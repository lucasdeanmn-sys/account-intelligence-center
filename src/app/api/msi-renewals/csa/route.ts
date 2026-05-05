import { NextRequest, NextResponse } from "next/server";
import { runAgentLoop, csaServer, configured, extractJSON } from "@/lib/anthropic";

export const maxDuration = 60;

// get_snapshot returns all companies at once — one tool call, then we filter.
// Each record has: instance, expire_date, current_circuits
const CSA_SYSTEM = `You have access to CSA tools.

Call get_snapshot ONCE to retrieve all company data. Do not call it multiple times.

From the snapshot results, find each company in the provided list by matching against
the "instance" field (fuzzy/partial match is fine). Extract the "current_circuits" value
for each match.

Return ONLY a valid JSON object mapping each input company name to its current_circuits
value (use null if not found):
{"Company Name": 12345, "Another Co": null}

Return the JSON only — no explanation, no markdown.`;

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
      `Find current_circuits for each of these companies using get_snapshot:\n${JSON.stringify(companies)}`,
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
