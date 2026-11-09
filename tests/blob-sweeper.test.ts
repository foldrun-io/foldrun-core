// The blob sweeper (FOL-126): mark, delay, sweep. Nothing referenced is ever
// deleted; nothing is deleted before it has been unreferenced for the delay.
//
//   node --test tests/blob-sweeper.test.ts

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { fsBlobStore, s3BlobStore, bounded, type BlobSweeper } from "../src/blob-store.ts";
import type { BlobStore } from "../src/blob-store.ts";
import { localRevisionStore, type RevisionStore } from "../src/revision-store.ts";
import type { BlobPins, PinHolder, PinKind } from "../src/blob-pins.ts";
import { publish, headsOf, manifestsAt, type Deps } from "../src/publish.ts";
import { blobObjectKey, manifestObjectKey, entryId, sha256Hex, MODE_FILE, type Changes } from "../src/manifest.ts";
import { sweepBlobs, memorySweepMarks, type SweepOptions } from "../src/blob-sweeper.ts";
import { s3Config } from "../src/storage.ts";
import { fakeS3 } from "./fake-s3.ts";

const T = "acme";
const DAY = 86_400_000;
const WS = { tenant: T, workspace: "desk" };
let root: string;
let blobs: BlobStore & BlobSweeper;
let revisions: RevisionStore;
let fp: ReturnType<typeof fakePins>;
let deps: Deps;
let now = Date.parse("2026-11-08T00:00:00Z");
const clock = () => new Date(now);

function fakePins() {
  const held: { tenant: string; kind: PinKind; ref: string; holder: PinHolder }[] = [];
  const pins: BlobPins & { before?: () => Promise<void> } = {
    async pinBlobs(t, shas, h) {
      for (const r of shas) held.push({ tenant: t, kind: "blob", ref: r, holder: h });
    },
    async pinManifests(t, ids, h) {
      for (const r of ids) held.push({ tenant: t, kind: "manifest", ref: r, holder: h });
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
      await pins.before?.();
      if (held.some((x) => x.tenant === t && x.kind === kind && x.ref === ref)) return false;
      await del();
      return true;
    },
  };
  return { pins, held };
}

/** Publish these files onto the workspace's head. */
async function put(files: Record<string, string | null>, ws = WS, d: Deps = deps) {
  const heads = await headsOf(d, ws);
  const m = await manifestsAt(d, ws.tenant, heads);
  const bytes = new Map<string, Buffer>();
  const changes: Changes = {};
  for (const [p, v] of Object.entries(files)) {
    const was = m.authored.files[p] ?? m.state.files[p];
    if (v === null) {
      changes[p] = { op: "delete", base: entryId(was) };
      continue;
    }
    const buf = Buffer.from(v);
    bytes.set(sha256Hex(buf), buf);
    changes[p] = { op: "put", base: was ? entryId(was) : null, sha: sha256Hex(buf), size: buf.length, mode: MODE_FILE };
  }
  const r = await publish(d, { ws, opId: `sweep-test-${Math.random().toString(36).slice(2, 12)}`, by: "t", message: "m", changes, bytesOf: async (s) => bytes.get(s)! });
  return r;
}
const has = async (key: string) => (await blobs.head(key)) !== null;
const blobKey = (text: string) => blobObjectKey(T, sha256Hex(Buffer.from(text)));
const opts = (o: Partial<SweepOptions> = {}): SweepOptions => ({ dryRun: false, delayMs: 7 * DAY, minAgeMs: 0, maxDeletes: 1000, ...o });

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-sweep-"));
  blobs = bounded(fsBlobStore(path.join(root, ".objects")), { backoffMs: 1 });
  revisions = localRevisionStore(path.join(root, ".revisions"));
  fp = fakePins();
  deps = { blobs, revisions, pins: fp.pins };
  now = Date.parse("2026-11-08T00:00:00Z");
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

