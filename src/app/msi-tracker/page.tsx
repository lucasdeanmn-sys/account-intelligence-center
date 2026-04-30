"use client";

import { useState, useEffect } from "react";
import {
  RefreshCw,
  AlertCircle,
  CheckCircle,
  Clock,
  AlertTriangle,
  Loader2,
  TrendingUp,
  FileText,
} from "lucide-react";
import type { MSIDeal, MSIFlag } from "@/lib/types";

const FLAG_CONFIG: Record<MSIFlag, { label: string; color: string; icon: any }> = {
  missing_m1_note: { label: "Missing M1 Note", color: "#ef4444", icon: FileText },
  malformed_m1_note: { label: "Malformed M1 Note", color: "#f59e0b", icon: AlertTriangle },
  circuit_discrepancy: { label: "Circuit Discrepancy", color: "#f59e0b", icon: TrendingUp },
  renewal_imminent: { label: "Renewal Imminent (≤30 days)", color: "#f59e0b", icon: Clock },
  renewal_overdue: { label: "Renewal Overdue", color: "#ef4444", icon: AlertCircle },
  cssa_unavailable: { label: "CSSA Data Unavailable", color: "#64748b", icon: AlertCircle },
};

function MSIDealCard({ deal }: { deal: MSIDeal }) {
  const hasFlags = deal.flags.length > 0;
  const hasCritical = deal.flags.some((f) =>
    ["missing_m1_note", "renewal_overdue"].includes(f)
  );

  return (
    <div
      className="rounded-xl border p-5 transition-all"
      style={{
        backgroundColor: "#1a1d27",
        borderColor: hasCritical ? "#ef444440" : hasFlags ? "#f59e0b30" : "#252836",
      }}
    >
      {/* Header */}
      <div className="flex items-start justify-between mb-4">
        <div>
          <h3 className="text-sm font-semibold text-white">{deal.name}</h3>
          <p className="text-xs mt-0.5" style={{ color: "#64748b" }}>
            {deal.company}
            {deal.stage && ` · ${deal.stage}`}
          </p>
        </div>
        <div className="flex gap-2 flex-wrap justify-end">
          {deal.flags.map((flag) => {
            const cfg = FLAG_CONFIG[flag];
            const Icon = cfg.icon;
            return (
              <span
                key={flag}
                className="flex items-center gap-1 text-xs px-2 py-0.5 rounded-full"
                style={{ backgroundColor: `${cfg.color}20`, color: cfg.color }}
              >
                <Icon size={10} />
                {cfg.label}
              </span>
            );
          })}
          {deal.flags.length === 0 && (
            <span
              className="flex items-center gap-1 text-xs px-2 py-0.5 rounded-full"
              style={{ backgroundColor: "#22c55e20", color: "#22c55e" }}
            >
              <CheckCircle size={10} />
              Clean
            </span>
          )}
        </div>
      </div>

      {/* Data grid */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <div
          className="rounded-lg p-3"
          style={{ backgroundColor: "#0f1117" }}
        >
          <p className="text-xs mb-1" style={{ color: "#64748b" }}>
            Next Renewal
          </p>
          <p className="text-sm font-semibold text-white">
            {deal.nextRenewalDate || "—"}
          </p>
        </div>
        <div
          className="rounded-lg p-3"
          style={{ backgroundColor: "#0f1117" }}
        >
          <p className="text-xs mb-1" style={{ color: "#64748b" }}>
            Contract Value
          </p>
          <p className="text-sm font-semibold text-white">
            {deal.contractValue ? `$${deal.contractValue.toLocaleString()}` : "—"}
          </p>
        </div>
        <div
          className="rounded-lg p-3"
          style={{
            backgroundColor: deal.flags.includes("circuit_discrepancy")
              ? "#f59e0b10"
              : "#0f1117",
          }}
        >
          <p className="text-xs mb-1" style={{ color: "#64748b" }}>
            Circuits (Contract / Actual)
          </p>
          <p className="text-sm font-semibold">
            <span className="text-white">{deal.contractedCircuits ?? "—"}</span>
            <span style={{ color: "#64748b" }}> / </span>
            <span
              style={{
                color: deal.flags.includes("circuit_discrepancy")
                  ? "#f59e0b"
                  : "#22c55e",
              }}
            >
              {deal.actualCircuits ?? "—"}
            </span>
          </p>
        </div>
        <div
          className="rounded-lg p-3"
          style={{
            backgroundColor: deal.recommendedInvoiceCircuits
              ? "#6366f110"
              : "#0f1117",
          }}
        >
          <p className="text-xs mb-1" style={{ color: "#64748b" }}>
            Invoice Recommendation
          </p>
          {deal.recommendedInvoiceCircuits ? (
            <div>
              <p className="text-sm font-semibold" style={{ color: "#a5b4fc" }}>
                {deal.recommendedInvoiceCircuits} circuits
              </p>
              {deal.recommendedInvoiceAmount && (
                <p className="text-xs" style={{ color: "#6366f1" }}>
                  ${deal.recommendedInvoiceAmount.toLocaleString()}
                </p>
              )}
            </div>
          ) : (
            <p className="text-sm font-semibold text-white">On contract</p>
          )}
        </div>
      </div>

      {/* M1 Note preview */}
      {deal.m1Note && (
        <div
          className="mt-3 rounded-lg p-3 text-xs font-mono"
          style={{ backgroundColor: "#0f1117", color: "#64748b" }}
        >
          <p className="text-xs mb-1 font-sans" style={{ color: "#475569" }}>
            M1 Note
          </p>
          <div
            dangerouslySetInnerHTML={{ __html: deal.m1Note }}
            className="leading-relaxed"
          />
        </div>
      )}
    </div>
  );
}

export default function MSITrackerPage() {
  const [deals, setDeals] = useState<MSIDeal[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<"all" | "flagged" | "clean">("all");
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);

  async function loadMSIData() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/msi-tracker");
      if (!res.ok) throw new Error(await res.text());
      const data = await res.json();
      setDeals(data.deals || []);
      setLastRefresh(new Date());
    } catch (e: any) {
      setError(e.message || "Failed to load MSI data");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadMSIData();
  }, []);

  const filtered = deals.filter((d) => {
    if (filter === "flagged") return d.flags.length > 0;
    if (filter === "clean") return d.flags.length === 0;
    return true;
  });

  const flaggedCount = deals.filter((d) => d.flags.length > 0).length;
  const renewalSoonCount = deals.filter((d) =>
    d.flags.some((f) => ["renewal_imminent", "renewal_overdue"].includes(f))
  ).length;

  return (
    <div className="p-6 max-w-5xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-white">MSI Renewal Tracker</h1>
          <p className="text-sm mt-0.5" style={{ color: "#64748b" }}>
            Adtran channel deals · Circuit reconciliation + renewal analysis
            {lastRefresh && (
              <> · Updated {lastRefresh.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</>
            )}
          </p>
        </div>
        <button
          onClick={loadMSIData}
          disabled={loading}
          className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors disabled:opacity-50"
          style={{ backgroundColor: "#6366f1", color: "white" }}
        >
          {loading ? (
            <Loader2 size={14} className="animate-spin" />
          ) : (
            <RefreshCw size={14} />
          )}
          {loading ? "Analyzing..." : "Refresh"}
        </button>
      </div>

      {/* Summary stats */}
      {deals.length > 0 && (
        <div className="grid grid-cols-3 gap-4 mb-6">
          <div
            className="rounded-xl border p-4"
            style={{ backgroundColor: "#1a1d27", borderColor: "#252836" }}
          >
            <p className="text-xs mb-1" style={{ color: "#64748b" }}>Total MSI Deals</p>
            <p className="text-2xl font-bold text-white">{deals.length}</p>
          </div>
          <div
            className="rounded-xl border p-4"
            style={{
              backgroundColor: "#1a1d27",
              borderColor: flaggedCount > 0 ? "#f59e0b30" : "#252836",
            }}
          >
            <p className="text-xs mb-1" style={{ color: "#64748b" }}>Flagged</p>
            <p className="text-2xl font-bold" style={{ color: flaggedCount > 0 ? "#f59e0b" : "#22c55e" }}>
              {flaggedCount}
            </p>
          </div>
          <div
            className="rounded-xl border p-4"
            style={{
              backgroundColor: "#1a1d27",
              borderColor: renewalSoonCount > 0 ? "#ef444430" : "#252836",
            }}
          >
            <p className="text-xs mb-1" style={{ color: "#64748b" }}>Renewal Attention Needed</p>
            <p className="text-2xl font-bold" style={{ color: renewalSoonCount > 0 ? "#ef4444" : "#22c55e" }}>
              {renewalSoonCount}
            </p>
          </div>
        </div>
      )}

      {/* Filters */}
      {deals.length > 0 && (
        <div className="flex gap-2 mb-5">
          {(["all", "flagged", "clean"] as const).map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className="px-3 py-1.5 rounded-lg text-xs font-medium capitalize transition-colors border"
              style={{
                backgroundColor: filter === f ? "#6366f120" : "transparent",
                borderColor: filter === f ? "#6366f140" : "#252836",
                color: filter === f ? "#6366f1" : "#64748b",
              }}
            >
              {f} {f === "all" ? `(${deals.length})` : f === "flagged" ? `(${flaggedCount})` : `(${deals.length - flaggedCount})`}
            </button>
          ))}
        </div>
      )}

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

      {/* Loading skeletons */}
      {loading && deals.length === 0 && (
        <div className="space-y-3">
          {[1, 2, 3].map((i) => (
            <div
              key={i}
              className="h-44 rounded-xl animate-pulse"
              style={{ backgroundColor: "#1a1d27" }}
            />
          ))}
        </div>
      )}

      {/* Empty state */}
      {!loading && deals.length === 0 && !error && (
        <div className="text-center py-16" style={{ color: "#64748b" }}>
          <RefreshCw size={32} className="mx-auto mb-3 opacity-50" />
          <p>Click Refresh to load MSI renewal data</p>
        </div>
      )}

      {/* Deals */}
      {filtered.length > 0 && (
        <div className="space-y-4">
          {filtered.map((deal) => (
            <MSIDealCard key={deal.id} deal={deal} />
          ))}
        </div>
      )}

      {filtered.length === 0 && deals.length > 0 && (
        <div className="text-center py-12" style={{ color: "#64748b" }}>
          <CheckCircle size={28} className="mx-auto mb-2" style={{ color: "#22c55e" }} />
          <p className="text-sm">No {filter} deals found</p>
        </div>
      )}
    </div>
  );
}
