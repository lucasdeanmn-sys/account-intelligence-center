// lib/scoring/config.ts
// All tunable weights live here. Adjust numbers, never logic, to retune the model.
// Scores are 0-100 for fit and 0-100 for trigger; total = fit * FIT_WEIGHT + trigger * TRIGGER_WEIGHT.

import type { Segment } from "./types";

export const SCORING_CONFIG = {
  // Blend: fit tells you WHO, trigger tells you WHEN.
  FIT_WEIGHT: 0.55,
  TRIGGER_WEIGHT: 0.45,

  // ---- FIT ----

  // Subscriber-count sweet spot. Bands are inclusive lower bound, exclusive upper.
  subscriberBands: [
    { min: 0, max: 1000, points: 5, label: "Very small (<1K subs)" },
    { min: 1000, max: 5000, points: 15, label: "Small (1-5K subs)" },
    { min: 5000, max: 25000, points: 25, label: "Core ICP (5-25K subs)" },
    { min: 25000, max: 100000, points: 20, label: "Upper mid (25-100K subs)" },
    { min: 100000, max: Infinity, points: 8, label: "Large (100K+ subs)" },
  ],
  subscriberUnknownPoints: 8, // don't zero out accounts just because data is thin

  // Companies far above the ICP ceiling (national MSOs/telcos that surface on
  // calls as someone's upstream provider) stay in the universe as prospects,
  // but fit is hard-capped — reference-state and deal-history bonuses must not
  // stack a Charter into the top of the list.
  nationalScale: {
    minSubs: 1_000_000,
    fitCap: 15,
    label: "National scale — out of ICP, fit capped",
  },

  segmentPoints: {
    RURAL_ILEC: 20,
    COOP: 20,
    MUNI: 15,
    FIBER_OVERBUILDER: 15,
    WISP: 8,
    CABLE: 5,
    UNKNOWN: 8,
  } satisfies Record<Segment, number>,

  // States where you have reference customers / association presence.
  // Proximity to peer proof is where direct motion converts.
  referenceStates: ["TX", "SD", "WA", "GA", "NC", "MN", "NY", "CT", "ME"],
  referenceStatePoints: 15,

  // Calix displacement play.
  calixShopPoints: 15,

  // Relationship history: a known account beats a cold one.
  closedLostRecency: [
    { maxMonths: 12, points: 20, label: "Closed-lost < 12 mo" },
    { maxMonths: 24, points: 15, label: "Closed-lost 12-24 mo" },
    { maxMonths: 48, points: 8, label: "Closed-lost 24-48 mo" },
  ],
  stalledOpenDealPoints: 25, // open deal, no activity in stalledAfterDays
  stalledAfterDays: 60,

  // ---- TRIGGER ----

  manualTriggerPoints: 40, // Luke flagged news: ownership change, exec hire, expansion
  inboundEmailTrigger: [
    { maxDays: 30, points: 30, label: "Inbound email < 30d" },
    { maxDays: 90, points: 15, label: "Inbound email 30-90d" },
  ],
  // Call mentions are weighted by WHO was on the call (from calendar_invitees):
  //   prospect — the company itself was on the invite: a meeting, not a mention
  //   external — mentioned on a call with a partner/customer/other outside party
  //   internal — only 7SIGMA people: mostly an echo of attention already paid
  fathomMentionTrigger: {
    prospect: [
      { maxDays: 60, points: 40, label: "Met with them on a call < 60d" },
      { maxDays: 180, points: 20, label: "Met with them on a call 60-180d" },
    ],
    external: [
      { maxDays: 60, points: 30, label: "Mentioned on a partner/customer call < 60d" },
      { maxDays: 180, points: 15, label: "Mentioned on a partner/customer call 60-180d" },
    ],
    internal: [
      { maxDays: 60, points: 10, label: "Discussed internally < 60d" },
      { maxDays: 180, points: 5, label: "Discussed internally 60-180d" },
    ],
  },
  dealStageChangeTrigger: { maxDays: 14, points: 20, label: "Deal stage moved < 14d" },
  newsTrigger: [
    { maxDays: 14, points: 40, label: "News hit < 14d" },
    { maxDays: 45, points: 20, label: "News hit 14-45d" },
  ],
  // Score-history riser: account jumped vs last run — itself a trigger.
  riser: { minDelta: 15, points: 15, label: "Score riser (+15 vs last run)" },

  // ---- SIGNAL GATHERING ----
  signals: {
    fathomLookbackDays: 180, // how far back to scan meetings for company mentions
    fathomIncludeTranscript: false, // titles + summaries first; transcripts are heavy
    gmailLookbackDays: 90,
    gmailConcurrency: 5, // parallel Gmail queries
    gmailMaxCompanies: 300, // safety cap: only query companies that have a domain
    alertsMaxAgeDays: 45, // ignore RSS items older than this
  },

  // ---- OUTPUT ----
  listSize: 75, // the standing named-account list
  weeklyFocusSize: 10, // Monday outreach set, ranked by trigger score
};

// HubSpot property names. Create these as custom company properties (see README).
export const HUBSPOT_PROPS = {
  // read
  NAME: "name",
  DOMAIN: "domain",
  STATE: "state",
  SUBSCRIBERS: "broadband_subs", // "Total Broadband Subs" — 192 prospects have values (of_subs_license_ doesn't exist in this portal)
  SEGMENT: "aic_segment", // enumeration: RURAL_ILEC | COOP | MUNI | FIBER_OVERBUILDER | WISP | CABLE
  CALIX: "aic_calix_shop", // boolean checkbox
  MANUAL_TRIGGER: "aic_manual_trigger", // boolean checkbox, set when you spot news
  TYPE: "type", // PROSPECT filter
  // write
  TOTAL_SCORE: "aic_target_score",
  FIT_SCORE: "aic_fit_score",
  TRIGGER_SCORE: "aic_trigger_score",
  BREAKDOWN: "aic_score_breakdown", // multi-line text, JSON string of components
  SCORED_AT: "aic_score_updated",
} as const;
