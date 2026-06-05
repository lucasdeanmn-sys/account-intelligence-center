const BASE = "https://api.hubapi.com";

// Sentinel value stored in service_terminated when a renewal is marked
// "Did Not Renew".  Chosen as a timestamp clearly before the MSI program
// existed (2000-01-01 UTC) so it can be distinguished from a real
// termination date set by the process route (~2025+ timestamps).
export const CANCEL_SENTINEL = "946684800000";

function token() {
  const t = process.env.HUBSPOT_ACCESS_TOKEN;
  if (!t) throw new Error("HUBSPOT_ACCESS_TOKEN not configured");
  return t;
}

async function hs(method: string, path: string, body?: unknown): Promise<any> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token()}`,
      "Content-Type": "application/json",
    },
    // Explicitly opt out of Next.js Data Cache so HubSpot responses are always
    // fresh — force-dynamic on the route isn't reliably propagated to fetch calls
    // in production builds of Next.js 14.
    cache: "no-store",
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(15_000), // prevent indefinite hangs
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HubSpot ${res.status} ${method} ${path}: ${text}`);
  }
  return res.json();
}

// ─── Read helpers ─────────────────────────────────────────────────────────────

export async function searchDeals(
  filters: object[],
  properties: string[],
  limit = 100,
  sorts?: object[]
): Promise<any[]> {
  const body: any = {
    filterGroups: [{ filters }],
    properties,
    limit,
  };
  if (sorts) body.sorts = sorts;
  const res = await hs("POST", "/crm/v3/objects/deals/search", body);
  return res.results ?? [];
}

async function fetchNotesByIds(ids: string[]): Promise<any[]> {
  if (!ids.length) return [];
  const batch = await hs("POST", "/crm/v3/objects/notes/batch/read", {
    inputs: ids.map((id) => ({ id })),
    properties: ["hs_note_body", "hs_timestamp"],
  }).catch(() => ({ results: [] }));
  return batch.results ?? [];
}

async function getCompanyNotesForDeal(dealId: string): Promise<any[]> {
  const companyAssoc = await hs(
    "GET",
    `/crm/v4/objects/deals/${dealId}/associations/companies`
  ).catch(() => ({ results: [] }));
  const companyIds: string[] = (companyAssoc.results ?? [])
    .map((r: any) => String(r.toObjectId ?? ""))
    .filter(Boolean);
  if (!companyIds.length) return [];

  // Fetch note associations for all companies in parallel
  const perCompany = await Promise.all(
    companyIds.map(async (companyId) => {
      const noteAssoc = await hs(
        "GET",
        `/crm/v4/objects/companies/${companyId}/associations/notes`
      ).catch(() => ({ results: [] }));
      const noteIds: string[] = (noteAssoc.results ?? [])
        .map((r: any) => String(r.toObjectId ?? ""))
        .filter(Boolean);
      return fetchNotesByIds(noteIds);
    })
  );
  return perCompany.flat();
}

export async function getDealNotes(dealId: string): Promise<any[]> {
  // Fetch v4 direct associations and company-level notes simultaneously.
  const [v4Assoc, companyNotes] = await Promise.all([
    hs("GET", `/crm/v4/objects/deals/${dealId}/associations/notes`).catch(() => ({ results: [] })),
    getCompanyNotesForDeal(dealId),
  ]);

  let directIds: string[] = (v4Assoc.results ?? [])
    .map((r: any) => String(r.toObjectId))
    .filter((id: string) => id && id !== "undefined");

  // Fall back to CRM v3 if v4 returned nothing (some older deals)
  if (!directIds.length) {
    const v3Assoc = await hs(
      "GET",
      `/crm/v3/objects/deals/${dealId}/associations/notes`
    ).catch(() => ({ results: [] }));
    directIds = (v3Assoc.results ?? [])
      .map((r: any) => String(r.id))
      .filter((id: string) => Boolean(id));
  }

  const directNotes = directIds.length ? await fetchNotesByIds(directIds) : [];

  // Merge direct + company notes, deduplicating by ID
  const seen = new Set<string>();
  const merged: any[] = [];
  for (const note of [...directNotes, ...companyNotes]) {
    const id = String(note.id ?? "");
    if (id && !seen.has(id)) {
      seen.add(id);
      merged.push(note);
    }
  }
  return merged;
}

export async function getDealTasks(dealId: string): Promise<any[]> {
  const assoc = await hs(
    "GET",
    `/crm/v4/objects/deals/${dealId}/associations/tasks`
  ).catch(() => ({ results: [] }));
  const ids: string[] = (assoc.results ?? []).map((r: any) => String(r.toObjectId));
  if (!ids.length) return [];
  const batch = await hs("POST", "/crm/v3/objects/tasks/batch/read", {
    inputs: ids.map((id) => ({ id })),
    properties: [
      "hs_task_subject",
      "hs_task_body",
      "hs_task_status",
      "hs_task_priority",
      "hs_timestamp",
    ],
  }).catch(() => ({ results: [] }));
  return batch.results ?? [];
}

