import { NextRequest, NextResponse } from "next/server";
import { searchProducts, createLineItem } from "@/lib/hubspot";

export const maxDuration = 60;

export async function POST(req: NextRequest) {
  try {
    const { dealId, lineItems } = await req.json();
    if (!dealId || !lineItems?.length) {
      return NextResponse.json(
        { error: "dealId and at least one line item are required" },
        { status: 400 }
      );
    }

    const created: Array<{ id: string; name: string }> = [];

    for (const item of lineItems as Array<{
      name: string;
      quantity?: string | number;
      unitPrice?: string;
      description?: string;
    }>) {
      const quantity = Number(item.quantity ?? 1);

      // Search product catalog first; use product ID if found
      let productId: string | null = null;
      if (item.name) {
        const products = await searchProducts(item.name);
        if (products.length > 0) {
          productId = products[0].id;
        }
      }

      const lineItem = await createLineItem(
        dealId,
        item.name,
        quantity,
        item.unitPrice ?? null,
        item.description ?? null,
        productId
      );
      created.push({ id: lineItem.id, name: item.name });
    }

    return NextResponse.json({ success: true, lineItems: created });
  } catch (error: any) {
    console.error("HubSpot line-items API error:", error);
    return NextResponse.json(
      { error: error.message || "Failed to add line items" },
      { status: 500 }
    );
  }
}