test("an unreferenced blob is recorded, waits the delay, and is deleted; what a retained revision names never is", async () => {
  const marks = memorySweepMarks(clock);
  await put({ "memory/keep.md": "keep\n", "memory/old.md": "old\n" });
  await put({ "memory/old.md": null }); // the old file leaves the head...
  // ...but the first revision still names it: retained, so live
  let r = await sweepBlobs({ blobs, revisions, pins: fp.pins }, marks, opts());
  assert.equal(r.marked, 0, "everything is reachable from a retained revision");
  // an orphan: uploaded, never committed (a publish that died)
  await blobs.putIfAbsent(blobKey("orphan\n"), Buffer.from("orphan\n"));
  r = await sweepBlobs({ blobs, revisions, pins: fp.pins }, marks, opts());
  assert.equal(r.marked, 1);
  assert.equal(r.deleted, 0);
  assert.equal(await has(blobKey("orphan\n")), true, "recorded, not deleted");
  now += 3 * DAY;
  r = await sweepBlobs({ blobs, revisions, pins: fp.pins }, marks, opts());
  assert.equal(r.waiting, 1);
  assert.equal(await has(blobKey("orphan\n")), true, "still inside the restore window");
  now += 5 * DAY;
  r = await sweepBlobs({ blobs, revisions, pins: fp.pins }, marks, opts());
  assert.equal(r.deleted, 1);
  assert.equal(r.deletedBytes, "orphan\n".length);
  assert.equal(await has(blobKey("orphan\n")), false);
  assert.equal(await has(blobKey("keep\n")), true);
  assert.equal(await has(blobKey("old\n")), true, "named by a retained revision");
  assert.equal(marks.table.size, 0, "the record went with the object");
  assert.ok(marks.runs.length >= 3, "each real run is recorded");
});

test("an object that is referenced again before the delay is cleared, not deleted", async () => {
  const marks = memorySweepMarks(clock);
  await put({ "memory/a.md": "a\n" });
  await blobs.putIfAbsent(blobKey("later\n"), Buffer.from("later\n"));
  await sweepBlobs(deps, marks, opts());
  assert.equal(marks.table.size, 1);
  now += 4 * DAY;
  await put({ "memory/later.md": "later\n" }); // a publish reuses it
  const r = await sweepBlobs(deps, marks, opts());
  assert.equal(marks.table.size, 0, "the record is cleared");
  now += 10 * DAY;
  await sweepBlobs(deps, marks, opts());
  assert.equal(await has(blobKey("later\n")), true);
  assert.equal(r.deleted, 0);
});

test("a pinned blob or manifest (a run's base, a publish in flight) is never deleted, however old", async () => {
  const marks = memorySweepMarks(clock);
  await put({ "memory/a.md": "a\n" });
  await blobs.putIfAbsent(blobKey("pinned-blob\n"), Buffer.from("pinned-blob\n"));
  const text = JSON.stringify({ v: 1, files: { "memory/z.md": { sha: sha256Hex(Buffer.from("under-pinned-manifest\n")), size: 22, mode: MODE_FILE } } });
  const mid = sha256Hex(text);
  await blobs.putIfAbsent(manifestObjectKey(T, mid), Buffer.from(text));
  await blobs.putIfAbsent(blobKey("under-pinned-manifest\n"), Buffer.from("under-pinned-manifest\n"));
  await blobs.putIfAbsent(blobKey("free\n"), Buffer.from("free\n"));
  await fp.pins.pinBlobs(T, [sha256Hex(Buffer.from("pinned-blob\n"))], { kind: "publish", id: "p1" });
  await fp.pins.pinManifests(T, [mid], { kind: "run", id: "run-1/pod" });
  await sweepBlobs(deps, marks, opts());
  now += 30 * DAY;
  const r = await sweepBlobs(deps, marks, opts());
  assert.equal(await has(blobKey("pinned-blob\n")), true);
  assert.equal(await has(manifestObjectKey(T, mid)), true);
  assert.equal(await has(blobKey("under-pinned-manifest\n")), true, "a pinned manifest keeps its blobs");
  assert.equal(await has(blobKey("free\n")), false, "an unpinned orphan beside them goes");
  assert.equal(r.deleted, 1);
  // released: now they are candidates, and wait the delay from the first time they were SEEN unreferenced
  await fp.pins.release(T, { kind: "run", id: "run-1/pod" });
  await fp.pins.release(T, { kind: "publish", id: "p1" });
  let r2 = await sweepBlobs(deps, marks, opts());
  assert.equal(r2.deleted, 0);
  now += 8 * DAY;
  r2 = await sweepBlobs(deps, marks, opts());
  assert.equal(r2.deleted, 3);
});