export async function getDealContacts(dealId: string): Promise<any[]> {
  const assoc = await hs(
    "GET",
    `/crm/v4/objects/deals/${dealId}/associations/contacts`
  ).catch(() => ({ results: [] }));
  const ids: string[] = (assoc.results ?? []).map((r: any) => String(r.toObjectId));
  if (!ids.length) return [];
  const batch = await hs("POST", "/crm/v3/objects/contacts/batch/read", {
    inputs: ids.map((id) => ({ id })),
    properties: ["firstname", "lastname", "email", "phone", "jobtitle"],
  }).catch(() => ({ results: [] }));
  return batch.results ?? [];
}

// ─── Write helpers ────────────────────────────────────────────────────────────

async function associate(
  fromType: string,
  fromId: string,
  toType: string,
  toId: string
) {
  return hs(
    "PUT",
    `/crm/v4/objects/${fromType}/${fromId}/associations/default/${toType}/${toId}`
  );
}

export async function createNote(
  dealId: string,
  htmlBody: string,
  ownerId: string
) {
  const note = await hs("POST", "/crm/v3/objects/notes", {
    properties: {
      hs_note_body: htmlBody,
      hs_timestamp: new Date().toISOString(),
      hubspot_owner_id: ownerId,
    },
  });
  await associate("notes", note.id, "deals", dealId);
  return note;
}

/** Create a note on a deal without requiring an owner.
 *  Used by the cancel route to stamp "Did not renew" on deals that have no
 *  existing M1 note, so the server-side cancelled detection works on re-run. */
export async function createDealNote(dealId: string, htmlBody: string): Promise<void> {
  const note = await hs("POST", "/crm/v3/objects/notes", {
    properties: {
      hs_note_body: htmlBody,
      hs_timestamp: new Date().toISOString(),
    },
  });
  await associate("notes", note.id, "deals", dealId);
}

/** Create a note directly on a company object.
 *  Used by the cancel route as the primary detection signal: company notes are
 *  returned by getCompanyNotesForDeal for ANY deal associated with the company,
 *  so cancelled detection works even when the algorithm picks a different deal
 *  between runs (e.g. a company with two MSI deals under different names such
 *  as "NTS Communications" and "Vexus Fiber"). */
export async function createCompanyNote(companyId: string, htmlBody: string): Promise<void> {
  const note = await hs("POST", "/crm/v3/objects/notes", {
    properties: {
      hs_note_body: htmlBody,
      hs_timestamp: new Date().toISOString(),
    },
  });
  await associate("notes", note.id, "companies", companyId);
}

export async function createTask(
  dealId: string,
  subject: string,
  priority: string,
  dueDate: string | null,
  notes: string | null,
  ownerId: string
) {
  const properties: Record<string, string> = {
    hs_task_subject: subject,
    hs_task_priority: priority.toUpperCase(),
    hs_task_status: "NOT_STARTED",
    hubspot_owner_id: ownerId,
    hs_timestamp: dueDate
      ? new Date(dueDate).toISOString()
      : new Date().toISOString(),
  };
  if (notes) properties.hs_task_body = notes;
  const task = await hs("POST", "/crm/v3/objects/tasks", { properties });
  await associate("tasks", task.id, "deals", dealId);
  return task;
}

export async function createContact(
  dealId: string | null,
  firstName: string,
  lastName: string,
  email: string,
  phone: string | null,
  title: string | null,
  ownerId: string
) {
  const properties: Record<string, string> = {
    firstname: firstName,
    lastname: lastName,
    email,
    hubspot_owner_id: ownerId,
  };
  if (phone) properties.phone = phone;
  if (title) properties.jobtitle = title;
  const contact = await hs("POST", "/crm/v3/objects/contacts", { properties });
  if (dealId) await associate("contacts", contact.id, "deals", dealId);
  return contact;
}

export async function createDeal(
  dealName: string,
  stage: string,
  amount: string | null,
  closeDate: string | null,
  companyName: string | null,
  ownerId: string
) {
  const properties: Record<string, string> = {
    dealname: dealName,
    dealstage: stage,
    hubspot_owner_id: ownerId,
  };
  if (amount) properties.amount = amount;
  if (closeDate) {
    properties.closedate = new Date(closeDate).toISOString().split("T")[0];
  }
  const deal = await hs("POST", "/crm/v3/objects/deals", { properties });

  if (companyName) {
    try {
      const search = await hs("POST", "/crm/v3/objects/companies/search", {
        filterGroups: [
          {
            filters: [
              { propertyName: "name", operator: "EQ", value: companyName },
            ],
          },
        ],
        properties: ["name"],
        limit: 1,
      });
      let companyId: string;
      if (search.results?.length > 0) {
        companyId = search.results[0].id;
      } else {
        const co = await hs("POST", "/crm/v3/objects/companies", {
          properties: { name: companyName },
        });
        companyId = co.id;
      }
      await associate("deals", deal.id, "companies", companyId);
    } catch {
      // Don't fail deal creation if company association fails
    }
  }

  return deal;
}

export async function searchProducts(name: string): Promise<any[]> {
  const res = await hs("POST", "/crm/v3/objects/products/search", {
    filterGroups: [
      {
        filters: [
          {
            propertyName: "name",
            operator: "CONTAINS_TOKEN",
            value: name,
          },
        ],
      },
    ],
    properties: ["name", "price", "description"],
    limit: 5,
  }).catch(() => ({ results: [] }));
  return res.results ?? [];
}

// ─── MSI Renewal helpers ──────────────────────────────────────────────────────

