import { NextResponse } from "next/server";
import { googleConfigured } from "@/lib/google";

export const dynamic = "force-dynamic";

export async function GET() {
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  const hubspotToken = process.env.HUBSPOT_ACCESS_TOKEN;
  const csaKey = process.env.CSA_API_KEY;

  const googleMode = process.env.GOOGLE_REFRESH_TOKEN
    ? "refresh_token"
    : process.env.GOOGLE_OAUTH_TOKEN
    ? "static_token (expires hourly)"
    : "NOT SET";

  return NextResponse.json({
    ANTHROPIC_API_KEY: anthropicKey
      ? `set (starts with: ${anthropicKey.slice(0, 10)}...)`
      : "NOT SET",
    HUBSPOT_ACCESS_TOKEN: hubspotToken ? "set" : "NOT SET",
    GOOGLE: googleConfigured() ? `configured (${googleMode})` : "NOT SET",
    CSA_API_KEY: csaKey ? "set" : "NOT SET",
  });
}
