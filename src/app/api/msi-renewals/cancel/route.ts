import { NextRequest, NextResponse } from "next/server";
import { updateNoteBody, createDealNote } from "@/lib/hubspot";
import { cancelRenewalRow } from "@/lib/sheets";
import { googleConfigured } from "@/lib/google";

export const maxDuration = 30;

export async function POST(req: NextRequest) {
  try {
    const { m1NoteId, m1NoteHtml, company, expirationDate, csaInstanceName, currentDealId } =
      await req.json();

    let noteError: string | null = null;
    let sheetError: string | null = null;

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

    // Step 2 (primary detection signal): ALWAYS create a fresh direct deal note.
    //
    // Why: HubSpot's /crm/v3/objects/notes/batch/read endpoint caches note body
    // content after a PATCH update and can return stale data for minutes.  That
    // causes Step 1's change to be invisible to getDealNotes on subsequent runs,
    // so the server returns cancelled: false even when the M1 note already says
    // "Did not renew" — which triggers another prepend, producing duplicates.
    //
    // A freshly-created note has no prior cached version and is immediately
    // readable via the v4 associations endpoint, so cancelled detection is
    // reliable on every run regardless of caching.
    if (currentDealId) {
      await createDealNote(
        currentDealId,
        "<p><strong>Did not renew</strong></p>"
      ).catch((e) => {
        console.warn("Cancel standalone note creation failed:", e.message);
        if (!noteError) noteError = e.message;
      });
    }

    // 2. Highlight the row red on the Google Sheet
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

    return NextResponse.json({ success: true, noteError, sheetError });
  } catch (error: any) {
    console.error("MSI cancel error:", error);
    return NextResponse.json(
      { error: error.message || "Failed to cancel renewal" },
      { status: 500 }
    );
  }
}
