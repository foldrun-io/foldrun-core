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

function installKey(): Buffer {
  const fromEnv = process.env.FOLDRUN_SECRET_KEY;
  if (!fromEnv) throw new Error("FOLDRUN_SECRET_KEY is required to wrap an account key");
  return crypto.createHash("sha256").update(fromEnv).digest();
}

function wrap(dataKey: Buffer): string {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", installKey(), iv);
  const enc = Buffer.concat([c.update(dataKey), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), enc]).toString("base64");
}

function unwrap(wrapped: string): Buffer {
  const raw = Buffer.from(wrapped, "base64");
  const d = crypto.createDecipheriv("aes-256-gcm", installKey(), raw.subarray(0, 12));
  d.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([d.update(raw.subarray(28)), d.final()]);
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

/** For tests and for the rewrap: forget what is cached. */
export function forgetTenantKeys(): void {
  keys.clear();
}
