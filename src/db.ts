// Postgres: the record store.
//
// The rule this file exists to hold (docs/paas-adr.md): markdown for what
// people author, Postgres for what the system accumulates. Workspaces, agents
// and flows stay files — they are the product. Runs, money, jobs, identity and
// audit are records: they need transactions, indexes and concurrent writers,
// and every symptom that pushed us here was one of those three missing.
//
// OPTIONAL BY DESIGN. With no FOLDRUN_DATABASE_URL the platform runs exactly
// as it did — files only. That is what a self-hoster on a laptop gets, and it
// is also the rollback: unset the variable and the file paths are still there.
// So every caller must handle `null` rather than assume a pool.
//
//   FOLDRUN_DATABASE_URL       postgres://user@host:5432/db
//   FOLDRUN_DATABASE_PASSWORD  kept separate so the URL can be a plain value
//                              in a manifest while the password comes from a
//                              secret — a URL with credentials inline leaks
//                              into every log line that prints its config.

import { Pool, type PoolClient } from "pg";

let pool: Pool | null = null;

export function databaseEnabled(): boolean {
  return Boolean(process.env.FOLDRUN_DATABASE_URL);
}

/** The pool, or null when this install has no database. */
export function db(): Pool | null {
  if (!databaseEnabled()) return null;
  if (!pool) {
    pool = new Pool({
      connectionString: process.env.FOLDRUN_DATABASE_URL,
      password: process.env.FOLDRUN_DATABASE_PASSWORD || undefined,
      // A web replica holds connections while it serves; Postgres counts them
      // against max_connections globally, so the cap is per-process and small
      // on purpose. N replicas × this is the number that matters.
      max: Number(process.env.FOLDRUN_DATABASE_POOL) || 8,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
    });
    // A pool that emits an unhandled 'error' takes the process down. Postgres
    // restarting under us is normal (a rollout, a node reboot) and must be a
    // logged reconnect, not an outage of the whole platform.
    pool.on("error", (err) => console.error("[db] idle client error:", err.message));
  }
  return pool;
}

/** Run inside a transaction, rolling back on any throw. */
export async function tx<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const p = db();
  if (!p) throw new Error("no database configured");
  const client = await p.connect();
  try {
    await client.query("BEGIN");
    const out = await fn(client);
    await client.query("COMMIT");
    return out;
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // the connection is already gone; the transaction died with it
    }
    throw err;
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------- migrations
//
// Plain SQL in order, applied once, recorded by name. No migration library:
// the whole mechanism is a table and a loop, and a library here would be a
// dependency to upgrade forever in exchange for `up`/`down` we do not use —
// a down migration on a production database is a thing you write and never
// run, because by the time you want it the data has moved on.

interface Migration {
  name: string;
  sql: string;
}

const MIGRATIONS: Migration[] = [
  {
    name: "0001_identity",
    sql: `
      -- Sessions become rows so they can be REVOKED. As signed statements they
      -- could not be: a stolen cookie stayed valid until it expired, and the
      -- only kill switch was rotating the install key, which signs out
      -- everybody. "Sign out my other devices" is table stakes and it needs a
      -- row to delete.
      CREATE TABLE IF NOT EXISTS sessions (
        id           TEXT PRIMARY KEY,
        user_id      TEXT NOT NULL,
        tenant       TEXT NOT NULL,
        created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
        expires_at   TIMESTAMPTZ NOT NULL,
        last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        -- What the person would recognise when deciding which to end. Never a
        -- raw IP beyond this: it is a security surface, not analytics.
        user_agent   TEXT,
        revoked_at   TIMESTAMPTZ
      );
      CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions (user_id) WHERE revoked_at IS NULL;
      CREATE INDEX IF NOT EXISTS sessions_expiry_idx ON sessions (expires_at);

      -- Who did what. The runs directory already records what agents did; this
      -- records what PEOPLE did, which is the half an auditor asks for and the
      -- half that was nowhere.
      CREATE TABLE IF NOT EXISTS audit_log (
        id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        at         TIMESTAMPTZ NOT NULL DEFAULT now(),
        tenant     TEXT,
        actor      TEXT NOT NULL,
        action     TEXT NOT NULL,
        subject    TEXT,
        detail     JSONB NOT NULL DEFAULT '{}'::jsonb
      );
      CREATE INDEX IF NOT EXISTS audit_tenant_at_idx ON audit_log (tenant, at DESC);
    `,
  },
];

/**
 * Apply anything unapplied. Safe to call on every boot and from every replica:
 * the advisory lock means the second one waits rather than racing, and each
 * migration is recorded by name so it runs exactly once across the fleet.
 */
export async function migrate(): Promise<string[]> {
  const p = db();
  if (!p) return [];
  const applied: string[] = [];

  await p.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name       TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);

  const client = await p.connect();
  try {
    // One arbitrary constant, held for the whole run: two replicas booting
    // together must not both apply 0001.
    await client.query("SELECT pg_advisory_lock($1)", [727_314_159]);
    const { rows } = await client.query<{ name: string }>("SELECT name FROM schema_migrations");
    const done = new Set(rows.map((r) => r.name));
    for (const m of MIGRATIONS) {
      if (done.has(m.name)) continue;
      await client.query("BEGIN");
      try {
        await client.query(m.sql);
        await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [m.name]);
        await client.query("COMMIT");
        applied.push(m.name);
      } catch (err) {
        await client.query("ROLLBACK");
        throw new Error(`migration ${m.name} failed: ${err instanceof Error ? err.message : err}`);
      }
    }
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [727_314_159]).catch(() => {});
    client.release();
  }
  return applied;
}

/** True when the database answers. Used by healthz, never to gate a request. */
export async function databaseReady(): Promise<boolean> {
  const p = db();
  if (!p) return false;
  try {
    await p.query("SELECT 1");
    return true;
  } catch {
    return false;
  }
}
