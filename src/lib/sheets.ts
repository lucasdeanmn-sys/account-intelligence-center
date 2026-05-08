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

  // Read columns A:B to locate the company row
  const colData = await sheetsGet(
    `/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(tab + "!A:B")}`
  );
  const colAB: string[][] = colData.values ?? [];

  const needle = row.company.trim().toLowerCase();
  let matchRow = -1; // 0-based index into colAB
  for (let i = 0; i < colAB.length; i++) {
    if ((colAB[i]?.[1] ?? "").trim().toLowerCase() === needle) {
      matchRow = i;
      break;
    }
  }

  // C–G values: Renewal License, Current License, Domo, Domo Rounded, Agreement
  const updateValues = [
    row.renewalCount,
    row.currentLicense ?? "",
    row.csaCount ?? "",
    row.csaRounded ?? "",
    row.renewalCount,
  ];

  if (matchRow !== -1) {
    // Company exists — update columns C–G on that row
    const rowNum = matchRow + 1; // 1-indexed
    const range = encodeURIComponent(`${tab}!C${rowNum}:G${rowNum}`);
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
      { values: [["", row.company, ...updateValues]] }
    );
  }
}
