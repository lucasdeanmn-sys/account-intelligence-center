import { NextRequest, NextResponse } from "next/server";
import { updateNoteBody } from "@/lib/hubspot";
import { cancelRenewalRow } from "@/lib/sheets";
import { googleConfigured } from "@/lib/google";

export const maxDuration = 30;

export async function POST(req: NextRequest) {
  try {
    const { m1NoteId, m1NoteHtml, company, expirationDate, csaInstanceName } =
      await req.json();

    let noteError: string | null = null;
    let sheetError: string | null = null;

    // 1. Prepend "Did not renew" to the top of the M1 note in HubSpot
    if (m1NoteId && m1NoteHtml != null) {
      const prepended =
        `<p><strong>Did not renew</strong></p>\n` + m1NoteHtml;
      await updateNoteBody(m1NoteId, prepended).catch((e) => {
        console.warn("Cancel note update failed:", e.message);
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
