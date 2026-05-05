import { NextRequest, NextResponse } from "next/server";
import { getMsiDealsByStartDate, getDealNotes } from "@/lib/hubspot";
import type { RenewalEntry } from "@/lib/types";

export const maxDuration = 60;
export const dynamic = "force-dynamic";

function extractCompany(dealName: string): string {
  const idx = dealName.indexOf(" (MSI");
  return idx > 0 ? dealName.slice(0, idx).trim() : dealName.trim();
}

// Handles regular hyphen, en dash, and em dash
function extractYearFromName(dealName: string): number | null {
  const m = dealName.match(/MSI\s*[-–—]\s*Year\s*(\d+)/i);
  return m ? parseInt(m[1], 10) : null;
}

function lastDayOfPreviousMonth(isoDate: string): string {
  const d = new Date(isoDate + "T00:00:00.000Z");
  d.setDate(d.getDate() - 1);
  return d.toISOString().split("T")[0];
}

function addOneYear(isoDate: string): string {
  const d = new Date(isoDate + "T00:00:00.000Z");
  d.setFullYear(d.getFullYear() + 1);
  return d.toISOString().split("T")[0];
}

function parseCount(s: string): number | null {
  const n = parseInt(s.replace(/,/g, ""), 10);
  return isNaN(n) ? null : n;
}

interface M1Parsed {
  dealId: string;
  msiYear: number | null;
  nextMsiYear: number | null;
  orderFormLicense: number | null;
  currentYearLicense: number | null;
  m1NoteHtml: string | null;
}

function parseM1Note(
  dealId: string,
  dealName: string,
  notes: { body: string }[]
): M1Parsed {
  const msiYear = extractYearFromName(dealName);
  const nextMsiYear = msiYear ? msiYear + 1 : null;

  const m1Note = notes.find((n) =>
    n.body.toLowerCase().includes("m1 order form")
  );
  if (!m1Note) {
    return { dealId, msiYear, nextMsiYear, orderFormLicense: null, currentYearLicense: null, m1NoteHtml: null };
  }

  const html = m1Note.body;

  // Collect italic (already-invoiced) entries
  const italicEntries = new Map<number, number>();
  const italicRe = /<(?:em|i)[^>]*>([\s\S]*?)<\/(?:em|i)>/gi;
  let m: RegExpExecArray | null;
  while ((m = italicRe.exec(html)) !== null) {
    const inner = m[1];
    const hit = inner.match(/MSI\s+Year\s+(\d+)\s*[-–—]\s*([\d,]+)/i);
    if (hit) {
      const yr = parseInt(hit[1], 10);
      const cnt = parseCount(hit[2]);
      if (cnt !== null) italicEntries.set(yr, cnt);
    }
  }

  // Collect non-italic (upcoming) entries
  const withoutItalics = html.replace(/<(?:em|i)[^>]*>[\s\S]*?<\/(?:em|i)>/gi, "");
  const nonItalicEntries = new Map<number, { main: number; paren: number | null }>();
  const niRe = /MSI\s+Year\s+(\d+)\s*[-–—]\s*([\d,]+)(?:\s*\(([^)]*)\))?/gi;
  while ((m = niRe.exec(withoutItalics)) !== null) {
    const yr = parseInt(m[1], 10);
    const main = parseCount(m[2]);
    const parenStr = m[3]?.trim() ?? null;
    const paren = parenStr ? parseCount(parenStr) : null;
    if (main !== null) nonItalicEntries.set(yr, { main, paren });
  }

  // orderFormLicense: non-italic entry for the NEXT year
  // If parens contain a number it's the order-form count; otherwise use main count
  let orderFormLicense: number | null = null;
  if (nextMsiYear !== null && nonItalicEntries.has(nextMsiYear)) {
    const e = nonItalicEntries.get(nextMsiYear)!;
    orderFormLicense = e.paren ?? e.main;
  }

  // currentYearLicense: italic entry for the CURRENT year (auto-renew fallback)
  let currentYearLicense: number | null = null;
  if (msiYear !== null && italicEntries.has(msiYear)) {
    currentYearLicense = italicEntries.get(msiYear)!;
  }

  return { dealId, msiYear, nextMsiYear, orderFormLicense, currentYearLicense, m1NoteHtml: html };
}

async function fetchNotesBatched(deals: any[]): Promise<{ dealId: string; notes: any[] }[]> {
  const results: { dealId: string; notes: any[] }[] = [];
  const BATCH = 5;
  for (let i = 0; i < deals.length; i += BATCH) {
    const batch = deals.slice(i, i + BATCH);
    const batchResults = await Promise.all(
      batch.map(async (deal: any) => ({
        dealId: deal.id,
        notes: await getDealNotes(deal.id).catch(() => []),
      }))
    );
    results.push(...batchResults);
  }
  return results;
}

