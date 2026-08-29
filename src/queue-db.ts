// The queue, in Postgres.
//
// Same job, same shape, same fairness. What changes is that a claim is a row
// lock rather than a rename, which is the difference between one worker and
// several: `rename()` is atomic on one filesystem and is not something to bet
// N workers on across a network one, whereas `FOR UPDATE SKIP LOCKED` is the
// primitive this problem was named after.
//
// FAIRNESS WITHOUT A WINDOW FUNCTION. `seq` is the job's position within its
// own account's pending jobs, assigned at insert. Ordering by (seq,
// enqueued_at) takes every account's oldest job before anyone's second — the
// same round-robin the file queue does — and it does it with a plain ORDER BY,
// which matters because Postgres refuses FOR UPDATE alongside a window
// function, and SKIP LOCKED is the entire reason to be here.

import type { PoolClient } from "pg";
import { db } from "./db.ts";

export interface QueueJobRow {
  tenant: string;
  workspace: string;
  runId: string;
  modelOverride?: string | null;
  tags?: string[];
  notBefore?: string;
}

function toJob(r: Record<string, unknown>): QueueJobRow {
  return {
    tenant: r.tenant as string,
    workspace: r.workspace as string,
    runId: r.run_id as string,
    ...(r.model_override ? { modelOverride: r.model_override as string } : {}),
    ...(Array.isArray(r.tags) && r.tags.length ? { tags: r.tags as string[] } : {}),
    ...(r.not_before ? { notBefore: new Date(r.not_before as string).toISOString() } : {}),
  };
}

/**
 * Add or replace a job for a run.
 *
 * Upsert, because re-enqueueing a run that is already waiting must not queue it
 * twice — the file queue got that by overwriting a filename, and here the
 * unique index says it outright. A re-enqueue keeps the account's ORIGINAL
 * position: a run that parks on a `wait:` and comes back should not lose its
 * place to everyone who arrived while it waited.
 */
export async function enqueueDb(job: QueueJobRow, client?: PoolClient): Promise<void> {
  const q = client ?? db();
  if (!q) throw new Error("no database configured");
  await q.query(
    `INSERT INTO queue (run_id, tenant, workspace, model_override, tags, not_before, seq)
     VALUES ($1,$2,$3,$4,$5,$6,
       COALESCE((SELECT MAX(seq) FROM queue WHERE tenant = $2 AND claimed_at IS NULL), 0) + 1)
     ON CONFLICT (run_id) DO UPDATE SET
       workspace      = EXCLUDED.workspace,
       model_override = EXCLUDED.model_override,
       tags           = EXCLUDED.tags,
       not_before     = EXCLUDED.not_before,
       claimed_at     = NULL,
       claimed_by     = NULL`,
    [
      job.runId,
      job.tenant,
      job.workspace,
      job.modelOverride ?? null,
      JSON.stringify(job.tags ?? []),
      job.notBefore ?? null,
    ],
  );
}

/**
 * Take the next job, fairly, without two workers taking the same one.
 *
 * SKIP LOCKED rather than a plain FOR UPDATE: a second worker steps over the
 * row a first has locked instead of blocking behind it, so N workers scale
 * rather than serialise. The `claimed_at IS NULL` in the outer UPDATE is
 * belt-and-braces against a row that changed between the subquery and the
 * write.
 */
export async function claimNextDb(owner: string): Promise<QueueJobRow | null> {
  const p = db();
  if (!p) return null;
  const { rows } = await p.query(
    `UPDATE queue SET claimed_at = now(), claimed_by = $1
      WHERE id = (
        SELECT id FROM queue
         WHERE claimed_at IS NULL
           AND (not_before IS NULL OR not_before <= now())
         ORDER BY seq, enqueued_at, id
         FOR UPDATE SKIP LOCKED
         LIMIT 1
      )
        AND claimed_at IS NULL
      RETURNING tenant, workspace, run_id, model_override, tags, not_before`,
    [owner],
  );
  return rows[0] ? toJob(rows[0]) : null;
}

/** The job is finished with — parked, completed or failed. */
export async function releaseDb(runId: string): Promise<void> {
  const p = db();
  if (!p) return;
  await p.query(`DELETE FROM queue WHERE run_id = $1`, [runId]);
}

/** Drop a run's job wherever it sits, for a stop. */
export async function removeDb(runId: string): Promise<boolean> {
  const p = db();
  if (!p) return false;
  const { rowCount } = await p.query(`DELETE FROM queue WHERE run_id = $1`, [runId]);
  return (rowCount ?? 0) > 0;
}

/**
 * Hand back jobs whose worker died.
 *
 * The file queue could only do this at boot, before any worker started, because
 * a claimed file gave no way to tell "being driven" from "abandoned". A row
 * carries when it was claimed, so a stale claim is recoverable at ANY time —
 * which is what lets a second worker pick up after a first is killed rather
 * than the run waiting for someone to restart the platform.
 */
export async function recoverStaleDb(olderThanMs: number): Promise<number> {
  const p = db();
  if (!p) return 0;
  const { rowCount } = await p.query(
    `UPDATE queue SET claimed_at = NULL, claimed_by = NULL
      WHERE claimed_at IS NOT NULL
        AND claimed_at < now() - ($1::bigint * interval '1 millisecond')`,
    [Math.max(1, Math.floor(olderThanMs))],
  );
  return rowCount ?? 0;
}

/** Renew a claim, so a long run is not mistaken for an abandoned one. */
export async function touchClaimDb(runId: string, owner: string): Promise<void> {
  const p = db();
  if (!p) return;
  await p.query(
    `UPDATE queue SET claimed_at = now() WHERE run_id = $1 AND claimed_by = $2`,
    [runId, owner],
  );
}

export async function statsDb(): Promise<{
  pending: number;
  scheduledAhead: number;
  claimed: number;
  oldestPendingSecs: number | null;
}> {
  const p = db();
  if (!p) return { pending: 0, scheduledAhead: 0, claimed: 0, oldestPendingSecs: null };
  const { rows } = await p.query<{
    pending: string; scheduled: string; claimed: string; oldest: string | null;
  }>(
    `SELECT
       count(*) FILTER (WHERE claimed_at IS NULL
                          AND (not_before IS NULL OR not_before <= now()))::text AS pending,
       count(*) FILTER (WHERE claimed_at IS NULL AND not_before > now())::text   AS scheduled,
       count(*) FILTER (WHERE claimed_at IS NOT NULL)::text                      AS claimed,
       EXTRACT(EPOCH FROM (now() - MIN(enqueued_at) FILTER (WHERE claimed_at IS NULL
                          AND (not_before IS NULL OR not_before <= now()))))::text AS oldest
     FROM queue`,
  );
  const r = rows[0];
  return {
    pending: Number(r.pending),
    scheduledAhead: Number(r.scheduled),
    claimed: Number(r.claimed),
    oldestPendingSecs: r.oldest === null ? null : Math.max(0, Math.round(Number(r.oldest))),
  };
}

/** Jobs an account has admitted but not settled — what assertFunds counts. */
export async function inFlightDb(tenant: string): Promise<number> {
  const p = db();
  if (!p) return 0;
  const { rows } = await p.query<{ c: string }>(
    `SELECT count(*)::text c FROM queue WHERE tenant = $1`, [tenant]);
  return Number(rows[0].c);
}

/** Is there a job for this run, claimed or not? */
export async function hasJobDb(runId: string): Promise<boolean> {
  const p = db();
  if (!p) return false;
  const { rows } = await p.query(`SELECT 1 FROM queue WHERE run_id = $1`, [runId]);
  return rows.length > 0;
}
