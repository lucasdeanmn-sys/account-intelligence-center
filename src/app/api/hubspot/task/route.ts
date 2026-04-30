import { NextRequest, NextResponse } from "next/server";

export const maxDuration = 30;

const HUBSPOT_OWNER_ID = "32225666";

export async function POST(req: NextRequest) {
  try {
    const { dealId, subject, dueDate, priority = "MEDIUM", notes } = await req.json();

    if (!dealId || !subject) {
      return NextResponse.json(
        { error: "dealId and subject are required" },
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

    const timestamp = Date.now();
    const dueDateMs = dueDate ? new Date(dueDate).getTime() : undefined;

    const body = {
      engagement: {
        active: true,
        ownerId: HUBSPOT_OWNER_ID,
        type: "TASK",
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
        body: notes || "",
        subject,
        status: "NOT_STARTED",
        ...(dueDateMs && { taskType: "TODO", completionDate: dueDateMs }),
        priority,
        reminders: [],
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
    console.error("HubSpot task API error:", error);
    return NextResponse.json(
      { error: error.message || "Failed to create task" },
      { status: 500 }
    );
  }
}
