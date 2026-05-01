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

export async function getDealNotes(dealId: string): Promise<any[]> {
  const assoc = await hs(
    "GET",
    `/crm/v4/objects/deals/${dealId}/associations/notes`
  ).catch(() => ({ results: [] }));
  const ids: string[] = (assoc.results ?? []).map((r: any) => String(r.toObjectId));
  if (!ids.length) return [];
  const batch = await hs("POST", "/crm/v3/objects/notes/batch/read", {
    inputs: ids.map((id) => ({ id })),
    properties: ["hs_note_body", "hs_timestamp"],
  }).catch(() => ({ results: [] }));
  return batch.results ?? [];
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
