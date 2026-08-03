import { NextRequest, NextResponse } from "next/server";
import { createHash, timingSafeEqual } from "crypto";

export const dynamic = "force-dynamic";

// Session cookie value must match src/middleware.ts's expectedToken().
function sessionToken(password: string): string {
  return createHash("sha256").update(`aic-session:${password}`).digest("hex");
}

export async function POST(req: NextRequest) {
  const appPassword = process.env.APP_PASSWORD;
  if (!appPassword) {
    return NextResponse.json(
      { error: "APP_PASSWORD is not configured" },
      { status: 503 }
    );
  }

  const { password } = (await req.json().catch(() => ({}))) as {
    password?: string;
  };
  if (typeof password !== "string" || !password) {
    return NextResponse.json({ error: "password required" }, { status: 400 });
  }

  // Compare digests, not raw strings — constant-time and length-independent.
  const a = createHash("sha256").update(password).digest();
  const b = createHash("sha256").update(appPassword).digest();
  if (!timingSafeEqual(a, b)) {
    return NextResponse.json({ error: "Incorrect password" }, { status: 401 });
  }

  const res = NextResponse.json({ ok: true });
  res.cookies.set("aic_auth", sessionToken(appPassword), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 30, // 30 days
  });
  return res;
}
