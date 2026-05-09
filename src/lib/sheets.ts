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

async function sheetsPost(path: string, body: unknown): Promise<any> {
  const token = await getGoogleToken();
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Sheets POST error ${res.status}: ${await res.text()}`);
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
  /** Comma-separated list of active extension names, e.g. "POM, Fiber Clarity".
   *  Written to column H (Extensions). */
  extensions?: string | null;
  /** Text for the Notes column (column I). */
  sheetNote?: string | null;
}

// Sheet column layout (row 2 = header, data starts row 3):
//   A=empty prefix, B=Company, C=Renewal License, D=Current License,
//   E=Domo (CSA), F=Domo Rounded, G=Agreement, H=Extensions, I=Notes

// Returns true when two company name strings refer to the same company.
// Handles: exact match, singular/plural, "(Auto-renew)" suffix, legal suffixes
// like ", LLC" / ", Inc" / ", Co", and substring containment so that
// "Fiber Connect" matches "Fiber Connect, LLC" and vice-versa.
function companiesMatch(a: string, b: string): boolean {
  const norm = (s: string) =>
    s.toLowerCase().trim()
      .replace(/\s*\(auto-renew\)\s*$/i, "")
      .replace(/[,.]?\s*(llc|inc|co|corp|ltd)\.?\s*$/i, "")
      .trim();
  const na = norm(a);
  const nb = norm(b);
  if (na === nb) return true;
  // Singular/plural: "Communication" vs "Communications"
  if (na + "s" === nb || nb + "s" === na) return true;
  // Substring containment: "Fiber Connect" ↔ "Fiber Connect, LLC"
  if (na.includes(nb) || nb.includes(na)) return true;
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
  const displayName = (row.instanceName?.trim() || row.company.trim());

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
  //             Agreement, Extensions, Notes
  const updateValues = [
    displayName,
    row.renewalCount,
    row.currentLicense ?? "",
    row.csaCount ?? "",
    row.csaRounded ?? "",
    row.renewalCount,
    row.extensions ?? "",    // H: Extensions (e.g. "POM, Fiber Clarity")
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
    // Company not found — insert a new row in alphabetical order within the table.
    // Normalise names for comparison (strip legal suffixes, auto-renew marker, case).
    const normForSort = (s: string) =>
      s.toLowerCase().trim()
       .replace(/\s*\(auto-renew\)\s*$/i, "")
       .replace(/[,.]?\s*(llc|inc|co|corp|ltd)\.?\s*$/i, "")
       .trim();
    const normDisplay = normForSort(displayName);

    // Skip header / empty rows; find first data row whose name sorts after ours.
    let insertAtIndex = -1; // 0-based sheet index; -1 = append after last data row
    for (let i = 0; i < colAB.length; i++) {
      const cellB = (colAB[i]?.[1] ?? "").trim();
      if (!cellB || cellB.toLowerCase() === "company") continue; // header / empty
      if (normDisplay < normForSort(cellB)) {
        insertAtIndex = i;
        break;
      }
    }

    // Get the numeric sheetId for this tab (needed for insertDimension)
    const meta = await sheetsGet(
      `/spreadsheets/${SHEET_ID}?fields=sheets.properties`
    );
    const sheet = (meta.sheets ?? []).find(
      (s: any) => s.properties?.title === monthLabel
    );

    if (sheet && insertAtIndex !== -1) {
      // Insert a blank row at the correct alphabetical position, inheriting the
      // formatting of the row below it (i.e. an existing data row) so it looks
      // like part of the table.
      const sheetId: number = sheet.properties.sheetId;
      await sheetsPost(`/spreadsheets/${SHEET_ID}:batchUpdate`, {
        requests: [{
          insertDimension: {
            range: {
              sheetId,
              dimension: "ROWS",
              startIndex: insertAtIndex,       // 0-based: insert before this row
              endIndex:   insertAtIndex + 1,
            },
            inheritFromBefore: false, // copy formatting from the row now below
          },
        }],
      });
      // Write data into the newly inserted row (1-based = insertAtIndex + 1)
      const newRowNum = insertAtIndex + 1;
      const range = encodeURIComponent(`${tab}!A${newRowNum}:I${newRowNum}`);
      await sheetsPut(
        `/spreadsheets/${SHEET_ID}/values/${range}?valueInputOption=USER_ENTERED`,
        { values: [["", ...updateValues]] }
      );
    } else {
      // Fallback: append after the last data row (company sorts last, or tab not found)
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
}

// Highlights the matching company row red on the month tab to indicate cancellation.
// Uses the same row-matching logic as appendRenewalRow.
export async function cancelRenewalRow(
  monthLabel: string,
  company: string,
  instanceName?: string | null
): Promise<void> {
  const tab = `'${monthLabel}'`;

  // 1. Find the row
  const colData = await sheetsGet(
    `/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(tab + "!A1:B")}`
  );
  const colAB: string[][] = colData.values ?? [];

  const instanceNeedle = instanceName?.trim() ?? null;
  const companyNeedle = company.trim();
  let matchRow = -1;

  for (let i = 0; i < colAB.length; i++) {
    const cellB = colAB[i]?.[1] ?? "";
    if (instanceNeedle && companiesMatch(cellB, instanceNeedle)) { matchRow = i; break; }
    if (matchRow === -1 && companiesMatch(cellB, companyNeedle)) matchRow = i;
  }

  if (matchRow === -1) return; // row not in sheet yet — nothing to highlight

  // 2. Get the numeric sheetId for this tab
  const meta = await sheetsGet(
    `/spreadsheets/${SHEET_ID}?fields=sheets.properties`
  );
  const sheet = (meta.sheets ?? []).find(
    (s: any) => s.properties?.title === monthLabel
  );
  if (!sheet) return;
  const sheetId: number = sheet.properties.sheetId;

  // 3. Color the entire row light red
  await sheetsPost(`/spreadsheets/${SHEET_ID}:batchUpdate`, {
    requests: [
      {
        repeatCell: {
          range: {
            sheetId,
            startRowIndex: matchRow,
            endRowIndex: matchRow + 1,
          },
          cell: {
            userEnteredFormat: {
              backgroundColor: { red: 1.0, green: 0.8, blue: 0.8 },
            },
          },
          fields: "userEnteredFormat.backgroundColor",
        },
      },
    ],
  });
}
