// FOL-126 fixes (8 Nov): a run's copy-back is published against the revisions
// its stage-in started from (and those are pinned while it runs), and `state/`
// checkpoints are kept in a window.
//
//   node --test tests/pinned-base-and-retention.test.ts

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { workspaceDir, writeWorkspaceFile } from "../src/store.ts";
import { fsBlobStore, bounded } from "../src/blob-store.ts";
import { localRevisionStore, type RevisionStore } from "../src/revision-store.ts";
import type { BlobPins, PinHolder, PinKind } from "../src/blob-pins.ts";
import {
  setRevisionBackend,
  resetJournalForTests,
  flushRevisions,
  readAtHead,
  pinRunBase,
  repinRunBase,
  pruneStateNow,
  recordStepOutputs,
} from "../src/workspace-revisions.ts";
import { applyContainerChanges, writeBaseRevision, readBaseRevision, dropHandedIn } from "../src/run-container.ts";
import { pruneStateRevisions } from "../src/state-retention.ts";
import { headsOf, manifestsAt, publish, type Deps } from "../src/publish.ts";
import { EMPTY_MANIFEST_ID, entryId, MODE_FILE, sha256Hex } from "../src/manifest.ts";

const T = "acme";
const W = "desk";
const ON = { journal: () => true, read: () => true };
const sha = (s: string) => crypto.createHash("sha256").update(s).digest("hex");

/** An in-memory BlobPins: holders and what they hold. */
function fakePins() {
  const held = new Map<string, { kind: PinKind; ref: string; holder: PinHolder }[]>();
  const all = () => [...held.values()].flat();
  const pins: BlobPins = {
    async pinBlobs(t, shas, h) {
      for (const r of shas) held.set(`${t}:${h.kind}:${h.id}`, [...(held.get(`${t}:${h.kind}:${h.id}`) ?? []).filter((x) => x.ref !== r), { kind: "blob", ref: r, holder: h }]);
    },
    async pinManifests(t, ids, h) {
      for (const r of ids) held.set(`${t}:${h.kind}:${h.id}`, [...(held.get(`${t}:${h.kind}:${h.id}`) ?? []).filter((x) => x.ref !== r), { kind: "manifest", ref: r, holder: h }]);
    },
    async release(t, h) {
      const n = held.get(`${t}:${h.kind}:${h.id}`)?.length ?? 0;
      held.delete(`${t}:${h.kind}:${h.id}`);
      return n;
    },
    async renew() {
      return 0;
    },
    async isPinned(_t, kind, ref) {
      return all().some((x) => x.kind === kind && x.ref === ref);
    },
    async isPinnedBeyondRevisions(_t, kind, ref) {
      return all().some((x) => x.kind === kind && x.ref === ref && x.holder.kind !== "revision");
    },
    async live() {
      return { manifests: all().filter((x) => x.kind === "manifest").map((x) => x.ref), blobs: all().filter((x) => x.kind === "blob").map((x) => x.ref) };
    },
    async guardDelete(_t, _k, _r, del) {
      await del();
      return true;
    },
  };
  return { pins, held, all };
}

let root: string;
let deps: Deps;
let inner: RevisionStore;
let fp: ReturnType<typeof fakePins>;
let ws: string;
const text = async (rel: string) => (await readAtHead(T, W, rel))?.toString("utf8") ?? null;
const heads = async () => manifestsAt(deps, T, await headsOf(deps, { tenant: T, workspace: W }));

function sandbox(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-sbx-"));
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), body);
  }
  return dir;
}

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-pin-"));
  process.env.FOLDRUN_DATA = root;
  ws = workspaceDir(T, W);
  fs.mkdirSync(path.join(ws, "agents", "writer"), { recursive: true });
  fs.writeFileSync(path.join(ws, "AGENTS.md"), "---\nname: desk\n---\n");
  fs.mkdirSync(path.join(ws, "memory"), { recursive: true });
  fs.writeFileSync(path.join(ws, "memory", "a.md"), "a0\n");
  fs.writeFileSync(path.join(ws, "memory", "b.md"), "b0\n");
  fs.writeFileSync(path.join(ws, "memory", "history.md"), 'row 0\n');
  fp = fakePins();
  inner = localRevisionStore(path.join(root, ".revisions"));
  deps = { blobs: bounded(fsBlobStore(path.join(root, ".objects")), { backoffMs: 1 }), revisions: inner, pins: fp.pins };
  setRevisionBackend(deps, { ...ON, stateRetention: () => ({ keep: 3, days: 0 }), retentionEveryMs: 0 });
  // the workspace as it is before any run: its tree is the baseline revision
  writeWorkspaceFile(T, W, "memory/a.md", "a0\n", { by: "test" });
  await flushRevisions({ tenant: T, workspace: W });
});
afterEach(() => {
  setRevisionBackend(null);
  resetJournalForTests();
  fs.rmSync(root, { recursive: true, force: true });
  delete process.env.FOLDRUN_DATA;
});

// -------------------------------------------------------------- pinned base

