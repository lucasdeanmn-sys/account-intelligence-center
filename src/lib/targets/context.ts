// lib/targets/context.ts
// Account-history context for a single target company: deal history with
// human-readable pipeline/stage labels, recent company notes, Fathom call
// mentions, and days since the last inbound email. Feeds the /targets
// expanded panel, the outreach-task body, and the AI outreach draft.
//
// Everything is best-effort: a failing source degrades to empty rather than
// breaking the panel.

import { matchKey } from "@/lib/signals/fathom";
import { getAccessToken, latestInboundDays } from "@/lib/signals/gmail";
import { SCORING_CONFIG as C, HUBSPOT_PROPS as P } from "@/lib/scoring/config";

const BASE = "https://api.hubapi.com";

function hsHeaders() {
  return {
    Authorization: `Bearer ${process.env.HUBSPOT_ACCESS_TOKEN}`,
    "Content-Type": "application/json",
  };
}

async function hs(path: string, init?: RequestInit): Promise<any> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { ...hsHeaders(), ...(init?.headers ?? {}) },
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`HubSpot ${res.status} on ${path}: ${await res.text()}`);
  return res.json();
}

export interface ContextDeal {
  id: string;
  name: string;
  pipeline: string | null;
  stage: string | null;
  amount: number | null;
  closeDate: string | null;
  isOpen: boolean;
  isClosedLost: boolean;
  lastActivity: string | null;
}

export interface ContextNote {
  date: string | null;
  text: string;
}

export interface ContextMention {
  title: string;
  date: string | null;
  excerpt: string | null;
}

export interface TargetContext {
  company: { id: string; name: string; domain: string | null; state: string | null };
  reasons: string[]; // score breakdown labels with points
  deals: ContextDeal[];
  notes: ContextNote[];
  fathomMentions: ContextMention[];
  lastInboundEmailDays: number | null;
}

function stripHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

// Pipeline/stage IDs → labels, one call for both maps.
async function fetchStageLabels(): Promise<{
  pipelines: Map<string, string>;
  stages: Map<string, string>;
}> {
  const pipelines = new Map<string, string>();
  const stages = new Map<string, string>();
  const data = await hs(`/crm/v3/pipelines/deals`).catch(() => ({ results: [] }));
  for (const p of data.results ?? []) {
    pipelines.set(String(p.id), p.label ?? String(p.id));
    for (const s of p.stages ?? []) {
      stages.set(String(s.id), s.label ?? String(s.id));
    }
  }
  return { pipelines, stages };
}

async function fetchDeals(companyId: string): Promise<ContextDeal[]> {
  const assoc = await hs(
    `/crm/v4/objects/companies/${companyId}/associations/deals`
  ).catch(() => ({ results: [] }));
  const dealIds: string[] = (assoc.results ?? [])
    .map((r: any) => String(r.toObjectId))
    .slice(0, 100);
  if (!dealIds.length) return [];

  const [batch, labels] = await Promise.all([
    hs(`/crm/v3/objects/deals/batch/read`, {
      method: "POST",
      body: JSON.stringify({
        inputs: dealIds.map((id) => ({ id })),
        properties: [
          "dealname", "pipeline", "dealstage", "amount", "closedate",
          "hs_is_closed", "hs_is_closed_lost", "notes_last_updated",
        ],
      }),
    }).catch(() => ({ results: [] })),
    fetchStageLabels(),
  ]);

  const deals: ContextDeal[] = (batch.results ?? []).map((d: any) => {
    const p = d.properties ?? {};
    return {
      id: String(d.id),
      name: p.dealname ?? "(unnamed deal)",
      pipeline: labels.pipelines.get(String(p.pipeline)) ?? p.pipeline ?? null,
      stage: labels.stages.get(String(p.dealstage)) ?? p.dealstage ?? null,
      amount: p.amount ? Number(p.amount) : null,
      closeDate: p.closedate ? String(p.closedate).slice(0, 10) : null,
      isOpen: p.hs_is_closed !== "true",
      isClosedLost: p.hs_is_closed_lost === "true",
      lastActivity: p.notes_last_updated ? String(p.notes_last_updated).slice(0, 10) : null,
    };
  });

  // Most recent first: open deals by last activity, closed by close date.
  deals.sort((a, b) =>
    (b.closeDate ?? b.lastActivity ?? "").localeCompare(a.closeDate ?? a.lastActivity ?? "")
  );
  return deals;
}

