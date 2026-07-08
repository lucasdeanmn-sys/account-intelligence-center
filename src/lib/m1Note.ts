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
 * Collect non-italic (not-yet-invoiced) year entries from the note.
 * Returns year → { main, paren } counts. Expects entity-decoded HTML.
 * Handles both "Year N - 1,000 (opt_paren)" and paren-only "Year N - (1,000)".
 */
export function extractNonItalicYearEntries(
  html: string
): Map<number, { main: number | null; paren: number | null }> {
  const withoutItalics = html.replace(/<(?:em|i)[^>]*>[\s\S]*?<\/(?:em|i)>/gi, "");
  const entries = new Map<number, { main: number | null; paren: number | null }>();
  const niRe =
    /(?:MSI\s+)?Year\s+(\d+)\s*[-–—−:]\s*(?:([\d,]+)(?:\s*\(([^)]*)\))?|\(([^)]*)\))/gi;
  let m: RegExpExecArray | null;
  while ((m = niRe.exec(withoutItalics)) !== null) {
    const yr = parseInt(m[1], 10);
    const main = m[2] ? parseCount(m[2]) : null;
    const parenStr = (m[3] ?? m[4])?.trim() ?? null;
    const paren = parenStr ? parseCount(parenStr) : null;
    if (main !== null || paren !== null) entries.set(yr, { main, paren });
  }
  return entries;
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

/** Strip HTML tags/entities and return the first line of visible note text
 *  (up to maxLen chars) — used to show what a garbled title actually says. */
export function noteFirstLine(html: string, maxLen = 90): string {
  const text = html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(?:p|div|li|h\d)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&[a-z#0-9]+;/gi, " ");
  const firstLine =
    text
      .split("\n")
      .map((l) => l.replace(/\s+/g, " ").trim())
      .find((l) => l.length > 0) ?? "";
  return firstLine.length > maxLen ? firstLine.slice(0, maxLen) + "…" : firstLine;
}

/** Format [8, 9, 10] → "Years 8, 9, 10"; [4] → "Year 4". */
function fmtYears(years: number[]): string {
  return `Year${years.length === 1 ? "" : "s"} ${years.join(", ")}`;
}

export interface SheetNoteInput {
  /** Decoded M1 note HTML, or null when no M1 note was found on the deal. */
  noteHtml: string | null;
  /** Term length parsed from the title line — the ONLY source of M. */
  termYears: number | null;
  /** Italicized (invoiced) MSI year numbers found in the note, ascending. */
  italicYears: number[];
  /** Non-italic (not-yet-invoiced) MSI year numbers found in the note. */
  nonItalicYears: number[];
}

/**
 * Derive the sheet note from parsed M1 data. Fails loud, not silent:
 *
 *  - Missing note or missing/unparseable title line → needs-review (these used
 *    to silently render "Auto-renewal", hiding data problems). The reason
 *    includes what the note's first line actually says.
 *  - A CONTIGUOUS run of italicized years is trusted, including past the term:
 *    the bookkeeping convention keeps italicizing each invoiced year as an
 *    account auto-renews, so italicCount > M with an unbroken run simply means
 *    the account has auto-renewed (italicCount − M) times → "Auto-renewal".
 *  - A BROKEN run — an uninvoiced (non-italic or missing) year sitting BELOW
 *    italicized years — is the real bad-data signature (a stray future year
 *    italicized, or an invoiced year that lost its italics) → needs-review,
 *    naming the specific years.
 *  - 1-year form whose only year is italicized → needs-review, naming the year
 *    and stating the rule applied. Under the italicCount+1 rule it computes
 *    N=2 > M=1 = Auto-renewal, but such accounts are often just in their
 *    active final year, so we surface the ambiguity instead of guessing.
 *
 * Never throws — every input maps to a result.
 */
export function computeSheetNote(input: SheetNoteInput): SheetNoteResult {
  const { noteHtml, termYears } = input;
  const italicYears = [...input.italicYears].sort((a, b) => a - b);
  const italicCount = italicYears.length;

  if (noteHtml === null) {
    return review(
      "NEEDS REVIEW — no M1 order form note found",
      "No M1 order form note found on this deal. Create the M1 note " +
        '(title "<N> Year M1 Order Form:", bullets "MSI Year <n> - <count>") ' +
        "or check whether it's attached to the wrong company/deal."
    );
  }

  if (termYears === null || termYears < 1) {
    const firstLine = noteFirstLine(noteHtml);
    const italicPart = italicCount
      ? ` ${fmtYears(italicYears)} ${italicCount === 1 ? "is" : "are"} italicized, but N can't be computed without the term.`
      : "";
    return review(
      "NEEDS REVIEW — M1 note title missing or unparseable",
      `Term length could not be parsed from the note title. The note's first line reads ` +
        `"${firstLine || "(empty)"}" — expected "<N> Year M1 Order Form:". ` +
        `Fix the title line, then the year math will resolve.${italicPart}`
    );
  }

  const M = termYears; // term length, from the title ONLY
  const N = italicCount + 1; // first uninvoiced year, 1-based position within this form

  // Guard: invoiced (italicized) years must form an unbroken run. An
  // uninvoiced year sitting BELOW italicized years means either a stray
  // future year was italicized or an invoiced year lost its italics —
  // either way the year math can't be trusted.
  if (italicCount > 0) {
    const maxItalic = italicYears[italicYears.length - 1];
    const uninvoicedBelow = input.nonItalicYears
      .filter((y) => y < maxItalic)
      .sort((a, b) => a - b);
    const missingInRun: number[] = [];
    for (let y = italicYears[0] + 1; y < maxItalic; y++) {
      if (!italicYears.includes(y) && !input.nonItalicYears.includes(y)) {
        missingInRun.push(y);
      }
    }
    const broken = [...uninvoicedBelow, ...missingInRun].sort((a, b) => a - b);
    if (broken.length) {
      return review(
        `NEEDS REVIEW — italicized years aren't a contiguous run (${fmtYears(broken)} uninvoiced below Year ${maxItalic})`,
        `Invoiced (italicized) years must form an unbroken run, but ${fmtYears(broken)} ` +
          `${broken.length === 1 ? "sits" : "sit"} uninvoiced below italicized Year ${maxItalic}. ` +
          `Either de-italicize the stray future year(s) above, or italicize the invoiced year(s) below.`
      );
    }
  }

  if (N > M) {
    // Every contracted year is invoiced. A contiguous run past the term means
    // the account has auto-renewed (italicCount − M) times — normal bookkeeping,
    // not bad data.
    if (M === 1 && italicCount === 1) {
      // Ambiguous: often just the active final year, not a true auto-renewal.
      const yr = italicYears[0];
      return review(
        `NEEDS REVIEW — 1-year form with its only year (Year ${yr}) italicized (computed Auto-renewal; may be Year 1 of 1)`,
        `Single-year form whose only listed year (MSI Year ${yr}) is italicized. ` +
          `Rule applied: N = italicCount + 1 = 2 > M = 1 → Auto-renewal. ` +
          `If this account is actually in its active final year it should read "Year 1 of 1" — ` +
          `de-italicize MSI Year ${yr} if it hasn't been invoiced yet; leave it if Auto-renewal is correct.`
      );
    }
    return ok("Auto-renewal");
  }

  return ok(`Year ${N} of ${M} on existing M1 agreement`);
}
