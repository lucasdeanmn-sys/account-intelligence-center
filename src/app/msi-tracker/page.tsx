"use client";

import { useState, useEffect, useRef } from "react";
import {
  Search,
  Loader2,
  AlertCircle,
  CheckCircle,
  ChevronDown,
  ChevronUp,
  Mail,
  X,
  Plus,
  RefreshCw,
} from "lucide-react";
import type { RenewalEntry } from "@/lib/types";
import type { CsaInstance } from "@/lib/csa";

interface CsaOverride {
  instanceId: number;
  instanceName: string;
}
const CSA_OVERRIDES_KEY = "csaOverrides_v1";
const cancelledKey = (expirationDate: string) => `msi_cancelled_${expirationDate}`;
// Secondary key stores company names — more resilient than deal IDs if the matching
// algorithm selects a different deal record for the same company between runs.
const cancelledCoKey = (expirationDate: string) => `msi_cancelled_co_${expirationDate}`;
// Tertiary key stores noc_instance_id values — most stable signal since it lives on
// the company object, not the deal.  Survives deal-name changes (NTS→Vexus) and
// any deal-ID churn between report runs.
const cancelledNocKey = (expirationDate: string) => `msi_cancelled_noc_${expirationDate}`;
// Quaternary key stores CSA instance names — authoritative name from the external
// CSA system, independent of HubSpot deal/company naming.
const cancelledCsaKey = (expirationDate: string) => `msi_cancelled_csa_${expirationDate}`;
// Quinary key stores HubSpot company object IDs — the most stable HubSpot
// identifier (never changes even through renames), returned by the cancel route.
const cancelledCoIdKey = (expirationDate: string) => `msi_cancelled_coid_${expirationDate}`;

// ─── Confirmation Modal ───────────────────────────────────────────────────────

interface ConfirmModalProps {
  entry: RenewalEntry;
  onCancel: () => void;
  onConfirm: () => Promise<void>;
}

