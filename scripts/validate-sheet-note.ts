// Validation harness for the MSI Renewal Tracker sheet-note logic.
// Run: npx tsx scripts/validate-sheet-note.ts
// Exercises the real pipeline: decodeNoteEntities → parseTermYears +
// extractItalicYearEntries → computeSheetNote.

import {
  decodeNoteEntities,
  parseTermYears,
  extractItalicYearEntries,
  computeSheetNote,
  SheetNoteResult,
} from "../src/lib/m1Note";

function run(name: string, rawHtml: string | null): SheetNoteResult {
  if (rawHtml === null) {
    // No M1 note found on the deal at all
    return computeSheetNote(false, null, 0);
  }
  const html = decodeNoteEntities(rawHtml);
  const termYears = parseTermYears(html);
  const italicCount = extractItalicYearEntries(html).size;
  return computeSheetNote(true, termYears, italicCount);
}

interface Case {
  name: string;
  html: string | null;
  expectNote?: string | RegExp;
  expectReview: boolean;
}

const cases: Case[] = [
  {
    name: "1. 3-yr form, Years 1/2/3, Year 1 italicized",
    html: `<p>3 Year M1 Order Form:</p><ul><li><em>MSI Year 1 - 1,000</em></li><li>MSI Year 2 - 1,000</li><li>MSI Year 3 - 1,000</li></ul>`,
    expectNote: "Year 2 of 3 on existing M1 agreement",
    expectReview: false,
  },
  {
    name: "2. 3-yr form, Years 8/9/10, Year 8 italicized (position, not cumulative)",
    html: `<p>3 Year M1 Order Form:</p><ul><li><em>MSI Year 8 - 2,500</em></li><li>MSI Year 9 - 2,500</li><li>MSI Year 10 - 2,500</li></ul>`,
    expectNote: "Year 2 of 3 on existing M1 agreement",
    expectReview: false,
  },
  {
    name: "3. 5-yr form, all 5 years italicized (N=6 > M=5)",
    html: `<p>5 Year M1 Order Form:</p><ul><li><em>MSI Year 1 - 1,000</em></li><li><em>MSI Year 2 - 1,000</em></li><li><em>MSI Year 3 - 1,000</em></li><li><em>MSI Year 4 - 1,000</em></li><li><em>MSI Year 5 - 1,000</em></li></ul>`,
    expectNote: "Auto-renewal",
    expectReview: false,
  },
  {
    name: "4a. Title line missing entirely",
    html: `<p>M1 Order details</p><ul><li><em>MSI Year 1 - 1,000</em></li><li>MSI Year 2 - 1,000</li></ul>`,
    expectNote: /NEEDS REVIEW/,
    expectReview: true,
  },
  {
    name: "4b. Title line garbled ('3 Yr M1 Order Form:')",
    html: `<p>3 Yr M1 Order Form:</p><ul><li><em>MSI Year 1 - 1,000</em></li><li>MSI Year 2 - 1,000</li><li>MSI Year 3 - 1,000</li></ul>`,
    expectNote: /NEEDS REVIEW/,
    expectReview: true,
  },
  {
    name: "4c. No M1 note on deal at all",
    html: null,
    expectNote: /NEEDS REVIEW/,
    expectReview: true,
  },
  {
    name: "5. 1-yr form, single year italicized (ambiguous)",
    html: `<p>1 Year M1 Order Form:</p><ul><li><em>MSI Year 4 - 1,200</em></li></ul>`,
    expectNote: /NEEDS REVIEW/,
    expectReview: true,
  },
  // ---- extra hardening regressions ----
  {
    name: "G1. Stray FUTURE italic: 3-yr form with 4 italicized years (italicCount 4 > M 3)",
    html: `<p>3 Year M1 Order Form:</p><ul><li><em>MSI Year 1 - 1,000</em></li><li><em>MSI Year 2 - 1,000</em></li><li><em>MSI Year 3 - 1,000</em></li><li><em>MSI Year 4 - 1,000</em></li></ul>`,
    expectNote: /NEEDS REVIEW/,
    expectReview: true,
  },
  {
    name: "G2. Bullet count ≠ title term: '3 Year' title but 5 bullets, 1 italic → M from TITLE",
    html: `<p>3 Year M1 Order Form:</p><ul><li><em>MSI Year 1 - 1,000</em></li><li>MSI Year 2 - 1,000</li><li>MSI Year 3 - 1,000</li><li>MSI Year 4 - 1,000</li><li>MSI Year 5 - 1,000</li></ul>`,
    expectNote: "Year 2 of 3 on existing M1 agreement",
    expectReview: false,
  },
  {
    name: "G3. 'Updated 3 year M1 Order:' title variant, en-dash entities, 2 italic",
    html: `<p>Updated 3 year M1 Order:</p><ul><li><em>MSI Year 1 &ndash; 1,000</em></li><li><em>MSI Year 2 &ndash; 1,050</em></li><li>MSI Year 3 &ndash; 1,100</li></ul>`,
    expectNote: "Year 3 of 3 on existing M1 agreement",
    expectReview: false,
  },
  {
    name: "G4. 1-yr form, year NOT italicized → Year 1 of 1, no flag",
    html: `<p>1 Year M1 Order Form:</p><ul><li>MSI Year 6 - 1,000</li></ul>`,
    expectNote: "Year 1 of 1 on existing M1 agreement",
    expectReview: false,
  },
  {
    name: "G5. Malformed garbage note (found via 'M1 Order' text, nothing parseable) → no crash",
    html: `<p>m1 order stuff &nbsp; ???</p>`,
    expectNote: /NEEDS REVIEW/,
    expectReview: true,
  },
];

let failed = 0;
for (const c of cases) {
  let res: SheetNoteResult;
  try {
    res = run(c.name, c.html);
  } catch (e: any) {
    console.log(`✗ ${c.name}\n    CRASHED: ${e.message}`);
    failed++;
    continue;
  }
  const noteOk =
    c.expectNote === undefined ||
    (typeof c.expectNote === "string"
      ? res.sheetNote === c.expectNote
      : c.expectNote.test(res.sheetNote));
  const reviewOk = res.needsReview === c.expectReview;
  const pass = noteOk && reviewOk;
  if (!pass) failed++;
  console.log(`${pass ? "✓" : "✗"} ${c.name}`);
  console.log(`    sheetNote:   "${res.sheetNote}"`);
  console.log(`    needsReview: ${res.needsReview}${res.needsReviewReason ? `\n    reason:      ${res.needsReviewReason}` : ""}`);
}

console.log(failed === 0 ? "\nALL CASES PASS" : `\n${failed} CASE(S) FAILED`);
process.exit(failed === 0 ? 0 : 1);
