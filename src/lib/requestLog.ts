// lib/requestLog.ts
// Permanent request log in Vercel Postgres — our own replacement for Vercel's
// ~1h Hobby-plan log retention. Written fire-and-forget from middleware;
// degrades gracefully (no-op) when POSTGRES_URL isn't set, like history/db.ts.

import { sql } from "@vercel/postgres";

const hasDb = () => Boolean(process.env.POSTGRES_URL);

// Memoized per runtime instance so the CREATE TABLE round-trip happens once,
// not on every request.
let schemaReady: Promise<void> | null = null;

function ensureSchema(): Promise<void> {
  if (!schemaReady) {
    schemaReady = (async () => {
      await sql`
        CREATE TABLE IF NOT EXISTS aic_request_log (
          id         BIGSERIAL PRIMARY KEY,
          ts         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          method     TEXT NOT NULL,
          path       TEXT NOT NULL,
          allowed    BOOLEAN NOT NULL,
          ip         TEXT,
          user_agent TEXT,
          referer    TEXT
        )
      `;
      await sql`
        CREATE INDEX IF NOT EXISTS idx_aic_request_log_ts
        ON aic_request_log (ts DESC)
      `;
    })().catch((e) => {
      schemaReady = null; // allow retry on next request
      throw e;
    });
  }
  return schemaReady;
}

export interface RequestLogEntry {
  method: string;
  path: string;
  allowed: boolean;
  ip: string | null;
  userAgent: string | null;
  referer: string | null;
}

// Never throws — a logging failure must not affect serving the request.
export async function logRequest(entry: RequestLogEntry): Promise<void> {
  if (!hasDb()) return;
  try {
    await ensureSchema();
    await sql`
      INSERT INTO aic_request_log (method, path, allowed, ip, user_agent, referer)
      VALUES (${entry.method}, ${entry.path}, ${entry.allowed},
              ${entry.ip}, ${entry.userAgent}, ${entry.referer})
    `;
  } catch (e: any) {
    console.error("request log write failed:", e?.message ?? e);
  }
}

export async function recentRequests(limit = 200): Promise<any[]> {
  if (!hasDb()) return [];
  await ensureSchema();
  const capped = Math.min(Math.max(limit, 1), 1000);
  const { rows } = await sql`
    SELECT ts, method, path, allowed, ip, user_agent, referer
    FROM aic_request_log
    ORDER BY ts DESC
    LIMIT ${capped}
  `;
  return rows;
}
