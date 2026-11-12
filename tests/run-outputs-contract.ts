// The run-outputs contract (FOL-126 phase 5): ONE suite, called once per
// pairing of a BlobStore and a RunOutputStore (fs / s3(fake) / MinIO + local
// records here; the database records in foldrun-platform), the way
// revision-contract.ts is.
//
// Every case drives the real publish and read paths in src/run-outputs.ts.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

import type { BlobStore, BlobSweeper } from "../src/blob-store.ts";
import type { BlobPins, PinHolder, PinKind } from "../src/blob-pins.ts";
import { blobObjectKey, manifestObjectKey, sha256Hex } from "../src/manifest.ts";
import { BlobMissing } from "../src/publish.ts";
import {
  archiveRunOutputs,
  dropRunOutputs,
  dropTenantOutputs,
  dropWorkspaceOutputs,
  listRunOutputs,
  moveWorkspaceOutputs,
  noteRefused,
  openRunOutput,
  outputsHolder,
  publishRunOutputs,
  readRunOutput,
  runOutputBytes,
  refusalText,
  setRunOutputsBackend,
  settleRunOutputs,
  type RunOutputStore,
  type RunOutputsBackend,
} from "../src/run-outputs.ts";
import { sweepBlobs, memorySweepMarks } from "../src/blob-sweeper.ts";
import { localRevisionStore } from "../src/revision-store.ts";
import { deleteRun, workspaceDir, writeRun, type RunRecord } from "../src/store.ts";

export interface Harness {
  blobs: BlobStore & BlobSweeper;
  store: RunOutputStore;
  /** Pins. Unset: an in-memory implementation with the same semantics. */
  pins?: BlobPins;
  cleanup(): Promise<void>;
}

/** The pin semantics the sweeper relies on, in memory (the pg ones are tested in platform). */
export function memoryPins() {
  const held: { tenant: string; kind: PinKind; ref: string; holder: PinHolder }[] = [];
  const pins: BlobPins = {
    async pinBlobs(t, shas, h) {
      for (const r of shas) if (!held.some((x) => x.tenant === t && x.kind === "blob" && x.ref === r && x.holder.id === h.id && x.holder.kind === h.kind)) held.push({ tenant: t, kind: "blob", ref: r, holder: h });
    },
    async pinManifests(t, ids, h) {
      for (const r of ids) if (!held.some((x) => x.tenant === t && x.kind === "manifest" && x.ref === r && x.holder.id === h.id && x.holder.kind === h.kind)) held.push({ tenant: t, kind: "manifest", ref: r, holder: h });
    },
    async release(t, h) {
      let n = 0;
      for (let i = held.length - 1; i >= 0; i--) if (held[i].tenant === t && held[i].holder.kind === h.kind && held[i].holder.id === h.id) (held.splice(i, 1), n++);
      return n;
    },
    async renew() {
      return 0;
    },
    async isPinned(t, kind, ref) {
      return held.some((x) => x.tenant === t && x.kind === kind && x.ref === ref);
    },
    async isPinnedBeyondRevisions(t, kind, ref) {
      return held.some((x) => x.tenant === t && x.kind === kind && x.ref === ref && x.holder.kind !== "revision");
    },
    async live(t) {
      return { manifests: held.filter((x) => x.tenant === t && x.kind === "manifest").map((x) => x.ref), blobs: held.filter((x) => x.tenant === t && x.kind === "blob").map((x) => x.ref) };
    },
    async guardDelete(t, kind, ref, del) {
      if (held.some((x) => x.tenant === t && x.kind === kind && x.ref === ref)) return false;
      await del();
      return true;
    },
  };
  return { pins, held };
}

let n = 0;
const uniq = () => `${Date.now().toString(36)}${(n++).toString(36)}${crypto.randomBytes(2).toString("hex")}`;

