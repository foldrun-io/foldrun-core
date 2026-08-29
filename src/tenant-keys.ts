// One encryption key per account.
//
// Every account's vault used to be encrypted with the same key: masterKey()
// took no tenant argument, so FOLDRUN_SECRET_KEY opened all of them. One leak
// was total, and rotating for a single customer meant rotating for everybody.
//
// Envelope encryption fixes the shape. Each account gets a random data key; the
// data key is stored encrypted under the install key. The install key alone no
// longer opens anything — it opens the keys, which are in Postgres, while the
// secrets they protect are on the data volume. A stolen copy of either half is
// not a compromise.
//
// PRELOADED AT BOOT, on purpose. Fetching a key is a query, and the secrets API
// is synchronous and called from everywhere; making it async would push a third
// await cascade through the one code path where a mistake makes data
// undecryptable. Loading every key once at startup keeps the lookup a Map read.

import crypto from "node:crypto";
import { db, databaseEnabled } from "./db.ts";

/** tenant → data key. Populated by loadTenantKeys(), read synchronously. */
const keys = new Map<string, Buffer>();

// ------------------------------------------------------------- the root key
//
// What protects the thing that protects everything. Every key manager has this
// problem; the difference between the options is only where it is answered.
//
//   env   FOLDRUN_SECRET_KEY, hashed. The root key is a VALUE, so it exists
//         anywhere that value lands: /etc/foldrun/env, the k8s Secret, the pod
//         environment, and — until the backup was sealed — every archive.
//
//   kms   A cloud KMS. The root key is never a value anyone can hold: you send
//         ciphertext and get plaintext back. On EC2 the instance's IAM role
//         means there is no credential to store at all, which is the part
//         self-hosting structurally cannot match. It also brings an audit line
//         per decrypt and revocation without re-encrypting anything.
//
// NOT IMPLEMENTED HERE, deliberately. There is no AWS account on this box to
// test against, and untested crypto guarding every account's secrets is worse
// than none. What IS here is the seam and the format that make it a small,
// safe change later rather than a migration:
//
//   * every wrapped key carries a PREFIX naming the provider that sealed it,
//     so accounts can move one at a time and a half-migrated install reads
//     correctly rather than throwing;
//   * wrap/unwrap are already the only two operations, so a provider is two
//     functions — for AWS, kms:Encrypt and kms:Decrypt against a key id.
//
// To add it: implement wrapKms/unwrapKms, switch on FOLDRUN_ROOT_KEY=kms, and
// re-wrap each account by reading its key with the old provider and writing it
// back with the new. No secret is re-encrypted; only the small keys move.

const ENV_PREFIX = "env:";

function installKey(): Buffer {
  const fromEnv = process.env.FOLDRUN_SECRET_KEY;
  if (!fromEnv) throw new Error("FOLDRUN_SECRET_KEY is required to wrap an account key");
  return crypto.createHash("sha256").update(fromEnv).digest();
}

function wrap(dataKey: Buffer): string {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", installKey(), iv);
  const enc = Buffer.concat([c.update(dataKey), c.final()]);
  return ENV_PREFIX + Buffer.concat([iv, c.getAuthTag(), enc]).toString("base64");
}

function unwrap(wrapped: string): Buffer {
  // An unprefixed blob predates the provider seam and is env-wrapped. Same
  // rule as the secret records: absence means the original, so nothing written
  // before this has to be migrated before it can be read.
  const [provider, body] = wrapped.startsWith(ENV_PREFIX)
    ? ["env", wrapped.slice(ENV_PREFIX.length)]
    : wrapped.includes(":")
      ? [wrapped.slice(0, wrapped.indexOf(":")), wrapped.slice(wrapped.indexOf(":") + 1)]
      : ["env", wrapped];

  if (provider !== "env") {
    throw new Error(
      `account key is sealed by the "${provider}" root-key provider, which this build cannot open`,
    );
  }
  const raw = Buffer.from(body, "base64");
  const d = crypto.createDecipheriv("aes-256-gcm", installKey(), raw.subarray(0, 12));
  d.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([d.update(raw.subarray(28)), d.final()]);
}

/** Which provider sealed a stored key — for an operator asking what is where. */
export function wrappedBy(wrapped: string): string {
  const i = wrapped.indexOf(":");
  return i === -1 ? "env" : wrapped.slice(0, i);
}

/** Every account key, unwrapped into memory. Called once at boot. */
export async function loadTenantKeys(): Promise<number> {
  const p = db();
  if (!p) return 0;
  const { rows } = await p.query<{ tenant: string; wrapped: string }>(
    `SELECT tenant, wrapped FROM tenant_keys`,
  );
  for (const r of rows) {
    try {
      keys.set(r.tenant, unwrap(r.wrapped));
    } catch {
      // Wrapped under a different install key — the account is unreadable
      // until that key comes back. Loudly absent beats silently wrong: with no
      // key in the map, its secrets fall back to the install key and fail to
      // decrypt, which is what actually happened rather than a plausible lie.
      console.error(`[keys] cannot unwrap the key for ${r.tenant} — wrong FOLDRUN_SECRET_KEY?`);
    }
  }
  return keys.size;
}

/** Mint a key for an account that has none. Idempotent across replicas. */
export async function ensureTenantKey(tenant: string): Promise<boolean> {
  const p = db();
  if (!p) return false;
  if (keys.has(tenant)) return false;
  const fresh = crypto.randomBytes(32);
  const { rows } = await p.query<{ wrapped: string }>(
    `INSERT INTO tenant_keys (tenant, wrapped) VALUES ($1, $2)
     ON CONFLICT (tenant) DO NOTHING
     RETURNING wrapped`,
    [tenant, wrap(fresh)],
  );
  if (rows[0]) {
    keys.set(tenant, fresh);
    return true;
  }
  // Another replica won the insert; take theirs so both agree.
  const { rows: existing } = await p.query<{ wrapped: string }>(
    `SELECT wrapped FROM tenant_keys WHERE tenant = $1`, [tenant]);
  if (existing[0]) keys.set(tenant, unwrap(existing[0].wrapped));
  return false;
}

/**
 * The account's key, or null when this install has none — no database, or an
 * account whose key has not been minted yet. Null means "use the install key",
 * which is what every record written before this existed is encrypted with.
 */
export function tenantKey(tenant: string): Buffer | null {
  return keys.get(tenant) ?? null;
}

export function tenantKeysEnabled(): boolean {
  return databaseEnabled();
}

/**
 * Destroy an account's key. This is the shred.
 *
 * Every secret that account ever had is AES-GCM ciphertext under this key, and
 * the key exists in exactly one place. Delete it and the ciphertext is inert
 * everywhere at once — including inside the fourteen nightly archives and the
 * copies in R2, which no delete-my-data routine could ever reach into and
 * scrub. That is the only honest answer to an erasure request once backups
 * exist, and it only works because the keys were separated per account before
 * there was more than one.
 *
 * Irreversible by construction. There is no second copy to recover from.
 */
export async function destroyTenantKey(tenant: string): Promise<boolean> {
  const p = db();
  if (!p) return false;
  const { rowCount } = await p.query(`DELETE FROM tenant_keys WHERE tenant = $1`, [tenant]);
  keys.delete(tenant);
  return (rowCount ?? 0) > 0;
}

/** For tests and for the rewrap: forget what is cached. */
export function forgetTenantKeys(): void {
  keys.clear();
}
