import { NextRequest, NextResponse } from "next/server";
import {
  fetchCsaForMonth,
  fetchSnapshot,
  matchCompany,
  type CsaInstance,
} from "@/lib/csa";

export const maxDuration = 60;

// Re-export CsaInstance so the page can still import it from this route
export type { CsaInstance };

// ─── POST /api/msi-renewals/csa ───────────────────────────────────────────────

interface CsaOverride {
  instanceId: number;
  instanceName: string;
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as {
      companies: string[];
      overrides?: Record<string, CsaOverride>;
      nocInstanceIds?: Record<string, number | null>;
      renewalDate?: string;
    };
    const { companies, overrides = {}, nocInstanceIds = {}, renewalDate } = body;

    if (!companies?.length) {
      return NextResponse.json({ error: "companies array required" }, { status: 400 });
    }

    // If a renewalDate is provided and there are nocInstanceIds, use the full
    // ID-based flow (fetches snapshot + get_company for the target month).
    const hasNocIds = Object.values(nocInstanceIds).some((id) => id != null);

    let idMap = new Map<number, number>();
    let csaInstances: CsaInstance[] = [];
    let records: { instance: string; circuits: number; domain: string | null }[] = [];

    if (renewalDate && hasNocIds) {
      const csaData = await fetchCsaForMonth(renewalDate);
      idMap = csaData.idMap;
      csaInstances = csaData.allInstances;
      records = csaData.records;
    } else {
      const snap = await fetchSnapshot();
      records = snap.records;
      csaInstances = snap.allInstances;
    }

    // Exact-name lookup for override resolution
    const byName = new Map<string, (typeof records)[0]>();
    for (const r of records) {
      byName.set(r.instance.toLowerCase().trim(), r);
    }

    const counts: Record<string, number | null> = {};
    for (const company of companies) {
      const override = overrides[company];
      const nocId = nocInstanceIds[company] ?? null;

      if (override?.instanceName) {
        const r = byName.get(override.instanceName.toLowerCase().trim());
        counts[company] = r?.circuits ?? null;
      } else if (nocId != null && idMap.has(nocId)) {
        counts[company] = idMap.get(nocId)!;
      } else {
        const r = matchCompany(company, records);
        counts[company] = r?.circuits ?? null;
      }
    }

    return NextResponse.json({ counts, instances: csaInstances });
  } catch (error: any) {
    console.error("CSA lookup error:", error);
    return NextResponse.json(
      { error: error.message || "CSA lookup failed" },
      { status: 500 }
    );
  }
}
