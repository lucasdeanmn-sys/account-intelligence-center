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

    // 1. Stamp "Did not renew" onto the deal in HubSpot so the server-side
    //    cancelled detection (rawNotes.some("Did not renew")) works on every
    //    subsequent report run — no reliance on localStorage.
    //
    //    Case A: deal has an M1 note → prepend the marker to that note.
    //    Case B: no M1 note (e.g. auto-renew like Vexus) → create a new note.
    //    Guard against duplicates in both cases.
    if (m1NoteId && m1NoteHtml != null && !m1NoteHtml.includes("Did not renew")) {
      // Case A: update existing M1 note
      const prepended =
        `<p><strong>Did not renew</strong></p>\n` + m1NoteHtml;
      await updateNoteBody(m1NoteId, prepended).catch((e) => {
        console.warn("Cancel note update failed:", e.message);
        noteError = e.message;
      });
    } else if (!m1NoteId && currentDealId) {
      // Case B: no M1 note — create a standalone cancellation note so the
      //         server can detect "Did not renew" on re-run without localStorage.
      await createDealNote(
        currentDealId,
        "<p><strong>Did not renew</strong></p>"
      ).catch((e) => {
        console.warn("Cancel note creation failed:", e.message);
        noteError = e.message;
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