async function fetchNotes(companyId: string): Promise<ContextNote[]> {
  const assoc = await hs(
    `/crm/v4/objects/companies/${companyId}/associations/notes`
  ).catch(() => ({ results: [] }));
  const noteIds: string[] = (assoc.results ?? [])
    .map((r: any) => String(r.toObjectId))
    .slice(0, 100);
  if (!noteIds.length) return [];

  const batch = await hs(`/crm/v3/objects/notes/batch/read`, {
    method: "POST",
    body: JSON.stringify({
      inputs: noteIds.map((id) => ({ id })),
      properties: ["hs_note_body", "hs_timestamp"],
    }),
  }).catch(() => ({ results: [] }));

  const notes: ContextNote[] = (batch.results ?? [])
    .map((n: any) => ({
      date: n.properties?.hs_timestamp ? String(n.properties.hs_timestamp).slice(0, 10) : null,
      text: stripHtml(n.properties?.hs_note_body ?? ""),
    }))
    .filter((n: ContextNote) => n.text.length > 0);

  notes.sort((a, b) => (b.date ?? "").localeCompare(a.date ?? ""));
  return notes.slice(0, 5).map((n) => ({
    ...n,
    text: n.text.length > 240 ? n.text.slice(0, 240) + "…" : n.text,
  }));
}

// Recent Fathom meetings that mention the company (title + summary match, same
// corpus the scoring signal scans), with a short excerpt around the mention.
//
// The External API rate-limits aggressively (429 after ~10 pages), so pages
// are retried with backoff and the whole corpus is cached in-module for a few
// minutes — expanding several target rows costs one scan, not one per row.
interface FathomDoc {
  title: string;
  date: string | null;
  summary: string;
  haystack: string; // lowercased title + summary
}

let fathomCorpus: { fetchedAt: number; complete: boolean; docs: FathomDoc[] } | null = null;
const FATHOM_TTL_COMPLETE_MS = 10 * 60_000;
const FATHOM_TTL_PARTIAL_MS = 60_000; // retry sooner if a scan got cut off

async function fetchFathomCorpus(): Promise<FathomDoc[]> {
  const apiKey = process.env.FATHOM_API_KEY;
  if (!apiKey) return [];

  if (fathomCorpus) {
    const ttl = fathomCorpus.complete ? FATHOM_TTL_COMPLETE_MS : FATHOM_TTL_PARTIAL_MS;
    if (Date.now() - fathomCorpus.fetchedAt < ttl) return fathomCorpus.docs;
  }

  const since = new Date(
    Date.now() - C.signals.fathomLookbackDays * 86_400_000
  ).toISOString();

  const docs: FathomDoc[] = [];
  let cursor: string | undefined;
  let pages = 0;
  let complete = true;

  do {
    const params = new URLSearchParams({ created_after: since });
    params.set("include_summary", "true");
    if (cursor) params.set("cursor", cursor);

    let res: Response | null = null;
    for (let attempt = 0; attempt < 4; attempt++) {
      res = await fetch(`https://api.fathom.ai/external/v1/meetings?${params}`, {
        headers: { "X-Api-Key": apiKey },
      }).catch(() => null);
      if (res?.status !== 429) break;
      await new Promise((r) => setTimeout(r, 1200 * (attempt + 1)));
    }
    if (!res || !res.ok) {
      complete = false; // rate-limited out — cache what we have, briefly
      break;
    }
    const data = await res.json();

    for (const m of data.items ?? data.meetings ?? []) {
      const title = m.title ?? m.meeting_title ?? "(untitled meeting)";
      const summary: string =
        m.default_summary?.markdown_formatted ?? m.default_summary?.text ?? "";
      docs.push({
        title,
        date: (m.created_at ?? m.scheduled_start_time ?? m.recording_start_time ?? "").slice(0, 10) || null,
        summary,
        haystack: `${title} \n ${summary}`.toLowerCase(),
      });
    }
    cursor = data.next_cursor ?? undefined;
    pages++;
  } while (cursor && pages < 60);

  fathomCorpus = { fetchedAt: Date.now(), complete, docs };
  return docs;
}

