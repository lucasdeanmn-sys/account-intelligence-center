import { NextRequest, NextResponse } from "next/server";

export const maxDuration = 60;

interface CsaRecord {
  instance: string;
  circuits: number;  // field name in actual snapshot payload
}

function matchCompany(company: string, records: CsaRecord[]): number | null {
  if (!company) return null;
  const needle = company.toLowerCase().trim();
  // Only consider records that have a valid instance string
  const valid = records.filter((r) => typeof r.instance === "string" && r.instance.length > 0);

  // Exact match
  let hit = valid.find((r) => r.instance.toLowerCase().trim() === needle);
  if (hit) return hit.circuits ?? null;

  // One contains the other
  hit = valid.find(
    (r) =>
      r.instance.toLowerCase().includes(needle) ||
      needle.includes(r.instance.toLowerCase())
  );
  if (hit) return hit.circuits ?? null;

  // First 6 chars
  hit = valid.find((r) =>
    r.instance.toLowerCase().startsWith(needle.slice(0, 6))
  );
  return hit?.circuits ?? null;
}

const CSA_SSE_URL =
  "https://computed-success-analysis-mcp-production.up.railway.app/sse";
const CSA_BASE =
  "https://computed-success-analysis-mcp-production.up.railway.app";

/**
 * Call get_snapshot directly over the MCP SSE protocol — no Anthropic API.
 *
 * Protocol:
 *  1. GET /sse  →  server sends:  event: endpoint\ndata: /messages?sessionId=…
 *  2. POST that messages URL with a JSON-RPC tools/call request
 *  3. Server replies on the same SSE stream:  event: message\ndata: {result: …}
 */
async function callGetSnapshot(): Promise<CsaRecord[]> {
  const apiKey = process.env.CSA_API_KEY;
  const authHeaders: Record<string, string> = apiKey
    ? { Authorization: `Bearer ${apiKey}` }
    : {};

  // ── 1. Open SSE connection ────────────────────────────────────────────────
  const sseRes = await fetch(CSA_SSE_URL, {
    headers: {
      Accept: "text/event-stream",
      "Cache-Control": "no-cache",
      ...authHeaders,
    },
  });

  if (!sseRes.ok || !sseRes.body) {
    throw new Error(`CSA SSE connect failed: ${sseRes.status}`);
  }

  const reader = sseRes.body.getReader();
  const decoder = new TextDecoder();

  // Shared SSE parse state — persists across nextEvent() calls
  let buf = "";
  let evType = "";
  let evData = "";

  /**
   * Read the SSE stream until an event of `targetType` arrives.
   * Returns the accumulated data payload for that event.
   */
  async function nextEvent(targetType: string): Promise<string> {
    while (true) {
      // Drain any lines already in the buffer before fetching more bytes
      while (true) {
        const nl = buf.indexOf("\n");
        if (nl === -1) break;

        const line = buf.slice(0, nl).replace(/\r$/, "");
        buf = buf.slice(nl + 1);

        if (line === "") {
          // Blank line → dispatch the current event
          if (evType === targetType && evData) {
            const payload = evData;
            evType = "";
            evData = "";
            return payload;
          }
          evType = "";
          evData = "";
        } else if (line.startsWith("event:")) {
          evType = line.slice(6).trim();
        } else if (line.startsWith("data:")) {
          evData += (evData ? "\n" : "") + line.slice(5).trim();
        }
        // id: / retry: lines are ignored
      }

      // Need more bytes from the stream
      const { done, value } = await reader.read();
      if (done) throw new Error(`CSA SSE stream ended before '${targetType}' event`);
      buf += decoder.decode(value, { stream: true });
    }
  }

  // ── 2. Wait for the messages endpoint URL ─────────────────────────────────
  const messagesPath = await nextEvent("endpoint");
  const messagesUrl = messagesPath.startsWith("http")
    ? messagesPath
    : `${CSA_BASE}${messagesPath}`;

  // ── 3. Fire the JSON-RPC tools/call request ───────────────────────────────
  const postRes = await fetch(messagesUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...authHeaders,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "1",
      method: "tools/call",
      params: { name: "get_snapshot", arguments: {} },
    }),
  });

  if (!postRes.ok) {
    const errText = await postRes.text().catch(() => "");
    throw new Error(`CSA RPC POST ${postRes.status}: ${errText.slice(0, 200)}`);
  }

  // ── 4. Wait for the tool result on the SSE stream ─────────────────────────
  const rawMsg = await nextEvent("message");
  reader.cancel().catch(() => {});

  let rpc: any;
  try {
    rpc = JSON.parse(rawMsg);
  } catch {
    throw new Error(`CSA SSE invalid JSON in message event: ${rawMsg.slice(0, 200)}`);
  }

  if (rpc.error) {
    throw new Error(`CSA RPC error: ${JSON.stringify(rpc.error)}`);
  }

  // Extract text from MCP result content
  const content = rpc?.result?.content;
  const rawText: string = Array.isArray(content)
    ? (content[0]?.text ?? "")
    : String(rpc?.result ?? "");

  let parsed: any;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    throw new Error(`CSA snapshot parse failed. Raw: ${rawText.slice(0, 300)}`);
  }

  // Handle wrapped responses: { companies: [...] }, { data: [...] }, { results: [...] }, etc.
  const raw: CsaRecord[] = Array.isArray(parsed)
    ? parsed
    : (parsed?.companies ?? parsed?.data ?? parsed?.results ?? parsed?.records ?? Object.values(parsed));

  if (!Array.isArray(raw)) {
    throw new Error(`CSA snapshot not an array. Got: ${JSON.stringify(parsed).slice(0, 300)}`);
  }

  return raw;
}

export async function POST(req: NextRequest) {
  try {
    const { companies } = (await req.json()) as { companies: string[] };
    if (!companies?.length) {
      return NextResponse.json({ error: "companies array required" }, { status: 400 });
    }

    const raw = await callGetSnapshot();

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
