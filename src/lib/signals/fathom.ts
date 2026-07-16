// lib/signals/fathom.ts
// Scans recent Fathom meetings (titles + summaries, optionally transcripts) for
// prospect company mentions, classifies each hit by WHO was on the call, and
// records the most recent mention age per call type.
//
// Call types (from calendar_invitees):
//   prospect — the company itself was on the invite: a meeting, not a mention
//   external — mentioned on a call with a partner/customer/other outside party
//   internal — only 7SIGMA people on the call (funnel reviews etc.)
//
// Strategy: pull the meeting corpus ONCE, then scan locally for every company —
// one pass over the data instead of one API search per company.
//
// Env: FATHOM_API_KEY

import { SCORING_CONFIG as C } from "../scoring/config";
import type { CompanyRecord, FathomCallType } from "../scoring/types";

export interface MeetingDoc {
  createdAt: string;
  rawText: string; // title + summary (+ transcript if enabled), ORIGINAL case
  inviteeDomains: string[]; // lowercased email domains on the calendar invite
  hasExternal: boolean; // any invitee flagged is_external by Fathom
}

const FATHOM_BASE = "https://api.fathom.ai/external/v1";

export async function fetchMeetingCorpus(): Promise<MeetingDoc[]> {
  const apiKey = process.env.FATHOM_API_KEY;
  if (!apiKey) return []; // signal is optional — degrade gracefully

  const since = new Date(
    Date.now() - C.signals.fathomLookbackDays * 86_400_000
  ).toISOString();

  const docs: MeetingDoc[] = [];
  let cursor: string | undefined;

  do {
    const params = new URLSearchParams({ created_after: since });
    if (C.signals.fathomIncludeTranscript) params.set("include_transcript", "true");
    params.set("include_summary", "true");
    if (cursor) params.set("cursor", cursor);

    // The External API 429s under sustained pagination — back off and retry.
    let res: Response | null = null;
    for (let attempt = 0; attempt < 4; attempt++) {
      res = await fetch(`${FATHOM_BASE}/meetings?${params}`, {
        headers: { "X-Api-Key": apiKey },
      }).catch(() => null);
      if (res?.status !== 429) break;
      await new Promise((r) => setTimeout(r, 1200 * (attempt + 1)));
    }
    if (!res || !res.ok) {
      // A missing key degrades gracefully (empty corpus, signal skipped), but
      // a FAILED fetch must not: scoring a partial/empty corpus silently
      // zeroes every call trigger and writes those scores to HubSpot. Throw
      // so the cron can abort the run instead of persisting wrong data.
      throw new Error(
        `Fathom corpus fetch failed (${res ? `HTTP ${res.status}` : "network error"}) — rate limited? Aborting rather than scoring without call mentions.`
      );
    }
    const data = await res.json();

    for (const m of data.items ?? data.meetings ?? []) {
      const pieces: string[] = [m.title ?? "", m.meeting_title ?? ""];
      // Ground truth (fathom-mcp): the External API returns the AI summary at
      // m.default_summary.markdown_formatted. Keep the older guesses as fallbacks.
      const summary =
        m.default_summary?.markdown_formatted ??
        m.default_summary?.text ??
        m.summary?.markdown_formatted ??
        m.summary?.text ??
        "";
      pieces.push(typeof summary === "string" ? summary : JSON.stringify(summary));
      if (C.signals.fathomIncludeTranscript && Array.isArray(m.transcript)) {
        pieces.push(m.transcript.map((t: any) => t.text ?? "").join(" "));
      }
      const invitees: any[] = m.calendar_invitees ?? [];
      docs.push({
        createdAt: m.created_at ?? m.scheduled_start_time ?? m.recording_start_time ?? since,
        rawText: pieces.join(" \n "),
        inviteeDomains: invitees
          .map((i) => (i.email_domain ?? i.email?.split("@")[1] ?? "").toLowerCase())
          .filter(Boolean),
        hasExternal: invitees.some((i) => i.is_external === true),
      });
    }
    cursor = data.next_cursor ?? undefined;
  } while (cursor);

  return docs;
}