const MSI_DEAL_PROPS = [
  "dealname", "dealstage", "pipeline", "amount", "closedate",
  "subscription_start_date", "hubspot_owner_id", "service_terminated",
];

/**
 * Find all HubSpot deals associated with the company whose noc_instance_id
 * matches the given CSA instanceId.  Returns raw deal objects (unfiltered).
 *
 * Flow: company search (noc_instance_id=id) → company→deal associations →
 *       batch-read deal properties.
 */
export async function getMsiDealsByCompanyInstanceId(instanceId: number): Promise<any[]> {
  // 1. Find companies with this noc_instance_id
  const coRes = await hs("POST", "/crm/v3/objects/companies/search", {
    filterGroups: [{ filters: [
      { propertyName: "noc_instance_id", operator: "EQ", value: String(instanceId) },
    ]}],
    properties: ["name", "noc_instance_id"],
    limit: 5,
  }).catch(() => ({ results: [] }));
  const companies: any[] = coRes.results ?? [];
  if (!companies.length) return [];

  // 2. Collect deal IDs from all matching companies
  const dealIds = new Set<string>();
  await Promise.all(companies.map(async (co) => {
    const assoc = await hs("GET", `/crm/v4/objects/companies/${co.id}/associations/deals`)
      .catch(() => ({ results: [] }));
    for (const r of (assoc.results ?? [])) {
      dealIds.add(String(r.toObjectId));
    }
  }));
  if (!dealIds.size) return [];

  // 3. Batch-read deal properties (cap at 50 to stay well within HubSpot limits)
  const idList = Array.from(dealIds).slice(0, 50);
  const batchRes = await hs("POST", "/crm/v3/objects/deals/batch/read", {
    inputs: idList.map((id) => ({ id })),
    properties: MSI_DEAL_PROPS,
  }).catch(() => ({ results: [] }));
  return batchRes.results ?? [];
}

// Batch-fetch noc_instance_id (Customer Number) from the company associated with each deal.
// Returns a Map<dealId, instanceId | null>.
export async function getDealCompanyNocIds(
  dealIds: string[]
): Promise<Map<string, number | null>> {
  const result = new Map<string, number | null>();
  if (!dealIds.length) return result;

  // Step 1: Fetch the first company association for each deal (10 at a time)
  const dealCompanyMap = new Map<string, string>(); // dealId → companyId
  const BATCH = 10;
  for (let i = 0; i < dealIds.length; i += BATCH) {
    const batch = dealIds.slice(i, i + BATCH);
    await Promise.all(
      batch.map(async (dealId) => {
        const assoc = await hs(
          "GET",
          `/crm/v4/objects/deals/${dealId}/associations/companies`
        ).catch(() => ({ results: [] }));
        const firstId = (assoc.results ?? [])[0]?.toObjectId;
        if (firstId) dealCompanyMap.set(dealId, String(firstId));
      })
    );
  }

  // Step 2: Batch-read noc_instance_id from all unique companies
  const uniqueCompanyIds = Array.from(new Set(Array.from(dealCompanyMap.values())));
  if (uniqueCompanyIds.length) {
    const batchRes = await hs("POST", "/crm/v3/objects/companies/batch/read", {
      inputs: uniqueCompanyIds.map((id) => ({ id })),
      properties: ["noc_instance_id"],
    }).catch(() => ({ results: [] }));

    const companyNocMap = new Map<string, number | null>();
    for (const co of batchRes.results ?? []) {
      const raw = co.properties?.noc_instance_id;
      const n = raw ? parseInt(raw, 10) : NaN;
      companyNocMap.set(String(co.id), isNaN(n) ? null : n);
    }

    // Step 3: Map deal → noc_instance_id
    for (const [dealId, companyId] of Array.from(dealCompanyMap.entries())) {
      result.set(dealId, companyNocMap.get(companyId) ?? null);
    }
  }

  // Deals with no associated company
  for (const dealId of dealIds) {
    if (!result.has(dealId)) result.set(dealId, null);
  }

  return result;
}

