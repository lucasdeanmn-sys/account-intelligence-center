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
  ChevronDown,
  ChevronUp,
  Sparkles,
  Copy,
  Briefcase,
  StickyNote,
  Phone,
  Mail,
  MapPin,
  Users,
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

type TaskState = "idle" | "creating" | "done" | "exists" | "error";

// ─── Context types (mirror /api/targets/[id]/context) ─────────────────────────

interface ContextDeal {
  id: string;
  name: string;
  pipeline: string | null;
  stage: string | null;
  amount: number | null;
  closeDate: string | null;
  isOpen: boolean;
  isClosedLost: boolean;
  lastActivity: string | null;
}

interface ContextNote {
  date: string | null;
  text: string;
}

interface ContextMention {
  title: string;
  date: string | null;
  excerpt: string | null;
  callType: "prospect" | "external" | "internal";
}

const CALL_TYPE_BADGE: Record<ContextMention["callType"], { label: string; bg: string; color: string }> = {
  prospect: { label: "They were on the call", bg: "#22c55e20", color: "#22c55e" },
  external: { label: "Partner/customer call", bg: "#6366f120", color: "#a5b4fc" },
  internal: { label: "Internal call", bg: "#25283680", color: "#64748b" },
};

interface ContextPerson {
  name: string;
  email: string | null;
  title: string | null;
  sources: ("hubspot" | "call" | "email")[];
  lastSeen: string | null;
  detail: string | null;
}

interface TargetContext {
  company: { id: string; name: string; domain: string | null; state: string | null; city: string | null };
  reasons: string[];
  deals: ContextDeal[];
  notes: ContextNote[];
  fathomMentions: ContextMention[];
  people: ContextPerson[];
  lastInboundEmailDays: number | null;
}

const PERSON_SOURCE_BADGE: Record<"hubspot" | "call" | "email", { label: string; color: string }> = {
  hubspot: { label: "CRM", color: "#94a3b8" },
  call: { label: "On calls", color: "#22c55e" },
  email: { label: "Emails us", color: "#a5b4fc" },
};

interface OutreachSuggestion {
  emailSubject: string;
  emailBody: string;
  callPoints: string[];
}

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
      <span style={{ color: points < 0 ? "#ef4444" : tone === "trigger" ? "#6366f1" : "#64748b" }}>
        {points >= 0 ? `+${points}` : points}
      </span>
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

// ─── Expanded context panel ───────────────────────────────────────────────────────

function SectionTitle({ icon, children }: { icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <p className="flex items-center gap-1.5 text-xs font-medium mb-2" style={{ color: "#64748b" }}>
      {icon}
      {children}
    </p>
  );
}

function DealBadge({ deal }: { deal: ContextDeal }) {
  const [bg, color, label] = deal.isOpen
    ? ["#6366f120", "#a5b4fc", `Open — ${deal.stage ?? "?"}`]
    : deal.isClosedLost
      ? ["#ef444420", "#ef4444", "Closed Lost"]
      : ["#22c55e20", "#22c55e", deal.stage ?? "Closed"];
  return (
    <span className="text-xs px-1.5 py-0.5 rounded shrink-0" style={{ backgroundColor: bg, color }}>
      {label}
    </span>
  );
}

