// app/api/targets/[id]/task/route.ts
// POST /api/targets/:id/task  -> creates a HubSpot outreach task on the company,
// pre-filled with the current score breakdown as the "why now" reasons.
// Wire the list page's button to this endpoint.

import { NextResponse } from "next/server";
import { createOutreachTask } from "@/lib/hubspot/tasks";
import { HUBSPOT_PROPS as P } from "@/lib/scoring/config";

const BASE = "https://api.hubapi.com";

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  // Pull current name + breakdown so the task explains itself.
  const res = await fetch(
    `${BASE}/crm/v3/objects/companies/${id}?properties=${P.NAME},${P.BREAKDOWN}`,
    {
      headers: { Authorization: `Bearer ${process.env.HUBSPOT_ACCESS_TOKEN}` },
      cache: "no-store",
    }
  );
  if (!res.ok) {
    return NextResponse.json({ error: await res.text() }, { status: res.status });
  }
  const company = await res.json();
  const name = company.properties?.[P.NAME] ?? "(unnamed)";

  let reasons: string[] = [];
  try {
    const breakdown = JSON.parse(company.properties?.[P.BREAKDOWN] ?? "{}");
    reasons = [...(breakdown.trigger ?? []), ...(breakdown.fit ?? [])].map(
      (c: { label: string; points: number; detail?: string }) =>
        `${c.label} (+${c.points})${c.detail ? ` — ${c.detail}` : ""}`
    );
  } catch {
    reasons = ["Score breakdown unavailable — see company record."];
  }

  try {
    const taskId = await createOutreachTask({ companyId: id, companyName: name, reasons });
    return NextResponse.json({ ok: true, taskId });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
