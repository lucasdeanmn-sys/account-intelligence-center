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
