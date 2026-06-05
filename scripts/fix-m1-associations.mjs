/**
 * fix-m1-associations.mjs
 *
 * For every note containing "M1 Order Form":
 *   1. Parse which MSI years are listed in the note (e.g. Year 3, 4, 5)
 *   2. Find the associated company's MSI deals
 *   3. ADD associations to deals whose year appears in the note
 *   4. REMOVE associations from MSI deals whose year does NOT appear in the note
 *
 * Run:  node scripts/fix-m1-associations.mjs [--dry-run]
 */

import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Load .env.local manually
try {
  const env = readFileSync(resolve(__dirname, "../.env.local"), "utf8");
  for (const line of env.split("\n")) {
    const m = line.match(/^([^#=]+)=(.*)$/);
    if (m) process.env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, "");
  }
} catch { /* file may not exist */ }

const TOKEN = process.env.HUBSPOT_ACCESS_TOKEN;
if (!TOKEN) { console.error("HUBSPOT_ACCESS_TOKEN not set"); process.exit(1); }

const DRY_RUN = process.argv.includes("--dry-run");
const BASE = "https://api.hubapi.com";

// ─── HubSpot helpers ──────────────────────────────────────────────────────────

async function hs(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HubSpot ${res.status} ${method} ${path}: ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : {};
}

// Fetch all M1 Order Form notes (paginated)
async function getAllM1Notes() {
  const notes = [];
  let after;
  do {
    const body = {
      filterGroups: [{ filters: [{ propertyName: "hs_note_body", operator: "CONTAINS_TOKEN", value: "M1 Order Form" }] }],
      properties: ["hs_note_body", "hs_timestamp"],
      limit: 100,
      ...(after ? { after } : {}),
    };
    const res = await hs("POST", "/crm/v3/objects/notes/search", body);
    notes.push(...(res.results ?? []));
    after = res.paging?.next?.after;
  } while (after);
  return notes;
}

async function getNoteAssociations(noteId, type) {
  const res = await hs("GET", `/crm/v4/objects/notes/${noteId}/associations/${type}`).catch(() => ({ results: [] }));
  return (res.results ?? []).map(r => String(r.toObjectId)).filter(Boolean);
}

async function getMsiDealsForCompany(companyId) {
  const assoc = await hs("GET", `/crm/v4/objects/companies/${companyId}/associations/deals`).catch(() => ({ results: [] }));
  const ids = (assoc.results ?? []).map(r => String(r.toObjectId)).filter(Boolean);
  if (!ids.length) return [];

  const batch = await hs("POST", "/crm/v3/objects/deals/batch/read", {
    inputs: ids.map(id => ({ id })),
    properties: ["dealname"],
  }).catch(() => ({ results: [] }));

  return (batch.results ?? []).filter(d => d.properties?.dealname?.includes("(MSI"));
}

async function addAssociation(noteId, dealId) {
  return hs("PUT", `/crm/v4/objects/notes/${noteId}/associations/default/deals/${dealId}`);
}

async function removeAssociation(noteId, dealId) {
  return hs("DELETE", `/crm/v4/objects/notes/${noteId}/associations/deals/${dealId}`);
}

// ─── Parsing helpers ──────────────────────────────────────────────────────────

function extractYearsFromNote(html) {
  const years = new Set();
  const re = /MSI\s+Year\s+(\d+)/gi;
  let m;
  while ((m = re.exec(html)) !== null) years.add(parseInt(m[1], 10));
  return [...years];
}

function extractYearFromDealName(dealName) {
  const m = dealName.match(/MSI\s*[-–—]\s*Year\s*(\d+)/i);
  return m ? parseInt(m[1], 10) : null;
}

function extractCompany(dealName) {
  const idx = dealName.indexOf(" (MSI");
  return idx > 0 ? dealName.slice(0, idx).trim() : dealName.trim();
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n🔍 Fetching all M1 Order Form notes…${DRY_RUN ? " (DRY RUN)" : ""}\n`);
  const notes = await getAllM1Notes();
  console.log(`Found ${notes.length} notes\n`);

  let added = 0, removed = 0, skipped = 0, errors = 0;

  for (let i = 0; i < notes.length; i++) {
    const note = notes[i];
    const noteId = note.id;
    const body = note.properties?.hs_note_body ?? "";
    const years = extractYearsFromNote(body);

    if (!years.length) { skipped++; continue; }

    // Get companies this note is attached to
    const companyIds = await getNoteAssociations(noteId, "companies");
    if (!companyIds.length) { skipped++; continue; }

    // Get all MSI deals for those companies
    const allMsiDeals = [];
    for (const cid of companyIds) {
      const deals = await getMsiDealsForCompany(cid);
      allMsiDeals.push(...deals);
    }
    if (!allMsiDeals.length) { skipped++; continue; }

    const companyName = extractCompany(allMsiDeals[0].properties?.dealname ?? "");

    // Split MSI deals into "should be associated" vs "should not"
    const shouldAssociate = new Set();
    const shouldNotAssociate = new Set();
    for (const deal of allMsiDeals) {
      const yr = extractYearFromDealName(deal.properties?.dealname ?? "");
      if (yr !== null) {
        if (years.includes(yr)) shouldAssociate.add(deal.id);
        else shouldNotAssociate.add(deal.id);
      }
    }

    // Get current deal associations for this note
    const currentDealIds = new Set(await getNoteAssociations(noteId, "deals"));

    const toAdd    = [...shouldAssociate].filter(id => !currentDealIds.has(id));
    const toRemove = [...currentDealIds].filter(id => shouldNotAssociate.has(id));

    const prefix = `[${i + 1}/${notes.length}] ${companyName} (years ${years.sort().join(",")})`;

    if (!toAdd.length && !toRemove.length) {
      console.log(`  ✓  ${prefix} — already correct`);
      skipped++;
      continue;
    }

    console.log(`  ${prefix}`);

    for (const dealId of toAdd) {
      const dealName = allMsiDeals.find(d => d.id === dealId)?.properties?.dealname ?? dealId;
      console.log(`     + Associate → ${dealName}`);
      if (!DRY_RUN) {
        try { await addAssociation(noteId, dealId); added++; }
        catch (e) { console.error(`       ERROR: ${e.message}`); errors++; }
      } else { added++; }
    }

    for (const dealId of toRemove) {
      const dealName = allMsiDeals.find(d => d.id === dealId)?.properties?.dealname ?? dealId;
      console.log(`     - Remove   → ${dealName}`);
      if (!DRY_RUN) {
        try { await removeAssociation(noteId, dealId); removed++; }
        catch (e) { console.error(`       ERROR: ${e.message}`); errors++; }
      } else { removed++; }
    }
  }

  console.log(`\n${"─".repeat(60)}`);
  console.log(`✅ Done${DRY_RUN ? " (dry run — no changes made)" : ""}`);
  console.log(`   Added:   ${added}`);
  console.log(`   Removed: ${removed}`);
  console.log(`   Skipped: ${skipped}`);
  console.log(`   Errors:  ${errors}`);
}

main().catch(e => { console.error(e); process.exit(1); });
