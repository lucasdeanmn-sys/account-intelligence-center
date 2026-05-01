import { NextResponse } from "next/server";
import { runAgentLoop, hubspotServer, gmailServer, calendarServer, configured, extractJSON } from "@/lib/anthropic";
import type { PriorityDeal } from "@/lib/types";

export const maxDuration = 120;
export const dynamic = "force-dynamic";

const SYSTEM = `You are an AI sales assistant for a B2B SaaS account executive.
You have access to HubSpot CRM, Gmail, and Google Calendar via MCP tools.

Your job is to pull recently active deals and rank them by priority for today.

Priority factors (weighted):
1. Renewal urgency / close date proximity (highest weight)
2. Overdue tasks
3. Days since last activity (longer = higher priority)
4. Stage stagnation (deal stuck in same stage for 30+ days)
5. Recent email/calendar activity cross-reference (use Gmail and Calendar to find true last contact date)

MSI deals (name contains "(MSI"): These are Adtran channel deals.
For MSI deals, the suggested action should ALWAYS be "Follow up with Adtran territory manager" rather than direct prospect outreach.

Return ONLY valid JSON in this format:
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

Pull at least 10-15 of the most recently active or close-date-relevant deals. Rank by priority score (10 = highest priority, 1 = lowest).`;

export async function GET() {
  if (!process.env.HUBSPOT_ACCESS_TOKEN) {
    return NextResponse.json(
      { error: "HubSpot is not configured. Add HUBSPOT_ACCESS_TOKEN to your environment variables." },
      { status: 503 }
    );
  }

  try {
    const servers = configured(hubspotServer(), gmailServer(), calendarServer());

    const today = new Date().toISOString().split("T")[0];

    const result = await runAgentLoop(
      SYSTEM,
      `Today is ${today}.

Please:
1. Search HubSpot for open deals owned by owner 32225666, focusing on those with recent activity, upcoming close dates, or overdue tasks.
2. For each deal, check Gmail for recent email threads with the deal's company domain to get the true last contact date.
3. Check Google Calendar for any upcoming or recent meetings with these accounts.
4. Rank all deals by priority and return the JSON array.

Focus on deals in active stages (not closed won/lost). Look back 90 days for activity.`,
      servers,
      8096
    );

    let deals: PriorityDeal[] = [];
    try {
      deals = extractJSON<PriorityDeal[]>(result);
      // Ensure MSI flag is set correctly
      deals = deals.map((d) => ({
        ...d,
        isMSI: d.name?.includes("(MSI") || false,
        suggestedAction: d.name?.includes("(MSI")
          ? "Follow up with Adtran territory manager"
          : d.suggestedAction,
      }));
    } catch {
      // If JSON extraction fails, return empty with the raw text as error
      return NextResponse.json({ deals: [], rawResponse: result }, { status: 200 });
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
