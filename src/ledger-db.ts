// The ledger, in Postgres.
//
// Same entries, same meaning, same append-only discipline — what changes is
// that the balance can be computed inside a transaction. That is the property
// the file could not offer: assertFunds summed a file it had just read, so two
// runs admitted at the same moment could each be judged against the same
// untouched balance and both pass. The queue worked around it by counting
// admitted-but-unsettled jobs; the database makes the workaround unnecessary.
//
// The file remains the fallback for an install with no database, and remains
// the thing the backfill reads once. Nothing here deletes it.

import type { PoolClient } from "pg";
import { db } from "./db.ts";
import type { LedgerEntry } from "./ledger.ts";

/** A row as the rest of the code already expects to see it. */
function toEntry(r: Record<string, unknown>): LedgerEntry {
  return {
    t: new Date(r.at as string).toISOString(),
    kind: r.kind as LedgerEntry["kind"],
    // NUMERIC comes back as a string from pg, deliberately — it is exact and
    // Number() is the only place that decision gets made.
    usd: Number(r.usd),
    ...(r.cost === null || r.cost === undefined ? {} : { cost: Number(r.cost) }),
    ...(r.meter ? { meter: r.meter as LedgerEntry["meter"] } : {}),
    ...(r.workspace ? { workspace: r.workspace as string } : {}),
    ...(r.run_id ? { runId: r.run_id as string } : {}),
    ...(r.note ? { note: r.note as string } : {}),
  };
}

export async function appendDb(tenant: string, entry: LedgerEntry, client?: PoolClient): Promise<void> {
  const q = client ?? db();
  if (!q) throw new Error("no database configured");
  await q.query(
    `INSERT INTO ledger (tenant, at, kind, usd, cost, workspace, run_id, note, meter)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT DO NOTHING`,
    [
      tenant,
      entry.t,
      entry.kind,
      entry.usd,
      entry.cost ?? null,
      entry.workspace ?? null,
      entry.runId ?? null,
      entry.note ?? null,
      entry.meter ? JSON.stringify(entry.meter) : null,
    ],
  );
}

export async function readLedgerDb(tenant: string): Promise<LedgerEntry[]> {
  const p = db();
  if (!p) return [];
  const { rows } = await p.query(
    `SELECT at, kind, usd, cost, workspace, run_id, note, meter
       FROM ledger WHERE tenant = $1 ORDER BY at ASC, id ASC`,
    [tenant],
  );
  return rows.map(toEntry);
}

/** The balance, summed by the database rather than by whoever read the file. */
export async function balanceDb(tenant: string, client?: PoolClient): Promise<number> {
  const q = client ?? db();
  if (!q) return 0;
  const { rows } = await q.query<{ sum: string | null }>(
    `SELECT COALESCE(SUM(usd), 0)::text AS sum FROM ledger WHERE tenant = $1`,
    [tenant],
  );
  return Number(rows[0]?.sum ?? 0);
}

/**
 * Copy a tenant's JSONL history in, once.
 *
 * Idempotent by the table's own unique constraint rather than by a flag we
 * would have to keep correct: re-running inserts nothing. Called at boot on
 * the worker, so an install that gains a database keeps its history instead
 * of appearing to start from zero — which, for a ledger, would read as every
 * customer's balance being wrong.
 */
export async function backfillLedger(
  tenant: string,
  fromFile: LedgerEntry[],
): Promise<{ inserted: number }> {
  const p = db();
  if (!p || fromFile.length === 0) return { inserted: 0 };
  const before = (await p.query<{ c: string }>(
    `SELECT count(*)::text c FROM ledger WHERE tenant = $1`, [tenant])).rows[0].c;
  for (const e of fromFile) await appendDb(tenant, e);
  const after = (await p.query<{ c: string }>(
    `SELECT count(*)::text c FROM ledger WHERE tenant = $1`, [tenant])).rows[0].c;
  return { inserted: Number(after) - Number(before) };
}
