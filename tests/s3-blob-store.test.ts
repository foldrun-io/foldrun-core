// The s3 BlobStore driver against a REAL S3-compatible server (MinIO on
// loopback), with a fault-injecting proxy in front where a test needs a
// failure a healthy server will not produce.
//
//   FOLDRUN_TEST_S3_URL=http://127.0.0.1:19000 \
//   FOLDRUN_TEST_S3_ACCESS_KEY=… FOLDRUN_TEST_S3_SECRET_KEY=… \
//   node --test tests/s3-blob-store.test.ts
//
// Without FOLDRUN_TEST_S3_URL every case here is skipped (CI has no S3).
// Multipart parts are 5 MiB — the smallest S3, R2 and MinIO accept — so the
// "large" files below are 12–40 MiB, not gigabytes.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  s3BlobStore,
  bounded,
  fsBlobStore,
  downloadToFile,
  readAll,
  fileSource,
  bufferSource,
  BlobNotFound,
  BlobSourceError,
  BlobStoreError,
  BlobTransientError,
  type BlobSource,
} from "../src/blob-store.ts";
import { planPartBytes, MAX_PARTS, MIN_PART_BYTES } from "../src/s3-blob-store.ts";
import { s3Request, type S3Config } from "../src/storage.ts";
import { realS3, openUploads } from "./s3-test-server.ts";
import { s3Proxy, type S3Proxy } from "./s3-proxy.ts";

const real = realS3();
const skip = real ? false : "no FOLDRUN_TEST_S3_URL";
const MiB = 1024 * 1024;

