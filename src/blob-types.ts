// The BlobStore contract and the pieces every driver shares (FOL-126).
// Split out of blob-store.ts so the s3 driver (s3-blob-store.ts) and the fs
// driver can both use the errors and the source type without importing each
// other.

import fs from "node:fs";
import crypto from "node:crypto";

export class BlobNotFound extends Error {
  readonly key: string;
  constructor(key: string) {
    super(`no object at ${key}`);
    this.name = "BlobNotFound";
    this.key = key;
  }
}

/** A failure the caller may retry: the network, a timeout, a 5xx, a 429, a
 *  conditional-write conflict, an expired token. Everything else (403, 400,
 *  404, a bad bucket name) is final. */
export class BlobTransientError extends Error {
  readonly status?: number;
  /** The store's own error code when it gave one (S3: `SlowDown`, ...). */
  readonly code?: string;
  constructor(message: string, status?: number, code?: string) {
    super(message);
    this.name = "BlobTransientError";
    this.status = status;
    this.code = code;
  }
}

/** The store said no and will say no again: wrong credentials, no such bucket,
 *  a malformed request. Carries the HTTP status and the store's error code. */
export class BlobStoreError extends Error {
  readonly status: number;
  readonly code?: string;
  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = "BlobStoreError";
    this.status = status;
    this.code = code;
  }
}

/** The bytes being uploaded stopped matching what was announced (the file was
 *  truncated, rewritten, or does not hash to the name it was given). Not
 *  retried: reading it again would give the same answer. */
export class BlobSourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BlobSourceError";
  }
}

export interface PutOptions {
  contentType?: string;
  signal?: AbortSignal;
}

export interface PutSourceOptions extends PutOptions {
  /** Hex sha256 of the whole content, when the caller has it (a blob key is
   *  one). It is signed into the request, so the store verifies it; without it
   *  the source is read once more to find it. */
  sha256?: string;
}

export interface PutResult {
  created: boolean;
  /** The store's ETag for the object that is there, unquoted, when it said.
   *  For a single-request upload that is the md5 of the content on S3, R2 and
   *  MinIO; for a multipart upload it is `<hash>-<parts>`. */
  etag?: string;
}

export interface HeadResult {
  size: number;
  /** When the object was last written, when the store says (whole seconds on
   *  S3). The garbage collector's grace period is measured from here. NOTE: a
   *  conditional put that finds the object already there does NOT refresh it,
   *  so an old blob that a new publish reuses looks old to a sweeper — the
   *  grace period alone does not protect it (see publish.ts, "the GC window"). */
  modifiedAt?: Date;
  etag?: string;
}

/**
 * A re-readable source of bytes. Streaming upload needs to read the same bytes
 * more than once: to hash them before they are sent, and again for every retry
 * or resumed part. So it is a *range reader*, not a one-shot stream.
 */
export interface BlobSource {
  readonly size: number;
  /** The bytes [start, end) as a stream. Throws BlobSourceError if the source
   *  turns out shorter than `size`. */
  read(start: number, end: number, signal?: AbortSignal): AsyncIterable<Uint8Array>;
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
   *  object is NOT verified against `body` — callers that need that compare the
   *  returned `etag` or read it back. After a retry, `created: false` can also
   *  mean "my first attempt landed and its answer was lost". */
  putIfAbsent(key: string, body: Uint8Array, opts?: PutOptions): Promise<PutResult>;
  /** The same, for content that should not be held in memory: streamed from the
   *  source, and — on s3, past the multipart threshold — uploaded in parts that
   *  survive an interruption and are picked up again by the next call. */
  putSourceIfAbsent(key: string, source: BlobSource, opts?: PutSourceOptions): Promise<PutResult>;
  /** The object as a stream, optionally one inclusive byte range. Throws BlobNotFound. */
  get(key: string, opts?: { range?: { start: number; end: number }; signal?: AbortSignal }): Promise<ReadableStream<Uint8Array>>;
  head(key: string, opts?: { signal?: AbortSignal }): Promise<HeadResult | null>;
}

/** Removal. Held by the garbage collector and by tests; not passed to publish. */
export interface BlobSweeper {
  /** Idempotent: a missing key is the end state asked for. */
  delete(key: string, opts?: { signal?: AbortSignal }): Promise<void>;
  /** Throw away uploads that were started and never finished (s3 multipart
   *  uploads; fs temp files) and are older than `olderThanMs`. Returns how many.
   *  A bucket lifecycle rule (AbortIncompleteMultipartUpload) does the same on
   *  AWS and R2; this is for stores that have none, and for tests. */
  abortStaleUploads(opts: { olderThanMs: number; prefix?: string; signal?: AbortSignal }): Promise<number>;
  /** An account is gone: remove everything under its prefix. Only a store that
   *  can enumerate has it (the folder one); a bucket's objects are the
   *  sweeper's once the account's pins are released. */
  purgeTenant?(tenant: string): Promise<void>;
  /** Every object under a key prefix, with its size and last-modified time —
   *  what the sweeper walks. */
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

// ---------- sources ----------

export function bufferSource(buf: Uint8Array): BlobSource {
  return {
    size: buf.byteLength,
    async *read(start, end) {
      const hi = Math.min(end, buf.byteLength);
      // Slices of at most 1 MiB, so a consumer sees a stream either way.
      for (let at = start; at < hi; at += 1 << 20) yield buf.subarray(at, Math.min(at + (1 << 20), hi));
    },
  };
}

/** A file on disk. The size is taken now; if the file is shorter (or longer)
 *  when it is read, the read throws BlobSourceError rather than send a body
 *  that no longer matches what was announced. */
export function fileSource(filePath: string): BlobSource {
  const size = fs.statSync(filePath).size;
  return {
    size,
    async *read(start, end, signal) {
      const hi = Math.min(end, size);
      if (hi <= start) return;
      const stream = fs.createReadStream(filePath, { start, end: hi - 1, highWaterMark: 1 << 20, signal });
      let got = 0;
      for await (const chunk of stream) {
        got += (chunk as Buffer).length;
        yield chunk as Buffer;
      }
      if (got !== hi - start) throw new BlobSourceError(`${filePath} changed while it was being uploaded: expected ${hi - start} bytes at ${start}, read ${got}`);
    },
  };
}

/** sha256 (and md5, which is what a single-request ETag is) of a range. */
export async function hashRange(source: BlobSource, start: number, end: number, signal?: AbortSignal): Promise<{ sha256: string; md5: string }> {
  const sha = crypto.createHash("sha256");
  const md5 = crypto.createHash("md5");
  for await (const chunk of source.read(start, end, signal)) {
    sha.update(chunk);
    md5.update(chunk);
  }
  return { sha256: sha.digest("hex"), md5: md5.digest("hex") };
}
