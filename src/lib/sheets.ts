import { getGoogleToken } from "./google";

const SHEET_ID = "1qkiazR_nrcWAXgfk1BOR8z0lP00s2MLh40ieEj4onC4";
const BASE = "https://sheets.googleapis.com/v4";

async function sheetsGet(path: string): Promise<any> {
  const token = await getGoogleToken();
  const res = await fetch(`${BASE}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Sheets GET error ${res.status}: ${await res.text()}`);
  return res.json();
}

async function sheetsPut(path: string, body: unknown): Promise<any> {
  const token = await getGoogleToken();
  const res = await fetch(`${BASE}${path}`, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Sheets PUT error ${res.status}: ${await res.text()}`);
  return res.json();
}

export interface RenewalSheetRow {
  company: string;
  currentLicense: number | null;
  csaCount: number | null;
  csaRounded: number | null;
  renewalCount: number;
  isAutoRenew?: boolean;
  notes?: string;
}

// Sheet column layout (1-indexed):
//   A=empty prefix, B=Company, C=Renewal License, D=Current License,
//   E=Domo (CSA), F=Domo Rounded, G=Agreement, H=Extensions

// Updates the matching company row in the month tab (e.g. "May 2026").
// Writes renewalCount → Renewal License (C) and Agreement (G),
// csaCount → Domo (E), csaRounded → Domo Rounded (F),
// currentLicense → Current License (D).
// If the company is not found in the tab, appends a new row at the bottom.
export async function appendRenewalRow(monthLabel: string, row: RenewalSheetRow): Promise<void> {
  const tab = `'${monthLabel}'`;

  // Display name written to column B: auto-renew deals get an "(Auto-renew)" suffix.
  const displayName = row.isAutoRenew
    ? `${row.company.trim()} (Auto-renew)`
    : row.company.trim();

  // Read columns A:B to locate the company row.
  // Use A1:B to ensure row indices match the 1-based sheet row numbers exactly.
  const colData = await sheetsGet(
    `/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(tab + "!A1:B")}`
  );
  const colAB: string[][] = colData.values ?? [];

  // Strip any "(Auto-renew)" suffix when matching so both new and existing rows
  // resolve to the same company regardless of whether the suffix was written.
  const needle = row.company.trim().toLowerCase();
  let matchRow = -1; // 0-based index into colAB (index 0 = row 1 in the sheet)
  for (let i = 0; i < colAB.length; i++) {
    const cellB = (colAB[i]?.[1] ?? "")
      .replace(/\s*\(auto-renew\)\s*$/i, "")
      .trim()
      .toLowerCase();
    if (cellB === needle) {
      matchRow = i;
      break;
    }
  }

  // B–G values: Company (display), Renewal License, Current License, Domo, Domo Rounded, Agreement
  const updateValues = [
    displayName,
    row.renewalCount,
    row.currentLicense ?? "",
    row.csaCount ?? "",
    row.csaRounded ?? "",
    row.renewalCount,
  ];

  if (matchRow !== -1) {
    // Company exists — update columns B–G on that row (index 0 = row 1)
    const rowNum = matchRow + 1; // 1-indexed
    const range = encodeURIComponent(`${tab}!B${rowNum}:G${rowNum}`);
    await sheetsPut(
      `/spreadsheets/${SHEET_ID}/values/${range}?valueInputOption=USER_ENTERED`,
      { values: [updateValues] }
    );
  } else {
    // Company not found — append a new row after the last content row
    const allData = await sheetsGet(
      `/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(tab + "!A:G")}`
    );
    const allRows: any[][] = allData.values ?? [];
    const newRowNum = allRows.length + 1;
    const range = encodeURIComponent(`${tab}!A${newRowNum}:G${newRowNum}`);
    await sheetsPut(
      `/spreadsheets/${SHEET_ID}/values/${range}?valueInputOption=USER_ENTERED`,
      { values: [["", ...updateValues]] }
    );
  }
}
