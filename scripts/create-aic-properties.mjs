// scripts/create-aic-properties.mjs
// Creates the 8 AIC custom company properties in HubSpot. Idempotent: skips any
// that already exist. Reads HUBSPOT_ACCESS_TOKEN from the environment.
//
//   node --env-file=.env.local scripts/create-aic-properties.mjs
//
// Property names + types mirror lib/scoring/config.ts (HUBSPOT_PROPS) and
// README-scoring.md. Safe to re-run.

const TOKEN = process.env.HUBSPOT_ACCESS_TOKEN;
if (!TOKEN) {
  console.error("HUBSPOT_ACCESS_TOKEN not set (try: node --env-file=.env.local ...)");
  process.exit(1);
}

const BASE = "https://api.hubapi.com";
const GROUP = "companyinformation"; // default HubSpot company property group

const PROPS = [
  {
    name: "aic_segment",
    label: "AIC Segment",
    type: "enumeration",
    fieldType: "select",
    options: [
      "RURAL_ILEC",
      "COOP",
      "MUNI",
      "FIBER_OVERBUILDER",
      "WISP",
      "CABLE",
    ].map((v) => ({ label: v, value: v })),
  },
  { name: "aic_calix_shop", label: "AIC Calix Shop", type: "bool", fieldType: "booleancheckbox",
    options: [{ label: "Yes", value: "true" }, { label: "No", value: "false" }] },
  { name: "aic_manual_trigger", label: "AIC Manual Trigger", type: "bool", fieldType: "booleancheckbox",
    options: [{ label: "Yes", value: "true" }, { label: "No", value: "false" }] },
  { name: "aic_target_score", label: "AIC Target Score", type: "number", fieldType: "number" },
  { name: "aic_fit_score", label: "AIC Fit Score", type: "number", fieldType: "number" },
  { name: "aic_trigger_score", label: "AIC Trigger Score", type: "number", fieldType: "number" },
  { name: "aic_score_breakdown", label: "AIC Score Breakdown", type: "string", fieldType: "textarea" },
  { name: "aic_score_updated", label: "AIC Score Updated", type: "date", fieldType: "date" },
];

async function hs(path, init) {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  const text = await res.text();
  return { ok: res.ok, status: res.status, body: text };
}

async function main() {
  const existingRes = await hs("/crm/v3/properties/companies");
  if (!existingRes.ok) {
    console.error("Failed to read existing properties:", existingRes.status, existingRes.body);
    process.exit(1);
  }
  const existing = new Set(JSON.parse(existingRes.body).results.map((p) => p.name));

  for (const prop of PROPS) {
    if (existing.has(prop.name)) {
      console.log(`SKIP   ${prop.name} (already exists)`);
      continue;
    }
    const payload = { ...prop, groupName: GROUP };
    const r = await hs("/crm/v3/properties/companies", {
      method: "POST",
      body: JSON.stringify(payload),
    });
    if (r.ok) {
      console.log(`CREATE ${prop.name} (${prop.type}/${prop.fieldType})`);
    } else {
      console.error(`FAIL   ${prop.name}: ${r.status} ${r.body}`);
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
