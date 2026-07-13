import { NextRequest, NextResponse } from "next/server";
import { updateDealProperties, getFirstOpenStageId, searchDeals } from "@/lib/hubspot";

export const maxDuration = 30;

export async function POST(req: NextRequest) {
  try {
    const { currentDealId, renewalDealId, company, renewalStartDate } = await req.json();

    if (!currentDealId) {
      return NextResponse.json({ error: "currentDealId required" }, { status: 400 });
    }

    // 1. Clear service_terminated on the current (expiring) deal so the tracker
    //    no longer treats it as processed. NOC360 rows ("csa-noc360:*") have no
    //    expiring deal of their own — processing terminated LAST year's yearly
    //    deal instead, so undo that by the same canonical-name lookup.
    if (!String(currentDealId).startsWith("csa-")) {
      await updateDealProperties(currentDealId, { service_terminated: "" });
    } else if (company && renewalStartDate) {
      const priorYear =
        new Date(renewalStartDate + "T00:00:00.000Z").getUTCFullYear() - 1;
      const prior = await searchDeals(
        [{ propertyName: "dealname", operator: "EQ", value: `${company} (NOC360 Renewal - ${priorYear})` }],
        ["dealname"],
        1
      ).catch(() => []);
      if (prior.length > 0) {
        await updateDealProperties(prior[0].id, { service_terminated: "" }).catch((e) => {
          console.warn("Prior-year NOC360 un-termination failed (non-fatal):", e.message);
        });
      }
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
