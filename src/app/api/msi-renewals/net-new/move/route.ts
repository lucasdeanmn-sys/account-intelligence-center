import { NextRequest, NextResponse } from "next/server";
import { moveDealToReadyForBilling } from "@/lib/hubspot";

export const maxDuration = 30;
export const dynamic = "force-dynamic";

// Advance a single net-new / standalone-extension deal from Pending Billing to
// the Ready-for-Billing stage of its pipeline. Driven by the msi-tracker
// "Move to Ready for Billing" button. Term-start gating lives in the UI (a deal
// whose term hasn't started yet doesn't get the button).
export async function POST(req: NextRequest) {
  try {
    const { dealId, pipeline } = (await req.json()) as {
      dealId?: string;
      pipeline?: string;
    };
    if (!dealId || !pipeline) {
      return NextResponse.json(
        { error: "dealId and pipeline are required" },
        { status: 400 }
      );
    }
    const result = await moveDealToReadyForBilling(dealId, pipeline);
    return NextResponse.json({ success: true, ...result });
  } catch (error: any) {
    console.error("net-new move-to-ready error:", error);
    return NextResponse.json(
      { error: error?.message || "Failed to move deal to Ready for Billing" },
      { status: 500 }
    );
  }
}
