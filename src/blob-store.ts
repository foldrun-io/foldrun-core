// BlobStore: immutable objects by key (FOL-126, phase 1).
//
// The small interface the revision work stands on. It is NOT a filesystem
// shim: no rename, no list-by-prefix, no append, no overwrite. A key is
// written once (put with `ifNoneMatch`), read as a stream, asked about
// (head), and removed (delete — only the garbage collector does that).
//
// Two drivers, both in this file:
//
//   fs   a directory tree under the data root. A conditional put is
//        link(2) of a finished temp file onto the target: atomic, and fails
//        with EEXIST if another writer got there first, on a local disk and
//        on NFS alike. This is what self-host Compose and the laptop get.
//   s3   any S3-compatible endpoint (R2, MinIO, AWS), signed by the code in
//        storage.ts. A conditional put is `If-None-Match: *`; 412 means "it is
//        already there".
//
// `bounded()` wraps either with what a production caller needs and neither
// driver should each reinvent: a deadline on every call, a retry budget for
// failures worth retrying, and a cap on calls in flight.
//
// Large objects: `putSourceIfAbsent` streams from a re-readable source (a file
// on disk) and, on s3 past a threshold, uploads in resumable parts. The s3
// driver lives in s3-blob-store.ts; the shared types and errors in
// blob-types.ts; both are re-exported here so callers import one module.
// tests/s3-blob-store.test.ts runs the s3 driver against a real MinIO
// (FOLDRUN_TEST_S3_URL), the contract suite runs it against the fake.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { dataRoot } from "./paths.ts";
import { s3Config } from "./storage.ts";
import { s3BlobStore } from "./s3-blob-store.ts";
import {
  BlobNotFound,
  BlobSourceError,
  BlobTransientError,
  assertKey,
  hashRange,
  type BlobStore,
  type BlobSweeper,
  type BlobSource,
  type PutSourceOptions,
  type ListedObject,
} from "./blob-types.ts";

export * from "./blob-types.ts";
export { s3BlobStore };

// ---------- fs driver ----------

