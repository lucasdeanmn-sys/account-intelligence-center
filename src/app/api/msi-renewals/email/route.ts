import { NextRequest, NextResponse } from "next/server";
import type { RenewalEntry } from "@/lib/types";
import { getRenewalDealInfo } from "@/lib/hubspot";
import type { RenewalDealInfo } from "@/lib/hubspot";

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

    // Pull the quantity AND extensions straight off the renewal deal in HubSpot
    // (what gets invoiced), not the report's pre-process figures — these drift:
    //   - count: Fiber Connect line item 1,600 but emailed 1,000.
    //   - extensions: the active-extension index drops an extension the moment
    //     its standalone deal is terminated, even though it's now a line item on
    //     the renewal (Nuvera's POM). The deal's own line items are the truth.
    const renewalDealIds = renewals
      .map((d) => d.renewalDealId)
      .filter((id): id is string => !!id);
    const infoByDeal = await getRenewalDealInfo(renewalDealIds).catch(
      () => new Map<string, RenewalDealInfo>()
    );

    const formatLine = (d: RenewalEntry): string => {
      const info = d.renewalDealId ? infoByDeal.get(d.renewalDealId) : undefined;
      const count = (info?.billedQty ?? d.renewalCount)?.toLocaleString() ?? "TBD";
      if (isNoc360) {
        // NOC360 lines are plain company + count — no M1 note/extension context.
        return `• ${d.company} — ${count}`;
      }
      // Shorten "Year X of Y on existing M1 agreement" → "Year X of Y"
      const note = d.sheetNote
        ? d.sheetNote.replace(/\s+on existing M1 agreement$/i, "")
        : null;
      // Extension labels from the deal's line items; fall back to the report's
      // names. Nuvera is a one-off exception where the extension bills on a
      // different quantity than the MSI count (POM on fiber circuits), so its
      // line shows the POM quantity — e.g. "(Auto-renewal, 22,300 POM)".
      const nuveraException = /\bnuvera\b/i.test(d.company);
      const extLabels =
        info?.extensions && info.extensions.length > 0
          ? info.extensions.map((e) =>
              nuveraException && e.qty != null
                ? `${e.qty.toLocaleString()} ${e.name}`
                : e.name
            )
          : d.extensionNames ?? [];
      // Combine note + extension labels into a single parenthetical so the line
      // stays on one row — Gmail strips leading-space indentation when converting
      // plain text to HTML, making separate sub-bullet lines merge into the main.
      const parts = [note, ...extLabels].filter(Boolean);
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
