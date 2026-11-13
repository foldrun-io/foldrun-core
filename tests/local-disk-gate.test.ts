// A pod whose data root is its own disk (FOLDRUN_DATA_LOCAL=1, an emptyDir)
// with the mirror OFF (Kousha's review, 14 Nov 2026): its folders are not the
// truth about anything, so the reconcile publishes nothing from them, the
// orphan sweep removes no history, and the journal recovery removes no entry
// because a folder is missing here. On a shared volume all three still do.
//
//   node --test tests/local-disk-gate.test.ts

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { workspaceDir, writeWorkspaceFile } from "../src/store.ts";
import { fsBlobStore, bounded } from "../src/blob-store.ts";
import { localRevisionStore } from "../src/revision-store.ts";
import { type JournalStore, type JournalRecord } from "../src/journal-store.ts";
import { setRevisionBackend, resetJournalForTests, flushRevisions, readAtHead, reconcileWorkspace, cleanOrphanedHistory, recoverJournal } from "../src/workspace-revisions.ts";
import { setLocalDiskGate, setMirrorGate } from "../src/mirror-base.ts";
import { memorySweepMarks } from "../src/blob-sweeper.ts";
import { headsOf, type Deps } from "../src/publish.ts";

const T = "acme";
let root: string;
let deps: Deps;
let marks: ReturnType<typeof memorySweepMarks>;

/** A shared table, as the database journal is: every pod sees every row. */
function sharedJournal(): JournalStore & { rows: Map<string, { rec: JournalRecord; at: number }> } {
  const rows = new Map<string, { rec: JournalRecord; at: number }>();
  const id = (t: string, w: string, h: string) => `${t}\0${w}\0${h}`;
  return {
    kind: "memory",
    rows,
    put(rec) {
      rows.set(id(rec.tenant, rec.workspace, rec.id), { rec, at: Date.now() });
      return rec.id;
    },
    remove: (t, w, h) => void rows.delete(id(t, w, h)),
    workspaces: () => [...new Map([...rows.values()].map((r) => [`${r.rec.tenant}\0${r.rec.workspace}`, { tenant: r.rec.tenant, workspace: r.rec.workspace }])).values()],
    entries: (t, w) => [...rows.values()].filter((r) => r.rec.tenant === t && r.rec.workspace === w).map((r) => ({ handle: r.rec.id, ageMs: Date.now() - r.at })),
    read(t, w, h) {
      const r = rows.get(id(t, w, h));
      if (!r) throw new Error("no such entry");
      return r.rec;
    },
    setAside: () => {},
    sweep() {},
    drop() {},
    move() {},
  };
}
const rec = (w: string, idv: string): JournalRecord => ({ v: 1, tenant: T, workspace: w, id: idv, files: [{ path: "memory/b.md", before: null, after: `b ${idv}\n` }], by: "u", message: "m", at: new Date().toISOString() });

async function make(w: string) {
  fs.mkdirSync(workspaceDir(T, w), { recursive: true });
  fs.writeFileSync(path.join(workspaceDir(T, w), "AGENTS.md"), `---\nname: ${w}\n---\n`);
  writeWorkspaceFile(T, w, "memory/a.md", `${w}\n`, { by: "test" });
  await flushRevisions({ tenant: T, workspace: w });
}
const head = async (w: string) => (await headsOf(deps, { tenant: T, workspace: w })).workspace;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-localdisk-"));
  process.env.FOLDRUN_DATA = root;
  marks = memorySweepMarks();
  deps = { blobs: bounded(fsBlobStore(path.join(root, ".objects")), { backoffMs: 1 }), revisions: localRevisionStore(path.join(root, ".revisions")) };
  setRevisionBackend(deps, { journal: () => true, read: () => true, sweepMarks: marks, orphanGraceMs: 0 });
  setMirrorGate(null);
});
afterEach(() => {
  setLocalDiskGate(null);
  setMirrorGate(null);
  setRevisionBackend(null);
  resetJournalForTests();
  fs.rmSync(root, { recursive: true, force: true });
  delete process.env.FOLDRUN_DATA;
});

test("own disk, mirror off: a file missing from the folder is not published as deleted", async () => {
  await make("desk");
  fs.rmSync(path.join(workspaceDir(T, "desk"), "memory", "a.md"));
  setLocalDiskGate(() => true);
  assert.equal(await reconcileWorkspace(T, "desk"), null);
  assert.equal((await readAtHead(T, "desk", "memory/a.md"))?.toString(), "desk\n", "the head keeps it");
  // control: on a shared volume the folder is the truth, and the file goes
  setLocalDiskGate(null);
  const r = await reconcileWorkspace(T, "desk");
  assert.equal(r?.status, "committed");
  assert.equal(await readAtHead(T, "desk", "memory/a.md"), null);
});

test("own disk, mirror off: a workspace with no folder here keeps its history", async () => {
  for (const w of ["alive", "ghost"]) await make(w);
  fs.rmSync(workspaceDir(T, "ghost"), { recursive: true, force: true });
  setLocalDiskGate(() => true);
  for (let i = 0; i < 2; i++) assert.equal((await cleanOrphanedHistory(marks, { graceMs: 0 })).dropped, 0);
  assert.ok(await head("ghost"));
  // control: a shared volume's absence is believed (seen once, then removed)
  setLocalDiskGate(null);
  await cleanOrphanedHistory(marks, { graceMs: 0 });
  assert.equal((await cleanOrphanedHistory(marks, { graceMs: 0 })).dropped, 1);
  assert.equal(await head("ghost"), null);
});

test("own disk: another pod's journal entry is not removed because the folder is missing here", async () => {
  const shared = sharedJournal();
  setRevisionBackend(deps, { journal: () => true, read: () => true, journalStore: shared });
  shared.put(rec("elsewhere", "journalother01")); // no folder for "elsewhere" on this pod
  setLocalDiskGate(() => true);
  await recoverJournal({ minAgeMs: 0 });
  assert.equal(shared.rows.size, 1, "left in the shared store for a pod that has the folder");
  // control: on a shared volume a missing folder is a deleted workspace
  setLocalDiskGate(null);
  await recoverJournal({ minAgeMs: 0 });
  assert.equal(shared.rows.size, 0);
});

test("shared volume: a young entry is kept even when its folder is missing; an old one is removed", async () => {
  const shared = sharedJournal();
  setRevisionBackend(deps, { journal: () => true, read: () => true, journalStore: shared });
  shared.put(rec("gone", "journalyoung01"));
  await recoverJournal({ minAgeMs: 60_000 });
  assert.equal(shared.rows.size, 1, "a live process may still be writing it");
  await recoverJournal({ minAgeMs: 0 });
  assert.equal(shared.rows.size, 0, "old, and the workspace is gone: discarded");
});
