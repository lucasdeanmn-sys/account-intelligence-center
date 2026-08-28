// app/api/cron/zuora-reconcile/route.ts
// Weekly Zuora reconciliation (Mondays, after Adtran's scheduled report email):
//   1. Parse the newest "7sigma weekly" Zuora CSV from Gmail
//   2. Compare each new/revised contract's term against the HubSpot M1 note
//   3. On misalignment, search Gmail for the updated agreement
//      - found: extract terms from the PDF, create a draft M1 note on the
//        company, and open a task linking the email (for Drive + HubSpot
//        file upload — the manual steps that remain)
//      - not found: pass through silently (nothing actionable yet)
//
// ?dry=1 runs read-only and returns everything that WOULD be written.
// Protect with CRON_SECRET like the scoring cron.

import { NextResponse } from "next/server";
import {
  fetchLatestZuoraReport,
  checkAlignment,
  searchAgreementEmails,
  fetchAttachment,
  extractAgreementFromPdf,
  buildM1NoteHtml,
  type Misalignment,
} from "@/lib/zuora";
import { findCompanyIdLoose, getCompanyM1Note, createCompanyNote } from "@/lib/hubspot";
import { googleConfigured } from "@/lib/google";

export const maxDuration = 300;
export const dynamic = "force-dynamic";

const BASE = "https://api.hubapi.com";

function taskSubject(company: string, quote: string): string {
  return `Zuora: updated agreement — ${company} (${quote})`;
}

async function taskExists(subject: string): Promise<boolean> {
  const res = await fetch(`${BASE}/crm/v3/objects/tasks/search`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.HUBSPOT_ACCESS_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      filterGroups: [{ filters: [
        { propertyName: "hs_task_subject", operator: "EQ", value: subject },
      ]}],
      properties: ["hs_task_subject"],
      limit: 1,
    }),
  });
  if (!res.ok) return false;
  return ((await res.json()).results ?? []).length > 0;
}

async function createAgreementTask(
  subject: string,
  bodyLines: string[],
  companyId: string | null
): Promise<string> {
  const due = new Date(Date.now() + 2 * 86_400_000);
  due.setUTCHours(17, 0, 0, 0);
  const body: any = {
    properties: {
      hs_task_subject: subject,
      hs_task_body: bodyLines.join("\n"),
      hs_task_status: "NOT_STARTED",
      hs_task_priority: "HIGH",
      hs_task_type: "TODO",
      hs_timestamp: due.toISOString(),
      hubspot_owner_id: "32225666",
    },
  };
  if (companyId) {
    body.associations = [{
      to: { id: companyId },
      types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: 192 }],
    }];
  }
  const res = await fetch(`${BASE}/crm/v3/objects/tasks`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.HUBSPOT_ACCESS_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Task create failed ${res.status}: ${await res.text()}`);
  return (await res.json()).id;
}

export async function GET(request: Request) {
  const auth = request.headers.get("authorization");
  if (!process.env.CRON_SECRET || auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!googleConfigured() || !process.env.HUBSPOT_ACCESS_TOKEN) {
    return NextResponse.json({ error: "Google/HubSpot not configured" }, { status: 503 });
  }
  const dry = new URL(request.url).searchParams.get("dry") === "1";

  const startedAt = Date.now();

  try {
    const report = await fetchLatestZuoraReport();
    const results: any[] = [];

    for (const contract of report.contracts.slice(0, 20)) {
      const entry: any = {
        company: contract.accountName,
        quote: contract.quoteNumber,
        zuoraTerm: `${contract.subscriptionStart} → ${contract.subscriptionEnd}`,
        charges: contract.charges.map((c) => `${c.chargeStart}: ${c.quantity}`),
      };
      results.push(entry);

      // HubSpot lookup
      const companyId = await findCompanyIdLoose(contract.accountName).catch(() => null);
      entry.hubspotCompanyId = companyId;
      const m1 = companyId ? await getCompanyM1Note(companyId).catch(() => null) : null;

      const mis: Misalignment | null = checkAlignment(contract, m1?.html ?? null, m1?.id ?? null);
      if (!mis) {
        entry.status = "aligned";
        continue;
      }
      entry.status = "MISALIGNED";
      entry.reason = mis.reason;

      // Search email for the updated agreement
      const emails = await searchAgreementEmails(contract.accountName).catch(() => []);
      const withPdf = emails.find((e) =>
        e.attachments.some((a) => /pdf$/i.test(a.filename) || a.mimeType.includes("pdf"))
      );
      if (!withPdf) {
        entry.status = "misaligned — no agreement email found, passing through";
        continue;
      }
      entry.agreementEmail = {
        subject: withPdf.subject,
        from: withPdf.from,
        date: withPdf.date,
        link: withPdf.gmailLink,
      };

      // Extract terms from the PDF
      const pdfAtt = withPdf.attachments.find(
        (a) => /pdf$/i.test(a.filename) || a.mimeType.includes("pdf")
      )!;
      const buf = await fetchAttachment(withPdf.messageId, pdfAtt.attachmentId).catch(() => null);
      const extracted = buf ? await extractAgreementFromPdf(buf).catch(() => null) : null;
      entry.extracted = extracted;

      const subject = taskSubject(contract.accountName, contract.quoteNumber);
      if (await taskExists(subject)) {
        entry.status = "misaligned — task already exists";
        continue;
      }

      const noteHtml =
        extracted?.confident && extracted.years?.length
          ? buildM1NoteHtml(extracted, {
              subject: withPdf.subject,
              date: withPdf.date,
              gmailLink: withPdf.gmailLink,
            })
          : null;
      entry.proposedNote = noteHtml;

      if (dry) {
        entry.status = "misaligned — would create " + (noteHtml ? "note + task" : "task (extraction not confident)");
        continue;
      }

      let noteId: string | null = null;
      if (noteHtml && companyId) {
        noteId = await createCompanyNote(companyId, noteHtml).catch(() => null);
      }
      const taskLines = [
        `Zuora shows a revised/new contract for ${contract.accountName} (quote ${contract.quoteNumber}).`,
        `Zuora term: ${contract.subscriptionStart} through ${contract.subscriptionEnd}`,
        `Mismatch: ${mis.reason}`,
        ``,
        `Updated agreement email found:`,
        `  ${withPdf.subject} — ${withPdf.from} (${withPdf.date})`,
        `  ${withPdf.gmailLink}`,
        `  Attachment: ${pdfAtt.filename}`,
        ``,
        noteId
          ? `Draft M1 note created on the company from this agreement — verify it, then:`
          : `Agreement PDF could not be confidently extracted — create the M1 note manually, then:`,
        `1. Save the attachment to Drive`,
        `2. Upload it to the HubSpot company record`,
        ``,
        `Created by AIC Zuora reconciliation.`,
      ];
      const taskId = await createAgreementTask(subject, taskLines, companyId);
      entry.status = `misaligned — created ${noteId ? "note + " : ""}task ${taskId}`;
      entry.noteId = noteId;
    }

    return NextResponse.json({
      report: { messageId: report.messageId, date: report.date, contracts: report.contracts.length },
      dryRun: dry,
      tookMs: Date.now() - startedAt,
      results,
    });
  } catch (error: any) {
    console.error("Zuora reconcile error:", error);
    return NextResponse.json({ error: error.message || "reconcile failed" }, { status: 500 });
  }
}
