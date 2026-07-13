import { NextRequest, NextResponse } from "next/server";
import { updateNoteBody, createDealNote, createCompanyNote, getDealCompanyId, findCompanyIdByName, searchDeals, updateDealProperties, CANCEL_SENTINEL } from "@/lib/hubspot";
import { cancelRenewalRow } from "@/lib/sheets";
import { googleConfigured } from "@/lib/google";

export const maxDuration = 30;

export async function POST(req: NextRequest) {
  try {
    const { m1NoteId, m1NoteHtml, company, expirationDate, csaInstanceName, currentDealId, platform, renewalStartDate } =
      await req.json();

    let noteError: string | null = null;
    let sheetError: string | null = null;
    let companyId: string | null = null;

    // NOC360 rows carry a synthetic currentDealId ("csa-noc360:<instance>") —
    // there is no expiring deal to note or stamp, and they are not on the MSI
    // sheet. Cancelling one means: mark LAST year's yearly deal with the
    // cancel sentinel (found by canonical name; year one has none — the
    // original contract deal is closed out manually) and leave a dated
    // "Did not renew" note on the company, found by name.
    const isNoc360 =
      platform === "NOC360" || String(currentDealId ?? "").startsWith("csa-noc360:");
    if (isNoc360) {
      if (company && renewalStartDate) {
        const priorYear =
          new Date(renewalStartDate + "T00:00:00.000Z").getUTCFullYear() - 1;
        const prior = await searchDeals(
          [{ propertyName: "dealname", operator: "EQ", value: `${company} (NOC360 Renewal - ${priorYear})` }],
          ["dealname"],
          1
        ).catch(() => []);
        if (prior.length > 0) {
          await updateDealProperties(prior[0].id, {
            service_terminated: CANCEL_SENTINEL,
          }).catch((e) => {
            console.warn("NOC360 cancel sentinel set failed:", e.message);
            noteError = e.message;
          });
        }
      }
      if (company && expirationDate) {
        companyId = await findCompanyIdByName(company).catch(() => null);
        if (companyId) {
          await createCompanyNote(
            companyId,
            `<p><strong>Did not renew — ${expirationDate}</strong></p>`
          ).catch((e) => {
            console.warn("NOC360 cancel company note failed:", e.message);
            if (!noteError) noteError = e.message;
          });
        }
      }
      return NextResponse.json({ success: true, noteError, sheetError, companyId: companyId ?? null });
    }

    // Step 1 (best-effort display): Prepend "Did not renew" to the M1 note so
    // it is visible when a rep opens the deal in HubSpot.  This uses PATCH on
    // the existing note, which HubSpot's batch/read endpoint may cache — so it
    // is NOT the primary signal for server-side cancelled detection.
    if (m1NoteId && m1NoteHtml != null && !m1NoteHtml.includes("Did not renew")) {
      const prepended = `<p><strong>Did not renew</strong></p>\n` + m1NoteHtml;
      await updateNoteBody(m1NoteId, prepended).catch((e) => {
        console.warn("Cancel note update failed:", e.message);
        noteError = e.message;
      });
    }

    // Step 2: Create a fresh direct DEAL note.
    // A newly-created note has no cached content, so it is immediately visible
    // via the v4 associations endpoint on the next report run.  Covers the common
    // case where the same deal is matched on every run.
    if (currentDealId) {
      await createDealNote(
        currentDealId,
        "<p><strong>Did not renew</strong></p>"
      ).catch((e) => {
        console.warn("Cancel deal note creation failed:", e.message);
        if (!noteError) noteError = e.message;
      });
    }

    // Step 3 (most reliable — handles renamed/rebranded companies): Create a fresh
    // note directly on the COMPANY object, tagged with the expiration date.
    //
    // Why: getDealNotes fetches both direct deal notes AND company notes (via
    // getCompanyNotesForDeal).  Company notes are found for ANY deal associated
    // with the company — so even if the algorithm picks a different deal on a future
    // run (e.g. "NTS Communications (MSI Year 3)" vs "Vexus Fiber (MSI Year 4)",
    // same company, different deal names), the cancel stamp is always detected.
    //
    // The expirationDate tag ("Did not renew — YYYY-MM-DD") prevents this note
    // from incorrectly flagging the company as cancelled in a future report period
    // if they renew under a new agreement.
    if (currentDealId && expirationDate) {
      companyId = await getDealCompanyId(currentDealId).catch(() => null);
      if (companyId) {
        await createCompanyNote(
          companyId,
          `<p><strong>Did not renew — ${expirationDate}</strong></p>`
        ).catch((e) => {
          console.warn("Cancel company note creation failed:", e.message);
        });
      }
    }

    // Step 4 (most reliable — survives URL/session changes, no notes needed):
    // Stamp service_terminated on the current deal with the cancel sentinel.
    // The report route already fetches service_terminated for every deal in the
    // initial batch query, so detection is free and works on every run without
    // any extra API calls or note-fetching.
    if (currentDealId) {
      await updateDealProperties(currentDealId, {
        service_terminated: CANCEL_SENTINEL,
      }).catch((e) => {
        console.warn("Cancel sentinel property set failed:", e.message);
        if (!noteError) noteError = e.message;
      });
    }

    // Highlight the row red on the Google Sheet
    if (googleConfigured() && company && expirationDate) {
      const monthLabel = new Date(
        expirationDate + "T00:00:00.000Z"
      ).toLocaleString("en-US", {
        month: "long",
        year: "numeric",
        timeZone: "UTC",
      });
      await cancelRenewalRow(monthLabel, company, csaInstanceName ?? null).catch(
        (e) => {
          console.warn("Cancel sheet update failed:", e.message);
          sheetError = e.message;
        }
      );
    }

    return NextResponse.json({ success: true, noteError, sheetError, companyId: companyId ?? null });
  } catch (error: any) {
    console.error("MSI cancel error:", error);
    return NextResponse.json(
      { error: error.message || "Failed to cancel renewal" },
      { status: 500 }
    );
  }
}
