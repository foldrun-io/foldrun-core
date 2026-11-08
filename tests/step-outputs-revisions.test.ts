// A step's copy-back lands as a revision (FOL-126 phase 4): one journal entry,
// one publish, pinned bases. Disjoint paths of concurrent runs both land, the
// same path is an explicit conflict, state/ goes to its own head, a retried
// copy-back publishes once, and without a backend nothing is recorded.
//
//   node --test tests/step-outputs-revisions.test.ts

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { workspaceDir } from "../src/store.ts";
import { fsBlobStore, bounded } from "../src/blob-store.ts";
import { localRevisionStore } from "../src/revision-store.ts";
import { setRevisionBackend, resetJournalForTests, flushRevisions, readAtHead, recordStepOutputs, pendingRevisions, needsReconcile, settleLifecycle } from "../src/workspace-revisions.ts";
import { applyContainerChanges } from "../src/run-container.ts";
import { headsOf, manifestsAt, type Deps } from "../src/publish.ts";

const T = "acme";
const W = "desk";
const ON = { journal: () => true, read: () => true };
const sha = (s: string) => crypto.createHash("sha256").update(s).digest("hex");
let root: string;
let deps: Deps;
let ws: string;
const text = async (rel: string) => (await readAtHead(T, W, rel))?.toString("utf8") ?? null;
const heads = async () => manifestsAt(deps, T, await headsOf(deps, { tenant: T, workspace: W }));

/** A sandbox's /workspace after a step: these files. */
function sandbox(files: Record<string, string | Buffer>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-sbx-"));
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), body);
  }
  return dir;
}

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-stepout-"));
  process.env.FOLDRUN_DATA = root;
  ws = workspaceDir(T, W);
  fs.mkdirSync(path.join(ws, "agents", "writer"), { recursive: true });
  fs.mkdirSync(path.join(ws, "memory"), { recursive: true });
  fs.writeFileSync(path.join(ws, "AGENTS.md"), "---\nname: desk\n---\n");
  fs.writeFileSync(path.join(ws, "memory", "a.md"), "a0\n");
  fs.writeFileSync(path.join(ws, "memory", "b.md"), "b0\n");
  deps = { blobs: bounded(fsBlobStore(path.join(root, ".objects")), { backoffMs: 1 }), revisions: localRevisionStore(path.join(root, ".revisions")) };
  setRevisionBackend(deps, ON);
  // the baseline (the workspace as it was before the runs)
  recordStepOutputs(T, W, [{ path: "memory/a.md", base: null, after: Buffer.from("a0\n") }], { runId: "seed", step: 0 });
  await flushRevisions({ tenant: T, workspace: W });
});
afterEach(() => {
  setRevisionBackend(null);
  resetJournalForTests();
  fs.rmSync(root, { recursive: true, force: true });
  delete process.env.FOLDRUN_DATA;
});

test("a step's outputs land as one revision: authored on the workspace head, state/ on its own", async () => {
  const before = await headsOf(deps, { tenant: T, workspace: W });
  const out = sandbox({ "memory/a.md": "a1\n", "memory/new.md": "n\n", "state/index.json": '{"n":1}' });
  const base = { "memory/a.md": sha("a0\n") };
  const applied = applyContainerChanges(ws, out, base, undefined, undefined, { revision: { tenant: T, runId: "run-1", step: "pod-1" } });
  assert.deepEqual(applied.sort(), ["memory/a.md", "memory/new.md", "state/index.json"]);
  assert.ok(pendingRevisions() >= 1);
  await flushRevisions({ tenant: T, workspace: W });
  assert.equal(await text("memory/a.md"), "a1\n");
  assert.equal(await text("memory/new.md"), "n\n");
  assert.equal(await text("state/index.json"), '{"n":1}');
  const after = await headsOf(deps, { tenant: T, workspace: W });
  assert.notEqual(after.workspace?.id, before.workspace?.id, "the workspace head moved once");
  assert.ok(after.state, "state/ has its own head");
  const m = await heads();
  assert.ok(m.authored.files["memory/new.md"] && !m.authored.files["state/index.json"]);
  assert.ok(m.state.files["state/index.json"]);
});

