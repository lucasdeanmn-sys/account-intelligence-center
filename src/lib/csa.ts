/**
 * src/lib/csa.ts
 *
 * Shared CSA MCP client.  Called by both the standalone CSA API route
 * (POST /api/msi-renewals/csa) and the main renewals route so circuit
 * counts arrive in the initial report load — no separate fetch step needed.
 *
 * NOTE: The SSE connection uses Node's native `https` module rather than the
 * global `fetch`, because Next.js patches `global.fetch` for caching/dedup
 * and its wrapper buffers the response before resolving — which hangs
 * indefinitely on an SSE stream that never sends a terminal chunk.
 */
import * as https from "node:https";

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
  /** CSA account status (Production / Staging / Disabled). */
  status: string | null;
}

interface CsaRecord {
  instance: string;
  circuits: number;
  domain: string | null;
  renewalDate: string | null;
  /** CSA account status (Production / Staging / Disabled). */
  status: string | null;
}

// ─── MCP SSE helper ───────────────────────────────────────────────────────────

// Wraps the actual SSE call with a hard timeout so a stalled Railway connection
// never blocks the request handler indefinitely.
export async function callMcp(
  toolName: string,
  args: Record<string, unknown> = {},
  timeoutMs = 12_000
): Promise<any> {
  const timer = new Promise<never>((_, reject) => {
    const t = setTimeout(
      () => reject(new Error(`callMcp(${toolName}) timed out after ${timeoutMs}ms`)),
      timeoutMs
    );
    // Allow process to exit even if this timer is still pending
    if (typeof (t as any).unref === "function") (t as any).unref();
  });
  return Promise.race([_callMcpInner(toolName, args), timer]);
}

/**
 * Open an SSE connection to the CSA MCP server and return an async function
 * that reads the next event of a given type.
 *
 * Uses node:https directly to bypass Next.js's global.fetch patch, which
 * buffers the full response before resolving and therefore hangs indefinitely
 * on a streaming SSE response.
 */
function openSseStream(
  url: string,
  headers: Record<string, string>
): {
  nextEvent: (type: string) => Promise<string>;
  destroy: () => void;
} {
  const parsed = new URL(url);

  // Simple FIFO queue — resolved promises for already-arrived events,
  // or pending resolve/reject for callers waiting on the next event.
  type QueueEntry = { type: string; data: string };
  const arrived: QueueEntry[] = [];
  let waiter: { type: string; resolve: (s: string) => void; reject: (e: Error) => void } | null = null;
  let streamError: Error | null = null;

  function emit(type: string, data: string) {
    if (waiter && waiter.type === type) {
      const w = waiter; waiter = null;
      w.resolve(data);
    } else {
      arrived.push({ type, data });
    }
  }
  function emitError(err: Error) {
    streamError = err;
    if (waiter) { const w = waiter; waiter = null; w.reject(err); }
  }

  function nextEvent(type: string): Promise<string> {
    // If we already have this event buffered, return it immediately
    const idx = arrived.findIndex((e) => e.type === type);
    if (idx !== -1) {
      const [entry] = arrived.splice(idx, 1);
      return Promise.resolve(entry.data);
    }
    if (streamError) return Promise.reject(streamError);
    return new Promise((resolve, reject) => {
      waiter = { type, resolve, reject };
    });
  }

  // SSE parser state
  let buf = "", evType = "", evData = "";
  function processChunk(chunk: string) {
    buf += chunk;
    while (true) {
      const nl = buf.indexOf("\n");
      if (nl === -1) break;
      const line = buf.slice(0, nl).replace(/\r$/, "");
      buf = buf.slice(nl + 1);
      if (line === "") {
        if (evType && evData) emit(evType, evData);
        evType = ""; evData = "";
      } else if (line.startsWith("event:")) {
        evType = line.slice(6).trim();
      } else if (line.startsWith("data:")) {
        evData += (evData ? "\n" : "") + line.slice(5).trim();
      }
    }
  }

  const req = https.request(
    {
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      method: "GET",
      headers: { Accept: "text/event-stream", "Cache-Control": "no-cache", ...headers },
    },
    (res) => {
      if ((res.statusCode ?? 0) >= 400) {
        emitError(new Error(`CSA SSE connect failed: ${res.statusCode}`));
        res.resume();
        return;
      }
      res.setEncoding("utf8");
      res.on("data", processChunk);
      res.on("end", () => emitError(new Error("CSA SSE stream ended unexpectedly")));
      res.on("error", emitError);
    }
  );
  req.on("error", emitError);
  req.end();

  return { nextEvent, destroy: () => req.destroy() };
}

