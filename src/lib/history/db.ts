// lib/history/db.ts
// Weekly score snapshots in Vercel Postgres. Powers the riser trigger and a
// future risers/fallers view. Degrades gracefully if POSTGRES_URL isn't set.
//
// Setup: Vercel dashboard -> Storage -> Create Postgres -> connect to project.
// npm install @vercel/postgres

import { sql } from "@vercel/postgres";
import type { AccountScore } from "../scoring/types";

const hasDb = () => Boolean(process.env.POSTGRES_URL);

export async function ensureSchema(): Promise<void> {
  if (!hasDb()) return;
  await sql`
    CREATE TABLE IF NOT EXISTS aic_score_history (
      id            SERIAL PRIMARY KEY,
      hubspot_id    TEXT NOT NULL,
      name          TEXT NOT NULL,
      total_score   INTEGER NOT NULL,
      fit_score     INTEGER NOT NULL,
      trigger_score INTEGER NOT NULL,
      run_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS idx_aic_history_company
    ON aic_score_history (hubspot_id, run_at DESC)
  `;
}

// Most recent snapshot per company (from any prior run).
export async function getPreviousTotals(): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  if (!hasDb()) return map;
  const { rows } = await sql`
    SELECT DISTINCT ON (hubspot_id) hubspot_id, total_score
    FROM aic_score_history
    ORDER BY hubspot_id, run_at DESC
  `;
  for (const r of rows) map.set(String(r.hubspot_id), Number(r.total_score));
  return map;
}

export async function saveSnapshot(scores: AccountScore[]): Promise<void> {
  if (!hasDb() || !scores.length) return;
  // Chunked multi-row inserts to keep statement size sane.
  const CHUNK = 200;
  for (let i = 0; i < scores.length; i += CHUNK) {
    const chunk = scores.slice(i, i + CHUNK);
    const values: string[] = [];
    const params: (string | number)[] = [];
    chunk.forEach((s, j) => {
      const base = j * 5;
      values.push(`($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5})`);
      params.push(s.hubspotId, s.name, s.totalScore, s.fitScore, s.triggerScore);
    });
    await sql.query(
      `INSERT INTO aic_score_history (hubspot_id, name, total_score, fit_score, trigger_score)
       VALUES ${values.join(", ")}`,
      params
    );
  }
}
