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
  fathomMentionDays?: number; // days since company mentioned in a call (Fathom signal)
  newsTrigger?: { days: number; headline?: string }; // from Google Alerts RSS parsing
  deals: DealSummary[];
}

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
