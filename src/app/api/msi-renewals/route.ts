import { NextRequest, NextResponse } from "next/server";
import { getMsiDealsByStartDate, getDealNotes, getDealCompanyNocIds, getActiveExtensionCompanies, getProcessedStageIds } from "@/lib/hubspot";
import { fetchCsaForMonth } from "@/lib/csa";
import type { CsaInstance } from "@/lib/csa";
import type { RenewalEntry } from "@/lib/types";

export const maxDuration = 90;
export const dynamic = "force-dynamic";

function extractCompany(dealName: string): string {
  const idx = dealName.indexOf(" (MSI");
  return idx > 0 ? dealName.slice(0, idx).trim() : dealName.trim();
}

// Handles regular hyphen, en dash, and em dash
function extractYearFromName(dealName: string): number | null {
  const m = dealName.match(/MSI\s*[-–—]\s*Year\s*(\d+)/i);
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

function parseCount(s: string): number | null {
  const n = parseInt(s.replace(/,/g, ""), 10);
  return isNaN(n) ? null : n;
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
}

// Derive a human-readable sheet note from the parsed M1 data.
// Auto-renew deals get "Auto-renewal"; order form deals get "Year X of Y on existing M1 agreement"
// where X/Y reflect the position within the consecutive year sequence in the note.
function computeSheetNote(
  orderFormLicense: number | null,
  nextMsiYear: number | null,
  allYearsInNote: number[]
): string {
  if (!orderFormLicense || !nextMsiYear) return "Auto-renewal";
  const yearSet = new Set(allYearsInNote);
  // Walk back to find the start of the consecutive block containing nextMsiYear
  let blockStart = nextMsiYear;
  while (yearSet.has(blockStart - 1)) blockStart--;
  const blockLen = allYearsInNote.filter((y) => y >= blockStart && y <= nextMsiYear).length;
  const pos = nextMsiYear - blockStart + 1;
  if (blockLen <= 1) return `Year ${pos} on existing M1 agreement`;
  return `Year ${pos} of ${blockLen} on existing M1 agreement`;
}

function parseM1Note(
  dealId: string,
  dealName: string,
  notes: { id?: string; body: string }[]
): M1Parsed {
  const msiYear = extractYearFromName(dealName);
  const nextMsiYear = msiYear ? msiYear + 1 : null;

  // Helper: extract max year number mentioned in a note body
  function maxYearInNote(body: string): number {
    const re = /(?:MSI\s+)?Year\s+(\d+)\s*[-–—−]\s*[\d,]+/gi;
    let max = 0;
    let hit: RegExpExecArray | null;
    while ((hit = re.exec(body)) !== null) max = Math.max(max, parseInt(hit[1], 10));
    return max;
  }

  // Collect all order/amendment notes. Accept:
  //   "M1 Order Form", "MSI Order Form" (standard labels)
  //   "M1 Amend" / "M1 Amendment" / "M1 Amendement" (amendment notes for extensions)
  const m1Notes = notes.filter((n) => {
    const lower = n.body.toLowerCase();
    return (
      lower.includes("m1 order form") ||
      lower.includes("msi order form") ||
      lower.includes("m1 amend")       // catches "M1 Amendment" and "M1 Amendement"
    );
  });
  if (!m1Notes.length) {
    return { dealId, msiYear, nextMsiYear, orderFormLicense: null, currentYearLicense: null, m1NoteHtml: null, m1NoteId: null, allYearsInNote: [] };
  }

  // Pick the best note:
  //  - Regular deal (msiYear known): prefer the note that mentions current or next year
  //  - Extension deal (msiYear null): pick the note with the highest max year (most recent term)
  const yearRe = (yr: number) => new RegExp(`(?:MSI\\s+)?Year\\s+${yr}\\b`, "i");
  let m1Note: typeof m1Notes[0];
  if (msiYear !== null) {
    m1Note =
      m1Notes.find((n) => yearRe(nextMsiYear ?? -1).test(n.body) || yearRe(msiYear).test(n.body)) ??
      m1Notes[0];
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
  const html = rawHtml
    .replace(/&ndash;/gi, "–")
    .replace(/&mdash;/gi, "—")
    .replace(/&minus;/gi, "−")
    .replace(/&#8211;/gi, "–")
    .replace(/&#8212;/gi, "—")
    .replace(/&#x2013;/gi, "–")
    .replace(/&#x2014;/gi, "—")
    .replace(/&nbsp;/gi, " ");

  // Year entry pattern: "MSI Year N - X,XXX" or "Year N - X,XXX" (some notes omit "MSI")
  const yearEntryRe = /(?:MSI\s+)?Year\s+(\d+)\s*[-–—−]\s*([\d,]+)/i;

  // Collect italic (already-invoiced) entries
  const italicEntries = new Map<number, number>();
  const italicRe = /<(?:em|i)[^>]*>([\s\S]*?)<\/(?:em|i)>/gi;
  let m: RegExpExecArray | null;
  while ((m = italicRe.exec(html)) !== null) {
    const inner = m[1];
    const hit = inner.match(yearEntryRe);
    if (hit) {
      const yr = parseInt(hit[1], 10);
      const cnt = parseCount(hit[2]);
      if (cnt !== null) italicEntries.set(yr, cnt);
    }
  }

  // Collect non-italic (upcoming) entries.
  // Handles both "Year N - 1,000 (opt_paren)" and paren-only "Year N - (1,000)".
  const withoutItalics = html.replace(/<(?:em|i)[^>]*>[\s\S]*?<\/(?:em|i)>/gi, "");
  const nonItalicEntries = new Map<number, { main: number | null; paren: number | null }>();
  const niRe = /(?:MSI\s+)?Year\s+(\d+)\s*[-–—−]\s*(?:([\d,]+)(?:\s*\(([^)]*)\))?|\(([^)]*)\))/gi;
  while ((m = niRe.exec(withoutItalics)) !== null) {
    const yr = parseInt(m[1], 10);
    const main = m[2] ? parseCount(m[2]) : null;                   // normal "N - count" form
    const parenStr = (m[3] ?? m[4])?.trim() ?? null;               // paren from either form
    const paren = parenStr ? parseCount(parenStr) : null;
    if (main !== null || paren !== null) nonItalicEntries.set(yr, { main, paren });
  }

  // For extension deals, infer the current year from the highest year in all entries
  let effectiveMsiYear = msiYear;
  if (effectiveMsiYear === null) {
    const allYears = Array.from(italicEntries.keys()).concat(Array.from(nonItalicEntries.keys()));
    if (allYears.length) effectiveMsiYear = Math.max(...allYears);
  }
  const effectiveNextYear = effectiveMsiYear ? effectiveMsiYear + 1 : null;

  // orderFormLicense: non-italic entry for the NEXT year.
  // Prefer paren (new order-form qty); fall back to main; support paren-only entries.
  let orderFormLicense: number | null = null;
  if (effectiveNextYear !== null && nonItalicEntries.has(effectiveNextYear)) {
    const e = nonItalicEntries.get(effectiveNextYear)!;
    orderFormLicense = e.paren ?? e.main;
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

    // Fetch HubSpot deals, active extensions, CSA data, and processed stage IDs in parallel.
    // CSA errors are non-fatal; other lookups default to safe empty values.
    const [currentDeals, renewalDeals, csaResult, extensionCompanies, processedStageIds] = await Promise.all([
      getMsiDealsByStartDate(startDate),
      getMsiDealsByStartDate(renewalStartDate),
      fetchCsaForMonth(expirationDate).catch((err: Error) => {
        console.error("CSA fetch error (non-fatal):", err.message);
        return null;
      }),
      getActiveExtensionCompanies().catch(() => new Set<string>()),
      getProcessedStageIds().catch(() => new Set<string>()),
    ]);

    // Keep only main MSI deals — extension deals live in the extensions pipeline
    // and are excluded here; they surface as the hasExtension flag on the parent deal.
    const filtered = currentDeals.filter((d: any) => {
      const name: string = d.properties?.dealname ?? "";
      return name.includes("(MSI") && !/extension/i.test(name);
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

    // Fetch notes and company noc_instance_ids in parallel
    const [notesAndItems, nocIdMap] = await Promise.all([
      fetchNotesBatched(filtered),
      getDealCompanyNocIds(filtered.map((d: any) => d.id)),
    ]);

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

    // Build a map from CSA instance ID → instance name so we can write the
    // canonical sheet name (e.g. "BEC Communication") rather than the HubSpot
    // deal name (e.g. "Bartlett Electric Cooperative").
    const instanceNameByIdMap = new Map<number, string>();
    for (const inst of csaResult?.allInstances ?? []) {
      if (inst.instanceId !== null) {
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
      };
      const msiYear = parsed.msiYear ?? extractYearFromName(deal.properties?.dealname ?? "");
      const nextMsiYear = msiYear ? msiYear + 1 : null;
      const orderFormLicense: number | null = parsed.orderFormLicense ?? null;
      const currentYearLicense: number | null = parsed.currentYearLicense ?? null;

      // ID-based CSA match: noc_instance_id → CSA circuits + instance name
      const nocInstanceId = nocIdMap.get(deal.id) ?? null;
      const csaCount: number | null =
        nocInstanceId != null ? (csaIdMap.get(nocInstanceId) ?? null) : null;
      const csaRounded: number | null =
        csaCount !== null ? Math.max(1000, Math.ceil(csaCount / 50) * 50) : null;
      const csaInstanceName: string | null =
        nocInstanceId != null ? (instanceNameByIdMap.get(nocInstanceId) ?? null) : null;

      // Order form always wins; auto-renew takes max(CSA rounded, current year)
      let renewalCount: number | null = null;
      if (orderFormLicense !== null) {
        renewalCount = orderFormLicense;
      } else if (csaRounded !== null || currentYearLicense !== null) {
        renewalCount = Math.max(csaRounded ?? 0, currentYearLicense ?? 0);
      }

      const renewalDeal = renewalDealMap.get(company.toLowerCase()) ?? null;
      const renewalDealName = `${company} (MSI - Year ${nextMsiYear ?? "?"})`;

      const dealName = deal.properties?.dealname ?? "";
      const hasExtension = extensionCompanies.has(company.toLowerCase());

      // A deal is considered processed if a renewal deal exists AND that deal
      // is in a "Closed Won - Ready for Billing" or "Closed Won - Invoiced" stage.
      const renewalStage: string = renewalDeal?.properties?.dealstage ?? "";
      const processed = !!(renewalDeal && renewalStage && processedStageIds.has(renewalStage));

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
        sheetNote: computeSheetNote(orderFormLicense, nextMsiYear, parsed.allYearsInNote ?? []),
        processed,
      };
    });

    entries.sort((a, b) => a.company.localeCompare(b.company));

    const csaInstances: CsaInstance[] = csaResult?.allInstances ?? [];
    const csaError: string | null = csaResult === null ? "CSA data unavailable" : null;

    return NextResponse.json({ deals: entries, expirationDate, renewalStartDate, csaInstances, csaError });
  } catch (error: any) {
    console.error("MSI renewals GET error:", error);
    return NextResponse.json({ error: error.message || "Internal server error" }, { status: 500 });
  }
}
