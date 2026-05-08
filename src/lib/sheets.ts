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
  /** CSA instance name — used as the primary row-matching key when present.
   *  Falls back to `company` (HubSpot deal name) when null. */
  instanceName?: string | null;
  currentLicense: number | null;
  csaCount: number | null;
  csaRounded: number | null;
  renewalCount: number;
  isAutoRenew?: boolean;
  /** Text for the Notes column (column I). */
  sheetNote?: string | null;
}

// Sheet column layout (row 2 = header, data starts row 3):
//   A=empty prefix, B=Company, C=Renewal License, D=Current License,
//   E=Domo (CSA), F=Domo Rounded, G=Agreement, H=Extensions, I=Notes

// Returns true when two company name strings refer to the same company, handling
// minor variations like trailing plural 's' and "(Auto-renew)" suffixes.
function companiesMatch(a: string, b: string): boolean {
  const norm = (s: string) =>
    s.toLowerCase().trim().replace(/\s*\(auto-renew\)\s*$/i, "");
  const na = norm(a);
  const nb = norm(b);
  if (na === nb) return true;
  // Singular/plural: "Communication" vs "Communications"
  if (na + "s" === nb || nb + "s" === na) return true;
  return false;
}

// Updates the matching company row in the month tab (e.g. "May 2026").
// Matching priority:
//   1. CSA instance name (row.instanceName) — canonical sheet name
//   2. HubSpot company name (row.company) — fallback
// If no row is found, appends a new row at the bottom.
export async function appendRenewalRow(monthLabel: string, row: RenewalSheetRow): Promise<void> {
  const tab = `'${monthLabel}'`;

  // Display name written to column B: prefer the CSA instance name so the sheet
  // keeps its canonical names; fall back to HubSpot company name.
  // Auto-renew deals get an "(Auto-renew)" suffix.
  const baseName = (row.instanceName?.trim() || row.company.trim());
  const displayName = row.isAutoRenew ? `${baseName} (Auto-renew)` : baseName;

  // Read columns A1:B to locate the company row (index 0 = sheet row 1).
  const colData = await sheetsGet(
    `/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(tab + "!A1:B")}`
  );
  const colAB: string[][] = colData.values ?? [];

  // Try CSA instance name first, then fall back to HubSpot company name.
  const instanceNeedle = row.instanceName?.trim() ?? null;
  const companyNeedle = row.company.trim();
  let matchRow = -1; // 0-based index into colAB (index 0 = sheet row 1)

  for (let i = 0; i < colAB.length; i++) {
    const cellB = colAB[i]?.[1] ?? "";
    // Instance name wins outright
    if (instanceNeedle && companiesMatch(cellB, instanceNeedle)) {
      matchRow = i;
      break;
    }
    // HubSpot company name is a fallback — keep searching in case instance name appears later
    if (matchRow === -1 && companiesMatch(cellB, companyNeedle)) {
      matchRow = i;
    }
  }

  // B–I values: Company, Renewal License, Current License, Domo, Domo Rounded,
  //             Agreement, Extensions (blank), Notes
  const updateValues = [
    displayName,
    row.renewalCount,
    row.currentLicense ?? "",
    row.csaCount ?? "",
    row.csaRounded ?? "",
    row.renewalCount,
    "",                      // H: Extensions — leave as-is (manually managed)
    row.sheetNote ?? "",     // I: Notes
  ];

  if (matchRow !== -1) {
    // Company exists — update columns B–I on that row
    const rowNum = matchRow + 1; // convert 0-based index to 1-based sheet row
    const range = encodeURIComponent(`${tab}!B${rowNum}:I${rowNum}`);
    await sheetsPut(
      `/spreadsheets/${SHEET_ID}/values/${range}?valueInputOption=USER_ENTERED`,
      { values: [updateValues] }
    );
  } else {
    // Company not found — append a new row after the last content row
    const allData = await sheetsGet(
      `/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(tab + "!A:I")}`
    );
    const allRows: any[][] = allData.values ?? [];
    const newRowNum = allRows.length + 1;
    const range = encodeURIComponent(`${tab}!A${newRowNum}:I${newRowNum}`);
    await sheetsPut(
      `/spreadsheets/${SHEET_ID}/values/${range}?valueInputOption=USER_ENTERED`,
      { values: [["", ...updateValues]] }
    );
  }
}
