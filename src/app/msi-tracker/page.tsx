"use client";

import { useState } from "react";
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

          {/* Actions on both deals */}
          <div className="space-y-2">
            <div className="flex items-center gap-2 text-sm">
              <CheckCircle size={13} style={{ color: "#22c55e" }} />
              <span style={{ color: "#94a3b8" }}>
                Move renewal deal to <span className="text-white font-medium">Closed Won</span>
                {" · "}Close date: <span className="text-white font-medium">{expDate}</span>
              </span>
            </div>
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
  onClose: () => void;
}

function EmailModal({ subject, body, to, onClose }: EmailModalProps) {
  const [copied, setCopied] = useState(false);

  function copy() {
    navigator.clipboard.writeText(body);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  const mailto = `mailto:${to.join(",")}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;

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
        <div className="flex gap-3 p-5 border-t shrink-0" style={{ borderColor: "#252836" }}>
          <button
            onClick={copy}
            className="flex-1 py-2 rounded-lg text-sm font-medium border transition-colors"
            style={{ borderColor: "#252836", color: "#94a3b8" }}
          >
            {copied ? "Copied!" : "Copy Body"}
          </button>
          <a
            href={mailto}
            className="flex-1 py-2 rounded-lg text-sm font-medium text-center transition-colors"
            style={{ backgroundColor: "#6366f1", color: "white" }}
          >
            Open in Mail
          </a>
        </div>
      </div>
    </div>
  );
}

// ─── Deal Row ─────────────────────────────────────────────────────────────────

interface DealRowProps {
  entry: RenewalEntry;
  onProcess: (entry: RenewalEntry) => void;
}

function DealRow({ entry, onProcess }: DealRowProps) {
  const [showNote, setShowNote] = useState(false);

  const renewalHigher =
    entry.renewalCount !== null &&
    entry.orderFormLicense !== null &&
    entry.renewalCount > entry.orderFormLicense;

  return (
    <div className="rounded-xl border" style={{ backgroundColor: "#1a1d27", borderColor: entry.processed ? "#22c55e30" : "#252836" }}>
      <div className="flex items-center gap-4 p-4">
        {/* Company */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <p className="text-sm font-semibold text-white truncate">{entry.company}</p>
            {entry.orderFormLicense === null && entry.csaCount === null && (
              <span className="hidden sm:inline-flex shrink-0 text-xs px-1.5 py-0.5 rounded" style={{ backgroundColor: "#f59e0b15", color: "#f59e0b" }}>
                No M1 data
              </span>
            )}
          </div>
          <p className="text-xs mt-0.5 truncate" style={{ color: "#64748b" }}>
            {entry.currentDealName}
            {entry.msiYear && ` · Year ${entry.msiYear} → ${entry.nextMsiYear ?? "?"}`}
          </p>
        </div>

        {/* Data columns */}
        <div className="hidden sm:flex items-center gap-6">
          <div className="text-right w-20">
            <p className="text-sm font-medium text-white">
              {entry.orderFormLicense?.toLocaleString() ?? "—"}
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
              {entry.renewalCount !== null
                ? `${entry.renewalCount.toLocaleString()}${renewalHigher && entry.orderFormLicense ? ` (${entry.orderFormLicense.toLocaleString()})` : ""}`
                : "—"}
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
          {entry.processed ? (
            <span className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium" style={{ backgroundColor: "#22c55e20", color: "#22c55e" }}>
              <CheckCircle size={12} />
              Processed
            </span>
          ) : (
            <button
              onClick={() => onProcess(entry)}
              className="px-3 py-1.5 rounded-lg text-xs font-medium transition-colors"
              style={{ backgroundColor: "#6366f120", color: "#a5b4fc", border: "1px solid #6366f140" }}
            >
              Process
            </button>
          )}
        </div>
      </div>

      {/* Mobile data */}
      <div className="flex sm:hidden gap-4 px-4 pb-3 text-sm">
        <span style={{ color: "#64748b" }}>OF: <span className="text-white">{entry.orderFormLicense?.toLocaleString() ?? "—"}</span></span>
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
  const [emailModal, setEmailModal] = useState<{ subject: string; body: string; to: string[] } | null>(null);
  const [emailLoading, setEmailLoading] = useState(false);

  async function runReport() {
    if (!month || !year) return;
    setLoading(true);
    setError(null);
    setDeals([]);
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
      setDeals(data.deals ?? []);
      setExpirationDate(data.expirationDate ?? "");
      setRenewalStartDate(data.renewalStartDate ?? "");
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
        csaCount: entry.csaCount,
        csaRounded: entry.csaRounded,
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
    setConfirmEntry(null);
  }

  async function generateEmail() {
    setEmailLoading(true);
    try {
      const label = expirationDate
        ? new Date(expirationDate + "T00:00:00.000Z").toLocaleString("en-US", {
            month: "long", year: "numeric", timeZone: "UTC",
          })
        : "Renewals";
      const res = await fetch("/api/msi-renewals/email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ deals, monthLabel: label }),
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

  const processedCount = deals.filter((d) => d.processed).length;
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

      {/* Summary bar */}
      {deals.length > 0 && (
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-4">
            <p className="text-sm font-medium text-white">
              {deals.length} deal{deals.length !== 1 ? "s" : ""} expiring{" "}
              {expLabel && <span style={{ color: "#6366f1" }}>{expLabel}</span>}
            </p>
            {processedCount > 0 && (
              <span className="text-xs px-2 py-0.5 rounded-full" style={{ backgroundColor: "#22c55e20", color: "#22c55e" }}>
                {processedCount} / {deals.length} processed
              </span>
            )}
          </div>
          <button
            onClick={generateEmail}
            disabled={emailLoading || deals.length === 0}
            className="flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors disabled:opacity-50"
            style={{ borderColor: "#252836", color: "#94a3b8" }}
          >
            {emailLoading ? <Loader2 size={12} className="animate-spin" /> : <Mail size={12} />}
            Generate Email
          </button>
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

      {/* Deal rows */}
      <div className="space-y-2">
        {deals.map((entry) => (
          <DealRow
            key={entry.currentDealId}
            entry={entry}
            onProcess={(e) => setConfirmEntry(e)}
          />
        ))}
      </div>

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

      {/* Email modal */}
      {emailModal && (
        <EmailModal
          subject={emailModal.subject}
          body={emailModal.body}
          to={emailModal.to}
          onClose={() => setEmailModal(null)}
        />
      )}
    </div>
  );
}
