import { NextRequest, NextResponse } from "next/server";
import { getMsiDealsByStartDate, getMsiDealsByStartMonth, getMsiDealsByCompanyInstanceId, searchMsiDealsByCompanyName, searchDeals, getDealsByIds, getDealNotes, getDealCompanyNocIds, getActiveExtensionCompanies, getProcessedStageIds, normExtCo, CANCEL_SENTINEL, MSI_STAGE_DID_NOT_RENEW } from "@/lib/hubspot";
import type { ExtensionIndex } from "@/lib/hubspot";
import { fetchCsaForMonth } from "@/lib/csa";
import type { CsaInstance } from "@/lib/csa";
import type { RenewalEntry } from "@/lib/types";
import { decodeNoteEntities, extractItalicYearEntries, extractNonItalicYearEntries, parseTermYears, computeSheetNote } from "@/lib/m1Note";

export const maxDuration = 90;
export const dynamic = "force-dynamic";

// Normalize a company name for fuzzy matching: lowercase, strip punctuation/spaces.
// "Fiber Connect" → "fiberconnect", "La Ward Telephone" → "lawardtelephone"
function normName(s: string): string {
  return s.toLowerCase().replace(/[\s\-_.,&()'"]/g, "");
}

// Returns true if two company name strings refer to the same company.
function companyNamesMatch(a: string, b: string): boolean {
  const na = a.toLowerCase().trim();
  const nb = b.toLowerCase().trim();
  if (na === nb) return true;
  if (na.includes(nb) || nb.includes(na)) return true;
  // Also try stripped comparison ("FiberConnect" ↔ "Fiber Connect")
  const nna = normName(a);
  const nnb = normName(b);
  return nna.includes(nnb) || nnb.includes(nna);
}

function extractCompany(dealName: string): string {
  // Standard format: "Company Name (MSI - Year N)"
  const parenIdx = dealName.indexOf(" (MSI");
  if (parenIdx > 0) return dealName.slice(0, parenIdx).trim();
  // Non-standard: "Company Name MSI Year N" (no parentheses)
  const plainIdx = dealName.indexOf(" MSI");
  if (plainIdx > 0) return dealName.slice(0, plainIdx).trim();
  return dealName.trim();
}

// Handles regular hyphen, en dash, and em dash
function extractYearFromName(dealName: string): number | null {
  // Matches all formats:
  //   "MSI - Year N"        → standard format (dash before Year)
  //   "MSI Year N"          → no dash
  //   "MSI Year - N"        → non-standard (dash after Year, e.g. Fiber Connect)
  //   "MSI – Year N"        → en dash variants
  //   "MSI Reboot - Year N" → one interstitial word (e.g. UCS churn-and-return
  //     "Reboot" deals). Without this, Reboot deals parsed as year 0 and lost
  //     the candidate sort to old churned deals with higher year numbers.
  const m = dealName.match(/MSI(?:\s+\w+)?\s*[-–—]?\s*Year\s*[-–—]?\s*(\d+)/i);
  return m ? parseInt(m[1], 10) : null;
}

function lastDayOfPreviousMonth(isoDate: string): string {
  const d = new Date(isoDate + "T00:00:00.000Z");
  d.setDate(d.getDate() - 1);
  return d.toISOString().split("T")[0];
}

function addOneYear(isoDate: string): string {
  const d = new Date(isoDate + "T00:00:00.000Z");
  d.setFullYear(d.getFullYear() + 1);
  return d.toISOString().split("T")[0];
}

interface M1Parsed {
  dealId: string;
  msiYear: number | null;
  nextMsiYear: number | null;
  orderFormLicense: number | null;
  currentYearLicense: number | null;
  m1NoteHtml: string | null;
  m1NoteId: string | null;
  /** All MSI year numbers found in the note (italic + non-italic), sorted asc. */
  allYearsInNote: number[];
  /** Term length in years parsed from the note title ("3 Year M1 Order Form:"). */
  termYears: number | null;
  /** Number of italicized (already-invoiced) MSI Year entries in the note. */
  italicCount: number;
  /** The italicized (invoiced) MSI year numbers themselves, sorted asc —
   *  used to name specific stray/ambiguous years in needs-review reasons. */
  italicYears: number[];
  /** Non-italic (not-yet-invoiced) MSI year numbers, sorted asc — used to
   *  detect broken italic runs (uninvoiced years below invoiced ones). */
  nonItalicYears: number[];
}

// Sheet note derivation now lives in src/lib/m1Note.ts (computeSheetNote):
//   M = termYears — parsed ONLY from the note title, never the bullet count
//   N = italicCount + 1 — position within this order form, not cumulative year
//   N <= M     → "Year N of M on existing M1 agreement"
//   N == M + 1 → "Auto-renewal"
//   A contiguous italic run past the term = Auto-renewal (normal bookkeeping).
//   Missing/garbled title, a BROKEN italic run (uninvoiced year below invoiced
//   ones), or a fully-italicized 1-year form → needs-review (fail loud), never
//   a silent "Auto-renewal" and never a crash.

function parseM1Note(
  dealId: string,
  dealName: string,
  notes: { id?: string; body: string }[]
): M1Parsed {
  const msiYear = extractYearFromName(dealName);
  const nextMsiYear = msiYear ? msiYear + 1 : null;

  // Helper: extract max year number mentioned in a note body
  function maxYearInNote(body: string): number {
    const re = /(?:MSI\s+)?Year\s+(\d+)\s*[-–—−:]\s*[\d,]+/gi;
    let max = 0;
    let hit: RegExpExecArray | null;
    while ((hit = re.exec(body)) !== null) max = Math.max(max, parseInt(hit[1], 10));
    return max;
  }

  // Collect all order/amendment notes. Accept:
  //   "M1 Order Form" / "M1 Order" / "MSI Order Form" (standard labels; some notes
  //   omit "Form", e.g. "Updated 3 year M1 Order:")
  //   "M1 Amend" / "M1 Amendment" / "M1 Amendement" (amendment notes for extensions)
  const m1Notes = notes.filter((n) => {
    const lower = n.body.toLowerCase();
    return (
      lower.includes("m1 order") ||    // catches "M1 Order Form", "M1 Order:", etc.
      lower.includes("msi order form") ||
      lower.includes("m1 amend")       // catches "M1 Amendment" and "M1 Amendement"
    );
  });
  if (!m1Notes.length) {
    return { dealId, msiYear, nextMsiYear, orderFormLicense: null, currentYearLicense: null, m1NoteHtml: null, m1NoteId: null, allYearsInNote: [], termYears: null, italicCount: 0, italicYears: [], nonItalicYears: [] };
  }

  // Pick the best note — always prefer the most recently created (highest note ID).
  //
  //  - Regular deal (msiYear known): among notes that mention the current or next
  //    year, pick the one with the highest ID. Fall back to highest ID overall if
  //    none mention those years.
  //  - Extension deal (msiYear null): pick the note with the highest max year;
  //    tiebreak by highest note ID.
  //
  // "Highest note ID = most recently created" is the key rule: if a deal has an
  // old canceled note AND a newer updated note, the updated note always wins.
  const yearRe = (yr: number) => new RegExp(`(?:MSI\\s+)?Year\\s+${yr}\\b`, "i");
  let m1Note: typeof m1Notes[0];
  if (msiYear !== null) {
    const yearMatches = m1Notes.filter(
      (n) => yearRe(nextMsiYear ?? -1).test(n.body) || yearRe(msiYear).test(n.body)
    );
    const candidates = yearMatches.length > 0 ? yearMatches : m1Notes;
    m1Note = candidates.reduce((best, n) =>
      parseInt(n.id ?? "0", 10) > parseInt(best.id ?? "0", 10) ? n : best
    );
  } else {
    // Extension: use the note that covers the most recent year.
    // Tiebreak by note ID (larger = more recently created) to prefer the newest order form.
    m1Note = m1Notes.reduce((best, n) => {
      const nMax = maxYearInNote(n.body);
      const bMax = maxYearInNote(best.body);
      if (nMax !== bMax) return nMax > bMax ? n : best;
      return parseInt(n.id ?? "0", 10) > parseInt(best.id ?? "0", 10) ? n : best;
    });
  }

  const rawHtml = m1Note.body;
  const m1NoteId = m1Note.id ?? null;

  // Decode common HTML entities that HubSpot may store (e.g. &ndash; for –) so
  // the dash-matching regexes below work regardless of how the note was typed.
  const html = decodeNoteEntities(rawHtml);

  // Collect italic (already-invoiced) entries: year → count.
  // (Regex details live in m1Note.ts — YEAR_ENTRY_RE handles all three
  // "MSI Year N - count" forms.)
  const italicEntries = extractItalicYearEntries(html);
  let m: RegExpExecArray | null;

  // Collect non-italic (upcoming) entries. Parsing lives in m1Note.ts —
  // handles both "Year N - 1,000 (opt_paren)" and paren-only "Year N - (1,000)".
  const nonItalicEntries = extractNonItalicYearEntries(html);

  // For extension deals, infer the current year from the highest year in all entries
  let effectiveMsiYear = msiYear;
  if (effectiveMsiYear === null) {
    const allYears = Array.from(italicEntries.keys()).concat(Array.from(nonItalicEntries.keys()));
    if (allYears.length) effectiveMsiYear = Math.max(...allYears);
  }
  const effectiveNextYear = effectiveMsiYear ? effectiveMsiYear + 1 : null;

  // orderFormLicense: the contracted amount for the NEXT year from the M1 note.
  // Primary source: non-italic entry (year not yet invoiced).
  //   Prefer paren (new order-form qty); fall back to main; support paren-only entries.
  // Fallback: italic entry for the same year — handles notes where all years were
  //   pre-italicized at creation time (e.g. "Updated 3 year M1 Order:" with all
  //   entries already in <em> tags). The contracted amount is still valid.
  let orderFormLicense: number | null = null;
  if (effectiveNextYear !== null) {
    if (nonItalicEntries.has(effectiveNextYear)) {
      const e = nonItalicEntries.get(effectiveNextYear)!;
      orderFormLicense = e.paren ?? e.main;
    } else if (italicEntries.has(effectiveNextYear)) {
      orderFormLicense = italicEntries.get(effectiveNextYear)!;
    }
  }

  // currentYearLicense: current year count for auto-renew baseline.
  // Prefer italic entry (already-invoiced); fall back to non-italic if not yet billed.
  // For non-italic: prefer main (full-year count) over paren (partial-term amount).
  let currentYearLicense: number | null = null;
  if (effectiveMsiYear !== null) {
    if (italicEntries.has(effectiveMsiYear)) {
      currentYearLicense = italicEntries.get(effectiveMsiYear)!;
    } else if (nonItalicEntries.has(effectiveMsiYear)) {
      const e = nonItalicEntries.get(effectiveMsiYear)!;
      currentYearLicense = e.main ?? e.paren;
    }
  }

  // Collect all year numbers found in the note (used for sheetNote generation)
  const allYearsInNote = Array.from(
    new Set([
      ...Array.from(italicEntries.keys()),
      ...Array.from(nonItalicEntries.keys()),
    ])
  ).sort((a, b) => a - b);

  const termYears = parseTermYears(html);

  // Return effective year values so extensions show year context in the UI
  return {
    dealId,
    msiYear: effectiveMsiYear,
    nextMsiYear: effectiveNextYear,
    orderFormLicense,
    currentYearLicense,
    m1NoteHtml: html,
    m1NoteId,
    allYearsInNote,
    termYears,
    italicCount: italicEntries.size,
    italicYears: Array.from(italicEntries.keys()).sort((a, b) => a - b),
    nonItalicYears: Array.from(nonItalicEntries.keys()).sort((a, b) => a - b),
  };
}

async function fetchNotesBatched(deals: any[]): Promise<{ dealId: string; notes: any[] }[]> {
  const results: { dealId: string; notes: any[] }[] = [];
  const BATCH = 15;
  for (let i = 0; i < deals.length; i += BATCH) {
    const batch = deals.slice(i, i + BATCH);
    const batchResults = await Promise.all(
      batch.map(async (deal: any) => ({
        dealId: deal.id,
        notes: await getDealNotes(deal.id).catch(() => []),
      }))
    );
    results.push(...batchResults);
  }
  return results;
}

export async function GET(req: NextRequest) {
  if (!process.env.HUBSPOT_ACCESS_TOKEN) {
    return NextResponse.json({ error: "HubSpot not configured" }, { status: 503 });
  }

  const monthParam = req.nextUrl.searchParams.get("month");
  const yearParam = req.nextUrl.searchParams.get("year");
  const startDateParam = req.nextUrl.searchParams.get("startDate");

  if (!monthParam && !yearParam && !startDateParam) {
    return NextResponse.json({ error: "month and year required" }, { status: 400 });
  }

  try {
    let startDate: string;

    if (startDateParam) {
      startDate = startDateParam;
    } else {
      const month = parseInt(monthParam!, 10);
      const year = parseInt(yearParam!, 10);
      if (!month || !year || month < 1 || month > 12) {
        return NextResponse.json({ error: "valid month (1-12) and year required" }, { status: 400 });
      }
      const nextMonth = month === 12 ? 1 : month + 1;
      const nextYear = month === 12 ? year + 1 : year;
      startDate = `${nextYear - 1}-${String(nextMonth).padStart(2, "0")}-01`;
    }

    const renewalStartDate = addOneYear(startDate);
    const expirationDate = lastDayOfPreviousMonth(renewalStartDate);

    // Fetch HubSpot deals, CSA data, extensions, and processed stage IDs in parallel.
    // The subscription_start_date search is the primary source.
    // CSA is the authoritative list of which companies are renewing this month —
    // any CSA instance not found by the date search gets a targeted name lookup.
    const renewalStartMs = new Date(renewalStartDate + "T00:00:00.000Z").getTime();
    const renewalEndMs   = new Date(renewalStartDate + "T23:59:59.999Z").getTime();

    const [startDateDeals, renewalDeals, startMonthDeals, csaResult, extensionIndex, processedStageIds] = await Promise.all([
      getMsiDealsByStartDate(startDate),
      getMsiDealsByStartDate(renewalStartDate),
      // startMonth pool: catches companies whose subscription_start_date is set to a
      // non-standard day within the expected start month (e.g. Syntrio June 19 vs
      // June 1). Searching the full month is more reliable than the closeDate approach
      // because closedate is set when the deal was sold, not to the expiration date.
      getMsiDealsByStartMonth(startDate.substring(0, 7)).catch(() => [] as any[]),
      fetchCsaForMonth(expirationDate).catch((err: Error) => {
        console.error("CSA fetch error (non-fatal):", err.message);
        return null;
      }),
      getActiveExtensionCompanies().catch((): ExtensionIndex => ({ byName: new Map(), byNocId: new Map(), pendingNocLookup: [] })),
      getProcessedStageIds().catch(() => new Set<string>()),
    ]);

    // Build lookup maps from extracted company name → deal.
    // Skip extension deals — they share the company name but belong to a separate pipeline.
    // closeDate map is used as a Tier 0 fallback for companies whose subscription_start_date
    // is set to a non-standard day (e.g. June 19 instead of June 1).
    const buildDealMap = (deals: any[]): Map<string, any> => {
      const map = new Map<string, any>();
      for (const d of deals) {
        if (/extension/i.test(d.properties?.dealname ?? "")) continue;
        if (!/\bYear\b/i.test(d.properties?.dealname ?? "")) continue;
        const co = extractCompany(d.properties?.dealname ?? "");
        if (co && !map.has(co.toLowerCase())) map.set(co.toLowerCase(), d);
      }
      return map;
    };
    const startDateMap = buildDealMap(startDateDeals);
    // Exclude future-year deals from the closeDate pool — only keep deals whose
    // subscription_start_date is before the renewal month (i.e. the current-year deal).
    // Using ssd < renewalStartMs rather than a single-day window because some companies
    // have non-standard start days (e.g. June 19 instead of June 1).
    // startMonthMap: all deals starting in the same calendar month as startDate
    // (e.g. June 2025), filtered to exclude future-year deals (ssd >= renewalStartMs).
    // Syntrio starts June 19, 2025 — this catches it even though June 19 ≠ June 1.
    const startMonthMap = buildDealMap(
      startMonthDeals.filter((d: any) => {
        const ssd = parseInt(d.properties?.subscription_start_date ?? "0", 10);
        return ssd > 0 && ssd < renewalStartMs;
      })
    );

    const seenIds = new Set<string>();
    const currentDeals: any[] = [];
    // Maps deal ID → the CSA instance name that was matched to it.
    // More reliable than noc_instance_id for the extension lookup because it's set
    // directly from the CSA match result — e.g. the Bartlett Electric Cooperative
    // MSI deal maps to "BEC Communication" if the CSA instance is "BEC Communication".
    const dealCSANameMap = new Map<string, string>();
    // CSA instances whose matched deal was already claimed by another instance
    // (e.g. a sub-tenant name-matching the parent's deal). Tracked so they count
    // as represented and don't get flagged as unmatched.
    const duplicateCsaMatches = new Set<string>();
    // Debug info: track how each CSA instance was resolved (for troubleshooting)
    const _csaDebug: { instance: string; method: string; dealName?: string }[] = [];

    // Partition CSA renewals by platform: MSI instances go through deal
    // matching; NOC360 instances become CSA-only report rows (own section,
    // own email) and never touch the MSI deal-matching tiers.
    const msiInstances = (csaResult?.instances ?? []).filter((i) => i.platform !== "NOC360");
    const noc360Instances = (csaResult?.instances ?? []).filter((i) => i.platform === "NOC360");

    if (msiInstances.length) {
      // CSA is the authoritative list. For each CSA instance, find its HubSpot deal:
      //   Tier 1 — startDate pool (fastest: already fetched, no extra API call)
      //   Tier 2 — instanceId → company → deals (reliable: bypasses name matching entirely)
      //   Tier 3 — name-based token search (last resort for companies missing an instanceId)
      const needFallback: typeof msiInstances = [];

      for (const inst of msiInstances) {
        // Tier 1a: subscription_start_date pool
        // Tier 1b: closeDate pool (catches companies with non-standard ssd, e.g. June 19)
        let found: any = null;
        let foundMethod = "startDate";
        for (const [co, deal] of Array.from(startDateMap.entries())) {
          if (companyNamesMatch(co, inst.instanceName)) { found = deal; break; }
        }
        if (!found) {
          for (const [co, deal] of Array.from(startMonthMap.entries())) {
            if (companyNamesMatch(co, inst.instanceName)) { found = deal; foundMethod = "startMonth"; break; }
          }
        }
        if (found && !seenIds.has(found.id)) {
          seenIds.add(found.id);
          currentDeals.push(found);
          dealCSANameMap.set(found.id, inst.instanceName);
          _csaDebug.push({ instance: inst.instanceName, method: foundMethod, dealName: found.properties?.dealname });
        } else if (found) {
          // Deal already claimed by another CSA instance. Previously this fell
          // through silently and the instance vanished from the report.
          duplicateCsaMatches.add(inst.instanceName);
          _csaDebug.push({ instance: inst.instanceName, method: "duplicate(dealAlreadyMatched)", dealName: found.properties?.dealname });
        } else {
          needFallback.push(inst);
          _csaDebug.push({ instance: inst.instanceName, method: "pending" });
        }
      }

      if (needFallback.length > 0) {
        // Tier 2: instanceId → company → deals
        // Skip for null-instanceId instances (new customers pre-kickoff) — avoids a
        // pointless search for noc_instance_id="null" and falls straight to Tier 3.
        const instanceIdResults = await Promise.allSettled(
          needFallback.map((inst) =>
            inst.instanceId !== null
              ? getMsiDealsByCompanyInstanceId(inst.instanceId)
              : Promise.resolve([])
          )
        );

        const needNameSearch: typeof msiInstances = [];

        for (let i = 0; i < needFallback.length; i++) {
          const res = instanceIdResults[i];
          const inst = needFallback[i];
          const debugIdx = _csaDebug.findIndex(d => d.instance === inst.instanceName && d.method === "pending");

          if (res.status !== "fulfilled" || !res.value.length) {
            // instanceId search failed or returned nothing — fall through to name search
            needNameSearch.push(inst);
            if (debugIdx >= 0) _csaDebug[debugIdx].method = "instanceId:noResults→nameSearch";
            continue;
          }

          // Filter: must be an MSI non-extension deal.
          // Prefer deals outside the renewal window (those are the CURRENT year deals).
          // If the company only has renewal-window deals (new Year-1 customer), allow
          // those through — their first deal starts on renewalStartDate.
          const msiDeals = res.value.filter((d: any) => {
            const name = d.properties?.dealname ?? "";
            return name.includes("MSI") && !/extension/i.test(name);
          });
          const nonRenewalCandidates = msiDeals.filter((d: any) => {
            const ssd = parseInt(d.properties?.subscription_start_date ?? "0", 10);
            // Require a real start date AND starting before the renewal month.
            // Using ssd < renewalStartMs (not a single-day window) so companies
            // with non-standard start days (e.g. June 19 vs June 1) are handled.
            return ssd > 0 && ssd < renewalStartMs;
          });
          const candidates = nonRenewalCandidates.length > 0 ? nonRenewalCandidates : msiDeals;

          if (!candidates.length) {
            needNameSearch.push(inst);
            if (debugIdx >= 0) _csaDebug[debugIdx].method = "instanceId:noMsiMatch→nameSearch";
            continue;
          }

          // Pick best: highest MSI year → latest subscription_start_date
          candidates.sort((a: any, b: any) => {
            const yA = extractYearFromName(a.properties?.dealname ?? "") ?? 0;
            const yB = extractYearFromName(b.properties?.dealname ?? "") ?? 0;
            if (yB !== yA) return yB - yA;
            const sA = parseInt(a.properties?.subscription_start_date ?? "0", 10);
            const sB = parseInt(b.properties?.subscription_start_date ?? "0", 10);
            return sB - sA;
          });

          const best = candidates[0];
          if (!seenIds.has(best.id)) {
            seenIds.add(best.id);
            currentDeals.push(best);
            dealCSANameMap.set(best.id, inst.instanceName);
            if (debugIdx >= 0) {
              _csaDebug[debugIdx].method = "instanceId:found";
              _csaDebug[debugIdx].dealName = best.properties?.dealname;
            }
          } else {
            duplicateCsaMatches.add(inst.instanceName);
            if (debugIdx >= 0) {
              _csaDebug[debugIdx].method = "instanceId:duplicate(dealAlreadyMatched)";
              _csaDebug[debugIdx].dealName = best.properties?.dealname;
            }
          }
        }

        // Tier 3: name-based token search for anything still unresolved
        if (needNameSearch.length > 0) {
          const nameResults = await Promise.allSettled(
            needNameSearch.map((inst) => searchMsiDealsByCompanyName(inst.instanceName))
          );

          for (let i = 0; i < needNameSearch.length; i++) {
            const res = nameResults[i];
            const inst = needNameSearch[i];
            const debugIdx = _csaDebug.findIndex(d => d.instance === inst.instanceName && (d.method.startsWith("instanceId:") || d.method === "pending"));

            if (res.status !== "fulfilled") {
              if (debugIdx >= 0) _csaDebug[debugIdx].method = "nameSearch:error";
              continue;
            }

            const returnedNames = res.value.map((d: any) => d.properties?.dealname ?? "?").join(" | ");

            // First, filter to name-matching non-extension deals (no date constraint yet).
            const allMatches = res.value.filter((d: any) => {
              if (/extension/i.test(d.properties?.dealname ?? "")) return false;
              const co = extractCompany(d.properties?.dealname ?? "");
              return companyNamesMatch(co, inst.instanceName);
            });
            // For companies with a known instanceId, prefer deals outside the
            // renewal window (current-year deals).  Mirror Tier 2's logic: fall
            // back to all name-matches if every deal starts at/after renewalStart
            // (e.g. a company whose deal ssd was recently updated or a Year-1 deal).
            //
            // NOTE: we require ssd > 0 (a real start date) here.  Accepting ssd === 0
            // as "any deal with no start date" was allowing Year N+1 deals (whose ssd
            // happens to be null/unset) to win over Year N deals when sorted by year
            // number, causing service_terminated to be stamped on the wrong deal.
            const candidates = (() => {
              if (inst.instanceId === null || !allMatches.length) return allMatches;
              const pastWindow = allMatches.filter((d: any) => {
                const ssd = parseInt(d.properties?.subscription_start_date ?? "0", 10);
                return ssd > 0 && ssd < renewalStartMs;
              });
              return pastWindow.length > 0 ? pastWindow : allMatches;
            })();

            if (!candidates.length) {
              if (debugIdx >= 0) _csaDebug[debugIdx].method = `nameSearch:noMatch(returned:${returnedNames})`;
              continue;
            }

            candidates.sort((a: any, b: any) => {
              const yA = extractYearFromName(a.properties?.dealname ?? "") ?? 0;
              const yB = extractYearFromName(b.properties?.dealname ?? "") ?? 0;
              if (yB !== yA) return yB - yA;
              const sA = parseInt(a.properties?.subscription_start_date ?? "0", 10);
              const sB = parseInt(b.properties?.subscription_start_date ?? "0", 10);
              return sB - sA;
            });

            const best = candidates[0];
            if (!seenIds.has(best.id)) {
              seenIds.add(best.id);
              currentDeals.push(best);
              dealCSANameMap.set(best.id, inst.instanceName);
              if (debugIdx >= 0) {
                _csaDebug[debugIdx].method = "nameSearch:found";
                _csaDebug[debugIdx].dealName = best.properties?.dealname;
              }
            } else {
              duplicateCsaMatches.add(inst.instanceName);
              if (debugIdx >= 0) {
                _csaDebug[debugIdx].method = "nameSearch:duplicate(dealAlreadyMatched)";
                _csaDebug[debugIdx].dealName = best.properties?.dealname;
              }
            }
          }
        }
      }
      // Mop-up: catch MSI deals for companies not covered by a CSA instance
      // (e.g. new customers pre-kickoff who have an active HubSpot deal but no CSA record,
      // or companies whose CSA instanceName didn't match any deal in Tiers 1-3).
      // Sources: startDateDeals (exact-day ssd match) PLUS startMonthDeals filtered to
      // pre-renewal dates — this ensures companies with a non-standard ssd (e.g. June 19
      // instead of June 1) that also lack a CSA record still appear in the report.
      // Deduplicate by company name and pick the highest MSI year to avoid pulling in
      // old-year deals for companies already resolved via instanceId search.
      const seenCompanyNorms = new Set(
        currentDeals.map((d: any) => normName(extractCompany(d.properties?.dealname ?? "")))
      );
      const mopUpByCompany = new Map<string, any>(); // normName → best deal
      const mopUpSources = [
        ...startDateDeals,
        ...startMonthDeals.filter((d: any) => {
          const ssd = parseInt(d.properties?.subscription_start_date ?? "0", 10);
          return ssd > 0 && ssd < renewalStartMs;
        }),
      ];
      // Build a fast lookup: is this company known to CSA for a DIFFERENT month?
      // If a company is in allInstances but NOT in this month's instances, their
      // renewal is in a different period — don't pull their old HubSpot deal into
      // this report via mop-up.  (e.g. Fiber Connect expires 5/31/2027 — an old
      // July 2025 deal exists in HubSpot but should not appear in June 2026.)
      const currentMonthCsaNames = msiInstances.map(i => i.instanceName);
      const isInOtherMonthCsa = (coName: string): boolean => {
        if (!csaResult) return false;
        const inCurrent = currentMonthCsaNames.some(n => companyNamesMatch(n, coName));
        if (inCurrent) return false; // their month — algorithm should have caught it
        return csaResult.allInstances.some(n => companyNamesMatch(n.instanceName, coName));
      };

      for (const d of mopUpSources) {
        if (seenIds.has(d.id)) continue;
        const name = d.properties?.dealname ?? "";
        if (!name.includes("MSI") || /extension/i.test(name)) continue;
        // Skip non-annual MSI deals (e.g. "United (MSI Enable/Disable)") — require "Year N"
        if (!/\bYear\b/i.test(name)) continue;
        const co = normName(extractCompany(name));
        if (seenCompanyNorms.has(co)) continue; // already covered by CSA match
        // Skip companies whose CSA renewal is in a different month
        if (isInOtherMonthCsa(extractCompany(name))) continue;
        const yr = extractYearFromName(name) ?? 0;
        const prev = mopUpByCompany.get(co);
        const prevYr = prev ? (extractYearFromName(prev.properties?.dealname ?? "") ?? 0) : -1;
        if (yr > prevYr) mopUpByCompany.set(co, d);
      }
      for (const [, d] of Array.from(mopUpByCompany.entries())) {
        seenIds.add(d.id);
        currentDeals.push(d);
        const name = d.properties?.dealname ?? "";
        _csaDebug.push({ instance: extractCompany(name), method: "startDate:noCSA", dealName: name });
      }
    } else {
      // CSA unavailable — fall back to the subscription_start_date results as-is
      for (const d of startDateDeals) {
        if (!seenIds.has(d.id)) { seenIds.add(d.id); currentDeals.push(d); }
      }
    }

    // Keep only main MSI deals — extension deals live in the extensions pipeline.
    // Also require "Year" in the name to exclude non-annual MSI deals (e.g. "MSI Enable/Disable").
    const filtered = currentDeals.filter((d: any) => {
      const name: string = d.properties?.dealname ?? "";
      return name.includes("MSI") && !/extension/i.test(name) && /\bYear\b/i.test(name);
    });

    if (!filtered.length) {
      return NextResponse.json({
        deals: [],
        expirationDate,
        renewalStartDate,
        csaInstances: csaResult?.allInstances ?? [],
        csaError: csaResult === null ? "CSA data unavailable" : null,
      });
    }

    const renewalDealMap = new Map<string, any>();
    for (const rd of renewalDeals) {
      if (rd.properties?.dealname?.includes("(MSI")) {
        const co = extractCompany(rd.properties.dealname);
        renewalDealMap.set(co.toLowerCase(), rd);
      }
    }

    // Fetch notes, company noc_instance_ids, and fresh deal properties in parallel.
    // getDealsByIds uses the batch/read endpoint (not search) so it bypasses HubSpot's
    // search-index lag — important for detecting service_terminated set moments ago.
    //
    // noc_instance_id lookup: combine MSI deal IDs + extension deal IDs into a single
    // getDealCompanyNocIds call.  Extension deals were deferred by getActiveExtensionCompanies
    // (pendingNocLookup) precisely so they can piggyback here instead of running as a
    // separate call during the parallel fetch phase (where HubSpot rate-limiting can
    // silently drop individual association lookups, leaving byNocId empty for some companies).
    const filteredIds = filtered.map((d: any) => d.id);
    const extPending = extensionIndex.pendingNocLookup ?? [];
    const nocLookupIds = extPending.length
      ? [...filteredIds, ...extPending.map((e) => e.dealId)]
      : filteredIds;

    const [notesAndItems, allNocIds, freshDeals] = await Promise.all([
      fetchNotesBatched(filtered),
      getDealCompanyNocIds(nocLookupIds),
      getDealsByIds(filteredIds, ["service_terminated"]).catch(() => []),
    ]);

    // Split allNocIds: MSI deals → nocIdMap, extension deals → populate byNocId
    const nocIdMap = new Map<string, number | null>();
    for (const id of filteredIds) {
      nocIdMap.set(id, allNocIds.get(id) ?? null);
    }
    for (const { dealId, extName } of extPending) {
      const nid = allNocIds.get(dealId);
      if (nid != null) {
        const existing = extensionIndex.byNocId.get(nid) ?? [];
        if (!existing.includes(extName)) existing.push(extName);
        extensionIndex.byNocId.set(nid, existing);
      }
    }

    // Build a map from deal ID → fresh service_terminated value
    const freshSvcTermMap = new Map<string, string>();
    for (const d of freshDeals) {
      const val = d.properties?.service_terminated;
      if (val) freshSvcTermMap.set(String(d.id), val);
    }

    // Parse M1 notes with regex (fast, no AI required)
    const parsedMap = new Map<string, M1Parsed>();
    for (const deal of filtered) {
      const rawNotes = notesAndItems.find((n) => n.dealId === deal.id)?.notes ?? [];
      const notes = rawNotes.map((n: any) => ({
        id: n.id ?? "",
        body: n.properties?.hs_note_body ?? "",
      }));
      const parsed = parseM1Note(deal.id, deal.properties?.dealname ?? "", notes);
      parsedMap.set(deal.id, parsed);
    }

    // CSA id → circuits map (empty if CSA fetch failed)
    const csaIdMap: Map<number, number> = csaResult?.idMap ?? new Map();
    const multiTenantIds: Set<number> = csaResult?.multiTenantIds ?? new Set();

    // Build a map from CSA instance ID → instance name so we can write the
    // canonical sheet name (e.g. "BEC Communication") rather than the HubSpot
    // deal name (e.g. "Bartlett Electric Cooperative").
    // Build instance ID → name map. Use the first name encountered for each ID
    // so that when multiple records share an ID (sub-tenants), the primary/first
    // CSA name wins rather than being overwritten by the sub-tenant entry.
    const instanceNameByIdMap = new Map<number, string>();
    for (const inst of csaResult?.allInstances ?? []) {
      if (inst.instanceId !== null && !instanceNameByIdMap.has(inst.instanceId)) {
        instanceNameByIdMap.set(inst.instanceId, inst.instanceName);
      }
    }

    // Build enriched entries
    const entries: RenewalEntry[] = filtered.map((deal: any) => {
      const company = extractCompany(deal.properties?.dealname ?? "");
      const parsed = parsedMap.get(deal.id) ?? {
        dealId: deal.id,
        msiYear: null,
        nextMsiYear: null,
        orderFormLicense: null,
        currentYearLicense: null,
        m1NoteHtml: null,
        m1NoteId: null,
        allYearsInNote: [] as number[],
        termYears: null,
        italicCount: 0,
        italicYears: [] as number[],
        nonItalicYears: [] as number[],
      };
      const msiYear = parsed.msiYear ?? extractYearFromName(deal.properties?.dealname ?? "");
      const nextMsiYear = msiYear ? msiYear + 1 : null;
      const orderFormLicense: number | null = parsed.orderFormLicense ?? null;
      const currentYearLicense: number | null = parsed.currentYearLicense ?? null;

      // ID-based CSA match: noc_instance_id → CSA circuits + instance name
      const nocInstanceId = nocIdMap.get(deal.id) ?? null;
      const csaCountById: number | null =
        nocInstanceId != null ? (csaIdMap.get(nocInstanceId) ?? null) : null;

      // csaInstanceName must be resolved before the fallback so the name-based
      // lookup can use it.  Compute it here; the comment block below explains it.
      const csaInstanceNameRaw: string | null =
        dealCSANameMap.get(deal.id) ??
        (nocInstanceId != null ? (instanceNameByIdMap.get(nocInstanceId) ?? null) : null);

      // Name-based fallback: when get_company calls time out the csaIdMap is empty,
      // but csaResult.instances still has circuit counts from the snapshot.
      // If ID lookup failed, match by instance name so counts still show up.
      const csaCountByName: number | null = (() => {
        if (csaCountById !== null || !csaResult) return null;
        const needle = csaInstanceNameRaw ?? company;
        const inst = csaResult.instances.find(
          (i) => companyNamesMatch(i.instanceName, needle)
        );
        return inst?.circuits ?? null;
      })();

      const csaCount: number | null = csaCountById ?? csaCountByName;
      const csaRounded: number | null =
        csaCount !== null ? Math.max(1000, Math.ceil(csaCount / 50) * 50) : null;
      // csaInstanceName already computed above as csaInstanceNameRaw.
      const csaInstanceName: string | null = csaInstanceNameRaw;

      // Renewal count = max(order form, CSA rounded, current year license).
      // Order form sets the contracted floor, but if actual usage (CSA rounded)
      // has grown beyond the contracted amount we bill the higher number.
      let renewalCount: number | null = null;
      if (orderFormLicense !== null || csaRounded !== null || currentYearLicense !== null) {
        renewalCount = Math.max(orderFormLicense ?? 0, csaRounded ?? 0, currentYearLicense ?? 0);
      }

      const renewalDeal = renewalDealMap.get(company.toLowerCase()) ?? null;
      const renewalDealName = `${company} (MSI - Year ${nextMsiYear ?? "?"})`;

      const dealName = deal.properties?.dealname ?? "";
      // Extension lookup — preference order:
      // 1. noc_instance_id (most reliable — shared company object, immune to name mismatches)
      // 2. Exact lowercase company name from MSI deal
      // 3. Normalised company name (strips LLC/Inc/etc.)
      // 4. CSA instance name (exact and normalised) — bridges "Bartlett Electric" ↔ "BEC Communication"
      const extensionNames: string[] =
        (nocInstanceId != null ? extensionIndex.byNocId.get(nocInstanceId) : undefined) ??
        extensionIndex.byName.get(company.toLowerCase()) ??
        extensionIndex.byName.get(normExtCo(company)) ??
        (csaInstanceName
          ? (extensionIndex.byName.get(csaInstanceName.toLowerCase()) ??
             extensionIndex.byName.get(normExtCo(csaInstanceName)))
          : undefined) ??
        [];
      const hasExtension = extensionNames.length > 0;

      // svcTerminated: check freshSvcTermMap first (batch/read, no search-index lag),
      // then the property from the initial search query as a fallback.
      const renewalStage: string = renewalDeal?.properties?.dealstage ?? "";
      const svcTerminated =
        freshSvcTermMap.get(deal.id) ??
        (deal.properties?.service_terminated || null);

      const multiTenant = nocInstanceId != null && multiTenantIds.has(nocInstanceId);

      // Detect cancellation.  Four signals checked in decreasing reliability:
      //
      //  1. service_terminated === CANCEL_SENTINEL (most reliable):
      //     Set directly on the deal by Step 4 of the cancel route.  Already
      //     fetched in the initial batch query — no extra API call needed, works
      //     across sessions and Vercel preview-URL changes.
      //
      //  2. dealstage === MSI_STAGE_DID_NOT_RENEW:
      //     Deal was explicitly moved to the "Did Not Renew" stage in HubSpot.
      //     Reliable — stage is fetched with the initial deal query.
      //
      //  3. Company note tagged with this expiration date ("Did not renew — YYYY-MM-DD"):
      //     Created by Step 3 of the cancel route.  Found via getCompanyNotesForDeal
      //     for ANY deal associated with the company — survives deal-ID changes.
      //     The date tag prevents false positives in future renewal periods.
      //
      //  4. Plain "Did not renew" (no date tag):
      //     Legacy — M1 note prepends (Step 1) and pre-date-tag standalone deal notes.
      //     Still checked for backward compatibility.
      const rawNotes = notesAndItems.find((n) => n.dealId === deal.id)?.notes ?? [];
      const cancelled =
        svcTerminated === CANCEL_SENTINEL ||
        deal.properties?.dealstage === MSI_STAGE_DID_NOT_RENEW ||
        rawNotes.some((n: any) => {
          const body: string = n.properties?.hs_note_body ?? "";
          if (body.includes(`Did not renew — ${expirationDate}`)) return true;
          return body.includes("Did not renew");
        });

      // processed: only if not cancelled, and either a billing-stage renewal deal
      // exists OR service_terminated is a real date (not the cancel sentinel).
      const processed = !cancelled && !!(
        (renewalDeal && renewalStage && processedStageIds.has(renewalStage)) ||
        (svcTerminated && svcTerminated !== CANCEL_SENTINEL)
      );

      // Sheet note: M comes ONLY from the note title, N from the italic count.
      // Missing note / garbled title / stray italics → needs-review, never a
      // silent "Auto-renewal" and never a crash.
      const noteResult = computeSheetNote({
        noteHtml: parsed.m1NoteHtml,
        termYears: parsed.termYears ?? null,
        italicYears: parsed.italicYears ?? [],
        nonItalicYears: parsed.nonItalicYears ?? [],
      });

      return {
        currentDealId: deal.id,
        currentDealName: dealName,
        company,
        hasExtension,
        msiYear,
        nextMsiYear,
        orderFormLicense,
        currentYearLicense,
        csaCount,
        csaRounded,
        renewalCount,
        renewalDealId: renewalDeal?.id ?? null,
        renewalDealName,
        renewalStartDate,
        expirationDate,
        m1NoteHtml: parsed.m1NoteHtml ?? null,
        m1NoteId: parsed.m1NoteId ?? null,
        nocInstanceId,
        csaInstanceName,
        sheetNote: noteResult.sheetNote,
        needsReview: noteResult.needsReview,
        needsReviewReason: noteResult.needsReviewReason,
        platform: "MSI",
        extensionNames,
        processed,
        cancelled,
        multiTenant,
      };
    });

    // Fail loud: CSA is the authoritative renewal list, but until now a CSA
    // instance that matched no HubSpot deal in any tier simply vanished from
    // the report (only a _csaDebug breadcrumb remained). Surface each one as a
    // needs-review row instead so missing/misnamed/misdated deals get found.
    const matchedCsaNames = new Set<string>([
      ...Array.from(dealCSANameMap.values()),
      ...Array.from(duplicateCsaMatches),
    ]);
    // Belt and suspenders: skip instances already represented in the report
    // via the mop-up (deal found by date pool without a CSA-tier match).
    // Three signals, because CSA↔HubSpot names can diverge completely (e.g.
    // CSA "CKV Brethren Home" ↔ deal "Morefield"):
    //   1. name match against entry company / CSA instance name
    //   2. noc_instance_id match (entry's ID comes from the HubSpot company
    //      association — independent of whether the CSA tiers resolved)
    //   3. CSA domain root vs entry company ("morefield.com" ↔ "Morefield")
    const representedInEntries = (inst: { instanceName: string; instanceId: number | null; domain: string | null }): boolean => {
      const domainRoot = inst.domain
        ? inst.domain.replace(/^www\./i, "").split(".")[0]
        : null;
      return entries.some(
        (e) =>
          companyNamesMatch(e.company, inst.instanceName) ||
          (e.csaInstanceName ? companyNamesMatch(e.csaInstanceName, inst.instanceName) : false) ||
          (inst.instanceId != null && e.nocInstanceId != null && e.nocInstanceId === inst.instanceId) ||
          (domainRoot !== null && domainRoot.length >= 5 && companyNamesMatch(e.company, domainRoot))
      );
    };
    const unmatchedCsaInstances = msiInstances.filter(
      (inst) =>
        !matchedCsaNames.has(inst.instanceName) &&
        inst.status !== "Disabled" && // churned accounts don't renew
        !representedInEntries(inst)
    );
    for (const inst of unmatchedCsaInstances) {
      const csaCount = inst.circuits ?? null;
      const csaRounded =
        csaCount !== null ? Math.max(1000, Math.ceil(csaCount / 50) * 50) : null;
      const statusPart =
        inst.status && inst.status !== "Production" ? `, status: ${inst.status}` : "";
      entries.push({
        currentDealId: `csa-unmatched:${inst.instanceName}`,
        currentDealName: "(no HubSpot deal matched)",
        company: inst.instanceName,
        hasExtension: false,
        msiYear: null,
        nextMsiYear: null,
        orderFormLicense: null,
        currentYearLicense: null,
        csaCount,
        csaRounded,
        renewalCount: null,
        renewalDealId: null,
        renewalDealName: `${inst.instanceName} (MSI - Year ?)`,
        renewalStartDate,
        expirationDate,
        m1NoteHtml: null,
        m1NoteId: null,
        nocInstanceId: inst.instanceId ?? null,
        csaInstanceName: inst.instanceName,
        sheetNote: "NEEDS REVIEW — CSA renewal with no matching HubSpot deal",
        needsReview: true,
        needsReviewReason:
          `CSA lists "${inst.instanceName}" renewing this month (${csaCount?.toLocaleString() ?? "?"} circuits${statusPart}), ` +
          `but no HubSpot MSI deal matched by start date, instance ID, or name search. ` +
          `Check: (a) the current-year deal's subscription_start_date, (b) whether the deal name ` +
          `matches the CSA instance name, or (c) whether this is a sub-tenant instance with no deal of its own.`,
        unmatchedCsa: true,
        platform: "MSI",
        extensionNames: [],
        processed: false,
        cancelled: false,
        multiTenant: inst.instanceId != null && multiTenantIds.has(inst.instanceId),
      });
    }

    // NOC360 renewals: CSA-only rows, processable like MSI ones. Processing
    // creates a yearly "Company (NOC360 Renewal - YYYY)" deal (no M1 note, no
    // expiring deal). Order Form column shows the CSA license count; renewal
    // count mirrors the MSI billing rule (max of license vs rounded actual
    // usage). Detect already-created yearly deals here so a reload shows
    // Processed and re-processing reuses the deal instead of duplicating it.
    const renewalYear = new Date(renewalStartDate + "T00:00:00.000Z").getUTCFullYear();
    const startDateMs = new Date(startDate + "T00:00:00.000Z").getTime();
    const [existingNoc360Deals, priorNoc360Deals]: any[][] =
      noc360Instances.length > 0
        ? await Promise.all([
            searchDeals(
              [
                { propertyName: "dealname", operator: "CONTAINS_TOKEN", value: "NOC360" },
                { propertyName: "subscription_start_date", operator: "EQ", value: String(renewalStartMs) },
              ],
              ["dealname", "dealstage"]
            ).catch(() => []),
            // Last year's yearly deals (their term started when this one's
            // expires) — a cancel sentinel on one means this instance was
            // marked Did Not Renew, so the row stays cancelled across
            // browsers/reloads without relying on localStorage.
            searchDeals(
              [
                { propertyName: "dealname", operator: "CONTAINS_TOKEN", value: "NOC360" },
                { propertyName: "subscription_start_date", operator: "EQ", value: String(startDateMs) },
              ],
              ["dealname", "service_terminated"]
            ).catch(() => []),
          ])
        : [[], []];
    for (const inst of noc360Instances) {
      if (inst.status === "Disabled") continue;
      const csaCount = inst.circuits ?? null;
      const csaRounded =
        csaCount !== null ? Math.max(1000, Math.ceil(csaCount / 50) * 50) : null;
      const lic = inst.licenseCount ?? null;
      const renewalCount =
        lic !== null || csaRounded !== null
          ? Math.max(lic ?? 0, csaRounded ?? 0)
          : null;
      const noc360DealName = `${inst.instanceName} (NOC360 Renewal - ${renewalYear})`;
      const existingDeal = existingNoc360Deals.find(
        (d) => d.properties?.dealname === noc360DealName
      );
      const existingStage = existingDeal?.properties?.dealstage ?? null;
      const priorDeal = priorNoc360Deals.find(
        (d) =>
          d.properties?.dealname ===
          `${inst.instanceName} (NOC360 Renewal - ${renewalYear - 1})`
      );
      const noc360Cancelled =
        priorDeal?.properties?.service_terminated === CANCEL_SENTINEL;
      entries.push({
        currentDealId: `csa-noc360:${inst.instanceName}`,
        currentDealName: "NOC360 renewal (from CSA)",
        company: inst.instanceName,
        hasExtension: false,
        msiYear: null,
        nextMsiYear: null,
        orderFormLicense: lic,
        currentYearLicense: null,
        csaCount,
        csaRounded,
        renewalCount,
        renewalDealId: existingDeal?.id ?? null,
        renewalDealName: noc360DealName,
        renewalStartDate,
        expirationDate,
        m1NoteHtml: null,
        m1NoteId: null,
        nocInstanceId: inst.instanceId ?? null,
        csaInstanceName: inst.instanceName,
        sheetNote: "NOC360 renewal",
        needsReview: false,
        needsReviewReason: null,
        unmatchedCsa: false,
        platform: "NOC360",
        csaLicenseCount: lic,
        extensionNames: [],
        processed: !!(existingDeal && existingStage && processedStageIds.has(existingStage)),
        cancelled: noc360Cancelled,
        multiTenant: false,
      });
    }

    entries.sort((a, b) => a.company.localeCompare(b.company));

    const csaInstances: CsaInstance[] = csaResult?.allInstances ?? [];
    const csaError: string | null = csaResult === null ? "CSA data unavailable" : null;

    return NextResponse.json({ deals: entries, expirationDate, renewalStartDate, csaInstances, csaError, _csaDebug });
  } catch (error: any) {
    console.error("MSI renewals GET error:", error);
    return NextResponse.json({ error: error.message || "Internal server error" }, { status: 500 });
  }
}