// Normalise a company name for extension lookups: lowercase, trim, strip common
// legal suffixes so "BEC Communication, LLC" and "BEC Communication" both map
// to the same key.
export function normExtCo(s: string): string {
  return s.toLowerCase().trim()
    .replace(/[,.]?\s*(llc|inc|co|corp|ltd)\.?\s*$/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

export interface ExtensionIndex {
  /** Lookup by normalised/exact company name prefix from the deal name */
  byName: Map<string, string[]>;
  /** Lookup by noc_instance_id — the most reliable key because the same
   *  company object is shared by both the MSI deal and its extension deal,
   *  even when the two deals use different company name prefixes (e.g.
   *  "Bartlett Electric Cooperative" MSI vs "BEC Communication" extension). */
  byNocId: Map<number, string[]>;
  /** Extension deals whose noc_instance_id lookup is deferred so the main
   *  route can batch them together with the MSI deal company lookups in a
   *  single getDealCompanyNocIds call — avoids a separate lookup that can
   *  silently fail under HubSpot rate-limiting during the parallel fetch. */
  pendingNocLookup: Array<{ dealId: string; extName: string }>;
}

/** Fetch all active MSI extension deals and index them by both name and
 *  noc_instance_id so the route can find extensions regardless of whether
 *  the extension deal name prefix matches the MSI deal company name. */
export async function getActiveExtensionCompanies(): Promise<ExtensionIndex> {
  const [deals, pipelineRes] = await Promise.all([
    searchDeals(
      [
        { propertyName: "dealname", operator: "CONTAINS_TOKEN", value: "MSI" },
        { propertyName: "dealname", operator: "CONTAINS_TOKEN", value: "Extension" },
      ],
      ["dealname", "service_terminated", "dealstage"],
      200
    ).catch(() => []),
    hs("GET", "/crm/v3/pipelines/deals").catch(() => ({ results: [] })),
  ]);

  // Build a set of Closed Lost stage IDs (isClosed=true, probability=0).
  // Extension deals in Closed Lost are not active and should not count.
  const closedLostIds = new Set<string>();
  for (const p of (pipelineRes.results ?? [])) {
    for (const s of (p.stages ?? []) as any[]) {
      if (
        s.metadata?.isClosed === "true" &&
        (s.metadata?.probability === "0.0" || s.metadata?.probability === "0")
      ) {
        closedLostIds.add(String(s.id));
      }
    }
  }

  const byName  = new Map<string, string[]>();
  const byNocId = new Map<number, string[]>();

  function addToName(key: string, extName: string) {
    const existing = byName.get(key) ?? [];
    if (!existing.includes(extName)) existing.push(extName);
    byName.set(key, existing);
  }

  // Active extension deals and their parsed extension names
  const active: { dealId: string; extName: string }[] = [];

  for (const deal of deals) {
    if (deal.properties?.service_terminated) continue;
    // Skip deals in a Closed Lost stage — the extension was never executed
    if (deal.properties?.dealstage && closedLostIds.has(deal.properties.dealstage)) continue;
    const name: string = deal.properties?.dealname ?? "";
    const idx = name.indexOf(" (MSI");
    if (idx <= 0) continue;
    const raw     = name.slice(0, idx).trim();
    const extName = extractExtensionName(name);
    // Store under exact lowercase key AND normalised key
    addToName(raw.toLowerCase(), extName);
    const normKey = normExtCo(raw);
    if (normKey !== raw.toLowerCase()) addToName(normKey, extName);
    active.push({ dealId: deal.id, extName });
  }

  // Defer the noc_instance_id lookups for extension deals.
  // The main route will include these deal IDs in its own getDealCompanyNocIds
  // call (which already fetches company IDs for MSI deals), so both sets are
  // resolved in one combined API batch instead of two separate calls that can
  // silently fail under HubSpot rate-limiting during the parallel fetch phase.
  return { byName, byNocId, pendingNocLookup: active };
}

export async function getMsiDealsByStartDate(
  isoDate: string,
  pipelineId?: string
): Promise<any[]> {
  const dayStart = new Date(isoDate + "T00:00:00.000Z").getTime().toString();
  const dayEnd = new Date(isoDate + "T23:59:59.999Z").getTime().toString();
  const filters: object[] = [
    { propertyName: "subscription_start_date", operator: "GTE", value: dayStart },
    { propertyName: "subscription_start_date", operator: "LTE", value: dayEnd },
    { propertyName: "dealname", operator: "CONTAINS_TOKEN", value: "MSI" },
  ];
  if (pipelineId) {
    filters.push({ propertyName: "pipeline", operator: "EQ", value: pipelineId });
  }
  return searchDeals(
    filters,
    ["dealname", "dealstage", "pipeline", "amount", "closedate", "subscription_start_date", "hubspot_owner_id", "service_terminated"],
    200
  );
}

/**
 * Find MSI deals whose deal name contains a given company name fragment.
 * Used as a CSA-driven fallback when a company appears in the CSA renewal
 * snapshot but wasn't found by any date-based HubSpot search.
 */
// Generic telecom / business words that make poor HubSpot search tokens because
// they appear in hundreds of deal names and produce noisy, irrelevant results.
// When building the search token we skip these and fall back to shorter but more
// distinctive words (e.g. "La Ward Telephone Co" → "Ward", not "Telephone").
const GENERIC_TELECOM_TOKENS = new Set([
  "communications", "communication", "telephone", "connect", "connected",
  "broadband", "electric", "electrical", "cooperative", "coop", "telecom",
  // NOTE: "fiber" is intentionally omitted — "Fiber Connect" needs "Fiber" as its
  // search token because "Connect" is also generic and would produce worse results.
  "networks", "network", "internet", "services", "service",
  "company", "systems", "system", "co", "inc", "llc", "ltd", "corp",
  "association", "authority", "rural", "mutual", "local",
]);

export async function searchMsiDealsByCompanyName(company: string): Promise<any[]> {
  // Build a distinctive search token from the company name:
  //   1. Split on whitespace, drop single-char tokens
  //   2. Remove generic telecom/business terms (they return hundreds of unrelated deals)
  //   3. If nothing remains after filtering, fall back to the full token list
  //   4. Pick the longest token from the remaining pool
  // Examples:
  //   "La Ward Telephone Co"    → ["Ward"] → "Ward"
  //   "Palo Communications"     → ["Palo"] → "Palo"
  //   "Fiber Connect"           → ["Fiber"] → "Fiber"  ("Connect" is generic; "Fiber" is not in the set)
  //   "BEC Communication"       → ["BEC"]  → "BEC"
  //   "United Communications"   → ["United"] → "United"
  const tokens = company.trim().split(/\s+/).filter((t) => t.length > 1);
  const significant = tokens.filter((t) => !GENERIC_TELECOM_TOKENS.has(t.toLowerCase()));
  const pool = significant.length > 0 ? significant : tokens;
  const mainToken = pool.reduce((a, b) => (a.length >= b.length ? a : b), pool[0] ?? company);
  return searchDeals(
    [
      { propertyName: "dealname", operator: "CONTAINS_TOKEN", value: mainToken },
      { propertyName: "dealname", operator: "CONTAINS_TOKEN", value: "MSI" },
    ],
    ["dealname", "dealstage", "pipeline", "amount", "closedate", "subscription_start_date", "hubspot_owner_id", "service_terminated"],
    20
  );
}

/**
 * Fetch MSI deals whose subscription_start_date falls anywhere within a calendar
 * month.  More reliable than getMsiDealsByStartDate (which matches a single day)
 * for companies whose start date is set to a non-standard day — e.g. Syntrio
 * starts June 19, 2025 instead of June 1, 2025.
 *
 * yearMonth: "2025-06"
 */
export async function getMsiDealsByStartMonth(yearMonth: string): Promise<any[]> {
  const [y, m] = yearMonth.split("-").map(Number);
  const firstDay = new Date(`${yearMonth}-01T00:00:00.000Z`).getTime().toString();
  // Last millisecond of the last day of the month
  const lastDayDate = new Date(Date.UTC(y, m, 0, 23, 59, 59, 999));
  const lastDay = lastDayDate.getTime().toString();
  return searchDeals(
    [
      { propertyName: "subscription_start_date", operator: "GTE", value: firstDay },
      { propertyName: "subscription_start_date", operator: "LTE", value: lastDay },
      { propertyName: "dealname", operator: "CONTAINS_TOKEN", value: "MSI" },
    ],
    ["dealname", "dealstage", "pipeline", "amount", "closedate", "subscription_start_date", "hubspot_owner_id", "service_terminated"],
    200
  );
}

/** Batch-fetch deals by ID using the direct object API (not search).
 *  Unlike search, this returns current property values immediately — no index lag. */
export async function getDealsByIds(dealIds: string[], properties: string[]): Promise<any[]> {
  if (!dealIds.length) return [];
  const res = await hs("POST", "/crm/v3/objects/deals/batch/read", {
    inputs: dealIds.map((id) => ({ id })),
    properties,
  });
  return res.results ?? [];
}

export async function getDealLineItems(dealId: string): Promise<any[]> {
  const assoc = await hs("GET", `/crm/v4/objects/deals/${dealId}/associations/line_items`).catch(() => ({ results: [] }));
  const ids: string[] = (assoc.results ?? []).map((r: any) => String(r.toObjectId));
  if (!ids.length) return [];
  const batch = await hs("POST", "/crm/v3/objects/line_items/batch/read", {
    inputs: ids.map((id) => ({ id })),
    properties: ["name", "quantity", "price", "amount", "hs_product_id", "recurringbillingfrequency"],
  }).catch(() => ({ results: [] }));
  return batch.results ?? [];
}

export async function updateNoteBody(noteId: string, htmlBody: string) {
  return hs("PATCH", `/crm/v3/objects/notes/${noteId}`, {
    properties: { hs_note_body: htmlBody },
  });
}

export async function updateLineItem(lineItemId: string, quantity: number) {
  return hs("PATCH", `/crm/v3/objects/line_items/${lineItemId}`, {
    properties: { quantity: String(quantity) },
  });
}

export async function updateDealProperties(dealId: string, properties: Record<string, string>) {
  return hs("PATCH", `/crm/v3/objects/deals/${dealId}`, { properties });
}

// Returns { pipelineId, stageId } for the "Closed Won - Ready for Billing" stage.
// Searches the pipeline whose label contains pipelineNameSubstring first; if not
// found, falls back to scanning every pipeline for a "ready for billing" stage.
// Returns the set of deal stage IDs that indicate a renewal has been fully
// processed — specifically any stage whose label contains "ready for billing"
// or "invoiced" across all pipelines.
export async function getProcessedStageIds(): Promise<Set<string>> {
  const res = await hs("GET", "/crm/v3/pipelines/deals").catch(() => ({ results: [] }));
  const pipelines: any[] = res.results ?? [];
  const ids = new Set<string>();
  for (const p of pipelines) {
    for (const s of (p.stages ?? []) as any[]) {
      const l: string = (s.label ?? "").toLowerCase();
      if (l.includes("ready for billing") || l.includes("invoiced")) {
        ids.add(String(s.id));
      }
    }
  }
  return ids;
}

export async function getClosedWonStage(pipelineNameSubstring: string): Promise<{ pipelineId: string; stageId: string } | null> {
  const res = await hs("GET", "/crm/v3/pipelines/deals");
  const pipelines: any[] = res.results ?? [];

  const isTargetStage = (label: string) => {
    const l = label.toLowerCase();
    // Must match "ready for billing" exactly — "billing" alone is too broad and
    // incorrectly matches "Pending Billing" which is an earlier pipeline stage.
    return l.includes("ready for billing");
  };
  const isFallbackClosedWon = (s: any) =>
    s.metadata?.isClosed === "true" && s.metadata?.probability === "1.0";

  // 1. Try the named pipeline first
  const named = pipelines.find((p: any) =>
    p.label?.toLowerCase().includes(pipelineNameSubstring.toLowerCase())
  );
  if (named) {
    const stages: any[] = named.stages ?? [];
    const s = stages.find((s: any) => isTargetStage(s.label ?? "")) ?? stages.find(isFallbackClosedWon);
    if (s) return { pipelineId: named.id, stageId: s.id };
  }

  // 2. Scan all pipelines for "Ready for Billing"
  for (const p of pipelines) {
    const stages: any[] = p.stages ?? [];
    const s = stages.find((s: any) => isTargetStage(s.label ?? ""));
    if (s) return { pipelineId: p.id, stageId: s.id };
  }

  // 3. Last resort: any closed-won stage in any pipeline
  for (const p of pipelines) {
    const stages: any[] = p.stages ?? [];
    const s = stages.find(isFallbackClosedWon);
    if (s) return { pipelineId: p.id, stageId: s.id };
  }

  return null;
}

// Return the first open (non-billing, non-closed) stage ID in the renewal pipeline.
// Used by the unprocess route to roll a renewal deal back out of "Ready for Billing".
export async function getFirstOpenStageId(pipelineNameSubstring: string): Promise<string | null> {
  const res = await hs("GET", "/crm/v3/pipelines/deals").catch(() => ({ results: [] }));
  const pipelines: any[] = res.results ?? [];

  const isClosedOrBilling = (s: any) => {
    const l = (s.label ?? "").toLowerCase();
    return (
      l.includes("billing") || l.includes("invoiced") ||
      s.metadata?.isClosed === "true"
    );
  };

  // Prefer the named pipeline, fall back to any pipeline
  const named = pipelines.find((p: any) =>
    p.label?.toLowerCase().includes(pipelineNameSubstring.toLowerCase())
  );
  const pipeline = named ?? pipelines[0];
  if (!pipeline) return null;

  const stages: any[] = [...(pipeline.stages ?? [])].sort(
    (a: any, b: any) => (a.displayOrder ?? 0) - (b.displayOrder ?? 0)
  );
  const open = stages.find((s) => !isClosedOrBilling(s));
  return open?.id ?? null;
}

export async function createMsiRenewalDeal(
  name: string,
  subscriptionStartDate: string,
  ownerId: string,
  pipelineId?: string,
  stageId?: string,
  extraProperties?: Record<string, string>
) {
  const properties: Record<string, string> = {
    dealname: name,
    hubspot_owner_id: ownerId,
    subscription_start_date: new Date(subscriptionStartDate + "T00:00:00.000Z").getTime().toString(),
    ...extraProperties,
  };
  if (pipelineId) properties.pipeline = pipelineId;
  if (stageId) properties.dealstage = stageId;
  return hs("POST", "/crm/v3/objects/deals", { properties });
}

// Fetch select custom fields from a deal (for copying to the renewal deal)
const COPYABLE_DEAL_FIELDS = [
  "channel_rep",
  "channel_partner",
  "lead_source",
  "type_of_billing",
  "subscription_term",
  "of_subs_license_",
  "deal_currency_code",
] as const;

export async function getDealCustomFields(
  dealId: string
): Promise<Partial<Record<(typeof COPYABLE_DEAL_FIELDS)[number], string>>> {
  const res = await hs(
    "GET",
    `/crm/v3/objects/deals/${dealId}?properties=${COPYABLE_DEAL_FIELDS.join(",")}`
  );
  const raw = res.properties ?? {};
  const out: Record<string, string> = {};
  for (const f of COPYABLE_DEAL_FIELDS) {
    if (raw[f] != null && raw[f] !== "") out[f] = String(raw[f]);
  }
  return out;
}

// Returns the first company ID associated with a deal, or null.
export async function getDealCompanyId(dealId: string): Promise<string | null> {
  const assoc = await hs(
    "GET",
    `/crm/v4/objects/deals/${dealId}/associations/companies`
  ).catch(() => ({ results: [] }));
  const first = (assoc.results ?? [])[0];
  return first ? String(first.toObjectId) : null;
}

// Associate a deal with a company (default association).
export async function associateDealWithCompany(
  dealId: string,
  companyId: string
): Promise<void> {
  await associate("deals", dealId, "companies", companyId);
}

export async function createLineItem(
  dealId: string,
  name: string,
  quantity: number,
  unitPrice: string | null,
  description: string | null,
  productId: string | null,
  recurringBillingFrequency?: string | null
) {
  const properties: Record<string, string> = {
    name,
    quantity: String(quantity),
  };
  if (unitPrice) properties.price = unitPrice;
  if (description) properties.description = description;
  if (productId) properties.hs_product_id = productId;
  if (recurringBillingFrequency) properties.recurringbillingfrequency = recurringBillingFrequency;
  const item = await hs("POST", "/crm/v3/objects/line_items", { properties });
  await associate("line_items", item.id, "deals", dealId);
  return item;
}

// Maps renewal circuit count to the correct MSI product catalog ID + standardized name.
// Tiers match the HubSpot product library naming convention: MSI (xk-yk).
const MSI_PRODUCT_TIERS: { max: number; id: string; name: string }[] = [
  { max: 2_500,     id: "1618654015", name: "MSI (1k-2.5k)"    },
  { max: 5_000,     id: "1618656776", name: "MSI (2.5k-5k)"    },
  { max: 10_000,    id: "1618656777", name: "MSI (5k-10k)"     },
  { max: 50_000,    id: "1618654016", name: "MSI (10k-50k)"    },
  { max: 100_000,   id: "2086570789", name: "MSI (50k-100k)"   },
  { max: 500_000,   id: "2086400308", name: "MSI (100k-500k)"  },
  { max: 800_000,   id: "2086400312", name: "MSI (500k-800k)"  },
  { max: 2_000_000, id: "2086570803", name: "MSI (800k-2M)"    },
  { max: 4_000_000, id: "2086400317", name: "MSI (2M-4M)"      },
];

function getMsiProductId(renewalCount: number): string | null {
  return MSI_PRODUCT_TIERS.find((t) => renewalCount <= t.max)?.id ?? null;
}

function getMsiProductName(renewalCount: number): string {
  return MSI_PRODUCT_TIERS.find((t) => renewalCount <= t.max)?.name ?? "MSI License";
}

// Clone all line items from sourceDealId to targetDealId.
// The first (primary) line item always uses the matching catalog product so
// HubSpot auto-populates the amount; add-on items are copied as-is.
export async function cloneLineItemsToDeal(
  sourceDealId: string,
  targetDealId: string,
  renewalCount: number
): Promise<void> {
  const items = await getDealLineItems(sourceDealId).catch(() => []);
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (i === 0) {
      // Primary MSI line item — use the catalog product (no custom price) so
      // HubSpot pulls the list price and amount auto-populates.
      // Use the standardized tier name (e.g. "MSI (10k-50k)") rather than the
      // catalog's default name or whatever the source deal had.
      const productId = getMsiProductId(renewalCount);
      const productName = getMsiProductName(renewalCount);
      await createLineItem(
        targetDealId,
        productName,
        renewalCount,
        null, // let catalog populate price/amount
        null,
        productId,
        item.properties?.recurringbillingfrequency ?? "annually"
      );
    } else {
      // Add-on line items — clone structure but use the same renewalCount so every
      // line item on the renewal deal reflects the correct circuit count (max of
      // order-form license and CSA rounded circuits).
      await createLineItem(
        targetDealId,
        item.properties?.name ?? "MSI Add-on",
        renewalCount,
        item.properties?.price ?? null,
        null,
        item.properties?.hs_product_id ?? null,
        item.properties?.recurringbillingfrequency ?? null
      );
    }
  }
}

// Extract the human-readable extension type from a deal name.
// e.g. "Eastex (MSI - Extension POM Prorated)"      → "POM"
//      "Eastex (MSI Extension - Fiber Clarity Prorated)" → "Fiber Clarity"
function extractExtensionName(dealName: string): string {
  const match = dealName.match(/Extension\s*[-–]?\s*([^)]+)/i);
  if (!match) return dealName;
  return match[1].replace(/\s*prorated\s*$/i, "").trim();
}