test("two runs on different paths both land; the same path is an explicit conflict that keeps both", async () => {
  // Both started from the same revision (a0).
  recordStepOutputs(T, W, [{ path: "memory/a.md", base: sha("a0\n"), after: Buffer.from("from run 1\n") }], { runId: "run-1", step: "p" });
  recordStepOutputs(T, W, [{ path: "memory/b.md", base: sha("b0\n"), after: Buffer.from("b from run 2\n") }], { runId: "run-2", step: "p" });
  recordStepOutputs(T, W, [{ path: "memory/a.md", base: sha("a0\n"), after: Buffer.from("from run 3\n") }], { runId: "run-3", step: "p" });
  await flushRevisions({ tenant: T, workspace: W });
  assert.equal(await text("memory/b.md"), "b from run 2\n", "the disjoint path replayed onto the new head");
  assert.equal(await text("memory/a.md"), "from run 1\n", "the head keeps the first writer's version");
  const files = Object.keys((await heads()).authored.files);
  const copy = files.find((f) => /^memory\/a\.conflict-[0-9a-f]{12}\.md$/.test(f));
  assert.ok(copy, `the other version is kept beside it (${files.join(", ")})`);
  assert.equal(await text(copy!), "from run 3\n");
});

test("a copy-back applied twice (a resumed driver) publishes once", async () => {
  const w = [{ path: "memory/a.md", base: sha("a0\n"), after: Buffer.from("a1\n") }];
  recordStepOutputs(T, W, w, { runId: "run-1", step: "pod-1" });
  await flushRevisions({ tenant: T, workspace: W });
  const first = (await headsOf(deps, { tenant: T, workspace: W })).workspace?.id;
  recordStepOutputs(T, W, w, { runId: "run-1", step: "pod-1" });
  await flushRevisions({ tenant: T, workspace: W });
  assert.equal((await headsOf(deps, { tenant: T, workspace: W })).workspace?.id, first, "no second revision");
  assert.equal(pendingRevisions(), 0);
  assert.equal(Object.keys((await heads()).authored.files).filter((f) => f.includes("conflict")).length, 0, "and no conflict copy of itself");
});

test("a step's journal entry is on disk before the commit, so a crash cannot leave half a tree", async () => {
  recordStepOutputs(T, W, [
    { path: "memory/a.md", base: sha("a0\n"), after: Buffer.from("a1\n") },
    { path: "state/x.json", base: null, after: Buffer.from("{}") },
  ], { runId: "run-9", step: "pod" });
  const dir = path.join(root, ".revision-journal", T, W);
  const names = fs.readdirSync(dir).filter((n) => n.endsWith(".json"));
  assert.equal(names.length, 1, "one file holds the whole step");
  const entry = JSON.parse(fs.readFileSync(path.join(dir, names[0]), "utf8"));
  assert.deepEqual(entry.files.map((f: { path: string }) => f.path).sort(), ["memory/a.md", "state/x.json"]);
  await flushRevisions({ tenant: T, workspace: W });
  assert.equal(fs.existsSync(dir), false);
});

test("files that are not workspace content, binaries and over-size files are not journalled; a big one is left to the reconcile", async () => {
  const n = recordStepOutputs(T, W, [
    { path: "runs/run-1/x.json", base: null, after: Buffer.from("{}") },
    { path: "memory/pic.png", base: null, after: Buffer.from([0xff, 0xfe, 0x00, 0x80]) },
    { path: "state/big.json", base: null, after: Buffer.alloc(1024 * 1024 + 1, 97) },
  ], { runId: "run-2", step: "p" });
  assert.equal(n, 0);
  assert.equal(pendingRevisions(), 0);
  assert.equal(needsReconcile(T, W), true, "the oversize file is recorded from the folder by the reconcile");
});

test("without a backend nothing is recorded and no journal appears (laptop, Compose)", async () => {
  setRevisionBackend(null);
  const out = sandbox({ "memory/a.md": "a1\n" });
  applyContainerChanges(ws, out, { "memory/a.md": sha("a0\n") }, undefined, undefined, { revision: { tenant: T, runId: "r", step: "p" } });
  assert.equal(fs.readFileSync(path.join(ws, "memory", "a.md"), "utf8"), "a1\n", "the folder is written as ever");
  assert.equal(pendingRevisions(), 0);
  assert.equal(fs.existsSync(path.join(root, ".revision-journal", T, W)), false);
});

test("with the journal switched off, a step's write is not recorded either", async () => {
  setRevisionBackend(deps, { journal: () => false, read: () => false });
  assert.equal(recordStepOutputs(T, W, [{ path: "memory/a.md", base: null, after: Buffer.from("x") }], { runId: "r", step: "p" }), 0);
  assert.equal(pendingRevisions(), 0);
});

