"use client";

import { useState, useEffect } from "react";
import {
  Target,
  ExternalLink,
  AlertCircle,
  CheckCircle,
  Loader2,
  Plus,
  RefreshCw,
} from "lucide-react";

// ─── Types (mirror /api/targets response) ──────────────────────────────────────

interface ScoreComponent {
  key: string;
  label: string;
  points: number;
  detail?: string;
}

interface TargetRecord {
  id: string;
  name: string;
  domain?: string;
  state?: string;
  totalScore: number;
  fitScore: number;
  triggerScore: number;
  breakdown: { fit?: ScoreComponent[]; trigger?: ScoreComponent[] } | null;
  scoredAt?: string;
  hubspotUrl: string;
}

type TaskState = "idle" | "creating" | "done" | "error";

// ─── Chip ───────────────────────────────────────────────────────────────────────

function Chip({
  label,
  detail,
  points,
  tone,
}: {
  label: string;
  detail?: string;
  points: number;
  tone: "trigger" | "fit";
}) {
  // Trigger reasons are the "why now" — warm indigo. Fit reasons are the
  // structural "why them" — muted slate.
  const color = tone === "trigger" ? "#a5b4fc" : "#94a3b8";
  const bg = tone === "trigger" ? "#6366f115" : "#25283680";
  return (
    <span
      className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded"
      style={{ backgroundColor: bg, color }}
      title={detail ? `${label} — ${detail}` : label}
    >
      {label}
      <span style={{ color: tone === "trigger" ? "#6366f1" : "#64748b" }}>+{points}</span>
    </span>
  );
}

// ─── Score pill ──────────────────────────────────────────────────────────────────

function ScorePill({ label, value, primary }: { label: string; value: number; primary?: boolean }) {
  return (
    <div className="text-right w-16">
      <p className="text-xs" style={{ color: "#475569" }}>{label}</p>
      <p
        className={primary ? "text-lg font-bold" : "text-sm font-semibold"}
        style={{ color: primary ? "#a5b4fc" : "#94a3b8" }}
      >
        {Number.isFinite(value) ? value : "—"}
      </p>
    </div>
  );
}

// ─── Target Row ───────────────────────────────────────────────────────────────────

