import { NextRequest, NextResponse } from "next/server";
import type { RenewalEntry } from "@/lib/types";
import { getRenewalBilledCounts } from "@/lib/hubspot";

export const maxDuration = 30;

const RECIPIENTS = [
  "liliana.mckune@adtran.com",
  "lloyd.mcdonald@adtran.com",
  "kathleen.walsh@adtran.com",
  "jtermaat@7sigma.com",
];

// NOC360 renewals are internal — they go only to Joan.
const RECIPIENTS_NOC360 = ["jtermaat@7sigma.com"];

export async function POST(req: NextRequest) {
  try {
    const { deals, monthLabel, platform } = await req.json() as {
      deals: RenewalEntry[];
      monthLabel: string;
      platform?: "MSI" | "NOC360";
    };
    const isNoc360 = platform === "NOC360";

    if (!deals?.length) {
      return NextResponse.json({ error: "deals array required" }, { status: 400 });
    }

    const renewals = [...deals].sort((a, b) => a.company.localeCompare(b.company));

    // Report the quantity actually on the renewal deal in HubSpot (what gets
    // invoiced), not the report's pre-process figure — these can drift (Fiber
    // Connect: line item 1,600, emailed figure 1,000). For any renewal deal
    // that exists, the line-item quantity wins; otherwise fall back to the
    // report's renewalCount.
    const renewalDealIds = renewals
      .map((d) => d.renewalDealId)
      .filter((id): id is string => !!id);
    const billedByDeal = await getRenewalBilledCounts(renewalDealIds).catch(
      () => new Map<string, number>()
    );

    const formatLine = (d: RenewalEntry): string => {
      const actual = d.renewalDealId ? billedByDeal.get(d.renewalDealId) : undefined;
      const count = (actual ?? d.renewalCount)?.toLocaleString() ?? "TBD";
      if (isNoc360) {
        // NOC360 lines are plain company + count — no M1 note/extension context.
        return `• ${d.company} — ${count}`;
      }
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

    const subject = isNoc360
      ? `NOC360 ${monthLabel} Renewal`
      : `MSI ${monthLabel} Renewal`;

    const bodyParts = isNoc360
      ? [
          `Hi Joan,`,
          ``,
          `Please see the ${monthLabel} NOC360 renewal list below.`,
          ``,
          ...renewals.map(formatLine),
          ``,
          `Please let me know if you have any questions.`,
          ``,
          `Thanks,`,
          `Luke`,
        ]
      : [
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
      to: isNoc360 ? RECIPIENTS_NOC360 : RECIPIENTS,
    });
  } catch (error: any) {
    console.error("MSI email generation error:", error);
    return NextResponse.json(
      { error: error.message || "Failed to generate email" },
      { status: 500 }
    );
  }
}
