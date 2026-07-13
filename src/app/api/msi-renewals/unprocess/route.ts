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
    //    no longer treats it as processed. Synthetic ids ("csa-noc360:*") have
    //    no expiring deal — only the renewal deal below needs resetting.
    if (!String(currentDealId).startsWith("csa-")) {
      await updateDealProperties(currentDealId, { service_terminated: "" });
    }

    // 2. If a renewal deal exists, move it back to the first open pipeline stage
    //    and clear its service_terminated so it no longer satisfies the
    //    "Closed Won - Ready for Billing" check.
    //    service_terminated on the renewal deal may have been set by a HubSpot
    //    automation (closedate → service_terminated on Closed Won stage entry);
    //    clearing it here ensures a clean slate for re-processing.
    if (renewalDealId) {
      const stageId = await getFirstOpenStageId("renewal").catch(() => null);
      const renewalUpdates: Record<string, string> = { service_terminated: "" };
      if (stageId) renewalUpdates.dealstage = stageId;
      await updateDealProperties(renewalDealId, renewalUpdates);
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
