const BASE = "https://api.hubapi.com";

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

// Returns the set of company names (lowercase) that currently have an active
// MSI extension deal — used to annotate renewal entries with hasExtension.
export async function getActiveExtensionCompanies(): Promise<Set<string>> {
  const deals = await searchDeals(
    [
      { propertyName: "dealname", operator: "CONTAINS_TOKEN", value: "MSI" },
      { propertyName: "dealname", operator: "CONTAINS_TOKEN", value: "Extension" },
    ],
    ["dealname", "service_terminated"],
    200
  ).catch(() => []);

  const companies = new Set<string>();
  for (const deal of deals) {
    // Skip if the extension term has already been terminated
    if (deal.properties?.service_terminated) continue;
    const name: string = deal.properties?.dealname ?? "";
    const idx = name.indexOf(" (MSI");
    if (idx > 0) companies.add(name.slice(0, idx).trim().toLowerCase());
  }
  return companies;
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

export async function getDealLineItems(dealId: string): Promise<any[]> {
  const assoc = await hs("GET", `/crm/v4/objects/deals/${dealId}/associations/line_items`).catch(() => ({ results: [] }));
  const ids: string[] = (assoc.results ?? []).map((r: any) => String(r.toObjectId));
  if (!ids.length) return [];
  const batch = await hs("POST", "/crm/v3/objects/line_items/batch/read", {
    inputs: ids.map((id) => ({ id })),
    properties: ["name", "quantity", "price", "amount", "hs_product_id"],
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
export async function getClosedWonStage(pipelineNameSubstring: string): Promise<{ pipelineId: string; stageId: string } | null> {
  const res = await hs("GET", "/crm/v3/pipelines/deals");
  const pipelines: any[] = res.results ?? [];

  const isTargetStage = (label: string) => {
    const l = label.toLowerCase();
    return l.includes("ready for billing") || l.includes("billing");
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

export async function createMsiRenewalDeal(
  name: string,
  subscriptionStartDate: string,
  ownerId: string,
  pipelineId?: string,
  stageId?: string
) {
  const properties: Record<string, string> = {
    dealname: name,
    hubspot_owner_id: ownerId,
    subscription_start_date: new Date(subscriptionStartDate + "T00:00:00.000Z").getTime().toString(),
  };
  if (pipelineId) properties.pipeline = pipelineId;
  if (stageId) properties.dealstage = stageId;
  return hs("POST", "/crm/v3/objects/deals", { properties });
}

export async function createLineItem(
  dealId: string,
  name: string,
  quantity: number,
  unitPrice: string | null,
  description: string | null,
  productId: string | null
) {
  const properties: Record<string, string> = {
    name,
    quantity: String(quantity),
  };
  if (unitPrice) properties.price = unitPrice;
  if (description) properties.description = description;
  if (productId) properties.hs_product_id = productId;
  const item = await hs("POST", "/crm/v3/objects/line_items", { properties });
  await associate("line_items", item.id, "deals", dealId);
  return item;
}

// Clone all line items from sourceDealId to targetDealId.
// The first (primary) line item's quantity is replaced with renewalCount;
// any additional line items (add-ons) are copied as-is.
export async function cloneLineItemsToDeal(
  sourceDealId: string,
  targetDealId: string,
  renewalCount: number
): Promise<void> {
  const items = await getDealLineItems(sourceDealId).catch(() => []);
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const qty = i === 0 ? renewalCount : parseInt(item.properties?.quantity ?? "1", 10);
    await createLineItem(
      targetDealId,
      item.properties?.name ?? "MSI License",
      qty,
      item.properties?.price ?? null,
      null,
      item.properties?.hs_product_id ?? null
    );
  }
}

// Look up the active (non-terminated) extension deal for a company and return
// its ID + line items so the process route can copy them to the renewal deal.
export async function getExtensionDealForCompany(
  company: string
): Promise<{ id: string; lineItems: any[] } | null> {
  const deals = await searchDeals(
    [
      { propertyName: "dealname", operator: "CONTAINS_TOKEN", value: "MSI" },
      { propertyName: "dealname", operator: "CONTAINS_TOKEN", value: "Extension" },
    ],
    ["dealname", "service_terminated"],
    200
  ).catch(() => []);

  const needle = company.toLowerCase();
  for (const deal of deals) {
    if (deal.properties?.service_terminated) continue;
    const name: string = deal.properties?.dealname ?? "";
    if (!/extension/i.test(name)) continue;
    const idx = name.indexOf(" (MSI");
    if (idx <= 0) continue;
    if (name.slice(0, idx).trim().toLowerCase() !== needle) continue;
    const lineItems = await getDealLineItems(deal.id).catch(() => []);
    return { id: deal.id, lineItems };
  }
  return null;
}

// For auto-renew deals: write an italic "MSI Year N - X,XXX" entry into the M1 note.
// • If the year already appears italic  → no-op.
// • If it appears non-italic            → wrap the existing line in <em>.
// • If it's absent                      → append a new italic <p> at the end.
export async function appendAutoRenewalEntry(
  noteId: string,
  html: string,
  nextMsiYear: number,
  renewalCount: number
): Promise<void> {
  const formatted = new Intl.NumberFormat("en-US").format(renewalCount);

  // Already italic — nothing to do
  const alreadyItalic = new RegExp(
    `<(?:em|i)[^>]*>[^<]*(?:MSI\\s+)?Year\\s+${nextMsiYear}\\b`,
    "i"
  );
  if (alreadyItalic.test(html)) return;

  // Non-italic entry exists — italicize in place
  const existingEntry = new RegExp(
    `(>)([ \\t]*(?:MSI\\s+)?Year\\s+${nextMsiYear}\\s*[-–—][^<]*)(<)`,
    "gi"
  );
  if (existingEntry.test(html)) {
    const updated = html.replace(
      existingEntry,
      (_, open, content, close) => `${open}<em>${content.trim()}</em>${close}`
    );
    await updateNoteBody(noteId, updated);
    return;
  }

  // No entry for this year — append a new italic line
  const newLine = `<p><em>MSI Year ${nextMsiYear} - ${formatted}</em></p>`;
  await updateNoteBody(noteId, html.trimEnd() + "\n" + newLine);
}
