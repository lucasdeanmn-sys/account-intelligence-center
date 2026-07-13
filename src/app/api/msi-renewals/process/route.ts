import { NextRequest, NextResponse } from "next/server";
import {
  createMsiRenewalDeal,
  getDealLineItems,
  updateLineItem,
  updateDealProperties,
  cloneLineItemsToDeal,
  getExtensionDealsForCompany,
  appendAutoRenewalEntry,
  createLineItem,
  getDealCustomFields,
  getDealCompanyId,
  associateDealWithCompany,
  findCompanyIdByName,
  searchDeals,
  updateDealMrr,
  associateNoteWithDeal,
  MSI_PIPELINE_ID,
  MSI_STAGE_READY,
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
      platform,
      csaLicenseCount,
    } = await req.json();

    if (!currentDealId || !renewalDealName || !renewalCount || !expirationDate) {
      return NextResponse.json(
        { error: "currentDealId, renewalDealName, renewalCount, and expirationDate are required" },
        { status: 400 }
      );
    }

    // NOC360 renewals come from CSA with a synthetic currentDealId
    // ("csa-noc360:<instance>") — there is no expiring HubSpot deal to read
    // fields from, clone line items from, or terminate, and no M1 note.
    // Processing one means: create (or reuse) the yearly
    // "Company (NOC360 Renewal - YYYY)" deal in Ready for Billing.
    const isNoc360 =
      platform === "NOC360" || String(currentDealId).startsWith("csa-noc360:");

    // 1. Use hardcoded pipeline/stage IDs for "Software - Renewals" /
    //    "Closed Won - Ready for Billing".  Dynamic lookup via getClosedWonStage
    //    was unreliable — "Support - Renewal" appeared before "Software - Renewals"
    //    in the HubSpot API response and was picked instead.
    const stage = { pipelineId: MSI_PIPELINE_ID, stageId: MSI_STAGE_READY };
    const [currentCustomFields, currentCompanyId] = isNoc360
      ? [{} as Record<string, string>, null]
      : await Promise.all([
          getDealCustomFields(currentDealId).catch(() => ({})),
          getDealCompanyId(currentDealId).catch(() => null),
        ]);

    // 2. Create or identify the renewal deal
    let renewalDealId = existingRenewalDealId as string | null;
    let action: "created" | "updated" = "updated";

    // Re-processing guard for NOC360: the row carries no renewalDealId after a
    // reload, so look the yearly deal up by its exact name before creating one.
    if (!renewalDealId && isNoc360) {
      const existing = await searchDeals(
        [{ propertyName: "dealname", operator: "EQ", value: renewalDealName }],
        ["dealname"],
        1
      ).catch(() => []);
      if (existing.length > 0) renewalDealId = existing[0].id;
    }

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
      // (NOC360: no current deal — look the company up by name instead).
      const companyId =
        currentCompanyId ??
        (isNoc360 && company ? await findCompanyIdByName(company).catch(() => null) : null);
      if (companyId) {
        await associateDealWithCompany(renewalDealId!, companyId).catch((e) => {
          console.warn("Company association failed (non-fatal):", e.message);
        });
      }
    }

    // 3. Set the renewal deal to Closed Won - Ready for Billing, update dates.
    //
    // closedate = end of the PREVIOUS (expiring) term — this is the intended
    // convention: the renewal deal's close date marks when the prior term ends
    // and the new one begins.
    //
    // service_terminated is explicitly cleared on the renewal deal.  It should
    // remain empty until THIS deal's own term ends (i.e. when Year N+2 is
    // processed next year).  Clearing it here is defensive: a previous failed
    // or undone processing run could have left a stale value behind.
    const dealUpdates: Record<string, string> = {
      closedate: new Date(expirationDate + "T00:00:00.000Z").getTime().toString(),
      service_terminated: "",
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
    } else if (isNoc360) {
      // NOC360: no current deal to clone from — create a single line item so
      // the count is on the deal. Count = max(CSA license, circuits rounded),
      // already computed as renewalCount by the tracker.
      await createLineItem(renewalDealId!, "NOC360", renewalCount, null, null, null).catch((e) => {
        console.warn("NOC360 line item failed (non-fatal):", e.message);
      });
      hadLineItems = true;
    } else {
      // New deal — clone line items from the current (expiring) deal with updated qty
      await cloneLineItemsToDeal(currentDealId, renewalDealId!, renewalCount).catch((e) => {
        console.warn("Line item clone failed (non-fatal):", e.message);
      });
      hadLineItems = true;
    }

    // 4b. If the company has active extension deals, copy all their line items
    //     onto the renewal deal so billing for the full term is in one place.
    //     A company can have multiple extension deals (e.g. POM + FOM), so we
    //     collect them all via getExtensionDealsForCompany.
    //     We hoist extDeals so the names are available for the sheet write below.
    //
    //     Dedup guard: build a set of product IDs and names already on the renewal
    //     deal so re-processing never creates duplicate extension line items.
    let extDeals: Awaited<ReturnType<typeof getExtensionDealsForCompany>> = [];
    if (hasExtension && company) {
      extDeals = await getExtensionDealsForCompany(company).catch(() => []);

      // Re-read current renewal line items (may have been cloned in step 4)
      const renewalLineItems = await getDealLineItems(renewalDealId!).catch(() => []);
      const existingProductIds = new Set(
        renewalLineItems.map((li: any) => li.properties?.hs_product_id).filter(Boolean)
      );
      const existingNames = new Set(
        renewalLineItems.map((li: any) => (li.properties?.name ?? "").toLowerCase()).filter(Boolean)
      );

      for (const ext of extDeals) {
        if (ext.lineItems?.length) {
          await Promise.all(
            ext.lineItems.map((item: any) => {
              const productId = item.properties?.hs_product_id ?? null;
              const itemName = (item.properties?.name ?? "").toLowerCase();
              // Skip if the renewal deal already has this product or name
              if (productId && existingProductIds.has(productId)) return Promise.resolve(null);
              if (itemName && existingNames.has(itemName)) return Promise.resolve(null);
              return createLineItem(
                renewalDealId!,
                item.properties?.name ?? "MSI Extension",
                renewalCount,            // always match the renewal circuit count
                item.properties?.price ?? null,
                null,
                productId
              ).catch(() => null); // non-fatal
            })
          );
        }
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

    // 5. Mark the new year in the M1 note as invoiced by italicizing/appending
    //    "MSI Year N - X,XXX". Works for both order-form and auto-renew deals:
    //    - Order-form: existing non-italic "Year N - X" entry is italicized in place.
    //    - Auto-renew: new italic "Year N - X,XXX (Auto-renew)" bullet is appended.
    if (m1NoteId && m1NoteHtml && nextMsiYear && renewalCount) {
      await appendAutoRenewalEntry(m1NoteId, m1NoteHtml, nextMsiYear, renewalCount).catch((e) => {
        console.warn("M1 note update failed (non-fatal):", e.message);
      });
    }

    // 6. Set service_terminated on the current (expiring) deal.
    //    NOC360 rows have a synthetic currentDealId — the expiring deal is last
    //    year's yearly deal, found by its canonical name. Year one has no prior
    //    deal (the original contract deal is closed out manually) — no-op.
    if (!isNoc360) {
      await updateDealProperties(currentDealId, {
        service_terminated: new Date(expirationDate + "T00:00:00.000Z").getTime().toString(),
      });
    } else if (company && renewalStartDate) {
      const priorYear =
        new Date(renewalStartDate + "T00:00:00.000Z").getUTCFullYear() - 1;
      const priorName = `${company} (NOC360 Renewal - ${priorYear})`;
      const prior = await searchDeals(
        [{ propertyName: "dealname", operator: "EQ", value: priorName }],
        ["dealname"],
        1
      ).catch(() => []);
      if (prior.length > 0) {
        await updateDealProperties(prior[0].id, {
          service_terminated: new Date(expirationDate + "T00:00:00.000Z").getTime().toString(),
        }).catch((e) => {
          console.warn("Prior-year NOC360 termination failed (non-fatal):", e.message);
        });
      }
    }

    // 7. Append to Google Sheet (best-effort — failure is non-fatal but surfaced in response)
    let sheetWriteError: string | null = null;
    if (isNoc360) {
      // NOC360 renewals stay off the MSI renewal sheet — the yearly deal in
      // HubSpot and the NOC360 section email (to Joan) are their record.
    } else if (googleConfigured() && company) {
      const monthLabel = new Date(expirationDate + "T00:00:00.000Z").toLocaleString("en-US", {
        month: "long",
        year: "numeric",
        timeZone: "UTC",
      });
      const extensionNames = extDeals.map((e) => e.extensionName).filter(Boolean);
      await appendRenewalRow(monthLabel, {
        company,
        instanceName: csaInstanceName ?? null,
        currentLicense: currentYearLicense ?? null,   // current year's invoiced count, not next year's order form
        csaCount: csaCount ?? null,
        csaRounded: csaRounded ?? null,
        renewalCount,
        isAutoRenew: !orderFormLicense,
        extensions: extensionNames.length ? extensionNames.join(", ") : null,
        sheetNote: sheetNote ?? null,
      }).catch((e) => {
        console.warn("Sheet write failed (non-fatal):", e.message);
        sheetWriteError = e.message ?? "Sheet write failed";
      });
    } else if (!googleConfigured()) {
      sheetWriteError = "Google Sheets not configured";
    }

    return NextResponse.json({
      success: true,
      renewalDealId,
      action,
      hadLineItems,
      sheetWriteError,
    });
  } catch (error: any) {
    console.error("MSI renewal process error:", error);
    return NextResponse.json(
      { error: error.message || "Failed to process renewal" },
      { status: 500 }
    );
  }
}
