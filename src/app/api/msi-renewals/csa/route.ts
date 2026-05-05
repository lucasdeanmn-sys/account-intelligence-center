import { NextRequest, NextResponse } from "next/server";
import { runAgentLoop, csaServer, configured, extractJSON } from "@/lib/anthropic";

export const maxDuration = 60;

const CSA_SYSTEM = `You have access to CSA tools. For each company name provided, query CSA to get the current circuit/subscriber count.
Return ONLY valid JSON mapping company names to counts (use null if not found):
{"Company Name": 12345, "Another Co": null}`;

export async function POST(req: NextRequest) {
  const csaServers = configured(csaServer());
  if (!csaServers.length) {
    return NextResponse.json({ error: "CSA not configured" }, { status: 503 });
  }

  try {
    const { companies } = await req.json() as { companies: string[] };
    if (!companies?.length) {
      return NextResponse.json({ error: "companies array required" }, { status: 400 });
    }

    const result = await runAgentLoop(
      CSA_SYSTEM,
      `Get current circuit counts for these companies:\n${JSON.stringify(companies)}`,
      csaServers,
      4096
    );

    const counts = extractJSON<Record<string, number | null>>(result);
    return NextResponse.json({ counts });
  } catch (error: any) {
    console.error("CSA lookup error:", error);
    return NextResponse.json({ error: error.message || "CSA lookup failed" }, { status: 500 });
  }
}
