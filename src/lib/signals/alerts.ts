// lib/signals/alerts.ts
// Parses Google Alerts RSS/Atom feeds and sets newsTrigger on matching companies.
//
// Setup: create a Google Alert per target account name (google.com/alerts),
// set "Deliver to: RSS feed", and map the feed URL to the HubSpot company ID
// in config/alert-feeds.json. Start with just the top 20-30 accounts —
// this replaces the manual trigger checkbox, it doesn't need full coverage.

import { SCORING_CONFIG as C } from "../scoring/config";
import type { CompanyRecord } from "../scoring/types";
import feedMap from "../../config/alert-feeds.json";

interface FeedEntry {
  title: string;
  publishedMs: number;
}

// Google Alerts feeds are Atom. Lightweight extraction — no XML dep needed.
function parseAtom(xml: string): FeedEntry[] {
  const entries: FeedEntry[] = [];
  const blocks = xml.split(/<entry[\s>]/).slice(1);
  for (const block of blocks) {
    const title = block.match(/<title[^>]*>([\s\S]*?)<\/title>/)?.[1] ?? "";
    const published = block.match(/<published>([\s\S]*?)<\/published>/)?.[1];
    if (!published) continue;
    const ms = Date.parse(published);
    if (Number.isNaN(ms)) continue;
    entries.push({
      title: title
        .replace(/<!\[CDATA\[|\]\]>/g, "")
        .replace(/<[^>]+>/g, "")
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&#39;/g, "'")
        .replace(/&quot;/g, '"')
        .trim(),
      publishedMs: ms,
    });
  }
  return entries;
}

export async function applyAlertsSignal(
  companies: Map<string, CompanyRecord>
): Promise<number> {
  const now = Date.now();
  const maxAgeMs = C.signals.alertsMaxAgeDays * 86_400_000;
  let hits = 0;

  for (const [hubspotId, feedUrl] of Object.entries(feedMap as Record<string, string>)) {
    const company = companies.get(hubspotId);
    if (!company || !feedUrl) continue;

    try {
      const res = await fetch(feedUrl, {
        headers: { "User-Agent": "aic-scoring/1.0" },
        cache: "no-store", // same-URL GET every run — Next's Data Cache would serve it stale
      });
      if (!res.ok) continue;
      const entries = parseAtom(await res.text())
        .filter((e) => now - e.publishedMs <= maxAgeMs)
        .sort((a, b) => b.publishedMs - a.publishedMs);

      if (entries.length) {
        company.newsTrigger = {
          days: Math.floor((now - entries[0].publishedMs) / 86_400_000),
          headline: entries[0].title.slice(0, 200),
        };
        hits++;
      }
    } catch (err) {
      console.error(`Alerts signal failed for ${company.name}:`, err);
    }
  }
  return hits;
}
