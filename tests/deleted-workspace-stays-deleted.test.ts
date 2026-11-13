// A workspace deleted on one pod must not come back from another pod's folder
// (FOL-126 follow-up). On a pod's own disk (the mirror, or FOLDRUN_DATA_LOCAL)
// a folder that outlives its heads is a stale copy, not a new workspace: a
// queued journal entry or a reconcile there used to find no heads, take the
// folder for a baseline and publish all of it as a first revision. A workspace
// this pod has never seen heads for (made here) still gets its first revision.
//
//   node --test tests/deleted-workspace-stays-deleted.test.ts

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { writeWorkspaceFile, workspaceDir } from "../src/store.ts";
import { fsBlobStore, bounded } from "../src/blob-store.ts";
import { localRevisionStore } from "../src/revision-store.ts";
import { setRevisionBackend, resetJournalForTests, flushRevisions, recoverJournal, reconcileWorkspace, syncFromHeads, dropWorkspaceRevisions } from "../src/workspace-revisions.ts";
import { setMirrorGate, setLocalDiskGate } from "../src/mirror-base.ts";
import { headsOf, type Deps } from "../src/publish.ts";

const T = "acme";
const W = "desk";
let shared: string;
let podA: string;
let podB: string;
let deps: Deps;

const on = (pod: string) => (process.env.FOLDRUN_DATA = pod);
const heads = async () => {
  const h = await headsOf(deps, { tenant: T, workspace: W });
  return !!(h.workspace || h.state);
};
const make = () => {
  fs.mkdirSync(path.join(workspaceDir(T, W), "agents"), { recursive: true });
  fs.writeFileSync(path.join(workspaceDir(T, W), "AGENTS.md"), "---\nname: desk\n---\n");
};

beforeEach(() => {
  shared = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-gone-shared-"));
  podA = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-gone-a-"));
  podB = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-gone-b-"));
  deps = { blobs: bounded(fsBlobStore(path.join(shared, ".objects")), { backoffMs: 1 }), revisions: localRevisionStore(path.join(shared, ".revisions")) };
  setRevisionBackend(deps, { journal: () => true, read: () => true });
  setMirrorGate(null);
  setLocalDiskGate(null);
});
afterEach(() => {
  setRevisionBackend(null);
  setMirrorGate(null);
  setLocalDiskGate(null);
  resetJournalForTests();
  for (const d of [shared, podA, podB]) fs.rmSync(d, { recursive: true, force: true });
  delete process.env.FOLDRUN_DATA;
});

/** Pod A makes the workspace and publishes it; pod B (mirror on) syncs a copy. */
async function twoPods() {
  setMirrorGate(() => true);
  on(podA);
  make();
  writeWorkspaceFile(T, W, "memory/a.md", "a\n", { by: "user:a" });
  await flushRevisions();
  assert.ok(await heads());
  on(podB);
  assert.equal(await syncFromHeads(T, W), "synced");
}
/** Pod A deletes it: heads and history go, A's folder with them. */
async function deleteOnA() {
  on(podA);
  await dropWorkspaceRevisions(T, W, () => fs.rmSync(workspaceDir(T, W), { recursive: true, force: true }));
  assert.equal(await heads(), false);
}

test("mirror on: a queued entry on a pod that still has the folder does not bring a deleted workspace back", async () => {
  await twoPods();
  await deleteOnA();
  on(podB);
  writeWorkspaceFile(T, W, "memory/late.md", "late\n", { by: "user:b" }); // queued here before B's sync saw the delete
  await flushRevisions();
  assert.equal(await heads(), false, "no first revision from a stale folder");
  // the sync is what removes the stale folder, not the commit
  assert.equal(await syncFromHeads(T, W), "removed");
  assert.equal(fs.existsSync(workspaceDir(T, W)), false);
});

test("mirror on: a reconcile on a pod that still has the folder does not bring a deleted workspace back", async () => {
  await twoPods();
  await deleteOnA();
  on(podB);
  fs.writeFileSync(path.join(workspaceDir(T, W), "memory", "hand.md"), "x\n");
  await reconcileWorkspace(T, W);
  assert.equal(await heads(), false);
});

test("mirror on: a workspace made on this pod still gets its first revision, also through a journal replay after a restart", async () => {
  setMirrorGate(() => true);
  on(podB);
  make();
  writeWorkspaceFile(T, W, "memory/new.md", "new\n", { by: "user:b" });
  resetJournalForTests(); // the pod died before the entry was committed; its journal entry stays
  assert.equal(await heads(), false);
  await recoverJournal({ minAgeMs: 0 });
  await flushRevisions();
  assert.ok(await heads(), "the replay published the first revision");
});

test("own disk, mirror off: a stale folder does not bring a deleted workspace back; a new one still publishes", async () => {
  setLocalDiskGate(() => true);
  on(podB);
  make();
  writeWorkspaceFile(T, W, "memory/new.md", "new\n", { by: "user:b" });
  await flushRevisions();
  assert.ok(await heads(), "made here: first revision");
  await deps.revisions.drop({ tenant: T, workspace: W }); // deleted elsewhere
  writeWorkspaceFile(T, W, "memory/late.md", "late\n", { by: "user:b" });
  await flushRevisions();
  assert.equal(await heads(), false);
});

test("shared volume: unchanged, the folder is the truth", async () => {
  on(podB);
  make();
  writeWorkspaceFile(T, W, "memory/new.md", "new\n", { by: "user:b" });
  await flushRevisions();
  await deps.revisions.drop({ tenant: T, workspace: W });
  writeWorkspaceFile(T, W, "memory/late.md", "late\n", { by: "user:b" });
  await flushRevisions();
  assert.ok(await heads(), "as before: no gate, no change");
});

test("a workspace deleted and made again on the same pod gets its first revision", async () => {
  setMirrorGate(() => true);
  on(podA);
  make();
  writeWorkspaceFile(T, W, "memory/a.md", "a\n", { by: "user:a" });
  await flushRevisions();
  await dropWorkspaceRevisions(T, W, () => fs.rmSync(workspaceDir(T, W), { recursive: true, force: true }));
  make();
  writeWorkspaceFile(T, W, "memory/b.md", "b\n", { by: "user:a" });
  await flushRevisions();
  assert.ok(await heads());
});
