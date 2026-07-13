// lib/hubspot/tasks.ts
// Creates an outreach task on a company, pre-filled with the score reasons.
// Owner: 32225666 (ldean@7sigma.com) per standing HubSpot conventions.

const BASE = "https://api.hubapi.com";
const OWNER_ID = "32225666";
const COMPANY_TO_TASK_ASSOCIATION_TYPE_ID = 192; // HubSpot-defined: task_to_company... see note below

export interface OutreachTaskInput {
  companyId: string;
  companyName: string;
  reasons: string[]; // score component labels, e.g. from aic_score_breakdown
  dueInDays?: number; // default 2 business-ish days
  historyLines?: string[]; // compact account history (deals, mentions, email recency)
  suggestion?: {
    emailSubject: string;
    emailBody: string;
    callPoints: string[];
  } | null; // AI outreach draft generated from the expanded panel
}

export function outreachTaskSubject(companyName: string): string {
  return `Outreach: ${companyName} (AIC target)`;
}

// Idempotency guard: an open task with this exact subject already covers the
// company — return its id so the button can't create duplicates across
// reloads or double clicks.
export async function findOpenOutreachTask(companyName: string): Promise<string | null> {
  const res = await fetch(`${BASE}/crm/v3/objects/tasks/search`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.HUBSPOT_ACCESS_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      filterGroups: [
        {
          filters: [
            { propertyName: "hs_task_subject", operator: "EQ", value: outreachTaskSubject(companyName) },
            { propertyName: "hs_task_status", operator: "NEQ", value: "COMPLETED" },
          ],
        },
      ],
      properties: ["hs_task_subject"],
      limit: 1,
    }),
  });
  if (!res.ok) return null; // guard is best-effort — fall through to create
  const data = await res.json();
  return data.results?.length ? String(data.results[0].id) : null;
}

export async function createOutreachTask(input: OutreachTaskInput): Promise<string> {
  const due = new Date(Date.now() + (input.dueInDays ?? 2) * 86_400_000);
  due.setUTCHours(17, 0, 0, 0); // noon Central-ish

  const sections: string[] = [
    `Surfaced by Account Intelligence Center scoring.`,
    ``,
    `Why now:`,
    ...input.reasons.map((r) => `- ${r}`),
  ];
  if (input.historyLines?.length) {
    sections.push(``, `Account history:`, ...input.historyLines.map((l) => `- ${l}`));
  }
  if (input.suggestion) {
    sections.push(
      ``,
      `Suggested email (AI draft — review before sending):`,
      `Subject: ${input.suggestion.emailSubject}`,
      input.suggestion.emailBody
    );
    if (input.suggestion.callPoints?.length) {
      sections.push(``, `Call points:`, ...input.suggestion.callPoints.map((p) => `- ${p}`));
    }
  }
  sections.push(``, `Created by Account Intelligence Center.`);

  const body = {
    properties: {
      hs_task_subject: outreachTaskSubject(input.companyName),
      hs_task_body: sections.join("\n"),
      hs_task_status: "NOT_STARTED",
      hs_task_priority: "HIGH",
      hs_task_type: "TODO",
      hs_timestamp: due.toISOString(),
      hubspot_owner_id: OWNER_ID,
    },
    associations: [
      {
        to: { id: input.companyId },
        types: [
          {
            associationCategory: "HUBSPOT_DEFINED",
            // 192 = task-to-company. If association fails with a type error,
            // GET /crm/v4/associations/tasks/companies/labels to confirm the ID
            // for your portal and update the constant above.
            associationTypeId: COMPANY_TO_TASK_ASSOCIATION_TYPE_ID,
          },
        ],
      },
    ],
  };

  const res = await fetch(`${BASE}/crm/v3/objects/tasks`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.HUBSPOT_ACCESS_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`Task create failed ${res.status}: ${await res.text()}`);
  }
  return (await res.json()).id;
}
