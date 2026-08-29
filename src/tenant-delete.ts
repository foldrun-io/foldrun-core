// Deleting an account, and meaning it.
//
// "Delete my data" is easy to claim and hard to honour, because backups exist.
// Fourteen nightly archives and a bucket hold copies nobody can reach into and
// scrub one account out of — and refusing to keep backups is not an answer
// either.
//
// Crypto-shredding is the answer that actually holds. Every secret an account
// had is ciphertext under one key that exists in one place; destroy the key and
// every copy of that ciphertext, everywhere, is permanently unreadable. The
// archives can stay exactly as they are.
//
// Deliberately NOT a dashboard button. This is irreversible in the strongest
// sense — there is no second copy of the key to recover from — so it lives
// behind a script an operator runs on purpose, with the account named twice.

import fs from "node:fs";
import path from "node:path";
import { dataRoot } from "./paths.ts";
import { db, databaseEnabled } from "./db.ts";
import { destroyTenantKey } from "./tenant-keys.ts";
import { assertSafeName } from "./store.ts";

export interface DeletionReport {
  tenant: string;
  keyDestroyed: boolean;
  queueJobsRemoved: number;
  sessionsRevoked: number;
  filesRemoved: boolean;
  ledgerKept: number;
}

/**
 * Remove an account.
 *
 * The ledger is KEPT, on purpose. It is the record of money that moved, it
 * holds no secret — amounts, dates and run ids — and deleting the financial
 * history of a customer who has paid you is the kind of erasure that makes an
 * accountant, and in most places a regulator, unhappy. Everything that could
 * identify them is either shredded with the key or removed with their files.
 */
export async function deleteTenant(
  tenant: string,
  opts: { confirm: string; by: string },
): Promise<DeletionReport> {
  assertSafeName(tenant, "tenant");
  if (opts.confirm !== tenant) {
    // Naming it twice is the whole safety mechanism. A flag can be pasted from
    // a runbook; the account's own name has to be typed while looking at it.
    throw new Error(`refusing to delete: confirm must be exactly "${tenant}"`);
  }

  const report: DeletionReport = {
    tenant,
    keyDestroyed: false,
    queueJobsRemoved: 0,
    sessionsRevoked: 0,
    filesRemoved: false,
    ledgerKept: 0,
  };

  const p = db();
  if (databaseEnabled() && p) {
    // Audited BEFORE anything is destroyed, so the record of who did this
    // survives even if a later step fails halfway.
    await p.query(
      `INSERT INTO audit_log (tenant, actor, action, subject, detail)
       VALUES ($1, $2, 'tenant.deleted', $1, '{}'::jsonb)`,
      [tenant, opts.by],
    );

    const q = await p.query(`DELETE FROM queue WHERE tenant = $1`, [tenant]);
    report.queueJobsRemoved = q.rowCount ?? 0;

    const s = await p.query(
      `UPDATE sessions SET revoked_at = now() WHERE tenant = $1 AND revoked_at IS NULL`,
      [tenant],
    );
    report.sessionsRevoked = s.rowCount ?? 0;

    const l = await p.query<{ c: string }>(
      `SELECT count(*)::text c FROM ledger WHERE tenant = $1`, [tenant]);
    report.ledgerKept = Number(l.rows[0].c);

    // The shred, last of the database work: once this is gone, anything of
    // theirs that survives anywhere is noise.
    report.keyDestroyed = await destroyTenantKey(tenant);
  }

  const dir = path.join(dataRoot(), tenant);
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
    report.filesRemoved = true;
  }
  return report;
}
