import { NextResponse } from "next/server";
import { callClaude, extractJSON } from "@/lib/anthropic";
import { searchDeals, getDealTasks } from "@/lib/hubspot";
import type { PriorityDeal } from "@/lib/types";

export const maxDuration = 120;
export const dynamic = "force-dynamic";

const SYSTEM = `You are an AI sales assistant for a B2B SaaS account executive.
HubSpot CRM deal data has already been fetched and is provided in the user message as JSON.
You may have access to Gmail and Google Calendar via MCP tools — use them to cross-reference last contact dates and upcoming meetings.

Priority factors (weighted):
1. Renewal urgency / close date proximity (highest weight)
2. Overdue tasks (tasks with status NOT_STARTED and past due date)
3. Days since last activity (longer = higher priority)
4. Stage stagnation (deal stuck in same stage for 30+ days based on hs_createdate vs closedate)
5. Recent email/calendar activity (use Gmail and Calendar tools if available)

MSI deals (name contains "(MSI"): suggested action should ALWAYS be "Follow up with Adtran territory manager".

Return ONLY valid JSON:
\`\`\`json
[
  {
    "id": "deal_id",
    "name": "Deal Name",
    "company": "Company Name",
    "stage": "Stage Name",
    "amount": 50000,
    "closeDate": "2025-06-30",
    "isMSI": false,
    "priorityScore": 9,
    "priorityReason": "Close date in 14 days, no activity in 12 days, 2 overdue tasks",
    "suggestedAction": "Call John to confirm next steps on proposal",
    "lastActivity": "2025-04-18",
    "daysSinceActivity": 12,
    "overdueTaskCount": 2,
    "stageAge": 21
  }
]
\`\`\`

Return 10-15 deals ranked by priority score (10 = highest, 1 = lowest).`;

const DEAL_PROPS = [
  "dealname",
  "dealstage",
  "amount",
  "closedate",
  "hubspot_owner_id",
  "notes_last_activity_date",
  "notes_last_contacted",
  "hs_lastmodifieddate",
  "hs_createdate",
];

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
    // Fetch open deals owned by this AE directly from HubSpot REST API
    const rawDeals = await searchDeals(
      [
        {
          propertyName: "hubspot_owner_id",
          operator: "EQ",
          value: "32225666",
        },
        { propertyName: "hs_is_closed", operator: "EQ", value: "false" },
      ],
      DEAL_PROPS,
      50,
      [{ propertyName: "notes_last_activity_date", direction: "DESCENDING" }]
    );

    // For the top 20 deals, fetch associated tasks in parallel
    const top20 = rawDeals.slice(0, 20);
    const tasksPerDeal = await Promise.all(
      top20.map((d: any) =>
        getDealTasks(d.id).catch(() => [] as any[])
      )
    );

    const now = Date.now();
    const dealsWithTasks = top20.map((deal: any, i: number) => {
      const tasks: any[] = tasksPerDeal[i] ?? [];
      const overdueTasks = tasks.filter((t: any) => {
        const status = t.properties?.hs_task_status;
        const due = t.properties?.hs_timestamp;
        return (
          status === "NOT_STARTED" && due && new Date(due).getTime() < now
        );
      });
      return {
        id: deal.id,
        ...deal.properties,
        overdueTaskCount: overdueTasks.length,
        tasks: tasks.map((t: any) => ({
          subject: t.properties?.hs_task_subject,
          status: t.properties?.hs_task_status,
          priority: t.properties?.hs_task_priority,
          dueDate: t.properties?.hs_timestamp,
        })),
      };
    });

    const today = new Date().toISOString().split("T")[0];

    const result = await callClaude(
      SYSTEM,
      `Today is ${today}.

## HubSpot Open Deals (pre-fetched)
${JSON.stringify(dealsWithTasks, null, 2)}

Analyze the deal data above and return the JSON priority array for the top 10-15 deals.`,
      8096
    );

    let deals: PriorityDeal[] = [];
    try {
      deals = extractJSON<PriorityDeal[]>(result);
      deals = deals.map((d) => ({
        ...d,
        isMSI: d.name?.includes("(MSI") || false,
        suggestedAction: d.name?.includes("(MSI")
          ? "Follow up with Adtran territory manager"
          : d.suggestedAction,
      }));
    } catch {
      return NextResponse.json(
        { deals: [], rawResponse: result },
        { status: 200 }
      );
    }

    return NextResponse.json({ deals });
  } catch (error: any) {
    console.error("Priorities API error:", error);
    return NextResponse.json(
      { error: error.message || "Internal server error" },
      { status: 500 }
    );
  }
}