function TargetRow({ target, rank }: { target: TargetRecord; rank: number }) {
  const [taskState, setTaskState] = useState<TaskState>("idle");
  const [taskError, setTaskError] = useState<string | null>(null);

  const triggerReasons = target.breakdown?.trigger ?? [];
  const fitReasons = target.breakdown?.fit ?? [];

  async function createTask() {
    setTaskState("creating");
    setTaskError(null);
    try {
      const res = await fetch(`/api/targets/${target.id}/task`, { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Task creation failed");
      setTaskState("done");
    } catch (e: any) {
      setTaskState("error");
      setTaskError(e.message ?? "Something went wrong");
    }
  }

  return (
    <div
      className="rounded-xl border transition-all hover:border-indigo-500/40"
      style={{ backgroundColor: "#1a1d27", borderColor: "#252836" }}
    >
      <div className="flex items-start gap-4 p-4">
        {/* Rank */}
        <div
          className="w-8 h-8 rounded-full flex items-center justify-center text-sm font-bold flex-shrink-0"
          style={{ backgroundColor: "#6366f120", color: "#a5b4fc" }}
        >
          {rank}
        </div>

        {/* Company + reasons */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <a
              href={target.hubspotUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-sm font-semibold text-white truncate hover:underline inline-flex items-center gap-1"
              title="Open in HubSpot"
            >
              {target.name}
              <ExternalLink size={12} style={{ color: "#64748b" }} />
            </a>
            {target.state && (
              <span className="text-xs px-1.5 py-0.5 rounded" style={{ backgroundColor: "#25283680", color: "#64748b" }}>
                {target.state}
              </span>
            )}
          </div>
          {target.domain && (
            <p className="text-xs mt-0.5 truncate" style={{ color: "#64748b" }}>{target.domain}</p>
          )}

          {/* Breakdown chips */}
          {(triggerReasons.length > 0 || fitReasons.length > 0) && (
            <div className="flex flex-wrap gap-1.5 mt-2">
              {triggerReasons.map((c, i) => (
                <Chip key={`t-${i}`} label={c.label} detail={c.detail} points={c.points} tone="trigger" />
              ))}
              {fitReasons.map((c, i) => (
                <Chip key={`f-${i}`} label={c.label} detail={c.detail} points={c.points} tone="fit" />
              ))}
            </div>
          )}
        </div>

        {/* Scores */}
        <div className="hidden sm:flex items-center gap-4 shrink-0">
          <ScorePill label="Fit" value={target.fitScore} />
          <ScorePill label="Trigger" value={target.triggerScore} />
          <ScorePill label="Total" value={target.totalScore} primary />
        </div>

        {/* Action */}
        <div className="shrink-0 w-40 flex justify-end">
          {taskState === "done" ? (
            <span className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium" style={{ backgroundColor: "#22c55e20", color: "#22c55e" }}>
              <CheckCircle size={12} />
              Task created
            </span>
          ) : (
            <button
              onClick={createTask}
              disabled={taskState === "creating"}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors disabled:opacity-50"
              style={{ backgroundColor: "#6366f120", color: "#a5b4fc", border: "1px solid #6366f140" }}
              title="Create a HIGH-priority HubSpot outreach task pre-filled with the score reasons"
            >
              {taskState === "creating" ? <Loader2 size={12} className="animate-spin" /> : <Plus size={12} />}
              {taskState === "creating" ? "Creating…" : "Create outreach task"}
            </button>
          )}
        </div>
      </div>

      {/* Mobile scores */}
      <div className="flex sm:hidden gap-4 px-4 pb-3 text-sm">
        <span style={{ color: "#64748b" }}>Fit: <span className="text-white">{target.fitScore}</span></span>
        <span style={{ color: "#64748b" }}>Trigger: <span className="text-white">{target.triggerScore}</span></span>
        <span style={{ color: "#64748b" }}>Total: <span style={{ color: "#a5b4fc", fontWeight: 600 }}>{target.totalScore}</span></span>
      </div>

      {/* Task error */}
      {taskState === "error" && taskError && (
        <div className="mx-4 mb-3 px-3 py-2 rounded-lg text-xs flex items-center gap-2" style={{ backgroundColor: "#ef444415", color: "#ef4444" }}>
          <AlertCircle size={12} />
          {taskError}
        </div>
      )}
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────────

export default function TargetsPage() {
  const [targets, setTargets] = useState<TargetRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/targets", { cache: "no-store" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to load targets");
      setTargets(data.targets ?? []);
    } catch (e: any) {
      setError(e.message || "Failed to load targets");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  const scoredAt = targets.find((t) => t.scoredAt)?.scoredAt;

  return (
    <div className="p-6 max-w-5xl mx-auto">
      {/* Header */}
      <div className="mb-6 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-white">AIC Targets</h1>
          <p className="text-sm mt-0.5" style={{ color: "#64748b" }}>
            Ranked prospect list from the weekly scoring run — fit tells you who, trigger tells you when
            {scoredAt && (
              <>
                {" · "}scored{" "}
                {new Date(scoredAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
              </>
            )}
          </p>
        </div>
        <button
          onClick={load}
          disabled={loading}
          className="flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium border transition-colors disabled:opacity-50 shrink-0"
          style={{ borderColor: "#252836", color: "#94a3b8" }}
        >
          {loading ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
          Refresh
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

      {/* Column headers */}
      {targets.length > 0 && (
        <div className="hidden sm:flex items-center gap-4 px-4 mb-2">
          <div className="flex-1" />
          <div className="flex items-center gap-4">
            <p className="text-xs w-16 text-right" style={{ color: "#475569" }}>Fit</p>
            <p className="text-xs w-16 text-right" style={{ color: "#475569" }}>Trigger</p>
            <p className="text-xs w-16 text-right" style={{ color: "#475569" }}>Total</p>
          </div>
          <div className="w-40" />
        </div>
      )}

      {/* List */}
      <div className="space-y-2">
        {targets.map((t, i) => (
          <TargetRow key={t.id} target={t} rank={i + 1} />
        ))}
      </div>

      {/* Loading state */}
      {loading && targets.length === 0 && (
        <div className="text-center py-16" style={{ color: "#64748b" }}>
          <Loader2 size={28} className="mx-auto mb-3 animate-spin opacity-60" />
          <p className="text-sm">Loading ranked targets…</p>
        </div>
      )}

      {/* Empty state */}
      {!loading && targets.length === 0 && !error && (
        <div className="text-center py-16" style={{ color: "#64748b" }}>
          <Target size={32} className="mx-auto mb-3 opacity-40" />
          <p className="text-sm">No scored targets yet</p>
          <p className="text-xs mt-1">
            Run the weekly scoring cron (<span className="text-white">/api/cron/score-accounts</span>) to populate the list
          </p>
        </div>
      )}
    </div>
  );
}
