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
  company?: string;
  onClose: () => void;
}

type Tab = "note" | "task" | "contact" | "deal" | "line-items";

const TABS: { id: Tab; label: string }[] = [
  { id: "note", label: "Note" },
  { id: "task", label: "Task" },
  { id: "contact", label: "Contact" },
  { id: "deal", label: "Deal" },
  { id: "line-items", label: "Line Items" },
];

const SUCCESS_MESSAGES: Record<Tab, string> = {
  note: "Note posted to HubSpot!",
  task: "Task created in HubSpot!",
  contact: "Contact created in HubSpot!",
  deal: "Deal created in HubSpot!",
  "line-items": "Line items added to deal!",
};

function Field({
  label,
  required,
  children,
}: {
  label: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label className="block text-xs font-medium mb-1.5" style={{ color: "#94a3b8" }}>
        {label} {required && <span style={{ color: "#ef4444" }}>*</span>}
      </label>
      {children}
    </div>
  );
}

const inputClass =
  "w-full px-3 py-2.5 rounded-xl border text-sm outline-none focus:border-indigo-500 transition-colors";
const inputStyle = { backgroundColor: "#0f1117", borderColor: "#252836", color: "#f1f5f9" };

export default function PushToHubSpot({ dealId, dealName, company, onClose }: Props) {
  const [tab, setTab] = useState<Tab>("note");
  const [submitting, setSubmitting] = useState(false);
  const [success, setSuccess] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Note
  const [noteHtml, setNoteHtml] = useState("");
  const [preview, setPreview] = useState(false);

  // Task
  const [taskSubject, setTaskSubject] = useState("");
  const [taskDueDate, setTaskDueDate] = useState("");
  const [taskPriority, setTaskPriority] = useState<"LOW" | "MEDIUM" | "HIGH">("MEDIUM");
  const [taskNotes, setTaskNotes] = useState("");

  // Contact
  const [contactFirst, setContactFirst] = useState("");
  const [contactLast, setContactLast] = useState("");
  const [contactEmail, setContactEmail] = useState("");
  const [contactPhone, setContactPhone] = useState("");
  const [contactTitle, setContactTitle] = useState("");

  // Deal
  const [newDealName, setNewDealName] = useState(company ? `${company} - ` : "");
  const [newDealStage, setNewDealStage] = useState("");
  const [newDealAmount, setNewDealAmount] = useState("");
  const [newDealCloseDate, setNewDealCloseDate] = useState("");

  // Line Items
  const [lineItems, setLineItems] = useState([
    { name: "", quantity: "1", unitPrice: "", description: "" },
  ]);

  function addLineItem() {
    setLineItems((prev) => [...prev, { name: "", quantity: "1", unitPrice: "", description: "" }]);
  }

  function updateLineItem(index: number, field: string, value: string) {
    setLineItems((prev) =>
      prev.map((item, i) => (i === index ? { ...item, [field]: value } : item))
    );
  }

  function removeLineItem(index: number) {
    setLineItems((prev) => prev.filter((_, i) => i !== index));
  }

  function isValid(): boolean {
    switch (tab) {
      case "note": return noteHtml.trim().length > 0;
      case "task": return taskSubject.trim().length > 0;
      case "contact": return contactFirst.trim().length > 0 && contactLast.trim().length > 0 && contactEmail.trim().length > 0;
      case "deal": return newDealName.trim().length > 0 && newDealStage.trim().length > 0;
      case "line-items": return lineItems.some((li) => li.name.trim().length > 0);
    }
  }

  async function handleSubmit() {
    if (!isValid()) return;
    setSubmitting(true);
    setError(null);

    try {
      let endpoint = "";
      let body: Record<string, unknown> = {};

      switch (tab) {
        case "note":
          endpoint = "/api/hubspot/note";
          body = { dealId, htmlContent: noteHtml };
          break;
        case "task":
          endpoint = "/api/hubspot/task";
          body = { dealId, subject: taskSubject, dueDate: taskDueDate || undefined, priority: taskPriority, notes: taskNotes || undefined };
          break;
        case "contact":
          endpoint = "/api/hubspot/contact";
          body = { dealId, firstName: contactFirst, lastName: contactLast, email: contactEmail, phone: contactPhone || undefined, title: contactTitle || undefined };
          break;
        case "deal":
          endpoint = "/api/hubspot/deal";
          body = { company, dealName: newDealName, stage: newDealStage, amount: newDealAmount ? Number(newDealAmount) : undefined, closeDate: newDealCloseDate || undefined };
          break;
        case "line-items":
          endpoint = "/api/hubspot/line-items";
          body = { dealId, lineItems: lineItems.filter((li) => li.name.trim()) };
          break;
      }

      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(await res.text());
      setSuccess(true);
      setTimeout(onClose, 2000);
    } catch (e: any) {
      setError(e.message || "Something went wrong");
    } finally {
      setSubmitting(false);
    }
  }

  if (success) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ backgroundColor: "#0f1117cc" }}>
        <div className="rounded-2xl border p-8 flex flex-col items-center gap-3" style={{ backgroundColor: "#1a1d27", borderColor: "#252836" }}>
          <CheckCircle size={40} style={{ color: "#22c55e" }} />
          <p className="text-white font-semibold">{SUCCESS_MESSAGES[tab]}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ backgroundColor: "#0f1117cc" }}>
      <div className="w-full max-w-2xl rounded-2xl border shadow-2xl flex flex-col max-h-[90vh]" style={{ backgroundColor: "#1a1d27", borderColor: "#252836" }}>

        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b flex-shrink-0" style={{ borderColor: "#252836" }}>
          <div>
            <h2 className="text-sm font-semibold text-white">HubSpot Actions</h2>
            <p className="text-xs mt-0.5" style={{ color: "#64748b" }}>{dealName}</p>
          </div>
          <button onClick={onClose} className="p-1 rounded-lg hover:bg-white/5 transition-colors" style={{ color: "#64748b" }}>
            <X size={16} />
          </button>
        </div>

        {/* Tabs */}
        <div className="flex border-b flex-shrink-0 overflow-x-auto" style={{ borderColor: "#252836" }}>
          {TABS.map(({ id, label }) => (
            <button
              key={id}
              onClick={() => { setTab(id); setError(null); }}
              className="px-4 py-3 text-sm font-medium whitespace-nowrap transition-colors border-b-2 flex-shrink-0"
              style={{
                borderColor: tab === id ? "#6366f1" : "transparent",
                color: tab === id ? "#6366f1" : "#64748b",
              }}
            >
              {label}
            </button>
          ))}
        </div>

        {/* Body */}
        <div className="p-6 overflow-y-auto flex-1">

          {/* NOTE */}
          {tab === "note" && (
            <div className="space-y-4">
              <div className="flex gap-2">
                <button onClick={() => setPreview(false)} className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors" style={{ backgroundColor: !preview ? "#6366f120" : "transparent", color: !preview ? "#6366f1" : "#64748b" }}>
                  <Edit3 size={12} /> Edit HTML
                </button>
                <button onClick={() => setPreview(true)} disabled={!noteHtml.trim()} className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors disabled:opacity-40" style={{ backgroundColor: preview ? "#6366f120" : "transparent", color: preview ? "#6366f1" : "#64748b" }}>
                  <Eye size={12} /> Preview
                </button>
              </div>
              {!preview ? (
                <textarea value={noteHtml} onChange={(e) => setNoteHtml(e.target.value)} placeholder={"<p>Call with <strong>John</strong> — discussed renewal timeline.</p>\n<ul><li>Send updated proposal by Friday</li></ul>"} rows={10} className={`${inputClass} font-mono resize-none p-3`} style={inputStyle} />
              ) : (
                <div className="rounded-xl border p-4 min-h-40 text-sm" style={{ backgroundColor: "#0f1117", borderColor: "#252836", color: "#cbd5e1" }} dangerouslySetInnerHTML={{ __html: noteHtml }} />
              )}
            </div>
          )}

          {/* TASK */}
          {tab === "task" && (
            <div className="space-y-4">
              <Field label="Subject" required>
                <input type="text" value={taskSubject} onChange={(e) => setTaskSubject(e.target.value)} placeholder="e.g. Follow up on renewal proposal" className={inputClass} style={inputStyle} />
              </Field>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Due Date">
                  <input type="date" value={taskDueDate} onChange={(e) => setTaskDueDate(e.target.value)} className={inputClass} style={inputStyle} />
                </Field>
                <Field label="Priority">
                  <select value={taskPriority} onChange={(e) => setTaskPriority(e.target.value as any)} className={inputClass} style={inputStyle}>
                    <option value="LOW">Low</option>
                    <option value="MEDIUM">Medium</option>
                    <option value="HIGH">High</option>
                  </select>
                </Field>
              </div>
              <Field label="Notes">
                <textarea value={taskNotes} onChange={(e) => setTaskNotes(e.target.value)} placeholder="Additional context..." rows={3} className={`${inputClass} resize-none`} style={inputStyle} />
              </Field>
            </div>
          )}

          {/* CONTACT */}
          {tab === "contact" && (
            <div className="space-y-4">
              <p className="text-xs" style={{ color: "#64748b" }}>
                Creates a new contact in HubSpot and associates them with this deal.
              </p>
              <div className="grid grid-cols-2 gap-3">
                <Field label="First Name" required>
                  <input type="text" value={contactFirst} onChange={(e) => setContactFirst(e.target.value)} placeholder="Jane" className={inputClass} style={inputStyle} />
                </Field>
                <Field label="Last Name" required>
                  <input type="text" value={contactLast} onChange={(e) => setContactLast(e.target.value)} placeholder="Smith" className={inputClass} style={inputStyle} />
                </Field>
              </div>
              <Field label="Email" required>
                <input type="email" value={contactEmail} onChange={(e) => setContactEmail(e.target.value)} placeholder="jane@company.com" className={inputClass} style={inputStyle} />
              </Field>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Phone">
                  <input type="tel" value={contactPhone} onChange={(e) => setContactPhone(e.target.value)} placeholder="+1 555 000 0000" className={inputClass} style={inputStyle} />
                </Field>
                <Field label="Job Title">
                  <input type="text" value={contactTitle} onChange={(e) => setContactTitle(e.target.value)} placeholder="VP of IT" className={inputClass} style={inputStyle} />
                </Field>
              </div>
            </div>
          )}

          {/* DEAL */}
          {tab === "deal" && (
            <div className="space-y-4">
              <p className="text-xs" style={{ color: "#64748b" }}>
                Creates a new deal in HubSpot. Owner defaults to your account.
              </p>
              <Field label="Deal Name" required>
                <input type="text" value={newDealName} onChange={(e) => setNewDealName(e.target.value)} placeholder="Acme Corp - Enterprise Renewal" className={inputClass} style={inputStyle} />
              </Field>
              <Field label="Pipeline Stage" required>
                <input type="text" value={newDealStage} onChange={(e) => setNewDealStage(e.target.value)} placeholder="e.g. Proposal Sent, Negotiation, Contract Sent" className={inputClass} style={inputStyle} />
              </Field>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Amount ($)">
                  <input type="number" value={newDealAmount} onChange={(e) => setNewDealAmount(e.target.value)} placeholder="50000" className={inputClass} style={inputStyle} />
                </Field>
                <Field label="Close Date">
                  <input type="date" value={newDealCloseDate} onChange={(e) => setNewDealCloseDate(e.target.value)} className={inputClass} style={inputStyle} />
                </Field>
              </div>
            </div>
          )}

          {/* LINE ITEMS */}
          {tab === "line-items" && (
            <div className="space-y-4">
              <p className="text-xs" style={{ color: "#64748b" }}>
                Adds line items to this deal. Enter product names exactly as they appear in your HubSpot product library, or use a custom name.
              </p>

              <div className="space-y-3">
                {lineItems.map((item, i) => (
                  <div key={i} className="rounded-xl border p-4 space-y-3" style={{ backgroundColor: "#0f1117", borderColor: "#252836" }}>
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-medium" style={{ color: "#64748b" }}>
                        Line Item {i + 1}
                      </span>
                      {lineItems.length > 1 && (
                        <button onClick={() => removeLineItem(i)} className="text-xs hover:text-red-400 transition-colors" style={{ color: "#64748b" }}>
                          Remove
                        </button>
                      )}
                    </div>
                    <Field label="Product / Name" required>
                      <input type="text" value={item.name} onChange={(e) => updateLineItem(i, "name", e.target.value)} placeholder="e.g. Enterprise License, Professional Services" className={inputClass} style={inputStyle} />
                    </Field>
                    <div className="grid grid-cols-2 gap-3">
                      <Field label="Quantity">
                        <input type="number" min="1" value={item.quantity} onChange={(e) => updateLineItem(i, "quantity", e.target.value)} className={inputClass} style={inputStyle} />
                      </Field>
                      <Field label="Unit Price ($)">
                        <input type="number" value={item.unitPrice} onChange={(e) => updateLineItem(i, "unitPrice", e.target.value)} placeholder="0.00" className={inputClass} style={inputStyle} />
                      </Field>
                    </div>
                    <Field label="Description">
                      <input type="text" value={item.description} onChange={(e) => updateLineItem(i, "description", e.target.value)} placeholder="Optional description" className={inputClass} style={inputStyle} />
                    </Field>
                  </div>
                ))}
              </div>

              <button onClick={addLineItem} className="w-full py-2 rounded-xl border text-sm transition-colors hover:border-indigo-500/40" style={{ borderColor: "#252836", borderStyle: "dashed", color: "#64748b" }}>
                + Add Another Line Item
              </button>
            </div>
          )}

          {/* Error */}
          {error && (
            <div className="flex items-center gap-2 p-3 rounded-xl mt-3 text-xs border" style={{ backgroundColor: "#ef444415", borderColor: "#ef444430", color: "#ef4444" }}>
              <AlertCircle size={13} />
              {error}
            </div>
          )}

          {/* Submit */}
          <div className="flex justify-end mt-5">
            <button
              onClick={handleSubmit}
              disabled={submitting || !isValid()}
              className="flex items-center gap-2 px-5 py-2.5 rounded-xl text-sm font-medium transition-colors disabled:opacity-50"
              style={{ backgroundColor: "#6366f1", color: "white" }}
            >
              {submitting ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}
              {submitting ? "Saving..." : {
                note: "Post Note",
                task: "Create Task",
                contact: "Create Contact",
                deal: "Create Deal",
                "line-items": "Add Line Items",
              }[tab]}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