export async function GET(req: NextRequest) {
  if (!process.env.HUBSPOT_ACCESS_TOKEN) {
    return NextResponse.json({ error: "HubSpot not configured" }, { status: 503 });
  }

  const monthParam = req.nextUrl.searchParams.get("month");
  const yearParam = req.nextUrl.searchParams.get("year");
  const startDateParam = req.nextUrl.searchParams.get("startDate");

  if (!monthParam && !yearParam && !startDateParam) {
    return NextResponse.json({ error: "month and year required" }, { status: 400 });
  }

  try {
    let startDate: string;

    if (startDateParam) {
      startDate = startDateParam;
    } else {
      const month = parseInt(monthParam!, 10);
      const year = parseInt(yearParam!, 10);
      if (!month || !year || month < 1 || month > 12) {
        return NextResponse.json({ error: "valid month (1-12) and year required" }, { status: 400 });
      }
      const nextMonth = month === 12 ? 1 : month + 1;
      const nextYear = month === 12 ? year + 1 : year;
      startDate = `${nextYear - 1}-${String(nextMonth).padStart(2, "0")}-01`;
    }

    const renewalStartDate = addOneYear(startDate);
    const expirationDate = lastDayOfPreviousMonth(renewalStartDate);

    const [currentDeals, renewalDeals] = await Promise.all([
      getMsiDealsByStartDate(startDate),
      getMsiDealsByStartDate(renewalStartDate),
    ]);

    const filtered = currentDeals.filter((d: any) =>
      d.properties?.dealname?.includes("(MSI")
    );

    if (!filtered.length) {
      return NextResponse.json({ deals: [], expirationDate, renewalStartDate });
    }

    const renewalDealMap = new Map<string, any>();
    for (const rd of renewalDeals) {
      if (rd.properties?.dealname?.includes("(MSI")) {
        const co = extractCompany(rd.properties.dealname);
        renewalDealMap.set(co.toLowerCase(), rd);
      }
    }

    // Fetch notes for all current deals
    const notesAndItems = await fetchNotesBatched(filtered);

    // Parse M1 notes with regex (fast, no AI required)
    const parsedMap = new Map<string, M1Parsed>();
    for (const deal of filtered) {
      const rawNotes = notesAndItems.find((n) => n.dealId === deal.id)?.notes ?? [];
      const notes = rawNotes.map((n: any) => ({
        body: n.properties?.hs_note_body ?? "",
      }));
      const parsed = parseM1Note(deal.id, deal.properties?.dealname ?? "", notes);
      parsedMap.set(deal.id, parsed);
    }

    // Build enriched entries
    const entries: RenewalEntry[] = filtered.map((deal: any) => {
      const company = extractCompany(deal.properties?.dealname ?? "");
      const parsed = parsedMap.get(deal.id) ?? {
        dealId: deal.id,
        msiYear: null,
        nextMsiYear: null,
        orderFormLicense: null,
        currentYearLicense: null,
        m1NoteHtml: null,
      };
      const msiYear = parsed.msiYear ?? extractYearFromName(deal.properties?.dealname ?? "");
      const nextMsiYear = msiYear ? msiYear + 1 : null;
      const orderFormLicense: number | null = parsed.orderFormLicense ?? null;
      const currentYearLicense: number | null = parsed.currentYearLicense ?? null;

      const csaCount: number | null = null;
      const csaRounded: number | null = null;

      const licenseFallback = orderFormLicense ?? currentYearLicense;
      const renewalCount =
        csaRounded !== null || licenseFallback !== null
          ? Math.max(csaRounded ?? 0, licenseFallback ?? 0)
          : null;

      const renewalDeal = renewalDealMap.get(company.toLowerCase()) ?? null;
      const renewalDealName = `${company} (MSI - Year ${nextMsiYear ?? "?"})`;

      const dealName = deal.properties?.dealname ?? "";
      const isExtension = /extension/i.test(dealName);

      return {
        currentDealId: deal.id,
        currentDealName: dealName,
        company,
        isExtension,
        msiYear,
        nextMsiYear,
        orderFormLicense,
        currentYearLicense,
        csaCount,
        csaRounded,
        renewalCount,
        renewalDealId: renewalDeal?.id ?? null,
        renewalDealName,
        renewalStartDate,
        expirationDate,
        m1NoteHtml: parsed.m1NoteHtml ?? null,
      };
    });

    entries.sort((a, b) => a.company.localeCompare(b.company));

    return NextResponse.json({ deals: entries, expirationDate, renewalStartDate });
  } catch (error: any) {
    console.error("MSI renewals GET error:", error);
    return NextResponse.json({ error: error.message || "Internal server error" }, { status: 500 });
  }
}
