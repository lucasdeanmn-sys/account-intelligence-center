// lib/zuora.ts
// Weekly Zuora reconciliation: Adtran's scheduled Zuora report (Gmail label
// "Adtran/Zuora Report") lists new/revised M1 contracts — the authoritative
// term + per-year license counts. Compare each against the HubSpot M1 note;
// on misalignment, search Gmail for the updated agreement, extract its terms,
// and stage a note + task. Companies that align (or have no agreement email
// to act on) pass through silently.

import { getGoogleToken } from "./google";
import { callClaude, extractJSON } from "./anthropic";

const ZUORA_LABEL_ID = "Label_3262044976286366000"; // Adtran/Zuora Report

async function gmail(path: string): Promise<any> {
  const token = await getGoogleToken();
  const res = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me${path}`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`Gmail ${res.status}: ${await res.text()}`);
  return res.json();
}

export interface ZuoraCharge {
  quantity: number;
  chargeStart: string; // YYYY-MM-DD
  chargeEnd: string;
}

export interface ZuoraContract {
  accountName: string;
  productDescription: string;
  subscriptionStart: string;
  subscriptionEnd: string;
  quoteNumber: string;
  status: string;
  charges: ZuoraCharge[];
}

// The scheduled report is a UTF-16LE TSV attachment named "7sigma weekly.csv".
export async function fetchLatestZuoraReport(): Promise<{
  messageId: string;
  date: string;
  contracts: ZuoraContract[];
}> {
  const list = await gmail(`/messages?labelIds=${ZUORA_LABEL_ID}&maxResults=1`);
  const messageId: string = list.messages?.[0]?.id;
  if (!messageId) throw new Error("No Zuora report emails found");
  const full = await gmail(`/messages/${messageId}`);
  const date =
    full.payload?.headers?.find((h: any) => h.name?.toLowerCase() === "date")?.value ?? "";

  function findAttachment(part: any): string | null {
    if (part?.filename && part?.body?.attachmentId) return part.body.attachmentId;
    for (const p of part?.parts ?? []) {
      const r = findAttachment(p);
      if (r) return r;
    }
    return null;
  }
  const attId = findAttachment(full.payload);
  if (!attId) throw new Error("Zuora report email has no attachment");
  const att = await gmail(`/messages/${messageId}/attachments/${attId}`);
  const buf = Buffer.from(att.data, "base64url");
  const text = buf.toString("utf16le").replace(/^﻿/, "");

  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  const header = lines[0].split("\t").map((h) => h.trim());
  const col = (name: string) => header.findIndex((h) => h.includes(name));
  const iName = col("Account: Name");
  const iDesc = col("Description");
  const iQty = col("Quantity");
  const iCS = col("Effective Start");
  const iCE = col("Effective End");
  const iSS = col("Subscription Start");
  const iSE = col("Subscription End");
  const iQuote = col("Quote Number");
  const iStatus = col("Status");

  const byKey = new Map<string, ZuoraContract>();
  for (const line of lines.slice(1)) {
    const c = line.split("\t").map((x) => x.trim());
    if (!c[iName]) continue;
    const key = `${c[iName]}|${c[iQuote]}`;
    let contract = byKey.get(key);
    if (!contract) {
      contract = {
        accountName: c[iName],
        productDescription: c[iDesc] ?? "",
        subscriptionStart: c[iSS] ?? "",
        subscriptionEnd: c[iSE] ?? "",
        quoteNumber: c[iQuote] ?? "",
        status: c[iStatus] ?? "",
        charges: [],
      };
      byKey.set(key, contract);
    }
    contract.charges.push({
      quantity: parseInt((c[iQty] ?? "0").replace(/[^\d]/g, ""), 10) || 0,
      chargeStart: c[iCS] ?? "",
      chargeEnd: c[iCE] ?? "",
    });
  }
  return { messageId, date, contracts: Array.from(byKey.values()) };
}

// ── Misalignment check against the HubSpot M1 note ───────────────────────────

export interface Misalignment {
  contract: ZuoraContract;
  reason: string;
  m1NoteId: string | null;
}

// The M1 note's "M1 Term: MM/DD/YYYY through MM/DD/YYYY" line is the recorded
// term. Zuora's Subscription End is authoritative; a revised (extended)
// contract shows a later end date than the note records.
export function checkAlignment(
  contract: ZuoraContract,
  m1NoteHtml: string | null,
  m1NoteId: string | null
): Misalignment | null {
  if (!m1NoteHtml) {
    return { contract, reason: "No M1 order form note found in HubSpot", m1NoteId };
  }
  const text = m1NoteHtml.replace(/<[^>]+>/g, " ").replace(/&[a-z#0-9]+;/gi, " ");
  const termM = text.match(
    /M1\s*Term:\s*(\d{1,2}\/\d{1,2}\/\d{2,4})\s*(?:through|thru|-|–|—)\s*(\d{1,2}\/\d{1,2}\/\d{2,4})/i
  );
  if (!termM) {
    return { contract, reason: "M1 note has no parseable 'M1 Term' line", m1NoteId };
  }
  const noteEnd = new Date(termM[2]);
  const zuoraEnd = new Date(contract.subscriptionEnd + "T00:00:00Z");
  const diffDays = Math.abs(zuoraEnd.getTime() - noteEnd.getTime()) / 86_400_000;
  // Tolerate small offsets (signing vs effective date); beyond ~45 days the
  // contract has been revised/extended relative to the note.
  if (diffDays > 45) {
    return {
      contract,
      reason: `Term end mismatch: Zuora ${contract.subscriptionEnd} vs M1 note ${termM[2]}`,
      m1NoteId,
    };
  }
  return null;
}

// ── Agreement email search ───────────────────────────────────────────────────

export interface AgreementEmail {
  messageId: string;
  threadId: string;
  date: string;
  from: string;
  subject: string;
  attachments: { filename: string; attachmentId: string; mimeType: string }[];
  gmailLink: string;
}

// Zuora account names are ALL CAPS legal names ("MAYFIELD ELECTRIC & WATER
// SYSTEMS"); search on the distinctive leading words.
function searchTerm(accountName: string): string {
  const words = accountName
    .replace(/[^A-Za-z0-9 &]/g, " ")
    .split(/\s+/)
    .filter((w) => w && !/^(the|of|and|&|inc|llc|co|corp)$/i.test(w));
  return words.slice(0, 2).join(" ");
}

export async function searchAgreementEmails(
  accountName: string,
  max = 3
): Promise<AgreementEmail[]> {
  const q = `"${searchTerm(accountName)}" ("order form" OR "M1" OR agreement) has:attachment newer_than:365d`;
  const list = await gmail(`/messages?q=${encodeURIComponent(q)}&maxResults=${max}`);
  const out: AgreementEmail[] = [];
  for (const m of list.messages ?? []) {
    const full = await gmail(`/messages/${m.id}`);
    const hdr = (n: string) =>
      full.payload?.headers?.find((h: any) => h.name?.toLowerCase() === n)?.value ?? "";
    const attachments: AgreementEmail["attachments"] = [];
    (function walk(part: any) {
      if (part?.filename && part?.body?.attachmentId) {
        attachments.push({
          filename: part.filename,
          attachmentId: part.body.attachmentId,
          mimeType: part.mimeType ?? "",
        });
      }
      for (const p of part?.parts ?? []) walk(p);
    })(full.payload);
    out.push({
      messageId: m.id,
      threadId: full.threadId,
      date: hdr("date"),
      from: hdr("from"),
      subject: hdr("subject"),
      attachments,
      gmailLink: `https://mail.google.com/mail/u/0/#all/${m.id}`,
    });
  }
  return out;
}

