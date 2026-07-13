// lib/signals/gmail.ts
// For each prospect company with a domain, finds the most recent inbound email
// from that domain and sets lastInboundEmailDays.
//
// Uses the same OAuth refresh token you generated in the Mac Mini setup session.
// Env: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN
// Scope required: gmail.readonly

import { SCORING_CONFIG as C } from "../scoring/config";
import type { CompanyRecord } from "../scoring/types";

export async function getAccessToken(): Promise<string | null> {
  const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN } = process.env;
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !GOOGLE_REFRESH_TOKEN) return null;

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      refresh_token: GOOGLE_REFRESH_TOKEN,
      grant_type: "refresh_token",
    }),
  });
  if (!res.ok) {
    console.error(`Gmail token refresh failed: ${res.status}`);
    return null;
  }
  return (await res.json()).access_token ?? null;
}

export async function latestInboundDays(token: string, domain: string): Promise<number | null> {
  const q = `from:${domain} newer_than:${C.signals.gmailLookbackDays}d`;
  const listRes = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${encodeURIComponent(q)}&maxResults=1`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!listRes.ok) return null;
  const list = await listRes.json();
  const id = list.messages?.[0]?.id;
  if (!id) return null;

  const msgRes = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=minimal`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!msgRes.ok) return null;
  const msg = await msgRes.json();
  if (!msg.internalDate) return null;

  return Math.floor((Date.now() - Number(msg.internalDate)) / 86_400_000);
}

// tiny concurrency limiter — no dependency needed
async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      results[idx] = await fn(items[idx]);
    }
  });
  await Promise.all(workers);
  return results;
}

export async function applyGmailSignal(
  companies: Map<string, CompanyRecord>
): Promise<number> {
  const token = await getAccessToken();
  if (!token) return 0; // signal optional — degrade gracefully

  // Only companies with domains, and skip freemail domains that would match noise.
  const FREEMAIL = new Set(["gmail.com", "yahoo.com", "outlook.com", "hotmail.com", "aol.com"]);
  const targets = Array.from(companies.values())
    .filter((c) => c.domain && !FREEMAIL.has(c.domain.toLowerCase()))
    .slice(0, C.signals.gmailMaxCompanies);

  let hits = 0;
  await mapLimit(targets, C.signals.gmailConcurrency, async (company) => {
    try {
      const days = await latestInboundDays(token, company.domain!);
      if (days != null) {
        company.lastInboundEmailDays = days;
        hits++;
      }
    } catch (err) {
      console.error(`Gmail signal failed for ${company.domain}:`, err);
    }
  });
  return hits;
}
