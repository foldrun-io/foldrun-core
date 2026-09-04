#!/usr/bin/env node
// Delete an account, permanently.
//
//   node scripts/delete-account.mjs <account> --confirm <account>
//
// The account is named twice on purpose. A --force flag can be pasted out of a
// runbook; the account's own name has to be typed while looking at it.
//
// What this does that a `rm -rf` cannot: it destroys the account's encryption
// key. Every secret they had is ciphertext under that key, and the key exists
// in one place — so once it is gone, the copies inside every nightly archive
// and every object in R2 are permanently unreadable. That is the part of "delete
// my data" that backups otherwise make impossible to honour.
//
// The ledger is kept: it is the record of money that moved, holds no secret,
// and deleting a paying customer's financial history is its own problem.

import { deleteTenant } from "../dist/src/tenant-delete.js";
import { loadTenantKeys } from "../dist/src/tenant-keys.js";

const [tenant, flag, confirm] = process.argv.slice(2);
if (!tenant || flag !== "--confirm" || !confirm) {
  console.error("usage: node scripts/delete-account.mjs <account> --confirm <account>");
  process.exit(2);
}

// The key has to be in memory to be destroyed from it as well as the database.
await loadTenantKeys();

try {
  const r = await deleteTenant(tenant, { confirm, by: process.env.USER ?? "operator" });
  console.log(`deleted ${r.tenant}`);
  console.log(`  encryption key destroyed : ${r.keyDestroyed ? "yes — their ciphertext is now inert everywhere, backups included" : "no key existed"}`);
  console.log(`  queued jobs removed      : ${r.queueJobsRemoved}`);
  console.log(`  sessions ended           : ${r.sessionsRevoked}`);
  console.log(`  files removed            : ${r.filesRemoved ? "yes" : "nothing on disk"}`);
  console.log(`  ledger lines kept        : ${r.ledgerKept} (money that moved is not erased)`);
  process.exit(0);
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}
