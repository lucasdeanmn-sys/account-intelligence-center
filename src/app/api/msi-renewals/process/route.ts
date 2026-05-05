import { NextRequest, NextResponse } from "next/server";
import {
  createMsiRenewalDeal,
  getDealLineItems,
  updateLineItem,
  updateDealProperties,
  getClosedWonStage,
} from "@/lib/hubspot";
import { appendRenewalRow } from "@/lib/sheets";
import { HUBSPOT_OWNER_ID } from "@/lib/anthropic";

export const maxDuration = 60;

export async function POST(req: NextRequest) {
  try {
    const {
      currentDealId,
      renewalDealId: existingRenewalDealId,
      renewalDealName,
      renewalCount,
      renewalStartDate,
      expirationDate,
      company,
      orderFormLicense,
      cssaCount,
      cssaRounded,
    } = await req.json();

    if (!currentDealId || !renewalDealName || !renewalCount || !expirationDate) {
      return NextResponse.json(
        { error: "currentDealId, renewalDealName, renewalCount, and expirationDate are required" },
        { status: 400 }
      );
    }

    // 1. Get or create the renewal deal
    let renewalDealId = existingRenewalDealId as string | null;
    let action: "created" | "updated" = "updated";

    // Look up the Software Renewal Pipeline closed won stage
    const stage = await getClosedWonStage("renewal").catch(() => null);

    if (!renewalDealId) {
      const newDeal = await createMsiRenewalDeal(
        renewalDealName,
        renewalStartDate,
        HUBSPOT_OWNER_ID,
        stage?.pipelineId,
        stage?.stageId
      );
      renewalDealId = newDeal.id;
      action = "created";
    }

    // 2. Update the renewal deal: stage → Closed Won, close date = expirationDate
    const dealUpdates: Record<string, string> = {
      closedate: new Date(expirationDate + "T00:00:00.000Z").getTime().toString(),
    };
    if (stage?.stageId) dealUpdates.dealstage = stage.stageId;
    if (renewalStartDate) {
      dealUpdates.subscription_start_date = new Date(renewalStartDate + "T00:00:00.000Z").getTime().toString();
    }
    await updateDealProperties(renewalDealId!, dealUpdates);

    // 3. Update line item quantity on the renewal deal
    const lineItems = await getDealLineItems(renewalDealId!).catch(() => []);
    if (lineItems.length > 0) {
      // Update the first line item
      await updateLineItem(lineItems[0].id, renewalCount);
    }
    // If no line items exist, skip — user will need to add manually
    // (flagged in the UI confirmation)

    // 4. Set service_terminated on the current (expiring) deal
    await updateDealProperties(currentDealId, {
      service_terminated: new Date(expirationDate + "T00:00:00.000Z").getTime().toString(),
    });

    // 5. Append to Google Sheet (best-effort)
    if (process.env.GOOGLE_OAUTH_TOKEN && company) {
      const monthLabel = new Date(expirationDate + "T00:00:00.000Z").toLocaleString("en-US", {
        month: "long",
        year: "numeric",
        timeZone: "UTC",
      });
      await appendRenewalRow(monthLabel, {
        company,
        currentLicense: orderFormLicense ?? null,
        cssaCount: cssaCount ?? null,
        cssaRounded: cssaRounded ?? null,
        renewalCount,
      }).catch((e) => console.warn("Sheet write failed (non-fatal):", e.message));
    }

    return NextResponse.json({
      success: true,
      renewalDealId,
      action,
      hadLineItems: lineItems.length > 0,
    });
  } catch (error: any) {
    console.error("MSI renewal process error:", error);
    return NextResponse.json(
      { error: error.message || "Failed to process renewal" },
      { status: 500 }
    );
  }
}