test("stage-in records the revisions the run starts from and pins their manifests; release lets go", async () => {
  const h0 = await headsOf(deps, { tenant: T, workspace: W });
  const pin = await pinRunBase(T, W, "run-1/pod-a");
  assert.ok(pin);
  assert.equal(pin!.base.workspace, h0.workspace!.id);
  assert.ok(fp.all().some((x) => x.holder.kind === "run" && x.holder.id === "run-1/pod-a" && x.ref === h0.workspace!.authored), "the base's manifest is pinned for the run");
  // it can be written down for a driver that takes over, and read back
  await writeBaseRevision(ws, "run-1", "pod-a", pin!.base);
  assert.deepEqual(await readBaseRevision(ws, "run-1", "pod-a"), pin!.base);
  await pin!.release();
  assert.equal(fp.all().filter((x) => x.holder.kind === "run").length, 0);
  await dropHandedIn(ws, "run-1", "pod-a");
  assert.equal(await readBaseRevision(ws, "run-1", "pod-a"), undefined, "erased with the step's hand-in record");
  await pin!.release(); // safe to repeat
});

test("no pin (and nothing changes) when revisions are off or there is no head yet", async () => {
  setRevisionBackend(deps, { journal: () => false, read: () => false });
  assert.equal(await pinRunBase(T, W, "run-x/pod"), null);
  setRevisionBackend(deps, ON);
  assert.equal(await pinRunBase(T, "no-such-workspace", "run-x/pod"), null, "a workspace with no head: the baseline will hold the whole tree");
});

test("a pinned base is published against: a head that moved on one path is a conflict there, the other paths still land", async () => {
  const pin = await pinRunBase(T, W, "run-2/pod-a");
  assert.ok(pin);
  // a writer reaches the head (not the folder) while the step runs
  const cur = await headsOf(deps, { tenant: T, workspace: W });
  const a1 = Buffer.from("a1 from someone else\n");
  const r = await publish(deps, {
    ws: { tenant: T, workspace: W },
    opId: "someone-else-1",
    by: "user:x",
    message: "edit",
    changes: { "memory/a.md": { op: "put", base: entryId((await manifestsAt(deps, T, cur)).authored.files["memory/a.md"]), sha: sha256Hex(a1), size: a1.length, mode: MODE_FILE } },
    bytesOf: async () => a1,
  });
  assert.equal(r.status, "committed");
  const out = sandbox({ "memory/a.md": "a2 from the step\n", "memory/b.md": "b1 from the step\n" });
  const applied = applyContainerChanges(ws, out, { "memory/a.md": sha("a0\n"), "memory/b.md": sha("b0\n") }, undefined, undefined, {
    revision: { tenant: T, runId: "run-2", step: "pod-a", base: pin!.base },
  });
  assert.deepEqual(applied.sort(), ["memory/a.md", "memory/b.md"]);
  await flushRevisions({ tenant: T, workspace: W });
  await pin!.release();
  assert.equal(await text("memory/a.md"), "a1 from someone else\n", "the head's version stays");
  assert.equal(await text("memory/b.md"), "b1 from the step\n", "a path nobody else touched goes through");
  const m = await heads();
  const copies = Object.keys(m.authored.files).filter((p) => /^memory\/a\.conflict-[0-9a-f]{12}\.md$/.test(p));
  assert.equal(copies.length, 1, `the step's version is kept beside it: ${Object.keys(m.authored.files).join(", ")}`);
  assert.equal((await readAtHead(T, W, copies[0]))!.toString(), "a2 from the step\n");
});

test("an append-merged file lands merged on the head (the pinned base must not turn a merge into a conflict)", async () => {
  // the ledger is in the head
  writeWorkspaceFile(T, W, "memory/history.md", 'row 0\n', { by: "test" });
  await flushRevisions({ tenant: T, workspace: W });
  const pin = await pinRunBase(T, W, "run-3/pod-a");
  // another writer appends (folder and head), while the step appends too
  writeWorkspaceFile(T, W, "memory/history.md", 'row 0\nrow other\n', { by: "user:x" });
  await flushRevisions({ tenant: T, workspace: W });
  const out = sandbox({ "memory/history.md": 'row 0\nrow step\n' });
  applyContainerChanges(ws, out, { "memory/history.md": sha('row 0\n') }, undefined, undefined, { revision: { tenant: T, runId: "run-3", step: "pod-a", base: pin!.base } });
  await flushRevisions({ tenant: T, workspace: W });
  await pin!.release();
  assert.equal(fs.readFileSync(path.join(ws, "memory", "history.md"), "utf8"), 'row 0\nrow other\nrow step\n');
  assert.equal(await text("memory/history.md"), 'row 0\nrow other\nrow step\n', "the head has the merge");
  const m = await heads();
  assert.deepEqual(Object.keys(m.authored.files).filter((p) => p.includes("conflict")), []);
});

