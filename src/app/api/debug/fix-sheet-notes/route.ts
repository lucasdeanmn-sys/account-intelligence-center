import { NextRequest, NextResponse } from "next/server";
import { getGoogleToken } from "@/lib/google";

const SHEET_ID = "1qkiazR_nrcWAXgfk1BOR8z0lP00s2MLh40ieEj4onC4";
const BASE = "https://sheets.googleapis.com/v4";

// Companies whose May 2026 sheet note should be "Auto-renewal"
// (old computeSheetNote wrote "Year X of Y"; new N>M logic correctly says Auto-renewal)
const AUTO_RENEWAL_COMPANIES = [
  "AW Broadband",
  "Bartlett Electric Cooperative",
  "BEC Communication",
  "Cyber Broadband",
  "Decatur",
  "Little Miami Gig",
  "Ohio Gig",
  "MINET",
  "Modern Cooperative Telephone",
  "Southwest Texas",
  "Town of Mountain Village",
  "TruVista",
  "United TN",
];

function companiesMatch(a: string, b: string): boolean {
  const norm = (s: string) =>
    s.toLowerCase().trim()
      .replace(/\s*\(auto-renew\)\s*$/i, "")
      .replace(/[,.]?\s*(llc|inc|co|corp|ltd)\.?\s*$/i, "")
      .trim();
  const na = norm(a);
  const nb = norm(b);
  if (na === nb) return true;
  if (na + "s" === nb || nb + "s" === na) return true;
  if (na.includes(nb) || nb.includes(na)) return true;
  return false;
}

async function sheetsGet(token: string, path: string) {
  const res = await fetch(`${BASE}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`GET ${res.status}: ${await res.text()}`);
  return res.json();
}

async function sheetsPut(token: string, path: string, body: unknown) {
  const res = await fetch(`${BASE}${path}`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`PUT ${res.status}: ${await res.text()}`);
  return res.json();
}

export async function GET(req: NextRequest) {
  const dry = req.nextUrl.searchParams.get("dry") !== "false";
  const tab = "May 2026";
  const token = await getGoogleToken();

  const colData = await sheetsGet(token, `/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(`'${tab}'!B1:I`)}`);
  const rows: string[][] = colData.values ?? [];

  const updates: { rowNum: number; company: string; oldNote: string; newNote: string }[] = [];

  for (let i = 0; i < rows.length; i++) {
    const cellB = rows[i]?.[0] ?? "";
    const cellI = rows[i]?.[7] ?? "";
    if (!cellB || cellB.toLowerCase() === "company") continue;

    const shouldBeAutoRenew = AUTO_RENEWAL_COMPANIES.some((c) => companiesMatch(cellB, c));
    if (shouldBeAutoRenew && cellI !== "Auto-renewal") {
      updates.push({ rowNum: i + 1, company: cellB, oldNote: cellI, newNote: "Auto-renewal" });
    }
  }

  if (!dry && updates.length > 0) {
    for (const u of updates) {
      const range = encodeURIComponent(`'${tab}'!I${u.rowNum}`);
      await sheetsPut(token, `/spreadsheets/${SHEET_ID}/values/${range}?valueInputOption=USER_ENTERED`, {
        values: [[u.newNote]],
      });
    }
  }

  return NextResponse.json({ dry, tab, updates });
}
