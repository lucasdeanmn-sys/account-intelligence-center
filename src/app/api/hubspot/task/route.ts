import { NextRequest, NextResponse } from "next/server";
import { runAgentLoop, configured, hubspotServer, HUBSPOT_OWNER_ID } from "@/lib/anthropic";

export const maxDuration = 60;

const SYSTEM = `You are a HubSpot CRM assistant. Your only job is to create a task on a specific deal using the HubSpot MCP tools available to you. Create the task exactly as instructed. Confirm success by returning the word DONE and the task/engagement ID if available.`;

export async function POST(req: NextRequest) {
  try {
    const { dealId, subject, dueDate, priority = "MEDIUM", notes } = await req.json();

    if (!dealId || !subject) {
      return NextResponse.json(
        { error: "dealId and subject are required" },
        { status: 400 }
      );
    }

    const result = await runAgentLoop(
      SYSTEM,
      `Create a task on HubSpot deal ID "${dealId}" with the following details. Associate it with owner ID ${HUBSPOT_OWNER_ID}.

Subject: ${subject}
Priority: ${priority}${dueDate ? `\nDue date: ${dueDate}` : ""}${notes ? `\nNotes: ${notes}` : ""}`,
      configured(hubspotServer()),
      2048
    );

    const success = /done|success|created|task/i.test(result);
    return NextResponse.json({ success, result });
  } catch (error: any) {
    console.error("HubSpot task API error:", error);
    return NextResponse.json(
      { error: error.message || "Failed to create task" },
      { status: 500 }
    );
  }
}
