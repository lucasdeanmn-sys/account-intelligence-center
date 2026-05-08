import { NextRequest, NextResponse } from "next/server";

export const maxDuration = 60;

interface CsaRecord {
  instance: string;
  circuits: number;
  domain: string | null;
}

// ─── Company matching (fuzzy, used when no override is set) ───────────────────

function matchCompany(company: string, records: CsaRecord[]): CsaRecord | null {
  if (!company) return null;
  const needle = company.toLowerCase().trim();
  const valid = records.filter((r) => typeof r.instance === "string" && r.instance.length > 0);

  // Exact
  let hit = valid.find((r) => r.instance.toLowerCase().trim() === needle);
  if (hit) return hit;

  // One contains the other
  hit = valid.find(
    (r) =>
      r.instance.toLowerCase().includes(needle) ||
      needle.includes(r.instance.toLowerCase())
  );
  if (hit) return hit;

  // First 6 chars
  hit = valid.find((r) => r.instance.toLowerCase().startsWith(needle.slice(0, 6)));
  return hit ?? null;
}

// ─── MCP SSE helpers ──────────────────────────────────────────────────────────

const CSA_SSE_URL =
  "https://computed-success-analysis-mcp-production.up.railway.app/sse";
const CSA_BASE =
  "https://computed-success-analysis-mcp-production.up.railway.app";

async function callMcp(toolName: string, args: Record<string, unknown> = {}): Promise<any> {
  const apiKey = process.env.CSA_API_KEY;
  const authHeaders: Record<string, string> = apiKey
    ? { Authorization: `Bearer ${apiKey}` }
    : {};

  const sseRes = await fetch(CSA_SSE_URL, {
    headers: { Accept: "text/event-stream", "Cache-Control": "no-cache", ...authHeaders },
  });
  if (!sseRes.ok || !sseRes.body) {
    throw new Error(`CSA SSE connect failed: ${sseRes.status}`);
  }

  const reader = sseRes.body.getReader();
  const decoder = new TextDecoder();
  let buf = "", evType = "", evData = "";

  async function nextEvent(targetType: string): Promise<string> {
    while (true) {
      while (true) {
        const nl = buf.indexOf("\n");
        if (nl === -1) break;
        const line = buf.slice(0, nl).replace(/\r$/, "");
        buf = buf.slice(nl + 1);
        if (line === "") {
          if (evType === targetType && evData) {
            const payload = evData; evType = ""; evData = ""; return payload;
          }
          evType = ""; evData = "";
        } else if (line.startsWith("event:")) {
          evType = line.slice(6).trim();
        } else if (line.startsWith("data:")) {
          evData += (evData ? "\n" : "") + line.slice(5).trim();
        }
      }
      const { done, value } = await reader.read();
      if (done) throw new Error(`CSA SSE stream ended before '${targetType}' event`);
      buf += decoder.decode(value, { stream: true });
    }
  }

  const messagesPath = await nextEvent("endpoint");
  const messagesUrl = messagesPath.startsWith("http")
    ? messagesPath
    : `${CSA_BASE}${messagesPath}`;

  const postRes = await fetch(messagesUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders },
    body: JSON.stringify({ jsonrpc: "2.0", id: "1", method: "tools/call", params: { name: toolName, arguments: args } }),
  });
  if (!postRes.ok) {
    throw new Error(`CSA RPC POST ${postRes.status}: ${(await postRes.text().catch(() => "")).slice(0, 200)}`);
  }

  const rawMsg = await nextEvent("message");
  reader.cancel().catch(() => {});

  const rpc = JSON.parse(rawMsg);
  if (rpc.error) throw new Error(`CSA RPC error: ${JSON.stringify(rpc.error)}`);

  const content = rpc?.result?.content;
  const text: string = Array.isArray(content)
    ? (content[0]?.text ?? "")
    : String(rpc?.result ?? "");
  return JSON.parse(text);
}

// ─── Snapshot fetch ───────────────────────────────────────────────────────────

export interface CsaInstance {
  instanceId: number | null;   // null when not returned by snapshot
  instanceName: string;
  circuits: number;
  domain: string | null;
}

async function fetchSnapshot(): Promise<{ records: CsaRecord[]; instances: CsaInstance[] }> {
  const parsed = await callMcp("get_snapshot", {});

  const raw: any[] = Array.isArray(parsed)
    ? parsed
    : (parsed?.companies ?? parsed?.data ?? parsed?.results ?? parsed?.records ?? Object.values(parsed));

  if (!Array.isArray(raw)) {
    throw new Error(`CSA snapshot not an array. Got: ${JSON.stringify(parsed).slice(0, 300)}`);
  }

  const records: CsaRecord[] = raw
    .filter((r) => typeof r.instance === "string" && r.instance.length > 0)
    .map((r) => ({
      instance: r.instance as string,
      circuits: (r.circuits as number) ?? 0,
      domain: (r.domain as string | null) ?? null,
    }));

  // Build the picker list — snapshot doesn't include instance_id so it's null here.
  // instance_id is resolved on the client via the stored override mapping.
  const instances: CsaInstance[] = records.map((r) => ({
    instanceId: null,
    instanceName: r.instance,
    circuits: r.circuits,
    domain: r.domain,
  }));

  return { records, instances };
}

// ─── POST /api/msi-renewals/csa ───────────────────────────────────────────────

interface CsaOverride {
  instanceId: number;
  instanceName: string;
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as {
      companies: string[];
      overrides?: Record<string, CsaOverride>; // hubspot company name → { instanceId, instanceName }
    };
    const { companies, overrides = {} } = body;

    if (!companies?.length) {
      return NextResponse.json({ error: "companies array required" }, { status: 400 });
    }

    const { records, instances } = await fetchSnapshot();

    // Build exact-name lookup for fast override resolution
    const byName = new Map<string, CsaRecord>();
    for (const r of records) {
      byName.set(r.instance.toLowerCase().trim(), r);
    }

    const counts: Record<string, number | null> = {};
    for (const company of companies) {
      const override = overrides[company];
      if (override?.instanceName) {
        // Exact match via stored override instance name
        const r = byName.get(override.instanceName.toLowerCase().trim());
        counts[company] = r?.circuits ?? null;
      } else {
        // Fuzzy match
        const r = matchCompany(company, records);
        counts[company] = r?.circuits ?? null;
      }
    }

    return NextResponse.json({ counts, instances });
  } catch (error: any) {
    console.error("CSA lookup error:", error);
    return NextResponse.json(
      { error: error.message || "CSA lookup failed" },
      { status: 500 }
    );
  }
}
