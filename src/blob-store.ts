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
// What s3 still needs before a caller depends on it (phase 2+): a streaming
// put (the body is a Buffer today; objects are capped at FOLDRUN_STORAGE_MAX_MB
// = 512 by the existing store, so this holds, but a file→S3 stream with
// UNSIGNED-PAYLOAD or aws-chunked signing avoids the copy), multipart upload
// for anything past ~5 GB, and a run against a real bucket — the tests here
// use an in-process fake that models the status codes, not S3's consistency.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { Readable } from "node:stream";
import { dataRoot } from "./paths.ts";
import { s3Config, s3Request, type S3Config } from "./storage.ts";

export class BlobNotFound extends Error {
  readonly key: string;
  constructor(key: string) {
    super(`no object at ${key}`);
    this.name = "BlobNotFound";
    this.key = key;
  }
}

/** A failure the caller may retry: the network, a timeout, a 5xx, a 429, a
 *  conditional-write conflict. Everything else (403, 400, 404) is final. */
export class BlobTransientError extends Error {
  readonly status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = "BlobTransientError";
    this.status = status;
  }
}

export interface PutOptions {
  contentType?: string;
  signal?: AbortSignal;
}

export interface HeadResult {
  size: number;
  /** When the object was last written, when the store says. The garbage
   *  collector's grace period is measured from here. NOTE: a conditional put
   *  that finds the object already there does NOT refresh it, so an old blob
   *  that a new publish reuses looks old to a sweeper — the grace period alone
   *  does not protect it (see publish.ts, "the GC window"). */
  modifiedAt?: Date;
}

/**
 * What every caller gets: create-only, read, ask. There is deliberately no
 * overwrite and no delete here — an object is named by its content, so the only
 * write that makes sense is "put it if it is not there", and removing one is
 * the garbage collector's job alone (BlobSweeper, below). A missed option
 * cannot corrupt a shared object because the option does not exist.
 */
export interface BlobStore {
  readonly kind: "fs" | "s3";
  /** Write only if nothing is at the key. `created: false` means it was
   *  already there; for a content-addressed key that is success. The existing
   *  object is NOT verified against `body` — callers that need that (the
   *  garbage collector's repair path) read it back. */
  putIfAbsent(key: string, body: Uint8Array, opts?: PutOptions): Promise<{ created: boolean }>;
  /** The object as a stream, optionally one inclusive byte range. Throws BlobNotFound. */
  get(key: string, opts?: { range?: { start: number; end: number }; signal?: AbortSignal }): Promise<ReadableStream<Uint8Array>>;
  head(key: string, opts?: { signal?: AbortSignal }): Promise<HeadResult | null>;
}

/** Removal. Held by the garbage collector and by tests; not passed to publish. */
export interface BlobSweeper {
  /** Idempotent: a missing key is the end state asked for. */
  delete(key: string, opts?: { signal?: AbortSignal }): Promise<void>;
  /** An account is gone: remove everything under its prefix. Only a store that
   *  can enumerate has it (the folder one); a bucket's objects are the
   *  sweeper's once the account's pins are released. */
  purgeTenant?(tenant: string): Promise<void>;
  /** Every object under a key prefix, with its size and last-modified time —
   *  what the sweeper walks. Only a store that can enumerate has it. */
  list?(prefix: string, opts?: { signal?: AbortSignal }): AsyncIterable<ListedObject>;
  /** The accounts that have objects (the first key segment under `t/`). */
  tenants?(opts?: { signal?: AbortSignal }): Promise<string[]>;
}

export interface ListedObject {
  key: string;
  size: number;
  modifiedAt: Date;
}

/** Read a whole object. For manifests and small blobs; a large file is
 *  streamed with `get`. */
