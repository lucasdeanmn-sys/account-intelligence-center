// lib/signals/fathom.ts
// Scans recent Fathom meetings (titles + summaries, optionally transcripts) for
// prospect company names and sets fathomMentionDays on matches.
//
// Strategy: pull the meeting corpus ONCE, then scan locally for every company —
// one pass over the data instead of one API search per company.
//
// Env: FATHOM_API_KEY
// NOTE: verify field names against your working fathom-mcp client — the External
// API response shape is coded defensively here but your MCP repo is ground truth.

import { SCORING_CONFIG as C } from "../scoring/config";
import type { CompanyRecord } from "../scoring/types";

interface MeetingDoc {
  createdAt: string;
  text: string; // title + summary (+ transcript if enabled), lowercased
}

const FATHOM_BASE = "https://api.fathom.ai/external/v1";

async function fetchMeetingCorpus(): Promise<MeetingDoc[]> {
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

    const res = await fetch(`${FATHOM_BASE}/meetings?${params}`, {
      headers: { "X-Api-Key": apiKey },
    });
    if (!res.ok) {
      console.error(`Fathom signal skipped: ${res.status} ${await res.text()}`);
      return docs;
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
      docs.push({
        createdAt: m.created_at ?? m.scheduled_start_time ?? m.recording_start_time ?? since,
        text: pieces.join(" \n ").toLowerCase(),
      });
    }
    cursor = data.next_cursor ?? undefined;
  } while (cursor);

  return docs;
}

// Company names need normalizing before matching, or "ABC Telephone Company, Inc."
// never matches "ABC Telephone" in a summary.
const STOP_SUFFIXES =
  /\b(inc|llc|corp|co|company|cooperative|coop|telephone|telecom|communications|networks|broadband|fiber)\.?\b/gi;

export function matchKey(name: string): string | null {
  const cleaned = name.toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
  const key = cleaned.replace(STOP_SUFFIXES, "").replace(/\s+/g, " ").trim();
  // Too-short keys ("abc") produce false positives; fall back to the fuller
  // cleaned name (suffixes kept) rather than matching on 3 characters.
  return key.length >= 5 ? key : cleaned || null;
}

export async function applyFathomSignal(
  companies: Map<string, CompanyRecord>
): Promise<number> {
  const corpus = await fetchMeetingCorpus();
  if (!corpus.length) return 0;

  const now = Date.now();
  let hits = 0;

  for (const company of Array.from(companies.values())) {
    const key = matchKey(company.name);
    if (!key) continue;

    let mostRecent: number | undefined;
    for (const doc of corpus) {
      if (doc.text.includes(key)) {
        const days = Math.floor((now - new Date(doc.createdAt).getTime()) / 86_400_000);
        if (mostRecent == null || days < mostRecent) mostRecent = days;
      }
    }
    if (mostRecent != null) {
      company.fathomMentionDays = mostRecent;
      hits++;
    }
  }
  return hits;
}
