/**
 * src/lib/csa.ts
 *
 * Shared CSA MCP client.  Called by both the standalone CSA API route
 * (POST /api/msi-renewals/csa) and the main renewals route so circuit
 * counts arrive in the initial report load — no separate fetch step needed.
 */

const CSA_SSE_URL =
  "https://computed-success-analysis-mcp-production.up.railway.app/sse";
const CSA_BASE =
  "https://computed-success-analysis-mcp-production.up.railway.app";

// ─── Shared types ─────────────────────────────────────────────────────────────

export interface CsaInstance {
  instanceId: number | null;
  instanceName: string;
  circuits: number;
  domain: string | null;
}

interface CsaRecord {
  instance: string;
  circuits: number;
  domain: string | null;
  renewalDate: string | null;
}

// ─── MCP SSE helper ───────────────────────────────────────────────────────────

export async function callMcp(
  toolName: string,
  args: Record<string, unknown> = {}
): Promise<any> {
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
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "1",
      method: "tools/call",
      params: { name: toolName, arguments: args },
    }),
  });
  if (!postRes.ok) {
    throw new Error(
      `CSA RPC POST ${postRes.status}: ${(await postRes.text().catch(() => "")).slice(0, 200)}`
    );
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

async function fetchSnapshot(): Promise<{ records: CsaRecord[]; allInstances: CsaInstance[] }> {
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

  const allInstances: CsaInstance[] = records.map((r) => ({
    instanceId: null,
    instanceName: r.instance,
    circuits: r.circuits,
    domain: r.domain,
  }));

  return { records, allInstances };
}

// ─── Fuzzy company matching (fallback when ID matching is unavailable) ────────

export function matchCompany(
  company: string,
  records: { instance: string; circuits: number; domain: string | null }[]
): { instance: string; circuits: number; domain: string | null } | null {
  if (!company) return null;
  const needle = company.toLowerCase().trim();
  const valid = records.filter((r) => typeof r.instance === "string" && r.instance.length > 0);

  let hit = valid.find((r) => r.instance.toLowerCase().trim() === needle);
  if (hit) return hit;

  hit = valid.find(
    (r) =>
      r.instance.toLowerCase().includes(needle) ||
      needle.includes(r.instance.toLowerCase())
  );
  if (hit) return hit;

  hit = valid.find((r) => r.instance.toLowerCase().startsWith(needle.slice(0, 6)));
  return hit ?? null;
}

// ─── High-level: fetch CSA data for a given renewal month ────────────────────
//
// expirationDate: ISO date string like "2026-05-31"
//
// Returns:
//   idMap        — instance_id → circuits  (for ID-based deal matching)
//   records      — all snapshot records    (for fuzzy-match fallback)
//   instances    — target-month instances with instanceId populated
//   allInstances — every snapshot instance (for the UI picker)

export interface CsaMonthData {
  idMap: Map<number, number>;
  records: CsaRecord[];
  instances: CsaInstance[];    // target-month instances (IDs resolved)
  allInstances: CsaInstance[]; // all instances (for picker / override UI)
}

export async function fetchCsaForMonth(expirationDate: string): Promise<CsaMonthData> {
  const { records, allInstances } = await fetchSnapshot();

  const ym = expirationDate.substring(0, 7); // "2026-05"
  const targets = records.filter(
    (r) => typeof r.renewalDate === "string" && r.renewalDate.startsWith(ym)
  );

  const idMap = new Map<number, number>();

  if (!targets.length) {
    return { idMap, records, instances: [], allInstances };
  }

  // Call get_company for each target instance — cap at 10 parallel at a time
  // to avoid overwhelming the MCP server with simultaneous SSE connections.
  const BATCH = 10;
  const resolvedInstances: CsaInstance[] = [];

  for (let i = 0; i < targets.length; i += BATCH) {
    const batch = targets.slice(i, i + BATCH);
    const results = await Promise.allSettled(
      batch.map((r) => callMcp("get_company", { name: r.instance }))
    );

    for (let j = 0; j < batch.length; j++) {
      const target = batch[j];
      const res = results[j];
      let instanceId: number | null = null;
      let circuits = target.circuits;

      if (res.status === "fulfilled" && res.value) {
        // get_company returns { companies: [{ instance_id, instance_name, circuits, ... }] }
        const companies: any[] = res.value?.companies ?? [];
        const match =
          companies.find(
            (c: any) =>
              typeof c.instance_id === "number" &&
              (
                (c.instance_name ?? "").toLowerCase() === target.instance.toLowerCase() ||
                (c.instance ?? "").toLowerCase() === target.instance.toLowerCase()
              )
          ) ?? companies[0];

        if (match?.instance_id != null) {
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
  }

  // Merge: resolved instances first, then the rest (unresolved) for the full picker list
  const resolvedNames = new Set(resolvedInstances.map((i) => i.instanceName.toLowerCase()));
  const unresolvedInstances = allInstances.filter(
    (i) => !resolvedNames.has(i.instanceName.toLowerCase())
  );

  return {
    idMap,
    records,
    instances: resolvedInstances,
    allInstances: [...resolvedInstances, ...unresolvedInstances],
  };
}
