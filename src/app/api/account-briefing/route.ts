import { NextRequest, NextResponse } from "next/server";
import { runAgentLoop, hubspotServer, gmailServer, calendarServer, configured, extractJSON } from "@/lib/anthropic";
import type { AccountBriefing } from "@/lib/types";

export const maxDuration = 120;

const SYSTEM = `You are an AI sales intelligence assistant for a B2B SaaS account executive.
You have access to HubSpot CRM, Gmail, and Google Calendar via MCP tools.

Generate a comprehensive account briefing by pulling data from all available sources.

For MSI deals (deal name contains "(MSI"), include a note that outreach should go through the Adtran territory manager.

Return ONLY valid JSON in this format:
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
      { error: "HubSpot is not configured. Add HUBSPOT_ACCESS_TOKEN to your environment variables." },
      { status: 503 }
    );
  }

  try {
    const { company } = await req.json();
    if (!company) {
      return NextResponse.json({ error: "company is required" }, { status: 400 });
    }

    const servers = configured(hubspotServer(), gmailServer(), calendarServer());
    const today = new Date().toISOString().split("T")[0];

    const result = await runAgentLoop(
      SYSTEM,
      `Today is ${today}. Generate a full account briefing for: "${company}"

Steps:
1. Search HubSpot for deals and companies matching "${company}". Get the deal details, associated contacts, recent notes, and open tasks.
2. Search Gmail for recent email threads with contacts at this company (search by company domain or contact email addresses). Look back 90 days.
3. Check Google Calendar for recent and upcoming meetings with this account.
4. Note any overdue tasks or unanswered emails.

Synthesize everything into the JSON briefing format. Be specific and actionable.`,
      servers,
      8096
    );

    let briefing: AccountBriefing;
    try {
      briefing = extractJSON<AccountBriefing>(result);
      // Enforce MSI logic
      if (briefing.isMSI) {
        briefing.recommendedNextStep = briefing.recommendedNextStep.includes("Adtran")
          ? briefing.recommendedNextStep
          : `Contact Adtran territory manager first. Then: ${briefing.recommendedNextStep}`;
      }
    } catch {
      return NextResponse.json({ briefing: null, rawResponse: result }, { status: 200 });
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
