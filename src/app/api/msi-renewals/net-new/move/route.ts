import { NextRequest, NextResponse } from "next/server";
import {
  moveDealToReadyForBilling,
  getDealCompanyId,
  getCompanyM1Note,
  updateNoteBody,
} from "@/lib/hubspot";
import { italicizeYearInNote } from "@/lib/m1Note";

export const maxDuration = 30;
export const dynamic = "force-dynamic";

// Advance a single net-new / standalone-extension deal from Pending Billing to
// the Ready-for-Billing stage of its pipeline. Driven by the msi-tracker
// "Move to Ready for Billing" button. Term-start gating lives in the UI (only a
// deal whose term starts by next month gets the button).
//
// Moving a new logo to Ready for Billing also marks it billed on the M1 note:
// italicize "MSI Year 1" (a new logo's first term is Year 1), matching the
// invoiced-year convention renewals use. Best-effort and idempotent — a missing
// note or no Year-1 line is a no-op and never fails the move.
export async function POST(req: NextRequest) {
  try {
    const { dealId, pipeline, year } = (await req.json()) as {
      dealId?: string;
      pipeline?: string;
      year?: number;
    };
    if (!dealId || !pipeline) {
      return NextResponse.json(
        { error: "dealId and pipeline are required" },
        { status: 400 }
      );
    }
    const result = await moveDealToReadyForBilling(dealId, pipeline);

    // Italicize the deal's year on the company M1 note (new logo = Year 1).
    let italicized: "updated" | "skipped" | "error" = "skipped";
    try {
      const companyId = await getDealCompanyId(dealId);
      if (companyId) {
        const note = await getCompanyM1Note(companyId);
        if (note) {
          const updated = italicizeYearInNote(note.html, year ?? 1);
          if (updated !== note.html) {
            await updateNoteBody(note.id, updated);
            italicized = "updated";
          }
        }
      }
    } catch (e: any) {
      console.warn("net-new move: italicize M1 note failed (non-fatal):", e?.message);
      italicized = "error";
    }

    return NextResponse.json({ success: true, italicized, ...result });
  } catch (error: any) {
    console.error("net-new move-to-ready error:", error);
    return NextResponse.json(
      { error: error?.message || "Failed to move deal to Ready for Billing" },
      { status: 500 }
    );
  }
}
