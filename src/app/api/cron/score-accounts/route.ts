// app/api/cron/score-accounts/route.ts
// Weekly scoring run — full V1+V2 pipeline:
//   1. Pull PROSPECT companies from HubSpot + attach deal history
//   2. Gather signals in parallel: Fathom mentions, Gmail inbound, Google Alerts news
//   3. Score fit + trigger
//   4. Apply riser bonus vs previous run (Postgres history)
//   5. Write scores back to HubSpot, snapshot history
//   6. Return standing top-75 + weekly top-10 focus with reasons
//
// Wire to Vercel Cron (vercel.json). Protect with CRON_SECRET.

import { NextResponse } from "next/server";
import { fetchProspectCompanies, attachDeals, writeScores } from "@/lib/hubspot/client";
import { scoreAccount, rankAccounts, applyRiserBonus } from "@/lib/scoring/score";
import { SCORING_CONFIG as C } from "@/lib/scoring/config";
import { applyFathomSignal } from "@/lib/signals/fathom";
import { applyGmailSignal } from "@/lib/signals/gmail";
import { applyAlertsSignal } from "@/lib/signals/alerts";
import { ensureSchema, getPreviousTotals, saveSnapshot } from "@/lib/history/db";

export const maxDuration = 300; // signal gathering needs headroom (Vercel Pro)
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  // Vercel Cron sends Authorization: Bearer <CRON_SECRET>
  // Reject when the secret is unconfigured — otherwise `Bearer undefined`
  // would authenticate anyone.
  const auth = request.headers.get("authorization");
  if (!process.env.CRON_SECRET || auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const startedAt = Date.now();

  // 1. Universe + deal history
  const companies = await fetchProspectCompanies();
  await attachDeals(companies);

  // 2. Signals — missing env vars degrade gracefully (signal skipped), but a
  //    FAILED Fathom corpus fetch aborts the run: call mentions carry the
  //    biggest trigger weights, and writing scores computed without them
  //    would wipe every call trigger in HubSpot until the next run (and
  //    poison riser deltas). Gmail/alerts failures stay non-fatal — their
  //    per-company errors are already handled inside each signal.
  let fathomError: string | null = null;
  const [fathomHits, gmailHits, alertsHits] = await Promise.all([
    applyFathomSignal(companies).catch(
      (e) => ((fathomError = e.message ?? "Fathom signal failed"), console.error("fathom", e), 0)
    ),
    applyGmailSignal(companies).catch((e) => (console.error("gmail", e), 0)),
    applyAlertsSignal(companies).catch((e) => (console.error("alerts", e), 0)),
  ]);
  if (fathomError) {
    return NextResponse.json(
      { ok: false, error: fathomError, scoresWritten: false },
      { status: 503 }
    );
  }

  // 3. Score
  let scores = Array.from(companies.values()).map((c) => scoreAccount(c));

  // 4. Riser bonus from score history
  await ensureSchema().catch((e) => console.error("history schema", e));
  const previous = await getPreviousTotals().catch(
    (e) => (console.error("history read", e), new Map<string, number>())
  );
  scores = scores.map((s) => applyRiserBonus(s, previous.get(s.hubspotId)));
  scores = rankAccounts(scores);

  // 5. Persist
  await writeScores(scores);
  await saveSnapshot(scores).catch((e) => console.error("history write", e));

  // 6. Output
  const standingList = scores.slice(0, C.listSize);
  const weeklyFocus = [...standingList]
    .sort((a, b) => b.triggerScore - a.triggerScore)
    .slice(0, C.weeklyFocusSize);

  return NextResponse.json({
    ok: true,
    universe: companies.size,
    signals: { fathomHits, gmailHits, alertsHits },
    tookMs: Date.now() - startedAt,
    standingList: standingList.map((s) => ({
      id: s.hubspotId,
      name: s.name,
      total: s.totalScore,
      fit: s.fitScore,
      trigger: s.triggerScore,
      delta: s.scoreDelta ?? null,
    })),
    weeklyFocus: weeklyFocus.map((s) => ({
      id: s.hubspotId,
      name: s.name,
      trigger: s.triggerScore,
      why: [...s.triggerComponents, ...s.fitComponents].map((p) =>
        p.detail ? `${p.label} — ${p.detail}` : p.label
      ),
    })),
  });
}
