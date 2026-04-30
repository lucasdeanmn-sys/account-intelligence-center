import { NextRequest, NextResponse } from "next/server";
import { runAgentLoop, hubspotServer, HUBSPOT_OWNER_ID } from "@/lib/anthropic";

export const maxDuration = 60;

const SYSTEM = `You are a HubSpot CRM assistant. Create a new deal with the provided details. Set owner ID to ${HUBSPOT_OWNER_ID}. If a company name is provided, find or create the company and associate it with the deal. Confirm success with the word DONE and the new deal ID.`;

export async function POST(req: NextRequest) {
  try {
    const { dealName, stage, amount, closeDate, company } = await req.json();

    if (!dealName || !stage) {
      return NextResponse.json(
        { error: "dealName and stage are required" },
        { status: 400 }
      );
    }

    const result = await runAgentLoop(
      SYSTEM,
      `Create a new HubSpot deal with these details:

Deal name: ${dealName}
Pipeline stage: ${stage}${amount ? `\nAmount: $${amount}` : ""}${closeDate ? `\nClose date: ${closeDate}` : ""}${company ? `\nAssociated company: ${company}` : ""}
Owner ID: ${HUBSPOT_OWNER_ID}`,
      [hubspotServer()],
      2048
    );

    return NextResponse.json({ success: true, result });
  } catch (error: any) {
    console.error("HubSpot deal API error:", error);
    return NextResponse.json(
      { error: error.message || "Failed to create deal" },
      { status: 500 }
    );
  }
}
