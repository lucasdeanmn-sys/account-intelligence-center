import { NextRequest, NextResponse } from "next/server";
import { runAgentLoop, configured, hubspotServer } from "@/lib/anthropic";

export const maxDuration = 60;

const SYSTEM = `You are a HubSpot CRM assistant. Add line items to a deal. For each line item, search the HubSpot product library first — if a matching product exists, use it. If not, create a custom line item. Associate all line items with the specified deal. Confirm success with the word DONE and the line item IDs.`;

export async function POST(req: NextRequest) {
  try {
    const { dealId, lineItems } = await req.json();

    if (!dealId || !lineItems?.length) {
      return NextResponse.json(
        { error: "dealId and at least one line item are required" },
        { status: 400 }
      );
    }

    const itemList = lineItems
      .map(
        (item: { name: string; quantity: string; unitPrice: string; description: string }, i: number) =>
          `${i + 1}. Name: ${item.name} | Quantity: ${item.quantity || 1}${item.unitPrice ? ` | Unit price: $${item.unitPrice}` : ""}${item.description ? ` | Description: ${item.description}` : ""}`
      )
      .join("\n");

    const result = await runAgentLoop(
      SYSTEM,
      `Add the following line items to HubSpot deal ID "${dealId}":

${itemList}`,
      configured(hubspotServer()),
      2048
    );

    return NextResponse.json({ success: true, result });
  } catch (error: any) {
    console.error("HubSpot line-items API error:", error);
    return NextResponse.json(
      { error: error.message || "Failed to add line items" },
      { status: 500 }
    );
  }
}
