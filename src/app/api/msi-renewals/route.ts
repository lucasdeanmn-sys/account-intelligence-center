import { NextRequest, NextResponse } from "next/server";
import { callClaude, extractJSON } from "@/lib/anthropic";
import { getMsiDealsByStartDate, getDealNotes } from "@/lib/hubspot";
import type { RenewalEntry } from "@/lib/types";

export const maxDuration = 60;
export const dynamic = "force-dynamic";

function extractCompany(dealName: string): string {
  const idx = dealName.indexOf(" (MSI");
  return idx > 0 ? dealName.slice(0, idx).trim() : dealName.trim();
}

function extractYearFromName(dealName: string): number | null {
  const m = dealName.match(/MSI\s*-\s*Year\s*(\d+)/i);
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

const M1_PARSE_SYSTEM = `You are parsing HubSpot M1 order form notes for MSI deals.
Each note is in HTML format. The note title contains "M1 Order Form:" (e.g. "3 Year M1 Order Form:", "5 Year M1 Order Form:").

Bullet format:
  "MSI Year N - X,XXX"                   → license = X,XXX
  "MSI Year N - X,XXX (Y,YYY) ..."       → X,XXX is CSSA-adjusted count, Y,YYY is the ORDER FORM license
  "MSI Year N - X,XXX (Auto-renew)"      → license = X,XXX
  Extra text in parens like "(14 month term)" is metadata — ignore it for the license number.

Italic bullets (<i> or <em> text) = already invoiced.
Non-italic = not yet invoiced.

For each deal, find the best matching M1 note and extract:
- msiYear: current deal year number (from the deal name field provided)
- nextMsiYear: msiYear + 1
- orderFormLicense: license from the note for nextMsiYear
  * Non-italic entry "MSI Year [nextMsiYear] - X (Y)": return Y
  * Non-italic entry "MSI Year [nextMsiYear] - X": return X
  * No entry for nextMsiYear (or only italic): return null
- currentYearLicense: license from the ITALIC entry for msiYear (the last invoiced year).
  Use this as the auto-renew fallback when orderFormLicense is null.
  If no italic entry for msiYear, return null.
- m1NoteHtml: full HTML of the best matching note

Return ONLY valid JSON array:
[{"dealId":"...","msiYear":4,"nextMsiYear":5,"orderFormLicense":2000,"currentYearLicense":1500,"m1NoteHtml":"..."}]`;


async function fetchNotesBatched(deals: any[]): Promise<{ dealId: string; notes: any[] }[]> {
  const results: { dealId: string; notes: any[] }[] = [];
  const BATCH = 5;
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
  // Also accept legacy startDate param
  const startDateParam = req.nextUrl.searchParams.get("startDate");

  if (!monthParam && !yearParam && !startDateParam) {
    return NextResponse.json({ error: "month and year required" }, { status: 400 });
  }

  try {
    let startDate: string;

    if (startDateParam) {
      startDate = startDateParam;
    } else {
      const month = parseInt(monthParam!, 10); // 1–12, the expiration month
      const year = parseInt(yearParam!, 10);
      if (!month || !year || month < 1 || month > 12) {
        return NextResponse.json({ error: "valid month (1-12) and year required" }, { status: 400 });
      }
      // Expiration = last day of selected month; subscription started same month+1, one year prior
      const nextMonth = month === 12 ? 1 : month + 1;
      const nextYear = month === 12 ? year + 1 : year;
      startDate = `${nextYear - 1}-${String(nextMonth).padStart(2, "0")}-01`;
    }

    const renewalStartDate = addOneYear(startDate);
    const expirationDate = lastDayOfPreviousMonth(renewalStartDate);

    // 1. Fetch current (expiring) deals and renewal deals from HubSpot
    const [currentDeals, renewalDeals] = await Promise.all([
      getMsiDealsByStartDate(startDate),
      getMsiDealsByStartDate(renewalStartDate),
    ]);

    // Filter to only deals with "(MSI" in the name
    const filtered = currentDeals.filter((d: any) =>
      d.properties?.dealname?.includes("(MSI")
    );

    if (!filtered.length) {
      return NextResponse.json({ deals: [], expirationDate, renewalStartDate });
    }

    // Build a map of company → renewal deal
    const renewalDealMap = new Map<string, any>();
    for (const rd of renewalDeals) {
      if (rd.properties?.dealname?.includes("(MSI")) {
        const co = extractCompany(rd.properties.dealname);
        renewalDealMap.set(co.toLowerCase(), rd);
      }
    }

    // 2. Fetch M1 notes for current deals — batched to avoid HubSpot rate limits
    const notesAndItems = await fetchNotesBatched(filtered);

    // 3. Parse M1 notes with Claude
    const noteInput = filtered.map((deal: any, i: number) => ({
      dealId: deal.id,
      dealName: deal.properties?.dealname ?? "",
      msiYear: extractYearFromName(deal.properties?.dealname ?? ""),
      notes: (notesAndItems.find(n => n.dealId === deal.id)?.notes ?? [])
        .sort((a: any, b: any) =>
          new Date(b.properties?.hs_timestamp ?? 0).getTime() -
          new Date(a.properties?.hs_timestamp ?? 0).getTime()
        )
        .slice(0, 5)
        .map((n: any) => ({ body: n.properties?.hs_note_body ?? "", timestamp: n.properties?.hs_timestamp })),
    }));

    let parsedNotes: any[] = [];
    try {
      const parseResult = await callClaude(
        M1_PARSE_SYSTEM,
        `Parse M1 notes for these deals:\n${JSON.stringify(noteInput, null, 2)}`,
        4096
      );
      parsedNotes = extractJSON<any[]>(parseResult);
    } catch {
      parsedNotes = filtered.map((d: any) => ({
        dealId: d.id,
        msiYear: extractYearFromName(d.properties?.dealname ?? ""),
        nextMsiYear: null,
        orderFormLicense: null,
        currentYearLicense: null,
        m1NoteHtml: null,
      }));
    }

    const parsedMap = new Map(parsedNotes.map((p: any) => [p.dealId, p]));

    // 4. Build enriched entries (CSA counts fetched separately via /api/msi-renewals/csa)
    const entries: RenewalEntry[] = filtered.map((deal: any) => {
      const company = extractCompany(deal.properties?.dealname ?? "");
      const parsed = parsedMap.get(deal.id) ?? {};
      const msiYear = parsed.msiYear ?? extractYearFromName(deal.properties?.dealname ?? "");
      const nextMsiYear = msiYear ? msiYear + 1 : null;
      const orderFormLicense: number | null = parsed.orderFormLicense ?? null;
      // Auto-renew fallback: last invoiced year's license when no next-year entry exists
      const currentYearLicense: number | null = parsed.currentYearLicense ?? null;

      const csaCount: number | null = null;
      const csaRounded: number | null = null;

      // Base = order form license OR current year license (auto-renew fallback)
      const licenseFallback = orderFormLicense ?? currentYearLicense;
      const renewalCount =
        csaRounded !== null || licenseFallback !== null
          ? Math.max(csaRounded ?? 0, licenseFallback ?? 0)
          : null;

      const renewalDeal = renewalDealMap.get(company.toLowerCase()) ?? null;
      const renewalDealName = `${company} (MSI - Year ${nextMsiYear ?? "?"})`;

      return {
        currentDealId: deal.id,
        currentDealName: deal.properties?.dealname ?? "",
        company,
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
      };
    });

    // Sort alphabetically
    entries.sort((a, b) => a.company.localeCompare(b.company));

    return NextResponse.json({ deals: entries, expirationDate, renewalStartDate });
  } catch (error: any) {
    console.error("MSI renewals GET error:", error);
    return NextResponse.json({ error: error.message || "Internal server error" }, { status: 500 });
  }
}
