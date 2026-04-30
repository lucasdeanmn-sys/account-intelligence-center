import { NextRequest, NextResponse } from "next/server";
import { runAgentLoop, hubspotServer, HUBSPOT_OWNER_ID } from "@/lib/anthropic";

export const maxDuration = 60;

const SYSTEM = `You are a HubSpot CRM assistant. Your only job is to create a note on a specific deal using the HubSpot MCP tools available to you. Create the note exactly as instructed — do not modify the content. Confirm success by returning the word DONE and the engagement/note ID if available.`;

export async function POST(req: NextRequest) {
  try {
    const { dealId, htmlContent } = await req.json();

    if (!dealId || !htmlContent) {
      return NextResponse.json(
        { error: "dealId and htmlContent are required" },
        { status: 400 }
      );
    }

    const result = await runAgentLoop(
      SYSTEM,
      `Create a note on HubSpot deal ID "${dealId}" with the following HTML body content. Associate it with owner ID ${HUBSPOT_OWNER_ID}.

Note body (HTML):
${htmlContent}`,
      [hubspotServer()],
      2048
    );

    const success = /done|success|created|note/i.test(result);
    return NextResponse.json({ success, result });
  } catch (error: any) {
    console.error("HubSpot note API error:", error);
    return NextResponse.json(
      { error: error.message || "Failed to create note" },
      { status: 500 }
    );
  }
}