// ── Agreement extraction (PDF → structured terms via Claude) ─────────────────

export interface ExtractedAgreement {
  termYears: number | null;
  m1TermStart: string | null; // MM/DD/YYYY
  m1TermEnd: string | null;
  years: { year: number; count: number; priorCount?: number | null }[];
  msiTermLine: string | null; // e.g. "08/01 through 07/31"
  confident: boolean;
}

export async function extractAgreementFromPdf(
  pdfBuffer: Buffer
): Promise<ExtractedAgreement | null> {
  // pdf-parse v2 API (class-based)
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { PDFParse } = require("pdf-parse");
  let text = "";
  try {
    const parser = new PDFParse({ data: new Uint8Array(pdfBuffer) });
    const result = await parser.getText();
    text = result?.text ?? "";
  } catch {
    return null;
  }
  if (text.trim().length < 100) return null;

  const SYSTEM = `You extract MSI (Mosaic One Subscriber Insight) contract terms from Adtran order-form documents for a sales rep's CRM notes.
Return ONLY JSON:
{
  "termYears": 3,
  "m1TermStart": "MM/DD/YYYY",
  "m1TermEnd": "MM/DD/YYYY",
  "years": [{ "year": 1, "count": 8250, "priorCount": null }],
  "msiTermLine": "08/01 through 07/31",
  "confident": true
}
"years" lists each contract year's subscriber license count in order (year numbers as the document labels them, or 1..N). Set "confident" false if the document is not an MSI order form or values are ambiguous.`;
  const result = await callClaude(SYSTEM, `Document text:\n\n${text.slice(0, 12000)}`, 2048);
  try {
    return extractJSON<ExtractedAgreement>(result);
  } catch {
    return null;
  }
}

export async function fetchAttachment(messageId: string, attachmentId: string): Promise<Buffer> {
  const att = await gmail(`/messages/${messageId}/attachments/${attachmentId}`);
  return Buffer.from(att.data, "base64url");
}

// ── M1 note HTML generation (canonical format) ───────────────────────────────

export function buildM1NoteHtml(
  ex: ExtractedAgreement,
  source: { subject: string; date: string; gmailLink: string }
): string {
  const fmt = new Intl.NumberFormat("en-US");
  const items = ex.years
    .map((y) => {
      const prior = y.priorCount ? ` (${fmt.format(y.priorCount)})` : "";
      return `<li><p style="margin:0;">MSI Year ${y.year} - ${fmt.format(y.count)}${prior}</p></li>`;
    })
    .join("");
  const termLine =
    ex.m1TermStart && ex.m1TermEnd
      ? `<p style="margin:0;">M1 Term: ${ex.m1TermStart} through ${ex.m1TermEnd}</p>`
      : "";
  const msiLine = ex.msiTermLine
    ? `<p style="margin:0;">MSI Term: ${ex.msiTermLine}</p>`
    : "";
  return (
    `<div><p style="margin:0;">${ex.termYears ?? ex.years.length} Year M1 Order Form:</p>` +
    `<ul>${items}</ul>` +
    termLine +
    msiLine +
    `<p style="margin:0;"><i>[Generated from agreement email "${source.subject}" (${source.date}) — verify against the attached order form before invoicing. ${source.gmailLink}]</i></p></div>`
  );
}
