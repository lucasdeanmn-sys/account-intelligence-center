import { NextRequest, NextResponse } from "next/server";
import { createContact } from "@/lib/hubspot";
import { HUBSPOT_OWNER_ID } from "@/lib/anthropic";

export const maxDuration = 30;

export async function POST(req: NextRequest) {
  try {
    const { dealId, firstName, lastName, email, phone, title } =
      await req.json();
    if (!firstName || !lastName || !email) {
      return NextResponse.json(
        { error: "firstName, lastName, and email are required" },
        { status: 400 }
      );
    }
    const contact = await createContact(
      dealId ?? null,
      firstName,
      lastName,
      email,
      phone ?? null,
      title ?? null,
      HUBSPOT_OWNER_ID
    );
    return NextResponse.json({ success: true, id: contact.id });
  } catch (error: any) {
    console.error("HubSpot contact API error:", error);
    return NextResponse.json(
      { error: error.message || "Failed to create contact" },
      { status: 500 }
    );
  }
}
