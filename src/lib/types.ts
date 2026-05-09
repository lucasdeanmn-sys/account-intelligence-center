export interface Deal {
  id: string;
  name: string;
  amount?: number;
  stage?: string;
  closeDate?: string;
  company?: string;
  ownerId?: string;
  isMSI: boolean;
  priorityScore?: number;
  priorityReason?: string;
  suggestedAction?: string;
  lastActivity?: string;
  daysSinceActivity?: number;
  overdueTaskCount?: number;
  stageAge?: number;
}

export interface PriorityDeal extends Deal {
  priorityScore: number;
  priorityReason: string;
  suggestedAction: string;
}

export interface Contact {
  id: string;
  name: string;
  email?: string;
  phone?: string;
  title?: string;
}

export interface HubSpotNote {
  id: string;
  body: string;
  createdAt: string;
  associatedDeal?: string;
}

export interface HubSpotTask {
  id?: string;
  subject: string;
  dueDate?: string;
  status?: string;
  priority?: string;
  notes?: string;
}

export interface AccountBriefing {
  dealName: string;
  company: string;
  dealStage?: string;
  dealAmount?: number;
  closeDate?: string;
  currentStatus: string;
  lastTouchpoint: string;
  openItems: string[];
  suggestedTalkingPoints: string[];
  recommendedNextStep: string;
  contacts: Array<{ name: string; title?: string; email?: string }>;
  recentEmailSummary?: string;
  upcomingMeetings?: string;
  companyNews?: string;
  isMSI: boolean;
}

export interface MSIDeal {
  id: string;
  name: string;
  company: string;
  stage?: string;
  closeDate?: string;
  m1Note: string | null;
  contractedCircuits: number | null;
  contractValue: number | null;
  nextRenewalDate: string | null;
  nextRenewalYear: number | null;
  actualCircuits: number | null;
  recommendedInvoiceCircuits: number | null;
  recommendedInvoiceAmount: number | null;
  flags: MSIFlag[];
  alreadyInvoicedYears: number;
}

export type MSIFlag =
  | "missing_m1_note"
  | "malformed_m1_note"
  | "circuit_discrepancy"
  | "renewal_imminent"
  | "renewal_overdue"
  | "csa_unavailable";

export interface NotePreview {
  dealId: string;
  dealName: string;
  htmlContent: string;
}

export interface RenewalEntry {
  currentDealId: string;
  currentDealName: string;
  company: string;
  /** True when the company also has an active prorated extension deal in HubSpot.
   *  Extension deals themselves are excluded from this list entirely. */
  hasExtension: boolean;
  msiYear: number | null;
  nextMsiYear: number | null;
  orderFormLicense: number | null;
  currentYearLicense: number | null;
  csaCount: number | null;
  csaRounded: number | null;
  renewalCount: number | null;
  renewalDealId: string | null;
  renewalDealName: string;
  renewalStartDate: string;
  expirationDate: string;
  m1NoteHtml: string | null;
  m1NoteId: string | null;
  nocInstanceId?: number | null;
  /** CSA instance name for this company (used as the sheet row matching key). */
  csaInstanceName?: string | null;
  /** Human-readable note to write to the sheet Notes column. */
  sheetNote?: string | null;
  /** Extension product names active for this company, e.g. ["POM", "Fiber Clarity"]. */
  extensionNames?: string[];
  processed?: boolean;
  cancelled?: boolean;
  /** True when this company's CSA data spans multiple records sharing the same
   *  instance ID (e.g. a sub-tenant). The displayed circuit count is already the
   *  sum, but the entry is flagged so you can double-check the breakdown. */
  multiTenant?: boolean;
}

export interface TaskCreate {
  dealId: string;
  subject: string;
  dueDate?: string;
  priority?: "LOW" | "MEDIUM" | "HIGH";
  notes?: string;
}
