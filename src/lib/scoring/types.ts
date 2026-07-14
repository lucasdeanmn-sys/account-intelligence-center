// lib/scoring/types.ts
// Shared types for the Account Intelligence Center target scoring module.

export type Segment =
  | "RURAL_ILEC"
  | "COOP"
  | "MUNI"
  | "FIBER_OVERBUILDER"
  | "WISP"
  | "CABLE"
  | "UNKNOWN";

export interface CompanyRecord {
  hubspotId: string;
  name: string;
  domain?: string;
  state?: string; // two-letter state code
  subscriberCount?: number; // parsed from HubSpot property
  segment: Segment;
  isCalixShop: boolean;
  manualTriggerFlag: boolean; // set by Luke in the app / HubSpot when he spots news
  lastInboundEmailDays?: number; // days since last inbound email from domain (Gmail signal)
  fathomMentionDays?: number; // days since company mentioned in a call (most recent, any type)
  /** Most-recent mention age per call type. "prospect" = the company itself was
   *  on the invite (that's a meeting, not a mention); "external" = mentioned on
   *  a call with a partner/customer/other outside party; "internal" = only
   *  7SIGMA people on the call. Scoring weights these very differently. */
  fathomMentionsByType?: Partial<Record<FathomCallType, number>>;
  newsTrigger?: { days: number; headline?: string }; // from Google Alerts RSS parsing
  deals: DealSummary[];
}

export type FathomCallType = "prospect" | "external" | "internal";

export interface DealSummary {
  dealId: string;
  pipeline: string;
  stage: string;
  isClosedLost: boolean;
  isOpen: boolean;
  closedDate?: string; // ISO date
  lastActivityDate?: string; // ISO date
}

export interface ScoreComponent {
  key: string;
  label: string;
  points: number;
  detail?: string;
}

export interface AccountScore {
  hubspotId: string;
  name: string;
  fitScore: number;
  triggerScore: number;
  totalScore: number;
  fitComponents: ScoreComponent[];
  triggerComponents: ScoreComponent[];
  scoredAt: string; // ISO timestamp
  scoreDelta?: number; // vs previous run (set when history is available)
}
