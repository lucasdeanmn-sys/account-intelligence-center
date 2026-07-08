// app/api/targets/route.ts
// Read endpoint for the app UI: returns the ranked target list straight from HubSpot,
// so the list page has no separate database to stay in sync with.

import { NextResponse } from "next/server";
import { HUBSPOT_PROPS as P, SCORING_CONFIG as C } from "@/lib/scoring/config";

const BASE = "https://api.hubapi.com";

export const dynamic = "force-dynamic";

export async function GET() {
  const body = {
    filterGroups: [
      {
        filters: [
          { propertyName: P.TYPE, operator: "EQ", value: "PROSPECT" },
          { propertyName: P.TOTAL_SCORE, operator: "HAS_PROPERTY" },
        ],
      },
    ],
    properties: [P.NAME, P.DOMAIN, P.STATE, P.TOTAL_SCORE, P.FIT_SCORE, P.TRIGGER_SCORE, P.BREAKDOWN, P.SCORED_AT],
    sorts: [{ propertyName: P.TOTAL_SCORE, direction: "DESCENDING" }],
    limit: C.listSize,
  };

  const res = await fetch(`${BASE}/crm/v3/objects/companies/search`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.HUBSPOT_ACCESS_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    cache: "no-store",
  });

  if (!res.ok) {
    return NextResponse.json({ error: await res.text() }, { status: res.status });
  }

  const data = await res.json();
  const targets = (data.results ?? []).map((r: any) => {
    const p = r.properties ?? {};
    let breakdown: unknown = null;
    try {
      breakdown = p[P.BREAKDOWN] ? JSON.parse(p[P.BREAKDOWN]) : null;
    } catch {
      breakdown = null;
    }
    return {
      id: r.id,
      name: p[P.NAME],
      domain: p[P.DOMAIN],
      state: p[P.STATE],
      totalScore: Number(p[P.TOTAL_SCORE]),
      fitScore: Number(p[P.FIT_SCORE]),
      triggerScore: Number(p[P.TRIGGER_SCORE]),
      breakdown,
      scoredAt: p[P.SCORED_AT],
      hubspotUrl: `https://app-na2.hubspot.com/contacts/4584171/company/${r.id}`,
    };
  });

  return NextResponse.json({ targets });
}
