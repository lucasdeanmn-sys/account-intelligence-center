import { NextRequest, NextResponse } from "next/server";
import { createDeal } from "@/lib/hubspot";
import { HUBSPOT_OWNER_ID } from "@/lib/anthropic";

export const maxDuration = 30;

export async function POST(req: NextRequest) {
  try {
    const { dealName, stage, amount, closeDate, company } = await req.json();
    if (!dealName || !stage) {
      return NextResponse.json(
        { error: "dealName and stage are required" },
        { status: 400 }
      );
    }
    const deal = await createDeal(
      dealName,
      stage,
      amount ?? null,
      closeDate ?? null,
      company ?? null,
      HUBSPOT_OWNER_ID
    );
    return NextResponse.json({ success: true, id: deal.id });
  } catch (error: any) {
    console.error("HubSpot deal API error:", error);
    return NextResponse.json(
      { error: error.message || "Failed to create deal" },
      { status: 500 }
    );
  }
}