test("a pruned revision's objects survive the restore-point window", async () => {
  const marks = memorySweepMarks(clock);
  await put({ "state/s.json": "v1" });
  await put({ "state/s.json": "v2" });
  await put({ "state/s.json": "v3" });
  const sws = { ...WS, scope: "state" as const };
  const all = await revisions.revisions(sws);
  await revisions.prune(sws, [all[1].id, all[2].id]); // state retention
  let r = await sweepBlobs(deps, marks, opts());
  assert.ok(r.marked >= 2, "v1 and v2 are unreferenced now");
  now += 6 * DAY; // a database restored to before the prune still finds them
  r = await sweepBlobs(deps, marks, opts());
  assert.equal(r.deleted, 0);
  assert.equal(await has(blobKey("v1")), true);
  now += 2 * DAY;
  r = await sweepBlobs(deps, marks, opts());
  assert.ok(r.deleted >= 2);
  assert.equal(await has(blobKey("v1")), false);
  assert.equal(await has(blobKey("v3")), true, "the head's state stays");
});

test("a dry run reports what it would do and changes nothing, records nothing", async () => {
  const marks = memorySweepMarks(clock);
  await put({ "memory/a.md": "a\n" });
  await blobs.putIfAbsent(blobKey("orphan\n"), Buffer.from("orphan\n"));
  let r = await sweepBlobs(deps, marks, opts({ dryRun: true }));
  assert.equal(r.dryRun, true);
  assert.equal(r.marked, 1);
  assert.equal(marks.table.size, 0, "no record");
  await sweepBlobs(deps, marks, opts()); // a real run records its marks
  now += 8 * DAY;
  r = await sweepBlobs(deps, marks, opts({ dryRun: true }));
  assert.equal(r.wouldDelete, 1);
  assert.equal(r.wouldDeleteBytes, 7);
  assert.equal(r.deleted, 0);
  assert.equal(await has(blobKey("orphan\n")), true);
});

test("an account that was deleted: its objects wait the delay and go, another account's stay", async () => {
  const marks = memorySweepMarks(clock);
  await put({ "memory/a.md": "a\n" }); // acme is alive
  const gone = { tenant: "gone", workspace: "w" };
  await put({ "memory/g.md": "g\n" }, gone);
  await revisions.drop({ tenant: "gone" }); // what tenant delete does: rows and pins
  await sweepBlobs(deps, marks, opts());
  now += 8 * DAY;
  const r = await sweepBlobs(deps, marks, opts());
  assert.ok(r.deleted >= 2, "its blob and its manifests");
  const left: string[] = [];
  for await (const o of blobs.list!("t/gone")) left.push(o.key);
  assert.deepEqual(left, [], "nothing of the deleted account is left");
  assert.equal(await has(blobKey("a\n")), true);
});

test("a database with no revision at all is not trusted: nothing is deleted", async () => {
  const marks = memorySweepMarks(clock);
  await blobs.putIfAbsent(blobKey("x\n"), Buffer.from("x\n"));
  const r = await sweepBlobs(deps, marks, opts());
  assert.match(r.refused ?? "", /holds no revision/);
  now += 30 * DAY;
  const r2 = await sweepBlobs(deps, marks, opts());
  assert.equal(r2.deleted, 0);
  assert.equal(await has(blobKey("x\n")), true);
});

test("a publish that commits between the mark and the delete is seen inside the pin lock", async () => {
  const marks = memorySweepMarks(); // the real clock: revisions are stamped by it, as by the database in production
  await put({ "memory/a.md": "a\n" });
  await blobs.putIfAbsent(blobKey("racy\n"), Buffer.from("racy\n"));
  await sweepBlobs(deps, marks, opts({ delayMs: 0 }));
  await new Promise((r) => setTimeout(r, 5));
  let armed = true;
  fp.pins.before = async () => {
    if (!armed) return;
    armed = false;
    await put({ "memory/racy.md": "racy\n" }); // commits (and releases its pin) after the mark, before the delete
  };
  const r = await sweepBlobs(deps, marks, opts({ delayMs: 0 }));
  assert.equal(r.deleted, 0);
  assert.equal(r.skippedHeld, 1);
  assert.equal(await has(blobKey("racy\n")), true, "the new revision's blob is still there");
});

