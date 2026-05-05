import { NextRequest, NextResponse } from "next/server";
import { callClaude, runAgentLoop, csaServer, configured, extractJSON } from "@/lib/anthropic";
import { getMsiDealsByStartDate, getDealNotes, getDealLineItems } from "@/lib/hubspot";
import type { RenewalEntry } from "@/lib/types";

export const maxDuration = 120;
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

const M1_PARSE_SYSTEM = `You are parsing HubSpot M1 renewal notes for MSI deals.
Each note is in HTML format. The note title is "1 Year Renewal M1 Order Form:" followed by bullet points listing MSI years.

Bullet format:
  "MSI Year N - X,XXX"              → order form license = X,XXX
  "MSI Year N - X,XXX (Y,YYY) ..." → X,XXX is the renewal count, Y,YYY is the ORDER FORM license

Italic bullets (<i> or <em> text) = already invoiced.
Non-italic = not yet invoiced.

For each deal, extract:
- msiYear: current deal year number (from the deal name field provided)
- nextMsiYear: msiYear + 1
- orderFormLicense: license count from the M1 note for nextMsiYear
  * If the note has "MSI Year [nextMsiYear] - X (Y)", return Y as orderFormLicense
  * If the note has "MSI Year [nextMsiYear] - X" (no parenthetical), return X
  * If nextMsiYear entry not found in note, return null
- m1NoteHtml: full HTML of the best matching note

Return ONLY valid JSON array:
[{"dealId":"...","msiYear":4,"nextMsiYear":5,"orderFormLicense":2000,"m1NoteHtml":"..."}]`;

const CSA_SYSTEM = `You have access to CSA tools. For each company name provided, query CSA to get the current circuit/subscriber count.
Return ONLY valid JSON mapping company names to counts (use null if not found):
{"Company Name": 12345, "Another Co": null}`;

export async function GET(req: NextRequest) {
  if (!process.env.HUBSPOT_ACCESS_TOKEN) {
    return NextResponse.json({ error: "HubSpot not configured" }, { status: 503 });
  }

  const startDate = req.nextUrl.searchParams.get("startDate");
  if (!startDate || !/^\d{4}-\d{2}-\d{2}$/.test(startDate)) {
    return NextResponse.json({ error: "startDate required (YYYY-MM-DD)" }, { status: 400 });
  }

  try {
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

    // 2. Fetch M1 notes and line items for current deals in parallel
    const notesAndItems = await Promise.all(
      filtered.map(async (deal: any) => {
        const [notes, lineItems] = await Promise.all([
          getDealNotes(deal.id).catch(() => []),
          getDealLineItems(deal.id).catch(() => []),
        ]);
        return { dealId: deal.id, notes, lineItems };
      })
    );

    // 3. Parse M1 notes with Claude
    const noteInput = filtered.map((deal: any, i: number) => ({
      dealId: deal.id,
      dealName: deal.properties?.dealname ?? "",
      msiYear: extractYearFromName(deal.properties?.dealname ?? ""),
      notes: (notesAndItems[i]?.notes ?? [])
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
        m1NoteHtml: null,
      }));
    }

    const parsedMap = new Map(parsedNotes.map((p: any) => [p.dealId, p]));

    // 4. Query CSA for circuit counts (optional — graceful fallback)
    const companies = filtered.map((d: any) => extractCompany(d.properties?.dealname ?? ""));
    let csaMap: Record<string, number | null> = {};
    const csaServers = configured(csaServer());
    if (csaServers.length > 0) {
      try {
        const csaResult = await runAgentLoop(
          CSA_SYSTEM,
          `Get current circuit counts for these companies:\n${JSON.stringify(companies)}`,
          csaServers,
          4096
        );
        csaMap = extractJSON<Record<string, number | null>>(csaResult);
      } catch {
        // CSA unavailable — proceed with nulls
      }
    }

    // 5. Build enriched entries
    const entries: RenewalEntry[] = filtered.map((deal: any) => {
      const company = extractCompany(deal.properties?.dealname ?? "");
      const parsed = parsedMap.get(deal.id) ?? {};
      const msiYear = parsed.msiYear ?? extractYearFromName(deal.properties?.dealname ?? "");
      const nextMsiYear = msiYear ? msiYear + 1 : null;
      const orderFormLicense: number | null = parsed.orderFormLicense ?? null;

      // CSA: fuzzy match by company name
      const csaCount: number | null =
        csaMap[company] ??
        Object.entries(csaMap).find(([k]) =>
          k.toLowerCase().includes(company.toLowerCase().slice(0, 6))
        )?.[1] ?? null;

      const csaRounded =
        csaCount !== null
          ? Math.max(1000, Math.ceil(csaCount / 50) * 50)
          : null;

      const renewalCount =
        csaRounded !== null || orderFormLicense !== null
          ? Math.max(csaRounded ?? 0, orderFormLicense ?? 0)
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
