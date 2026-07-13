// app/api/targets/[id]/task/route.ts
// POST /api/targets/:id/task  -> creates a HubSpot outreach task on the company,
// pre-filled with the score breakdown, a compact account-history summary, and
// (when the client generated one) the AI outreach draft.
//
// Idempotent: if an open "Outreach: <company> (AIC target)" task already
// exists, its id is returned with existing: true instead of creating a dupe.

import { NextResponse } from "next/server";
import {
  createOutreachTask,
  findOpenOutreachTask,
} from "@/lib/hubspot/tasks";
import { getTargetContext, buildHistoryLines } from "@/lib/targets/context";

export const maxDuration = 30;

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  // Optional body: the AI draft from the expanded panel rides along into the task.
  let suggestion: { emailSubject: string; emailBody: string; callPoints: string[] } | null = null;
  try {
    const body = await request.json();
    if (body?.suggestion?.emailSubject && body?.suggestion?.emailBody) {
      suggestion = {
        emailSubject: String(body.suggestion.emailSubject),
        emailBody: String(body.suggestion.emailBody),
        callPoints: Array.isArray(body.suggestion.callPoints)
          ? body.suggestion.callPoints.map(String)
          : [],
      };
    }
  } catch {
    // no body — fine
  }

  try {
    // Deals + notes only — skip the slower Fathom/Gmail calls so the button
    // stays snappy; call mentions are already reflected in the score reasons.
    const context = await getTargetContext(id, { includeSignals: false });
    const name = context.company.name;

    const existingId = await findOpenOutreachTask(name);
    if (existingId) {
      return NextResponse.json({ ok: true, taskId: existingId, existing: true });
    }

    const taskId = await createOutreachTask({
      companyId: id,
      companyName: name,
      reasons: context.reasons.length
        ? context.reasons
        : ["Score breakdown unavailable — see company record."],
      historyLines: buildHistoryLines(context),
      suggestion,
    });
    return NextResponse.json({ ok: true, taskId, existing: false });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