function ContextPanel({
  target,
  suggestion,
  onSuggestion,
}: {
  target: TargetRecord;
  suggestion: OutreachSuggestion | null;
  onSuggestion: (s: OutreachSuggestion) => void;
}) {
  const [ctx, setCtx] = useState<TargetContext | null>(null);
  const [loading, setLoading] = useState(true);
  const [signalsLoading, setSignalsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [drafting, setDrafting] = useState(false);
  const [draftError, setDraftError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  // Two-stage load: deals + notes render immediately; call mentions and email
  // recency arrive second (the Fathom corpus scan can take ~15s when cold).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/targets/${target.id}/context?signals=0`, { cache: "no-store" });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Failed to load account context");
        if (!cancelled) {
          setCtx(data);
          setLoading(false);
        }
        const fullRes = await fetch(`/api/targets/${target.id}/context`, { cache: "no-store" });
        const full = await fullRes.json();
        if (fullRes.ok && !cancelled) setCtx(full);
      } catch (e: any) {
        if (!cancelled) {
          setError(e.message ?? "Failed to load account context");
          setLoading(false);
        }
      } finally {
        if (!cancelled) setSignalsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [target.id]);

  async function draftOutreach() {
    setDrafting(true);
    setDraftError(null);
    try {
      const res = await fetch(`/api/targets/${target.id}/suggest`, { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to draft outreach");
      onSuggestion(data.suggestion);
    } catch (e: any) {
      setDraftError(e.message ?? "Failed to draft outreach");
    } finally {
      setDrafting(false);
    }
  }

  async function copyEmail() {
    if (!suggestion) return;
    await navigator.clipboard.writeText(
      `Subject: ${suggestion.emailSubject}\n\n${suggestion.emailBody}`
    );
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  if (loading) {
    return (
      <div className="px-4 pb-4 pt-1 flex items-center gap-2 text-xs" style={{ color: "#64748b" }}>
        <Loader2 size={13} className="animate-spin" />
        Loading account history…
      </div>
    );
  }
  if (error || !ctx) {
    return (
      <div className="mx-4 mb-3 px-3 py-2 rounded-lg text-xs flex items-center gap-2" style={{ backgroundColor: "#ef444415", color: "#ef4444" }}>
        <AlertCircle size={12} />
        {error ?? "No context available"}
      </div>
    );
  }

  const hasHistory = ctx.deals.length > 0 || ctx.notes.length > 0 || ctx.fathomMentions.length > 0;

  return (
    <div className="px-4 pb-4 pt-1 border-t space-y-4" style={{ borderColor: "#252836" }}>
      {/* Signals strip */}
      {(signalsLoading || ctx.company.city || ctx.company.state || ctx.lastInboundEmailDays != null || ctx.fathomMentions.length > 0) && (
        <div className="flex flex-wrap gap-3 pt-3 text-xs" style={{ color: "#94a3b8" }}>
          {(ctx.company.city || ctx.company.state) && (
            <span className="flex items-center gap-1.5">
              <MapPin size={12} style={{ color: "#a5b4fc" }} />
              {[ctx.company.city, ctx.company.state].filter(Boolean).join(", ")}
            </span>
          )}
          {signalsLoading && (
            <span className="flex items-center gap-1.5" style={{ color: "#64748b" }}>
              <Loader2 size={12} className="animate-spin" />
              Scanning recent calls & email…
            </span>
          )}
          {ctx.fathomMentions.length > 0 && (
            <span className="flex items-center gap-1.5">
              <Phone size={12} style={{ color: "#a5b4fc" }} />
              Mentioned on {ctx.fathomMentions.length} recent call{ctx.fathomMentions.length > 1 ? "s" : ""}
            </span>
          )}
          {ctx.lastInboundEmailDays != null && (
            <span className="flex items-center gap-1.5">
              <Mail size={12} style={{ color: "#a5b4fc" }} />
              Last inbound email {ctx.lastInboundEmailDays}d ago
            </span>
          )}
        </div>
      )}

      <div className="grid sm:grid-cols-2 gap-4 pt-1">
        {/* Deal history */}
        <div>
          <SectionTitle icon={<Briefcase size={12} />}>DEAL HISTORY</SectionTitle>
          {ctx.deals.length === 0 ? (
            <p className="text-xs" style={{ color: "#475569" }}>No deals on record — cold account</p>
          ) : (
            <div className="space-y-1.5">
              {ctx.deals.slice(0, 6).map((d) => (
                <div key={d.id} className="flex items-center gap-2 text-xs">
                  <DealBadge deal={d} />
                  <span className="truncate" style={{ color: "#94a3b8" }} title={d.name}>{d.name}</span>
                  <span className="ml-auto shrink-0" style={{ color: "#475569" }}>
                    {d.amount ? `$${d.amount.toLocaleString()} · ` : ""}{d.closeDate ?? d.lastActivity ?? ""}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Call mentions + notes */}
        <div className="space-y-4">
          {ctx.fathomMentions.length > 0 && (
            <div>
              <SectionTitle icon={<Phone size={12} />}>RECENT CALL MENTIONS</SectionTitle>
              <div className="space-y-1.5">
                {ctx.fathomMentions.slice(0, 3).map((m, i) => {
                  const badge = CALL_TYPE_BADGE[m.callType] ?? CALL_TYPE_BADGE.external;
                  return (
                    <div key={i} className="text-xs">
                      <p className="flex items-center gap-1.5 flex-wrap" style={{ color: "#94a3b8" }}>
                        {m.title} <span style={{ color: "#475569" }}>{m.date ?? ""}</span>
                        <span className="px-1.5 py-0.5 rounded" style={{ backgroundColor: badge.bg, color: badge.color }}>
                          {badge.label}
                        </span>
                      </p>
                      {m.excerpt && <p className="mt-0.5 italic" style={{ color: "#64748b" }}>{m.excerpt}</p>}
                    </div>
                  );
                })}
              </div>
            </div>
          )}
          {ctx.notes.length > 0 && (
            <div>
              <SectionTitle icon={<StickyNote size={12} />}>RECENT NOTES</SectionTitle>
              <div className="space-y-1.5">
                {ctx.notes.slice(0, 3).map((n, i) => (
                  <p key={i} className="text-xs" style={{ color: "#64748b" }}>
                    <span style={{ color: "#475569" }}>{n.date ?? ""}</span> {n.text}
                  </p>
                ))}
              </div>
            </div>
          )}
          {!hasHistory && (
            <p className="text-xs" style={{ color: "#475569" }}>
              No notes or call mentions — the score reasons above are all we know.
            </p>
          )}
        </div>
      </div>

      {/* People — HubSpot contacts, call participants, email senders, merged */}
      {ctx.people.length > 0 && (
        <div>
          <SectionTitle icon={<Users size={12} />}>
            PEOPLE{signalsLoading ? " (CRM so far — scanning calls & email…)" : ""}
          </SectionTitle>
          <div className="grid sm:grid-cols-2 gap-x-4 gap-y-1.5">
            {ctx.people.slice(0, 8).map((p, i) => (
              <div key={i} className="flex items-center gap-2 text-xs min-w-0">
                <span className="text-white font-medium truncate" title={p.email ?? p.name}>{p.name}</span>
                {p.title && <span className="truncate" style={{ color: "#64748b" }}>{p.title}</span>}
                <span className="ml-auto flex items-center gap-1 shrink-0">
                  {p.sources.map((s) => (
                    <span
                      key={s}
                      className="px-1.5 py-0.5 rounded"
                      style={{ backgroundColor: "#25283680", color: PERSON_SOURCE_BADGE[s]?.color ?? "#94a3b8" }}
                      title={s === "call" && p.detail ? `${p.detail}${p.lastSeen ? ` (${p.lastSeen})` : ""}` : p.lastSeen ?? undefined}
                    >
                      {PERSON_SOURCE_BADGE[s]?.label ?? s}
                    </span>
                  ))}
                  {p.lastSeen && <span style={{ color: "#475569" }}>{p.lastSeen}</span>}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Outreach draft */}
      <div>
        {suggestion ? (
          <div className="rounded-lg border p-3 space-y-2" style={{ backgroundColor: "#0f1117", borderColor: "#252836" }}>
            <div className="flex items-center justify-between gap-2">
              <SectionTitle icon={<Sparkles size={12} />}>SUGGESTED OUTREACH — attached to the task when you create it</SectionTitle>
              <button
                onClick={copyEmail}
                className="flex items-center gap-1 text-xs px-2 py-1 rounded transition-colors shrink-0"
                style={{ color: copied ? "#22c55e" : "#94a3b8", backgroundColor: "#25283680" }}
              >
                {copied ? <CheckCircle size={11} /> : <Copy size={11} />}
                {copied ? "Copied" : "Copy email"}
              </button>
            </div>
            <p className="text-xs font-medium text-white">Subject: {suggestion.emailSubject}</p>
            <p className="text-xs whitespace-pre-wrap" style={{ color: "#94a3b8" }}>{suggestion.emailBody}</p>
            {suggestion.callPoints.length > 0 && (
              <div className="pt-1">
                <p className="text-xs font-medium mb-1" style={{ color: "#64748b" }}>Call points</p>
                <ul className="space-y-0.5">
                  {suggestion.callPoints.map((p, i) => (
                    <li key={i} className="text-xs flex gap-1.5" style={{ color: "#94a3b8" }}>
                      <span style={{ color: "#6366f1" }}>·</span>
                      {p}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        ) : (
          <button
            onClick={draftOutreach}
            disabled={drafting}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors disabled:opacity-50"
            style={{ backgroundColor: "#25283680", color: "#c4b5fd", border: "1px solid #6366f130" }}
            title="Draft a first-touch email and call points from the account history (attached to the task when you create it)"
          >
            {drafting ? <Loader2 size={12} className="animate-spin" /> : <Sparkles size={12} />}
            {drafting ? "Drafting from account history…" : "Draft outreach email & call points"}
          </button>
        )}
        {draftError && (
          <p className="text-xs mt-2 flex items-center gap-1.5" style={{ color: "#ef4444" }}>
            <AlertCircle size={11} />
            {draftError}
          </p>
        )}
      </div>
    </div>
  );
}

// ─── Target Row ───────────────────────────────────────────────────────────────────

function TargetRow({ target, rank }: { target: TargetRecord; rank: number }) {
  const [taskState, setTaskState] = useState<TaskState>("idle");
  const [taskError, setTaskError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [suggestion, setSuggestion] = useState<OutreachSuggestion | null>(null);

  const triggerReasons = target.breakdown?.trigger ?? [];
  const fitReasons = target.breakdown?.fit ?? [];

  async function createTask() {
    setTaskState("creating");
    setTaskError(null);
    try {
      const res = await fetch(`/api/targets/${target.id}/task`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ suggestion }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Task creation failed");
      setTaskState(data.existing ? "exists" : "done");
    } catch (e: any) {
      setTaskState("error");
      setTaskError(e.message ?? "Something went wrong");
    }
  }

  return (
    <div
      className="rounded-xl border transition-all hover:border-indigo-500/40"
      style={{ backgroundColor: "#1a1d27", borderColor: expanded ? "#6366f140" : "#252836" }}
    >
      <div
        className="flex items-start gap-4 p-4 cursor-pointer"
        onClick={() => setExpanded((v) => !v)}
        title={expanded ? "Collapse" : "Expand for account history"}
      >
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
              onClick={(e) => e.stopPropagation()}
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
        <div className="shrink-0 w-44 flex justify-end items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
          {taskState === "done" || taskState === "exists" ? (
            <span className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium" style={{ backgroundColor: "#22c55e20", color: "#22c55e" }}>
              <CheckCircle size={12} />
              {taskState === "exists" ? "Task already exists" : "Task created"}
            </span>
          ) : (
            <button
              onClick={createTask}
              disabled={taskState === "creating"}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors disabled:opacity-50"
              style={{ backgroundColor: "#6366f120", color: "#a5b4fc", border: "1px solid #6366f140" }}
              title={
                suggestion
                  ? "Create the HubSpot task — score reasons, account history, and the outreach draft included"
                  : "Create a HIGH-priority HubSpot outreach task with the score reasons and account history"
              }
            >
              {taskState === "creating" ? <Loader2 size={12} className="animate-spin" /> : <Plus size={12} />}
              {taskState === "creating" ? "Creating…" : "Create outreach task"}
            </button>
          )}
          <span style={{ color: "#475569" }}>
            {expanded ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
          </span>
        </div>
      </div>

      {/* Expanded account history */}
      {expanded && (
        <ContextPanel target={target} suggestion={suggestion} onSuggestion={setSuggestion} />
      )}

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
