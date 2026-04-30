"use client";

import { useState } from "react";
import {
  X,
  Send,
  Eye,
  Edit3,
  CheckCircle,
  Loader2,
  AlertCircle,
} from "lucide-react";

interface Props {
  dealId: string;
  dealName: string;
  onClose: () => void;
}

type Tab = "note" | "task";

export default function PushToHubSpot({ dealId, dealName, onClose }: Props) {
  const [tab, setTab] = useState<Tab>("note");
  const [noteHtml, setNoteHtml] = useState("");
  const [taskSubject, setTaskSubject] = useState("");
  const [taskDueDate, setTaskDueDate] = useState("");
  const [taskPriority, setTaskPriority] = useState<"LOW" | "MEDIUM" | "HIGH">("MEDIUM");
  const [taskNotes, setTaskNotes] = useState("");
  const [preview, setPreview] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [success, setSuccess] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmitNote() {
    if (!noteHtml.trim()) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/hubspot/note", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dealId, htmlContent: noteHtml }),
      });
      if (!res.ok) throw new Error(await res.text());
      setSuccess(true);
      setTimeout(onClose, 2000);
    } catch (e: any) {
      setError(e.message || "Failed to post note");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleSubmitTask() {
    if (!taskSubject.trim()) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/hubspot/task", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          dealId,
          subject: taskSubject,
          dueDate: taskDueDate || undefined,
          priority: taskPriority,
          notes: taskNotes || undefined,
        }),
      });
      if (!res.ok) throw new Error(await res.text());
      setSuccess(true);
      setTimeout(onClose, 2000);
    } catch (e: any) {
      setError(e.message || "Failed to create task");
    } finally {
      setSubmitting(false);
    }
  }

  if (success) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ backgroundColor: "#0f1117cc" }}>
        <div
          className="rounded-2xl border p-8 flex flex-col items-center gap-3"
          style={{ backgroundColor: "#1a1d27", borderColor: "#252836" }}
        >
          <CheckCircle size={40} style={{ color: "#22c55e" }} />
          <p className="text-white font-semibold">
            {tab === "note" ? "Note posted to HubSpot!" : "Task created in HubSpot!"}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ backgroundColor: "#0f1117cc" }}>
      <div
        className="w-full max-w-2xl rounded-2xl border shadow-2xl"
        style={{ backgroundColor: "#1a1d27", borderColor: "#252836" }}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b" style={{ borderColor: "#252836" }}>
          <div>
            <h2 className="text-sm font-semibold text-white">Push to HubSpot</h2>
            <p className="text-xs mt-0.5" style={{ color: "#64748b" }}>{dealName}</p>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded-lg hover:bg-white/5 transition-colors"
            style={{ color: "#64748b" }}
          >
            <X size={16} />
          </button>
        </div>

        {/* Tabs */}
        <div className="flex border-b" style={{ borderColor: "#252836" }}>
          {(["note", "task"] as Tab[]).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className="px-6 py-3 text-sm font-medium capitalize transition-colors border-b-2"
              style={{
                borderColor: tab === t ? "#6366f1" : "transparent",
                color: tab === t ? "#6366f1" : "#64748b",
              }}
            >
              {t === "note" ? "Add Note" : "Create Task"}
            </button>
          ))}
        </div>

        <div className="p-6">
          {tab === "note" ? (
            <div className="space-y-4">
              {/* Toggle edit/preview */}
              <div className="flex gap-2">
                <button
                  onClick={() => setPreview(false)}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors"
                  style={{
                    backgroundColor: !preview ? "#6366f120" : "transparent",
                    color: !preview ? "#6366f1" : "#64748b",
                  }}
                >
                  <Edit3 size={12} /> Edit HTML
                </button>
                <button
                  onClick={() => setPreview(true)}
                  disabled={!noteHtml.trim()}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors disabled:opacity-40"
                  style={{
                    backgroundColor: preview ? "#6366f120" : "transparent",
                    color: preview ? "#6366f1" : "#64748b",
                  }}
                >
                  <Eye size={12} /> Preview
                </button>
              </div>

              {!preview ? (
                <textarea
                  value={noteHtml}
                  onChange={(e) => setNoteHtml(e.target.value)}
                  placeholder="Enter HTML note content...&#10;&#10;Example:&#10;&lt;p&gt;Had a call with &lt;strong&gt;John&lt;/strong&gt;. Discussed renewal timeline.&lt;/p&gt;&#10;&lt;ul&gt;&lt;li&gt;Send updated proposal by Friday&lt;/li&gt;&lt;/ul&gt;"
                  rows={10}
                  className="w-full rounded-xl border text-sm font-mono outline-none focus:border-indigo-500 transition-colors resize-none p-3"
                  style={{
                    backgroundColor: "#0f1117",
                    borderColor: "#252836",
                    color: "#f1f5f9",
                  }}
                />
              ) : (
                <div
                  className="rounded-xl border p-4 min-h-40 text-sm prose-dark"
                  style={{ backgroundColor: "#0f1117", borderColor: "#252836", color: "#cbd5e1" }}
                  dangerouslySetInnerHTML={{ __html: noteHtml }}
                />
              )}
            </div>
          ) : (
            <div className="space-y-4">
              <div>
                <label className="block text-xs font-medium mb-1.5" style={{ color: "#94a3b8" }}>
                  Task Subject *
                </label>
                <input
                  type="text"
                  value={taskSubject}
                  onChange={(e) => setTaskSubject(e.target.value)}
                  placeholder="e.g. Follow up on renewal proposal"
                  className="w-full px-3 py-2.5 rounded-xl border text-sm outline-none focus:border-indigo-500 transition-colors"
                  style={{ backgroundColor: "#0f1117", borderColor: "#252836", color: "#f1f5f9" }}
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium mb-1.5" style={{ color: "#94a3b8" }}>
                    Due Date
                  </label>
                  <input
                    type="date"
                    value={taskDueDate}
                    onChange={(e) => setTaskDueDate(e.target.value)}
                    className="w-full px-3 py-2.5 rounded-xl border text-sm outline-none focus:border-indigo-500 transition-colors"
                    style={{ backgroundColor: "#0f1117", borderColor: "#252836", color: "#f1f5f9" }}
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium mb-1.5" style={{ color: "#94a3b8" }}>
                    Priority
                  </label>
                  <select
                    value={taskPriority}
                    onChange={(e) => setTaskPriority(e.target.value as any)}
                    className="w-full px-3 py-2.5 rounded-xl border text-sm outline-none focus:border-indigo-500 transition-colors"
                    style={{ backgroundColor: "#0f1117", borderColor: "#252836", color: "#f1f5f9" }}
                  >
                    <option value="LOW">Low</option>
                    <option value="MEDIUM">Medium</option>
                    <option value="HIGH">High</option>
                  </select>
                </div>
              </div>
              <div>
                <label className="block text-xs font-medium mb-1.5" style={{ color: "#94a3b8" }}>
                  Notes (optional)
                </label>
                <textarea
                  value={taskNotes}
                  onChange={(e) => setTaskNotes(e.target.value)}
                  placeholder="Additional notes about this task..."
                  rows={3}
                  className="w-full px-3 py-2.5 rounded-xl border text-sm outline-none focus:border-indigo-500 transition-colors resize-none"
                  style={{ backgroundColor: "#0f1117", borderColor: "#252836", color: "#f1f5f9" }}
                />
              </div>
            </div>
          )}

          {/* Error */}
          {error && (
            <div
              className="flex items-center gap-2 p-3 rounded-xl mt-3 text-xs border"
              style={{ backgroundColor: "#ef444415", borderColor: "#ef444430", color: "#ef4444" }}
            >
              <AlertCircle size={13} />
              {error}
            </div>
          )}

          {/* Submit */}
          <div className="flex justify-end mt-5">
            <button
              onClick={tab === "note" ? handleSubmitNote : handleSubmitTask}
              disabled={submitting || (tab === "note" ? !noteHtml.trim() : !taskSubject.trim())}
              className="flex items-center gap-2 px-5 py-2.5 rounded-xl text-sm font-medium transition-colors disabled:opacity-50"
              style={{ backgroundColor: "#6366f1", color: "white" }}
            >
              {submitting ? (
                <Loader2 size={14} className="animate-spin" />
              ) : (
                <Send size={14} />
              )}
              {submitting
                ? "Posting..."
                : tab === "note"
                ? "Post Note to HubSpot"
                : "Create Task in HubSpot"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
