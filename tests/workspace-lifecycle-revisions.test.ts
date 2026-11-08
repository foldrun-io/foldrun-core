// A workspace's history follows its folder through a delete and a rename
// (FOL-126 fixes, 8 Nov). Before: a delete left the heads and revisions where
// they were and a rename left them under the old name, so a NEW workspace of
// either name started on the old one's head.
//
//   node --test tests/workspace-lifecycle-revisions.test.ts

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { workspaceDir, writeWorkspaceFile, deleteWorkspace, deleteWorkspaceAsync, renameWorkspaceAsync, renameWorkspace } from "../src/store.ts";
import { fsBlobStore, bounded } from "../src/blob-store.ts";
import { localRevisionStore, type RevisionStore } from "../src/revision-store.ts";
import { setRevisionBackend, resetJournalForTests, flushRevisions, readAtHead, pendingRevisions, dropTenantRevisions, settleLifecycle } from "../src/workspace-revisions.ts";
import { listRevisionsLocal } from "../src/history.ts";
import { headsOf, manifestsAt, type Deps } from "../src/publish.ts";

const T = "acme";
const ON = { journal: () => true, read: () => true };
let root: string;
let deps: Deps;
let inner: RevisionStore;
let failNext: { drop?: number; move?: number } = {};

const text = async (w: string, rel: string) => (await readAtHead(T, w, rel))?.toString("utf8") ?? null;
const heads = (w: string) => headsOf(deps, { tenant: T, workspace: w });
async function make(w: string, files: Record<string, string>) {
  fs.mkdirSync(workspaceDir(T, w), { recursive: true });
  fs.writeFileSync(path.join(workspaceDir(T, w), "AGENTS.md"), `---\nname: ${w}\n---\n`);
  for (const [rel, body] of Object.entries(files)) writeWorkspaceFile(T, w, rel, body, { by: "test", message: `write ${rel}` });
  await flushRevisions({ tenant: T, workspace: w });
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-life-"));
  process.env.FOLDRUN_DATA = root;
  inner = localRevisionStore(path.join(root, ".revisions"));
  failNext = {};
  const flaky: RevisionStore = new Proxy(inner, {
    get(target, prop, recv) {
      if (prop === "drop" || prop === "move") {
        return (...a: unknown[]) => {
          if ((failNext as Record<string, number | undefined>)[prop as string]) {
            (failNext as Record<string, number>)[prop as string]--;
            return Promise.reject(new Error("the store is down"));
          }
          return (target[prop as "drop"] as (...x: unknown[]) => unknown).apply(target, a);
        };
      }
      return Reflect.get(target, prop, recv);
    },
  });
  deps = { blobs: bounded(fsBlobStore(path.join(root, ".objects")), { backoffMs: 1 }), revisions: flaky };
  setRevisionBackend(deps, ON);
});
afterEach(() => {
  setRevisionBackend(null);
  resetJournalForTests();
  fs.rmSync(root, { recursive: true, force: true });
  delete process.env.FOLDRUN_DATA;
});

test("deleting a workspace removes its heads and history; a new one of that name starts empty and sees none of its files", async () => {
  await make("desk", { "memory/secret.md": "old secret\n", "state/s.json": "{}" });
  assert.ok((await heads("desk")).workspace && (await heads("desk")).state);
  assert.equal(await text("desk", "memory/secret.md"), "old secret\n");

  await deleteWorkspaceAsync(T, "desk");
  assert.equal(fs.existsSync(workspaceDir(T, "desk")), false);
  const h = await heads("desk");
  assert.equal(h.workspace, null);
  assert.equal(h.state, null);
  assert.deepEqual(await inner.revisions({ tenant: T, workspace: "desk" }), []);
  assert.equal(await text("desk", "memory/secret.md"), null, "the old file cannot be read from a head");

  // the next workspace of that name
  await make("desk", { "memory/new.md": "new\n" });
  const m = await manifestsAt(deps, T, await heads("desk"));
  const mem = Object.keys(m.authored.files).filter((p) => p.startsWith("memory/"));
  assert.ok(mem.includes("memory/new.md") && !mem.includes("memory/secret.md"), `only the new workspace's own files: ${mem.join(", ")}`);
  assert.equal(await text("desk", "memory/secret.md"), null);
  const revs = await inner.revisions({ tenant: T, workspace: "desk" });
  assert.equal(revs.length, 1, "its history is its own: one revision, the baseline");
});

test("a delete does not touch another workspace of the account", async () => {
  await make("desk", { "memory/a.md": "a\n" });
  await make("other", { "memory/o.md": "o\n" });
  await deleteWorkspaceAsync(T, "desk");
  assert.equal(await text("other", "memory/o.md"), "o\n");
  assert.ok((await heads("other")).workspace);
});

