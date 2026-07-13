// app/api/targets/[id]/context/route.ts
// GET /api/targets/:id/context -> account history for the expanded target row:
// deal history, recent notes, Fathom call mentions, last inbound email.

import { NextResponse } from "next/server";
import { getTargetContext } from "@/lib/targets/context";

export const maxDuration = 30;
export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  // ?signals=0 -> deals + notes only (fast). The panel renders that first,
  // then re-fetches with signals for call mentions + email recency, which can
  // take ~15s when the Fathom corpus cache is cold.
  const includeSignals = new URL(request.url).searchParams.get("signals") !== "0";
  try {
    const context = await getTargetContext(id, { includeSignals });
    return NextResponse.json(context);
  } catch (err: any) {
    console.error("Target context error:", err);
    return NextResponse.json(
      { error: err.message || "Failed to load account context" },
      { status: 500 }
    );
  }
}
