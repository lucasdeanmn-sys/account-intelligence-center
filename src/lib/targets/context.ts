// lib/targets/context.ts
// Account-history context for a single target company: deal history with
// human-readable pipeline/stage labels, recent company notes, Fathom call
// mentions, and days since the last inbound email. Feeds the /targets
// expanded panel, the outreach-task body, and the AI outreach draft.
//
// Everything is best-effort: a failing source degrades to empty rather than
// breaking the panel.

import { buildMentionMatcher, classifyCall } from "@/lib/signals/fathom";
import type { FathomCallType } from "@/lib/scoring/types";
import { getAccessToken, recentInboundActivity } from "@/lib/signals/gmail";
import type { InboundSender } from "@/lib/signals/gmail";
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
  /** prospect = they were on the call; external = partner/customer call;
   *  internal = 7SIGMA-only call. */
  callType: FathomCallType;
}

export interface ContextPerson {
  name: string;
  email: string | null;
  title: string | null;
  /** Where we know them from — a person can appear in several. */
  sources: ("hubspot" | "call" | "email")[];
  /** Most recent touchpoint we can date (call or email). */
  lastSeen: string | null;
  detail: string | null; // e.g. the meeting title they attended
  /** Other addresses folded into this person by alias matching. */
  aliases?: string[];
}

export interface TargetContext {
  company: {
    id: string;
    name: string;
    domain: string | null;
    state: string | null;
    city: string | null;
  };
  reasons: string[]; // score breakdown labels with points
  deals: ContextDeal[];
  notes: ContextNote[];
  fathomMentions: ContextMention[];
  people: ContextPerson[];
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
  rawText: string; // title + summary, original case (matcher needs capitalization)
  recordingId: string | number | null;
  inviteeDomains: string[];
  hasExternal: boolean;
  invitees: { name: string | null; email: string | null; domain: string }[];
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
      const invitees: any[] = m.calendar_invitees ?? [];
      docs.push({
        title,
        date: (m.created_at ?? m.scheduled_start_time ?? m.recording_start_time ?? "").slice(0, 10) || null,
        summary,
        rawText: `${title} \n ${summary}`,
        recordingId: m.recording_id ?? null,
        inviteeDomains: invitees
          .map((i) => (i.email_domain ?? i.email?.split("@")[1] ?? "").toLowerCase())
          .filter(Boolean),
        hasExternal: invitees.some((i) => i.is_external === true),
        invitees: invitees.map((i) => ({
          name: i.name ?? null,
          email: i.email?.toLowerCase() ?? null,
          domain: (i.email_domain ?? i.email?.split("@")[1] ?? "").toLowerCase(),
        })),
      });
    }
    cursor = data.next_cursor ?? undefined;
    pages++;
  } while (cursor && pages < 60);

  fathomCorpus = { fetchedAt: Date.now(), complete, docs };
  return docs;
}

// Shared calendars, ticket queues, and role mailboxes end up on invites but
// are not people. Filtered unconditionally.
const GENERIC_MAILBOX =
  /^(info|sales|support|help|helpdesk|admin|office|billing|noc|contact|team|hello|accounts?|service|tickets?)@/i;
const NON_PERSON_NAME =
  /\b(meetings?|calendar|room|conference|csm|notetaker|recorder|bot|desk|queue)\b/i;

function looksLikePerson(inv: { name: string | null; email: string | null }): boolean {
  if (inv.email && GENERIC_MAILBOX.test(inv.email)) return false;
  if (inv.name && NON_PERSON_NAME.test(inv.name)) return false;
  return true;
}

// Did this invitee actually SPEAK on the call? Fathom's own invitee↔speaker
// matching is nearly always empty, and transcript display names come in many
// shapes — "Chris Dodd", "rwhite" (Roxanne White), "DJ Weber" (djweber@…) —
// so match ourselves against every shape we've seen.
function speakerMatchesInvitee(
  speaker: { display: string; matchedEmail: string | null },
  inv: { name: string | null; email: string | null }
): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z]/g, "");
  if (speaker.matchedEmail && inv.email && speaker.matchedEmail.toLowerCase() === inv.email) return true;
  const d = norm(speaker.display ?? "");
  if (!d) return false;
  if (inv.name) {
    const n = norm(inv.name);
    if (d === n) return true;
    const parts = inv.name.trim().split(/\s+/);
    if (parts.length >= 2) {
      const first = norm(parts[0]);
      const last = norm(parts[parts.length - 1]);
      if (first && d === first[0] + last) return true; // "rwhite"
      if (last && d === first + last[0]) return true; // "roxannew"
      if (d === last && last.length >= 5) return true; // bare surname
    }
  }
  if (inv.email) {
    const local = norm(inv.email.split("@")[0]);
    if (local && d === local) return true; // "djweber"
  }
  return false;
}

