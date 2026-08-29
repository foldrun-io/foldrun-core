// Redis: only what can be rebuilt.
//
// The test for whether something belongs here (docs/paas-adr.md): if Redis is
// wiped, the platform gets slower and re-elects a worker, and loses no
// customer data. Rate-limit counters, leases, SSE fan-out, hot caches — yes.
// Runs, money, identity — never; those are Postgres, and the queue stays in
// the same database as the run records so a claim and a status write are one
// transaction. Adding Redis does not reopen that.
//
// OPTIONAL, like the database. With no FOLDRUN_REDIS_URL every function here
// degrades to a safe local answer rather than throwing — a laptop install has
// no Redis and must still refuse a brute-force attempt.
//
//   FOLDRUN_REDIS_URL   redis://host:6379

import { Redis } from "ioredis";

let client: Redis | null = null;
let down = false;

export function cacheEnabled(): boolean {
  return Boolean(process.env.FOLDRUN_REDIS_URL);
}

export function cache(): Redis | null {
  if (!cacheEnabled()) return null;
  if (!client) {
    client = new Redis(process.env.FOLDRUN_REDIS_URL!, {
      // A request must never hang waiting for a cache. Failing fast and
      // falling back is the whole point of holding only rebuildable state.
      connectTimeout: 2_000,
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      lazyConnect: false,
    });
    client.on("error", (err: Error) => {
      if (!down) console.error("[cache] redis unavailable:", err.message);
      down = true;
    });
    client.on("ready", () => {
      if (down) console.log("[cache] redis back");
      down = false;
    });
  }
  return client;
}

// ------------------------------------------------------------- rate limiting
//
// The gap this closes was live and exploitable: /api/auth/login had no limit
// at all, so a password could be guessed as fast as scrypt would answer.

/** In-process fallback, so a laptop with no Redis is still not a free oracle. */
const local = new Map<string, { n: number; resetAt: number }>();

export interface RateVerdict {
  allowed: boolean;
  remaining: number;
  /** Seconds until the window resets — what a Retry-After header wants. */
  retryAfter: number;
}

/**
 * Fixed-window counter. Chosen over a sliding log because the failure mode of
 * a fixed window — up to 2x the limit across a boundary — is irrelevant for
 * login attempts, and it costs one INCR instead of a sorted set per attempt.
 *
 * Fails OPEN if Redis is unreachable, and says so. A cache outage must not
 * lock every customer out of their own account; the in-process counter below
 * still holds the line for a single replica, which is the common case.
 */
export async function rateLimit(
  key: string,
  limit: number,
  windowSec: number,
): Promise<RateVerdict> {
  const c = cache();
  if (c) {
    try {
      const k = `rl:${key}`;
      const n = await c.incr(k);
      if (n === 1) await c.expire(k, windowSec);
      const ttl = n === 1 ? windowSec : await c.ttl(k);
      return {
        allowed: n <= limit,
        remaining: Math.max(0, limit - n),
        retryAfter: ttl > 0 ? ttl : windowSec,
      };
    } catch {
      // fall through to the local counter rather than refusing to serve
    }
  }

  const now = Date.now();
  const hit = local.get(key);
  if (!hit || hit.resetAt <= now) {
    local.set(key, { n: 1, resetAt: now + windowSec * 1000 });
    // Unbounded growth is the only way this map hurts; a sweep on write is
    // cheaper than a timer and runs exactly when entries are being added.
    if (local.size > 10_000) {
      for (const [k, v] of local) if (v.resetAt <= now) local.delete(k);
    }
    return { allowed: true, remaining: limit - 1, retryAfter: windowSec };
  }
  hit.n += 1;
  return {
    allowed: hit.n <= limit,
    remaining: Math.max(0, limit - hit.n),
    retryAfter: Math.ceil((hit.resetAt - now) / 1000),
  };
}

/** Forget a key — called on a SUCCESSFUL login, so one good password does not
 *  leave someone throttled by their own earlier typos. */
export async function rateLimitReset(key: string): Promise<void> {
  local.delete(key);
  const c = cache();
  if (!c) return;
  try {
    await c.del(`rl:${key}`);
  } catch {
    // a counter that outlives its reset is a slow login, not a broken one
  }
}

/** True when Redis answers. For healthz, never to gate a request. */
export async function cacheReady(): Promise<boolean> {
  const c = cache();
  if (!c) return false;
  try {
    return (await c.ping()) === "PONG";
  } catch {
    return false;
  }
}
