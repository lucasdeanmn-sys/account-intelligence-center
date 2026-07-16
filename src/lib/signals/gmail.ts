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

// Query suffix excluding labeled mail (e.g. -label:tickets) per config.
function excludeLabelsQuery(): string {
  return (C.signals.gmailExcludeLabels ?? []).map((l) => ` -label:${l}`).join("");
}

export async function latestInboundDays(token: string, domain: string): Promise<number | null> {
  const q = `from:${domain} newer_than:${C.signals.gmailLookbackDays}d${excludeLabelsQuery()}`;
  const listRes = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${encodeURIComponent(q)}&maxResults=5`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!listRes.ok) return null;
  const list = await listRes.json();
  const ids: string[] = (list.messages ?? []).map((m: any) => m.id);

  // Gmail's from: operator also matches display names (our own support desk
  // notifications carry the prospect's address as display text) — verify the
  // actual sender address before counting a message as inbound.
  for (const id of ids) {
    const msgRes = await fetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=metadata&metadataHeaders=From`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (!msgRes.ok) continue;
    const msg = await msgRes.json();
    const from: string =
      msg.payload?.headers?.find((h: any) => h.name?.toLowerCase() === "from")?.value ?? "";
    const email = parseFromHeader(from)?.email;
    const d = domain.toLowerCase();
    if (!email || (!email.endsWith(`@${d}`) && !email.endsWith(`.${d}`))) continue;
    if (!msg.internalDate) continue;
    return Math.floor((Date.now() - Number(msg.internalDate)) / 86_400_000);
  }
  return null;
}

export interface InboundSender {
  name: string | null;
  email: string;
  lastDate: string | null; // YYYY-MM-DD of their most recent email
}

// From-header shapes in the wild: `Jane Doe <jane@acme.com>`, `"Doe, Jane"
// <jane@acme.com>`, RFC-comment style `jane@acme.com (Jane Doe)`, bare
// `jane@acme.com`. Returns null when no address can be found.
function parseFromHeader(from: string): { name: string | null; email: string } | null {
  const angled = from.match(/<([^<>\s]+@[^<>\s]+)>/);
  const email = (
    angled?.[1] ?? from.match(/([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})/)?.[1]
  )?.toLowerCase();
  if (!email) return null;
  let name: string | null = null;
  if (angled && angled.index! > 0) {
    name = from.slice(0, angled.index).replace(/["']/g, "").trim() || null;
  }
  if (!name) {
    const paren = from.match(/\(([^)]*)\)/);
    if (paren) name = paren[1].trim() || null;
  }
  if (name && (name.includes("@") || name.toLowerCase() === email)) name = null;
  return { name, email };
}

// Who has been emailing us from this domain, and when. One list call plus a
// metadata fetch per message (no bodies). Used by the target context panel —
// per-company on expand, never in bulk.
export async function recentInboundActivity(
  token: string,
  domain: string,
  lookbackDays: number,
  max = 8
): Promise<{ lastInboundDays: number | null; senders: InboundSender[] }> {
  const q = `from:${domain} newer_than:${lookbackDays}d${excludeLabelsQuery()}`;
  const listRes = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${encodeURIComponent(q)}&maxResults=${max}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!listRes.ok) return { lastInboundDays: null, senders: [] };
  const ids: string[] = ((await listRes.json()).messages ?? []).map((m: any) => m.id);
  if (!ids.length) return { lastInboundDays: null, senders: [] };

  const byEmail = new Map<string, InboundSender & { ms: number }>();
  let newestMs = 0;
  await Promise.all(
    ids.map(async (id) => {
      const res = await fetch(
        `https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=metadata&metadataHeaders=From`,
        { headers: { Authorization: `Bearer ${token}` } }
      ).catch(() => null);
      if (!res || !res.ok) return;
      const msg = await res.json();
      const ms = Number(msg.internalDate ?? 0);
      const from: string =
        msg.payload?.headers?.find((h: any) => h.name?.toLowerCase() === "from")?.value ?? "";
      const parsed = parseFromHeader(from);
      if (!parsed) return;
      const { name, email } = parsed;
      // Gmail's from: operator also matches display names — our own support
      // desk sends "prospect@their.com (Ticket...)" <support@7sigma.com> and
      // would count as inbound from the prospect. Trust the address only,
      // and only count recency from messages that pass the check.
      if (!email.endsWith(`@${domain.toLowerCase()}`) && !email.endsWith(`.${domain.toLowerCase()}`)) return;
      if (ms > newestMs) newestMs = ms;
      const existing = byEmail.get(email);
      if (!existing || ms > existing.ms) {
        byEmail.set(email, {
          name: name ?? existing?.name ?? null,
          email,
          lastDate: ms ? new Date(ms).toISOString().slice(0, 10) : null,
          ms,
        });
      }
    })
  );

  const senders = Array.from(byEmail.values())
    .sort((a, b) => b.ms - a.ms)
    .map(({ ms: _ms, ...s }) => s);
  return {
    lastInboundDays: newestMs ? Math.floor((Date.now() - newestMs) / 86_400_000) : null,
    senders,
  };
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
