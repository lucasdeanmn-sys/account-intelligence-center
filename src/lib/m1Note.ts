// Pure M1 order-form note logic for the MSI Renewal Tracker.
//
// Extracted from src/app/api/msi-renewals/route.ts so it can be unit-tested
// without pulling in Next.js server dependencies (route files can't export
// arbitrary helpers).
//
// Data format each renewal account's M1 note follows:
//   Title line:   "<integer> Year M1 Order Form:"   (e.g. "3 Year M1 Order Form:")
//   Bullet lines: "MSI Year <n> - <count>"
//   Italicized MSI Year lines = already invoiced/paid years.
//
// Derivation rules (single source of truth):
//   M = termYears, parsed ONLY from the title line. Never derived from the
//       bullet count — a 3-year form listing Years 8/9/10 is still M = 3.
//   N = italicCount + 1. Italics = invoiced, so the current year is the first
//       uninvoiced one, as a 1-based position WITHIN this order form (position,
//       not the cumulative MSI year number).
//   N <= M      → "Year N of M on existing M1 agreement"
//   N == M + 1  → "Auto-renewal" (every contracted year invoiced)
//   Anything that can't be trusted → needsReview (fail loud, never silent).

/** Parse "1,000" → 1000. Returns null when not a number. */
export function parseCount(s: string): number | null {
  const n = parseInt(s.replace(/,/g, ""), 10);
  return isNaN(n) ? null : n;
}

/**
 * Decode common HTML entities that HubSpot may store (e.g. &ndash; for –) so
 * the dash-matching regexes below work regardless of how the note was typed.
 */
export function decodeNoteEntities(rawHtml: string): string {
  return rawHtml
    .replace(/&ndash;/gi, "–")
    .replace(/&mdash;/gi, "—")
    .replace(/&minus;/gi, "−")
    .replace(/&#8211;/gi, "–")
    .replace(/&#8212;/gi, "—")
    .replace(/&#x2013;/gi, "–")
    .replace(/&#x2014;/gi, "—")
    .replace(/&nbsp;/gi, " ");
}

/**
 * Year entry pattern: matches all three forms:
 *   "MSI Year N - X,XXX"          → group 2 = main count
 *   "MSI Year N - X,XXX (Y,YYY)"  → group 2 = main count (paren ignored here)
 *   "MSI Year N - (X,XXX)"        → group 3 = paren-only count
 */
export const YEAR_ENTRY_RE =
  /(?:MSI\s+)?Year\s+(\d+)\s*[-–—−:]\s*(?:([\d,]+)(?:\s*\([^)]*\))?|\((\d[\d,]*)\))/i;

/**
 * Collect italic (already-invoiced) year entries: Map of year number → count.
 * Expects entity-decoded HTML (see decodeNoteEntities).
 * Unique years only — the same year italicized twice counts once.
 */
export function extractItalicYearEntries(html: string): Map<number, number> {
  const italicEntries = new Map<number, number>();
  const italicRe = /<(?:em|i)[^>]*>([\s\S]*?)<\/(?:em|i)>/gi;
  let m: RegExpExecArray | null;
  while ((m = italicRe.exec(html)) !== null) {
    const inner = m[1];
    const hit = inner.match(YEAR_ENTRY_RE);
    if (hit) {
      const yr = parseInt(hit[1], 10);
      // Group 2 = main count; group 3 = paren-only count
      const cnt = hit[2] ? parseCount(hit[2]) : hit[3] ? parseCount(hit[3]) : null;
      if (cnt !== null) italicEntries.set(yr, cnt);
    }
  }
  return italicEntries;
}

/**
 * Parse the term length M from the M1 note title line. This is the ONLY
 * source of M — never derive it from the bullet count.
 *   "3 Year M1 Order Form:"      → 3
 *   "Updated 3 year M1 Order:"   → 3
 * Returns null when the title is missing or unparseable.
 */
export function parseTermYears(html: string): number | null {
  const m = html.match(/(?:updated\s+)?(\d+)\s+years?\s+m1\s+order/i);
  return m ? parseInt(m[1], 10) : null;
}

export interface SheetNoteResult {
  /** Human-readable note for the tracker/sheet Notes column. */
  sheetNote: string;
  /** True when the M1 note failed a sanity check and needs manual cleanup. */
  needsReview: boolean;
  /** Why the entry was flagged (null when needsReview is false). */
  needsReviewReason: string | null;
}

function ok(sheetNote: string): SheetNoteResult {
  return { sheetNote, needsReview: false, needsReviewReason: null };
}

function review(sheetNote: string, reason: string): SheetNoteResult {
  return { sheetNote, needsReview: true, needsReviewReason: reason };
}

/**
 * Derive the sheet note from parsed M1 data. Fails loud, not silent:
 *
 *  - Missing note or missing/unparseable title line → needs-review (these used
 *    to silently render "Auto-renewal", hiding data problems).
 *  - italicCount > M (stray italicized FUTURE years inflating N) → needs-review.
 *    Legitimate auto-renewal is exactly N === M + 1, i.e. italicCount === M.
 *  - 1-year form whose only year is italicized → needs-review. Under the
 *    italicCount+1 rule it computes N=2 > M=1 = Auto-renewal, but such accounts
 *    are often just in their active final year, so we surface the ambiguity and
 *    state which rule was applied instead of guessing.
 *
 * Never throws — every input maps to a result.
 */
export function computeSheetNote(
  hasM1Note: boolean,
  termYears: number | null,
  italicCount: number
): SheetNoteResult {
  if (!hasM1Note) {
    return review(
      "NEEDS REVIEW — no M1 order form note found",
      "No M1 order form note found on the deal, so term/year math is impossible."
    );
  }

  if (termYears === null || termYears < 1) {
    return review(
      "NEEDS REVIEW — M1 note title missing or unparseable",
      'Could not parse the term length from the note title ("<N> Year M1 Order Form:"). ' +
        "Fix the title line before trusting the year math."
    );
  }

  const M = termYears; // term length, from the title ONLY
  const N = italicCount + 1; // first uninvoiced year, 1-based position within this form

  // Guard: more italic years than the term allows means a future year is
  // italicized that shouldn't be. Rendering Auto-renewal here would be wrong.
  if (italicCount > M) {
    return review(
      `NEEDS REVIEW — ${italicCount} italicized year${italicCount === 1 ? "" : "s"} exceed the ${M}-year term`,
      `italicCount (${italicCount}) > termYears (${M}): a stray future year is italicized ` +
        "beyond what can have been invoiced — clean up the note."
    );
  }

  if (N > M) {
    // Here N === M + 1 exactly (every contracted year invoiced).
    if (M === 1) {
      // Ambiguous: often just the active final year, not a true auto-renewal.
      return review(
        "NEEDS REVIEW — 1-year form fully italicized (italicCount+1 rule computes Auto-renewal; may be Year 1 of 1)",
        "Single-year form with its only year italicized. Rule applied: N = italicCount + 1 = 2 > M = 1 " +
          "→ Auto-renewal. But such accounts are often in their active final year (Year 1 of 1). " +
          "Confirm intended behavior for this note."
      );
    }
    return ok("Auto-renewal");
  }

  return ok(`Year ${N} of ${M} on existing M1 agreement`);
}
