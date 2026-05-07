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

  const allNotes: any[] = [];
  for (const companyId of companyIds) {
    const noteAssoc = await hs(
      "GET",
      `/crm/v4/objects/companies/${companyId}/associations/notes`
    ).catch(() => ({ results: [] }));
    const noteIds: string[] = (noteAssoc.results ?? [])
      .map((r: any) => String(r.toObjectId ?? ""))
      .filter(Boolean);
    const notes = await fetchNotesByIds(noteIds);
    allNotes.push(...notes);
  }
  return allNotes;
}

export async function getDealNotes(dealId: string): Promise<any[]> {
  // Try CRM v4 associations (toObjectId)
  let assoc = await hs(
    "GET",
    `/crm/v4/objects/deals/${dealId}/associations/notes`
  ).catch(() => ({ results: [] }));
  let ids: string[] = (assoc.results ?? [])
    .map((r: any) => String(r.toObjectId))
    .filter((id: string) => id && id !== "undefined");

  // Fall back to CRM v3 associations (id)
  if (!ids.length) {
    assoc = await hs(
      "GET",
      `/crm/v3/objects/deals/${dealId}/associations/notes`
    ).catch(() => ({ results: [] }));
    ids = (assoc.results ?? [])
      .map((r: any) => String(r.id))
      .filter((id: string) => Boolean(id));
  }

  if (ids.length) {
    const notes = await fetchNotesByIds(ids);
    if (notes.length) return notes;
  }

  // Try legacy engagements API
  const eng = await hs(
    "GET",
    `/engagements/v1/engagements/associated/DEAL/${dealId}/paged?limit=100`
  ).catch(() => ({ results: [] }));
  const engNotes = (eng.results ?? [])
    .filter((e: any) => e.engagement?.type === "NOTE")
    .map((e: any) => ({
      id: String(e.engagement?.id ?? ""),
      properties: {
        hs_note_body: e.metadata?.body ?? e.metadata?.bodyHtml ?? "",
        hs_timestamp: new Date(
          e.engagement?.timestamp ?? e.engagement?.createdAt ?? 0
        ).toISOString(),
      },
    }));
  if (engNotes.length) return engNotes;

  // Final fallback: notes on the associated company record
  return getCompanyNotesForDeal(dealId);
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

// Returns { pipelineId, stageId } for the Closed Won stage in the named pipeline
export async function getClosedWonStage(pipelineNameSubstring: string): Promise<{ pipelineId: string; stageId: string } | null> {
  const res = await hs("GET", "/crm/v3/pipelines/deals");
  const pipelines: any[] = res.results ?? [];
  const pipeline = pipelines.find((p: any) =>
    p.label?.toLowerCase().includes(pipelineNameSubstring.toLowerCase())
  );
  if (!pipeline) return null;
  const stages: any[] = pipeline.stages ?? [];
  // Prefer "Ready for Billing" stage; fall back to any closed-won stage
  const closedWon =
    stages.find((s: any) =>
      s.label?.toLowerCase().includes("billing") ||
      s.label?.toLowerCase().includes("ready for billing")
    ) ??
    stages.find((s: any) =>
      s.metadata?.isClosed === "true" && s.metadata?.probability === "1.0"
    );
  return closedWon ? { pipelineId: pipeline.id, stageId: closedWon.id } : null;
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