test("a retained manifest that cannot be read stops the account's sweep: no deletions on guesswork", async () => {
  const marks = memorySweepMarks(clock);
  const first = await put({ "memory/a.md": "a\n" });
  await blobs.putIfAbsent(blobKey("orphan\n"), Buffer.from("orphan\n"));
  await sweepBlobs(deps, marks, opts());
  now += 8 * DAY;
  await blobs.delete(manifestObjectKey(T, first.revision!.authored));
  const r = await sweepBlobs(deps, marks, opts());
  assert.equal(r.errors, 1);
  assert.equal(r.deleted, 0);
  assert.equal(await has(blobKey("orphan\n")), true);
});

test("keys it does not own are left alone; the per-run cap and the minimum age are honoured", async () => {
  const marks = memorySweepMarks(clock);
  await put({ "memory/a.md": "a\n" });
  await blobs.putIfAbsent(`t/${T}/somethingelse/readme`, Buffer.from("not ours"));
  for (const i of [1, 2, 3]) await blobs.putIfAbsent(blobKey(`o${i}\n`), Buffer.from(`o${i}\n`));
  await sweepBlobs(deps, marks, opts());
  now += 8 * DAY;
  let r = await sweepBlobs(deps, marks, opts({ maxDeletes: 2 }));
  assert.equal(r.deleted, 2, "capped");
  assert.equal(r.foreign, 1);
  assert.equal(await has(`t/${T}/somethingelse/readme`), true);
  r = await sweepBlobs(deps, marks, opts({ maxDeletes: 2, minAgeMs: 365 * DAY })); // everything is "too young"
  assert.equal(r.deleted, 0);
  r = await sweepBlobs(deps, marks, opts({ maxDeletes: 2 }));
  assert.equal(r.deleted, 1);
});

test("on an S3-compatible store: paged listing, tenants by prefix, and the same rules", async () => {
  const server = await fakeS3("test-bucket");
  const ENV = { FOLDRUN_S3_ENDPOINT: server.endpoint, FOLDRUN_S3_BUCKET: "test-bucket", FOLDRUN_S3_ACCESS_KEY_ID: "AKIATEST", FOLDRUN_S3_SECRET_ACCESS_KEY: "secret-test", FOLDRUN_S3_PATH_STYLE: "true" };
  const saved = Object.fromEntries(Object.keys(ENV).map((k) => [k, process.env[k]]));
  Object.assign(process.env, ENV);
  try {
    const s3 = bounded(s3BlobStore(s3Config()!), { backoffMs: 1 });
    const d: Deps = { blobs: s3, revisions, pins: fp.pins };
    const marks = memorySweepMarks(clock);
    await put({ "memory/a.md": "a\n", "memory/b.md": "b\n" }, WS, d);
    await put({ "memory/g.md": "g\n" }, { tenant: "gone", workspace: "w" }, d);
    await revisions.drop({ tenant: "gone" });
    for (const i of [1, 2, 3]) await s3.putIfAbsent(blobKey(`s3orphan${i}\n`), Buffer.from(`s3orphan${i}\n`));
    assert.deepEqual((await s3.tenants!()).sort(), ["acme", "gone"]);
    const listed: string[] = [];
    for await (const o of s3.list!(`t/${T}`)) listed.push(o.key);
    assert.ok(listed.length >= 6, `paged listing crossed the page size: ${listed.length}`);
    await sweepBlobs({ blobs: s3, revisions, pins: fp.pins }, marks, opts());
    now += 8 * DAY;
    const r = await sweepBlobs({ blobs: s3, revisions, pins: fp.pins }, marks, opts());
    assert.ok(r.deleted >= 5, `3 orphans + the deleted account's objects: ${r.deleted}`);
    assert.deepEqual(await s3.tenants!(), ["acme"], "no object, no prefix");
    assert.equal((await s3.head(blobKey("a\n"))) !== null, true);
  } finally {
    await server.close();
    for (const [k, v] of Object.entries(saved)) v === undefined ? delete process.env[k] : (process.env[k] = v);
  }
});
