import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

const BASE = "https://api.hubapi.com";

function token() {
  const t = process.env.HUBSPOT_ACCESS_TOKEN;
  if (!t) throw new Error("HUBSPOT_ACCESS_TOKEN not configured");
  return t;
}

async function raw(method: string, path: string, body?: unknown): Promise<{ ok: boolean; status: number; data: any; error?: string }> {
  try {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token()}`,
        "Content-Type": "application/json",
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    let data: any;
    try { data = JSON.parse(text); } catch { data = text; }
    return { ok: res.ok, status: res.status, data };
  } catch (e: any) {
    return { ok: false, status: 0, data: null, error: e.message };
  }
}

export async function GET(req: NextRequest) {
  const dealId = req.nextUrl.searchParams.get("dealId");
  if (!dealId) {
    return NextResponse.json({ error: "?dealId= required" }, { status: 400 });
  }

  const [v4Assoc, v3Assoc, engagements] = await Promise.all([
    raw("GET", `/crm/v4/objects/deals/${dealId}/associations/notes`),
    raw("GET", `/crm/v3/objects/deals/${dealId}/associations/notes`),
    raw("GET", `/engagements/v1/engagements/associated/DEAL/${dealId}/paged?limit=20`),
  ]);

  // Try batch read if v4 gave us IDs
  const v4Ids: string[] = ((v4Assoc.data?.results ?? []) as any[])
    .map((r: any) => String(r.toObjectId ?? r.id ?? ""))
    .filter(Boolean);
  const v3Ids: string[] = ((v3Assoc.data?.results ?? []) as any[])
    .map((r: any) => String(r.id ?? r.toObjectId ?? ""))
    .filter(Boolean);
  const allIds = [...new Set([...v4Ids, ...v3Ids])];

  let batchRead: any = null;
  if (allIds.length) {
    batchRead = await raw("POST", "/crm/v3/objects/notes/batch/read", {
      inputs: allIds.map((id) => ({ id })),
      properties: ["hs_note_body", "hs_timestamp"],
    });
  }

  // Parse legacy engagements for notes
  const engNotes = ((engagements.data?.results ?? []) as any[])
    .filter((e: any) => e.engagement?.type === "NOTE")
    .map((e: any) => ({
      engagementId: e.engagement?.id,
      createdAt: e.engagement?.createdAt,
      bodyLength: (e.metadata?.body ?? e.metadata?.bodyHtml ?? "").length,
      bodyPreview: (e.metadata?.body ?? e.metadata?.bodyHtml ?? "").slice(0, 200),
      containsM1: (e.metadata?.body ?? e.metadata?.bodyHtml ?? "").toLowerCase().includes("m1 order form"),
    }));

  return NextResponse.json({
    dealId,
    v4Associations: {
      status: v4Assoc.status,
      ok: v4Assoc.ok,
      error: v4Assoc.error,
      resultCount: v4Assoc.data?.results?.length ?? 0,
      ids: v4Ids,
      raw: v4Assoc.data,
    },
    v3Associations: {
      status: v3Assoc.status,
      ok: v3Assoc.ok,
      error: v3Assoc.error,
      resultCount: v3Assoc.data?.results?.length ?? 0,
      ids: v3Ids,
      raw: v3Assoc.data,
    },
    batchRead: batchRead ? {
      status: batchRead.status,
      ok: batchRead.ok,
      error: batchRead.error,
      resultCount: batchRead.data?.results?.length ?? 0,
      notes: ((batchRead.data?.results ?? []) as any[]).map((n: any) => ({
        id: n.id,
        timestamp: n.properties?.hs_timestamp,
        bodyLength: (n.properties?.hs_note_body ?? "").length,
        bodyPreview: (n.properties?.hs_note_body ?? "").slice(0, 300),
        containsM1: (n.properties?.hs_note_body ?? "").toLowerCase().includes("m1 order form"),
      })),
    } : null,
    legacyEngagements: {
      status: engagements.status,
      ok: engagements.ok,
      error: engagements.error,
      totalEngagements: engagements.data?.results?.length ?? 0,
      noteCount: engNotes.length,
      notes: engNotes,
    },
  });
}