export function fsBlobStore(root: string = path.join(dataRoot(), ".objects")): BlobStore & BlobSweeper {
  const at = (key: string) => path.join(root, ...assertKey(key).split("/"));
  const tmpName = (target: string) => `${target}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  return {
    kind: "fs",
    async putSourceIfAbsent(key, source, opts: PutSourceOptions = {}) {
      const target = at(key);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      if (fs.existsSync(target)) return { created: false };
      const tmp = tmpName(target);
      try {
        const sha = crypto.createHash("sha256");
        const out = fs.createWriteStream(tmp);
        await pipeline(
          Readable.from(source.read(0, source.size, opts.signal), { objectMode: false }),
          async function* (chunks: AsyncIterable<Uint8Array>) {
            for await (const c of chunks) {
              sha.update(c);
              yield c;
            }
          },
          out,
        );
        if (opts.sha256 && sha.digest("hex") !== opts.sha256) throw new BlobSourceError(`the bytes for ${key} do not hash to ${opts.sha256}`);
        try {
          fs.linkSync(tmp, target);
          return { created: true };
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === "EEXIST") return { created: false };
          throw err;
        }
      } finally {
        fs.rmSync(tmp, { force: true });
      }
    },
    async abortStaleUploads({ olderThanMs, prefix = "" }) {
      // The fs driver's "incomplete uploads" are temp files a dead writer left.
      let n = 0;
      const walk = (dir: string) => {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
          const f = path.join(dir, e.name);
          if (e.isDirectory()) walk(f);
          else if (e.name.endsWith(".tmp") && path.relative(root, f).startsWith(prefix) && Date.now() - fs.statSync(f).mtimeMs >= olderThanMs) {
            fs.rmSync(f, { force: true });
            n++;
          }
        }
      };
      if (fs.existsSync(root)) walk(root);
      return n;
    },
    async putIfAbsent(key, body) {
      const target = at(key);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      if (fs.existsSync(target)) return { created: false };
      const tmp = `${target}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
      fs.writeFileSync(tmp, body);
      try {
        // link() refuses an existing target: the atomic "create if absent".
        fs.linkSync(tmp, target);
        return { created: true };
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "EEXIST") return { created: false };
        throw err;
      } finally {
        fs.rmSync(tmp, { force: true });
      }
    },
    async get(key, opts = {}) {
      const target = at(key);
      if (!fs.existsSync(target)) throw new BlobNotFound(key);
      const stream = fs.createReadStream(target, opts.range ? { start: opts.range.start, end: opts.range.end } : {});
      return Readable.toWeb(stream) as unknown as ReadableStream<Uint8Array>;
    },
    async head(key) {
      const target = at(key); // a bad key throws; only a missing file is null
      try {
        const st = fs.statSync(target);
        return st.isFile() ? { size: st.size, modifiedAt: st.mtime } : null;
      } catch {
        return null;
      }
    },
    async delete(key) {
      fs.rmSync(at(key), { force: true });
    },
    async purgeTenant(tenant) {
      fs.rmSync(path.dirname(at(`t/${tenant}/x`)), { recursive: true, force: true });
    },
    async *list(prefix) {
      const base = at(`${prefix.replace(/\/+$/, "")}/x`);
      const dir = path.dirname(base);
      const walk = function* (d: string, rel: string): Generator<ListedObject> {
        let names: fs.Dirent[] = [];
        try {
          names = fs.readdirSync(d, { withFileTypes: true });
        } catch {
          return;
        }
        for (const e of names) {
          if (e.isDirectory()) yield* walk(path.join(d, e.name), `${rel}${e.name}/`);
          else if (e.isFile() && !e.name.endsWith(".tmp")) {
            try {
              const st = fs.statSync(path.join(d, e.name));
              yield { key: `${rel}${e.name}`, size: st.size, modifiedAt: st.mtime };
            } catch {
              // gone meanwhile
            }
          }
        }
      };
      yield* walk(dir, `${prefix.replace(/\/+$/, "")}/`);
    },
    async tenants() {
      try {
        return fs.readdirSync(path.join(root, "t"), { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
      } catch {
        return [];
      }
    },
  };
}

// ---------- download to a file ----------

/**
 * Fetch an object into a file, resuming. The bytes land in `<dest>.part`;
 * a connection cut mid-body (a transient error) is picked up again with a
 * Range from where the file ends, and so is a `.part` a dead process left.
 * The whole file is hashed against `sha256` (when given) before it is renamed
 * into place; a mismatch discards it and throws BlobSourceError.
 */
export async function downloadToFile(
  store: BlobStore,
  key: string,
  dest: string,
  opts: { sha256?: string; signal?: AbortSignal; attempts?: number } = {},
): Promise<{ size: number }> {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const part = `${dest}.part`;
  const size = (await store.head(key, { signal: opts.signal }))?.size;
  if (size === undefined) throw new BlobNotFound(key);
  const max = opts.attempts ?? 5;
  for (let attempt = 0; ; attempt++) {
    let have = fs.existsSync(part) ? fs.statSync(part).size : 0;
    if (have > size) {
      fs.rmSync(part, { force: true });
      have = 0;
    }
    if (have < size) {
      try {
        const body = await store.get(key, { signal: opts.signal, ...(have > 0 ? { range: { start: have, end: size - 1 } } : {}) });
        await pipeline(Readable.fromWeb(body as never), fs.createWriteStream(part, { flags: have > 0 ? "a" : "w" }));
      } catch (err) {
        const transient = err instanceof BlobTransientError || (err as { cause?: unknown })?.cause instanceof BlobTransientError;
        if (!transient || attempt + 1 >= max || opts.signal?.aborted) throw err;
        continue;
      }
    } else if (have === 0) {
      // An empty object: nothing to fetch, but the file must still exist to
      // be checked and renamed into place like any other.
      fs.writeFileSync(part, "");
    }
    if (fs.statSync(part).size !== size) {
      if (attempt + 1 >= max) throw new BlobTransientError(`download of ${key} stopped short`);
      continue;
    }
    break;
  }
  if (opts.sha256) {
    const h = await hashRange(fileRange(part), 0, size, opts.signal);
    if (h.sha256 !== opts.sha256) {
      fs.rmSync(part, { force: true });
      throw new BlobSourceError(`${key} does not hash to ${opts.sha256}`);
    }
  }
  fs.renameSync(part, dest);
  return { size };
}

