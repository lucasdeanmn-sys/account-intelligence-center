import { NextRequest, NextResponse } from "next/server";
import { updateDealProperties, getFirstOpenStageId } from "@/lib/hubspot";

export const maxDuration = 30;

export async function POST(req: NextRequest) {
  try {
    const { currentDealId, renewalDealId } = await req.json();

    if (!currentDealId) {
      return NextResponse.json({ error: "currentDealId required" }, { status: 400 });
    }

    // 1. Clear service_terminated on the current (expiring) deal so the tracker
    //    no longer treats it as processed.
    await updateDealProperties(currentDealId, { service_terminated: "" });

    // 2. If a renewal deal exists, move it back to the first open pipeline stage
    //    so it no longer satisfies the "Closed Won - Ready for Billing" check.
    //    This ensures re-running the report shows the deal as unprocessed even
    //    before the next fetch refreshes the freshSvcTermMap.
    if (renewalDealId) {
      const stageId = await getFirstOpenStageId("renewal").catch(() => null);
      if (stageId) {
        await updateDealProperties(renewalDealId, { dealstage: stageId });
      }
    }

    return NextResponse.json({ success: true });
  } catch (error: any) {
    console.error("MSI unprocess error:", error);
    return NextResponse.json(
      { error: error.message || "Failed to unprocess renewal" },
      { status: 500 }
    );
  }
}
