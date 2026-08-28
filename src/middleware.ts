import { NextRequest, NextResponse, NextFetchEvent } from "next/server";
import { logRequest } from "@/lib/requestLog";

// Gate every page and API route behind the APP_PASSWORD session cookie.
// Exemptions: the login page + login API (obviously), Vercel Cron's entry
// point (it authenticates itself with CRON_SECRET and cannot carry cookies),
// and Next.js static assets.
const PUBLIC_PATHS = [
  "/login",
  "/api/auth/login",
  "/api/cron/score-accounts",
  "/api/cron/zuora-reconcile",
];

async function expectedToken(): Promise<string | null> {
  const password = process.env.APP_PASSWORD;
  if (!password) return null;
  const data = new TextEncoder().encode(`aic-session:${password}`);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function middleware(req: NextRequest, event: NextFetchEvent) {
  const { pathname } = req.nextUrl;

  const expected = await expectedToken();
  // Fail closed: if APP_PASSWORD is unset in this environment, nothing is
  // served — a missing env var must not silently publish the app.
  const cookie = req.cookies.get("aic_auth")?.value;
  const authed = Boolean(expected && cookie === expected);
  const isPublic = PUBLIC_PATHS.some((p) => pathname === p);

  // Permanent request log (fire-and-forget — adds no latency, never blocks).
  event.waitUntil(
    logRequest({
      method: req.method,
      path: pathname,
      allowed: authed || isPublic,
      ip: req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
      userAgent: req.headers.get("user-agent"),
      referer: req.headers.get("referer"),
    })
  );

  if (isPublic || authed) return NextResponse.next();

  if (pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const login = req.nextUrl.clone();
  login.pathname = "/login";
  login.search = "";
  return NextResponse.redirect(login);
}

export const config = {
  // Skip Next internals and static files; everything else goes through the gate.
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
