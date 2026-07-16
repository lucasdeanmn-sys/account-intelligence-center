// app/api/targets/[id]/suggest/route.ts
// POST /api/targets/:id/suggest -> AI-drafted outreach (email + call points)
// grounded in the account's actual history: deals, notes, call mentions, and
// the score reasons. Uses the same Claude setup as the account-briefing page.

import { NextResponse } from "next/server";
import { getTargetContext } from "@/lib/targets/context";
import { callClaude, extractJSON } from "@/lib/anthropic";

export const maxDuration = 60;
export const dynamic = "force-dynamic";

export interface OutreachSuggestion {
  emailSubject: string;
  emailBody: string;
  callPoints: string[];
}

const SYSTEM = `You draft first-touch sales outreach for a rep at 7SIGMA, which provides managed network monitoring and NOC services (MSI, NOC360) to broadband providers — rural ILECs, cooperatives, munis, fiber overbuilders, WISPs.

Rules:
- Ground every claim ONLY in the provided account context. Never invent names, numbers, meetings, or history.
- Reference the most specific hook available (a recent call mention, a closed-lost deal worth revisiting, news trigger) — that is the reason for reaching out NOW.
- knownPeople lists real people from the CRM, calls, and email. Address the most senior/relevant one by their actual first name instead of {{firstName}} when a clear best recipient exists; name who to ask for in the call points.
- Email: under 130 words, plain text, no bullet lists, no placeholder tokens except the {{firstName}} greeting. Confident but not salesy; one clear ask (a short call).
- Call points: 3-5 short bullets a rep can glance at while dialing — the hook, the fit angle, likely objection + response, the ask.

Respond with JSON only:
{"emailSubject": string, "emailBody": string, "callPoints": string[]}`;

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  try {
    const context = await getTargetContext(id);
    const text = await callClaude(
      SYSTEM,
      JSON.stringify(
        {
          company: context.company,
          scoreReasons: context.reasons,
          dealHistory: context.deals.slice(0, 8),
          recentNotes: context.notes,
          recentCallMentions: context.fathomMentions,
          knownPeople: context.people.slice(0, 8),
          lastInboundEmailDays: context.lastInboundEmailDays,
        },
        null,
        2
      ),
      2000
    );
    const suggestion = extractJSON<OutreachSuggestion>(text);
    if (!suggestion.emailSubject || !suggestion.emailBody) {
      throw new Error("Draft came back incomplete — try again");
    }
    return NextResponse.json({ suggestion });
  } catch (err: any) {
    console.error("Outreach suggest error:", err);
    return NextResponse.json(
      { error: err.message || "Failed to draft outreach" },
      { status: 500 }
    );
  }
}
