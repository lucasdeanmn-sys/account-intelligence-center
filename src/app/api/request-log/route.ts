import { NextRequest, NextResponse } from "next/server";
import { recentRequests } from "@/lib/requestLog";

export const dynamic = "force-dynamic";

// Recent traffic from our own permanent request log (behind the auth gate,
// like every API route). ?limit=500 for more rows, capped at 1000.
export async function GET(req: NextRequest) {
  try {
    const limit = parseInt(req.nextUrl.searchParams.get("limit") ?? "200", 10);
    const rows = await recentRequests(isNaN(limit) ? 200 : limit);
    if (!process.env.POSTGRES_URL) {
      return NextResponse.json({
        rows: [],
        note: "POSTGRES_URL not set — attach Postgres in Vercel (Storage tab) to enable the request log.",
      });
    }
    return NextResponse.json({ rows });
  } catch (error: any) {
    return NextResponse.json(
      { error: error.message || "request log unavailable" },
      { status: 500 }
    );
  }
}