test("a store that cannot be reached refuses the delete BEFORE the folder is removed, and the retry works", async () => {
  await make("desk", { "memory/a.md": "a\n" });
  failNext.drop = 1;
  await assert.rejects(() => deleteWorkspaceAsync(T, "desk"), /store is down/);
  assert.equal(fs.existsSync(workspaceDir(T, "desk")), true, "nothing was removed");
  await deleteWorkspaceAsync(T, "desk");
  assert.equal(fs.existsSync(workspaceDir(T, "desk")), false);
  assert.equal((await heads("desk")).workspace, null);
});

test("changes queued when the delete starts are never committed afterwards", async () => {
  await make("desk", { "memory/a.md": "a\n" });
  // a write whose commit has not run yet
  writeWorkspaceFile(T, "desk", "memory/late.md", "late\n", { by: "test" });
  assert.ok(pendingRevisions() >= 1);
  await deleteWorkspaceAsync(T, "desk");
  await flushRevisions();
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(pendingRevisions(), 0);
  assert.equal((await heads("desk")).workspace, null, "no revision appeared for the deleted workspace");
  assert.equal(fs.existsSync(path.join(root, ".revision-journal", T, "desk")), false, "and no journal file is left");
});

test("the sync deleteWorkspace also drops the history (a caller that cannot wait)", async () => {
  await make("desk", { "memory/a.md": "a\n" });
  deleteWorkspace(T, "desk");
  await settleLifecycle();
  assert.equal((await heads("desk")).workspace, null);
});

test("deleting an account drops every workspace's history, the pins and its blobs; another account is untouched", async () => {
  await make("one", { "memory/a.md": "a\n" });
  await make("two", { "memory/b.md": "b\n" });
  const OTHER = "globex";
  fs.mkdirSync(workspaceDir(OTHER, "w"), { recursive: true });
  fs.writeFileSync(path.join(workspaceDir(OTHER, "w"), "AGENTS.md"), "---\nname: w\n---\n");
  writeWorkspaceFile(OTHER, "w", "memory/x.md", "x\n", { by: "test" });
  await flushRevisions();
  assert.ok(fs.existsSync(path.join(root, ".objects", "t", T)));
  await dropTenantRevisions(T);
  assert.equal((await heads("one")).workspace, null);
  assert.equal((await heads("two")).workspace, null);
  assert.equal(fs.existsSync(path.join(root, ".objects", "t", T)), false, "the account's blobs are gone");
  assert.ok((await headsOf(deps, { tenant: OTHER, workspace: "w" })).workspace, "another account is untouched");
  assert.ok(fs.existsSync(path.join(root, ".objects", "t", OTHER)));
});

// ------------------------------------------------------------------ rename

test("a rename carries the history: the new name has it, the old name has none, and a new workspace of the old name starts empty", async () => {
  await make("desk", { "memory/a.md": "a\n", "state/s.json": "{}" });
  const before = await heads("desk");
  await renameWorkspaceAsync(T, "desk", "bench");
  assert.equal(fs.existsSync(workspaceDir(T, "desk")), false);
  assert.ok(fs.existsSync(workspaceDir(T, "bench")));
  const after = await heads("bench");
  assert.equal(after.workspace?.id, before.workspace?.id, "the same revision, under the new name");
  assert.equal(after.state?.id, before.state?.id);
  assert.equal(await text("bench", "memory/a.md"), "a\n");
  const old = await heads("desk");
  assert.equal(old.workspace, null);
  assert.equal(old.state, null);
  // history continues on the new name
  writeWorkspaceFile(T, "bench", "memory/b.md", "b\n", { by: "test" });
  await flushRevisions({ tenant: T, workspace: "bench" });
  assert.ok((await heads("bench")).workspace!.seq > before.workspace!.seq, "the history continues from where it was");
  // a new workspace given the old name sees nothing of it
  await make("desk", { "memory/z.md": "z\n" });
  assert.equal(await text("desk", "memory/a.md"), null);
  assert.equal((await inner.revisions({ tenant: T, workspace: "desk" })).length, 1);
});

test("changes queued for the old name follow the rename and commit under the new one", async () => {
  await make("desk", { "memory/a.md": "a\n" });
  writeWorkspaceFile(T, "desk", "memory/queued.md", "queued\n", { by: "test" });
  assert.ok(pendingRevisions() >= 1);
  await renameWorkspaceAsync(T, "desk", "bench");
  await flushRevisions({ tenant: T, workspace: "bench" });
  assert.equal(pendingRevisions(), 0);
  assert.equal(await text("bench", "memory/queued.md"), "queued\n");
  assert.equal((await heads("desk")).workspace, null, "nothing was committed under the old name");
  assert.equal(fs.existsSync(path.join(root, ".revision-journal", T, "desk")), false);
  // and no journal file is left for the new name once committed
  assert.equal(fs.existsSync(path.join(root, ".revision-journal", T, "bench")), false);
});

