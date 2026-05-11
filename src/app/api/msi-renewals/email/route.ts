import { NextRequest, NextResponse } from "next/server";
import type { RenewalEntry } from "@/lib/types";

export const maxDuration = 30;

const RECIPIENTS = [
  "sherry.woodruff@adtran.com",
  "liliana.mckune@adtran.com",
  "lloyd.mcdonald@adtran.com",
  "kathleen.walsh@adtran.com",
  "jtermaat@7sigma.com",
];

export async function POST(req: NextRequest) {
  try {
    const { deals, monthLabel } = await req.json() as {
      deals: RenewalEntry[];
      monthLabel: string;
    };

    if (!deals?.length) {
      return NextResponse.json({ error: "deals array required" }, { status: 400 });
    }

    const renewals = [...deals].sort((a, b) => a.company.localeCompare(b.company));

    const formatLine = (d: RenewalEntry): string => {
      const count = d.renewalCount?.toLocaleString() ?? "TBD";
      // Shorten "Year X of Y on existing M1 agreement" → "Year X of Y"
      const note = d.sheetNote
        ? d.sheetNote.replace(/\s+on existing M1 agreement$/i, "")
        : null;
      // Combine note + extension names into a single parenthetical so the line
      // stays on one row — Gmail strips leading-space indentation when converting
      // plain text to HTML, making separate sub-bullet lines merge into the main.
      const parts = [note, ...(d.extensionNames ?? [])].filter(Boolean);
      const notePart = parts.length > 0 ? ` (${parts.join(", ")})` : "";
      return `• ${d.company} — ${count}${notePart}`;
    };

    const subject = `MSI ${monthLabel} Renewal`;

    const bodyParts = [
      `Hi Team,`,
      ``,
      `Please see the ${monthLabel} MSI renewal list below. Licenses have been updated in NOC360 accordingly.`,
      ``,
      ...renewals.map(formatLine),
      ``,
      `Please let me know if you have any questions.`,
      ``,
      `Thanks,`,
      `Luke`,
    ];

    const body = bodyParts.join("\n");

    return NextResponse.json({
      subject,
      body,
      to: RECIPIENTS,
    });
  } catch (error: any) {
    console.error("MSI email generation error:", error);
    return NextResponse.json(
      { error: error.message || "Failed to generate email" },
      { status: 500 }
    );
  }
}
