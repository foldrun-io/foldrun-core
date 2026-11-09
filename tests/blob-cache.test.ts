// The node-local blob cache (src/blob-cache.ts). Runs everywhere over the fs
// driver; the last case reads through a real S3-compatible server when
// FOLDRUN_TEST_S3_URL is set.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { fsBlobStore, s3BlobStore, bounded, BlobNotFound, BlobSourceError, BlobTransientError, fileSource, type BlobStore } from "../src/blob-store.ts";
import { blobCache } from "../src/blob-cache.ts";
import { blobObjectKey } from "../src/manifest.ts";
import { realS3 } from "./s3-test-server.ts";

const MiB = 1024 * 1024;
const dirs: string[] = [];
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-cache-"));
  dirs.push(d);
  return d;
};
after(() => dirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

const sha = (b: Uint8Array) => crypto.createHash("sha256").update(b).digest("hex");
const blob = (n: number) => crypto.randomBytes(n);

/** A source store holding blobs, with counters and optional misbehaviour. */
async function rig(tenant = "default") {
  const inner = fsBlobStore(path.join(tmp(), "objects"));
  const ctl = { gets: 0, delayMs: 0, failNext: 0, gate: null as Promise<void> | null };
  const store: BlobStore = {
    ...inner,
    async get(key, opts) {
      ctl.gets++;
      if (ctl.gate) await ctl.gate;
      if (ctl.delayMs) await new Promise((r) => setTimeout(r, ctl.delayMs));
      if (ctl.failNext > 0) {
        ctl.failNext--;
        throw new BlobTransientError("injected");
      }
      return inner.get(key, opts);
    },
  };
  const put = async (b: Uint8Array, t = tenant) => {
    const s = sha(b);
    await inner.putIfAbsent(blobObjectKey(t, s), b);
    return s;
  };
  const cache = (maxBytes: number, extra: Partial<Parameters<typeof blobCache>[0]> = {}, dir = tmp()) =>
    blobCache({ dir, maxBytes, store: bounded(store, { retries: 0, backoffMs: 1 }), ...extra });
  return { inner, store, ctl, put, cache };
}

const readFile = (p: string) => fs.readFileSync(p);

test("read-through: a miss downloads and verifies, a hit does not touch the store", async () => {
  const r = await rig();
  const b = blob(300_000);
  const s = await r.put(b);
  const c = r.cache(10 * MiB);
  const l1 = await c.acquire("default", s);
  assert.deepEqual(readFile(l1.path), b);
  assert.equal(l1.size, b.length);
  l1.release();
  const l2 = await c.acquire("default", s);
  assert.equal(l2.path, l1.path);
  l2.release();
  assert.equal(r.ctl.gets, 1);
  const st = c.stats();
  assert.deepEqual([st.hits, st.misses, st.fills, st.entries, st.bytes], [1, 1, 1, 1, b.length]);
  assert.deepEqual(fs.readdirSync(path.join(path.dirname(path.dirname(l1.path)), "..", "..", "tmp")).filter((n) => n.includes(s)), [], "no temp file left");
});

test("single flight: 20 readers of one missing blob cause one download, each gets its own pin", async () => {
  const r = await rig();
  const b = blob(MiB);
  const s = await r.put(b);
  r.ctl.delayMs = 60;
  const c = r.cache(10 * MiB);
  const leases = await Promise.all(Array.from({ length: 20 }, () => c.acquire("default", s)));
  assert.equal(r.ctl.gets, 1);
  assert.equal(new Set(leases.map((l) => l.path)).size, 1);
  assert.equal(c.stats().pinned, 1);
  leases.slice(0, 19).forEach((l) => l.release());
  assert.equal(c.stats().pinned, 1, "one pin still held");
  leases[19].release();
  leases[19].release(); // twice is harmless
  assert.equal(c.stats().pinned, 0);
  assert.equal(c.stats().joined, 19);
});

test("LRU: over the cap the least recently used goes first; a touch saves an entry", async () => {
  const r = await rig();
  const bs = [blob(MiB), blob(MiB), blob(MiB), blob(MiB)];
  const ss = await Promise.all(bs.map((b) => r.put(b)));
  const c = r.cache(3 * MiB + 10);
  for (const s of ss.slice(0, 3)) (await c.acquire("default", s)).release();
  (await c.acquire("default", ss[0])).release(); // 0 is now the newest; 1 the oldest
  (await c.acquire("default", ss[3])).release(); // pushes one out
  const before = r.ctl.gets;
  for (const i of [0, 2, 3]) (await c.acquire("default", ss[i])).release();
  assert.equal(r.ctl.gets, before, "0, 2 and 3 are still cached");
  (await c.acquire("default", ss[1])).release();
  assert.equal(r.ctl.gets, before + 1, "1 was the one evicted");
  assert.ok(c.stats().bytes <= 3 * MiB + 10);
  assert.ok(c.stats().evictions >= 1);
});

test("pinning: a blob in use is never evicted; the cache goes over its cap and comes back down on release", async () => {
  const r = await rig();
  const bs = [blob(MiB), blob(MiB), blob(MiB)];
  const ss = await Promise.all(bs.map((b) => r.put(b)));
  const c = r.cache(MiB + 10);
  const held = await c.acquire("default", ss[0]);
  (await c.acquire("default", ss[1])).release();
  (await c.acquire("default", ss[2])).release();
  assert.deepEqual(readFile(held.path), bs[0], "the pinned file is intact");
  assert.ok(fs.existsSync(held.path));
  assert.ok(c.stats().bytes <= 2 * MiB + 10, "only the pinned one and the newest remain");
  held.release();
  assert.ok(c.stats().bytes <= MiB + 10, "back under the cap once nothing is pinned");

  // everything pinned: the cap is soft, and says so
  const a = await c.acquire("default", ss[0]);
  const b2 = await c.acquire("default", ss[1]);
  assert.ok(c.stats().bytes >= 2 * MiB);
  assert.ok(c.stats().overCap >= 1);
  a.release();
  b2.release();
  assert.ok(c.stats().bytes <= MiB + 10);
});

test("a blob bigger than the whole cache is still served, and goes when released", async () => {
  const r = await rig();
  const b = blob(3 * MiB);
  const s = await r.put(b);
  const c = r.cache(MiB);
  const l = await c.acquire("default", s);
  assert.deepEqual(readFile(l.path), b);
  l.release();
  assert.equal(c.stats().entries, 0);
  assert.equal(fs.existsSync(l.path), false);
});

test("atomic: while a download is in flight nothing is visible at the final path; a mismatch leaves nothing", async () => {
  const r = await rig();
  const b = blob(MiB);
  const s = await r.put(b);
  let open!: () => void;
  r.ctl.gate = new Promise<void>((res) => (open = res));
  const dir = tmp();
  const c = r.cache(10 * MiB, {}, dir);
  const pending = c.acquire("default", s);
  await new Promise((res) => setTimeout(res, 30));
  const final = path.join(dir, "blobs", "default", s.slice(0, 2), s);
  assert.equal(fs.existsSync(final), false, "not visible before it is complete");
  assert.equal(c.stats().entries, 0);
  assert.equal(c.stats().fillsInFlight, 1);
  open();
  (await pending).release();
  assert.ok(fs.existsSync(final));

  // bytes that do not hash to their name: refused, no entry, no file, and a later good copy works
  const bad = blob(1000);
  const badSha = sha(bad);
  const wrong = blob(1000);
  r.ctl.gate = null;
  await r.inner.putIfAbsent(blobObjectKey("default", badSha), wrong);
  await assert.rejects(() => c.acquire("default", badSha), BlobSourceError);
  assert.equal(fs.existsSync(path.join(dir, "blobs", "default", badSha.slice(0, 2), badSha)), false);
  assert.equal(c.stats().entries, 1);
  await r.inner.delete(blobObjectKey("default", badSha));
  await r.inner.putIfAbsent(blobObjectKey("default", badSha), bad);
  (await c.acquire("default", badSha)).release();
  assert.equal(c.stats().entries, 2);
});

test("a failed fill rejects every reader that joined it, and the next try starts clean", async () => {
  const r = await rig();
  const b = blob(200_000);
  const s = await r.put(b);
  r.ctl.failNext = 99; // downloadToFile resumes a transient cut itself; fail every attempt
  r.ctl.delayMs = 30;
  const c = r.cache(10 * MiB);
  const results = await Promise.allSettled([c.acquire("default", s), c.acquire("default", s), c.acquire("default", s)]);
  assert.ok(results.every((x) => x.status === "rejected"));
  assert.equal(c.stats().pinned, 0);
  assert.equal(c.stats().entries, 0);
  r.ctl.delayMs = 0;
  r.ctl.failNext = 0;
  const l = await c.acquire("default", s);
  assert.deepEqual(readFile(l.path), b);
  l.release();
  await assert.rejects(() => c.acquire("default", "f".repeat(64)), BlobNotFound);
});

test("a reader that gives up does not cancel the download the others wait for, and leaves no pin", async () => {
  const r = await rig();
  const b = blob(MiB);
  const s = await r.put(b);
  r.ctl.delayMs = 80;
  const c = r.cache(10 * MiB);
  const ctl = new AbortController();
  const quitter = c.acquire("default", s, { signal: ctl.signal });
  const stayer = c.acquire("default", s);
  setTimeout(() => ctl.abort(new Error("changed my mind")), 10);
  await assert.rejects(() => quitter, /changed my mind/);
  const l = await stayer;
  assert.deepEqual(readFile(l.path), b);
  assert.equal(r.ctl.gets, 1);
  l.release();
  assert.equal(c.stats().pinned, 0);
  await assert.rejects(() => c.acquire("default", s, { signal: AbortSignal.abort(new Error("already")) }), /already/);
});

test("concurrent readers under eviction pressure: every byte read is right, nothing is pulled from under a reader, the cap holds at rest", async () => {
  const r = await rig();
  const bs = Array.from({ length: 12 }, (_, i) => blob(200_000 + i * 1000));
  const ss = await Promise.all(bs.map((b) => r.put(b)));
  const c = r.cache(4 * 220_000);
  r.ctl.delayMs = 2;
  let reads = 0;
  const worker = async (seed: number) => {
    for (let i = 0; i < 40; i++) {
      const n = (seed * 7 + i * 5) % ss.length;
      const rs = await c.stream("default", ss[n]);
      const chunks: Buffer[] = [];
      for await (const ch of rs) {
        chunks.push(ch as Buffer);
        if (i % 3 === 0) await new Promise((res) => setTimeout(res, 1)); // hold the pin a moment
      }
      assert.deepEqual(Buffer.concat(chunks), bs[n], `blob ${n} read back wrong`);
      reads++;
    }
  };
  await Promise.all(Array.from({ length: 8 }, (_, i) => worker(i)));
  assert.equal(reads, 320);
  const st = c.stats();
  assert.equal(st.pinned, 0);
  assert.ok(st.bytes <= 4 * 220_000, `at rest ${st.bytes} is over the cap`);
  assert.ok(st.evictions > 0 && st.hits > 0 && st.fills > 0);
  assert.ok(r.ctl.gets < 320, "the cache absorbed reads");
});

test("a ranged stream reads the right bytes", async () => {
  const r = await rig();
  const b = blob(100_000);
  const s = await r.put(b);
  const c = r.cache(10 * MiB);
  const chunks: Buffer[] = [];
  for await (const ch of await c.stream("default", s, { range: { start: 10, end: 99 } })) chunks.push(ch as Buffer);
  assert.deepEqual(Buffer.concat(chunks), b.subarray(10, 100));
  assert.equal(c.stats().pinned, 0);
});

test("restart: a new cache over the same directory adopts the entries in last-use order, and sweeps dead parts", async () => {
  const r = await rig();
  const bs = [blob(MiB), blob(MiB), blob(MiB)];
  const ss = await Promise.all(bs.map((b) => r.put(b)));
  const dir = tmp();
  const c1 = r.cache(10 * MiB, {}, dir);
  for (const s of ss) {
    (await c1.acquire("default", s)).release();
    await new Promise((res) => setTimeout(res, 15)); // distinct mtimes
  }
  fs.writeFileSync(path.join(dir, "tmp", "dead.part"), "half");
  const old = new Date(Date.now() - 7200_000);
  fs.utimesSync(path.join(dir, "tmp", "dead.part"), old, old);
  const before = r.ctl.gets;
  const c2 = r.cache(2 * MiB + 10, {}, dir);
  assert.equal(c2.stats().entries, 3);
  assert.equal(fs.existsSync(path.join(dir, "tmp", "dead.part")), false);
  (await c2.acquire("default", ss[2])).release(); // a hit, and it pushes the cache over: the oldest (0) goes
  (await c2.acquire("default", ss[0])).release();
  assert.equal(r.ctl.gets, before + 1, "0 had to be fetched again; 2 was a hit");
});

test("tenants do not share entries: a hit for one is not an answer for another", async () => {
  const r = await rig();
  const b = blob(50_000);
  const s = await r.put(b, "acme");
  const c = r.cache(10 * MiB);
  (await c.acquire("acme", s)).release();
  await assert.rejects(() => c.acquire("other", s), BlobNotFound);
  await assert.rejects(() => c.acquire("../x", s), /illegal|tenant/i);
  await assert.rejects(() => c.acquire("acme", "../../etc/passwd"), /sha256/);
});

test("a file removed behind the cache's back is a miss, not an error", async () => {
  const r = await rig();
  const b = blob(80_000);
  const s = await r.put(b);
  const dir = tmp();
  const c = r.cache(10 * MiB, {}, dir);
  const l = await c.acquire("default", s);
  l.release();
  fs.rmSync(l.path);
  const again = await c.acquire("default", s);
  assert.deepEqual(readFile(again.path), b);
  assert.equal(r.ctl.gets, 2);
  again.release();
  fs.writeFileSync(again.path, "truncated"); // damaged: the size no longer matches
  const third = await c.acquire("default", s);
  assert.deepEqual(readFile(third.path), b);
  third.release();
});

test("fills across different blobs are capped", async () => {
  const r = await rig();
  const ss = await Promise.all(Array.from({ length: 10 }, () => r.put(blob(50_000))));
  let live = 0;
  let peak = 0;
  const base = r.store;
  const counting: BlobStore = {
    ...base,
    async get(k, o) {
      live++;
      peak = Math.max(peak, live);
      await new Promise((res) => setTimeout(res, 25));
      try {
        return await base.get(k, o);
      } finally {
        live--;
      }
    },
  };
  const c = blobCache({ dir: tmp(), maxBytes: 100 * MiB, store: counting, fillConcurrency: 3 });
  const ls = await Promise.all(ss.map((s) => c.acquire("default", s)));
  ls.forEach((l) => l.release());
  assert.ok(peak <= 3 && peak >= 2, `peak fills ${peak}`);
});

// ---------- the same, reading through a real S3-compatible server ----------

test("read-through from real S3: a large blob is downloaded once, verified, and served from disk after", { skip: realS3() ? false : "no FOLDRUN_TEST_S3_URL" }, async () => {
  const real = realS3()!;
  const b = await real.newBucket();
  try {
    const store = bounded(s3BlobStore(b.cfg, { multipartThresholdBytes: 6 * MiB }), { backoffMs: 2 });
    const data = blob(14 * MiB);
    const s = sha(data);
    const f = path.join(tmp(), "src.bin");
    fs.writeFileSync(f, data);
    await store.putSourceIfAbsent(blobObjectKey("default", s), fileSource(f), { sha256: s });
    const c = blobCache({ dir: tmp(), maxBytes: 64 * MiB, store });
    const l = await c.acquire("default", s);
    assert.equal(sha(readFile(l.path)), s);
    l.release();
    // the server can go away: the cache still answers
    await b.drop();
    const l2 = await c.acquire("default", s);
    assert.equal(l2.size, data.length);
    l2.release();
    assert.deepEqual([c.stats().hits, c.stats().misses], [1, 1]);
  } finally {
    await b.drop().catch(() => {});
  }
});
