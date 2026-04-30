import { NextRequest, NextResponse } from "next/server";

export const maxDuration = 30;

const HUBSPOT_OWNER_ID = "32225666";

export async function POST(req: NextRequest) {
  try {
    const { dealId, htmlContent } = await req.json();

    if (!dealId || !htmlContent) {
      return NextResponse.json(
        { error: "dealId and htmlContent are required" },
        { status: 400 }
      );
    }

    const token = process.env.HUBSPOT_ACCESS_TOKEN;
    if (!token) {
      return NextResponse.json(
        { error: "HUBSPOT_ACCESS_TOKEN not configured" },
        { status: 500 }
      );
    }

    // Create note engagement via HubSpot API
    const timestamp = Date.now();

    const body = {
      engagement: {
        active: true,
        ownerId: HUBSPOT_OWNER_ID,
        type: "NOTE",
        timestamp,
      },
      associations: {
        dealIds: [dealId],
        contactIds: [],
        companyIds: [],
        ownerIds: [],
        ticketIds: [],
      },
      metadata: {
        body: htmlContent,
      },
    };

    const res = await fetch("https://api.hubapi.com/engagements/v1/engagements", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`HubSpot API error: ${err}`);
    }

    const data = await res.json();
    return NextResponse.json({ success: true, engagementId: data.engagement?.id });
  } catch (error: any) {
    console.error("HubSpot note API error:", error);
    return NextResponse.json(
      { error: error.message || "Failed to create note" },
      { status: 500 }
    );
  }
}
