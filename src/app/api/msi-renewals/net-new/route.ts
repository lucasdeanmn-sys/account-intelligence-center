import { NextResponse } from "next/server";
import { getNetNewPendingBilling } from "@/lib/hubspot";

export const maxDuration = 60;
export const dynamic = "force-dynamic";

// Net-new deals "pending billing" that aren't renewals — surfaced so they reach
// Joan (billing) without going into the Adtran renewal list. Not month-scoped.
export async function GET() {
  try {
    const { newLogos, standaloneExtensions } = await getNetNewPendingBilling();
    return NextResponse.json({ newLogos, standaloneExtensions });
  } catch (error: any) {
    console.error("net-new pending billing error:", error);
    return NextResponse.json(
      { error: error?.message || "Failed to load net-new pending billing" },
      { status: 500 }
    );
  }
}