// ─── Mention matching ─────────────────────────────────────────────────────────

// Generic suffixes stripped when deriving the distinctive key, or "ABC
// Telephone Company, Inc." never matches "ABC Telephone" in a summary.
const STOP_SUFFIXES =
  /\b(inc|llc|corp|co|company|cooperative|coop|telephone|telecom|communications|networks|broadband|fiber)\.?\b/gi;

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Word-boundaried phrase, tolerant of hyphens/dashes between words so
// "S Infra" matches "S-Infra".
function phraseRe(s: string): RegExp {
  return new RegExp(`\\b${escapeRe(s).replace(/ /g, "[\\s\\-–—]+")}\\b`, "gi");
}

// Build a predicate deciding whether rawText mentions the company. Accepted:
//   1. the full cleaned name as a phrase (case-insensitive): "greenlight networks"
//   2. a multi-word distinctive key as a phrase: "la ward"
//   3. the single-token key — ONLY where the text capitalizes it somewhere
//      ("Greenlight", "telMAX", "GATEWAY"). The old substring match scored
//      Greenlight Networks off the verb "greenlight" and Gateway Fiber off
//      lowercase "gateway"; requiring an uppercase character in the matched
//      word keeps names and drops common nouns/verbs. (Sentence-initial
//      capitalization is the residual risk — rare in practice.)
export function buildMentionMatcher(name: string): ((rawText: string) => boolean) | null {
  const cleaned = name.toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
  if (!cleaned) return null;
  const key = cleaned.replace(STOP_SUFFIXES, "").replace(/\s+/g, " ").trim();

  const checks: { re: RegExp; requireUpper: boolean }[] = [];
  if (cleaned.includes(" ")) checks.push({ re: phraseRe(cleaned), requireUpper: false });
  if (key && key !== cleaned && key.includes(" ")) {
    checks.push({ re: phraseRe(key), requireUpper: false });
  }
  const single = !key.includes(" ") && key.length >= 3
    ? key
    : !cleaned.includes(" ") && cleaned.length >= 3
      ? cleaned
      : null;
  if (single) {
    checks.push({ re: new RegExp(`\\b${escapeRe(single)}\\b`, "gi"), requireUpper: true });
  }
  if (!checks.length) return null;

  return (rawText: string) => {
    for (const { re, requireUpper } of checks) {
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(rawText)) !== null) {
        if (!requireUpper) return true;
        if (m[0] !== m[0].toLowerCase()) return true;
      }
    }
    return false;
  };
}

export function classifyCall(
  doc: { inviteeDomains: string[]; hasExternal: boolean },
  companyDomain?: string | null
): FathomCallType {
  const domain = companyDomain?.toLowerCase().replace(/^www\./, "");
  if (domain && doc.inviteeDomains.includes(domain)) return "prospect";
  return doc.hasExternal ? "external" : "internal";
}

export async function applyFathomSignal(
  companies: Map<string, CompanyRecord>
): Promise<number> {
  const corpus = await fetchMeetingCorpus();
  if (!corpus.length) return 0;

  const now = Date.now();
  let hits = 0;

  for (const company of Array.from(companies.values())) {
    const matches = buildMentionMatcher(company.name);
    if (!matches) continue;

    const byType: Partial<Record<FathomCallType, number>> = {};
    for (const doc of corpus) {
      if (!matches(doc.rawText)) continue;
      const type = classifyCall(doc, company.domain);
      const days = Math.floor((now - new Date(doc.createdAt).getTime()) / 86_400_000);
      if (byType[type] == null || days < byType[type]!) byType[type] = days;
    }

    const ages = Object.values(byType).filter((d): d is number => d != null);
    if (ages.length) {
      company.fathomMentionsByType = byType;
      company.fathomMentionDays = Math.min(...ages);
      hits++;
    }
  }
  return hits;
}
