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
  /** HubSpot deal object ID — attached server-side (not LLM output); required for note/task/line-item associations */
  dealId?: string;
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
  /** True when the M1 note failed a sanity check (missing/garbled title line,
   *  italicized years exceeding the term, or an ambiguous fully-italicized
   *  1-year form). The note needs manual cleanup — don't trust the year math. */
  needsReview?: boolean;
  /** Why the entry was flagged for review (null when needsReview is false). */
  needsReviewReason?: string | null;
  /** True for synthetic rows created from a CSA renewal instance that matched
   *  no HubSpot deal. These have no deal to process — fix HubSpot first. */
  unmatchedCsa?: boolean;
  /** Platform of the renewal: "MSI" (default) or "NOC360" (CSA-only rows,
   *  reported in their own section and emailed separately). */
  platform?: string | null;
  /** Contracted license count straight from the CSA snapshot (NOC360 rows). */
  csaLicenseCount?: number | null;
  /** Extension product names active for this company, e.g. ["POM", "Fiber Clarity"]. */
  extensionNames?: string[];
  processed?: boolean;
  cancelled?: boolean;
  /** True when this company's CSA data spans multiple records sharing the same
   *  instance ID (e.g. a sub-tenant). The displayed circuit count is already the
   *  sum, but the entry is flagged so you can double-check the breakdown. */
  multiTenant?: boolean;
  /** CSA account status for this company (Production / Staging / Disabled). */
  csaStatus?: string | null;
  /** True when CSA shows the account Disabled (churned) yet it isn't already
   *  marked cancelled — i.e. it would otherwise be billed. Surfaced so a
   *  termination isn't missed before the renewal email goes out. */
  terminationRisk?: boolean;
  /** True for a row recovered from the HubSpot billing queue (a renewal deal in
   *  a billing stage for this cycle that the normal date/CSA matching missed).
   *  Joan: "it's in the Hubspot billing que but not on this list." */
  billingQueueOnly?: boolean;
  /** Set when the signed M1 order form / note disagrees with what NOCAdmin
   *  (CSA snapshot) currently has — either the billing-cycle month or the
   *  contracted license count. Surfaces an "Update NOCAdmin" flag so the
   *  backend gets corrected before the stale value feeds the next renewal.
   *  Null when NOCAdmin and the order form agree (or data is missing). */
  nocAdminDrift?: {
    /** Which signals drifted: "cycle" (renewal month) and/or "count" (license count). */
    kinds: Array<"cycle" | "count">;
    /** Human-readable summary for the tooltip / notice. */
    message: string;
    /** M1 note "MSI Term" start month (1-12), when parsed. */
    noteMonth?: number | null;
    /** NOCAdmin/CSA renewal_date month (1-12), when known. */
    csaMonth?: number | null;
    /** Contracted license count from the M1 order form / note. */
    orderFormCount?: number | null;
    /** license_count NOCAdmin/CSA currently holds. */
    nocLicenseCount?: number | null;
  } | null;
}

export interface TaskCreate {
  dealId: string;
  subject: string;
  dueDate?: string;
  priority?: "LOW" | "MEDIUM" | "HIGH";
  notes?: string;
}
