import { NextRequest, NextResponse } from "next/server";
import { updateNoteBody } from "@/lib/hubspot";
import type { RenewalEntry } from "@/lib/types";

export const maxDuration = 30;

/**
 * Wraps the "MSI Year N - ..." line for nextMsiYear in <em> tags,
 * marking it as invoiced in the M1 Order Form note.
 */
function italicizeNextYear(html: string, nextMsiYear: number): string {
  // Check if already italic
  const alreadyRe = new RegExp(
    `<(?:em|i)[^>]*>[^<]*MSI[^<]*Year[^<]*${nextMsiYear}`,
    "i"
  );
  if (alreadyRe.test(html)) return html;

  // Match text content "MSI Year N - ..." sitting directly inside a tag
  // (i.e. preceded by > and followed by <, with no nested tags)
  const re = new RegExp(
    `(>)(\\s*MSI\\s+Year\\s+${nextMsiYear}\\s*[-–—][^<]*)(<)`,
    "gi"
  );
  return html.replace(re, (_, open, content, close) =>
    `${open}<em>${content.trim()}</em>${close}`
  );
}

export async function POST(req: NextRequest) {
  try {
    const { deals } = (await req.json()) as { deals: RenewalEntry[] };
    if (!deals?.length) {
      return NextResponse.json({ error: "deals array required" }, { status: 400 });
    }

    const results: { company: string; status: "updated" | "skipped" | "error"; reason?: string }[] = [];

    for (const deal of deals) {
      // Only process regular renewals with an M1 note
      if (deal.isExtension) {
        results.push({ company: deal.company, status: "skipped", reason: "extension" });
        continue;
      }
      if (!deal.m1NoteId || !deal.m1NoteHtml) {
        results.push({ company: deal.company, status: "skipped", reason: "no M1 note" });
        continue;
      }
      if (!deal.nextMsiYear) {
        results.push({ company: deal.company, status: "skipped", reason: "unknown next year" });
        continue;
      }

      const updatedHtml = italicizeNextYear(deal.m1NoteHtml, deal.nextMsiYear);

      if (updatedHtml === deal.m1NoteHtml) {
        results.push({ company: deal.company, status: "skipped", reason: "already italic" });
        continue;
      }

      try {
        await updateNoteBody(deal.m1NoteId, updatedHtml);
        results.push({ company: deal.company, status: "updated" });
      } catch (e: any) {
        results.push({ company: deal.company, status: "error", reason: e.message });
      }
    }

    const updated = results.filter((r) => r.status === "updated").length;
    return NextResponse.json({ results, updated });
  } catch (error: any) {
    return NextResponse.json({ error: error.message || "Failed" }, { status: 500 });
  }
}
