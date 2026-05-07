import { NextRequest, NextResponse } from "next/server";
import { MCP_BETA, MODEL } from "@/lib/anthropic";

export const maxDuration = 60;

interface CsaRecord {
  instance: string;
  expire_date: string;
  current_circuits: number;
}

function matchCompany(company: string, records: CsaRecord[]): number | null {
  if (!company) return null;
  const needle = company.toLowerCase().trim();
  // Only consider records that have a valid instance string
  const valid = records.filter((r) => typeof r.instance === "string" && r.instance.length > 0);

  // Exact match
  let hit = valid.find((r) => r.instance.toLowerCase().trim() === needle);
  if (hit) return hit.current_circuits ?? null;

  // One contains the other
  hit = valid.find(
    (r) =>
      r.instance.toLowerCase().includes(needle) ||
      needle.includes(r.instance.toLowerCase())
  );
  if (hit) return hit.current_circuits ?? null;

  // First 6 chars
  hit = valid.find((r) =>
    r.instance.toLowerCase().startsWith(needle.slice(0, 6))
  );
  return hit?.current_circuits ?? null;
}

export async function POST(req: NextRequest) {
  if (!process.env.ANTHROPIC_API_KEY) {
    return NextResponse.json({ error: "ANTHROPIC_API_KEY not configured" }, { status: 503 });
  }

  try {
    const { companies } = (await req.json()) as { companies: string[] };
    if (!companies?.length) {
      return NextResponse.json({ error: "companies array required" }, { status: 400 });
    }

    // Single API call — Anthropic calls the MCP server server-side
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "anthropic-beta": MCP_BETA,
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 8096,
        system: "Call get_snapshot once to retrieve all company data. Do not call any other tools.",
        messages: [{ role: "user", content: "Call get_snapshot." }],
        mcp_servers: [
          {
            type: "url",
            url: "https://computed-success-analysis-mcp-production.up.railway.app/sse",
            name: "csa",
            ...(process.env.CSA_API_KEY
              ? { authorization_token: process.env.CSA_API_KEY }
              : {}),
          },
        ],
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Anthropic API error ${res.status}: ${err.slice(0, 300)}`);
    }

    const data = await res.json();

    // Extract the mcp_tool_result block
    const toolResult = data.content?.find((b: any) => b.type === "mcp_tool_result");
    if (!toolResult) {
      throw new Error("No mcp_tool_result in response — get_snapshot may not have been called");
    }

    // content may be an array of blocks or a plain string
    const rawText: string = Array.isArray(toolResult.content)
      ? (toolResult.content[0]?.text ?? "")
      : String(toolResult.content ?? "");

    let parsed: any;
    try {
      parsed = JSON.parse(rawText);
    } catch {
      throw new Error(`CSA snapshot parse failed. Raw: ${rawText.slice(0, 300)}`);
    }

    // Handle wrapped responses: { data: [...] }, { results: [...] }, etc.
    const raw: CsaRecord[] = Array.isArray(parsed)
      ? parsed
      : (parsed?.data ?? parsed?.results ?? parsed?.records ?? Object.values(parsed));

    if (!Array.isArray(raw)) {
      throw new Error(`CSA snapshot not an array. Got: ${JSON.stringify(parsed).slice(0, 300)}`);
    }

    // Match each company to its circuit count
    const counts: Record<string, number | null> = {};
    for (const company of companies) {
      counts[company] = matchCompany(company, raw);
    }

    return NextResponse.json({ counts });
  } catch (error: any) {
    console.error("CSA lookup error:", error);
    return NextResponse.json(
      { error: error.message || "CSA lookup failed" },
      { status: 500 }
    );
  }
}
