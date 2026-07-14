// lib/scoring/score.ts
// Pure functions: CompanyRecord in, AccountScore out. No I/O here — keeps it testable.

import { SCORING_CONFIG as C } from "./config";
import type { AccountScore, CompanyRecord, ScoreComponent } from "./types";

const daysBetween = (iso: string, now: Date) =>
  Math.floor((now.getTime() - new Date(iso).getTime()) / 86_400_000);

const monthsBetween = (iso: string, now: Date) => daysBetween(iso, now) / 30.44;

export function computeFit(c: CompanyRecord, now = new Date()): ScoreComponent[] {
  const parts: ScoreComponent[] = [];

  // Subscriber band
  if (c.subscriberCount != null && !Number.isNaN(c.subscriberCount)) {
    const band = C.subscriberBands.find(
      (b) => c.subscriberCount! >= b.min && c.subscriberCount! < b.max
    );
    if (band) parts.push({ key: "subs", label: band.label, points: band.points });
  } else {
    parts.push({ key: "subs", label: "Subscriber count unknown", points: C.subscriberUnknownPoints });
  }

  // Segment
  parts.push({
    key: "segment",
    label: `Segment: ${c.segment}`,
    points: C.segmentPoints[c.segment] ?? C.segmentPoints.UNKNOWN,
  });

  // Reference-state proximity
  if (c.state && C.referenceStates.includes(c.state.toUpperCase())) {
    parts.push({
      key: "geo",
      label: `Reference-customer state (${c.state.toUpperCase()})`,
      points: C.referenceStatePoints,
    });
  }

  // Calix displacement
  if (c.isCalixShop) {
    parts.push({ key: "calix", label: "Calix footprint (displacement play)", points: C.calixShopPoints });
  }

  // Relationship history — take the single best of closed-lost recency vs stalled open deal
  const historyCandidates: ScoreComponent[] = [];
  for (const d of c.deals) {
    if (d.isClosedLost && d.closedDate) {
      const m = monthsBetween(d.closedDate, now);
      const tier = C.closedLostRecency.find((t) => m <= t.maxMonths);
      if (tier) historyCandidates.push({ key: "history", label: tier.label, points: tier.points });
    }
    if (d.isOpen && d.lastActivityDate && daysBetween(d.lastActivityDate, now) >= C.stalledAfterDays) {
      historyCandidates.push({
        key: "history",
        label: `Stalled open deal (no activity ${C.stalledAfterDays}+ days)`,
        points: C.stalledOpenDealPoints,
      });
    }
  }
  if (historyCandidates.length) {
    parts.push(historyCandidates.sort((a, b) => b.points - a.points)[0]);
  }

  return parts;
}

export function computeTrigger(c: CompanyRecord, now = new Date()): ScoreComponent[] {
  const parts: ScoreComponent[] = [];

  if (c.manualTriggerFlag) {
    parts.push({ key: "manual", label: "Manual trigger flag (news/event)", points: C.manualTriggerPoints });
  }

  if (c.lastInboundEmailDays != null) {
    const tier = C.inboundEmailTrigger.find((t) => c.lastInboundEmailDays! <= t.maxDays);
    if (tier) parts.push({ key: "email", label: tier.label, points: tier.points });
  }

  // One fathom component max: score every (type, recency) combination the
  // company earned and keep the highest-scoring one. A 10d-old external
  // mention (30) beats a 100d-old prospect meeting (20); precedence falls out
  // of the points, not a fixed type order.
  if (c.fathomMentionsByType) {
    let best: { points: number; label: string } | null = null;
    for (const [type, days] of Object.entries(c.fathomMentionsByType)) {
      if (days == null) continue;
      const tiers = C.fathomMentionTrigger[type as keyof typeof C.fathomMentionTrigger];
      const tier = tiers?.find((t) => days <= t.maxDays);
      if (tier && (!best || tier.points > best.points)) {
        best = { points: tier.points, label: tier.label };
      }
    }
    if (best) parts.push({ key: "fathom", label: best.label, points: best.points });
  }

  if (c.newsTrigger) {
    const tier = C.newsTrigger.find((t) => c.newsTrigger!.days <= t.maxDays);
    if (tier) {
      parts.push({
        key: "news",
        label: tier.label,
        points: tier.points,
        detail: c.newsTrigger.headline,
      });
    }
  }

  // Recent deal stage movement
  const recentMove = c.deals.some(
    (d) => d.isOpen && d.lastActivityDate && daysBetween(d.lastActivityDate, now) <= C.dealStageChangeTrigger.maxDays
  );
  if (recentMove) {
    parts.push({ key: "stage", label: C.dealStageChangeTrigger.label, points: C.dealStageChangeTrigger.points });
  }

  return parts;
}

const clamp100 = (n: number) => Math.min(100, Math.round(n));
const sum = (parts: ScoreComponent[]) => parts.reduce((a, p) => a + p.points, 0);

export function scoreAccount(c: CompanyRecord, now = new Date()): AccountScore {
  const fitComponents = computeFit(c, now);
  const triggerComponents = computeTrigger(c, now);
  let fitScore = clamp100(sum(fitComponents));

  // National-scale cap: giants stay prospects but can't out-fit the ICP.
  // The negative component keeps the breakdown honest about the clamp.
  if (
    c.subscriberCount != null &&
    c.subscriberCount >= C.nationalScale.minSubs &&
    fitScore > C.nationalScale.fitCap
  ) {
    fitComponents.push({
      key: "national-cap",
      label: C.nationalScale.label,
      points: C.nationalScale.fitCap - fitScore,
    });
    fitScore = C.nationalScale.fitCap;
  }
  const triggerScore = clamp100(sum(triggerComponents));
  const totalScore = Math.round(fitScore * C.FIT_WEIGHT + triggerScore * C.TRIGGER_WEIGHT);

  return {
    hubspotId: c.hubspotId,
    name: c.name,
    fitScore,
    triggerScore,
    totalScore,
    fitComponents,
    triggerComponents,
    scoredAt: now.toISOString(),
  };
}

export function rankAccounts(scores: AccountScore[]): AccountScore[] {
  return [...scores].sort(
    (a, b) => b.totalScore - a.totalScore || b.triggerScore - a.triggerScore
  );
}

// Score-history riser: if an account's total jumped >= riser.minDelta since the
// previous run, that movement is itself a trigger. Mutates and returns the score.
export function applyRiserBonus(
  score: AccountScore,
  previousTotal: number | undefined
): AccountScore {
  if (previousTotal == null) return score;
  const delta = score.totalScore - previousTotal;
  score.scoreDelta = delta;
  if (delta >= C.riser.minDelta) {
    score.triggerComponents.push({
      key: "riser",
      label: C.riser.label,
      points: C.riser.points,
      detail: `+${delta} vs last run`,
    });
    score.triggerScore = clamp100(score.triggerScore + C.riser.points);
    score.totalScore = Math.round(
      score.fitScore * C.FIT_WEIGHT + score.triggerScore * C.TRIGGER_WEIGHT
    );
  }
  return score;
}
