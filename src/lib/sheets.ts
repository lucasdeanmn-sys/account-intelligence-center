const SHEET_ID = "1qkiazR_nrcWAXgfk1BOR8z0lP00s2MLh40ieEj4onC4";
const BASE = "https://sheets.googleapis.com/v4";

function token() {
  const t = process.env.GOOGLE_OAUTH_TOKEN;
  if (!t) throw new Error("GOOGLE_OAUTH_TOKEN not configured");
  return t;
}

async function sheetsGet(path: string): Promise<any> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { Authorization: `Bearer ${token()}` },
  });
  if (!res.ok) throw new Error(`Sheets GET error ${res.status}: ${await res.text()}`);
  return res.json();
}

async function sheetsPost(path: string, body: unknown): Promise<any> {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token()}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Sheets POST error ${res.status}: ${await res.text()}`);
  return res.json();
}

async function sheetsPut(path: string, body: unknown): Promise<any> {
  const res = await fetch(`${BASE}${path}`, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${token()}`,
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

// Appends a row to the correct month section in the MSI Renewal/Term Worksheet.
// Finds the "# Month YYYY" header and appends after existing rows in that section.
// Creates a new section at the bottom if the month doesn't exist yet.
export async function appendRenewalRow(monthLabel: string, row: RenewalSheetRow): Promise<void> {
  // Read column A to locate the month section
  const data = await sheetsGet(
    `/spreadsheets/${SHEET_ID}/values/Sheet1!A:A`
  );
  const colA: string[][] = data.values ?? [];

  const normalizedTarget = `# ${monthLabel}`.toLowerCase().replace(/\s+/g, " ").trim();
  let sectionStart = -1;
  let sectionEnd = colA.length; // default: end of sheet

  for (let i = 0; i < colA.length; i++) {
    const cell = (colA[i]?.[0] ?? "").toLowerCase().replace(/\s+/g, " ").trim();
    if (cell === normalizedTarget) {
      sectionStart = i;
    } else if (sectionStart > -1 && i > sectionStart + 1 && cell.startsWith("# ")) {
      sectionEnd = i;
      break;
    }
  }

  const newRow = [
    row.company,
    row.currentLicense ?? "",
    row.csaCount ?? "",
    row.csaRounded ?? "",
    row.renewalCount,
    row.notes ?? "",
  ];

  if (sectionStart === -1) {
    // Month section doesn't exist — append a new section at the bottom
    const lastRow = colA.length + 1;
    const headerRange = `Sheet1!A${lastRow + 1}`;
    const dataRange = `Sheet1!A${lastRow + 3}`;

    await sheetsPut(
      `/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(headerRange)}?valueInputOption=USER_ENTERED`,
      { values: [[`# ${monthLabel}`]] }
    );
    await sheetsPut(
      `/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(dataRange)}?valueInputOption=USER_ENTERED`,
      { values: [["Company", "Current License", "CSA", "CSA Rounded", "Agreement", "Notes"]] }
    );
    const rowRange = `Sheet1!A${lastRow + 4}`;
    await sheetsPut(
      `/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(rowRange)}?valueInputOption=USER_ENTERED`,
      { values: [newRow] }
    );
  } else {
    // Month section exists — find the first empty row within it
    const fullData = await sheetsGet(
      `/spreadsheets/${SHEET_ID}/values/Sheet1!A${sectionStart + 1}:F${sectionEnd}`
    );
    const sectionRows: any[][] = fullData.values ?? [];
    // Find last non-empty row in section
    let insertOffset = sectionRows.length;
    for (let i = sectionRows.length - 1; i >= 0; i--) {
      const hasContent = sectionRows[i]?.some((c: any) => c !== "");
      if (hasContent) {
        insertOffset = i + 1;
        break;
      }
    }
    const insertRow = sectionStart + 1 + insertOffset + 1; // 1-based
    const rowRange = `Sheet1!A${insertRow}:F${insertRow}`;
    await sheetsPut(
      `/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(rowRange)}?valueInputOption=USER_ENTERED`,
      { values: [newRow] }
    );
  }
}
