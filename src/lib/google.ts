// Token cache per Lambda warm instance — avoids redundant refresh calls within one request
let cachedToken: string | null = null;
let cacheExpiry = 0;

async function refreshAccessToken(): Promise<string> {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID!,
      client_secret: process.env.GOOGLE_CLIENT_SECRET!,
      refresh_token: process.env.GOOGLE_REFRESH_TOKEN!,
      grant_type: "refresh_token",
    }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Google token refresh failed: ${err}`);
  }
  const data = await res.json();
  // Cache for 55 minutes (tokens last 60)
  cachedToken = data.access_token as string;
  cacheExpiry = Date.now() + 55 * 60 * 1000;
  return cachedToken;
}

export async function getGoogleToken(): Promise<string> {
  // Refresh-token flow (preferred — permanent)
  if (
    process.env.GOOGLE_REFRESH_TOKEN &&
    process.env.GOOGLE_CLIENT_ID &&
    process.env.GOOGLE_CLIENT_SECRET
  ) {
    if (cachedToken && Date.now() < cacheExpiry) return cachedToken;
    return refreshAccessToken();
  }

  // Fallback: static token (expires in 1h — for local testing only)
  if (process.env.GOOGLE_OAUTH_TOKEN) {
    return process.env.GOOGLE_OAUTH_TOKEN;
  }

  throw new Error(
    "Google not configured: set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN"
  );
}

export function googleConfigured(): boolean {
  return !!(
    (process.env.GOOGLE_REFRESH_TOKEN &&
      process.env.GOOGLE_CLIENT_ID &&
      process.env.GOOGLE_CLIENT_SECRET) ||
    process.env.GOOGLE_OAUTH_TOKEN
  );
}

export interface CalendarEvent {
  title: string;
  start: string | null; // ISO datetime, or date for all-day events
  end: string | null;
  status: string | null;
  attendees: string[]; // emails
}

// Events on the user's primary calendar involving any of the given domains
// (matched against attendee emails). Catches meetings that were never logged
// or synced into HubSpot. Scope required: calendar.readonly.
export async function getCalendarEventsForDomains(
  domains: string[],
  { daysBack = 30, daysAhead = 60 } = {}
): Promise<CalendarEvent[]> {
  if (!googleConfigured() || !domains.length) return [];
  const token = await getGoogleToken();

  const params = new URLSearchParams({
    timeMin: new Date(Date.now() - daysBack * 86_400_000).toISOString(),
    timeMax: new Date(Date.now() + daysAhead * 86_400_000).toISOString(),
    singleEvents: "true",
    orderBy: "startTime",
    maxResults: "250",
  });
  const res = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/primary/events?${params}`,
    {
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
      signal: AbortSignal.timeout(15_000),
    }
  );
  if (!res.ok) {
    throw new Error(`Google Calendar ${res.status}: ${await res.text()}`);
  }
  const data = await res.json();

  const wanted = domains.map((d) => d.toLowerCase());
  return (data.items ?? [])
    .filter((ev: any) =>
      (ev.attendees ?? []).some((a: any) => {
        const email = String(a.email ?? "").toLowerCase();
        return wanted.some((d) => email.endsWith(`@${d}`) || email.endsWith(`.${d}`));
      })
    )
    .map((ev: any) => ({
      title: ev.summary ?? "(no title)",
      start: ev.start?.dateTime ?? ev.start?.date ?? null,
      end: ev.end?.dateTime ?? ev.end?.date ?? null,
      status: ev.status ?? null,
      attendees: (ev.attendees ?? [])
        .map((a: any) => String(a.email ?? ""))
        .filter(Boolean),
    }));
}