export function runOutputsContract(label: string, make: () => Promise<Harness>): void {
  // A new account per case, so rows and pins left in a shared database by another case cannot matter.
  let T = "acme";
  let h: Harness;
  let pins: BlobPins;
  let held: ReturnType<typeof memoryPins>["held"] | null = null;
  let be: RunOutputsBackend;
  let on = true;
  let fileMax = 1_000_000;
  let runMax = 10_000_000;
  let tmp: string;
  let prevData: string | undefined;

  const dirWith = (files: Record<string, string | { content: string; exec?: boolean }>): string => {
    const d = fs.mkdtempSync(path.join(tmp, "out-"));
    for (const [rel, v] of Object.entries(files)) {
      const f = path.join(d, rel);
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, typeof v === "string" ? v : v.content, { mode: typeof v === "object" && v.exec ? 0o755 : 0o644 });
      if (typeof v === "object" && v.exec) fs.chmodSync(f, 0o755);
    }
    return d;
  };
  const ids = () => ({ ws: `w${uniq()}`, run: `run-${uniq()}` });

  const t = (name: string, fn: () => Promise<void>) =>
    test(`run outputs [${label}]: ${name}`, async () => {
      T = `ro${uniq()}`;
      h = await make();
      tmp = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-ro-"));
      prevData = process.env.FOLDRUN_DATA;
      process.env.FOLDRUN_DATA = path.join(tmp, "data");
      const mem = h.pins ? null : memoryPins();
      pins = h.pins ?? mem!.pins;
      held = mem?.held ?? null;
      on = true;
      fileMax = 1_000_000;
      runMax = 10_000_000;
      be = { blobs: h.blobs, pins, store: h.store, enabled: () => on, fileMaxBytes: () => fileMax, runMaxBytes: () => runMax };
      setRunOutputsBackend(be);
      try {
        await fn();
      } finally {
        await settleRunOutputs();
        setRunOutputsBackend(null);
        await h.cleanup();
        if (prevData === undefined) delete process.env.FOLDRUN_DATA;
        else process.env.FOLDRUN_DATA = prevData;
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    });

  t("publishes an agent's outputs and reads them back: names, bytes, nesting, mode", async () => {
    const { ws, run } = ids();
    const dir = dirWith({ "report.md": "# hello", "data/rows.csv": "a,b\n1,2\n", "bin/run.sh": { content: "#!/bin/sh\n", exec: true } });
    const r = await publishRunOutputs(be, T, ws, run, "writer", dir);
    assert.equal(r.refused.length, 0);
    assert.equal(r.record?.files, 3);
    assert.equal(r.record?.bytes, "# hello".length + "a,b\n1,2\n".length + "#!/bin/sh\n".length);
    const files = await listRunOutputs(T, ws, run);
    assert.deepEqual(files.map((f) => `${f.agent}:${f.path}:${f.bytes}`), ["writer:bin/run.sh:10", "writer:data/rows.csv:8", "writer:report.md:7"]);
    assert.equal((await readRunOutput(T, ws, run, "writer", "data/rows.csv"))?.toString(), "a,b\n1,2\n");
    // a name that is not there, and names that try to leave
    assert.equal(await openRunOutput(T, ws, run, "writer", "nope.txt"), null);
    assert.equal(await openRunOutput(T, ws, run, "writer", "../writer/report.md"), null);
    assert.equal(await openRunOutput(T, ws, run, "../x", "report.md"), null);
    assert.equal(await openRunOutput(T, ws, run, "other", "report.md"), null);
  });

  t("a byte range is served from the store", async () => {
    const { ws, run } = ids();
    await publishRunOutputs(be, T, ws, run, "writer", dirWith({ "big.txt": "0123456789abcdef" }));
    const o = (await openRunOutput(T, ws, run, "writer", "big.txt"))!;
    assert.equal(o.size, 16);
    const chunks: Buffer[] = [];
    const reader = o.read({ start: 4, end: 9 }).getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(Buffer.from(value));
    }
    assert.equal(Buffer.concat(chunks).toString(), "456789");
  });

  t("the same files twice are one record and one manifest (a resumed driver publishes once)", async () => {
    const { ws, run } = ids();
    const dir = dirWith({ "a.txt": "one", "b.txt": "two" });
    const a = await publishRunOutputs(be, T, ws, run, "writer", dir);
    const b = await publishRunOutputs(be, T, ws, run, "writer", dir);
    assert.equal(a.record?.manifest, b.record?.manifest);
    assert.equal((await h.store.list(T, ws, run)).length, 1);
    if (held) assert.equal(held.filter((x) => x.holder.kind === "run").length, 1, "one permanent pin");
  });

  t("a second archive of the run replaces the first and lets go of the old manifest", async () => {
    const { ws, run } = ids();
    const first = await publishRunOutputs(be, T, ws, run, "writer", dirWith({ "a.txt": "one" }));
    const second = await publishRunOutputs(be, T, ws, run, "writer", dirWith({ "a.txt": "one", "b.txt": "added after a resume" }));
    assert.notEqual(first.record!.manifest, second.record!.manifest);
    assert.deepEqual((await listRunOutputs(T, ws, run)).map((f) => f.path), ["a.txt", "b.txt"]);
    assert.equal(await pins.isPinned(T, "manifest", first.record!.manifest), false, "the old manifest is no longer held");
    assert.equal(await pins.isPinned(T, "manifest", second.record!.manifest), true);
  });

  t("agents of one run are separate records; the run cap is shared by them", async () => {
    const { ws, run } = ids();
    runMax = 100;
    fileMax = 100;
    const a = await publishRunOutputs(be, T, ws, run, "researcher", dirWith({ "r.txt": "x".repeat(70) }));
    assert.equal(a.refused.length, 0);
    const b = await publishRunOutputs(be, T, ws, run, "writer", dirWith({ "small.txt": "y".repeat(20), "w.txt": "z".repeat(40) }));
    // sorted by name: small.txt (20) fits (90 of 100), w.txt (40) would make 130
    assert.deepEqual(b.refused.map((r) => [r.agent, r.path, r.reason, r.limit]), [["writer", "w.txt", "run-cap", 100]]);
    assert.deepEqual((await listRunOutputs(T, ws, run)).map((f) => `${f.agent}/${f.path}`), ["researcher/r.txt", "writer/small.txt"]);
  });

  t("a file over the per-file cap is refused, named, and the rest is kept", async () => {
    const { ws, run } = ids();
    fileMax = 50;
    const r = await publishRunOutputs(be, T, ws, run, "writer", dirWith({ "ok.txt": "small", "huge.bin": "x".repeat(51) }));
    assert.deepEqual(r.refused, [{ agent: "writer", path: "huge.bin", bytes: 51, reason: "file-cap", limit: 50 }]);
    assert.deepEqual((await listRunOutputs(T, ws, run)).map((f) => f.path), ["ok.txt"]);
    // exactly at the cap is kept
    const run2 = ids().run;
    const r2 = await publishRunOutputs(be, T, ws, run2, "writer", dirWith({ "edge.bin": "x".repeat(50) }));
    assert.equal(r2.refused.length, 0);
  });

  t("a cap of 0 means no cap", async () => {
    const { ws, run } = ids();
    fileMax = 0;
    runMax = 0;
    const r = await publishRunOutputs(be, T, ws, run, "writer", dirWith({ "a.bin": "x".repeat(3000) }));
    assert.equal(r.refused.length, 0);
  });

  t("every file refused: nothing is published, nothing is pinned, nothing is recorded", async () => {
    const { ws, run } = ids();
    fileMax = 3;
    const r = await publishRunOutputs(be, T, ws, run, "writer", dirWith({ "a.txt": "toolong" }));
    assert.equal(r.record, null);
    assert.equal(r.refused.length, 1);
    assert.deepEqual(await h.store.list(T, ws, run), []);
    if (held) assert.equal(held.length, 0);
  });

  t("names the store cannot hold are refused, not mangled: control characters, case twins", async () => {
    const { ws, run } = ids();
    const d = dirWith({ "Report.md": "A", "ok.txt": "ok" });
    fs.writeFileSync(path.join(d, "report.md"), "B"); // on a case-insensitive disk this IS Report.md: skip then
    const onDisk = fs.readdirSync(d);
    fs.writeFileSync(path.join(d, "bell\u0007.txt"), "x");
    const r = await publishRunOutputs(be, T, ws, run, "writer", d);
    const reasons = r.refused.map((x) => `${x.path}:${x.reason}`).sort();
    assert.ok(reasons.includes("bell\u0007.txt:name"), reasons.join(","));
    if (onDisk.length === 3) assert.ok(reasons.some((x) => x.endsWith(":name") && /report/i.test(x)), "the case twin is refused");
    assert.ok((await listRunOutputs(T, ws, run)).some((f) => f.path === "ok.txt"));
  });

  t("symlinks are not outputs", async () => {
    const { ws, run } = ids();
    const d = dirWith({ "real.txt": "real" });
    fs.symlinkSync("/etc/hostname", path.join(d, "link.txt"));
    const r = await publishRunOutputs(be, T, ws, run, "writer", d);
    assert.equal(r.record?.files, 1);
    assert.deepEqual((await listRunOutputs(T, ws, run)).map((f) => f.path), ["real.txt"]);
  });

  t("a crash between the upload and the commit leaves no record and no pin; the retry publishes", async () => {
    const { ws, run } = ids();
    const dir = dirWith({ "a.txt": "payload" });
    let fail = true;
    const flaky: RunOutputStore = { ...h.store, put: async (rec) => (fail ? Promise.reject(new Error("database down")) : h.store.put(rec)) };
    await assert.rejects(() => publishRunOutputs({ ...be, store: flaky }, T, ws, run, "writer", dir), /database down/);
    assert.deepEqual(await h.store.list(T, ws, run), []);
    if (held) assert.equal(held.length, 0, "the pins taken for the lost commit are released");
    fail = false;
    const r = await publishRunOutputs({ ...be, store: flaky }, T, ws, run, "writer", dir);
    assert.equal(r.record?.files, 1);
    assert.equal((await readRunOutput(T, ws, run, "writer", "a.txt"))?.toString(), "payload");
  });

  t("a store that refuses the upload fails the publish (nothing recorded)", async () => {
    const { ws, run } = ids();
    const dead: BlobStore & BlobSweeper = { ...h.blobs, putIfAbsent: async () => Promise.reject(new Error("bucket unreachable")) } as never;
    await assert.rejects(() => publishRunOutputs({ ...be, blobs: dead }, T, ws, run, "writer", dirWith({ "a.txt": "x" })), /bucket unreachable/);
    assert.deepEqual(await h.store.list(T, ws, run), []);
  });

  t("TEMPORARY fallback: a publish error archives to the volume; off or no backend also answers 'volume'", async () => {
    const { ws, run } = ids();
    const dir = dirWith({ "a.txt": "x" });
    const dead: BlobStore & BlobSweeper = { ...h.blobs, putIfAbsent: async () => Promise.reject(new Error("bucket unreachable")) } as never;
    setRunOutputsBackend({ ...be, blobs: dead });
    assert.deepEqual(await archiveRunOutputs(T, ws, run, "writer", dir), { where: "volume" });
    setRunOutputsBackend(be);
    on = false;
    assert.deepEqual(await archiveRunOutputs(T, ws, run, "writer", dir), { where: "volume" });
    on = true;
    const done = await archiveRunOutputs(T, ws, run, "writer", dir);
    assert.equal(done.where, "store");
    setRunOutputsBackend(null);
    assert.deepEqual(await archiveRunOutputs(T, ws, run, "writer", dir), { where: "volume" });
  });

  t("reads ask the store first and the volume second, per agent (a run archived both ways)", async () => {
    const { ws, run } = ids();
    await publishRunOutputs(be, T, ws, run, "stored-agent", dirWith({ "s.txt": "from the store" }));
    const volume = path.join(workspaceDir(T, ws), "runs", run, "outputs", "volume-agent");
    fs.mkdirSync(volume, { recursive: true });
    fs.writeFileSync(path.join(volume, "v.txt"), "from the volume");
    const files = await listRunOutputs(T, ws, run);
    assert.deepEqual(files.map((f) => `${f.agent}/${f.path}`), ["stored-agent/s.txt", "volume-agent/v.txt"]);
    assert.equal((await readRunOutput(T, ws, run, "stored-agent", "s.txt"))?.toString(), "from the store");
    assert.equal((await readRunOutput(T, ws, run, "volume-agent", "v.txt"))?.toString(), "from the volume");
    // and with the setting off, the stored one is still readable
    on = false;
    assert.equal((await readRunOutput(T, ws, run, "stored-agent", "s.txt"))?.toString(), "from the store");
  });

  t("a blob that is gone is an error, never an empty file", async () => {
    const { ws, run } = ids();
    const r = await publishRunOutputs(be, T, ws, run, "writer", dirWith({ "a.txt": "precious" }));
    assert.ok(r.record);
    await h.blobs.delete(blobObjectKey(T, sha256Hex("precious")));
    await assert.rejects(() => openRunOutput(T, ws, run, "writer", "a.txt"), BlobMissing);
  });

  t("the sweeper keeps a run's outputs while the run exists, and collects them after it is gone", async () => {
    const { ws, run } = ids();
    const r = await publishRunOutputs(be, T, ws, run, "writer", dirWith({ "a.txt": "keep me", "b.txt": "and me" }));
    const manifestKey = manifestObjectKey(T, r.record!.manifest);
    const marks = memorySweepMarks();
    const revisions = localRevisionStore(path.join(tmp, "rev"));
    const opts = { dryRun: false, delayMs: 1, minAgeMs: 0, maxDeletes: 1000, tenants: [T], allowEmpty: true };
    const keys = async () => {
      const out: string[] = [];
      for await (const o of h.blobs.list!(`t/${T}/`)) out.push(o.key);
      return out.sort();
    };
    const before = await keys();
    assert.equal(before.length, 3, "two blobs and the manifest");
    for (let i = 0; i < 3; i++) await sweepBlobs({ blobs: h.blobs, revisions, pins }, marks, opts);
    assert.deepEqual(await keys(), before, "pinned: nothing goes");
    await dropRunOutputs(T, ws, run);
    assert.deepEqual(await h.store.list(T, ws, run), []);
    await new Promise((res) => setTimeout(res, 20));
    for (let i = 0; i < 4; i++) {
      await sweepBlobs({ blobs: h.blobs, revisions, pins }, marks, opts);
      await new Promise((res) => setTimeout(res, 20));
    }
    assert.deepEqual(await keys(), [], `released: collected (${manifestKey})`);
  });

  t("two runs of identical output share the blobs; deleting one keeps them for the other", async () => {
    const { ws } = ids();
    const a = `run-${uniq()}`;
    const b = `run-${uniq()}`;
    const files = { "same.txt": "identical bytes" };
    await publishRunOutputs(be, T, ws, a, "writer", dirWith(files));
    await publishRunOutputs(be, T, ws, b, "writer", dirWith(files));
    await dropRunOutputs(T, ws, a);
    assert.equal((await readRunOutput(T, ws, b, "writer", "same.txt"))?.toString(), "identical bytes");
    assert.deepEqual(await listRunOutputs(T, ws, a), []);
    const marks = memorySweepMarks();
    const opts = { dryRun: false, delayMs: 1, minAgeMs: 0, maxDeletes: 1000, tenants: [T], allowEmpty: true };
    const revisions = localRevisionStore(path.join(tmp, "rev"));
    for (let i = 0; i < 3; i++) {
      await sweepBlobs({ blobs: h.blobs, revisions, pins }, marks, opts);
      await new Promise((res) => setTimeout(res, 10));
    }
    assert.equal((await readRunOutput(T, ws, b, "writer", "same.txt"))?.toString(), "identical bytes", "still held by b's pin");
  });

  t("deleting a workspace drops its runs' records and pins; another workspace's are untouched", async () => {
    const x = ids();
    const y = ids();
    await publishRunOutputs(be, T, x.ws, x.run, "writer", dirWith({ "x.txt": "x" }));
    await publishRunOutputs(be, T, y.ws, y.run, "writer", dirWith({ "y.txt": "y" }));
    await dropWorkspaceOutputs(T, x.ws);
    assert.deepEqual(await listRunOutputs(T, x.ws, x.run), []);
    assert.equal((await readRunOutput(T, y.ws, y.run, "writer", "y.txt"))?.toString(), "y");
    if (held) assert.equal(held.filter((p) => p.holder.kind === "run").length, 1);
  });

  t("the usage statement counts what a workspace's runs hold in the store, and stops when they are gone", async () => {
    const { ws, run } = ids();
    await publishRunOutputs(be, T, ws, run, "writer", dirWith({ "a.txt": "12345", "b.txt": "1234567" }));
    await publishRunOutputs(be, T, ws, `${run}b`, "writer", dirWith({ "c.txt": "123" }));
    assert.equal(runOutputBytes(T, ws), 15);
    assert.equal(runOutputBytes(T, `${ws}x`), 0);
    await dropRunOutputs(T, ws, run);
    assert.equal(runOutputBytes(T, ws), 3);
  });

  t("deleting an account drops every workspace's records", async () => {
    const x = ids();
    const y = ids();
    await publishRunOutputs(be, T, x.ws, x.run, "writer", dirWith({ "x.txt": "x" }));
    await publishRunOutputs(be, `${T}x`, y.ws, y.run, "writer", dirWith({ "y.txt": "y" }));
    await dropTenantOutputs(T);
    assert.deepEqual(await h.store.list(T, x.ws, x.run), []);
    assert.equal((await h.store.list(`${T}x`, y.ws, y.run)).length, 1, "another account's records stay");
  });

  t("renaming a workspace carries its runs' outputs; what the new name held is replaced", async () => {
    const x = ids();
    const to = `w${uniq()}`;
    const stale = `run-${uniq()}`;
    await publishRunOutputs(be, T, x.ws, x.run, "writer", dirWith({ "x.txt": "moved" }));
    await publishRunOutputs(be, T, to, stale, "writer", dirWith({ "old.txt": "stale" }));
    const staleManifest = (await h.store.list(T, to, stale))[0].manifest;
    await moveWorkspaceOutputs(T, x.ws, to);
    assert.deepEqual(await listRunOutputs(T, x.ws, x.run), []);
    assert.equal((await readRunOutput(T, to, x.run, "writer", "x.txt"))?.toString(), "moved");
    assert.deepEqual(await h.store.list(T, to, stale), []);
    // Review, 12 Nov 2026: the replaced records' pins go too, or nothing
    // could ever find and release them.
    assert.equal(await pins.isPinned(T, "manifest", staleManifest), false, "what the new name held is no longer pinned");
  });

  t("an output may be named __proto__ (and anything else legal): kept, listed, read back", async () => {
    const { ws, run } = ids();
    const r = await publishRunOutputs(be, T, ws, run, "writer", dirWith({ ["__proto__"]: "proto", constructor: "ctor", "a.txt": "a" }));
    assert.equal(r.record?.files, 3, "none silently dropped");
    assert.deepEqual((await listRunOutputs(T, ws, run)).map((f) => f.path), ["__proto__", "a.txt", "constructor"]);
    assert.equal((await readRunOutput(T, ws, run, "writer", "__proto__"))?.toString(), "proto");
  });

  t("a download is read only as fast as it is taken, and a cancelled one stops reading", async () => {
    const { ws, run } = ids();
    fileMax = 8 * 1024 * 1024;
    runMax = 8 * 1024 * 1024;
    await publishRunOutputs(be, T, ws, run, "writer", dirWith({ "big.bin": "x".repeat(4 * 1024 * 1024) }));
    // Count what the store hands out, and whether the reader was cancelled.
    let chunks = 0;
    let cancelled = false;
    const blobs = h.blobs;
    const counting = Object.create(blobs) as typeof blobs;
    counting.get = async (key, opts) => {
      const src = (await blobs.get(key, opts)).getReader();
      return new ReadableStream<Uint8Array>({
        async pull(c) {
          const { done, value } = await src.read();
          if (done) return c.close();
          chunks++;
          c.enqueue(value.subarray(0, 1024)); // small chunks: many reads for one file
          if (value.length > 1024) c.enqueue(value.subarray(1024));
        },
        cancel(reason) {
          cancelled = true;
          return src.cancel(reason);
        },
      });
    };
    setRunOutputsBackend({ ...be, blobs: counting });
    const reader = (await openRunOutput(T, ws, run, "writer", "big.bin"))!.read().getReader();
    await reader.read();
    await new Promise((r) => setTimeout(r, 50));
    const afterOne = chunks;
    await reader.cancel();
    await new Promise((r) => setTimeout(r, 20));
    setRunOutputsBackend(be);
    assert.ok(afterOne <= 3, `one read pulled ${afterOne} chunks from the store, not the whole file`);
    assert.equal(cancelled, true, "cancelling the download cancels the store's read");
  });

  t("deleteRun drops the outputs too (in the background, then settled)", async () => {
    const { ws, run } = ids();
    const rec = { id: run, flow: "adhoc:writer", status: "completed", steps: [], startedAt: new Date().toISOString() } as unknown as RunRecord;
    fs.mkdirSync(workspaceDir(T, ws), { recursive: true });
    writeRun(T, ws, rec);
    await publishRunOutputs(be, T, ws, run, "writer", dirWith({ "a.txt": "x" }));
    assert.equal(deleteRun(T, ws, run, { pruned: true }), true);
    await settleRunOutputs();
    assert.deepEqual(await h.store.list(T, ws, run), []);
  });

  t("what was refused is written on the run and in the step's trail, once", async () => {
    const run = { steps: [{ status: "completed", events: [] as { t: string; type: string; text: string }[] }] } as Parameters<typeof noteRefused>[0];
    const refused = [{ agent: "writer", path: "huge.bin", bytes: 80 * 1048576, reason: "file-cap" as const, limit: 64 * 1048576 }];
    noteRefused(run, refused);
    noteRefused(run, refused);
    assert.equal(run.outputsRefused?.length, 1);
    assert.equal(run.outputsRefusedCount, 1);
    assert.equal(run.steps[0].events.length, 1);
    assert.match(run.steps[0].events[0].text, /outputs: writer\/huge\.bin \(80 MiB\) was not kept: a file may be at most 64 MiB/);
    assert.match(refusalText({ agent: "w", path: "p", bytes: 5 * 1048576, reason: "run-cap", limit: 512 * 1048576 }), /this run's outputs may total at most 512 MiB/);
  });
}