// Look up ALL active (non-terminated, non-closed-lost) extension deals for a company
// and return each deal's ID + display name + line items so the process route can
// copy them to the renewal deal. A company can have multiple extension deals (e.g. POM + FOM).
export async function getExtensionDealsForCompany(
  company: string
): Promise<{ id: string; extensionName: string; lineItems: any[] }[]> {
  const [deals, pipelineRes] = await Promise.all([
    searchDeals(
      [
        { propertyName: "dealname", operator: "CONTAINS_TOKEN", value: "MSI" },
        { propertyName: "dealname", operator: "CONTAINS_TOKEN", value: "Extension" },
      ],
      ["dealname", "service_terminated", "dealstage"],
      200
    ).catch(() => []),
    hs("GET", "/crm/v3/pipelines/deals").catch(() => ({ results: [] })),
  ]);

  const closedLostIds = new Set<string>();
  for (const p of (pipelineRes.results ?? [])) {
    for (const s of (p.stages ?? []) as any[]) {
      if (
        s.metadata?.isClosed === "true" &&
        (s.metadata?.probability === "0.0" || s.metadata?.probability === "0")
      ) {
        closedLostIds.add(String(s.id));
      }
    }
  }

  const needle = company.toLowerCase();
  const matched: { id: string; extensionName: string; lineItems: any[] }[] = [];

  for (const deal of deals) {
    if (deal.properties?.service_terminated) continue;
    if (deal.properties?.dealstage && closedLostIds.has(deal.properties.dealstage)) continue;
    const name: string = deal.properties?.dealname ?? "";
    if (!/extension/i.test(name)) continue;
    const idx = name.indexOf(" (MSI");
    if (idx <= 0) continue;
    if (name.slice(0, idx).trim().toLowerCase() !== needle) continue;
    const lineItems = await getDealLineItems(deal.id).catch(() => []);
    matched.push({ id: deal.id, extensionName: extractExtensionName(name), lineItems });
  }

  return matched;
}

