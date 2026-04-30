"use client";

import { useState, useEffect } from "react";
import {
  RefreshCw,
  AlertCircle,
  Clock,
  TrendingUp,
  Calendar,
  ChevronRight,
  Loader2,
} from "lucide-react";
import type { PriorityDeal } from "@/lib/types";
import Link from "next/link";

const PRIORITY_COLORS = [
  { bg: "#ef444420", text: "#ef4444", dot: "#ef4444" },
  { bg: "#f59e0b20", text: "#f59e0b", dot: "#f59e0b" },
  { bg: "#22c55e20", text: "#22c55e", dot: "#22c55e" },
];

function getPriorityStyle(score: number) {
  if (score >= 8) return PRIORITY_COLORS[0];
  if (score >= 5) return PRIORITY_COLORS[1];
  return PRIORITY_COLORS[2];
}

function DealCard({ deal, rank }: { deal: PriorityDeal; rank: number }) {
  const style = getPriorityStyle(deal.priorityScore);
  const isMSI = deal.isMSI;

  return (
    <div
      className="rounded-xl p-4 border transition-all hover:border-indigo-500/40"
      style={{ backgroundColor: "#1a1d27", borderColor: "#252836" }}
    >
      <div className="flex items-start gap-4">
        {/* Rank badge */}
        <div
          className="w-8 h-8 rounded-full flex items-center justify-center text-sm font-bold flex-shrink-0"
          style={{ backgroundColor: style.bg, color: style.text }}
        >
          {rank}
        </div>

        <div className="flex-1 min-w-0">
          {/* Header row */}
          <div className="flex items-center gap-2 flex-wrap mb-1">
            <span className="font-semibold text-white text-sm truncate">{deal.name}</span>
            {isMSI && (
              <span
                className="text-xs px-2 py-0.5 rounded-full font-medium flex-shrink-0"
                style={{ backgroundColor: "#6366f120", color: "#6366f1" }}
              >
                MSI
              </span>
            )}
            {deal.stage && (
              <span
                className="text-xs px-2 py-0.5 rounded-full flex-shrink-0"
                style={{ backgroundColor: "#ffffff10", color: "#94a3b8" }}
              >
                {deal.stage}
              </span>
            )}
          </div>

          {/* Company & close date */}
          <div className="flex items-center gap-3 mb-2 text-xs" style={{ color: "#64748b" }}>
            {deal.company && <span>{deal.company}</span>}
            {deal.closeDate && (
              <span className="flex items-center gap-1">
                <Clock size={10} />
                Close {deal.closeDate}
              </span>
            )}
            {deal.amount && (
              <span className="flex items-center gap-1">
                <TrendingUp size={10} />
                ${deal.amount.toLocaleString()}
              </span>
            )}
          </div>

          {/* Priority reason */}
          <p className="text-xs mb-2" style={{ color: "#94a3b8" }}>
            {deal.priorityReason}
          </p>

          {/* Suggested action */}
          <div
            className="flex items-start gap-2 rounded-lg px-3 py-2"
            style={{ backgroundColor: "#6366f115" }}
          >
            <ChevronRight size={12} className="mt-0.5 flex-shrink-0" style={{ color: "#6366f1" }} />
            <p className="text-xs font-medium" style={{ color: "#a5b4fc" }}>
              {deal.suggestedAction}
            </p>
          </div>
        </div>

        {/* Deep dive link */}
        <Link
          href={`/account?q=${encodeURIComponent(deal.company || deal.name)}`}
          className="flex-shrink-0 text-xs px-3 py-1.5 rounded-lg border transition-colors hover:bg-indigo-500/10"
          style={{ borderColor: "#6366f140", color: "#6366f1" }}
        >
          Brief →
        </Link>
      </div>
    </div>
  );
}

export default function DashboardPage() {
  const [deals, setDeals] = useState<PriorityDeal[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);

  async function loadPriorities() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/priorities");
      if (!res.ok) throw new Error(await res.text());
      const data = await res.json();
      setDeals(data.deals || []);
      setLastRefresh(new Date());
    } catch (e: any) {
      setError(e.message || "Failed to load priorities");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadPriorities();
  }, []);

  return (
    <div className="p-6 max-w-4xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-white">Daily Priorities</h1>
          <p className="text-sm mt-0.5" style={{ color: "#64748b" }}>
            AI-ranked deals for today
            {lastRefresh && (
              <> · Updated {lastRefresh.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</>
            )}
          </p>
        </div>
        <button
          onClick={loadPriorities}
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

      {/* Legend */}
      <div className="flex items-center gap-4 mb-5 text-xs" style={{ color: "#64748b" }}>
        <div className="flex items-center gap-1.5">
          <div className="w-2 h-2 rounded-full" style={{ backgroundColor: "#ef4444" }} />
          High priority (8–10)
        </div>
        <div className="flex items-center gap-1.5">
          <div className="w-2 h-2 rounded-full" style={{ backgroundColor: "#f59e0b" }} />
          Medium (5–7)
        </div>
        <div className="flex items-center gap-1.5">
          <div className="w-2 h-2 rounded-full" style={{ backgroundColor: "#22c55e" }} />
          Lower priority (1–4)
        </div>
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

      {/* Loading skeletons */}
      {loading && deals.length === 0 && (
        <div className="space-y-3">
          {[1, 2, 3, 4, 5].map((i) => (
            <div
              key={i}
              className="h-32 rounded-xl animate-pulse"
              style={{ backgroundColor: "#1a1d27" }}
            />
          ))}
        </div>
      )}

      {/* Deals list */}
      {!loading && deals.length === 0 && !error && (
        <div className="text-center py-16" style={{ color: "#64748b" }}>
          <Calendar size={32} className="mx-auto mb-3 opacity-50" />
          <p>Click Refresh to load today&apos;s priorities</p>
        </div>
      )}

      {deals.length > 0 && (
        <div className="space-y-3">
          {deals.map((deal, i) => (
            <DealCard key={deal.id} deal={deal} rank={i + 1} />
          ))}
        </div>
      )}
    </div>
  );
}