const dirs: string[] = [];
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-s3-"));
  dirs.push(d);
  return d;
};
after(() => dirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

const sha = (b: Uint8Array | string) => crypto.createHash("sha256").update(b).digest("hex");
const md5 = (b: Uint8Array | string) => crypto.createHash("md5").update(b).digest("hex");
const blobKey = (n: string | Uint8Array) => `t/default/blobs/${sha(n)}`;

/** A bucket, a fault proxy in front of it, and the pieces to build stores. */
async function rig() {
  const b = await real!.newBucket();
  const proxy = await s3Proxy(real!.endpoint);
  const viaProxy: S3Config = { ...b.cfg, endpoint: proxy.endpoint };
  return {
    cfg: b.cfg,
    viaProxy,
    proxy,
    /** Fast backoff, small parts. */
    store: (opts: Parameters<typeof s3BlobStore>[1] = {}, limits: Parameters<typeof bounded>[1] = {}) =>
      bounded(s3BlobStore(viaProxy, { multipartThresholdBytes: 6 * MiB, partBytes: MIN_PART_BYTES, partConcurrency: 3, ...opts }), { backoffMs: 2, ...limits }),
    raw: (opts: Parameters<typeof s3BlobStore>[1] = {}) => s3BlobStore(viaProxy, { multipartThresholdBytes: 6 * MiB, partBytes: MIN_PART_BYTES, partConcurrency: 3, ...opts }),
    async done() {
      await proxy.close();
      await b.drop();
    },
  };
}

/** A random file of `bytes`, written in chunks; returns its path and sha256. */
function randomFile(bytes: number): { file: string; sha256: string; size: number } {
  const file = path.join(tmp(), "big.bin");
  const fd = fs.openSync(file, "w");
  const h = crypto.createHash("sha256");
  for (let left = bytes; left > 0; ) {
    const c = crypto.randomBytes(Math.min(left, MiB));
    fs.writeSync(fd, c);
    h.update(c);
    left -= c.length;
  }
  fs.closeSync(fd);
  return { file, sha256: h.digest("hex"), size: bytes };
}

const partPuts = (p: S3Proxy) => p.seen.filter((r) => r.method === "PUT" && r.query.has("partNumber"));
const isPart = (n?: number) => (r: { method: string; query: URLSearchParams }) => r.method === "PUT" && r.query.has("partNumber") && (n === undefined || r.query.get("partNumber") === String(n));
const sha256OfFile = (f: string) => crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex");

// ---------- plain behaviour a fake does not show ----------

test("conditional put: 412 says 'already there' and hands back the existing ETag, which is the content's md5", { skip }, async () => {
  const r = await rig();
  try {
    const body = Buffer.from("hello real s3");
    const key = blobKey(body);
    const first = await r.store().putIfAbsent(key, body);
    assert.deepEqual(first, { created: true, etag: md5(body) });
    const again = await r.store().putIfAbsent(key, body);
    assert.deepEqual(again, { created: false, etag: md5(body) });
    // A caller that cares whether the bytes there are *its* bytes can now tell, without a GET.
    const other = await r.store().putIfAbsent(key, Buffer.from("not the same"));
    assert.equal(other.created, false);
    assert.equal(other.etag, md5(body), "the existing object's ETag, not the rejected body's");
    const head = await r.store().head(key);
    assert.equal(head?.etag, md5(body));
    assert.equal(head?.size, body.length);
    assert.ok(head?.modifiedAt instanceof Date);
  } finally {
    await r.done();
  }
});

test("conditional put: 30 racing writers of a 2 MB object — exactly one creates, nobody errors", { skip }, async () => {
  const r = await rig();
  try {
    const body = crypto.randomBytes(2_000_000);
    const key = blobKey(body);
    const store = r.store({}, { concurrency: 30 });
    const results = await Promise.all(Array.from({ length: 30 }, () => store.putIfAbsent(key, body)));
    assert.equal(results.filter((x) => x.created).length, 1);
    assert.deepEqual((await readAll(store, key)).length, body.length);
  } finally {
    await r.done();
  }
});

test("a 409 ConditionalRequestConflict is retried and then reads as 'already there'", { skip }, async () => {
  const r = await rig();
  try {
    const body = Buffer.from("conflict me");
    const key = blobKey(body);
    await r.store().putIfAbsent(key, body);
    r.proxy.add({ when: (s) => s.method === "PUT", fault: { status: 409, body: "<Error><Code>ConditionalRequestConflict</Code><Message>x</Message></Error>" }, times: 2 });
    r.proxy.reset();
    const res = await r.store().putIfAbsent(key, body);
    assert.equal(res.created, false);
    assert.equal(r.proxy.seen.filter((s) => s.method === "PUT").length, 3, "two 409s, then the real 412");
  } finally {
    await r.done();
  }
});

test("errors are read for their S3 code: a missing bucket is final and named; a HEAD cannot say, checkBucket can", { skip }, async () => {
  const r = await rig();
  try {
    const gone = s3BlobStore({ ...r.cfg, bucket: "fr-test-no-such-bucket" });
    assert.equal(await gone.head(blobKey("x")), null, "HEAD: a missing bucket looks like a missing key — that is the trap");
    await assert.rejects(() => gone.checkBucket(), (e: unknown) => e instanceof BlobStoreError && e.code === "NoSuchBucket");
    await assert.rejects(() => gone.get(blobKey("x")), (e: unknown) => e instanceof BlobStoreError && e.code === "NoSuchBucket", "GET carries the reason");
    await assert.rejects(() => gone.putIfAbsent(blobKey("x"), Buffer.from("x")), (e: unknown) => e instanceof BlobStoreError && e.code === "NoSuchBucket");
    await r.store().checkBucket?.call(r.raw()); // the real one is fine
    await r.raw().checkBucket();
    // a key that is not there is BlobNotFound on get, null on head
    await assert.rejects(() => r.raw().get(blobKey("nothing")), BlobNotFound);
  } finally {
    await r.done();
  }
});

test("wrong credentials: 403 is final — one request, a named error, no retry", { skip }, async () => {
  const r = await rig();
  try {
    r.proxy.reset();
    const bad = bounded(s3BlobStore({ ...r.viaProxy, secretAccessKey: "definitely-wrong" }), { retries: 3, backoffMs: 1 });
    await assert.rejects(() => bad.putIfAbsent(blobKey("z"), Buffer.from("z")), (e: unknown) => e instanceof BlobStoreError && e.status === 403 && /SignatureDoesNotMatch|AccessDenied/.test(e.code ?? ""));
    assert.equal(r.proxy.seen.length, 1);
  } finally {
    await r.done();
  }
});

// ---------- retries, deadlines, concurrency — against the real server ----------

test("retries: 503, a 400 RequestTimeout, BadDigest, ExpiredToken and a reset connection are all retried, and the put lands once", { skip }, async () => {
  const r = await rig();
  try {
    const cases: [string, () => void][] = [
      ["503", () => r.proxy.add({ when: (s) => s.method === "PUT", fault: { status: 503 }, times: 2 })],
      ["RequestTimeout", () => r.proxy.add({ when: (s) => s.method === "PUT", fault: { status: 400, body: "<Error><Code>RequestTimeout</Code><Message>x</Message></Error>" } })],
      ["BadDigest", () => r.proxy.add({ when: (s) => s.method === "PUT", fault: { status: 400, body: "<Error><Code>BadDigest</Code><Message>x</Message></Error>" } })],
      ["ExpiredToken", () => r.proxy.add({ when: (s) => s.method === "PUT", fault: { status: 400, body: "<Error><Code>ExpiredToken</Code><Message>x</Message></Error>" } })],
      ["SlowDown", () => r.proxy.add({ when: (s) => s.method === "PUT", fault: { status: 503, body: "<Error><Code>SlowDown</Code><Message>x</Message></Error>" } })],
      ["reset", () => r.proxy.add({ when: (s) => s.method === "PUT", fault: { reset: true }, times: 2 })],
    ];
    for (const [name, arm] of cases) {
      const body = Buffer.from(`retry ${name}`);
      r.proxy.clearRules();
      arm();
      r.proxy.reset();
      const res = await r.store().putIfAbsent(blobKey(body), body);
      assert.equal(res.created, true, name);
      assert.ok(r.proxy.seen.filter((s) => s.method === "PUT").length >= 2, `${name}: it was retried`);
      assert.equal((await readAll(r.store(), blobKey(body))).toString(), body.toString(), name);
    }
  } finally {
    await r.done();
  }
});

test("retries: the budget is a budget — after exactly 1+retries tries it fails, transient", { skip }, async () => {
  const r = await rig();
  try {
    r.proxy.add({ when: () => true, fault: { status: 500 }, times: 100 });
    r.proxy.reset();
    await assert.rejects(() => r.store({}, { retries: 2 }).head(blobKey("a")), BlobTransientError);
    assert.equal(r.proxy.seen.length, 3);
  } finally {
    await r.done();
  }
});

test("deadline: a store that does not answer is cut off; and an upload's deadline grows with its size", { skip }, async () => {
  const r = await rig();
  try {
    r.proxy.add({ when: () => true, fault: { delayMs: 600 }, times: 100 });
    const tight = r.store({}, { deadlineMs: 100, retries: 0, minBytesPerSec: 1 * MiB });
    const t0 = Date.now();
    await assert.rejects(() => tight.head(blobKey("slow")), BlobTransientError);
    assert.ok(Date.now() - t0 < 500, "gave up before the server answered");
    // 4 MiB at 1 MiB/s earns 4 s on top of 100 ms: a 600 ms answer is fine for it…
    const big = crypto.randomBytes(4 * MiB);
    assert.equal((await tight.putIfAbsent(blobKey(big), big)).created, true);
    // …and the same server delay is fatal for a tiny put with the same base deadline.
    await assert.rejects(() => tight.putIfAbsent(blobKey("tiny"), Buffer.from("tiny")), BlobTransientError);
  } finally {
    await r.done();
  }
});

test("concurrency: the cap holds at the SERVER, not just in the wrapper", { skip }, async () => {
  const r = await rig();
  try {
    const store = r.store({}, { concurrency: 3 });
    r.proxy.add({ when: () => true, fault: { delayMs: 40 }, times: 1000 });
    r.proxy.reset();
    await Promise.all(Array.from({ length: 24 }, (_, i) => store.head(blobKey(`k${i}`))));
    assert.equal(r.proxy.seen.length, 24);
    assert.ok(r.proxy.peakInFlight <= 3, `peak in flight at the server was ${r.proxy.peakInFlight}`);
    assert.ok(r.proxy.peakInFlight >= 2, "and it did run in parallel");
  } finally {
    await r.done();
  }
});

// ---------- reading ----------

test("a body cut off mid-download is a transient error, not a TypeError; downloadToFile resumes with a Range and verifies the hash", { skip }, async () => {
  const r = await rig();
  try {
    const f = randomFile(3 * MiB);
    const key = `t/default/blobs/${f.sha256}`;
    await r.store().putSourceIfAbsent(key, fileSource(f.file), { sha256: f.sha256 });
    r.proxy.add({ when: (s) => s.method === "GET" && !s.query.size, fault: { truncateResponseAt: 700_000 } });
    await assert.rejects(async () => readAll(r.store(), key), (e: unknown) => e instanceof BlobTransientError && /cut off/.test((e as Error).message));

    // two cuts in a row, then it lets the rest through: three requests, the later ones ranged
    r.proxy.clearRules();
    r.proxy.add({ when: (s) => s.method === "GET", fault: { truncateResponseAt: 900_000 }, times: 2 });
    r.proxy.reset();
    const dest = path.join(tmp(), "out", "file.bin");
    const { size } = await downloadToFile(r.store(), key, dest, { sha256: f.sha256 });
    assert.equal(size, f.size);
    assert.equal(sha256OfFile(dest), f.sha256);
    assert.equal(fs.existsSync(`${dest}.part`), false);
    const gets = r.proxy.seen.filter((s) => s.method === "GET");
    assert.equal(gets.length, 3);
    assert.ok(gets.slice(1).every((g) => /^bytes=\d+-\d+$/.test(String(g.headers.range))), "resumed with Range, not from byte 0");

    // a leftover .part from a dead process is continued, and a wrong hash is discarded
    const dest2 = path.join(tmp(), "resume.bin");
    fs.writeFileSync(`${dest2}.part`, fs.readFileSync(f.file).subarray(0, 1_000_000));
    r.proxy.reset();
    await downloadToFile(r.store(), key, dest2, { sha256: f.sha256 });
    assert.equal(sha256OfFile(dest2), f.sha256);
    assert.match(String(r.proxy.seen.find((s) => s.method === "GET")?.headers.range), /^bytes=1000000-/);
    const dest3 = path.join(tmp(), "bad.bin");
    await assert.rejects(() => downloadToFile(r.store(), key, dest3, { sha256: "0".repeat(64) }), BlobSourceError);
    assert.equal(fs.existsSync(dest3), false);
    assert.equal(fs.existsSync(`${dest3}.part`), false);
  } finally {
    await r.done();
  }
});

// ---------- streaming upload ----------

test("streaming put: a file goes up as a stream under 6 MiB; the server verifies the hash we signed", { skip }, async () => {
  const r = await rig();
  try {
    const f = randomFile(4 * MiB + 123);
    const key = `t/default/blobs/${f.sha256}`;
    r.proxy.reset();
    const res = await r.store().putSourceIfAbsent(key, fileSource(f.file), { sha256: f.sha256 });
    assert.equal(res.created, true);
    assert.equal(res.etag, md5(fs.readFileSync(f.file)), "a single-request ETag is the md5");
    assert.equal(r.proxy.seen.filter((s) => s.method === "PUT").length, 1, "one PUT, no multipart");
    assert.equal(r.proxy.seen.filter((s) => s.query.has("uploads")).length, 0);
    const dest = path.join(tmp(), "d.bin");
    await downloadToFile(r.store(), key, dest, { sha256: f.sha256 });
    // no hash given: it is computed first, from the source
    const g = randomFile(MiB);
    assert.equal((await r.store().putSourceIfAbsent(`t/default/blobs/${g.sha256}`, fileSource(g.file))).created, true);
    // a buffer is a source too; the empty object is fine
    assert.equal((await r.store().putSourceIfAbsent(blobKey(""), bufferSource(Buffer.alloc(0)))).created, true);
    assert.equal((await r.store().head(blobKey("")))?.size, 0);
  } finally {
    await r.done();
  }
});

test("streaming put: bytes that do not hash to what was announced are refused by the server; a file that shrinks mid-upload is a source error; neither leaves an object", { skip }, async () => {
  const r = await rig();
  try {
    const f = randomFile(2 * MiB);
    const key = `t/default/blobs/${f.sha256}`;
    await assert.rejects(() => r.store({}, { retries: 1 }).putSourceIfAbsent(key, fileSource(f.file), { sha256: "a".repeat(64) }), BlobTransientError);
    assert.equal(await r.store().head(key), null, "the server did not keep a body that failed its hash");

    const src = fileSource(f.file);
    fs.truncateSync(f.file, MiB); // the file shrinks after its size was taken
    await assert.rejects(() => r.store({}, { retries: 3 }).putSourceIfAbsent(key, src, { sha256: f.sha256 }), BlobSourceError);
    assert.equal(await r.store().head(key), null);
  } finally {
    await r.done();
  }
});

// ---------- multipart ----------

test("multipart: a 24 MiB file goes up in parts, completes with a conditional put, and reads back byte for byte", { skip }, async () => {
  const r = await rig();
  try {
    const f = randomFile(24 * MiB + 7);
    const key = `t/default/blobs/${f.sha256}`;
    r.proxy.reset();
    const res = await r.store().putSourceIfAbsent(key, fileSource(f.file), { sha256: f.sha256 });
    assert.equal(res.created, true);
    assert.match(res.etag ?? "", /-5$/, "a multipart ETag is <hash>-<parts>: 5 parts of 5 MiB");
    assert.equal(partPuts(r.proxy).length, 5);
    const complete = r.proxy.seen.find((s) => s.method === "POST" && s.query.has("uploadId"));
    assert.equal(complete?.headers["if-none-match"], "*");
    assert.equal((await r.store().head(key))?.size, f.size);
    assert.deepEqual(await openUploads(r.cfg), [], "nothing left open");
    const dest = path.join(tmp(), "mp.bin");
    await downloadToFile(r.store(), key, dest, { sha256: f.sha256 });

    // already there: no upload is even started
    r.proxy.reset();
    const again = await r.store().putSourceIfAbsent(key, fileSource(f.file), { sha256: f.sha256 });
    assert.equal(again.created, false);
    assert.equal(r.proxy.seen.filter((s) => s.method === "POST").length, 0);
    assert.equal(partPuts(r.proxy).length, 0);
  } finally {
    await r.done();
  }
});

test("multipart: the parts go up concurrently but never beyond the part cap; threshold and part size are configurable", { skip }, async () => {
  const r = await rig();
  try {
    const f = randomFile(32 * MiB);
    r.proxy.add({ when: isPart(), fault: { delayMs: 80 }, times: 100 });
    r.proxy.reset();
    await r.store({ partConcurrency: 4 }).putSourceIfAbsent(`t/default/blobs/${f.sha256}`, fileSource(f.file), { sha256: f.sha256 });
    assert.equal(partPuts(r.proxy).length, 7);
    assert.ok(r.proxy.peakInFlight >= 2 && r.proxy.peakInFlight <= 4, `peak ${r.proxy.peakInFlight}`);

    // threshold above the size: one request. Part size 8 MiB: 4 parts of 32.
    const g = randomFile(12 * MiB);
    r.proxy.clearRules();
    r.proxy.reset();
    await r.store({ multipartThresholdBytes: 64 * MiB }).putSourceIfAbsent(`t/default/blobs/${g.sha256}`, fileSource(g.file), { sha256: g.sha256 });
    assert.equal(partPuts(r.proxy).length, 0);
    const h = randomFile(32 * MiB);
    r.proxy.reset();
    await r.store({ partBytes: 8 * MiB }).putSourceIfAbsent(`t/default/blobs/${h.sha256}`, fileSource(h.file), { sha256: h.sha256 });
    assert.equal(partPuts(r.proxy).length, 4);
  } finally {
    await r.done();
  }
});

test("multipart: part sizing — never under 5 MiB, raised to keep an object under 10,000 parts", () => {
  assert.equal(planPartBytes(100 * MiB, 1 * MiB), MIN_PART_BYTES);
  assert.equal(planPartBytes(100 * MiB, 16 * MiB), 16 * MiB);
  const huge = 200 * 1024 * MiB; // 200 GiB at 16 MiB would be 12,800 parts
  const p = planPartBytes(huge, 16 * MiB);
  assert.ok(Math.ceil(huge / p) <= MAX_PARTS && p % MiB === 0);
});

test("multipart: two writers of the same blob at once — one object, both told the truth, nothing left open", { skip }, async () => {
  const r = await rig();
  try {
    const f = randomFile(16 * MiB);
    const key = `t/default/blobs/${f.sha256}`;
    const [a, b] = await Promise.all([r.store().putSourceIfAbsent(key, fileSource(f.file), { sha256: f.sha256 }), r.store().putSourceIfAbsent(key, fileSource(f.file), { sha256: f.sha256 })]);
    assert.ok(a.created || b.created, "at least one created it");
    const dest = path.join(tmp(), "twin.bin");
    await downloadToFile(r.store(), key, dest, { sha256: f.sha256 });
    assert.deepEqual(await openUploads(r.cfg), []);
  } finally {
    await r.done();
  }
});

test("interrupted multipart: a caller who cancels mid-upload leaves nothing behind", { skip }, async () => {
  const r = await rig();
  try {
    const f = randomFile(24 * MiB);
    const key = `t/default/blobs/${f.sha256}`;
    const ctl = new AbortController();
    // the third part hangs; we cancel while it does
    r.proxy.add({ when: isPart(3), fault: { delayMs: 5_000 } });
    const going = r.store().putSourceIfAbsent(key, fileSource(f.file), { sha256: f.sha256, signal: ctl.signal });
    for (let i = 0; i < 100 && !r.proxy.seen.some(isPart(3)); i++) await new Promise((x) => setTimeout(x, 20));
    assert.ok(r.proxy.seen.some(isPart(3)), "got as far as part 3");
    assert.equal((await openUploads(r.cfg)).length, 1, "an upload is open while it runs");
    ctl.abort();
    await assert.rejects(() => going);
    assert.deepEqual(await openUploads(r.cfg), [], "cancelled: the upload was aborted, no parts left to bill");
    assert.equal(await r.store().head(key), null);
  } finally {
    await r.done();
  }
});

test("interrupted multipart: a final failure (403 on a part) aborts the upload; a transient one leaves it for the resume, and abortStaleUploads sweeps it", { skip }, async () => {
  const r = await rig();
  try {
    const f = randomFile(24 * MiB);
    const key = `t/default/blobs/${f.sha256}`;
    r.proxy.add({ when: isPart(2), fault: { status: 403, body: "<Error><Code>AccessDenied</Code><Message>no</Message></Error>" } });
    await assert.rejects(() => r.store({}, { retries: 3 }).putSourceIfAbsent(key, fileSource(f.file), { sha256: f.sha256 }), (e: unknown) => e instanceof BlobStoreError && e.status === 403);
    assert.deepEqual(await openUploads(r.cfg), [], "final failure: cleaned up");

    r.proxy.clearRules();
    r.proxy.add({ when: isPart(4), fault: { status: 503 }, times: 1000 });
    await assert.rejects(() => r.store({}, { retries: 1 }).putSourceIfAbsent(key, fileSource(f.file), { sha256: f.sha256 }), BlobTransientError);
    assert.equal((await openUploads(r.cfg)).length, 1, "transient failure: left open, on purpose — the retry resumes it");

    assert.equal(await r.raw().abortStaleUploads({ olderThanMs: 60 * 60_000 }), 0, "a fresh upload is not stale");
    assert.equal(await r.raw().abortStaleUploads({ olderThanMs: 0 }), 1);
    assert.deepEqual(await openUploads(r.cfg), []);
  } finally {
    await r.done();
  }
});

test("resumed multipart: a retry after a failure sends only the parts that are missing — and re-sends a part whose bytes are wrong", { skip }, async () => {
  const r = await rig();
  try {
    const f = randomFile(24 * MiB + 1); // 5 parts: 4 × 5 MiB + a tail
    const key = `t/default/blobs/${f.sha256}`;
    const data = fs.readFileSync(f.file);

    // First attempt: parts 1-3 land (concurrency 1 keeps the order), part 4 fails for good.
    r.proxy.add({ when: isPart(4), fault: { status: 503 }, times: 1000 });
    await assert.rejects(() => r.store({ partConcurrency: 1 }, { retries: 0 }).putSourceIfAbsent(key, fileSource(f.file), { sha256: f.sha256 }), BlobTransientError);
    const [open] = await openUploads(r.cfg);
    assert.ok(open);

    // Meanwhile a part of that upload is corrupted (same number, other bytes) — a stale or damaged part must not be trusted.
    const bad = crypto.randomBytes(5 * MiB);
    const res = await s3Request(r.cfg, "PUT", key, bad, undefined, {}, undefined, { query: { partNumber: "2", uploadId: open.uploadId } });
    assert.ok(res.ok);
    await res.arrayBuffer();

    // The retry — a different store instance, as if another pod — picks the upload up.
    r.proxy.clearRules();
    r.proxy.reset();
    const done = await r.store({ partConcurrency: 1 }).putSourceIfAbsent(key, fileSource(f.file), { sha256: f.sha256 });
    assert.equal(done.created, true);
    const sent = partPuts(r.proxy).map((s) => Number(s.query.get("partNumber"))).sort();
    assert.deepEqual(sent, [2, 4, 5], "parts 1 and 3 were reused; 2 (damaged), 4 and 5 were sent");
    assert.equal(r.proxy.seen.filter((s) => s.method === "POST" && s.query.has("uploads")).length, 0, "no new upload was started");
    assert.deepEqual(await openUploads(r.cfg), []);
    const dest = path.join(tmp(), "resumed.bin");
    await downloadToFile(r.store(), key, dest, { sha256: f.sha256 });
    assert.equal(fs.readFileSync(dest).equals(data), true);
  } finally {
    await r.done();
  }
});

test("resumed multipart: inside one call, a part that fails once is retried by resuming — not by starting over", { skip }, async () => {
  const r = await rig();
  try {
    const f = randomFile(21 * MiB);
    const key = `t/default/blobs/${f.sha256}`;
    r.proxy.add({ when: isPart(3), fault: { reset: true } }); // connection dies mid part 3, once
    r.proxy.reset();
    const res = await r.store({ partConcurrency: 1 }, { retries: 3 }).putSourceIfAbsent(key, fileSource(f.file), { sha256: f.sha256 });
    assert.equal(res.created, true);
    const nums = partPuts(r.proxy).map((s) => Number(s.query.get("partNumber")));
    assert.equal(nums.filter((n) => n === 1).length, 1, "part 1 was not sent again");
    assert.equal(nums.filter((n) => n === 3).length, 2, "part 3 was tried twice");
    assert.equal(r.proxy.seen.filter((s) => s.method === "POST" && s.query.has("uploads")).length, 1, "one upload throughout");
    await downloadToFile(r.store(), key, path.join(tmp(), "x.bin"), { sha256: f.sha256 });
  } finally {
    await r.done();
  }
});

test("multipart: a source that changes between the hash and the send is caught by the server (part hash) and aborts the upload", { skip }, async () => {
  const r = await rig();
  try {
    const f = randomFile(12 * MiB);
    const real = fileSource(f.file);
    let reads = 0;
    const flaky: BlobSource = {
      size: real.size,
      read: (s, e, sig) => {
        // the first read of each range is the hash pass; the second is the send — flip a byte in the second
        const second = ++reads % 2 === 0;
        return (async function* () {
          let first = true;
          for await (const c of real.read(s, e, sig)) {
            if (second && first) {
              const copy = Buffer.from(c);
              copy[0] ^= 0xff;
              first = false;
              yield copy;
            } else yield c;
          }
        })();
      },
    };
    await assert.rejects(() => r.store({ partConcurrency: 1 }, { retries: 0 }).putSourceIfAbsent(`t/default/blobs/${f.sha256}`, flaky, { sha256: f.sha256 }));
    assert.equal(await r.store().head(`t/default/blobs/${f.sha256}`), null, "a damaged upload never becomes the object");
  } finally {
    await r.done();
  }
});

/** Flip one byte of a file in place, keeping its size: the change a size check cannot see. */
const flipByte = (file: string, at: number) => {
  const fd = fs.openSync(file, "r+");
  const b = Buffer.alloc(1);
  fs.readSync(fd, b, 0, 1, at);
  b[0] ^= 0xff;
  fs.writeSync(fd, b, 0, 1, at);
  fs.closeSync(fd);
};

test("multipart: a file that changed after the caller hashed it is refused — the whole object is checked against the sha256, not just each part", { skip }, async () => {
  const r = await rig();
  try {
    const f = randomFile(17 * MiB); // 4 parts
    const key = `t/default/blobs/${f.sha256}`;
    flipByte(f.file, 7 * MiB); // in part 2; every part is still self-consistent
    await assert.rejects(() => r.store({}, { retries: 3 }).putSourceIfAbsent(key, fileSource(f.file), { sha256: f.sha256 }), BlobSourceError);
    assert.equal(await r.store().head(key), null, "nothing is stored under the old content address");
    assert.deepEqual(await openUploads(r.cfg), [], "and the upload was aborted, not left open");
    // without a sha256 there is nothing to hold it to, and it goes up as it is
    assert.equal((await r.store().putSourceIfAbsent(`t/default/blobs/${sha256OfFile(f.file)}`, fileSource(f.file))).created, true);
  } finally {
    await r.done();
  }
});

test("resumed multipart: the whole-object check covers the parts reused from the first attempt", { skip }, async () => {
  const r = await rig();
  try {
    const f = randomFile(24 * MiB + 1); // 5 parts
    const key = `t/default/blobs/${f.sha256}`;
    // Parts 1-3 land, part 4 fails for good: the upload stays open for a resume.
    r.proxy.add({ when: isPart(4), fault: { status: 503 }, times: 1000 });
    await assert.rejects(() => r.store({ partConcurrency: 1 }, { retries: 0 }).putSourceIfAbsent(key, fileSource(f.file), { sha256: f.sha256 }), BlobTransientError);
    assert.equal((await openUploads(r.cfg)).length, 1);
    r.proxy.clearRules();

    // The file changes in part 5 (not yet sent) before the retry: parts 1-3 are
    // reused, 4 and 5 go up as they now are, and the result is refused.
    flipByte(f.file, 24 * MiB);
    r.proxy.reset();
    await assert.rejects(() => r.store({ partConcurrency: 1 }, { retries: 0 }).putSourceIfAbsent(key, fileSource(f.file), { sha256: f.sha256 }), BlobSourceError);
    assert.deepEqual(partPuts(r.proxy).map((s) => Number(s.query.get("partNumber"))).sort(), [4, 5], "parts 1-3 were reused, not re-sent");
    assert.equal(await r.store().head(key), null);
    assert.deepEqual(await openUploads(r.cfg), []);

    // Put back, the same resume shape completes: the reused parts' bytes are in the hash.
    flipByte(f.file, 24 * MiB);
    r.proxy.add({ when: isPart(4), fault: { status: 503 }, times: 1000 });
    await assert.rejects(() => r.store({ partConcurrency: 2 }, { retries: 0 }).putSourceIfAbsent(key, fileSource(f.file), { sha256: f.sha256 }), BlobTransientError);
    r.proxy.clearRules();
    r.proxy.reset();
    assert.equal((await r.store({ partConcurrency: 3 }).putSourceIfAbsent(key, fileSource(f.file), { sha256: f.sha256 })).created, true);
    assert.ok(partPuts(r.proxy).length < 5, "it resumed rather than starting over");
    await downloadToFile(r.store(), key, path.join(tmp(), "ok.bin"), { sha256: f.sha256 });
  } finally {
    await r.done();
  }
});

test("deadlines: the driver bounds every request of a streamed put — the single PUT and the multipart HEAD, list, create and complete", { skip }, async () => {
  const r = await rig();
  try {
    // bounded() gives a streamed put no deadline of its own; these are the driver's.
    const store = () => r.store({ requestDeadlineMs: 300, minBytesPerSec: 50 * MiB }, { retries: 0 });
    const slow = 4000;
    const small = randomFile(64 * 1024);
    const big = randomFile(12 * MiB);
    const cases: [string, (s: { method: string; query: URLSearchParams }) => boolean, { file: string; sha256: string }][] = [
      ["single PUT", (s) => s.method === "PUT", small],
      ["HEAD", (s) => s.method === "HEAD", big],
      ["list uploads", (s) => s.method === "GET" && s.query.has("uploads"), big],
      ["create upload", (s) => s.method === "POST" && s.query.has("uploads"), big],
      ["complete", (s) => s.method === "POST" && s.query.has("uploadId"), big],
    ];
    for (const [name, when, f] of cases) {
      r.proxy.clearRules();
      r.proxy.add({ when, fault: { delayMs: slow } });
      const t0 = Date.now();
      await assert.rejects(
        () => store().putSourceIfAbsent(`t/default/blobs/${f.sha256}`, fileSource(f.file), { sha256: f.sha256 }),
        (e: unknown) => e instanceof BlobTransientError && /no answer within \d+ms/.test((e as Error).message),
        name,
      );
      assert.ok(Date.now() - t0 < slow - 1000, `${name}: gave up at ${Date.now() - t0}ms, before the server answered`);
    }
    // The caller's signal still counts beside the deadline.
    r.proxy.clearRules();
    r.proxy.add({ when: (s) => s.method === "PUT", fault: { delayMs: slow } });
    const ctl = new AbortController();
    setTimeout(() => ctl.abort(new Error("caller gave up")), 50);
    await assert.rejects(() => r.store({ requestDeadlineMs: 10_000 }, { retries: 0 }).putSourceIfAbsent(`t/default/blobs/${small.sha256}`, fileSource(small.file), { sha256: small.sha256, signal: ctl.signal }), /caller gave up/);
    // A healthy server is not cut off by them. (A fresh file: the proxy still
    // forwards the delayed requests above once their delay is over.)
    r.proxy.clearRules();
    const fresh = randomFile(12 * MiB);
    assert.equal((await store().putSourceIfAbsent(`t/default/blobs/${fresh.sha256}`, fileSource(fresh.file), { sha256: fresh.sha256 })).created, true);
  } finally {
    await r.done();
  }
});

test("deadlines: one longer than Node's longest timer is held at that, not fired at once", { skip }, async () => {
  const r = await rig();
  try {
    // At 1 byte a second a 5 MiB part earns ~5.2e9 ms and the complete of 12 MiB
    // ~1.3e10 — past 2^31-1, where a timer fires after 1 ms (as a multi-TiB
    // object would at the default throughput).
    const f = randomFile(12 * MiB);
    const res = await r.store({ minBytesPerSec: 1 }, { retries: 0 }).putSourceIfAbsent(`t/default/blobs/${f.sha256}`, fileSource(f.file), { sha256: f.sha256 });
    assert.equal(res.created, true);
  } finally {
    await r.done();
  }
});

// ---------- fs driver, same streaming surface (runs everywhere) ----------

test("fs driver: streamed put, hash check, stale temp sweep", async () => {
  const root = path.join(tmp(), "objs");
  const store = fsBlobStore(root);
  const f = randomFile(2 * MiB + 5);
  const key = `t/default/blobs/${f.sha256}`;
  assert.deepEqual(await store.putSourceIfAbsent(key, fileSource(f.file), { sha256: f.sha256 }), { created: true });
  assert.deepEqual(await store.putSourceIfAbsent(key, fileSource(f.file), { sha256: f.sha256 }), { created: false });
  assert.equal((await store.head(key))?.size, f.size);

  const g = randomFile(MiB);
  const k2 = `t/default/blobs/${g.sha256}`;
  await assert.rejects(() => store.putSourceIfAbsent(k2, fileSource(g.file), { sha256: "b".repeat(64) }), BlobSourceError);
  assert.equal(await store.head(k2), null);
  assert.deepEqual(fs.readdirSync(path.dirname(path.join(root, ...k2.split("/")))).filter((n) => n.endsWith(".tmp")), [], "no temp file left behind");

  // a crashed writer's temp file is swept when old enough
  const stale = path.join(root, "t", "default", "blobs", `${g.sha256}.1.abc.tmp`);
  fs.writeFileSync(stale, "half");
  assert.equal(await store.abortStaleUploads({ olderThanMs: 60_000 }), 0);
  fs.utimesSync(stale, new Date(Date.now() - 3600_000), new Date(Date.now() - 3600_000));
  assert.equal(await store.abortStaleUploads({ olderThanMs: 60_000 }), 1);
  assert.equal(fs.existsSync(stale), false);

  const dest = path.join(tmp(), "fs.bin");
  await downloadToFile(store, key, dest, { sha256: f.sha256 });
  assert.equal(sha256OfFile(dest), f.sha256);
});

test("downloadToFile: an empty object downloads to an empty file, fresh or over a leftover .part", async () => {
  const store = fsBlobStore(path.join(tmp(), "objs"));
  const key = blobKey("");
  await store.putIfAbsent(key, Buffer.alloc(0));
  const dest = path.join(tmp(), "empty.bin");
  assert.deepEqual(await downloadToFile(store, key, dest, { sha256: sha("") }), { size: 0 });
  assert.equal(fs.readFileSync(dest).length, 0);
  assert.equal(fs.existsSync(`${dest}.part`), false);
  // a dead process's .part that is too long for the object is thrown away
  const again = path.join(tmp(), "again.bin");
  fs.writeFileSync(`${again}.part`, "junk");
  assert.deepEqual(await downloadToFile(store, key, again, { sha256: sha("") }), { size: 0 });
  assert.equal(fs.readFileSync(again).length, 0);
});