export async function readAll(store: BlobStore, key: string): Promise<Buffer> {
  const chunks: Buffer[] = [];
  const reader = (await store.get(key)).getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

// ---------- keys ----------

/** A key is slash-separated safe segments. Checked in every driver, because a
 *  key reaches the fs driver as a path. */
export function assertKey(key: string): string {
  if (!key || key.length > 600 || key.startsWith("/") || key.split("/").some((s) => !/^[A-Za-z0-9._=-]{1,200}$/.test(s) || s === "." || s === "..")) {
    throw new Error(`illegal object key: ${key.slice(0, 80)}`);
  }
  return key;
}

// ---------- fs driver ----------

export function fsBlobStore(root: string = path.join(dataRoot(), ".objects")): BlobStore & BlobSweeper {
  const at = (key: string) => path.join(root, ...assertKey(key).split("/"));
  return {
    kind: "fs",
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

// ---------- s3 driver ----------

export function s3BlobStore(cfg: S3Config | null = s3Config()): BlobStore & BlobSweeper {
  if (!cfg) throw new Error("the s3 blob store needs FOLDRUN_S3_ENDPOINT, FOLDRUN_S3_BUCKET and credentials");
  const transient = (status: number) => status >= 500 || status === 429 || status === 408 || status === 409;
  const wrap = async (what: string, fn: () => Promise<Response>): Promise<Response> => {
    try {
      return await fn();
    } catch (err) {
      if ((err as Error)?.name === "AbortError" || (err as Error)?.name === "TimeoutError") throw new BlobTransientError(`s3 ${what}: timed out`);
      throw new BlobTransientError(`s3 ${what}: ${(err as Error)?.message ?? err}`);
    }
  };
  const fail = async (res: Response, what: string): Promise<never> => {
    const text = (await res.text().catch(() => "")).slice(0, 200);
    const msg = `s3 ${what} failed: ${res.status} ${text}`;
    if (transient(res.status)) throw new BlobTransientError(msg, res.status);
    throw Object.assign(new Error(msg), { status: res.status });
  };
  return {
    kind: "s3",
    async putIfAbsent(key, body, opts = {}) {
      assertKey(key);
      const res = await wrap("put", () => s3Request(cfg, "PUT", key, Buffer.from(body), opts.contentType, { "if-none-match": "*" }, opts.signal));
      if (res.status === 412) {
        await res.arrayBuffer().catch(() => {});
        return { created: false };
      }
      if (!res.ok) await fail(res, "put");
      await res.arrayBuffer().catch(() => {});
      return { created: true };
    },
    async get(key, opts = {}) {
      assertKey(key);
      const res = await wrap("get", () =>
        s3Request(cfg, "GET", key, undefined, undefined, opts.range ? { range: `bytes=${opts.range.start}-${opts.range.end}` } : {}, opts.signal),
      );
      if (res.status === 404) {
        await res.arrayBuffer().catch(() => {});
        throw new BlobNotFound(key);
      }
      if (!res.ok || !res.body) await fail(res, "get");
      return res.body as ReadableStream<Uint8Array>;
    },
    async head(key, opts = {}) {
      assertKey(key);
      const res = await wrap("head", () => s3Request(cfg, "HEAD", key, undefined, undefined, {}, opts.signal));
      if (res.status === 404) return null;
      if (!res.ok) await fail(res, "head");
      const size = Number(res.headers.get("content-length"));
      const lm = res.headers.get("last-modified");
      return { size: Number.isSafeInteger(size) && size >= 0 ? size : 0, ...(lm ? { modifiedAt: new Date(lm) } : {}) };
    },
    async delete(key, opts = {}) {
      assertKey(key);
      const res = await wrap("delete", () => s3Request(cfg, "DELETE", key, undefined, undefined, {}, opts.signal));
      if (!res.ok && res.status !== 404) await fail(res, "delete");
      await res.arrayBuffer().catch(() => {});
    },
    async *list(prefix, opts = {}) {
      let token: string | undefined;
      do {
        const q: Record<string, string> = { "list-type": "2", prefix: prefix.endsWith("/") ? prefix : `${prefix}/`, ...(token ? { "continuation-token": token } : {}) };
        const res = await wrap("list", () => s3Request(cfg, "GET", "", undefined, undefined, {}, opts.signal, q));
        if (!res.ok) await fail(res, "list");
        const xml = await res.text();
        for (const c of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
          const key = xmlText(c[1], "Key");
          const size = Number(xmlText(c[1], "Size"));
          const lm = xmlText(c[1], "LastModified");
          if (key) yield { key, size: Number.isFinite(size) ? size : 0, modifiedAt: lm ? new Date(lm) : new Date(0) };
        }
        token = /<IsTruncated>true<\/IsTruncated>/.test(xml) ? xmlText(xml, "NextContinuationToken") ?? undefined : undefined;
      } while (token);
    },
    async tenants(opts = {}) {
      const out: string[] = [];
      let token: string | undefined;
      do {
        const q: Record<string, string> = { "list-type": "2", prefix: "t/", delimiter: "/", ...(token ? { "continuation-token": token } : {}) };
        const res = await wrap("list", () => s3Request(cfg, "GET", "", undefined, undefined, {}, opts.signal, q));
        if (!res.ok) await fail(res, "list");
        const xml = await res.text();
        for (const c of xml.matchAll(/<CommonPrefixes>\s*<Prefix>([^<]*)<\/Prefix>/g)) out.push(unxml(c[1]).replace(/^t\//, "").replace(/\/$/, ""));
        token = /<IsTruncated>true<\/IsTruncated>/.test(xml) ? xmlText(xml, "NextContinuationToken") ?? undefined : undefined;
      } while (token);
      return out;
    },
  };
}

const unxml = (v: string) => v.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
function xmlText(xml: string, tag: string): string | null {
  const m = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(xml);
  return m ? unxml(m[1]) : null;
}

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
}

export const DEFAULT_LIMITS: Limits = { deadlineMs: 30_000, retries: 3, concurrency: 8, backoffMs: 200 };

export function limitsFromEnv(env: NodeJS.ProcessEnv = process.env): Limits {
  const n = (v: string | undefined, d: number) => (v !== undefined && /^\d+$/.test(v) ? Number(v) : d);
  return {
    deadlineMs: n(env.FOLDRUN_BLOB_DEADLINE_MS, DEFAULT_LIMITS.deadlineMs),
    retries: n(env.FOLDRUN_BLOB_RETRIES, DEFAULT_LIMITS.retries),
    concurrency: Math.max(1, n(env.FOLDRUN_BLOB_CONCURRENCY, DEFAULT_LIMITS.concurrency)),
    backoffMs: DEFAULT_LIMITS.backoffMs,
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
  const both = (caller?: AbortSignal) => {
    const deadline = AbortSignal.timeout(L.deadlineMs);
    return caller ? AbortSignal.any([caller, deadline]) : deadline;
  };
  async function call<T>(what: string, caller: AbortSignal | undefined, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
    return gate.run(async () => {
      let attempt = 0;
      for (;;) {
        if (caller?.aborted) throw caller.reason ?? new Error(`${what}: cancelled`);
        const signal = both(caller);
        try {
          return await Promise.race([
            fn(signal),
            new Promise<never>((_, reject) =>
              signal.addEventListener(
                "abort",
                () => reject(caller?.aborted ? (caller.reason ?? new Error(`${what}: cancelled`)) : new BlobTransientError(`${what}: no answer within ${L.deadlineMs}ms`)),
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
    putIfAbsent: (key, body, opts) => call("put", opts?.signal, (signal) => inner.putIfAbsent(key, body, { ...opts, signal })),
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
    head: (key, opts) => call("head", opts?.signal, (signal) => inner.head(key, { signal })),
    delete: (key, opts) => call("delete", opts?.signal, (signal) => (inner.delete ? inner.delete(key, { signal }) : Promise.reject(new Error("this store cannot delete")))),
    ...(inner.purgeTenant ? { purgeTenant: (tenant: string) => inner.purgeTenant!(tenant) } : {}),
    ...(inner.list ? { list: (prefix: string, o?: { signal?: AbortSignal }) => inner.list!(prefix, o) } : {}),
    ...(inner.tenants ? { tenants: (o?: { signal?: AbortSignal }) => inner.tenants!(o) } : {}),
  } as S & BlobSweeper;
}
