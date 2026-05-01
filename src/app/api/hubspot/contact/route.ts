import { NextRequest, NextResponse } from "next/server";
import { runAgentLoop, configured, hubspotServer, HUBSPOT_OWNER_ID } from "@/lib/anthropic";

export const maxDuration = 60;

const SYSTEM = `You are a HubSpot CRM assistant. Create a new contact and associate it with the specified deal. Use the exact field values provided. Set the owner to ${HUBSPOT_OWNER_ID}. Confirm success with the word DONE and the new contact ID.`;

export async function POST(req: NextRequest) {
  try {
    const { dealId, firstName, lastName, email, phone, title } = await req.json();

    if (!firstName || !lastName || !email) {
      return NextResponse.json(
        { error: "firstName, lastName, and email are required" },
        { status: 400 }
      );
    }

    const result = await runAgentLoop(
      SYSTEM,
      `Create a new HubSpot contact with these details and associate them with deal ID "${dealId}":

First name: ${firstName}
Last name: ${lastName}
Email: ${email}${phone ? `\nPhone: ${phone}` : ""}${title ? `\nJob title: ${title}` : ""}
Owner ID: ${HUBSPOT_OWNER_ID}`,
      configured(hubspotServer()),
      2048
    );

    return NextResponse.json({ success: true, result });
  } catch (error: any) {
    console.error("HubSpot contact API error:", error);
    return NextResponse.json(
      { error: error.message || "Failed to create contact" },
      { status: 500 }
    );
  }
}