function ConfirmModal({ entry, onCancel, onConfirm }: ConfirmModalProps) {
  const [processing, setProcessing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleConfirm() {
    setProcessing(true);
    setError(null);
    try {
      await onConfirm();
    } catch (e: any) {
      setError(e.message ?? "Something went wrong");
      setProcessing(false);
    }
  }

  const expDate = new Date(entry.expirationDate + "T00:00:00.000Z").toLocaleDateString("en-US", {
    month: "2-digit", day: "2-digit", year: "numeric", timeZone: "UTC",
  });
  const renewStart = new Date(entry.renewalStartDate + "T00:00:00.000Z").toLocaleDateString("en-US", {
    month: "2-digit", day: "2-digit", year: "numeric", timeZone: "UTC",
  });

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ backgroundColor: "rgba(0,0,0,0.7)" }}>
      <div className="w-full max-w-lg rounded-2xl border shadow-2xl" style={{ backgroundColor: "#1a1d27", borderColor: "#252836" }}>
        {/* Header */}
        <div className="flex items-center justify-between p-5 border-b" style={{ borderColor: "#252836" }}>
          <div>
            <h2 className="text-base font-semibold text-white">Confirm Renewal Processing</h2>
            <p className="text-xs mt-0.5" style={{ color: "#64748b" }}>{entry.company}</p>
          </div>
          <button onClick={onCancel} style={{ color: "#64748b" }} className="hover:text-white transition-colors">
            <X size={18} />
          </button>
        </div>

        {/* Body */}
        <div className="p-5 space-y-4">
          {/* Renewal Deal */}
          <div className="rounded-xl p-4 border" style={{ backgroundColor: "#0f1117", borderColor: "#252836" }}>
            <p className="text-xs font-medium mb-2" style={{ color: "#64748b" }}>RENEWAL DEAL</p>
            <div className="flex items-start gap-2">
              {entry.renewalDealId ? (
                <RefreshCw size={14} className="mt-0.5 shrink-0" style={{ color: "#6366f1" }} />
              ) : (
                <Plus size={14} className="mt-0.5 shrink-0" style={{ color: "#22c55e" }} />
              )}
              <div>
                <p className="text-sm font-medium text-white">{entry.renewalDealName}</p>
                <p className="text-xs mt-0.5" style={{ color: "#64748b" }}>
                  {entry.renewalDealId ? "Update existing deal" : "Create new deal"}
                  {" · "}Term start: {renewStart}
                </p>
              </div>
            </div>
          </div>

          {/* Circuit Count */}
          <div className="rounded-xl p-4 border" style={{ backgroundColor: "#0f1117", borderColor: "#252836" }}>
            <p className="text-xs font-medium mb-2" style={{ color: "#64748b" }}>RENEWAL COUNT</p>
            <p className="text-xl font-bold" style={{ color: "#a5b4fc" }}>
              {entry.renewalCount?.toLocaleString() ?? "TBD"} circuits
            </p>
            <div className="flex gap-4 mt-2">
              {entry.csaRounded !== null && (
                <p className="text-xs" style={{ color: "#64748b" }}>
                  CSA: {entry.csaCount?.toLocaleString() ?? "—"} → rounded: {entry.csaRounded.toLocaleString()}
                </p>
              )}
              {entry.orderFormLicense !== null && (
                <p className="text-xs" style={{ color: "#64748b" }}>
                  Order form: {entry.orderFormLicense.toLocaleString()}
                </p>
              )}
            </div>
          </div>

          {/* Actions */}
          <div className="space-y-2">
            <div className="flex items-center gap-2 text-sm">
              <CheckCircle size={13} style={{ color: "#22c55e" }} />
              <span style={{ color: "#94a3b8" }}>
                Set renewal deal to{" "}
                <span className="text-white font-medium">Closed Won — Ready for Billing</span>
                {" · "}Close date: <span className="text-white font-medium">{expDate}</span>
              </span>
            </div>
            {entry.orderFormLicense === null && entry.m1NoteId && entry.nextMsiYear && (
              <div className="flex items-center gap-2 text-sm">
                <CheckCircle size={13} style={{ color: "#22c55e" }} />
                <span style={{ color: "#94a3b8" }}>
                  Add <em style={{ color: "#c4b5fd" }}>italic</em> Year {entry.nextMsiYear} entry to M1 note{" "}
                  <span style={{ color: "#6366f1" }}>({entry.renewalCount?.toLocaleString()} circuits)</span>
                </span>
              </div>
            )}
            {entry.hasExtension && (
              <div className="flex items-center gap-2 text-sm">
                <CheckCircle size={13} style={{ color: "#f59e0b" }} />
                <span style={{ color: "#94a3b8" }}>
                  Copy <span className="text-white font-medium">extension line items</span> to renewal deal
                </span>
              </div>
            )}
            <div className="flex items-center gap-2 text-sm">
              <CheckCircle size={13} style={{ color: "#22c55e" }} />
              <span style={{ color: "#94a3b8" }}>
                Set <span className="text-white font-medium">Service Terminated</span> on{" "}
                <span className="text-white font-medium">{entry.currentDealName}</span>
                {" → "}{expDate}
              </span>
            </div>
            <div className="flex items-center gap-2 text-sm">
              <CheckCircle size={13} style={{ color: "#22c55e" }} />
              <span style={{ color: "#94a3b8" }}>Append row to MSI Renewal/Term Worksheet</span>
            </div>
          </div>

          {error && (
            <div className="flex items-center gap-2 text-sm p-3 rounded-lg" style={{ backgroundColor: "#ef444415", color: "#ef4444" }}>
              <AlertCircle size={13} />
              {error}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex gap-3 p-5 border-t" style={{ borderColor: "#252836" }}>
          <button
            onClick={onCancel}
            disabled={processing}
            className="flex-1 py-2 rounded-lg text-sm font-medium border transition-colors disabled:opacity-50"
            style={{ borderColor: "#252836", color: "#94a3b8" }}
          >
            Cancel
          </button>
          <button
            onClick={handleConfirm}
            disabled={processing}
            className="flex-1 py-2 rounded-lg text-sm font-medium transition-colors disabled:opacity-50"
            style={{ backgroundColor: "#6366f1", color: "white" }}
          >
            {processing ? (
              <span className="flex items-center justify-center gap-2">
                <Loader2 size={13} className="animate-spin" />
                Processing…
              </span>
            ) : (
              "Confirm & Process"
            )}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Email Modal ──────────────────────────────────────────────────────────────

interface EmailModalProps {
  subject: string;
  body: string;
  to: string[];
  deals: RenewalEntry[];
  onClose: () => void;
}

function EmailModal({ subject, body, to, deals, onClose }: EmailModalProps) {
  const [copied, setCopied] = useState(false);
  const [italicizing, setItalicizing] = useState(false);
  const [italicizeResult, setItalicizeResult] = useState<{ updated: number; skipped: number; errors: number } | null>(null);

  function copy() {
    navigator.clipboard.writeText(body);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  async function updateM1Notes() {
    setItalicizing(true);
    setItalicizeResult(null);
    try {
      const res = await fetch("/api/msi-renewals/italicize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ deals }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      const results: { status: string }[] = data.results ?? [];
      setItalicizeResult({
        updated: results.filter((r) => r.status === "updated").length,
        skipped: results.filter((r) => r.status === "skipped").length,
        errors: results.filter((r) => r.status === "error").length,
      });
    } catch (e: any) {
      setItalicizeResult({ updated: 0, skipped: 0, errors: 1 });
    } finally {
      setItalicizing(false);
    }
  }

  const gmailUrl =
    `https://mail.google.com/mail/?view=cm&fs=1` +
    `&to=${encodeURIComponent(to.join(","))}` +
    `&su=${encodeURIComponent(subject)}` +
    `&body=${encodeURIComponent(body)}`;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ backgroundColor: "rgba(0,0,0,0.7)" }}>
      <div className="w-full max-w-2xl rounded-2xl border shadow-2xl flex flex-col max-h-[85vh]" style={{ backgroundColor: "#1a1d27", borderColor: "#252836" }}>
        <div className="flex items-center justify-between p-5 border-b shrink-0" style={{ borderColor: "#252836" }}>
          <div>
            <h2 className="text-base font-semibold text-white">Renewal Email Draft</h2>
            <p className="text-xs mt-0.5" style={{ color: "#64748b" }}>To: {to.join(", ")}</p>
          </div>
          <button onClick={onClose} style={{ color: "#64748b" }} className="hover:text-white transition-colors">
            <X size={18} />
          </button>
        </div>
        <div className="p-5 overflow-y-auto flex-1">
          <p className="text-xs mb-1" style={{ color: "#64748b" }}>Subject</p>
          <p className="text-sm text-white mb-4 font-medium">{subject}</p>
          <p className="text-xs mb-1" style={{ color: "#64748b" }}>Body</p>
          <pre className="text-sm whitespace-pre-wrap leading-relaxed" style={{ color: "#94a3b8" }}>{body}</pre>
        </div>

        {/* Italicize result banner */}
        {italicizeResult && (
          <div className="mx-5 mb-2 px-4 py-2.5 rounded-lg text-xs flex items-center gap-2"
            style={{
              backgroundColor: italicizeResult.errors > 0 ? "#ef444415" : "#22c55e15",
              color: italicizeResult.errors > 0 ? "#ef4444" : "#22c55e",
            }}>
            <CheckCircle size={13} />
            {italicizeResult.errors > 0
              ? `${italicizeResult.errors} error(s) — ${italicizeResult.updated} updated, ${italicizeResult.skipped} skipped`
              : `M1 notes updated: ${italicizeResult.updated} italicized, ${italicizeResult.skipped} skipped`}
          </div>
        )}

        <div className="flex gap-3 p-5 border-t shrink-0" style={{ borderColor: "#252836" }}>
          <button
            onClick={copy}
            className="py-2 px-4 rounded-lg text-sm font-medium border transition-colors"
            style={{ borderColor: "#252836", color: "#94a3b8" }}
          >
            {copied ? "Copied!" : "Copy Body"}
          </button>
          <button
            onClick={updateM1Notes}
            disabled={italicizing || italicizeResult?.updated !== undefined && italicizeResult.errors === 0}
            className="py-2 px-4 rounded-lg text-sm font-medium border transition-colors disabled:opacity-50 flex items-center gap-2"
            style={{ borderColor: "#252836", color: "#94a3b8" }}
          >
            {italicizing ? <Loader2 size={13} className="animate-spin" /> : <CheckCircle size={13} />}
            {italicizing ? "Updating…" : "Update M1 Notes"}
          </button>
          <a
            href={gmailUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="flex-1 py-2 rounded-lg text-sm font-medium text-center transition-colors"
            style={{ backgroundColor: "#6366f1", color: "white" }}
          >
            Open in Gmail
          </a>
        </div>
      </div>
    </div>
  );
}

// ─── Cancel Modal ─────────────────────────────────────────────────────────────

interface CancelModalProps {
  entry: RenewalEntry;
  onClose: () => void;
  onConfirm: () => Promise<void>;
}

function CancelModal({ entry, onClose, onConfirm }: CancelModalProps) {
  const [processing, setProcessing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleConfirm() {
    setProcessing(true);
    setError(null);
    try {
      await onConfirm();
    } catch (e: any) {
      setError(e.message ?? "Something went wrong");
      setProcessing(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ backgroundColor: "rgba(0,0,0,0.7)" }}>
      <div className="w-full max-w-md rounded-2xl border shadow-2xl" style={{ backgroundColor: "#1a1d27", borderColor: "#252836" }}>
        <div className="flex items-center justify-between p-5 border-b" style={{ borderColor: "#252836" }}>
          <div>
            <h2 className="text-base font-semibold text-white">Mark as Did Not Renew</h2>
            <p className="text-xs mt-0.5" style={{ color: "#64748b" }}>{entry.company}</p>
          </div>
          <button onClick={onClose} style={{ color: "#64748b" }} className="hover:text-white transition-colors">
            <X size={18} />
          </button>
        </div>
        <div className="p-5 space-y-3">
          <p className="text-sm" style={{ color: "#94a3b8" }}>This will:</p>
          <ul className="text-sm space-y-1.5" style={{ color: "#64748b" }}>
            <li className="flex items-start gap-2"><span style={{ color: "#ef4444" }}>•</span> Prepend <strong className="text-white">"Did not renew"</strong> to the top of the M1 note in HubSpot</li>
            <li className="flex items-start gap-2"><span style={{ color: "#ef4444" }}>•</span> Highlight the row red on the Google Sheet</li>
            <li className="flex items-start gap-2"><span style={{ color: "#ef4444" }}>•</span> Exclude this account from the renewal email</li>
          </ul>
          {error && (
            <p className="text-xs mt-2" style={{ color: "#ef4444" }}>{error}</p>
          )}
        </div>
        <div className="flex gap-3 p-5 border-t" style={{ borderColor: "#252836" }}>
          <button
            onClick={onClose}
            className="flex-1 py-2 rounded-lg text-sm font-medium border transition-colors"
            style={{ borderColor: "#252836", color: "#94a3b8" }}
          >
            Go Back
          </button>
          <button
            onClick={handleConfirm}
            disabled={processing}
            className="flex-1 py-2 rounded-lg text-sm font-medium transition-colors disabled:opacity-50"
            style={{ backgroundColor: "#ef444420", color: "#ef4444", border: "1px solid #ef444430" }}
          >
            {processing ? "Marking…" : "Confirm — Did Not Renew"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Deal Row ─────────────────────────────────────────────────────────────────

interface DealRowProps {
  entry: RenewalEntry;
  onProcess: (entry: RenewalEntry) => void;
  onCancel: (entry: RenewalEntry) => void;
  onUnprocess: (entry: RenewalEntry) => void;
}

function DealRow({ entry, onProcess, onCancel, onUnprocess }: DealRowProps) {
  const [showNote, setShowNote] = useState(false);

  const renewalHigher =
    entry.renewalCount !== null &&
    entry.orderFormLicense !== null &&
    entry.renewalCount > entry.orderFormLicense;

  return (
    <div className="rounded-xl border" style={{ backgroundColor: entry.cancelled ? "#ef444408" : "#1a1d27", borderColor: entry.cancelled ? "#ef444430" : entry.processed ? "#22c55e30" : "#252836" }}>
      <div className="flex items-center gap-4 p-4">
        {/* Company */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <p className="text-sm font-semibold text-white truncate">{entry.company}</p>
            {entry.hasExtension && (
              <span className="hidden sm:inline-flex shrink-0 text-xs px-1.5 py-0.5 rounded" style={{ backgroundColor: "#f59e0b15", color: "#f59e0b" }}
                title="This company has an active prorated extension deal in HubSpot">
                Has Extension
              </span>
            )}
            {entry.multiTenant && (
              <span className="hidden sm:inline-flex shrink-0 text-xs px-1.5 py-0.5 rounded" style={{ backgroundColor: "#f9731615", color: "#fb923c" }}
                title="Multiple CSA records share this instance ID — CSA count is the sum. Verify the individual tenant counts before processing.">
                Multi-tenant
              </span>
            )}
            {entry.needsReview && (
              <span className="hidden sm:inline-flex shrink-0 text-xs px-1.5 py-0.5 rounded" style={{ backgroundColor: "#ef444415", color: "#ef4444" }}
                title={entry.needsReviewReason ?? "M1 note failed a sanity check — review the note before trusting the year math."}>
                Needs Review
              </span>
            )}
            {entry.orderFormLicense === null && entry.currentYearLicense !== null && (
              <span className="hidden sm:inline-flex shrink-0 text-xs px-1.5 py-0.5 rounded" style={{ backgroundColor: "#3b82f615", color: "#60a5fa" }}>
                Auto-renew
              </span>
            )}
            {entry.orderFormLicense === null && entry.currentYearLicense === null && !entry.m1NoteId && (
              <span className="hidden sm:inline-flex shrink-0 text-xs px-1.5 py-0.5 rounded" style={{ backgroundColor: "#ef444415", color: "#ef4444" }}>
                No M1 note
              </span>
            )}
          </div>
          <p className="text-xs mt-0.5 truncate" style={{ color: "#64748b" }}>
            {entry.currentDealName}
            {entry.msiYear && ` · Year ${entry.msiYear} → ${entry.nextMsiYear ?? "?"}`}
          </p>
          {entry.needsReview && entry.needsReviewReason && (
            <p className="text-xs mt-1 truncate" style={{ color: "#8b93a7" }} title={entry.needsReviewReason}>
              <span style={{ color: "#f87171" }}>⚠ </span>
              {entry.needsReviewReason}
            </p>
          )}
        </div>

        {/* Data columns */}
        <div className="hidden sm:flex items-center gap-6">
          <div className="text-right w-20">
            <p className="text-sm font-medium text-white">
              {(entry.orderFormLicense ?? entry.currentYearLicense)?.toLocaleString() ?? "—"}
            </p>
          </div>
          <div className="text-right w-20">
            <p className="text-sm font-medium text-white">
              {entry.csaCount !== null ? entry.csaCount.toLocaleString() : "—"}
            </p>
          </div>
          <div className="text-right w-24">
            <p className="text-sm font-medium text-white">
              {entry.csaRounded?.toLocaleString() ?? "—"}
            </p>
          </div>
          <div className="text-right w-28">
            <p className="text-sm font-bold" style={{ color: renewalHigher ? "#f59e0b" : "#a5b4fc" }}>
              {entry.renewalCount?.toLocaleString() ?? "—"}
            </p>
          </div>
        </div>

        {/* Actions */}
        <div className="flex items-center gap-2 shrink-0">
          {entry.m1NoteHtml && (
            <button
              onClick={() => setShowNote((v) => !v)}
              className="p-1.5 rounded-lg transition-colors"
              style={{ color: "#64748b" }}
              title="Toggle M1 note"
            >
              {showNote ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
            </button>
          )}
          {entry.cancelled ? (
            <span className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium" style={{ backgroundColor: "#ef444420", color: "#ef4444" }}>
              <X size={12} />
              Cancelled
            </span>
          ) : entry.processed ? (
            <div className="flex items-center gap-1">
              <button
                onClick={() => onProcess(entry)}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-opacity hover:opacity-70"
                style={{ backgroundColor: "#22c55e20", color: "#22c55e" }}
                title="Re-process (safe to repeat)"
              >
                <CheckCircle size={12} />
                Processed
              </button>
              <button
                onClick={() => onUnprocess(entry)}
                className="p-1.5 rounded-lg transition-colors hover:opacity-70"
                style={{ color: "#64748b" }}
                title="Undo — clear processed state so this deal can be re-processed"
              >
                <RefreshCw size={13} />
              </button>
            </div>
          ) : entry.platform === "NOC360" ? (
            <span
              className="text-xs px-3 py-1.5"
              style={{ color: "#64748b" }}
              title="NOC360 renewal from CSA — reported to Joan via the section email, nothing to process here."
            >
              CSA renewal
            </span>
          ) : entry.unmatchedCsa ? (
            <span
              className="text-xs px-3 py-1.5"
              style={{ color: "#64748b" }}
              title="No HubSpot deal matched this CSA renewal — create or fix the deal in HubSpot, then reload."
            >
              No deal to process
            </span>
          ) : (
            <>
              <button
                onClick={() => onCancel(entry)}
                className="px-3 py-1.5 rounded-lg text-xs font-medium transition-colors"
                style={{ backgroundColor: "#ef444415", color: "#ef4444", border: "1px solid #ef444430" }}
              >
                Cancel
              </button>
              <button
                onClick={() => onProcess(entry)}
                className="px-3 py-1.5 rounded-lg text-xs font-medium transition-colors"
                style={{ backgroundColor: "#6366f120", color: "#a5b4fc", border: "1px solid #6366f140" }}
              >
                Process
              </button>
            </>
          )}
        </div>
      </div>

      {/* Mobile data */}
      <div className="flex sm:hidden gap-4 px-4 pb-3 text-sm">
        <span style={{ color: "#64748b" }}>OF: <span className="text-white">{(entry.orderFormLicense ?? entry.currentYearLicense)?.toLocaleString() ?? "—"}</span></span>
        <span style={{ color: "#64748b" }}>CSA: <span className="text-white">{entry.csaCount?.toLocaleString() ?? "—"}</span></span>
        <span style={{ color: "#64748b" }}>Renewal: <span style={{ color: "#a5b4fc", fontWeight: 600 }}>{entry.renewalCount?.toLocaleString() ?? "—"}</span></span>
      </div>

      {/* M1 Note */}
      {showNote && entry.m1NoteHtml && (
        <div
          className="mx-4 mb-4 p-3 rounded-lg text-xs"
          style={{ backgroundColor: "#0f1117", color: "#94a3b8" }}
        >
          <p className="text-xs mb-1.5 font-medium" style={{ color: "#475569" }}>M1 Note</p>
          <div dangerouslySetInnerHTML={{ __html: entry.m1NoteHtml }} className="leading-relaxed [&_i]:text-slate-500 [&_em]:text-slate-500" />
        </div>
      )}
    </div>
  );
}

// ─── CSA Mapping Panel ────────────────────────────────────────────────────────

interface CsaMappingPanelProps {
  deals: RenewalEntry[];
  instances: CsaInstance[];
  overrides: Record<string, CsaOverride>;
  onLink: (company: string, instanceName: string) => void;
  onClear: (company: string) => void;
}

function CsaMappingPanel({ deals, instances, overrides, onLink, onClear }: CsaMappingPanelProps) {
  const unmatched = deals.filter((d) => d.csaCount === null);
  if (!unmatched.length) return null;

  // Sort instances alphabetically for the datalist
  const sorted = [...instances].sort((a, b) => a.instanceName.localeCompare(b.instanceName));

  return (
    <div className="mt-4 rounded-xl border p-4" style={{ backgroundColor: "#1a1d27", borderColor: "#252836" }}>
      <p className="text-xs font-semibold mb-1" style={{ color: "#f59e0b" }}>
        CSA — {unmatched.length} unmatched {unmatched.length === 1 ? "company" : "companies"}
      </p>
      <p className="text-xs mb-4" style={{ color: "#475569" }}>
        Link each company to its CSA instance. Matches are saved and used on future fetches.
      </p>

      {/* Hidden datalist for all instances.
          ID is shown first so typing a customer number filters to the right instance.
          The value stays as instanceName so the link logic fires on selection. */}
      <datalist id="csa-instance-list">
        {sorted.map((i) => (
          <option key={i.instanceName} value={i.instanceName}>
            {i.instanceId != null ? `${i.instanceId} · ` : ""}{i.instanceName} · {i.circuits.toLocaleString()} circuits{i.domain ? ` · ${i.domain}` : ""}
          </option>
        ))}
      </datalist>

      <div className="space-y-2">
        {unmatched.map((d) => (
          <CsaMatchRow
            key={d.currentDealId}
            company={d.company}
            override={overrides[d.company]}
            instances={sorted}
            onLink={onLink}
            onClear={onClear}
          />
        ))}
      </div>
    </div>
  );
}

interface CsaMatchRowProps {
  company: string;
  override: CsaOverride | undefined;
  instances: CsaInstance[];
  onLink: (company: string, instanceName: string) => void;
  onClear: (company: string) => void;
}

function CsaMatchRow({ company, override, instances, onLink, onClear }: CsaMatchRowProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState(override?.instanceName ?? "");

  // Keep input in sync when override changes externally
  useEffect(() => {
    setQuery(override?.instanceName ?? "");
  }, [override?.instanceName]);

  function handleChange(e: React.ChangeEvent<HTMLInputElement>) {
    const val = e.target.value;
    setQuery(val);
    // Match by instance name (normal datalist selection)
    let match = instances.find((i) => i.instanceName === val);
    if (match) { onLink(company, val); return; }
    // Match by instance ID — if the user types a raw number (the customer number
    // from HubSpot), find the instance and swap the query to the name.
    if (/^\d+$/.test(val.trim())) {
      const numId = parseInt(val.trim(), 10);
      match = instances.find((i) => i.instanceId === numId);
      if (match) {
        setQuery(match.instanceName);
        onLink(company, match.instanceName);
      }
    }
  }

  function handleClear() {
    setQuery("");
    onClear(company);
    inputRef.current?.focus();
  }

  return (
    <div className="flex items-center gap-3">
      <p className="text-sm text-white w-48 shrink-0 truncate" title={company}>{company}</p>
      <div className="flex items-center gap-1 flex-1 min-w-0">
        <input
          ref={inputRef}
          list="csa-instance-list"
          value={query}
          onChange={handleChange}
          placeholder="Search CSA instance…"
          className="flex-1 min-w-0 px-3 py-1.5 rounded-lg border text-sm text-white focus:outline-none focus:border-indigo-500"
          style={{ backgroundColor: "#0f1117", borderColor: query ? "#6366f1" : "#252836" }}
        />
        {query && (
          <button
            onClick={handleClear}
            className="p-1.5 rounded-lg transition-colors"
            style={{ color: "#64748b" }}
            title="Clear"
          >
            <X size={13} />
          </button>
        )}
      </div>
      {override && (
        <span className="text-xs shrink-0" style={{ color: "#22c55e" }}>
          Linked · ID {override.instanceId}
        </span>
      )}
    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

const currentYear = new Date().getFullYear();
const YEARS = Array.from({ length: 5 }, (_, i) => currentYear - 1 + i);

export default function MSITrackerPage() {
  const now = new Date();
  const [month, setMonth] = useState(String(now.getMonth() + 1)); // 1-12
  const [year, setYear] = useState(String(now.getFullYear()));
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deals, setDeals] = useState<RenewalEntry[]>([]);
  const [expirationDate, setExpirationDate] = useState("");
  const [renewalStartDate, setRenewalStartDate] = useState("");

  const [confirmEntry, setConfirmEntry] = useState<RenewalEntry | null>(null);
  const [cancelEntry, setCancelEntry] = useState<RenewalEntry | null>(null);
  const [sheetWarning, setSheetWarning] = useState<string | null>(null);
  const [emailModal, setEmailModal] = useState<{ subject: string; body: string; to: string[] } | null>(null);
  const [emailLoading, setEmailLoading] = useState(false);
  const [csaInstances, setCsaInstances] = useState<CsaInstance[]>([]);
  const [csaError, setCsaError] = useState<string | null>(null);
  const [csaOverrides, setCsaOverrides] = useState<Record<string, CsaOverride>>(() => {
    try { return JSON.parse(localStorage.getItem(CSA_OVERRIDES_KEY) ?? "{}"); }
    catch { return {}; }
  });

  // Persist overrides to localStorage whenever they change
  useEffect(() => {
    localStorage.setItem(CSA_OVERRIDES_KEY, JSON.stringify(csaOverrides));
  }, [csaOverrides]);

  // Persist cancelled deal IDs + company names in localStorage keyed by expiration date.
  // Two parallel keys: deal IDs (fast exact match) and company names (resilient to
  // deal-ID changes if the matching algorithm picks a different record between runs).
  const [cancelledIds, setCancelledIds] = useState<Set<string>>(new Set());
  function loadCancelledIds(expDate: string) {
    try {
      const stored = JSON.parse(localStorage.getItem(cancelledKey(expDate)) ?? "[]");
      return new Set<string>(stored);
    } catch { return new Set<string>(); }
  }
  function loadCancelledCompanies(expDate: string) {
    try {
      const stored = JSON.parse(localStorage.getItem(cancelledCoKey(expDate)) ?? "[]");
      return new Set<string>(stored);
    } catch { return new Set<string>(); }
  }
  function loadCancelledNocIds(expDate: string) {
    try {
      const stored = JSON.parse(localStorage.getItem(cancelledNocKey(expDate)) ?? "[]");
      return new Set<string>(stored);
    } catch { return new Set<string>(); }
  }
  function loadCancelledCsaNames(expDate: string) {
    try {
      const stored = JSON.parse(localStorage.getItem(cancelledCsaKey(expDate)) ?? "[]");
      return new Set<string>(stored);
    } catch { return new Set<string>(); }
  }
  function loadCancelledCoIds(expDate: string) {
    try {
      const stored = JSON.parse(localStorage.getItem(cancelledCoIdKey(expDate)) ?? "[]");
      return new Set<string>(stored);
    } catch { return new Set<string>(); }
  }
  function persistCancelledId(
    expDate: string,
    dealId: string,
    company: string,
    nocId?: number | null,
    csaName?: string | null,
    hsCompanyId?: string | null,
  ) {
    const ids = loadCancelledIds(expDate);
    ids.add(dealId);
    localStorage.setItem(cancelledKey(expDate), JSON.stringify(Array.from(ids)));

    const cos = loadCancelledCompanies(expDate);
    cos.add(company.trim().toLowerCase());
    localStorage.setItem(cancelledCoKey(expDate), JSON.stringify(Array.from(cos)));

    if (nocId != null) {
      const nocs = loadCancelledNocIds(expDate);
      nocs.add(String(nocId));
      localStorage.setItem(cancelledNocKey(expDate), JSON.stringify(Array.from(nocs)));
    }
    if (csaName) {
      const csas = loadCancelledCsaNames(expDate);
      csas.add(csaName.trim().toLowerCase());
      localStorage.setItem(cancelledCsaKey(expDate), JSON.stringify(Array.from(csas)));
    }
    if (hsCompanyId) {
      const coids = loadCancelledCoIds(expDate);
      coids.add(hsCompanyId);
      localStorage.setItem(cancelledCoIdKey(expDate), JSON.stringify(Array.from(coids)));
    }
    setCancelledIds(new Set(ids));
    console.log("[MSI cancel] persisted for expDate:", expDate, {
      dealId, company: company.trim().toLowerCase(),
      nocId, csaName, hsCompanyId,
      storedIds: Array.from(ids),
      storedCos: Array.from(loadCancelledCompanies(expDate)),
    });
  }

  function applyOverride(company: string, instanceName: string) {
    const inst = csaInstances.find((i) => i.instanceName === instanceName);
    if (!inst) return;
    const override: CsaOverride = { instanceId: inst.instanceId ?? 0, instanceName };
    setCsaOverrides((prev) => ({ ...prev, [company]: override }));
    // Update the deal immediately from already-fetched data
    setDeals((prev) =>
      prev.map((d) => {
        if (d.company !== company) return d;
        const csaCount = inst.circuits;
        const csaRounded = Math.max(1000, Math.ceil(csaCount / 50) * 50);
        let renewalCount: number | null = null;
        if (d.orderFormLicense !== null) {
          renewalCount = d.orderFormLicense;
        } else {
          renewalCount = Math.max(csaRounded, d.currentYearLicense ?? 0);
        }
        return { ...d, csaCount, csaRounded, renewalCount, csaInstanceName: instanceName };
      })
    );
  }

  function clearOverride(company: string) {
    setCsaOverrides((prev) => {
      const next = { ...prev };
      delete next[company];
      return next;
    });
  }

  async function runReport() {
    if (!month || !year) return;
    setLoading(true);
    setError(null);
    setDeals([]);
    setCsaError(null);
    try {
      const res = await fetch(`/api/msi-renewals?month=${month}&year=${year}`);
      const text = await res.text();
      let data: any;
      try {
        data = JSON.parse(text);
      } catch {
        throw new Error(`API error: ${text.slice(0, 300)}`);
      }
      if (!res.ok) throw new Error(data.error || "Failed to fetch renewals");

      const instances: CsaInstance[] = data.csaInstances ?? [];
      setCsaInstances(instances);
      if (data.csaError) setCsaError(data.csaError);

      setExpirationDate(data.expirationDate ?? "");
      setRenewalStartDate(data.renewalStartDate ?? "");

      // Apply any stored overrides for companies that still have no CSA match
      const overrides = csaOverrides;
      const deals: RenewalEntry[] = (data.deals ?? []).map((d: RenewalEntry) => {
        if (d.csaCount !== null) return d; // already matched by ID
        const override = overrides[d.company];
        if (!override?.instanceName) return d;
        const inst = instances.find((i) => i.instanceName === override.instanceName);
        if (!inst) return d;
        const csaCount = inst.circuits;
        const csaRounded = Math.max(1000, Math.ceil(csaCount / 50) * 50);
        const renewalCount =
          d.orderFormLicense !== null
            ? d.orderFormLicense
            : Math.max(csaRounded, d.currentYearLicense ?? 0);
        return { ...d, csaCount, csaRounded, renewalCount };
      });

      // Merge locally-persisted cancellations.
      // Five parallel keys for maximum resilience:
      //   1. deal IDs          — fast exact match, but may change between runs
      //   2. company names     — survives deal-ID changes
      //   3. noc_instance_id   — company-object property, survives deal renames
      //   4. CSA instance name — from external CSA system, independent of HubSpot naming
      //   5. HubSpot company object ID — stored from cancel response, never changes
      const expDate = data.expirationDate ?? "";
      const storedCancelled    = loadCancelledIds(expDate);
      const storedCancelledCos = loadCancelledCompanies(expDate);
      const storedCancelledNocs = loadCancelledNocIds(expDate);
      const storedCancelledCsas = loadCancelledCsaNames(expDate);
      console.log("[MSI runReport] expDate:", expDate, {
        storedIds: Array.from(storedCancelled),
        storedCos: Array.from(storedCancelledCos),
        storedNocs: Array.from(storedCancelledNocs),
        storedCsas: Array.from(storedCancelledCsas),
        deals: deals.map((d) => ({
          id: d.currentDealId, company: d.company,
          csa: d.csaInstanceName, noc: d.nocInstanceId,
          serverCancelled: d.cancelled,
        })),
      });
      setCancelledIds(storedCancelled);
      setDeals(deals.map((d) => {
        if (d.cancelled) return d; // server already detected it — trust that
        const byId  = storedCancelled.has(d.currentDealId);
        const byCo  = storedCancelledCos.has(d.company.trim().toLowerCase());
        const byNoc = d.nocInstanceId != null && storedCancelledNocs.has(String(d.nocInstanceId));
        const byCSA = d.csaInstanceName != null && storedCancelledCsas.has(d.csaInstanceName.trim().toLowerCase());
        return byId || byCo || byNoc || byCSA ? { ...d, cancelled: true } : d;
      }));
    } catch (e: any) {
      setError(e.message || "Failed to load renewal data");
    } finally {
      setLoading(false);
    }
  }

  async function handleProcess(entry: RenewalEntry) {
    const res = await fetch("/api/msi-renewals/process", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        currentDealId: entry.currentDealId,
        renewalDealId: entry.renewalDealId,
        renewalDealName: entry.renewalDealName,
        renewalCount: entry.renewalCount,
        renewalStartDate: entry.renewalStartDate,
        expirationDate: entry.expirationDate,
        company: entry.company,
        orderFormLicense: entry.orderFormLicense,
        currentYearLicense: entry.currentYearLicense,
        csaCount: entry.csaCount,
        csaRounded: entry.csaRounded,
        m1NoteId: entry.m1NoteId,
        m1NoteHtml: entry.m1NoteHtml,
        nextMsiYear: entry.nextMsiYear,
        hasExtension: entry.hasExtension,
        csaInstanceName: entry.csaInstanceName ?? null,
        sheetNote: entry.sheetNote ?? null,
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Process failed");

    setDeals((prev) =>
      prev.map((d) =>
        d.currentDealId === entry.currentDealId
          ? { ...d, processed: true, renewalDealId: data.renewalDealId }
          : d
      )
    );

    if (data.sheetWriteError) {
      setSheetWarning(
        `Sheet write failed for ${entry.company}: ${data.sheetWriteError}. Re-process to retry.`
      );
    }

    setConfirmEntry(null);
  }

  async function handleUnprocess(entry: RenewalEntry) {
    const res = await fetch("/api/msi-renewals/unprocess", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        currentDealId: entry.currentDealId,
        renewalDealId: entry.renewalDealId ?? null,
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Unprocess failed");
    setDeals((prev) =>
      prev.map((d) =>
        d.currentDealId === entry.currentDealId
          ? { ...d, processed: false }
          : d
      )
    );
  }

  async function handleCancel(entry: RenewalEntry) {
    const res = await fetch("/api/msi-renewals/cancel", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        m1NoteId: entry.m1NoteId,
        m1NoteHtml: entry.m1NoteHtml,
        company: entry.company,
        expirationDate: entry.expirationDate,
        csaInstanceName: entry.csaInstanceName ?? null,
        currentDealId: entry.currentDealId,
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Cancel failed");
    persistCancelledId(
      entry.expirationDate,
      entry.currentDealId,
      entry.company,
      entry.nocInstanceId,
      entry.csaInstanceName ?? null,
      data.companyId ?? null,
    );
    setDeals((prev) =>
      prev.map((d) =>
        d.currentDealId === entry.currentDealId
          ? {
              ...d,
              cancelled: true,
              // Mirror the "Did not renew" prepend locally so that if the user
              // somehow triggers cancel again in this session the idempotency
              // check in cancel/route.ts sees the updated html and skips Step 1.
              m1NoteHtml: d.m1NoteHtml
                ? `<p><strong>Did not renew</strong></p>\n${d.m1NoteHtml}`
                : d.m1NoteHtml,
            }
          : d
      )
    );
    setCancelEntry(null);
  }

  async function generateEmail(platform: "MSI" | "NOC360" = "MSI") {
    setEmailLoading(true);
    try {
      const label = expirationDate
        ? new Date(expirationDate + "T00:00:00.000Z").toLocaleString("en-US", {
            month: "long", year: "numeric", timeZone: "UTC",
          })
        : "Renewals";
      const emailDeals =
        platform === "NOC360"
          ? noc360Deals
          : msiDeals.filter((d) => d.processed && !d.cancelled);
      const res = await fetch("/api/msi-renewals/email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          deals: emailDeals,
          monthLabel: label,
          platform,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setEmailModal(data);
    } catch (e: any) {
      setError(e.message || "Failed to generate email");
    } finally {
      setEmailLoading(false);
    }
  }

  const msiDeals = deals.filter((d) => d.platform !== "NOC360");
  const noc360Deals = deals.filter((d) => d.platform === "NOC360");
  const processedCount = msiDeals.filter((d) => d.processed).length;
  const expLabel = expirationDate
    ? new Date(expirationDate + "T00:00:00.000Z").toLocaleDateString("en-US", {
        month: "long", day: "numeric", year: "numeric", timeZone: "UTC",
      })
    : "";

  return (
    <div className="p-6 max-w-5xl mx-auto">
      {/* Header */}
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-white">MSI Renewal Processing</h1>
        <p className="text-sm mt-0.5" style={{ color: "#64748b" }}>
          Select the month and year deals are expiring to generate the renewal report
        </p>
      </div>

      {/* Month / Year picker */}
      <div className="flex items-end gap-3 mb-6">
        <div>
          <label className="block text-xs font-medium mb-1.5" style={{ color: "#64748b" }}>
            Expiration Month
          </label>
          <select
            value={month}
            onChange={(e) => setMonth(e.target.value)}
            className="px-3 py-2 rounded-lg border text-sm text-white focus:outline-none focus:border-indigo-500"
            style={{ borderColor: "#252836", backgroundColor: "#1a1d27" }}
          >
            {MONTHS.map((m, i) => (
              <option key={m} value={String(i + 1)}>{m}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-xs font-medium mb-1.5" style={{ color: "#64748b" }}>
            Year
          </label>
          <select
            value={year}
            onChange={(e) => setYear(e.target.value)}
            className="px-3 py-2 rounded-lg border text-sm text-white focus:outline-none focus:border-indigo-500"
            style={{ borderColor: "#252836", backgroundColor: "#1a1d27" }}
          >
            {YEARS.map((y) => (
              <option key={y} value={String(y)}>{y}</option>
            ))}
          </select>
        </div>
        <button
          onClick={runReport}
          disabled={loading}
          className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors disabled:opacity-50"
          style={{ backgroundColor: "#6366f1", color: "white" }}
        >
          {loading ? <Loader2 size={14} className="animate-spin" /> : <Search size={14} />}
          {loading ? "Loading…" : "Run Report"}
        </button>
      </div>

      {/* Error */}
      {error && (
        <div
          className="flex items-center gap-3 p-4 rounded-xl mb-4 border"
          style={{ backgroundColor: "#ef444415", borderColor: "#ef444430", color: "#ef4444" }}
        >
          <AlertCircle size={16} />
          <p className="text-sm">{error}</p>
        </div>
      )}

      {/* Sheet write warning */}
      {sheetWarning && (
        <div
          className="flex items-center justify-between gap-3 p-4 rounded-xl mb-4 border"
          style={{ backgroundColor: "#f59e0b15", borderColor: "#f59e0b30", color: "#f59e0b" }}
        >
          <div className="flex items-center gap-3">
            <AlertCircle size={16} className="shrink-0" />
            <p className="text-sm">{sheetWarning}</p>
          </div>
          <button onClick={() => setSheetWarning(null)} className="shrink-0 hover:opacity-70 transition-opacity">
            <X size={14} />
          </button>
        </div>
      )}

      {/* Summary bar */}
      {deals.length > 0 && (
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-4">
            <p className="text-sm font-medium text-white">
              {msiDeals.length} MSI deal{msiDeals.length !== 1 ? "s" : ""} expiring{" "}
              {expLabel && <span style={{ color: "#6366f1" }}>{expLabel}</span>}
            </p>
            {processedCount > 0 && (
              <span className="text-xs px-2 py-0.5 rounded-full" style={{ backgroundColor: "#22c55e20", color: "#22c55e" }}>
                {processedCount} / {msiDeals.length} processed
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            {/* CSA status badge */}
            {csaError ? (
              <span className="flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-lg"
                style={{ backgroundColor: "#f59e0b15", color: "#f59e0b" }}
                title={csaError}>
                <AlertCircle size={11} /> CSA unavailable
              </span>
            ) : deals.some((d) => d.csaCount !== null) ? (
              <span className="flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-lg"
                style={{ backgroundColor: "#22c55e15", color: "#22c55e" }}>
                <CheckCircle size={11} /> CSA loaded
              </span>
            ) : null}
            <button
              onClick={() => generateEmail("MSI")}
              disabled={emailLoading || msiDeals.length === 0}
              className="flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors disabled:opacity-50"
              style={{ borderColor: "#252836", color: "#94a3b8" }}
            >
              {emailLoading ? <Loader2 size={12} className="animate-spin" /> : <Mail size={12} />}
              Generate Email
            </button>
          </div>
        </div>
      )}

      {/* Column headers */}
      {deals.length > 0 && (
        <div className="hidden sm:flex items-center gap-4 px-4 mb-2">
          <div className="flex-1" />
          <div className="flex items-center gap-6">
            <p className="text-xs w-20 text-right" style={{ color: "#475569" }}>Order Form</p>
            <p className="text-xs w-20 text-right" style={{ color: "#475569" }}>CSA</p>
            <p className="text-xs w-24 text-right" style={{ color: "#475569" }}>Rounded</p>
            <p className="text-xs w-28 text-right" style={{ color: "#475569" }}>Renewal Count</p>
          </div>
          <div className="w-24" />
        </div>
      )}

      {/* Deal rows — MSI */}
      <div className="space-y-2">
        {msiDeals.map((entry) => (
          <DealRow
            key={entry.currentDealId}
            entry={entry}
            onProcess={(e) => setConfirmEntry(e)}
            onCancel={(e) => setCancelEntry(e)}
            onUnprocess={handleUnprocess}
          />
        ))}
      </div>

      {/* NOC360 renewals — CSA-only rows, emailed separately (to Joan) */}
      {noc360Deals.length > 0 && (
        <div className="mt-8">
          <div className="flex items-center justify-between mb-3">
            <p className="text-sm font-semibold text-white">
              NOC360 Renewals{" "}
              <span className="font-normal" style={{ color: "#64748b" }}>
                ({noc360Deals.length})
              </span>
            </p>
            <button
              onClick={() => generateEmail("NOC360")}
              disabled={emailLoading}
              className="flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors disabled:opacity-50"
              style={{ borderColor: "#252836", color: "#94a3b8" }}
            >
              {emailLoading ? <Loader2 size={12} className="animate-spin" /> : <Mail size={12} />}
              Generate Email (Joan)
            </button>
          </div>
          <div className="hidden sm:flex items-center gap-4 px-4 mb-2">
            <div className="flex-1" />
            <div className="flex items-center gap-6">
              <p className="text-xs w-20 text-right" style={{ color: "#475569" }}>License</p>
              <p className="text-xs w-20 text-right" style={{ color: "#475569" }}>CSA</p>
              <p className="text-xs w-24 text-right" style={{ color: "#475569" }}>Rounded</p>
              <p className="text-xs w-28 text-right" style={{ color: "#475569" }}>Renewal Count</p>
              <div className="w-[104px]" />
            </div>
          </div>
          <div className="space-y-2">
            {noc360Deals.map((entry) => (
              <DealRow
                key={entry.currentDealId}
                entry={entry}
                onProcess={(e) => setConfirmEntry(e)}
                onCancel={(e) => setCancelEntry(e)}
                onUnprocess={handleUnprocess}
              />
            ))}
          </div>
        </div>
      )}

      {/* CSA Mapping — shown after a fetch when some companies didn't auto-match */}
      {csaInstances.length > 0 && deals.some((d) => d.csaCount === null) && (
        <CsaMappingPanel
          deals={deals}
          instances={csaInstances}
          overrides={csaOverrides}
          onLink={applyOverride}
          onClear={clearOverride}
        />
      )}

      {/* Empty state */}
      {!loading && deals.length === 0 && !error && (
        <div className="text-center py-16" style={{ color: "#64748b" }}>
          <Search size={32} className="mx-auto mb-3 opacity-40" />
          <p className="text-sm">Select the expiration month and year, then run the report</p>
          <p className="text-xs mt-1">
            e.g., <span className="text-white">May 2026</span> finds all MSI deals expiring 05/31/2026
          </p>
        </div>
      )}

      {/* Confirm modal */}
      {confirmEntry && (
        <ConfirmModal
          entry={confirmEntry}
          onCancel={() => setConfirmEntry(null)}
          onConfirm={() => handleProcess(confirmEntry)}
        />
      )}

      {/* Cancel confirmation modal */}
      {cancelEntry && (
        <CancelModal
          entry={cancelEntry}
          onClose={() => setCancelEntry(null)}
          onConfirm={() => handleCancel(cancelEntry)}
        />
      )}

      {/* Email modal */}
      {emailModal && (
        <EmailModal
          subject={emailModal.subject}
          body={emailModal.body}
          to={emailModal.to}
          deals={deals}
          onClose={() => setEmailModal(null)}
        />
      )}
    </div>
  );
}