const fileRange = (file: string): BlobSource => ({
  size: fs.statSync(file).size,
  async *read(start, end) {
    if (end > start) yield* fs.createReadStream(file, { start, end: end - 1 });
  },
});

// ---------- the store in force ----------

/** s3 when FOLDRUN_STORAGE_DRIVER=s3 and it is fully configured, else fs.
 *  (The same fall-back rule as storage.ts's driverFor.) */
export function blobStore(): BlobStore & BlobSweeper {
  if (process.env.FOLDRUN_STORAGE_DRIVER === "s3") {
    const cfg = s3Config();
    if (cfg) return bounded(s3BlobStore(cfg));
  }
  return bounded(fsBlobStore());
}

// ---------- deadlines, retries, concurrency ----------

export interface Limits {
  /** Per attempt. */
  deadlineMs: number;
  /** Extra attempts after the first, for transient failures only. */
  retries: number;
  /** Calls in flight at once, across all keys. */
  concurrency: number;
  /** First backoff; doubles each retry, with jitter. */
  backoffMs: number;
  /** The slowest link a transfer is expected to survive. A put's deadline is
   *  `deadlineMs` plus its size over this, so a 400 MB blob is not cut off at
   *  the 30 s a head gets. */
  minBytesPerSec: number;
}

export const DEFAULT_LIMITS: Limits = { deadlineMs: 30_000, retries: 3, concurrency: 8, backoffMs: 200, minBytesPerSec: 1024 * 1024 };

export function limitsFromEnv(env: NodeJS.ProcessEnv = process.env): Limits {
  const n = (v: string | undefined, d: number) => (v !== undefined && /^\d+$/.test(v) ? Number(v) : d);
  return {
    deadlineMs: n(env.FOLDRUN_BLOB_DEADLINE_MS, DEFAULT_LIMITS.deadlineMs),
    retries: n(env.FOLDRUN_BLOB_RETRIES, DEFAULT_LIMITS.retries),
    concurrency: Math.max(1, n(env.FOLDRUN_BLOB_CONCURRENCY, DEFAULT_LIMITS.concurrency)),
    backoffMs: DEFAULT_LIMITS.backoffMs,
    minBytesPerSec: Math.max(1, n(env.FOLDRUN_BLOB_MIN_BYTES_PER_SEC, DEFAULT_LIMITS.minBytesPerSec)),
  };
}

class Semaphore {
  private waiting: (() => void)[] = [];
  private active = 0;
  private readonly max: number;
  constructor(max: number) {
    this.max = max;
  }
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.max) await new Promise<void>((r) => this.waiting.push(r));
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      this.waiting.shift()?.();
    }
  }
}

const isTransient = (err: unknown) =>
  err instanceof BlobTransientError || ["ECONNRESET", "ETIMEDOUT", "EAGAIN", "EBUSY", "EMFILE"].includes((err as NodeJS.ErrnoException)?.code ?? "");

/**
 * Wrap a store so every call has a deadline (an AbortSignal handed down; the
 * call fails with BlobTransientError if it passes), is retried on transient
 * failure within a budget, and counts against a concurrency cap.
 *
 * A `get` is deadline-bound only until the stream starts: a long download is
 * the caller's to bound. A not-found, a 4xx and a bad key are never retried.
 */
