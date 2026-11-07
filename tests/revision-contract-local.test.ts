// The revision contract (tests/revision-contract.ts) against the pairings
// foldrun-core ships: fs blobs + local revisions, and s3 blobs (an in-process
// fake endpoint) + local revisions. The pg pairing runs in foldrun-platform.
//
//   node --test tests/revision-contract-local.test.ts

import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { fsBlobStore, s3BlobStore, bounded, BlobTransientError, readAll } from "../src/blob-store.ts";
import { localRevisionStore } from "../src/revision-store.ts";
import { s3Config } from "../src/storage.ts";
import { blobObjectKey, sha256Hex } from "../src/manifest.ts";
import { revisionContract } from "./revision-contract.ts";
import { fakeS3 } from "./fake-s3.ts";
import { realS3 } from "./s3-test-server.ts";

const dirs: string[] = [];
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-rev-"));
  dirs.push(d);
  return d;
};
after(() => dirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

revisionContract("fs + local", async () => {
  const root = tmp();
  return {
    blobs: bounded(fsBlobStore(path.join(root, "objects")), { backoffMs: 1 }),
    revisions: localRevisionStore(path.join(root, "revisions")),
    cleanup: async () => {},
  };
});

const S3_ENV = ["FOLDRUN_S3_ENDPOINT", "FOLDRUN_S3_BUCKET", "FOLDRUN_S3_ACCESS_KEY_ID", "FOLDRUN_S3_SECRET_ACCESS_KEY", "FOLDRUN_S3_PATH_STYLE"] as const;

async function s3Harness() {
  const server = await fakeS3("test-bucket");
  const saved = Object.fromEntries(S3_ENV.map((k) => [k, process.env[k]]));
  Object.assign(process.env, {
    FOLDRUN_S3_ENDPOINT: server.endpoint,
    FOLDRUN_S3_BUCKET: "test-bucket",
    FOLDRUN_S3_ACCESS_KEY_ID: "AKIATEST",
    FOLDRUN_S3_SECRET_ACCESS_KEY: "secret-test",
    FOLDRUN_S3_PATH_STYLE: "true",
  });
  const cfg = s3Config()!;
  const root = tmp();
  return {
    server,
    blobs: bounded(s3BlobStore(cfg), { backoffMs: 1 }),
    revisions: localRevisionStore(path.join(root, "revisions")),
    cleanup: async () => {
      await server.close();
      for (const k of S3_ENV) saved[k] === undefined ? delete process.env[k] : (process.env[k] = saved[k]);
    },
  };
}

revisionContract("s3(fake) + local", s3Harness);

// The same cases against a REAL S3-compatible server (MinIO on loopback), when
// the environment offers one. Without FOLDRUN_TEST_S3_URL this registers
// nothing, so CI without MinIO passes untouched. Each case gets a bucket of its
// own and the harness deletes it.
const realServer = realS3();
if (realServer) {
  revisionContract("s3(minio) + local", async () => {
    const b = await realServer.newBucket();
    const root = tmp();
    return {
      blobs: bounded(s3BlobStore(b.cfg), { backoffMs: 5 }),
      revisions: localRevisionStore(path.join(root, "revisions")),
      cleanup: () => b.drop(),
    };
  });
}

// ---------- what only the bounded wrapper and the s3 driver can show ----------

test("s3: a conditional put sends If-None-Match and treats 412 as 'already there'", async () => {
  const h = await s3Harness();
  try {
    const key = blobObjectKey("default", sha256Hex("x"));
    assert.equal((await h.blobs.putIfAbsent(key, Buffer.from("x"))).created, true);
    assert.equal((await h.blobs.putIfAbsent(key, Buffer.from("x"))).created, false);
    const puts = h.server.requests.filter((r) => r.method === "PUT");
    assert.ok(puts.every((r) => r.headers["if-none-match"] === "*"));
    assert.ok(puts.every((r) => String(r.headers.authorization).startsWith("AWS4-HMAC-SHA256")), "requests are signed");
  } finally {
    await h.cleanup();
  }
});

test("retries: a transient 503 is retried within the budget, then succeeds", async () => {
  const h = await s3Harness();
  try {
    const key = blobObjectKey("default", sha256Hex("y"));
    h.server.failNext(2, 503);
    await h.blobs.putIfAbsent(key, Buffer.from("y"));
    assert.equal(h.server.requests.filter((r) => r.method === "PUT").length, 3);
    assert.equal((await readAll(h.blobs, key)).toString(), "y");
  } finally {
    await h.cleanup();
  }
});

test("retries: the budget is a budget — a store that keeps failing fails, after exactly 1+retries tries", async () => {
  const h = await s3Harness();
  try {
    const store = bounded(s3BlobStore(s3Config()!), { retries: 2, backoffMs: 1 });
    h.server.failNext(100, 500);
    await assert.rejects(() => store.head(blobObjectKey("default", sha256Hex("z"))), BlobTransientError);
    assert.equal(h.server.requests.length, 3);
  } finally {
    await h.cleanup();
  }
});

test("retries: a 403 and a 404 are final, never retried", async () => {
  const h = await s3Harness();
  try {
    const store = bounded(s3BlobStore(s3Config()!), { retries: 3, backoffMs: 1 });
    h.server.failNext(1, 403);
    await assert.rejects(() => store.head(blobObjectKey("default", sha256Hex("q"))), /403/);
    assert.equal(h.server.requests.length, 1);
    assert.equal(await store.head(blobObjectKey("default", sha256Hex("q"))), null);
  } finally {
    await h.cleanup();
  }
});

test("deadline: a store that does not answer is cut off, not waited for", async () => {
  const h = await s3Harness();
  try {
    const store = bounded(s3BlobStore(s3Config()!), { deadlineMs: 80, retries: 1, backoffMs: 1 });
    h.server.delay(600);
    const t0 = Date.now();
    await assert.rejects(() => store.head(blobObjectKey("default", sha256Hex("slow"))), BlobTransientError);
    assert.ok(Date.now() - t0 < 500, `gave up in ${Date.now() - t0}ms, long before the store answered`);
  } finally {
    await h.cleanup();
  }
});

test("concurrency: no more calls in flight than the cap", async () => {
  let active = 0;
  let peak = 0;
  const inner = fsBlobStore(path.join(tmp(), "o"));
  const slow: any = {
    ...inner,
    head: async (k: string) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 15));
      active--;
      return inner.head(k);
    },
  };
  const store = bounded(slow, { concurrency: 3 });
  await Promise.all(Array.from({ length: 20 }, (_, i) => store.head(`t/default/blobs/${String(i).padStart(64, "0")}`)));
  assert.equal(peak, 3);
});