// Speaker lists per recording, cached for the process lifetime — transcripts
// are only fetched for the few meetings that involve the company at hand.
const speakerCache = new Map<string, { display: string; matchedEmail: string | null }[] | null>();

async function fetchSpeakers(
  recordingId: string | number
): Promise<{ display: string; matchedEmail: string | null }[] | null> {
  const key = String(recordingId);
  if (speakerCache.has(key)) return speakerCache.get(key)!;
  const apiKey = process.env.FATHOM_API_KEY;
  if (!apiKey) return null;

  let res: Response | null = null;
  for (let attempt = 0; attempt < 4; attempt++) {
    res = await fetch(`https://api.fathom.ai/external/v1/recordings/${key}/transcript`, {
      headers: { "X-Api-Key": apiKey },
    }).catch(() => null);
    if (res?.status !== 429) break;
    await new Promise((r) => setTimeout(r, 1200 * (attempt + 1)));
  }
  if (!res || !res.ok) {
    speakerCache.set(key, null); // null = unavailable, callers fall back
    return null;
  }
  const data = await res.json().catch(() => null);
  const entries: any[] = Array.isArray(data) ? data : data?.transcript ?? data?.items ?? [];
  const seen = new Map<string, { display: string; matchedEmail: string | null }>();
  for (const e of entries) {
    const display = e?.speaker?.display_name ?? e?.speaker?.name ?? null;
    if (!display) continue;
    if (!seen.has(display)) {
      seen.set(display, {
        display,
        matchedEmail: e?.speaker?.matched_calendar_invitee_email?.toLowerCase() ?? null,
      });
    }
  }
  const speakers = Array.from(seen.values());
  speakerCache.set(key, speakers);
  return speakers;
}

async function fetchFathomMentions(
  companyName: string,
  companyDomain: string | null
): Promise<{ mentions: ContextMention[]; participants: ContextPerson[] }> {
  const matches = buildMentionMatcher(companyName);
  if (!matches) return { mentions: [], participants: [] };
  const docs = await fetchFathomCorpus();

  // People from the prospect's side who ENGAGED on calls with us: on the
  // invite by domain AND matched to a transcript speaker. When a transcript
  // can't be fetched, fall back to the invite list (minus non-persons) —
  // showing invited-but-unverified beats showing nobody.
  const domain = companyDomain?.toLowerCase().replace(/^www\./, "") ?? null;
  const participantMap = new Map<string, ContextPerson>();
  if (domain) {
    const relevant = docs
      .filter((doc) => doc.invitees.some((i) => i.domain === domain && looksLikePerson(i)))
      .sort((a, b) => (b.date ?? "").localeCompare(a.date ?? ""))
      .slice(0, 4); // transcripts are a per-recording fetch — bound it

    for (const doc of relevant) {
      const speakers = doc.recordingId != null ? await fetchSpeakers(doc.recordingId) : null;
      for (const inv of doc.invitees) {
        if (inv.domain !== domain || (!inv.name && !inv.email) || !looksLikePerson(inv)) continue;
        const engaged = speakers === null || speakers.some((s) => speakerMatchesInvitee(s, inv));
        if (!engaged) continue;
        const key = inv.email ?? inv.name!.toLowerCase();
        const existing = participantMap.get(key);
        if (!existing || (doc.date ?? "") > (existing.lastSeen ?? "")) {
          participantMap.set(key, {
            name: inv.name ?? inv.email!,
            email: inv.email,
            title: existing?.title ?? null,
            sources: ["call"],
            lastSeen: doc.date,
            detail: doc.title,
          });
        }
      }
    }
  }

  // The excerpt slice still keys off the lowercased distinctive token.
  const key = companyName.toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim().split(" ")[0];

  const mentions: ContextMention[] = [];
  for (const doc of docs) {
    if (!matches(doc.rawText)) continue;
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
    const sIdx = key ? cleanedSummary.toLowerCase().indexOf(key) : -1;
    const cleaned =
      sIdx >= 0
        ? cleanedSummary.slice(Math.max(0, sIdx - 150), sIdx + 220).trim()
        : null;
    const excerpt = cleaned && cleaned.length > 20 ? cleaned : null;
    mentions.push({
      title: doc.title,
      date: doc.date,
      excerpt: excerpt ? `…${excerpt}…` : null,
      callType: classifyCall(doc, companyDomain),
    });
    if (mentions.length >= 5) break;
  }
  return { mentions, participants: Array.from(participantMap.values()) };
}

