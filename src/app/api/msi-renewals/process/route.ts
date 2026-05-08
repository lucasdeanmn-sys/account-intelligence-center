import { NextRequest, NextResponse } from "next/server";
import {
  createMsiRenewalDeal,
  getDealLineItems,
  updateLineItem,
  updateDealProperties,
  getClosedWonStage,
  cloneLineItemsToDeal,
  getExtensionDealForCompany,
  appendAutoRenewalEntry,
  createLineItem,
  getDealCustomFields,
  getDealCompanyId,
  associateDealWithCompany,
  updateDealMrr,
  associateNoteWithDeal,
} from "@/lib/hubspot";
import { appendRenewalRow } from "@/lib/sheets";
import { HUBSPOT_OWNER_ID } from "@/lib/anthropic";
import { googleConfigured } from "@/lib/google";

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
      currentYearLicense,
      csaCount,
      csaRounded,
      // New fields
      m1NoteId,
      m1NoteHtml,
      nextMsiYear,
      hasExtension,
      csaInstanceName,
      sheetNote,
    } = await req.json();

    if (!currentDealId || !renewalDealName || !renewalCount || !expirationDate) {
      return NextResponse.json(
        { error: "currentDealId, renewalDealName, renewalCount, and expirationDate are required" },
        { status: 400 }
      );
    }

    // 1. Resolve the pipeline stage ("Closed Won - Ready for Billing") and fetch
    //    current deal's custom fields + company association in parallel.
    const [stage, currentCustomFields, currentCompanyId] = await Promise.all([
      getClosedWonStage("renewal").catch(() => null),
      getDealCustomFields(currentDealId).catch(() => ({})),
      getDealCompanyId(currentDealId).catch(() => null),
    ]);

    // 2. Create or identify the renewal deal
    let renewalDealId = existingRenewalDealId as string | null;
    let action: "created" | "updated" = "updated";

    if (!renewalDealId) {
      const newDeal = await createMsiRenewalDeal(
        renewalDealName,
        renewalStartDate,
        HUBSPOT_OWNER_ID,
        stage?.pipelineId,
        stage?.stageId,
        currentCustomFields as Record<string, string>
      );
      renewalDealId = newDeal.id;
      action = "created";

      // Associate the new deal with the same company as the current deal
      if (currentCompanyId) {
        await associateDealWithCompany(renewalDealId!, currentCompanyId).catch((e) => {
          console.warn("Company association failed (non-fatal):", e.message);
        });
      }
    }

    // 3. Set the renewal deal to Closed Won - Ready for Billing, update dates
    const dealUpdates: Record<string, string> = {
      closedate: new Date(expirationDate + "T00:00:00.000Z").getTime().toString(),
    };
    if (stage?.stageId) dealUpdates.dealstage = stage.stageId;
    if (renewalStartDate) {
      dealUpdates.subscription_start_date = new Date(renewalStartDate + "T00:00:00.000Z").getTime().toString();
    }
    await updateDealProperties(renewalDealId!, dealUpdates);

    // 4. Line items ─────────────────────────────────────────────────────────
    const existingLineItems = await getDealLineItems(renewalDealId!).catch(() => []);
    let hadLineItems = existingLineItems.length > 0;

    if (existingLineItems.length > 0) {
      // Renewal deal already has line items — just update the primary quantity
      await updateLineItem(existingLineItems[0].id, renewalCount);
    } else {
      // New deal — clone line items from the current (expiring) deal with updated qty
      await cloneLineItemsToDeal(currentDealId, renewalDealId!, renewalCount).catch((e) => {
        console.warn("Line item clone failed (non-fatal):", e.message);
      });
      hadLineItems = true;
    }

    // 4b. If the company has an active extension deal, also copy its line items
    //     onto the renewal deal so billing for the full term is in one place.
    if (hasExtension && company) {
      const ext = await getExtensionDealForCompany(company).catch(() => null);
      if (ext?.lineItems?.length) {
        await Promise.all(
          ext.lineItems.map((item: any) =>
            createLineItem(
              renewalDealId!,
              item.properties?.name ?? "MSI Extension",
              parseInt(item.properties?.quantity ?? "1", 10),
              item.properties?.price ?? null,
              null,
              item.properties?.hs_product_id ?? null
            ).catch(() => null) // non-fatal
          )
        );
      }
    }

    // 4c. Recalculate deal amount (MRR = annual total / 12) from the final line items.
    //     Catalog products auto-populate price, so we read them back here.
    await updateDealMrr(renewalDealId!).catch((e) => {
      console.warn("MRR update failed (non-fatal):", e.message);
    });

    // 4d. Associate the M1 Order Form note with the renewal deal so it's visible
    //     in HubSpot without navigating back to the original deal.
    if (m1NoteId) {
      await associateNoteWithDeal(m1NoteId, renewalDealId!).catch((e) => {
        console.warn("Note association failed (non-fatal):", e.message);
      });
    }

    // 5. For auto-renew deals (no order form), mark the new year in the M1 note
    //    as invoiced by appending/italicizing "MSI Year N - X,XXX".
    if (!orderFormLicense && m1NoteId && m1NoteHtml && nextMsiYear && renewalCount) {
      await appendAutoRenewalEntry(m1NoteId, m1NoteHtml, nextMsiYear, renewalCount).catch((e) => {
        console.warn("M1 note auto-renew update failed (non-fatal):", e.message);
      });
    }

    // 6. Set service_terminated on the current (expiring) deal
    await updateDealProperties(currentDealId, {
      service_terminated: new Date(expirationDate + "T00:00:00.000Z").getTime().toString(),
    });

    // 7. Append to Google Sheet (best-effort)
    if (googleConfigured() && company) {
      const monthLabel = new Date(expirationDate + "T00:00:00.000Z").toLocaleString("en-US", {
        month: "long",
        year: "numeric",
        timeZone: "UTC",
      });
      await appendRenewalRow(monthLabel, {
        company,
        instanceName: csaInstanceName ?? null,
        currentLicense: currentYearLicense ?? null,   // current year's invoiced count, not next year's order form
        csaCount: csaCount ?? null,
        csaRounded: csaRounded ?? null,
        renewalCount,
        isAutoRenew: !orderFormLicense,
        sheetNote: sheetNote ?? null,
      }).catch((e) => console.warn("Sheet write failed (non-fatal):", e.message));
    }

    return NextResponse.json({
      success: true,
      renewalDealId,
      action,
      hadLineItems,
    });
  } catch (error: any) {
    console.error("MSI renewal process error:", error);
    return NextResponse.json(
      { error: error.message || "Failed to process renewal" },
      { status: 500 }
    );
  }
}
