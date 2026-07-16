import { NextRequest, NextResponse } from "next/server";
import { callClaude, extractJSON } from "@/lib/anthropic";
import {
  searchDeals,
  getDealContacts,
  getDealNotes,
  getDealTasks,
  getDealEmailsBatch,
  getDealMeetingsBatch,
} from "@/lib/hubspot";
import { getCalendarEventsForDomains } from "@/lib/google";
import type { AccountBriefing } from "@/lib/types";

export const maxDuration = 120;

const SYSTEM = `You are an AI sales intelligence assistant for a B2B SaaS account executive.
HubSpot CRM data (deals, contacts, notes, tasks, logged emails, and meetings) plus the rep's Google Calendar events involving this account have already been fetched and are provided in the user message. That is your ONLY data source — base "recentEmailSummary" strictly on the logged emails and "upcomingMeetings" on the HubSpot meetings and Google Calendar events provided; never invent email or meeting context.
Logged emails may include threads the rep was not copied on — treat those as account activity too. The same meeting may appear in both HubSpot and Google Calendar — mention it once. Meetings/events starting on or after today are upcoming; call them out with their date/time and attendees.

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

    // Enrich the top matching deal(s) with contacts, notes, tasks, logged
    // emails, and meetings in parallel. Emails/meetings use the batched
    // helpers, which also pick up engagements associated only at the
    // company level (e.g. threads the rep was dropped from).
    const topDeals = rawDeals.slice(0, 3);
    const dealIds = topDeals.map((d: any) => String(d.id));
    const byTimestampDesc = (key: string) => (a: any, b: any) =>
      new Date(b.properties?.[key] ?? 0).getTime() -
      new Date(a.properties?.[key] ?? 0).getTime();

    const [emailsByDeal, meetingsByDeal, enriched] = await Promise.all([
      getDealEmailsBatch(dealIds).catch(() => new Map<string, any[]>()),
      getDealMeetingsBatch(dealIds).catch(() => new Map<string, any[]>()),
      Promise.all(
      topDeals.map(async (deal: any) => {
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
      ),
    ]);

    // Attach logged emails and meetings to each enriched deal. Email bodies
    // can be whole threads — truncate so 3 deals × 10 emails stays well
    // inside the prompt budget.
    for (const deal of enriched as any[]) {
      deal.loggedEmails = (emailsByDeal.get(String(deal.id)) ?? [])
        .sort(byTimestampDesc("hs_timestamp"))
        .slice(0, 10)
        .map((e: any) => ({
          subject: e.properties?.hs_email_subject,
          direction: e.properties?.hs_email_direction,
          timestamp: e.properties?.hs_timestamp,
          body: (e.properties?.hs_email_text ?? "").slice(0, 1200),
        }));
      deal.meetings = (meetingsByDeal.get(String(deal.id)) ?? [])
        .sort(byTimestampDesc("hs_meeting_start_time"))
        .slice(0, 10)
        .map((m: any) => ({
          title: m.properties?.hs_meeting_title,
          startTime: m.properties?.hs_meeting_start_time,
          endTime: m.properties?.hs_meeting_end_time,
          outcome: m.properties?.hs_meeting_outcome,
          body: (m.properties?.hs_meeting_body ?? "").slice(0, 500),
        }));
    }

    // Google Calendar events involving the account's domains — catches
    // meetings that were never logged or synced into HubSpot. Domains come
    // from the HubSpot contacts' emails (freemail excluded so a personal
    // gmail contact doesn't match the rep's whole calendar).
    const FREEMAIL = new Set(["gmail.com", "yahoo.com", "outlook.com", "hotmail.com", "aol.com"]);
    const accountDomains = Array.from(
      new Set(
        (enriched as any[])
          .flatMap((d) => d.contacts ?? [])
          .map((c: any) => String(c.email ?? "").split("@")[1]?.toLowerCase())
          .filter((dom: string | undefined): dom is string => !!dom && !FREEMAIL.has(dom))
      )
    );
    const calendarEvents = await getCalendarEventsForDomains(accountDomains).catch(
      (e) => {
        console.error("Google Calendar fetch failed:", e?.message ?? e);
        return [];
      }
    );

    const today = new Date().toISOString().split("T")[0];

    const result = await callClaude(
      SYSTEM,
      `Today is ${today}. Generate a full account briefing for: "${company}"

## HubSpot Data (pre-fetched)
${JSON.stringify(enriched, null, 2)}

## Google Calendar events involving this account (past 30 / next 60 days)
${JSON.stringify(calendarEvents, null, 2)}

Use the deal, contact, notes, task, logged email (loggedEmails), meeting (meetings), and calendar event data above to generate the JSON briefing. Note any overdue tasks and any meetings on or after today. Return the JSON.`,
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
