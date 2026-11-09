// The s3 BlobStore driver (FOL-126): any S3-compatible endpoint (AWS, R2,
// MinIO), signed by the code in storage.ts — no SDK.
//
// What it does beyond "PUT/GET with a signature", each point learnt by running
// it against a real server (MinIO) instead of the in-process fake:
//
//  * A conditional put is `If-None-Match: *`. 412 = "already there" and the
//    reply carries the existing object's ETag, which is returned so a caller
//    can tell "my bytes are there" from "something else is".
//  * 409 (ConditionalRequestConflict: another put of the same key is still in
//    flight) is transient: the retry then sees 412.
//  * An error is read for its S3 `<Code>`, not just its status: RequestTimeout
//    and BadDigest come back as 400 and ARE worth retrying; NoSuchBucket,
//    AccessDenied, SignatureDoesNotMatch are final and say so by name.
//  * A HEAD cannot tell a missing bucket from a missing key (both 404, no
//    body). `checkBucket()` asks the bucket itself; run it at start-up.
//  * An upload streams from a re-readable source (no Buffer of the whole
//    object), signed with its real payload hash so the server verifies it.
//  * Past a threshold the upload is multipart. Nothing is kept on the local
//    side to resume it: the next call lists the in-flight uploads for the key
//    and the parts already there, hashes the local parts, and uploads only
//    the ones that differ. An upload that is cancelled or fails for a final
//    reason is aborted; one that fails for a transient reason is left to be
//    resumed (and swept by abortStaleUploads / a bucket lifecycle rule if no
//    one comes back).

import { s3Request, forgetS3Credentials, type S3Config, type S3StreamBody } from "./storage.ts";
import {
  BlobNotFound,
  BlobSourceError,
  BlobStoreError,
  BlobTransientError,
  assertKey,
  bufferSource,
  hashRange,
  type BlobStore,
  type BlobSweeper,
  type BlobSource,
  type HeadResult,
  type PutOptions,
  type PutResult,
  type PutSourceOptions,
} from "./blob-types.ts";

const MiB = 1024 * 1024;
/** S3's floor for every part but the last. R2 and MinIO enforce the same. */
export const MIN_PART_BYTES = 5 * MiB;
/** S3's ceiling on the number of parts. */
export const MAX_PARTS = 10_000;

export interface S3BlobOptions {
  /** Objects at or above this many bytes go up as multipart. */
  multipartThresholdBytes: number;
  /** Size of every part but the last. Raised if the object would need more
   *  than MAX_PARTS; never below MIN_PART_BYTES. */
  partBytes: number;
  /** Parts in flight at once for ONE upload. */
  partConcurrency: number;
  /** Per-part (and per single request) deadline floor and the throughput the
   *  deadline assumes on top of it. */
  requestDeadlineMs: number;
  minBytesPerSec: number;
}

export const DEFAULT_S3_OPTIONS: S3BlobOptions = {
  multipartThresholdBytes: 64 * MiB,
  partBytes: 16 * MiB,
  partConcurrency: 4,
  requestDeadlineMs: 30_000,
  minBytesPerSec: 1 * MiB,
};

export function s3OptionsFromEnv(env: NodeJS.ProcessEnv = process.env): S3BlobOptions {
  const n = (v: string | undefined, d: number) => (v !== undefined && /^\d+$/.test(v) && Number(v) > 0 ? Number(v) : d);
  const d = DEFAULT_S3_OPTIONS;
  return {
    multipartThresholdBytes: n(env.FOLDRUN_BLOB_MULTIPART_THRESHOLD_MB, d.multipartThresholdBytes / MiB) * MiB,
    partBytes: Math.max(MIN_PART_BYTES, n(env.FOLDRUN_BLOB_PART_MB, d.partBytes / MiB) * MiB),
    partConcurrency: n(env.FOLDRUN_BLOB_PART_CONCURRENCY, d.partConcurrency),
    requestDeadlineMs: n(env.FOLDRUN_BLOB_DEADLINE_MS, d.requestDeadlineMs),
    minBytesPerSec: d.minBytesPerSec,
  };
}

/** The part size for an object: the configured one, raised until the object
 *  fits in MAX_PARTS parts. Every part but the last is exactly this size —
 *  R2 requires uniform parts, S3 and MinIO do not mind. */