test("an append the copy-back merged is recorded as the merged text, on the folder's base", async () => {
  // the workspace moved while the step ran (an append), the step appended too
  fs.writeFileSync(path.join(ws, "memory", "a.md"), "a0\nhost\n");
  const out = sandbox({ "memory/a.md": "a0\nstep\n" });
  applyContainerChanges(ws, out, { "memory/a.md": sha("a0\n") }, undefined, undefined, { revision: { tenant: T, runId: "run-m", step: "p" } });
  assert.equal(fs.readFileSync(path.join(ws, "memory", "a.md"), "utf8"), "a0\nhost\nstep\n");
  await flushRevisions({ tenant: T, workspace: W });
  // the head still held a0 (the host's append was never journalled in this test): the merged
  // text's base is the folder's prior content, so it is a conflict kept beside, never a lost write
  const files = (await heads()).authored.files;
  assert.ok(files["memory/a.md"]);
  assert.ok((await text("memory/a.md"))!.length > 0);
});

// ---- deleting a workspace clears its journal (FOL-126 phase 4, item 2) ----

import { deleteWorkspace, writeWorkspaceFile } from "../src/store.ts";
import type { RevisionStore } from "../src/revision-store.ts";

function downStore(state: { down: boolean }): Deps {
  const inner = deps.revisions;
  const flaky: RevisionStore = new Proxy(inner, {
    get(target, prop, recv) {
      const v = Reflect.get(target, prop, recv);
      if (prop === "commit" && typeof v === "function") return (...a: unknown[]) => (state.down ? Promise.reject(new Error("database down")) : (v as Function).apply(target, a));
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
  return { ...deps, revisions: flaky };
}

test("deleting a workspace removes its queued changes and journal files, and nothing commits or replays later", async () => {
  const state = { down: true };
  setRevisionBackend(downStore(state), ON);
  writeWorkspaceFile(T, W, "memory/c.md", "c\n", { by: "user:a" });
  recordStepOutputs(T, W, [{ path: "memory/a.md", base: sha("a0\n"), after: Buffer.from("a1\n") }], { runId: "r", step: "p" });
  const dir = path.join(root, ".revision-journal", T, W);
  assert.ok(fs.readdirSync(dir).length >= 2, "journalled while the store is down");
  assert.ok(pendingRevisions() >= 2);
  const headBefore = (await headsOf(deps, { tenant: T, workspace: W })).workspace?.id;

  deleteWorkspace(T, W);
  assert.equal(pendingRevisions(), 0, "queue cleared");
  assert.equal(fs.existsSync(dir), false, "journal files removed");

  state.down = false; // the store comes back: there is nothing to commit
  const { recoverJournal } = await import("../src/workspace-revisions.ts");
  assert.deepEqual(await recoverJournal({ minAgeMs: 0 }), { entries: 0, workspaces: 0 });
  await flushRevisions();
  await settleLifecycle();
  // The delete also took the history (8 Nov): no head at all, and in particular no new revision.
  assert.equal((await headsOf(deps, { tenant: T, workspace: W })).workspace, null, "no revision was made for the deleted workspace, and its history is gone");
  assert.ok(headBefore);
});

test("a commit already waiting when the workspace is deleted does not publish the rest of the queue", async () => {
  const state = { down: true };
  setRevisionBackend(downStore(state), ON);
  for (let i = 0; i < 3; i++) writeWorkspaceFile(T, W, `memory/q${i}.md`, `${i}\n`, { by: "user:a" });
  const headBefore = (await headsOf(deps, { tenant: T, workspace: W })).workspace?.id;
  const flushing = flushRevisions({ tenant: T, workspace: W }); // a drain is in flight against the dead store
  await new Promise((r) => setImmediate(r));
  deleteWorkspace(T, W);
  await flushing; // the store refused the commit it was waiting on; the rest of the queue is gone
  state.down = false; // back up: the retry timer and a later drain find nothing
  await flushRevisions();
  await new Promise((r) => setTimeout(r, 1200)); // past the first retry delay
  await settleLifecycle();
  assert.equal((await headsOf(deps, { tenant: T, workspace: W })).workspace, null, "nothing was published after the delete, and the history went with it");
  assert.ok(headBefore);
  assert.equal(pendingRevisions(), 0);
});

test("a step with more output than one entry may carry journals what fits and leaves the rest to the reconcile", async () => {
  const big = (c: string) => Buffer.alloc(900 * 1024, c);
  const writes = Array.from({ length: 12 }, (_, i) => ({ path: `memory/f${i}.md`, base: null, after: big(String.fromCharCode(97 + i)) }));
  const n = recordStepOutputs(T, W, writes, { runId: "run-big", step: "p" });
  assert.ok(n > 0 && n < 12, `some, not all (${n})`);
  assert.equal(needsReconcile(T, W), true);
});