test("a journal entry left by a dead process for the old name is replayed under the new one", async () => {
  await make("desk", { "memory/a.md": "a\n" });
  // what a crashed process leaves: a journal file, no queue
  const dir = path.join(root, ".revision-journal", T, "desk");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "00000000000001-000000-orphan.json"), JSON.stringify({ v: 1, tenant: T, workspace: "desk", id: "orphan", files: [{ path: "memory/orphan.md", before: null, after: "o\n" }], by: "test", message: "m", at: new Date().toISOString() }));
  fs.writeFileSync(path.join(workspaceDir(T, "desk"), "memory", "orphan.md"), "o\n");
  await renameWorkspaceAsync(T, "desk", "bench");
  assert.equal(fs.existsSync(dir), false, "nothing is left under the old name");
  const moved = path.join(root, ".revision-journal", T, "bench");
  assert.ok(fs.existsSync(moved) && fs.readdirSync(moved).length === 1, "the entry now belongs to the new name");
  const { recoverJournal } = await import("../src/workspace-revisions.ts");
  await recoverJournal({ minAgeMs: 0 });
  assert.equal(await text("bench", "memory/orphan.md"), "o\n");
});

test("a name that is taken is refused before any history moves", async () => {
  await make("desk", { "memory/a.md": "a\n" });
  await make("bench", { "memory/keep.md": "keep\n" });
  const before = await heads("bench");
  await assert.rejects(() => renameWorkspaceAsync(T, "desk", "bench"), /already exists/);
  assert.equal((await heads("bench")).workspace?.id, before.workspace?.id, "the other workspace keeps its own history");
  assert.equal(await text("desk", "memory/a.md"), "a\n");
  assert.equal(await text("bench", "memory/keep.md"), "keep\n");
});

test("a store that cannot move the history refuses the rename before the folder moved", async () => {
  await make("desk", { "memory/a.md": "a\n" });
  failNext.move = 1;
  await assert.rejects(() => renameWorkspaceAsync(T, "desk", "bench"), /store is down/);
  assert.ok(fs.existsSync(workspaceDir(T, "desk")), "the folder stayed");
  assert.equal(fs.existsSync(workspaceDir(T, "bench")), false);
  assert.ok((await heads("desk")).workspace, "and the history stayed under its name");
  await renameWorkspaceAsync(T, "desk", "bench");
  assert.ok((await heads("bench")).workspace);
});

test("if the folder cannot be renamed the history goes back", async () => {
  await make("desk", { "memory/a.md": "a\n" });
  const id = (await heads("desk")).workspace!.id;
  // a file where the destination's parent folder should be makes the rename fail after the history moved
  const wsRoot = path.dirname(workspaceDir(T, "desk"));
  fs.mkdirSync(path.join(wsRoot), { recursive: true });
  const real = fs.renameSync;
  (fs as { renameSync: typeof fs.renameSync }).renameSync = ((a: fs.PathLike, b: fs.PathLike) => {
    if (String(b).endsWith(`${path.sep}bench`)) throw new Error("disk full");
    return real(a, b);
  }) as typeof fs.renameSync;
  try {
    await assert.rejects(() => renameWorkspaceAsync(T, "desk", "bench"), /disk full/);
  } finally {
    (fs as { renameSync: typeof fs.renameSync }).renameSync = real;
  }
  assert.equal((await heads("desk")).workspace?.id, id, "the history is back under the old name");
  assert.equal((await heads("bench")).workspace, null);
});

test("the sync renameWorkspace moves the history too, and the queued changes with it", async () => {
  await make("desk", { "memory/a.md": "a\n" });
  writeWorkspaceFile(T, "desk", "memory/q.md", "q\n", { by: "test" });
  renameWorkspace(T, "desk", "bench");
  await settleLifecycle();
  await flushRevisions({ tenant: T, workspace: "bench" });
  assert.equal(await text("bench", "memory/a.md"), "a\n");
  assert.equal(await text("bench", "memory/q.md"), "q\n");
  assert.equal((await heads("desk")).workspace, null);
});

test("without a backend nothing changes: the async forms are the plain ones", async () => {
  setRevisionBackend(null);
  fs.mkdirSync(workspaceDir(T, "plain"), { recursive: true });
  fs.writeFileSync(path.join(workspaceDir(T, "plain"), "AGENTS.md"), "---\nname: plain\n---\n");
  await renameWorkspaceAsync(T, "plain", "plain2");
  assert.ok(fs.existsSync(workspaceDir(T, "plain2")));
  await deleteWorkspaceAsync(T, "plain2");
  assert.equal(fs.existsSync(workspaceDir(T, "plain2")), false);
  assert.ok(listRevisionsLocal);
});