export function planPartBytes(size: number, configured: number): number {
  let p = Math.max(MIN_PART_BYTES, configured);
  if (Math.ceil(size / p) > MAX_PARTS) p = Math.ceil(size / MAX_PARTS / MiB) * MiB;
  return p;
}

// Codes that arrive with a non-5xx status but are worth another try.
const TRANSIENT_CODES = new Set([
  "RequestTimeout",
  "SlowDown",
  "InternalError",
  "ServiceUnavailable",
  "BadDigest", // the body changed in flight
  "XAmzContentSHA256Mismatch", // the same, seen by MinIO
  "ConditionalRequestConflict",
  "OperationAborted",
  "ExpiredToken", // role credentials; the cache is dropped before the retry
]);
const transientStatus = (s: number) => s >= 500 || s === 429 || s === 408 || s === 409;

const codeOf = (xml: string) => /<Code>([^<]+)<\/Code>/.exec(xml)?.[1];
// MinIO writes a quote as `&#34;`, AWS as `&quot;`; both must read back as `"`
// (a part's ETag is handed back to the store verbatim to complete the upload).
const unxml = (s: string) =>
  s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
const unquote = (etag: string | null | undefined) => (etag ? etag.replace(/^W\//, "").replace(/^"|"$/g, "") : undefined);
const isTimeout = (signal?: AbortSignal) => signal?.aborted === true && (signal.reason as Error | undefined)?.name === "TimeoutError";

export function s3BlobStore(cfg: S3Config, given: Partial<S3BlobOptions> = {}): BlobStore & BlobSweeper & { checkBucket(signal?: AbortSignal): Promise<void> } {
  if (!cfg) throw new Error("the s3 blob store needs FOLDRUN_S3_ENDPOINT, FOLDRUN_S3_BUCKET and credentials");
  const o: S3BlobOptions = { ...s3OptionsFromEnv(), ...given };
  const requestDeadline = (bytes: number) => o.requestDeadlineMs + Math.ceil((bytes / o.minBytesPerSec) * 1000);

  /** One signed request with the failures of the network turned into
   *  BlobTransientError, so the retry wrapper above knows what to retry. */
  const send = async (
    what: string,
    method: Parameters<typeof s3Request>[1],
    key: string,
    body?: Buffer | S3StreamBody,
    extra: Record<string, string> = {},
    signal?: AbortSignal,
    query?: Record<string, string>,
    mime?: string,
  ): Promise<Response> => {
    try {
      return await s3Request(cfg, method, key, body, mime, extra, signal, query ? { query } : {});
    } catch (err) {
      // A source that fails while it is being sent surfaces from fetch as
      // "fetch failed" with the real error as its cause. It is not the
      // network's fault and a retry would read the same bytes.
      for (let e: unknown = err, i = 0; e && i < 4; e = (e as Error).cause, i++) if (e instanceof BlobSourceError) throw e;
      if (signal?.aborted && !isTimeout(signal)) throw err; // the caller cancelled
      const name = (err as Error)?.name;
      if (name === "AbortError" || name === "TimeoutError") throw new BlobTransientError(`s3 ${what}: timed out`);
      const cause = (err as { cause?: { code?: string; message?: string } }).cause;
      throw new BlobTransientError(`s3 ${what}: ${cause?.code ?? cause?.message ?? (err as Error)?.message ?? err}`);
    }
  };

  /** Read an error reply: transient or final, with the store's code in the message. */
  const failure = async (res: Response, what: string): Promise<Error> => {
    const text = (await res.text().catch(() => "")).slice(0, 400);
    const code = codeOf(text);
    const msg = `s3 ${what} failed: ${res.status}${code ? ` ${code}` : ""} ${unxml(/<Message>([^<]*)<\/Message>/.exec(text)?.[1] ?? "").slice(0, 160)}`.trim();
    if (code === "ExpiredToken") forgetS3Credentials();
    if (transientStatus(res.status) || (code && TRANSIENT_CODES.has(code))) return new BlobTransientError(msg, res.status, code);
    return new BlobStoreError(msg, res.status, code);
  };
  const drain = (res: Response) => res.arrayBuffer().catch(() => {});

  const headObject = async (key: string, signal?: AbortSignal): Promise<HeadResult | null> => {
    const res = await send("head", "HEAD", key, undefined, {}, signal);
    if (res.status === 404) {
      await drain(res);
      return null;
    }
    if (!res.ok) throw await failure(res, "head");
    await drain(res);
    const size = Number(res.headers.get("content-length"));
    const lm = res.headers.get("last-modified");
    const etag = unquote(res.headers.get("etag"));
    return { size: Number.isSafeInteger(size) && size >= 0 ? size : 0, ...(lm ? { modifiedAt: new Date(lm) } : {}), ...(etag ? { etag } : {}) };
  };

  // ---------- single request ----------

  const putOnce = async (key: string, body: Buffer | S3StreamBody, mime: string | undefined, signal: AbortSignal | undefined): Promise<PutResult> => {
    const res = await send("put", "PUT", key, body, { "if-none-match": "*" }, signal, undefined, mime);
    if (res.status === 412) {
      await drain(res);
      return { created: false, ...(unquote(res.headers.get("etag")) ? { etag: unquote(res.headers.get("etag")) } : {}) };
    }
    if (!res.ok) throw await failure(res, "put");
    await drain(res);
    return { created: true, ...(unquote(res.headers.get("etag")) ? { etag: unquote(res.headers.get("etag")) } : {}) };
  };

  // ---------- multipart ----------

  interface PartInfo {
    etag: string; // as the store returned it, quotes and all: complete wants it back verbatim
    size: number;
  }

  /** The upload to continue, if one is open for this exact key. */
  const findUpload = async (key: string, signal?: AbortSignal): Promise<string | null> => {
    let keyMarker = "";
    let uploadMarker = "";
    for (let page = 0; page < 20; page++) {
      const q: Record<string, string> = { uploads: "", prefix: key, "max-uploads": "1000" };
      if (keyMarker) q["key-marker"] = keyMarker;
      if (uploadMarker) q["upload-id-marker"] = uploadMarker;
      const res = await send("list uploads", "GET", "", undefined, {}, signal, q);
      if (!res.ok) throw await failure(res, "list uploads");
      const xml = await res.text();
      // The oldest open upload for the key: the one most likely to have parts.
      const mine = [...xml.matchAll(/<Upload>([\s\S]*?)<\/Upload>/g)]
        .map((m) => ({ key: unxml(/<Key>([^<]*)<\/Key>/.exec(m[1])?.[1] ?? ""), id: unxml(/<UploadId>([^<]*)<\/UploadId>/.exec(m[1])?.[1] ?? ""), at: Date.parse(/<Initiated>([^<]*)<\/Initiated>/.exec(m[1])?.[1] ?? "") || 0 }))
        .filter((u) => u.key === key && u.id)
        .sort((a, b) => a.at - b.at);
      if (mine.length) return mine[0].id;
      if (!/<IsTruncated>true<\/IsTruncated>/.test(xml)) return null;
      keyMarker = unxml(/<NextKeyMarker>([^<]*)<\/NextKeyMarker>/.exec(xml)?.[1] ?? "");
      uploadMarker = unxml(/<NextUploadIdMarker>([^<]*)<\/NextUploadIdMarker>/.exec(xml)?.[1] ?? "");
      if (!keyMarker && !uploadMarker) return null;
    }
    return null;
  };

  const listParts = async (key: string, uploadId: string, signal?: AbortSignal): Promise<Map<number, PartInfo> | null> => {
    const parts = new Map<number, PartInfo>();
    let marker = "";
    for (;;) {
      const q: Record<string, string> = { uploadId, "max-parts": "1000" };
      if (marker) q["part-number-marker"] = marker;
      const res = await send("list parts", "GET", key, undefined, {}, signal, q);
      if (res.status === 404) {
        await drain(res);
        return null; // NoSuchUpload: it was completed or aborted under us
      }
      if (!res.ok) throw await failure(res, "list parts");
      const xml = await res.text();
      for (const m of xml.matchAll(/<Part>([\s\S]*?)<\/Part>/g)) {
        const n = Number(/<PartNumber>(\d+)<\/PartNumber>/.exec(m[1])?.[1]);
        const size = Number(/<Size>(\d+)<\/Size>/.exec(m[1])?.[1]);
        const etag = unxml(/<ETag>([^<]*)<\/ETag>/.exec(m[1])?.[1] ?? "");
        if (n && etag) parts.set(n, { etag, size });
      }
      if (!/<IsTruncated>true<\/IsTruncated>/.test(xml)) return parts;
      marker = /<NextPartNumberMarker>(\d+)<\/NextPartNumberMarker>/.exec(xml)?.[1] ?? "";
      if (!marker) return parts;
    }
  };

  const abortUpload = async (key: string, uploadId: string): Promise<void> => {
    // A fresh signal: the one that got us here is probably already aborted.
    const res = await send("abort upload", "DELETE", key, undefined, {}, AbortSignal.timeout(10_000), { uploadId }).catch(() => null);
    if (res) await drain(res);
  };

  async function multipartPut(key: string, source: BlobSource, opts: PutSourceOptions): Promise<PutResult> {
    const { signal } = opts;
    // Already there: nothing to upload, and nothing to leave half-open.
    const there = await headObject(key, signal);
    if (there) return { created: false, ...(there.etag ? { etag: there.etag } : {}) };

    const partBytes = planPartBytes(source.size, o.partBytes);
    const count = Math.ceil(source.size / partBytes);
    const range = (n: number): [number, number] => [(n - 1) * partBytes, Math.min(n * partBytes, source.size)];

    let uploadId = await findUpload(key, signal);
    let have = uploadId ? await listParts(key, uploadId, signal) : null;
    if (!uploadId || !have) {
      const res = await send("create upload", "POST", key, undefined, {}, signal, { uploads: "" }, opts.contentType);
      if (!res.ok) throw await failure(res, "create upload");
      uploadId = unxml(/<UploadId>([^<]*)<\/UploadId>/.exec(await res.text())?.[1] ?? "");
      if (!uploadId) throw new BlobTransientError("s3 create upload: no upload id in the reply");
      have = new Map();
    }
    const id = uploadId;
    const done = new Map<number, string>(); // part number → ETag to complete with

    const inner = new AbortController();
    // The error that stopped the upload, not whichever worker's rejection
    // happens to sit first in the pool: the siblings it aborts reject with an
    // AbortError, which would hide a transient or final cause.
    let firstError: { err: unknown } | null = null;
    const both = signal ? AbortSignal.any([signal, inner.signal]) : inner.signal;
    let next = 1;
    const worker = async () => {
      while (!both.aborted) {
        const n = next++;
        if (n > count) return;
        const [start, end] = range(n);
        const len = end - start;
        // Hash first: the sha256 is signed into the request, the md5 is what a
        // part already in the store must match to be trusted.
        const h = await hashRange(source, start, end, both);
        const prior = have!.get(n);
        if (prior && prior.size === len && unquote(prior.etag) === h.md5) {
          done.set(n, prior.etag);
          continue;
        }
        const res = await send(
          `part ${n}/${count}`,
          "PUT",
          key,
          { stream: source.read(start, end, both), length: len, sha256: h.sha256 },
          {},
          AbortSignal.any([both, AbortSignal.timeout(requestDeadline(len))]),
          { partNumber: String(n), uploadId: id },
        );
        if (!res.ok) throw await failure(res, `part ${n}`);
        await drain(res);
        const etag = res.headers.get("etag");
        if (!etag) throw new BlobTransientError(`s3 part ${n}: no ETag in the reply`);
        done.set(n, etag);
      }
    };

    try {
      const pool = Array.from({ length: Math.min(o.partConcurrency, count) }, () =>
        worker().catch((err) => {
          firstError ??= { err };
          inner.abort(err); // stop the siblings
          throw err;
        }),
      );
      await Promise.allSettled(pool);
      if (firstError) throw (firstError as { err: unknown }).err;

      const xml =
        `<CompleteMultipartUpload>` +
        [...done.entries()]
          .sort((a, b) => a[0] - b[0])
          .map(([n, etag]) => `<Part><PartNumber>${n}</PartNumber><ETag>${etag.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</ETag></Part>`)
          .join("") +
        `</CompleteMultipartUpload>`;
      const res = await send("complete upload", "POST", key, Buffer.from(xml), { "if-none-match": "*" }, signal, { uploadId: id }, "application/xml");
      if (res.status === 412) {
        // Someone else's identical object won. Ours is not needed.
        await drain(res);
        await abortUpload(key, id);
        return { created: false, ...(unquote(res.headers.get("etag")) ? { etag: unquote(res.headers.get("etag")) } : {}) };
      }
      if (res.status === 404) {
        // NoSuchUpload: a twin of this call completed (or aborted) the same
        // upload. If the object is there, the work is done.
        await drain(res);
        const now = await headObject(key, signal);
        if (now) return { created: false, ...(now.etag ? { etag: now.etag } : {}) };
        throw new BlobTransientError("s3 complete upload: the upload vanished", 404, "NoSuchUpload");
      }
      if (!res.ok) throw await failure(res, "complete upload");
      // S3 can answer 200 and put the error in the body.
      const text = await res.text();
      if (/<Error>/.test(text)) {
        const code = codeOf(text);
        const msg = `s3 complete upload failed: 200 ${code ?? "error in body"}`;
        throw code && !TRANSIENT_CODES.has(code) && code !== "NoSuchUpload" ? new BlobStoreError(msg, 200, code) : new BlobTransientError(msg, 200, code);
      }
      return { created: true, ...(unquote(/<ETag>([^<]*)<\/ETag>/.exec(text)?.[1]) ? { etag: unquote(unxml(/<ETag>([^<]*)<\/ETag>/.exec(text)![1])) } : {}) };
    } catch (err) {
      // Cancelled by the caller, or a final failure: nothing will come back to
      // finish this, so do not leave parts for the store to bill. A transient
      // failure (including a deadline) leaves the upload for the retry.
      const cancelled = signal?.aborted === true && !isTimeout(signal);
      const final = !(err instanceof BlobTransientError);
      if (cancelled || final) await abortUpload(key, id);
      throw err;
    }
  }

  // ---------- the interface ----------

  return {
    kind: "s3",
    async putIfAbsent(key, body, opts: PutOptions = {}) {
      assertKey(key);
      return putOnce(key, Buffer.from(body), opts.contentType, opts.signal);
    },
    async putSourceIfAbsent(key, source, opts: PutSourceOptions = {}) {
      assertKey(key);
      if (source.size >= o.multipartThresholdBytes) return multipartPut(key, source, opts);
      const sha256 = opts.sha256 ?? (await hashRange(source, 0, source.size, opts.signal)).sha256;
      return putOnce(key, { stream: source.read(0, source.size, opts.signal), length: source.size, sha256 }, opts.contentType, opts.signal);
    },
    async get(key, opts = {}) {
      assertKey(key);
      const res = await send("get", "GET", key, undefined, opts.range ? { range: `bytes=${opts.range.start}-${opts.range.end}` } : {}, opts.signal);
      if (res.status === 404) {
        const text = await res.text().catch(() => "");
        // A GET carries the reason a HEAD cannot: the bucket may be the thing that is missing.
        if (codeOf(text) === "NoSuchBucket") throw new BlobStoreError(`s3 get failed: 404 NoSuchBucket (${cfg.bucket})`, 404, "NoSuchBucket");
        throw new BlobNotFound(key);
      }
      if (!res.ok || !res.body) throw await failure(res, "get");
      // A connection that drops mid-body is a retryable failure, not a TypeError.
      const reader = (res.body as ReadableStream<Uint8Array>).getReader();
      return new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            const { done, value } = await reader.read();
            if (done) controller.close();
            else controller.enqueue(value);
          } catch (err) {
            controller.error(new BlobTransientError(`s3 get ${key}: the body was cut off (${(err as { cause?: { code?: string } }).cause?.code ?? (err as Error).message})`));
          }
        },
        cancel: (reason) => reader.cancel(reason),
      });
    },
    async head(key, opts = {}) {
      assertKey(key);
      return headObject(key, opts.signal);
    },
    async delete(key, opts = {}) {
      assertKey(key);
      const res = await send("delete", "DELETE", key, undefined, {}, opts.signal);
      if (!res.ok && res.status !== 404) throw await failure(res, "delete");
      await drain(res);
    },
    async abortStaleUploads({ olderThanMs, prefix = "", signal }) {
      let n = 0;
      let keyMarker = "";
      let uploadMarker = "";
      for (;;) {
        const q: Record<string, string> = { uploads: "", "max-uploads": "1000", ...(prefix ? { prefix } : {}) };
        if (keyMarker) q["key-marker"] = keyMarker;
        if (uploadMarker) q["upload-id-marker"] = uploadMarker;
        const res = await send("list uploads", "GET", "", undefined, {}, signal, q);
        if (!res.ok) throw await failure(res, "list uploads");
        const xml = await res.text();
        for (const m of xml.matchAll(/<Upload>([\s\S]*?)<\/Upload>/g)) {
          const key = unxml(/<Key>([^<]*)<\/Key>/.exec(m[1])?.[1] ?? "");
          const id = unxml(/<UploadId>([^<]*)<\/UploadId>/.exec(m[1])?.[1] ?? "");
          const at = Date.parse(/<Initiated>([^<]*)<\/Initiated>/.exec(m[1])?.[1] ?? "");
          if (key && id && Number.isFinite(at) && Date.now() - at >= olderThanMs) {
            await abortUpload(key, id);
            n++;
          }
        }
        if (!/<IsTruncated>true<\/IsTruncated>/.test(xml)) return n;
        keyMarker = unxml(/<NextKeyMarker>([^<]*)<\/NextKeyMarker>/.exec(xml)?.[1] ?? "");
        uploadMarker = unxml(/<NextUploadIdMarker>([^<]*)<\/NextUploadIdMarker>/.exec(xml)?.[1] ?? "");
        if (!keyMarker && !uploadMarker) return n;
      }
    },
    async *list(prefix, opts = {}) {
      let token: string | undefined;
      do {
        const q: Record<string, string> = { "list-type": "2", prefix: prefix.endsWith("/") ? prefix : `${prefix}/`, ...(token ? { "continuation-token": token } : {}) };
        const res = await send("list", "GET", "", undefined, {}, opts.signal, q);
        if (!res.ok) throw await failure(res, "list");
        const xml = await res.text();
        for (const c of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
          const key = xmlText(c[1], "Key");
          const size = Number(xmlText(c[1], "Size"));
          const lm = xmlText(c[1], "LastModified");
          if (key) yield { key, size: Number.isFinite(size) ? size : 0, modifiedAt: lm ? new Date(lm) : new Date(0) };
        }
        token = /<IsTruncated>true<\/IsTruncated>/.test(xml) ? (xmlText(xml, "NextContinuationToken") ?? undefined) : undefined;
      } while (token);
    },
    async tenants(opts = {}) {
      const out: string[] = [];
      let token: string | undefined;
      do {
        const q: Record<string, string> = { "list-type": "2", prefix: "t/", delimiter: "/", ...(token ? { "continuation-token": token } : {}) };
        const res = await send("list", "GET", "", undefined, {}, opts.signal, q);
        if (!res.ok) throw await failure(res, "list");
        const xml = await res.text();
        for (const c of xml.matchAll(/<CommonPrefixes>\s*<Prefix>([^<]*)<\/Prefix>/g)) out.push(unxml(c[1]).replace(/^t\//, "").replace(/\/$/, ""));
        token = /<IsTruncated>true<\/IsTruncated>/.test(xml) ? (xmlText(xml, "NextContinuationToken") ?? undefined) : undefined;
      } while (token);
      return out;
    },
    /** Is the bucket there, and may we use it? A HEAD on a key cannot say. */
    async checkBucket(signal) {
      const res = await send("head bucket", "HEAD", "", undefined, {}, signal);
      if (res.ok) return void (await drain(res));
      await drain(res);
      if (res.status === 404) throw new BlobStoreError(`s3: bucket ${cfg.bucket} does not exist (or the endpoint is wrong)`, 404, "NoSuchBucket");
      throw await failure(res, "head bucket");
    },
  };
}

function xmlText(xml: string, tag: string): string | null {
  const m = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(xml);
  return m ? unxml(m[1]) : null;
}

export { bufferSource };
