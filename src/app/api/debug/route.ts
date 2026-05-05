import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET() {
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  const hubspotToken = process.env.HUBSPOT_ACCESS_TOKEN;
  const googleToken = process.env.GOOGLE_OAUTH_TOKEN;
  const csaKey = process.env.CSA_API_KEY;

  return NextResponse.json({
    ANTHROPIC_API_KEY: anthropicKey
      ? `set (starts with: ${anthropicKey.slice(0, 10)}...)`
      : "NOT SET",
    HUBSPOT_ACCESS_TOKEN: hubspotToken ? "set" : "NOT SET",
    GOOGLE_OAUTH_TOKEN: googleToken ? "set" : "NOT SET",
    CSA_API_KEY: csaKey ? "set" : "NOT SET",
  });
}
