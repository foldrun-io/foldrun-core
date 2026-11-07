// Benchmark the s3 BlobStore and the blob cache against a LOCAL S3-compatible
// server (MinIO on loopback). Not part of the test suite.
//
//   source <env file with FOLDRUN_TEST_S3_URL / _ACCESS_KEY / _SECRET_KEY>
//   node scripts/bench-blobs.ts [--large-mb 256]
//
// Refuses anything but loopback (it creates and deletes a bucket). Numbers are
// for comparing small vs large and hit vs miss on one machine, not a forecast
// of S3 over a network.

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { s3BlobStore, bounded, fileSource, bufferSource, readAll, downloadToFile } from "../src/blob-store.ts";
import { blobCache } from "../src/blob-cache.ts";
import { blobObjectKey } from "../src/manifest.ts";
import { realS3 } from "../tests/s3-test-server.ts";

const MiB = 1024 * 1024;
const arg = (n: string, d: number) => {
  const i = process.argv.indexOf(`--${n}`);
  return i > 0 ? Number(process.argv[i + 1]) : d;
};
const largeMb = arg("large-mb", 256);
const real = realS3();
if (!real) throw new Error("set FOLDRUN_TEST_S3_URL (loopback MinIO) and its throwaway keys");

const sha = (b: Uint8Array) => crypto.createHash("sha256").update(b).digest("hex");
const pct = (xs: number[], p: number) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor((p / 100) * xs.length))];
const ms = (n: number) => n.toFixed(n < 10 ? 2 : 1);
const time = async <T>(fn: () => Promise<T>): Promise<[number, T]> => {
  const t = performance.now();
  const v = await fn();
  return [performance.now() - t, v];
};
const rows: string[][] = [["case", "n", "p50 ms", "p95 ms", "throughput"]];
const row = (c: string, xs: number[], thr = "") => rows.push([c, String(xs.length), ms(pct(xs, 50)), ms(pct(xs, 95)), thr]);

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fr-bench-"));
const bucket = await real.newBucket();
const store = bounded(s3BlobStore(bucket.cfg), { backoffMs: 5 });
const pool = async <T>(n: number, k: number, fn: (i: number) => Promise<T>) => {
  let next = 0;
  await Promise.all(Array.from({ length: k }, async () => { for (;;) { const i = next++; if (i >= n) return; await fn(i); } }));
};

