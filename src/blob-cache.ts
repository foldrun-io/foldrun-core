// A node-local, bounded cache of blobs, keyed by sha (FOL-126, phase 3 seam).
//
// Object storage holds the truth; local disk is only a cache. A reader asks for
// (tenant, sha) and gets a file path it can open, stat, or hand to a tar. A
// miss is read through: the blob is downloaded from the BlobStore, hashed
// against its name, and only then made visible.
//
//   * bounded     a byte cap; past it the least recently used UNPINNED entries
//                 are removed. The cap is soft in one case only: when every
//                 entry is pinned (or one blob alone is bigger than the cap)
//                 the cache goes over rather than pull a file out from under a
//                 reader. It shrinks again as leases are released.
//   * pinned      `acquire` returns a lease; an entry with a live lease is never
//                 evicted. Release it (idempotent) when done; `stream()` and
//                 `withBlob()` do it for you.
//   * atomic      a download goes to `tmp/` and is renamed into place after the
//                 hash matched. No reader ever sees a partial file, and a crash
//                 leaves only a `.part` that the next start sweeps when old.
//   * concurrent  N readers of one missing blob share ONE download (single
//                 flight) and each gets its own pin. Fills across different
//                 blobs are capped (`fillConcurrency`), on top of the store's own
//                 concurrency cap. A reader that gives up (its signal) does not
//                 cancel the download the others are waiting for.
//   * tenant-safe the directory is per tenant. Content addressing would let two
//                 tenants share a file, but then a cache hit would answer "does
//                 this sha exist?" without the store's authorisation; cross
//                 tenant dedup is a non-goal of FOL-126.
//
// What it is NOT: shared between processes. Each process keeps its own index of
// its directory. Two processes on one directory are tolerated (publish is a
// rename, eviction renames before it unlinks, a file that vanished is a miss)
// but they do not see each other's pins, so give each pod its own directory
// (an emptyDir or node disk, never the shared volume this refactor removes).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { Readable } from "node:stream";
import { downloadToFile, type BlobStore } from "./blob-store.ts";
import { blobObjectKey } from "./manifest.ts";

export interface BlobCacheOptions {
  /** Where entries live. Must be node-local disk. */
  dir: string;
  /** The cap on bytes held, soft only while everything is pinned. */
  maxBytes: number;
  /** Where a miss is read from. Only `head`/`get` are used. */
  store: BlobStore;
  /** Downloads of different blobs at once. */
  fillConcurrency?: number;
  /** A `.part` older than this at start-up is a dead process's; remove it. */
  stalePartMs?: number;
}

export interface CacheLease {
  /** An existing, complete, hash-verified file. Read it; do not write it. */
  readonly path: string;
  readonly size: number;
  /** Let the entry be evicted again. Safe to call twice. */
  release(): void;
}

export interface CacheStats {
  entries: number;
  bytes: number;
  maxBytes: number;
  pinned: number;
  hits: number;
  misses: number;
  /** Misses that joined a download already running. */
  joined: number;
  fills: number;
  evictions: number;
  /** Times the cache was over its cap because nothing was evictable. */
  overCap: number;
  peakBytes: number;
  fillsInFlight: number;
}

interface Entry {
  size: number;
  pins: number;
  /** Monotonic use counter: the larger, the more recent. */
  tick: number;
}

interface Fill {
  promise: Promise<void>;
  /** Readers waiting; each is handed a pin when the entry is inserted. */
  waiters: number;
  inserted: boolean;
}

export interface BlobCache {
  acquire(tenant: string, sha: string, opts?: { signal?: AbortSignal }): Promise<CacheLease>;
  /** The blob as a stream (an optional inclusive byte range); pinned until the stream closes. */
  stream(tenant: string, sha: string, opts?: { signal?: AbortSignal; range?: { start: number; end: number } }): Promise<Readable>;
  /** Run `fn` with the blob pinned. */
  withBlob<T>(tenant: string, sha: string, fn: (file: string, size: number) => Promise<T>, opts?: { signal?: AbortSignal }): Promise<T>;
  stats(): CacheStats;
}

const SHA = /^[0-9a-f]{64}$/;