/** @deprecated Use getExtensionDealsForCompany (returns all matches) */
export async function getExtensionDealForCompany(
  company: string
): Promise<{ id: string; lineItems: any[] } | null> {
  const all = await getExtensionDealsForCompany(company);
  return all[0] ?? null;
}

// For auto-renew deals: write an italic "MSI Year N - X,XXX" entry into the M1 note.
// • If the year already appears italic  → no-op.
// • If it appears non-italic            → wrap the existing line in <em>.
// • If it's absent                      → insert as <li> after the last bullet, or append <p>.
export async function appendAutoRenewalEntry(
  noteId: string,
  rawHtml: string,
  nextMsiYear: number,
  renewalCount: number
): Promise<void> {
  // Decode HTML entities so dash-matching regexes work regardless of how the note was typed.
  const html = rawHtml
    .replace(/&ndash;/gi, "–")
    .replace(/&mdash;/gi, "—")
    .replace(/&minus;/gi, "−")
    .replace(/&#8211;/gi, "–")
    .replace(/&#8212;/gi, "—")
    .replace(/&#x2013;/gi, "–")
    .replace(/&#x2014;/gi, "—")
    .replace(/&nbsp;/gi, " ");

  const formatted = new Intl.NumberFormat("en-US").format(renewalCount);

  // Helper: given the text after "Year N - ", rewrite it to show the billing
  // amount as the main figure. Paren-only entries like "(41,500)" become
  // "45,350 (41,500)"; entries whose main count already equals renewalCount
  // are returned unchanged; others are also left as-is.
  function rewriteSuffix(suffix: string): string {
    const s = suffix.trim();
    const parenOnlyM = s.match(/^\((\d[\d,]*)\)/);
    if (parenOnlyM) {
      // Paren-only "(41,500)" → "45,350 (41,500)"
      return `${formatted} (${parenOnlyM[1]})`;
    }
    return s; // keep existing "X,XXX" or "X,XXX (Y,YYY)" as-is
  }

  // Already italic — check whether it's paren-only and needs rewriting.
  const alreadyItalicRe = new RegExp(
    `(<(?:em|i)[^>]*>)([^<]*(?:MSI\\s+)?Year\\s+${nextMsiYear}\\s*[-–—−]([^<]*))(<\\/(?:em|i)>)`,
    "i"
  );
  const italicMatch = alreadyItalicRe.exec(html);
  if (italicMatch) {
    const suffix = italicMatch[3].trim();
    if (/^\([\d,]+\)/.test(suffix)) {
      // Paren-only italic entry — rewrite to include billing amount
      const newInner = `MSI Year ${nextMsiYear} - ${rewriteSuffix(suffix)}`;
      await updateNoteBody(noteId, html.replace(alreadyItalicRe,
        (_, open, _inner, _suffix, close) => `${open}${newInner}${close}`
      ));
    }
    return; // already italic (correct or just fixed above)
  }

  // Non-italic entry exists — italicize, rewriting paren-only content
  const existingEntry = new RegExp(
    `(>)([ \\t]*(?:MSI\\s+)?Year\\s+${nextMsiYear}\\s*[-–—−])([^<]*)(<)`,
    "gi"
  );
  if (existingEntry.test(html)) {
    const updated = html.replace(
      existingEntry,
      (_, open, prefix, rest, close) => {
        const newSuffix = rewriteSuffix(rest);
        return `${open}<em>${prefix.trim()} ${newSuffix}</em>${close}`;
      }
    );
    await updateNoteBody(noteId, updated);
    return;
  }

  // No entry for this year — insert into the FIRST <ul> block (the order-form
  // list), just before its closing </ul>.  Notes can have multiple lists
  // (e.g. "Order Form" + "Extensions") so we target only the first one.
  // Fall back to appending a plain <p> if no list is found.
  const newEntry = `<em>MSI Year ${nextMsiYear} - ${formatted}</em>`;
  const firstUlOpen = html.indexOf("<ul");
  if (firstUlOpen !== -1) {
    const firstUlClose = html.indexOf("</ul>", firstUlOpen);
    if (firstUlClose !== -1) {
      // Match the bullet style already used in the note (with inner <p>) so the
      // new entry renders consistently with the existing year entries.
      const newLi = `<li><p style="margin:0;">${newEntry}</p></li>`;
      await updateNoteBody(
        noteId,
        html.slice(0, firstUlClose) + newLi + html.slice(firstUlClose)
      );
      return;
    }
  }
  await updateNoteBody(noteId, html.trimEnd() + `\n<p>${newEntry}</p>`);
}

// Sum all line items on a deal and write the annual MRR (total / 12) to `amount`.
// Uses the catalog price when available; falls back to the stored price property.
export async function updateDealMrr(dealId: string): Promise<void> {
  const items = await getDealLineItems(dealId).catch(() => []);
  let totalAnnual = 0;
  for (const item of items) {
    const price = parseFloat(item.properties?.price ?? "0");
    const qty = parseInt(item.properties?.quantity ?? "1", 10);
    if (price > 0 && qty > 0) totalAnnual += price * qty;
  }
  if (totalAnnual > 0) {
    const mrr = (totalAnnual / 12).toFixed(2);
    await updateDealProperties(dealId, { amount: mrr });
  }
}

// Associate a note with a deal (e.g. link the M1 Order Form note to the renewal deal).
export async function associateNoteWithDeal(
  noteId: string,
  dealId: string
): Promise<void> {
  await associate("notes", noteId, "deals", dealId);
}