try {
  // ---- small blobs ----
  for (const size of [4 * 1024, 256 * 1024]) {
    const N = 150;
    const blobs = Array.from({ length: N }, () => crypto.randomBytes(size));
    const keys = blobs.map((b) => blobObjectKey("bench", sha(b)));
    const put: number[] = [];
    for (let i = 0; i < N; i++) put.push((await time(() => store.putIfAbsent(keys[i], blobs[i])))[0]);
    row(`put ${size / 1024} KiB, sequential`, put);
    const get: number[] = [];
    for (let i = 0; i < N; i++) get.push((await time(() => readAll(store, keys[i])))[0]);
    row(`get ${size / 1024} KiB, sequential`, get);
    const head: number[] = [];
    for (let i = 0; i < N; i++) head.push((await time(() => store.head(keys[i])))[0]);
    row(`head ${size / 1024} KiB`, head);
    const more = Array.from({ length: 400 }, () => crypto.randomBytes(size));
    const t0 = performance.now();
    await pool(more.length, 8, (i) => store.putIfAbsent(blobObjectKey("bench", sha(more[i])), more[i]));
    const secs = (performance.now() - t0) / 1000;
    rows.push([`put ${size / 1024} KiB, 8 at once`, String(more.length), "", "", `${(more.length / secs).toFixed(0)} obj/s, ${((more.length * size) / MiB / secs).toFixed(0)} MiB/s`]);
    const t1 = performance.now();
    await pool(more.length, 8, (i) => readAll(store, blobObjectKey("bench", sha(more[i]))));
    const s1 = (performance.now() - t1) / 1000;
    rows.push([`get ${size / 1024} KiB, 8 at once`, String(more.length), "", "", `${(more.length / s1).toFixed(0)} obj/s, ${((more.length * size) / MiB / s1).toFixed(0)} MiB/s`]);
  }

  // ---- large blobs ----
  const mk = (mb: number) => {
    const f = path.join(dir, `large-${mb}.bin`);
    const fd = fs.openSync(f, "w");
    const h = crypto.createHash("sha256");
    for (let i = 0; i < mb; i++) { const c = crypto.randomBytes(MiB); fs.writeSync(fd, c); h.update(c); }
    fs.closeSync(fd);
    return { f, sha: h.digest("hex"), mb };
  };
  const cases: { label: string; mb: number; opts: Parameters<typeof s3BlobStore>[1] }[] = [
    { label: "32 MiB single request", mb: 32, opts: { multipartThresholdBytes: 1024 * MiB } },
    { label: "32 MiB multipart 16 MiB x4", mb: 32, opts: { multipartThresholdBytes: 8 * MiB } },
    { label: `${largeMb} MiB multipart 16 MiB x4`, mb: largeMb, opts: { multipartThresholdBytes: 64 * MiB } },
    { label: `${largeMb} MiB multipart 32 MiB x8`, mb: largeMb, opts: { multipartThresholdBytes: 64 * MiB, partBytes: 32 * MiB, partConcurrency: 8 } },
  ];
  const big = new Map<number, ReturnType<typeof mk>>();
  for (const c of cases) {
    const file = big.get(c.mb) ?? mk(c.mb);
    big.set(c.mb, file);
    const s = bounded(s3BlobStore(bucket.cfg, c.opts), { backoffMs: 5 });
    // a distinct key per case: the blob's own sha is the key, so vary it by a prefix
    const key = `t/bench/blobs/${file.sha}`;
    await s.delete(key);
    const [t] = await time(() => s.putSourceIfAbsent(key, fileSource(file.f), { sha256: file.sha }));
    rows.push([`put ${c.label}`, "1", ms(t), "", `${(c.mb / (t / 1000)).toFixed(0)} MiB/s`]);
    const dest = path.join(dir, "dl.bin");
    fs.rmSync(dest, { force: true });
    const [d] = await time(() => downloadToFile(s, key, dest, { sha256: file.sha }));
    rows.push([`get ${c.label} (to file, verified)`, "1", ms(d), "", `${(c.mb / (d / 1000)).toFixed(0)} MiB/s`]);
  }

  // ---- the cache: hit vs miss ----
  const cacheDir = path.join(dir, "cache");
  const cache = blobCache({ dir: cacheDir, maxBytes: 4096 * MiB, store });
  const smalls = Array.from({ length: 100 }, () => crypto.randomBytes(64 * 1024));
  for (const b of smalls) await store.putIfAbsent(blobObjectKey("bench", sha(b)), b);
  const miss: number[] = [];
  for (const b of smalls) miss.push((await time(async () => (await cache.acquire("bench", sha(b))).release()))[0]);
  row("cache miss, 64 KiB (read-through)", miss);
  const hit: number[] = [];
  for (const b of smalls) hit.push((await time(async () => (await cache.acquire("bench", sha(b))).release()))[0]);
  row("cache hit, 64 KiB", hit);
  const largeFile = big.get(largeMb)!;
  const [lm] = await time(async () => (await cache.acquire("bench", largeFile.sha)).release());
  rows.push([`cache miss, ${largeMb} MiB`, "1", ms(lm), "", `${(largeMb / (lm / 1000)).toFixed(0)} MiB/s`]);
  const hits: number[] = [];
  for (let i = 0; i < 20; i++) hits.push((await time(async () => (await cache.acquire("bench", largeFile.sha)).release()))[0]);
  row(`cache hit, ${largeMb} MiB (path only)`, hits);
  const [rs] = await time(async () => { let n = 0; for await (const c of await cache.stream("bench", largeFile.sha)) n += (c as Buffer).length; return n; });
  rows.push([`cache hit, ${largeMb} MiB streamed out`, "1", ms(rs), "", `${(largeMb / (rs / 1000)).toFixed(0)} MiB/s`]);
  const tc = performance.now();
  await pool(100, 8, async (i) => (await cache.acquire("bench", sha(smalls[i % smalls.length]))).release());
  const sc = (performance.now() - tc) / 1000;
  rows.push(["cache hit, 64 KiB, 8 readers", "100", "", "", `${(100 / sc).toFixed(0)} hits/s`]);
  console.log(JSON.stringify(cache.stats()));
} finally {
  await bucket.drop().catch(() => {});
  fs.rmSync(dir, { recursive: true, force: true });
}
const w = rows[0].map((_, i) => Math.max(...rows.map((r) => r[i].length)));
for (const r of rows) console.log("| " + r.map((c, i) => c.padEnd(w[i])).join(" | ") + " |");
