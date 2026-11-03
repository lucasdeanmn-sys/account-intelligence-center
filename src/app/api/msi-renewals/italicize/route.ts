import { NextRequest, NextResponse } from "next/server";
import { updateNoteBody } from "@/lib/hubspot";
import { italicizeYearInNote } from "@/lib/m1Note";
import type { RenewalEntry } from "@/lib/types";

export const maxDuration = 30;

export async function POST(req: NextRequest) {
  try {
    const { deals } = (await req.json()) as { deals: RenewalEntry[] };
    if (!deals?.length) {
      return NextResponse.json({ error: "deals array required" }, { status: 400 });
    }

    const results: { company: string; status: "updated" | "skipped" | "error"; reason?: string }[] = [];

    for (const deal of deals) {
      if (!deal.m1NoteId || !deal.m1NoteHtml) {
        results.push({ company: deal.company, status: "skipped", reason: "no M1 note" });
        continue;
      }
      if (!deal.nextMsiYear) {
        results.push({ company: deal.company, status: "skipped", reason: "unknown next year" });
        continue;
      }

      const updatedHtml = italicizeYearInNote(deal.m1NoteHtml, deal.nextMsiYear);

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