async function fetchInbound(
  domain: string | null
): Promise<{ lastInboundDays: number | null; senders: InboundSender[] }> {
  if (!domain) return { lastInboundDays: null, senders: [] };
  const token = await getAccessToken().catch(() => null);
  if (!token) return { lastInboundDays: null, senders: [] };
  return recentInboundActivity(token, domain, C.signals.gmailLookbackDays).catch(() => ({
    lastInboundDays: null,
    senders: [],
  }));
}

// HubSpot contacts associated with the company — names, titles, emails.
async function fetchContacts(companyId: string): Promise<ContextPerson[]> {
  const assoc = await hs(
    `/crm/v4/objects/companies/${companyId}/associations/contacts`
  ).catch(() => ({ results: [] }));
  const ids: string[] = (assoc.results ?? [])
    .map((r: any) => String(r.toObjectId))
    .slice(0, 20);
  if (!ids.length) return [];

  const batch = await hs(`/crm/v3/objects/contacts/batch/read`, {
    method: "POST",
    body: JSON.stringify({
      inputs: ids.map((id) => ({ id })),
      properties: ["firstname", "lastname", "jobtitle", "email"],
    }),
  }).catch(() => ({ results: [] }));

  return (batch.results ?? [])
    .map((c: any) => {
      const p = c.properties ?? {};
      const name = [p.firstname, p.lastname].filter(Boolean).join(" ").trim();
      if (!name && !p.email) return null;
      return {
        name: name || p.email,
        email: p.email?.toLowerCase() ?? null,
        title: p.jobtitle ?? null,
        sources: ["hubspot"],
        lastSeen: null,
        detail: null,
      } as ContextPerson;
    })
    .filter(Boolean) as ContextPerson[];
}

// ─── Alias matching ────────────────────────────────────────────────────────
// The same human shows up as dgosseling@ (HubSpot), dalen@ (their email), and
// "Dalen Gosseling" (call invite). Exact-email dedupe leaves them as separate
// rows, so a second folding pass matches aliases.

const normPersonName = (s: string) =>
  s.toLowerCase().replace(/[^a-z ]/g, " ").replace(/\s+/g, " ").trim();
// Gmail-style normalization: case, plus-tags, dots in the local part.
const normEmailLocal = (email: string) =>
  email.split("@")[0].toLowerCase().replace(/\+.*$/, "").replace(/\./g, "");
const emailDomainOf = (email: string) => email.split("@")[1]?.toLowerCase() ?? "";

// Does an address local part spell this person's name in a common shape?
// dgosseling / dalen.gosseling / dalengosseling / dalen / gosseling ↔ "Dalen Gosseling"
function localMatchesName(local: string, name: string): boolean {
  const parts = normPersonName(name).split(" ").filter(Boolean);
  if (parts.length < 2) return false;
  const first = parts[0];
  const last = parts[parts.length - 1];
  return (
    local === first + last ||
    local === last + first ||
    local === first[0] + last ||
    local === first + last[0] ||
    (local === first && first.length >= 4) ||
    (local === last && last.length >= 5)
  );
}

function samePerson(a: ContextPerson, b: ContextPerson): boolean {
  if (a.email && b.email) {
    if (
      emailDomainOf(a.email) === emailDomainOf(b.email) &&
      normEmailLocal(a.email) === normEmailLocal(b.email)
    ) {
      return true;
    }
  }
  // Full-name match (2+ words) — safe inside a single company's panel.
  const na = normPersonName(a.name);
  const nb = normPersonName(b.name);
  if (na && na === nb && na.includes(" ")) return true;
  // Address spells the other's name — same domain only (or the named side
  // has no address of its own).
  for (const [x, y] of [
    [a, b],
    [b, a],
  ] as const) {
    if (!x.email) continue;
    if (y.email && emailDomainOf(x.email) !== emailDomainOf(y.email)) continue;
    if (localMatchesName(normEmailLocal(x.email), y.name)) return true;
  }
  return false;
}

// Fold alias entries into their canonical person. Earlier entries win on
// name/title (HubSpot contacts are inserted first). An entry matching MORE
// than one existing person is ambiguous (jsmith@ with John and Jane Smith
// both present) and stays its own row. Exported for the validation script.
export function foldAliases(people: ContextPerson[]): ContextPerson[] {
  const out: ContextPerson[] = [];
  for (const p of people) {
    const matches = out.filter((q) => samePerson(q, p));
    if (matches.length !== 1) {
      out.push({ ...p });
      continue;
    }
    const target = matches[0];
    for (const s of p.sources) if (!target.sources.includes(s)) target.sources.push(s);
    if ((p.lastSeen ?? "") > (target.lastSeen ?? "")) {
      target.lastSeen = p.lastSeen;
      target.detail = p.detail ?? target.detail;
    }
    target.title = target.title ?? p.title;
    if (p.email && p.email !== target.email) {
      if (!target.email) target.email = p.email;
      else if (!(target.aliases ?? []).includes(p.email)) {
        target.aliases = [...(target.aliases ?? []), p.email];
      }
    }
  }
  return out;
}

