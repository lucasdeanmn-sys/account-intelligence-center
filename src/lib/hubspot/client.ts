// lib/hubspot/client.ts
// Minimal HubSpot v3 client for the scoring cron. Uses a Private App token.
// Env: HUBSPOT_ACCESS_TOKEN

import { HUBSPOT_PROPS as P } from "../scoring/config";
import type { CompanyRecord, DealSummary, Segment } from "../scoring/types";
import type { AccountScore } from "../scoring/types";

const BASE = "https://api.hubapi.com";
const TOKEN = process.env.HUBSPOT_ACCESS_TOKEN;

async function hs(path: string, init?: RequestInit): Promise<any> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
    // Opt out of the Next.js Data Cache — without this the weekly scoring run
    // can score STALE HubSpot data (fresh property values visible via curl
    // while the cron kept reading cached search responses). Same guard the
    // main lib (src/lib/hubspot.ts) has always carried.
    cache: "no-store",
  });
  if (res.status === 429) {
    // basic backoff on rate limit
    await new Promise((r) => setTimeout(r, 1500));
    return hs(path, init);
  }
  if (!res.ok) {
    throw new Error(`HubSpot ${res.status} on ${path}: ${await res.text()}`);
  }
  return res.json();
}

// ---- 1. Pull the prospect universe ----
// Companies where type = PROSPECT. Closed-lost-only companies still carry
// type = PROSPECT under your conventions, so this one filter covers the universe.

export async function fetchProspectCompanies(): Promise<Map<string, CompanyRecord>> {
  const companies = new Map<string, CompanyRecord>();
  let after: string | undefined;

  do {
    const body = {
      filterGroups: [
        { filters: [{ propertyName: P.TYPE, operator: "EQ", value: "PROSPECT" }] },
      ],
      properties: [P.NAME, P.DOMAIN, P.STATE, P.SUBSCRIBERS, P.SEGMENT, P.CALIX, P.MANUAL_TRIGGER],
      limit: 100,
      ...(after ? { after } : {}),
    };
    const page = await hs(`/crm/v3/objects/companies/search`, {
      method: "POST",
      body: JSON.stringify(body),
    });

    for (const r of page.results ?? []) {
      const props = r.properties ?? {};
      companies.set(r.id, {
        hubspotId: r.id,
        name: props[P.NAME] ?? "(unnamed)",
        domain: props[P.DOMAIN] ?? undefined,
        state: props[P.STATE] ?? undefined,
        subscriberCount: props[P.SUBSCRIBERS] ? Number(props[P.SUBSCRIBERS]) : undefined,
        segment: (props[P.SEGMENT] as Segment) || "UNKNOWN",
        isCalixShop: props[P.CALIX] === "true",
        manualTriggerFlag: props[P.MANUAL_TRIGGER] === "true",
        deals: [],
      });
    }
    after = page.paging?.next?.after;
  } while (after);

  return companies;
}

// ---- 2. Attach deal history ----
// Batch-read company→deal associations, then batch-read the deals themselves.

export async function attachDeals(companies: Map<string, CompanyRecord>): Promise<void> {
  const ids = Array.from(companies.keys());
  const dealToCompany = new Map<string, string>();

  // associations, 1000 inputs max per batch call
  for (let i = 0; i < ids.length; i += 1000) {
    const batch = ids.slice(i, i + 1000).map((id) => ({ id }));
    const assoc = await hs(`/crm/v4/associations/companies/deals/batch/read`, {
      method: "POST",
      body: JSON.stringify({ inputs: batch }),
    });
    for (const row of assoc.results ?? []) {
      for (const to of row.to ?? []) {
        dealToCompany.set(String(to.toObjectId), String(row.from.id));
      }
    }
  }

  // deal details, 100 per batch read
  const dealIds = Array.from(dealToCompany.keys());
  for (let i = 0; i < dealIds.length; i += 100) {
    const batch = dealIds.slice(i, i + 100).map((id) => ({ id }));
    const deals = await hs(`/crm/v3/objects/deals/batch/read`, {
      method: "POST",
      body: JSON.stringify({
        inputs: batch,
        properties: ["pipeline", "dealstage", "hs_is_closed_lost", "hs_is_closed", "closedate", "notes_last_updated"],
      }),
    });
    for (const d of deals.results ?? []) {
      const companyId = dealToCompany.get(d.id);
      const company = companyId ? companies.get(companyId) : undefined;
      if (!company) continue;
      const p = d.properties ?? {};
      const summary: DealSummary = {
        dealId: d.id,
        pipeline: p.pipeline,
        stage: p.dealstage,
        isClosedLost: p.hs_is_closed_lost === "true",
        isOpen: p.hs_is_closed !== "true",
        closedDate: p.closedate ?? undefined,
        lastActivityDate: p.notes_last_updated ?? undefined,
      };
      company.deals.push(summary);
    }
  }
}

// ---- 3. Write scores back ----
// Batch update, 100 per call. Breakdown stored as JSON in a multi-line text prop.

export async function writeScores(scores: AccountScore[]): Promise<void> {
  for (let i = 0; i < scores.length; i += 100) {
    const inputs = scores.slice(i, i + 100).map((s) => ({
      id: s.hubspotId,
      properties: {
        [P.TOTAL_SCORE]: String(s.totalScore),
        [P.FIT_SCORE]: String(s.fitScore),
        [P.TRIGGER_SCORE]: String(s.triggerScore),
        [P.BREAKDOWN]: JSON.stringify({ fit: s.fitComponents, trigger: s.triggerComponents }),
        [P.SCORED_AT]: s.scoredAt.slice(0, 10), // HubSpot date property wants YYYY-MM-DD
      },
    }));
    await hs(`/crm/v3/objects/companies/batch/update`, {
      method: "POST",
      body: JSON.stringify({ inputs }),
    });
  }
}