async function _callMcpInner(
  toolName: string,
  args: Record<string, unknown>
): Promise<any> {
  const apiKey = process.env.CSA_API_KEY;
  const authHeaders: Record<string, string> = apiKey
    ? { Authorization: `Bearer ${apiKey}` }
    : {};

  const { nextEvent, destroy } = openSseStream(CSA_SSE_URL, authHeaders);

  try {
    const messagesPath = await nextEvent("endpoint");
    const messagesUrl = messagesPath.startsWith("http")
      ? messagesPath
      : `${CSA_BASE}${messagesPath}`;

    // POST the JSON-RPC request.  fetch is fine here — it's a short-lived POST
    // that returns immediately with status 202; the result comes back on the
    // SSE stream, not as the POST response body.
    const postRes = await fetch(messagesUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders },
      signal: AbortSignal.timeout(10_000),
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

    const rpc = JSON.parse(rawMsg);
    if (rpc.error) throw new Error(`CSA RPC error: ${JSON.stringify(rpc.error)}`);

    const content = rpc?.result?.content;
    const text: string = Array.isArray(content)
      ? (content[0]?.text ?? "")
      : String(rpc?.result ?? "");
    return JSON.parse(text);
  } finally {
    destroy();
  }
}

// ─── Snapshot fetch ───────────────────────────────────────────────────────────

async function fetchSnapshot(): Promise<{ records: CsaRecord[]; allInstances: CsaInstance[] }> {
  // get_snapshot returns all companies — it's a large payload; allow up to 30s.
  // status_filter "All": the server defaults to Production only, which made
  // Staging renewals (e.g. Country Wireless, Clarksville) invisible to the
  // CSA-authoritative matching and reliant on the HubSpot date-pool mop-up.
  const parsed = await callMcp("get_snapshot", { status_filter: "All" }, 30_000);

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
      status: (r.status as string | null) ?? null,
    }));

  const allInstances: CsaInstance[] = records.map((r) => ({
    instanceId: null,
    instanceName: r.instance,
    circuits: r.circuits,
    domain: r.domain,
    status: r.status,
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
  /** Instance IDs that have more than one CSA record (e.g. a sub-tenant).
   *  Used to surface a "Multi-tenant" warning tag in the UI. */
  multiTenantIds: Set<number>;
}

export async function fetchCsaForMonth(expirationDate: string): Promise<CsaMonthData> {
  const { records, allInstances } = await fetchSnapshot();

  const ym = expirationDate.substring(0, 7); // "2026-05"
  const targets = records.filter(
    (r) => typeof r.renewalDate === "string" && r.renewalDate.startsWith(ym)
  );

  const idMap = new Map<number, number>();
  const multiTenantIds = new Set<number>();

  if (!targets.length) {
    return { idMap, records, instances: [], allInstances, multiTenantIds };
  }

  // Fire all get_company calls in a single parallel batch — each has its own
  // 12-second timeout so a stalled connection doesn't block the others.
  // The Railway server can be cold-started; a single retry on failure covers
  // the warm-up window without blocking the whole request.
  const callWithRetry = async (name: string) => {
    try {
      return await callMcp("get_company", { name }, 12_000);
    } catch {
      // Single retry with a longer timeout in case the server was waking up
      return await callMcp("get_company", { name }, 20_000);
    }
  };
  const results = await Promise.allSettled(
    targets.map((r) => callWithRetry(r.instance))
  );

  const resolvedInstances: CsaInstance[] = [];

  for (let j = 0; j < targets.length; j++) {
    const target = targets[j];
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
        // Use target.circuits (from the snapshot) rather than match.circuits (from
        // get_company). The snapshot already has correct per-company circuit counts
        // when multiple companies share an instance_id (e.g. Great Plains + GPC East).
        // get_company may return the same "first match" record for different snapshot
        // targets that share an instance name, giving a wrong/doubled count.
        // circuits stays as target.circuits (set at the top of this iteration).
        //
        // Accumulate: sum circuits across all snapshot records sharing the same
        // instance_id so the total reflects all companies on that MSI instance.
        if (idMap.has(instanceId)) multiTenantIds.add(instanceId);
        idMap.set(instanceId, (idMap.get(instanceId) ?? 0) + circuits);
      }
    }

    resolvedInstances.push({
      instanceId,
      instanceName: target.instance,
      circuits,
      domain: target.domain,
      status: target.status,
    });
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
    multiTenantIds,
  };
}
