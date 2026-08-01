// Move an account's secrets onto a new master key.
//
// The default master key is `data/.secret-key`, sitting on the same disk as
// the ciphertext it protects — one filesystem read gets both. The fix is to
// hold the key somewhere else and pass it in as MDAGENT_SECRET_KEY, which
// masterKey() already prefers.
//
// That move is not safe without this script. Change the key and every stored
// value stops decrypting, and the platform reports each one as a *missing*
// secret — so the failure looks like "you never set it" rather than "the key
// is wrong", and you would go and re-enter credentials you still have.
//
//   node scripts/rotate-secret-key.mjs <account> --to "<new key>"
//   node scripts/rotate-secret-key.mjs <account> --to "$(openssl rand -hex 32)"
//
// The current key is read from MDAGENT_SECRET_KEY, or from data/.secret-key.
// Nothing is deleted: a value that will not decrypt is left exactly as it is
// and reported, so a partial rotation is visible rather than silent.

import fs from "node:fs";
import path from "node:path";
import { dataRoot } from "@mdagent/core";
import { rotateMasterKey, masterKeySource } from "@mdagent/core";

const [account, ...rest] = process.argv.slice(2);
const toIndex = rest.indexOf("--to");
const to = toIndex === -1 ? null : rest[toIndex + 1];

if (!account || !to) {
  console.error(`
  Move an account's secrets onto a new master key.

    node scripts/rotate-secret-key.mjs <account> --to "<new key>"

  Then set MDAGENT_SECRET_KEY to the same value wherever the platform runs,
  and delete data/.secret-key.
`);
  process.exit(1);
}

const source = masterKeySource();
const from =
  process.env.MDAGENT_SECRET_KEY ??
  (source.path && fs.existsSync(source.path) ? fs.readFileSync(source.path, "utf8") : null);

if (!from) {
  console.error("  no current master key found — nothing to rotate from\n");
  process.exit(1);
}

// Back up first. Re-encryption is per-file and atomic, but an account is many
// files, and the operator should be able to put it back exactly as it was.
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const backup = path.join(dataRoot(), `.secrets-backup-${stamp}`);
fs.mkdirSync(backup, { recursive: true, mode: 0o700 });
fs.cpSync(path.join(dataRoot(), account), path.join(backup, account), {
  recursive: true,
  filter: (src) => !src.includes("/runs") && (fs.statSync(src).isDirectory() || src.endsWith("secrets.json")),
});
console.log(`  backup      ${backup}`);

const { rewritten, unreadable } = rotateMasterKey(account, from, to);

for (const r of rewritten) {
  console.log(`  rewrote     ${path.relative(dataRoot(), r.file)}  (${r.secrets} secrets)`);
}
if (unreadable.length) {
  console.log(`\n  could not decrypt with the current key, left untouched:`);
  for (const name of unreadable) console.log(`    ${name}`);
}

console.log(`
  Next
    1. set MDAGENT_SECRET_KEY to the new key wherever the platform runs
    2. restart it, and confirm a secret resolves
    3. delete ${source.path ?? "data/.secret-key"}
    4. delete the backup once you are satisfied
`);
