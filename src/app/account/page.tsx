"use client";

import { useState, useEffect, Suspense } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import {
  Search,
  Loader2,
  AlertCircle,
  Building2,
  User,
  Mail,
  Calendar,
  FileText,
  ChevronRight,
  Plus,
} from "lucide-react";
import type { AccountBriefing } from "@/lib/types";
import PushToHubSpot from "@/components/account/PushToHubSpot";

function BriefingSection({
  title,
  icon: Icon,
  children,
}: {
  title: string;
  icon: any;
  children: React.ReactNode;
}) {
  return (
    <div
      className="rounded-xl border p-5"
      style={{ backgroundColor: "#1a1d27", borderColor: "#252836" }}
    >
      <div className="flex items-center gap-2 mb-4">
        <Icon size={15} style={{ color: "#6366f1" }} />
        <h3 className="text-sm font-semibold text-white">{title}</h3>
      </div>
      {children}
    </div>
  );
}

function AccountBriefingView({
  briefing,
  onPushToHubSpot,
}: {
  briefing: AccountBriefing;
  onPushToHubSpot: () => void;
}) {
  return (
    <div className="space-y-4">
      {/* Deal Header */}
      <div
        className="rounded-xl border p-5"
        style={{ backgroundColor: "#1a1d27", borderColor: "#252836" }}
      >
        <div className="flex items-start justify-between">
          <div>
            <div className="flex items-center gap-2 mb-1">
              <h2 className="text-lg font-bold text-white">{briefing.dealName}</h2>
              {briefing.isMSI && (
                <span
                  className="text-xs px-2 py-0.5 rounded-full font-medium"
                  style={{ backgroundColor: "#6366f120", color: "#6366f1" }}
                >
                  MSI
                </span>
              )}
            </div>
            <p className="text-sm" style={{ color: "#64748b" }}>
              {briefing.company}
              {briefing.dealStage && ` · ${briefing.dealStage}`}
              {briefing.dealAmount && ` · $${briefing.dealAmount.toLocaleString()}`}
              {briefing.closeDate && ` · Close ${briefing.closeDate}`}
            </p>
          </div>
          <button
            onClick={onPushToHubSpot}
            className="flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors hover:bg-indigo-500/10"
            style={{ borderColor: "#6366f140", color: "#6366f1" }}
          >
            <Plus size={12} />
            Add Note / Task
          </button>
        </div>

        {/* Status chips */}
        <div className="flex flex-wrap gap-2 mt-4">
          <div
            className="flex items-center gap-1.5 px-3 py-1 rounded-full text-xs"
            style={{ backgroundColor: "#22c55e15", color: "#22c55e" }}
          >
            <div className="w-1.5 h-1.5 rounded-full bg-current" />
            {briefing.currentStatus}
          </div>
          <div
            className="flex items-center gap-1.5 px-3 py-1 rounded-full text-xs"
            style={{ backgroundColor: "#ffffff08", color: "#94a3b8" }}
          >
            <Calendar size={10} />
            Last contact: {briefing.lastTouchpoint}
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Contacts */}
        {briefing.contacts.length > 0 && (
          <BriefingSection title="Contacts" icon={User}>
            <div className="space-y-2">
              {briefing.contacts.map((c, i) => (
                <div key={i} className="flex items-start gap-3">
                  <div
                    className="w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold flex-shrink-0"
                    style={{ backgroundColor: "#6366f120", color: "#6366f1" }}
                  >
                    {c.name.charAt(0)}
                  </div>
                  <div>
                    <p className="text-sm text-white font-medium">{c.name}</p>
                    {c.title && (
                      <p className="text-xs" style={{ color: "#64748b" }}>
                        {c.title}
                      </p>
                    )}
                    {c.email && (
                      <a
                        href={`mailto:${c.email}`}
                        className="text-xs hover:text-indigo-400 transition-colors"
                        style={{ color: "#6366f1" }}
                      >
                        {c.email}
                      </a>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </BriefingSection>
        )}

        {/* Open Items */}
        {briefing.openItems.length > 0 && (
          <BriefingSection title="Open Items" icon={FileText}>
            <ul className="space-y-1.5">
              {briefing.openItems.map((item, i) => (
                <li key={i} className="flex items-start gap-2 text-sm" style={{ color: "#94a3b8" }}>
                  <span className="mt-0.5 flex-shrink-0" style={{ color: "#f59e0b" }}>•</span>
                  {item}
                </li>
              ))}
            </ul>
          </BriefingSection>
        )}
      </div>

      {/* Recent Email Activity */}
      {briefing.recentEmailSummary && (
        <BriefingSection title="Recent Email Activity" icon={Mail}>
          <p className="text-sm" style={{ color: "#94a3b8" }}>
            {briefing.recentEmailSummary}
          </p>
        </BriefingSection>
      )}

      {/* Upcoming Meetings */}
      {briefing.upcomingMeetings && (
        <BriefingSection title="Calendar" icon={Calendar}>
          <p className="text-sm" style={{ color: "#94a3b8" }}>
            {briefing.upcomingMeetings}
          </p>
        </BriefingSection>
      )}

      {/* Company News */}
      {briefing.companyNews && (
        <BriefingSection title="Company Intelligence" icon={Building2}>
          <p className="text-sm" style={{ color: "#94a3b8" }}>
            {briefing.companyNews}
          </p>
        </BriefingSection>
      )}

      {/* Talking Points */}
      {briefing.suggestedTalkingPoints.length > 0 && (
        <BriefingSection title="Suggested Talking Points" icon={ChevronRight}>
          <ul className="space-y-2">
            {briefing.suggestedTalkingPoints.map((point, i) => (
              <li
                key={i}
                className="flex items-start gap-2 text-sm p-2 rounded-lg"
                style={{ backgroundColor: "#6366f110" }}
              >
                <span className="font-bold flex-shrink-0" style={{ color: "#6366f1" }}>
                  {i + 1}.
                </span>
                <span style={{ color: "#c7d2fe" }}>{point}</span>
              </li>
            ))}
          </ul>
        </BriefingSection>
      )}

      {/* Recommended Next Step */}
      <div
        className="rounded-xl border p-5"
        style={{ backgroundColor: "#6366f110", borderColor: "#6366f130" }}
      >
        <p className="text-xs font-semibold mb-1" style={{ color: "#818cf8" }}>
          RECOMMENDED NEXT STEP
        </p>
        <p className="text-sm font-medium text-white">{briefing.recommendedNextStep}</p>
      </div>
    </div>
  );
}

function AccountPageContent() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const [query, setQuery] = useState(searchParams.get("q") || "");
  const [briefing, setBriefing] = useState<AccountBriefing | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showPushModal, setShowPushModal] = useState(false);

  async function handleSearch(e: React.FormEvent) {
    e.preventDefault();
    if (!query.trim()) return;
    setLoading(true);
    setError(null);
    setBriefing(null);
    router.push(`/account?q=${encodeURIComponent(query)}`);
    try {
      const res = await fetch("/api/account-briefing", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ company: query }),
      });
      if (!res.ok) throw new Error(await res.text());
      const data = await res.json();
      setBriefing(data.briefing);
    } catch (e: any) {
      setError(e.message || "Failed to generate briefing");
    } finally {
      setLoading(false);
    }
  }

  // Auto-load if query param present on mount
  useEffect(() => {
    const q = searchParams.get("q");
    if (q && q !== query) {
      setQuery(q);
    }
    if (q) {
      const fakeEvent = { preventDefault: () => {} } as React.FormEvent;
      setTimeout(() => handleSearch(fakeEvent), 100);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="p-6 max-w-4xl mx-auto">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-white">Account Deep-Dive</h1>
        <p className="text-sm mt-0.5" style={{ color: "#64748b" }}>
          AI-generated briefing from HubSpot, Gmail, Calendar + web search
        </p>
      </div>

      {/* Search */}
      <form onSubmit={handleSearch} className="mb-6">
        <div className="flex gap-3">
          <div className="relative flex-1">
            <Search
              size={16}
              className="absolute left-3 top-1/2 -translate-y-1/2"
              style={{ color: "#64748b" }}
            />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search by company or deal name..."
              className="w-full pl-10 pr-4 py-3 rounded-xl border text-sm outline-none focus:border-indigo-500 transition-colors"
              style={{
                backgroundColor: "#1a1d27",
                borderColor: "#252836",
                color: "#f1f5f9",
              }}
            />
          </div>
          <button
            type="submit"
            disabled={loading || !query.trim()}
            className="px-5 py-3 rounded-xl text-sm font-medium transition-colors disabled:opacity-50"
            style={{ backgroundColor: "#6366f1", color: "white" }}
          >
            {loading ? <Loader2 size={16} className="animate-spin" /> : "Generate Briefing"}
          </button>
        </div>
      </form>

      {/* Loading */}
      {loading && (
        <div className="space-y-4">
          <div
            className="rounded-xl border p-6 flex items-center gap-4"
            style={{ backgroundColor: "#1a1d27", borderColor: "#252836" }}
          >
            <Loader2 size={20} className="animate-spin" style={{ color: "#6366f1" }} />
            <div>
              <p className="text-sm font-medium text-white">Generating briefing for &quot;{query}&quot;</p>
              <p className="text-xs mt-0.5" style={{ color: "#64748b" }}>
                Pulling from HubSpot, Gmail, Calendar, and web search…
              </p>
            </div>
          </div>
          {[1, 2, 3].map((i) => (
            <div
              key={i}
              className="h-40 rounded-xl animate-pulse"
              style={{ backgroundColor: "#1a1d27" }}
            />
          ))}
        </div>
      )}

      {/* Error */}
      {error && (
        <div
          className="flex items-center gap-3 p-4 rounded-xl border"
          style={{ backgroundColor: "#ef444415", borderColor: "#ef444430", color: "#ef4444" }}
        >
          <AlertCircle size={16} />
          <p className="text-sm">{error}</p>
        </div>
      )}

      {/* Briefing */}
      {briefing && !loading && (
        <>
          <AccountBriefingView
            briefing={briefing}
            onPushToHubSpot={() => setShowPushModal(true)}
          />
          {showPushModal && briefing && (
            <PushToHubSpot
              dealId={briefing.dealId ?? ""}
              dealName={briefing.dealName}
              company={briefing.company}
              onClose={() => setShowPushModal(false)}
            />
          )}
        </>
      )}
    </div>
  );
}

export default function AccountPage() {
  return (
    <Suspense fallback={<div className="p-6 text-slate-400">Loading...</div>}>
      <AccountPageContent />
    </Suspense>
  );
}
