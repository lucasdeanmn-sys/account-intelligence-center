import { NextRequest, NextResponse } from "next/server";
import { callClaude, extractJSON } from "@/lib/anthropic";
import {
  searchDeals,
  getDealContacts,
  getDealNotes,
  getDealTasks,
} from "@/lib/hubspot";
import type { AccountBriefing } from "@/lib/types";

export const maxDuration = 120;

const SYSTEM = `You are an AI sales intelligence assistant for a B2B SaaS account executive.
HubSpot CRM data (deals, contacts, notes, tasks) has already been fetched and is provided in the user message.
You may have access to Gmail and Google Calendar via MCP tools — use them to enrich the briefing with recent email and meeting context.

For MSI deals (deal name contains "(MSI"), note that outreach should go through the Adtran territory manager.

Return ONLY valid JSON:
\`\`\`json
{
  "dealName": "Full deal name from HubSpot",
  "company": "Company name",
  "dealStage": "Current stage",
  "dealAmount": 50000,
  "closeDate": "2025-06-30",
  "isMSI": false,
  "currentStatus": "Brief one-line status summary",
  "lastTouchpoint": "Description of last contact + date",
  "openItems": [
    "Overdue task: Send proposal",
    "Unanswered email from April 20"
  ],
  "suggestedTalkingPoints": [
    "Reference their recent product launch",
    "Ask about Q3 expansion plans"
  ],
  "recommendedNextStep": "Specific, actionable next step with timing",
  "contacts": [
    { "name": "John Smith", "title": "VP of IT", "email": "john@company.com" }
  ],
  "recentEmailSummary": "Summary of recent email thread topics and sentiment",
  "upcomingMeetings": "Any scheduled meetings or call summaries",
  "companyNews": "Any relevant company news or intelligence found"
}
\`\`\``;

export async function POST(req: NextRequest) {
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
    const { company } = await req.json();
    if (!company) {
      return NextResponse.json(
        { error: "company is required" },
        { status: 400 }
      );
    }

    // Fetch deals matching the company name
    const rawDeals = await searchDeals(
      [{ propertyName: "dealname", operator: "CONTAINS_TOKEN", value: company }],
      [
        "dealname",
        "dealstage",
        "amount",
        "closedate",
        "notes_last_activity_date",
        "notes_last_contacted",
        "hs_lastmodifieddate",
      ],
      10
    );

    // Enrich the top matching deal(s) with contacts, notes, tasks in parallel
    const enriched = await Promise.all(
      rawDeals.slice(0, 3).map(async (deal: any) => {
        const [contacts, notes, tasks] = await Promise.all([
          getDealContacts(deal.id).catch(() => []),
          getDealNotes(deal.id).catch(() => []),
          getDealTasks(deal.id).catch(() => []),
        ]);
        return {
          id: deal.id,
          ...deal.properties,
          contacts: contacts.map((c: any) => c.properties),
          notes: notes
            .sort(
              (a: any, b: any) =>
                new Date(b.properties?.hs_timestamp ?? 0).getTime() -
                new Date(a.properties?.hs_timestamp ?? 0).getTime()
            )
            .slice(0, 10)
            .map((n: any) => ({
              body: n.properties?.hs_note_body,
              timestamp: n.properties?.hs_timestamp,
            })),
          tasks: tasks.map((t: any) => ({
            subject: t.properties?.hs_task_subject,
            status: t.properties?.hs_task_status,
            priority: t.properties?.hs_task_priority,
            dueDate: t.properties?.hs_timestamp,
            body: t.properties?.hs_task_body,
          })),
        };
      })
    );

    const today = new Date().toISOString().split("T")[0];

    const result = await callClaude(
      SYSTEM,
      `Today is ${today}. Generate a full account briefing for: "${company}"

## HubSpot Data (pre-fetched)
${JSON.stringify(enriched, null, 2)}

Use the deal, contact, notes, and task data above to generate the JSON briefing. Note any overdue tasks. Return the JSON.`,
      8096
    );

    let briefing: AccountBriefing;
    try {
      briefing = extractJSON<AccountBriefing>(result);
      if (briefing.isMSI && !briefing.recommendedNextStep.includes("Adtran")) {
        briefing.recommendedNextStep = `Contact Adtran territory manager first. Then: ${briefing.recommendedNextStep}`;
      }
      // Attach the real HubSpot deal ID server-side — the LLM only echoes
      // names, and PushToHubSpot needs the object ID for associations.
      // Match on the deal name Claude chose; fall back to the top result.
      const matched = enriched.find(
        (d: any) => d.dealname === briefing.dealName
      );
      briefing.dealId = matched?.id ?? enriched[0]?.id;
    } catch {
      return NextResponse.json(
        { briefing: null, rawResponse: result },
        { status: 200 }
      );
    }

    return NextResponse.json({ briefing });
  } catch (error: any) {
    console.error("Account briefing API error:", error);
    return NextResponse.json(
      { error: error.message || "Internal server error" },
      { status: 500 }
    );
  }
}