export function defaultCacheDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.FOLDRUN_BLOB_CACHE_DIR || path.join(os.tmpdir(), "foldrun-blob-cache");
}

export function cacheMaxBytesFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const v = env.FOLDRUN_BLOB_CACHE_MB;
  return (v && /^\d+$/.test(v) && Number(v) > 0 ? Number(v) : 2048) * 1024 * 1024;
}

export function blobCache(opts: BlobCacheOptions): BlobCache {
  const { dir, maxBytes, store } = opts;
  const root = path.join(dir, "blobs");
  const tmpDir = path.join(dir, "tmp");
  const fillCap = Math.max(1, opts.fillConcurrency ?? 4);
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(tmpDir, { recursive: true });

  const index = new Map<string, Entry>();
  const fills = new Map<string, Fill>();
  let tick = 0;
  let bytes = 0;
  const st = { hits: 0, misses: 0, joined: 0, fills: 0, evictions: 0, overCap: 0, peakBytes: 0 };

  const keyOf = (tenant: string, sha: string) => {
    if (!SHA.test(sha)) throw new Error("expected a sha256");
    blobObjectKey(tenant, sha); // validates the tenant segment
    return `${tenant}/${sha}`;
  };
  const fileOf = (tenant: string, sha: string) => path.join(root, tenant, sha.slice(0, 2), sha);

  // ---- start-up: take what is on disk, oldest use first; sweep dead parts ----
  {
    const found: { k: string; size: number; at: number }[] = [];
    for (const t of safeDir(root)) {
      for (const shard of safeDir(path.join(root, t))) {
        for (const name of safeDir(path.join(root, t, shard))) {
          if (!SHA.test(name)) continue;
          try {
            const s = fs.statSync(path.join(root, t, shard, name));
            if (s.isFile()) found.push({ k: `${t}/${name}`, size: s.size, at: s.mtimeMs });
          } catch {}
        }
      }
    }
    found.sort((a, b) => a.at - b.at);
    for (const f of found) {
      index.set(f.k, { size: f.size, pins: 0, tick: ++tick });
      bytes += f.size;
    }
    const stale = opts.stalePartMs ?? 3600_000;
    for (const n of safeDir(tmpDir)) {
      try {
        const f = path.join(tmpDir, n);
        if (Date.now() - fs.statSync(f).mtimeMs >= stale) fs.rmSync(f, { force: true });
      } catch {}
    }
  }

  const gate = (() => {
    let active = 0;
    const waiting: (() => void)[] = [];
    return async <T>(fn: () => Promise<T>): Promise<T> => {
      if (active >= fillCap) await new Promise<void>((r) => waiting.push(r));
      active++;
      try {
        return await fn();
      } finally {
        active--;
        waiting.shift()?.();
      }
    };
  })();
  let inFlight = 0;

  /** Remove least-recently-used unpinned entries until under the cap. */
  function evict() {
    while (bytes > maxBytes) {
      let victim: [string, Entry] | null = null;
      for (const e of index) if (e[1].pins === 0 && (!victim || e[1].tick < victim[1].tick)) victim = e;
      if (!victim) {
        st.overCap++;
        return;
      }
      const [k, e] = victim;
      index.delete(k);
      bytes -= e.size;
      st.evictions++;
      const [tenant, sha] = k.split("/");
      // Rename first: a reader that opens by path sees ENOENT (a miss), never a
      // half-deleted file; an fd already open keeps reading its inode.
      const gone = path.join(tmpDir, `evict-${process.pid}-${crypto.randomBytes(4).toString("hex")}`);
      try {
        fs.renameSync(fileOf(tenant, sha), gone);
        fs.rmSync(gone, { force: true });
      } catch {}
    }
  }

  const lease = (k: string, e: Entry, file: string): CacheLease => {
    let released = false;
    return {
      path: file,
      size: e.size,
      release() {
        if (released) return;
        released = true;
        e.pins--;
        if (index.get(k) === e && bytes > maxBytes) evict();
      },
    };
  };

  /** A hit if the file is really there at the size we recorded. */
  function hit(k: string, tenant: string, sha: string): CacheLease | null {
    const e = index.get(k);
    if (!e) return null;
    const file = fileOf(tenant, sha);
    try {
      if (fs.statSync(file).size !== e.size) throw new Error("size changed");
    } catch {
      // Removed or damaged behind our back (another process, a tmp cleaner).
      if (e.pins === 0) {
        index.delete(k);
        bytes -= e.size;
      }
      return null;
    }
    e.pins++;
    e.tick = ++tick;
    const now = new Date();
    fs.utimes(file, now, now, () => {}); // keeps the order across a restart
    return lease(k, e, file);
  }

  function startFill(k: string, tenant: string, sha: string, f: Fill): Promise<void> {
    return gate(async () => {
      inFlight++;
      const part = path.join(tmpDir, `${tenant}-${sha}.${process.pid}.part`);
      try {
        const final = fileOf(tenant, sha);
        fs.mkdirSync(path.dirname(final), { recursive: true });
        // downloadToFile resumes a cut body with a Range and checks the hash
        // before it renames `part` to its name; nothing is left on a mismatch.
        const dl = `${part}.dl`;
        const { size } = await downloadToFile(store, blobObjectKey(tenant, sha), dl, { sha256: sha });
        fs.renameSync(dl, final);
        const e: Entry = { size, pins: f.waiters, tick: ++tick };
        const old = index.get(k);
        if (old) bytes -= old.size; // another process won the rename; same bytes
        index.set(k, e);
        bytes += size;
        st.peakBytes = Math.max(st.peakBytes, bytes);
        f.inserted = true;
        st.fills++;
        evict(); // the new entry is pinned by its waiters; others may go
      } finally {
        inFlight--;
        fs.rmSync(part, { force: true });
      }
    });
  }

  async function acquire(tenant: string, sha: string, o: { signal?: AbortSignal } = {}): Promise<CacheLease> {
    const k = keyOf(tenant, sha);
    if (o.signal?.aborted) throw o.signal.reason ?? new Error("cancelled");
    const got = hit(k, tenant, sha);
    if (got) {
      st.hits++;
      return got;
    }
    let f = fills.get(k);
    if (f) st.joined++;
    else {
      st.misses++;
      const fill: Fill = { waiters: 0, inserted: false, promise: Promise.resolve() };
      fills.set(k, fill);
      fill.promise = startFill(k, tenant, sha, fill).finally(() => {
        if (fills.get(k) === fill) fills.delete(k);
      });
      // A failed fill rejects every waiter; nothing else holds the promise.
      fill.promise.catch(() => {});
      f = fill;
    }
    f.waiters++;
    const mine = f;
    let abort: (() => void) | undefined;
    try {
      await Promise.race([
        mine.promise,
        new Promise<never>((_, reject) => {
          if (!o.signal) return;
          abort = () => reject(o.signal!.reason ?? new Error("cancelled"));
          o.signal.addEventListener("abort", abort, { once: true });
        }),
      ]);
    } catch (err) {
      // Leaving: if the entry was already pinned for us, give that pin back.
      if (mine.inserted) {
        const e = index.get(k);
        if (e) {
          e.pins--;
          if (bytes > maxBytes) evict();
        }
      } else mine.waiters--;
      throw err;
    } finally {
      if (abort) o.signal!.removeEventListener("abort", abort);
    }
    const e = index.get(k)!;
    e.tick = ++tick;
    return lease(k, e, fileOf(tenant, sha));
  }

  return {
    acquire,
    async stream(tenant, sha, o = {}) {
      const l = await acquire(tenant, sha, o);
      try {
        const rs = fs.createReadStream(l.path, o.range ? { start: o.range.start, end: o.range.end } : {});
        rs.once("close", () => l.release());
        return rs;
      } catch (err) {
        l.release();
        throw err;
      }
    },
    async withBlob(tenant, sha, fn, o = {}) {
      const l = await acquire(tenant, sha, o);
      try {
        return await fn(l.path, l.size);
      } finally {
        l.release();
      }
    },
    stats(): CacheStats {
      let pinned = 0;
      for (const e of index.values()) if (e.pins > 0) pinned++;
      return { entries: index.size, bytes, maxBytes, pinned, ...st, fillsInFlight: inFlight };
    },
  };
}

function safeDir(d: string): string[] {
  try {
    return fs.readdirSync(d);
  } catch {
    return [];
  }
}
