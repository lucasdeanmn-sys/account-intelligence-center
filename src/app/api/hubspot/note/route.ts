import { NextRequest, NextResponse } from "next/server";
import { createNote } from "@/lib/hubspot";
import { HUBSPOT_OWNER_ID } from "@/lib/anthropic";

export const maxDuration = 30;

export async function POST(req: NextRequest) {
  try {
    const { dealId, htmlContent } = await req.json();
    if (!dealId || !htmlContent) {
      return NextResponse.json(
        { error: "dealId and htmlContent are required" },
        { status: 400 }
      );
    }
    const note = await createNote(dealId, htmlContent, HUBSPOT_OWNER_ID);
    return NextResponse.json({ success: true, id: note.id });
  } catch (error: any) {
    console.error("HubSpot note API error:", error);
    return NextResponse.json(
      { error: error.message || "Failed to create note" },
      { status: 500 }
    );
  }
}
