import { NextResponse } from "next/server";
import { callClaude, extractJSON } from "@/lib/anthropic";
import { searchDeals, getDealNotes } from "@/lib/hubspot";
import type { MSIDeal } from "@/lib/types";

export const maxDuration = 180;
export const dynamic = "force-dynamic";

const SYSTEM = `You are an AI assistant analyzing MSI (Adtran channel) deals for a B2B SaaS AE.

MSI deals are identified by "(MSI" in the deal name. Examples: "Acme Corp (MSI - Year 2)", "Beta Inc (MSI - Year 1)".

## M1 Note Format
M1 notes are stored in HubSpot as HTML. Format:
- Each line = one subscription year
- Format per line: [circuit_count] ([contract_value]) - [Month YYYY]
- Lines wrapped in <i> or <em> tags = already invoiced years
- First NON-italic line = next renewal
- The circuit count = contracted circuits for that renewal year

Example M1 note:
<i>50 ($12,000) - Jan 2024</i>
<i>50 ($13,200) - Jan 2025</i>
75 ($14,520) - Jan 2026

Means: 50 contracted circuits, Year 3 renews Jan 2026, contract value $14,520

## Circuit Discrepancy Logic
- If CSSA tools are available, query CSSA for actual circuit count for each company
- If actual ≠ contracted: flag as "circuit_discrepancy"
- Recommended invoice circuits = actual circuits rounded UP to next multiple of 50
  (e.g., actual=73 → recommend 100; actual=50 → no discrepancy if matches contract)
- Recommended invoice amount = use per-circuit rate from M1 note if calculable

## Flags to Apply
- "missing_m1_note": No M1 note found on deal
- "malformed_m1_note": M1 note exists but can't be parsed
- "circuit_discrepancy": CSSA actual ≠ contracted circuits
- "renewal_imminent": Next renewal within 30 days
- "renewal_overdue": Next renewal date is in the past
- "cssa_unavailable": CSSA returned no data for this company

Today's date will be provided. Use it to calculate renewal timing.

Return ONLY valid JSON:
\`\`\`json
[
  {
    "id": "deal_id_from_hubspot",
    "name": "Deal Name (MSI - Year X)",
    "company": "Company Name",
    "stage": "Deal Stage",
    "closeDate": "2025-12-31",
    "m1Note": "<i>50 ($12,000) - Jan 2024</i>\\n75 ($13,200) - Jan 2025",
    "contractedCircuits": 75,
    "contractValue": 13200,
    "nextRenewalDate": "Jan 2025",
    "nextRenewalYear": 2,
    "actualCircuits": 90,
    "recommendedInvoiceCircuits": 100,
    "recommendedInvoiceAmount": 15840,
    "alreadyInvoicedYears": 1,
    "flags": ["circuit_discrepancy"]
  }
]
\`\`\``;

export async function GET() {
  if (!process.env.HUBSPOT_ACCESS_TOKEN) {
    return NextResponse.json(
      {
        error:
          "HubSpot is not configured. Add HUBSPOT_ACCESS_TOKEN to your environment variables.",
      },
      { status: 503 }
    );
  }

  try {
    // Fetch all deals with "(MSI" in the name directly from HubSpot
    const rawDeals = await searchDeals(
      [{ propertyName: "dealname", operator: "CONTAINS_TOKEN", value: "MSI" }],
      ["dealname", "dealstage", "amount", "closedate", "hs_is_closed"],
      100
    );

    // Filter to only deals that literally contain "(MSI"
    const msiDeals = rawDeals.filter((d: any) =>
      d.properties?.dealname?.includes("(MSI")
    );

    // Fetch notes for all MSI deals in parallel
    const notesPerDeal = await Promise.all(
      msiDeals.map((d: any) => getDealNotes(d.id).catch(() => [] as any[]))
    );

    // Build enriched deal context for Claude
    const enriched = msiDeals.map((deal: any, i: number) => {
      const notes: any[] = notesPerDeal[i] ?? [];
      return {
        id: deal.id,
        name: deal.properties?.dealname,
        stage: deal.properties?.dealstage,
        closeDate: deal.properties?.closedate,
        isClosed: deal.properties?.hs_is_closed === "true",
        notes: notes.map((n: any) => ({
          body: n.properties?.hs_note_body,
          timestamp: n.properties?.hs_timestamp,
        })),
      };
    });

    const today = new Date().toISOString().split("T")[0];

    const result = await callClaude(
      SYSTEM,
      `Today is ${today}.

## HubSpot MSI Deals (pre-fetched — ${enriched.length} deals)
${JSON.stringify(enriched, null, 2)}

Instructions:
1. For each deal above, find the M1 note in the notes array.
2. Parse the M1 note to extract contracted circuits, contract value, and next renewal date.
3. Apply all relevant flags based on the parsed data and today's date (${today}).
4. For circuit discrepancy checks, set actualCircuits to null and flag as "cssa_unavailable" since CSSA is not connected.
5. Return the complete JSON array for all ${enriched.length} MSI deals.`,
      16000
    );

    let deals: MSIDeal[] = [];
    try {
      deals = extractJSON<MSIDeal[]>(result);
    } catch {
      return NextResponse.json(
        { deals: [], rawResponse: result },
        { status: 200 }
      );
    }

    // Sort: flagged first, then by renewal date
    deals.sort((a, b) => {
      const aFlagged = a.flags.length > 0 ? -1 : 1;
      const bFlagged = b.flags.length > 0 ? -1 : 1;
      if (aFlagged !== bFlagged) return aFlagged - bFlagged;
      if (a.nextRenewalDate && b.nextRenewalDate) {
        return (
          new Date(a.nextRenewalDate).getTime() -
          new Date(b.nextRenewalDate).getTime()
        );
      }
      return 0;
    });

    return NextResponse.json({ deals });
  } catch (error: any) {
    console.error("MSI tracker API error:", error);
    return NextResponse.json(
      { error: error.message || "Internal server error" },
      { status: 500 }
    );
  }
}
