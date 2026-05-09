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

    const formatLine = (d: RenewalEntry) => {
      const count = d.renewalCount?.toLocaleString() ?? "TBD";
      const orderForm = d.orderFormLicense?.toLocaleString();
      // Show order-form qty in parens when CSA count is higher
      const countSuffix =
        d.renewalCount !== null &&
        d.orderFormLicense !== null &&
        d.renewalCount > d.orderFormLicense
          ? ` (${orderForm})`
          : "";
      // Extension names, e.g. "POM & Fiber Clarity"
      const extPart =
        d.extensionNames?.length
          ? ` — ${d.extensionNames.join(" & ")}`
          : "";
      // Sheet note, e.g. "Year 3 of 3 on existing M1 agreement" or "Auto-renewal"
      const notePart = d.sheetNote ? ` — ${d.sheetNote}` : "";
      return `${d.company} - ${count}${countSuffix}${extPart}${notePart}`;
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
