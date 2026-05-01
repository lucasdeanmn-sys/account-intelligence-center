import { NextRequest, NextResponse } from "next/server";
import { createTask } from "@/lib/hubspot";
import { HUBSPOT_OWNER_ID } from "@/lib/anthropic";

export const maxDuration = 30;

export async function POST(req: NextRequest) {
  try {
    const { dealId, subject, dueDate, priority = "MEDIUM", notes } =
      await req.json();
    if (!dealId || !subject) {
      return NextResponse.json(
        { error: "dealId and subject are required" },
        { status: 400 }
      );
    }
    const task = await createTask(
      dealId,
      subject,
      priority,
      dueDate ?? null,
      notes ?? null,
      HUBSPOT_OWNER_ID
    );
    return NextResponse.json({ success: true, id: task.id });
  } catch (error: any) {
    console.error("HubSpot task API error:", error);
    return NextResponse.json(
      { error: error.message || "Failed to create task" },
      { status: 500 }
    );
  }
}