test("local revisions: a revision pointer left by a crash (op written, revision never) is not an operation", async () => {
  const root = tmp();
  const store = localRevisionStore(root);
  const ws = { tenant: "default", workspace: "crashy" };
  const opId = "crashed-op-0001";
  // what commit() writes first, then dies:
  const opDir = path.join(root, ws.tenant, ws.workspace, "ops");
  fs.mkdirSync(opDir, { recursive: true });
  fs.writeFileSync(path.join(opDir, `${sha256Hex(opId)}.json`), JSON.stringify({ opId, seq: 1 }));
  assert.equal(await store.operation(ws, opId), null);
  const r = await store.commit(ws, { base: null, authored: "a".repeat(64), state: "b".repeat(64), opId, digest: "d", by: "u", message: "m" });
  assert.equal(r.status, "committed");
});

test("local revisions: two PROCESSES racing one workspace — exactly one wins each round", async () => {
  const root = tmp();
  const { spawn } = await import("node:child_process");
  const mod = path.resolve("src/revision-store.ts");
  const script = path.join(root, "w.mjs");
  fs.writeFileSync(
    script,
    `import { localRevisionStore } from ${JSON.stringify(mod)};
     const s = localRevisionStore(${JSON.stringify(path.join(root, "rev"))});
     const ws = { tenant: "default", workspace: "shared" };
     const head = await s.head(ws);
     const r = await s.commit(ws, { base: head?.id ?? null, authored: "a".repeat(64), state: "b".repeat(64), opId: "proc-" + process.pid + "-xx", digest: "d", by: "p", message: "m" });
     process.stdout.write(r.status);`,
  );
  const run = () =>
    new Promise<string>((resolve) => {
      let out = "";
      const c = spawn(process.execPath, [script]);
      c.stdout.on("data", (d) => (out += d));
      c.stderr.on("data", (d) => (out += d));
      c.on("close", () => resolve(out));
    });
  const first = await run(); // seed so every racer sees the same head
  assert.equal(first, "committed");
  const outs = await Promise.all(Array.from({ length: 5 }, run));
  const store = localRevisionStore(path.join(root, "rev"));
  const all = await store.revisions({ tenant: "default", workspace: "shared" });
  assert.equal(all.length, 1 + outs.filter((o) => o === "committed").length, outs.join(","));
  assert.deepEqual(all.map((r) => r.seq), all.map((_, i) => all.length - i), "seqs are contiguous: no gap, no duplicate");
});