test("a base whose revision can no longer be read falls back to the folder's sha, and the write still lands", async () => {
  const out = sandbox({ "memory/b.md": "b1\n" });
  const gone = { workspace: "rev_doesnotexist0000000000", state: null };
  applyContainerChanges(ws, out, { "memory/b.md": sha("b0\n") }, undefined, undefined, { revision: { tenant: T, runId: "run-4", step: "pod-a", base: gone } });
  await flushRevisions({ tenant: T, workspace: W });
  assert.equal(await text("memory/b.md"), "b1\n");
});

test("a driver that takes a step over pins the recorded base again; a base that is gone is null", async () => {
  const pin = await pinRunBase(T, W, "run-5/pod-a");
  await writeBaseRevision(ws, "run-5", "pod-a", pin!.base);
  const recorded = (await readBaseRevision(ws, "run-5", "pod-a"))!;
  const again = await repinRunBase(T, W, recorded, "run-5/pod-a");
  assert.ok(again);
  assert.deepEqual(again!.base, pin!.base);
  assert.equal(await repinRunBase(T, W, { workspace: "rev_gone", state: null }, "run-5/pod-b"), null);
  await again!.release();
});

test("without a tenant or without a backend the copy-back is as before (no revision, no pin)", async () => {
  setRevisionBackend(null);
  assert.equal(await pinRunBase(T, W, "run-6/pod"), null);
  const out = sandbox({ "memory/b.md": "b9\n" });
  applyContainerChanges(ws, out, { "memory/b.md": sha("b0\n") }, undefined, undefined, {});
  assert.equal(fs.readFileSync(path.join(ws, "memory", "b.md"), "utf8"), "b9\n");
});

// -------------------------------------------------------------- state retention

async function checkpoints(n: number) {
  for (let i = 1; i <= n; i++) {
    recordStepOutputs(T, W, [{ path: "state/s.json", base: i === 1 ? null : sha(`{"i":${i - 1}}`), after: Buffer.from(`{"i":${i}}`) }], { runId: `r${i}`, step: i });
    // keep the folder in step with what the head is told
    fs.mkdirSync(path.join(ws, "state"), { recursive: true });
    fs.writeFileSync(path.join(ws, "state", "s.json"), `{"i":${i}}`);
    await flushRevisions({ tenant: T, workspace: W });
  }
}
const stateRevs = () => inner.revisions({ tenant: T, workspace: W, scope: "state" }, { limit: 500 });

test("retention keeps the newest N checkpoints and the head, and the commit that follows a step does the pruning", async () => {
  await checkpoints(8);
  const left = await stateRevs();
  assert.ok(left.length <= 4 && left.length >= 3, `kept the window (3) plus at most the one being committed: ${left.length}`);
  assert.equal((await heads()).state.files["state/s.json"] !== undefined, true);
  assert.equal(await text("state/s.json"), '{"i":8}', "the current state is intact");
});

test("a checkpoint a running step started from is not pruned until it lets go", async () => {
  await checkpoints(2);
  const pin = await pinRunBase(T, W, "run-7/pod-a"); // pins the current state head's manifest
  const pinned = (await headsOf(deps, { tenant: T, workspace: W })).state!;
  await checkpoints(8);
  const mid = await stateRevs();
  assert.ok(mid.some((r) => r.id === pinned.id), "held by the run");
  await pin!.release();
  const res = await pruneStateNow(T, W);
  assert.ok(res && res.pruned >= 1);
  const after = await stateRevs();
  assert.equal(after.some((r) => r.id === pinned.id), false, "gone once released");
  assert.equal(after.length, 3);
});

test("the window is by count AND age; 0 switches a limit off; the head is never pruned; the workspace head is not touched", async () => {
  await checkpoints(1);
  const sws = { tenant: T, workspace: W, scope: "state" as const };
  // age: nothing is older than a day yet
  let res = await pruneStateRevisions(deps, { tenant: T, workspace: W }, { keep: 0, days: 1 });
  assert.equal(res.pruned, 0);
  // far in the future everything is old — except the head
  res = await pruneStateRevisions(deps, { tenant: T, workspace: W }, { keep: 0, days: 1 }, Date.now() + 400 * 86_400_000);
  assert.equal((await inner.revisions(sws, { limit: 50 })).length, 1);
  // both off: nothing
  res = await pruneStateRevisions(deps, { tenant: T, workspace: W }, { keep: 0, days: 0 });
  assert.deepEqual(res, { pruned: 0, kept: 0, held: 0 });
  assert.ok((await headsOf(deps, { tenant: T, workspace: W })).workspace, "the source head is untouched");
});

test("without a retention setting from the host nothing is ever pruned", async () => {
  setRevisionBackend(deps, ON);
  await checkpoints(6);
  assert.equal((await stateRevs()).length >= 6, true);
  assert.equal(await pruneStateNow(T, W), null);
});

test("EMPTY manifest is never pinned for a run (it is not stored)", async () => {
  const pin = await pinRunBase(T, W, "run-8/pod-a");
  assert.equal(fp.all().some((x) => x.ref === EMPTY_MANIFEST_ID && x.holder.kind === "run"), false);
  await pin!.release();
});