// Merge people from HubSpot, calls, and email into one deduped list.
// HubSpot wins on name/title; calls and email contribute recency + sources.
function mergePeople(
  contacts: ContextPerson[],
  participants: ContextPerson[],
  senders: InboundSender[]
): ContextPerson[] {
  const byKey = new Map<string, ContextPerson>();
  const keyOf = (email: string | null, name: string) =>
    email ?? `name:${name.toLowerCase()}`;

  for (const p of contacts) byKey.set(keyOf(p.email, p.name), { ...p });

  const fold = (p: ContextPerson) => {
    const key = keyOf(p.email, p.name);
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, { ...p });
      return;
    }
    for (const s of p.sources) if (!existing.sources.includes(s)) existing.sources.push(s);
    if ((p.lastSeen ?? "") > (existing.lastSeen ?? "")) {
      existing.lastSeen = p.lastSeen;
      existing.detail = p.detail ?? existing.detail;
    }
    existing.title = existing.title ?? p.title;
  };
  for (const p of participants) fold(p);
  for (const s of senders) {
    fold({
      name: s.name ?? s.email,
      email: s.email,
      title: null,
      sources: ["email"],
      lastSeen: s.lastDate,
      detail: null,
    });
  }

  // Alias pass: same human under different addresses becomes one row
  // (insertion order is contacts → calls → email, so HubSpot names/titles win).
  // Then most recently seen first, then HubSpot contacts with titles.
  return foldAliases(Array.from(byKey.values())).sort((a, b) => {
    const r = (b.lastSeen ?? "").localeCompare(a.lastSeen ?? "");
    if (r !== 0) return r;
    return (b.title ? 1 : 0) - (a.title ? 1 : 0);
  });
}

export async function getTargetContext(
  companyId: string,
  opts: { includeSignals?: boolean } = {}
): Promise<TargetContext> {
  const includeSignals = opts.includeSignals ?? true;

  const company = await hs(
    `/crm/v3/objects/companies/${companyId}?properties=${P.NAME},${P.DOMAIN},${P.STATE},city,${P.BREAKDOWN}`
  );
  const props = company.properties ?? {};
  const name = props[P.NAME] ?? "(unnamed)";
  const domain = props[P.DOMAIN] ?? null;

  let reasons: string[] = [];
  try {
    const breakdown = JSON.parse(props[P.BREAKDOWN] ?? "{}");
    reasons = [...(breakdown.trigger ?? []), ...(breakdown.fit ?? [])].map(
      (c: { label: string; points: number; detail?: string }) =>
        `${c.label} (${c.points >= 0 ? "+" : ""}${c.points})${c.detail ? ` — ${c.detail}` : ""}`
    );
  } catch {
    // breakdown unavailable — reasons stay empty
  }

  const [deals, notes, contacts, fathom, inbound] = await Promise.all([
    fetchDeals(companyId),
    fetchNotes(companyId),
    fetchContacts(companyId), // HubSpot-only, cheap — included in the fast stage
    includeSignals
      ? fetchFathomMentions(name, domain)
      : Promise.resolve({ mentions: [] as ContextMention[], participants: [] as ContextPerson[] }),
    includeSignals
      ? fetchInbound(domain)
      : Promise.resolve({ lastInboundDays: null, senders: [] as InboundSender[] }),
  ]);

  return {
    company: {
      id: companyId,
      name,
      domain,
      state: props[P.STATE] ?? null,
      city: props.city ?? null,
    },
    reasons,
    deals,
    notes,
    fathomMentions: fathom.mentions,
    people: mergePeople(contacts, fathom.participants, inbound.senders),
    lastInboundEmailDays: inbound.lastInboundDays,
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
  const CALL_TYPE_LABEL: Record<string, string> = {
    prospect: "they were on the call",
    external: "partner/customer call",
    internal: "internal call",
  };
  for (const m of ctx.fathomMentions.slice(0, 3)) {
    const type = CALL_TYPE_LABEL[m.callType] ?? m.callType;
    lines.push(`Mentioned on "${m.title}"${m.date ? ` (${m.date})` : ""} — ${type}`);
  }
  for (const p of ctx.people.slice(0, 3)) {
    const bits = [p.title, p.email, p.lastSeen ? `last touch ${p.lastSeen}` : null]
      .filter(Boolean)
      .join(", ");
    lines.push(`Contact: ${p.name}${bits ? ` (${bits})` : ""}`);
  }
  if (ctx.lastInboundEmailDays != null) {
    lines.push(`Last inbound email: ${ctx.lastInboundEmailDays}d ago`);
  }
  return lines;
}