async function fetchFathomMentions(companyName: string): Promise<ContextMention[]> {
  const key = matchKey(companyName);
  if (!key) return [];
  const docs = await fetchFathomCorpus();

  const mentions: ContextMention[] = [];
  for (const doc of docs) {
    if (!doc.haystack.includes(key)) continue;
    // Summaries are markdown with timestamp links — clean the WHOLE summary
    // first (reduce links to their text, drop bare URLs), then find the
    // mention and slice. Slicing first can cut a link in half and leave URL
    // fragments in the excerpt.
    const cleanedSummary = stripHtml(
      doc.summary
        .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
        .replace(/https?:\/\/\S+/g, "")
        .replace(/[#*_>`]/g, "")
    );
    const sIdx = cleanedSummary.toLowerCase().indexOf(key);
    const cleaned =
      sIdx >= 0
        ? cleanedSummary.slice(Math.max(0, sIdx - 150), sIdx + 220).trim()
        : null;
    const excerpt = cleaned && cleaned.length > 20 ? cleaned : null;
    mentions.push({
      title: doc.title,
      date: doc.date,
      excerpt: excerpt ? `…${excerpt}…` : null,
    });
    if (mentions.length >= 5) break;
  }
  return mentions;
}

async function fetchLastInbound(domain: string | null): Promise<number | null> {
  if (!domain) return null;
  const token = await getAccessToken().catch(() => null);
  if (!token) return null;
  return latestInboundDays(token, domain).catch(() => null);
}

export async function getTargetContext(
  companyId: string,
  opts: { includeSignals?: boolean } = {}
): Promise<TargetContext> {
  const includeSignals = opts.includeSignals ?? true;

  const company = await hs(
    `/crm/v3/objects/companies/${companyId}?properties=${P.NAME},${P.DOMAIN},${P.STATE},${P.BREAKDOWN}`
  );
  const props = company.properties ?? {};
  const name = props[P.NAME] ?? "(unnamed)";
  const domain = props[P.DOMAIN] ?? null;

  let reasons: string[] = [];
  try {
    const breakdown = JSON.parse(props[P.BREAKDOWN] ?? "{}");
    reasons = [...(breakdown.trigger ?? []), ...(breakdown.fit ?? [])].map(
      (c: { label: string; points: number; detail?: string }) =>
        `${c.label} (+${c.points})${c.detail ? ` — ${c.detail}` : ""}`
    );
  } catch {
    // breakdown unavailable — reasons stay empty
  }

  const [deals, notes, fathomMentions, lastInboundEmailDays] = await Promise.all([
    fetchDeals(companyId),
    fetchNotes(companyId),
    includeSignals ? fetchFathomMentions(name) : Promise.resolve([]),
    includeSignals ? fetchLastInbound(domain) : Promise.resolve(null),
  ]);

  return {
    company: { id: companyId, name, domain, state: props[P.STATE] ?? null },
    reasons,
    deals,
    notes,
    fathomMentions,
    lastInboundEmailDays,
  };
}

// Compact history lines for the HubSpot task body.
export function buildHistoryLines(ctx: TargetContext): string[] {
  const lines: string[] = [];
  for (const d of ctx.deals.slice(0, 5)) {
    const status = d.isOpen ? `OPEN — ${d.stage ?? "?"}` : d.isClosedLost ? "Closed Lost" : d.stage ?? "Closed";
    const amount = d.amount ? ` ($${d.amount.toLocaleString()})` : "";
    const when = d.closeDate ?? d.lastActivity ?? "";
    lines.push(`${when} ${status}: "${d.name}"${amount}`.trim());
  }
  for (const m of ctx.fathomMentions.slice(0, 3)) {
    lines.push(`Mentioned on call "${m.title}"${m.date ? ` (${m.date})` : ""}`);
  }
  if (ctx.lastInboundEmailDays != null) {
    lines.push(`Last inbound email: ${ctx.lastInboundEmailDays}d ago`);
  }
  return lines;
}
