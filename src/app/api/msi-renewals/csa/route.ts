import { NextRequest, NextResponse } from "next/server";

export const maxDuration = 60;

interface CsaRecord {
  instance: string;
  circuits: number;
  domain: string | null;
  renewalDate: string | null;
}

// ─── Company matching (fuzzy, fallback when ID matching can't be used) ─────────

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
  instanceId: number | null;
  instanceName: string;
  circuits: number;
  domain: string | null;
}

async function fetchSnapshot(): Promise<{ records: CsaRecord[]; instances: CsaInstance[] }> {
  const parsed = await callMcp("get_snapshot", {});

  // Snapshot returns { snapshot_date, total_returned, filters, companies: [...] }
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
      renewalDate: (r.renewal_date as string | null) ?? null,
    }));

  // Snapshot instances (instanceId resolved later via get_company for target month)
  const instances: CsaInstance[] = records.map((r) => ({
    instanceId: null,
    instanceName: r.instance,
    circuits: r.circuits,
    domain: r.domain,
  }));

  return { records, instances };
}

// ─── Build instance_id → circuits map for a target renewal month ──────────────
//
// Filters snapshot records to those whose renewal_date matches the target month
// (e.g. "2026-05"), then calls get_company for each in parallel to obtain the
// numeric instance_id.  Returns a Map<instanceId, circuits> and an updated
// CsaInstance list with instanceIds populated.

async function buildIdMap(
  records: CsaRecord[],
  renewalYearMonth: string // e.g. "2026-05"
): Promise<{ idMap: Map<number, number>; resolvedInstances: CsaInstance[] }> {
  const idMap = new Map<number, number>();

  const targets = records.filter(
    (r) => r.renewalDate?.startsWith(renewalYearMonth) ?? false
  );

  if (!targets.length) {
    return { idMap, resolvedInstances: [] };
  }

  // Call get_company for each target instance in parallel
  const results = await Promise.allSettled(
    targets.map((r) => callMcp("get_company", { name: r.instance }))
  );

  const resolvedInstances: CsaInstance[] = [];

  for (let i = 0; i < targets.length; i++) {
    const target = targets[i];
    const res = results[i];

    let instanceId: number | null = null;
    let circuits = target.circuits;

    if (res.status === "fulfilled" && res.value) {
      // get_company returns { companies: [{ instance_id, circuits, ... }] }
      const companies: any[] = res.value?.companies ?? [];
      // Pick the entry whose instance_name matches (could be multiple snapshots)
      const match =
        companies.find(
          (c: any) =>
            typeof c.instance_id === "number" &&
            (c.instance_name?.toLowerCase() === target.instance.toLowerCase() ||
              c.instance?.toLowerCase() === target.instance.toLowerCase())
        ) ?? companies[0];

      if (match?.instance_id) {
        instanceId = match.instance_id as number;
        circuits = (match.circuits as number) ?? circuits;
        idMap.set(instanceId, circuits);
      }
    }

    resolvedInstances.push({
      instanceId,
      instanceName: target.instance,
      circuits,
      domain: target.domain,
    });
  }

  return { idMap, resolvedInstances };
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
      overrides?: Record<string, CsaOverride>;       // hubspot company name → { instanceId, instanceName }
      nocInstanceIds?: Record<string, number | null>; // hubspot company name → noc_instance_id
      renewalDate?: string;                           // ISO date like "2026-05-31" for filtering
    };
    const { companies, overrides = {}, nocInstanceIds = {}, renewalDate } = body;

    if (!companies?.length) {
      return NextResponse.json({ error: "companies array required" }, { status: 400 });
    }

    // 1. Fetch snapshot
    const { records, instances: allInstances } = await fetchSnapshot();

    // 2. Build exact-name lookup for fast override resolution
    const byName = new Map<string, CsaRecord>();
    for (const r of records) {
      byName.set(r.instance.toLowerCase().trim(), r);
    }

    // 3. Build instance_id → circuits map for the target renewal month
    //    (only if renewalDate is provided and some companies have nocInstanceId)
    const hasNocIds = Object.values(nocInstanceIds).some((id) => id != null);
    let idMap = new Map<number, number>();
    let resolvedInstances: CsaInstance[] = [];

    if (renewalDate && hasNocIds) {
      const ym = renewalDate.substring(0, 7); // "2026-05"
      const built = await buildIdMap(records, ym);
      idMap = built.idMap;
      resolvedInstances = built.resolvedInstances;
    }

    // 4. Match each company
    const counts: Record<string, number | null> = {};
    for (const company of companies) {
      const override = overrides[company];
      const nocId = nocInstanceIds[company] ?? null;

      if (override?.instanceName) {
        // Explicit manual override — use exact instance name from snapshot
        const r = byName.get(override.instanceName.toLowerCase().trim());
        counts[company] = r?.circuits ?? null;
      } else if (nocId != null && idMap.has(nocId)) {
        // ID-based exact match (most reliable)
        counts[company] = idMap.get(nocId)!;
      } else {
        // Fuzzy name fallback (works for most companies, may miss edge cases)
        const r = matchCompany(company, records);
        counts[company] = r?.circuits ?? null;
      }
    }

    // 5. Build the full instance list for the picker
    //    Resolved instances (with IDs) take priority; remaining are unresolved
    const resolvedNames = new Set(resolvedInstances.map((i) => i.instanceName.toLowerCase()));
    const unresolved: CsaInstance[] = allInstances.filter(
      (i) => !resolvedNames.has(i.instanceName.toLowerCase())
    );
    const pickerInstances: CsaInstance[] = [...resolvedInstances, ...unresolved];

    return NextResponse.json({ counts, instances: pickerInstances });
  } catch (error: any) {
    console.error("CSA lookup error:", error);
    return NextResponse.json(
      { error: error.message || "CSA lookup failed" },
      { status: 500 }
    );
  }
}