export function bounded<S extends BlobStore & Partial<BlobSweeper>>(inner: S, limits: Partial<Limits> = {}): S & BlobSweeper {
  const L = { ...limitsFromEnv(), ...limits };
  const gate = new Semaphore(L.concurrency);
  /** The caller's signal and this attempt's deadline, either of which ends it. */
  const both = (caller: AbortSignal | undefined, ms: number) => {
    const deadline = AbortSignal.timeout(ms);
    return caller ? AbortSignal.any([caller, deadline]) : deadline;
  };
  async function call<T>(what: string, caller: AbortSignal | undefined, fn: (signal: AbortSignal) => Promise<T>, bytes = 0): Promise<T> {
    const ms = L.deadlineMs + Math.ceil((bytes / L.minBytesPerSec) * 1000);
    return gate.run(async () => {
      let attempt = 0;
      for (;;) {
        if (caller?.aborted) throw caller.reason ?? new Error(`${what}: cancelled`);
        const signal = both(caller, ms);
        try {
          return await Promise.race([
            fn(signal),
            new Promise<never>((_, reject) =>
              signal.addEventListener(
                "abort",
                () => reject(caller?.aborted ? (caller.reason ?? new Error(`${what}: cancelled`)) : new BlobTransientError(`${what}: no answer within ${ms}ms`)),
                { once: true },
              ),
            ),
          ]);
        } catch (err) {
          if (caller?.aborted || !isTransient(err) || attempt >= L.retries) throw err;
          attempt++;
          await new Promise((r) => setTimeout(r, L.backoffMs * 2 ** (attempt - 1) * (0.5 + Math.random())));
        }
      }
    });
  }
  return {
    ...inner,
    kind: inner.kind,
    putIfAbsent: (key, body, opts) => call("put", opts?.signal, (signal) => inner.putIfAbsent(key, body, { ...opts, signal }), body.byteLength),
    // The deadline covers getting the stream going, not draining it: the
    // timer is cleared once the object starts to arrive. The caller's signal
    // stays attached to the stream, so cancelling still stops the download.
    get: (key, opts) =>
      call("get", opts?.signal, async () => {
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), L.deadlineMs);
        const onCaller = () => ctl.abort(opts?.signal?.reason);
        opts?.signal?.addEventListener("abort", onCaller, { once: true });
        try {
          return await inner.get(key, { ...opts, signal: ctl.signal });
        } finally {
          clearTimeout(timer);
        }
      }),
    // A streamed put has no fixed deadline (its length decides), so it gets the
    // retry budget and the concurrency cap, and the s3 driver's own per-request
    // deadlines. Cancelling is the caller's signal.
    putSourceIfAbsent: (key, source, opts) =>
      gate.run(async () => {
        for (let attempt = 0; ; attempt++) {
          if (opts?.signal?.aborted) throw opts.signal.reason ?? new Error("put: cancelled");
          try {
            return await inner.putSourceIfAbsent(key, source, opts);
          } catch (err) {
            if (opts?.signal?.aborted || !isTransient(err) || attempt >= L.retries) throw err;
            await new Promise((r) => setTimeout(r, L.backoffMs * 2 ** attempt * (0.5 + Math.random())));
          }
        }
      }),
    abortStaleUploads: (o) => (inner.abortStaleUploads ? inner.abortStaleUploads(o) : Promise.resolve(0)),
    head: (key, opts) => call("head", opts?.signal, (signal) => inner.head(key, { signal })),
    delete: (key, opts) => call("delete", opts?.signal, (signal) => (inner.delete ? inner.delete(key, { signal }) : Promise.reject(new Error("this store cannot delete")))),
    ...(inner.purgeTenant ? { purgeTenant: (tenant: string) => inner.purgeTenant!(tenant) } : {}),
    ...(inner.list ? { list: (prefix: string, o?: { signal?: AbortSignal }) => inner.list!(prefix, o) } : {}),
    ...(inner.tenants ? { tenants: (o?: { signal?: AbortSignal }) => inner.tenants!(o) } : {}),
  } as S & BlobSweeper;
}
