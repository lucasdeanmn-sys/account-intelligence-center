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

    const sorted = [...deals].sort((a, b) => a.company.localeCompare(b.company));

    const lines = sorted.map((d) => {
      const count = d.renewalCount?.toLocaleString() ?? "TBD";
      const orderForm = d.orderFormLicense?.toLocaleString();
      const suffix =
        d.renewalCount !== null &&
        d.orderFormLicense !== null &&
        d.renewalCount > d.orderFormLicense
          ? ` (${orderForm})`
          : "";
      return `${d.company} - ${count}${suffix}`;
    });

    const subject = `MSI ${monthLabel} Renewal`;

    const body = [
      `Hi Team,`,
      ``,
      `Please see the ${monthLabel} MSI renewal list below. Licenses have been updated in NOC360 accordingly.`,
      ``,
      ...lines,
      ``,
      `Please let me know if you have any questions.`,
      ``,
      `Thanks,`,
      `Luke`,
    ].join("\n");

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
