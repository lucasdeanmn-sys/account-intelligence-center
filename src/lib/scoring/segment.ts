// lib/scoring/segment.ts
// Deduce aic_segment for prospects. Two passes:
//   1. Deterministic name/domain rules — free, safe, cover a big chunk
//      (".coop" TLD, "Cooperative", "City of", "Telephone", "Fiber", ...)
//   2. Claude classification for the rest — {name, domain, state} in,
//      segment + confidence out; only "high" confidence is trusted.
// Neither pass ever overwrites a segment a human already set — callers filter
// to segment === "UNKNOWN" first.

import { callClaude, extractJSON } from "../anthropic";
import type { Segment } from "./types";

export interface SegmentGuess {
  hubspotId: string;
  segment: Exclude<Segment, "UNKNOWN">;
  source: "rule" | "llm";
  reason: string;
}

// Order matters: co-op beats "Telephone" ("Meeker Cooperative Light & Power"),
// muni beats "Fiber" ("City of Fort Collins" fiber utility). "Fiber" is the
// weakest tell and goes last. Bare "telecom" is deliberately NOT a rule —
// CLECs and overbuilders use it as freely as ILECs do; the LLM pass sorts those.
export function deduceSegmentFromName(
  name: string,
  domain?: string | null
): { segment: Exclude<Segment, "UNKNOWN">; reason: string } | null {
  if (domain && /\.coop$/i.test(domain.trim())) {
    return { segment: "COOP", reason: ".coop domain" };
  }
  if (/\bco-?op(erative)?s?\b/i.test(name) || /\belectric membership\b/i.test(name)) {
    return { segment: "COOP", reason: "cooperative in name" };
  }
  if (
    /^(city|town|village|county) of /i.test(name) ||
    /\bmunicipal|public utilit|utilities (board|commission|district)|\bPUD\b|city utilities\b/i.test(name)
  ) {
    return { segment: "MUNI", reason: "municipal/public-utility name" };
  }
  if (/\bwireless\b|\bwisp\b|\bfixed wireless\b/i.test(name)) {
    return { segment: "WISP", reason: "wireless in name" };
  }
  if (/\bcable(vision)?\b|\bcatv\b/i.test(name)) {
    return { segment: "CABLE", reason: "cable in name" };
  }
  if (/\btelephone\b/i.test(name)) {
    return { segment: "RURAL_ILEC", reason: "telephone company name" };
  }
  if (/\bfiber\b|\bfibre\b/i.test(name)) {
    return { segment: "FIBER_OVERBUILDER", reason: "fiber in name" };
  }
  return null;
}

const SYSTEM = `You classify North American broadband/telecom providers into exactly one segment:

- RURAL_ILEC: incumbent rural telephone company (independent/family telcos, often decades old)
- COOP: member-owned cooperative (telephone or electric co-op offering broadband)
- MUNI: city/county/public-power broadband (municipal utility, PUD)
- FIBER_OVERBUILDER: private competitive FTTH builder entering markets as a challenger
- WISP: fixed-wireless ISP
- CABLE: cable MSO
- UNKNOWN: cannot tell

Confidence rules — this feeds a CRM, wrong data is worse than no data:
- "high" ONLY if you recognize the specific company, or the name/domain is unambiguous.
- "medium" for an educated guess from naming patterns.
- "low"/UNKNOWN otherwise. Never guess "high" for a company you don't actually know.

Respond with JSON only: [{"id": string, "segment": string, "confidence": "high"|"medium"|"low"}]`;

export async function classifySegmentsWithClaude(
  companies: { hubspotId: string; name: string; domain?: string; state?: string }[]
): Promise<Map<string, { segment: Segment; confidence: "high" | "medium" | "low" }>> {
  const out = new Map<string, { segment: Segment; confidence: "high" | "medium" | "low" }>();
  if (!companies.length) return out;

  const VALID = new Set(["RURAL_ILEC", "COOP", "MUNI", "FIBER_OVERBUILDER", "WISP", "CABLE"]);
  const payload = companies.map((c) => ({
    id: c.hubspotId,
    name: c.name,
    domain: c.domain ?? null,
    state: c.state ?? null,
  }));

  const text = await callClaude(SYSTEM, JSON.stringify(payload), 4000);
  const rows = extractJSON<{ id: string; segment: string; confidence: string }[]>(text);
  for (const r of rows) {
    if (!r?.id || !VALID.has(r.segment)) continue;
    const confidence =
      r.confidence === "high" ? "high" : r.confidence === "medium" ? "medium" : "low";
    out.set(String(r.id), { segment: r.segment as Segment, confidence });
  }
  return out;
}
