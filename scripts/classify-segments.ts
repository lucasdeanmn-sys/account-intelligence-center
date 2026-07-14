// Backfill aic_segment for prospects that still have it empty/UNKNOWN.
// Deterministic name/domain rules first, Claude for the remainder; only
// rule hits and high-confidence LLM answers are written. Never overwrites
// a segment already set in HubSpot, so it is safe to re-run any time.
//
// Run:  set -a; . ./.env.local; set +a
//       npx tsx scripts/classify-segments.ts --dry-run     # look first
//       npx tsx scripts/classify-segments.ts               # write
//       npx tsx scripts/classify-segments.ts --llm-limit 80  # bound LLM spend

import { fetchProspectCompanies } from "../src/lib/hubspot/client";
import { deduceSegmentFromName, classifySegmentsWithClaude } from "../src/lib/scoring/segment";
import type { CompanyRecord } from "../src/lib/scoring/types";

const DRY = process.argv.includes("--dry-run");
const llmLimitIdx = process.argv.indexOf("--llm-limit");
const LLM_LIMIT = llmLimitIdx > -1 ? Number(process.argv[llmLimitIdx + 1]) : Infinity;
const BATCH = 40;

async function writeSegments(rows: { hubspotId: string; segment: string }[]) {
  for (let i = 0; i < rows.length; i += 100) {
    const inputs = rows.slice(i, i + 100).map((r) => ({
      id: r.hubspotId,
      properties: { aic_segment: r.segment },
    }));
    const res = await fetch("https://api.hubapi.com/crm/v3/objects/companies/batch/update", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.HUBSPOT_ACCESS_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ inputs }),
    });
    if (!res.ok) throw new Error(`batch update ${res.status}: ${await res.text()}`);
  }
}

(async () => {
  const companies = await fetchProspectCompanies();
  const unknowns = Array.from(companies.values()).filter((c) => c.segment === "UNKNOWN");
  console.log(`prospects: ${companies.size}, segment UNKNOWN: ${unknowns.length}`);

  // Pass 1 — rules
  const decided: { hubspotId: string; name: string; segment: string; source: string; reason: string }[] = [];
  const leftover: CompanyRecord[] = [];
  for (const c of unknowns) {
    const hit = deduceSegmentFromName(c.name, c.domain);
    if (hit) decided.push({ hubspotId: c.hubspotId, name: c.name, segment: hit.segment, source: "rule", reason: hit.reason });
    else leftover.push(c);
  }
  console.log(`rule pass: ${decided.length} classified, ${leftover.length} left for LLM`);

  // Pass 2 — Claude, batched, high-confidence only
  let llmHigh = 0, llmMedium = 0, llmLow = 0;
  const mediumSamples: string[] = [];
  const toLLM = leftover.slice(0, LLM_LIMIT);
  for (let i = 0; i < toLLM.length; i += BATCH) {
    const batch = toLLM.slice(i, i + BATCH);
    try {
      const result = await classifySegmentsWithClaude(batch);
      for (const c of batch) {
        const r = result.get(c.hubspotId);
        if (!r) continue;
        if (r.confidence === "high") {
          decided.push({ hubspotId: c.hubspotId, name: c.name, segment: r.segment, source: "llm", reason: "high confidence" });
          llmHigh++;
        } else if (r.confidence === "medium") {
          llmMedium++;
          if (mediumSamples.length < 15) mediumSamples.push(`${c.name} -> ${r.segment}`);
        } else llmLow++;
      }
      console.log(`  llm batch ${i / BATCH + 1}/${Math.ceil(toLLM.length / BATCH)} done (high so far: ${llmHigh})`);
    } catch (e: any) {
      console.warn(`  llm batch ${i / BATCH + 1} failed (skipped): ${e.message}`);
    }
  }

  // Report
  const bySegment = new Map<string, number>();
  for (const d of decided) bySegment.set(d.segment, (bySegment.get(d.segment) ?? 0) + 1);
  console.log(`\nclassified total: ${decided.length} (rules ${decided.filter(d => d.source === "rule").length}, llm-high ${llmHigh})`);
  console.log("by segment:", Object.fromEntries(bySegment));
  console.log(`llm declined: medium ${llmMedium}, low/unknown ${llmLow} — left UNKNOWN for a human`);
  if (mediumSamples.length) {
    console.log("medium-confidence samples (NOT written):");
    for (const s of mediumSamples) console.log("  ", s);
  }
  console.log("\nsample of what gets written:");
  for (const d of decided.slice(0, 25)) console.log(`  ${d.segment.padEnd(17)} ${d.name}  [${d.source}: ${d.reason}]`);

  if (DRY) {
    console.log("\nDRY RUN — nothing written");
    return;
  }
  await writeSegments(decided);
  console.log(`\nWROTE aic_segment for ${decided.length} companies`);
})();
