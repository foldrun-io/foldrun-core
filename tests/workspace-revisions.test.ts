// Workspaces as revisions, first slice (FOL-126 phase 3): every write path
// (they all end in history.recordRevision) is committed through the publish
// protocol; reads and history come back from revisions in history.ts's shapes.
//
//   node --test tests/workspace-revisions.test.ts

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { writeWorkspaceFile, deleteWorkspacePath, renameWorkspaceFile, workspaceDir } from "../src/store.ts";
import { fsBlobStore, bounded } from "../src/blob-store.ts";
import { localRevisionStore, type RevisionStore } from "../src/revision-store.ts";
import {
  setRevisionBackend, resetJournalForTests, setBlobCache, flushRevisions, pendingRevisions, readAtHead, listRevisionSummaries, readRevisionDetail,
  snapshotFiles, restoreRevision, reconcileWorkspace, needsReconcile, type BlobCache,
} from "../src/workspace-revisions.ts";
import { headsOf, manifestsAt, type Deps } from "../src/publish.ts";
import { MODE_EXEC } from "../src/manifest.ts";

const T = "acme";
const W = "desk";
let root: string;
let deps: Deps;

const AGENT = (name: string) => `---\nname: ${name}\n---\n${name} body\n`;
const text = async (rel: string) => (await readAtHead(T, W, rel))?.toString("utf8") ?? null;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-wsrev-"));
  process.env.FOLDRUN_DATA = root;
  fs.mkdirSync(path.join(workspaceDir(T, W), "agents", "writer"), { recursive: true });
  fs.writeFileSync(path.join(workspaceDir(T, W), "AGENTS.md"), "---\nname: desk\n---\n");
  fs.writeFileSync(path.join(workspaceDir(T, W), "agents", "writer", "AGENTS.md"), AGENT("writer"));
  deps = { blobs: bounded(fsBlobStore(path.join(root, ".objects")), { backoffMs: 1 }), revisions: localRevisionStore(path.join(root, ".revisions")) };
});
afterEach(() => {
  setRevisionBackend(null);
  setBlobCache(null);
  resetJournalForTests();
  fs.rmSync(root, { recursive: true, force: true });
  delete process.env.FOLDRUN_DATA;
});

test("with no backend nothing is journalled: a laptop and the CLI are untouched", async () => {
  writeWorkspaceFile(T, W, "agents/writer/AGENTS.md", AGENT("writer2"), { by: "user:a" });
  assert.equal(pendingRevisions(), 0);
  assert.deepEqual(await listRevisionSummaries(T, W), []);
  assert.equal(await readAtHead(T, W, "AGENTS.md"), null);
  assert.equal(fs.existsSync(path.join(root, ".revisions")), false);
});

test("the first write commits the whole tree as the baseline; later writes are one revision each, and reads resolve head → manifest → blob", async () => {
  setRevisionBackend(deps);
  writeWorkspaceFile(T, W, "agents/writer/AGENTS.md", AGENT("writer2"), { by: "user:a", message: "rename" });
  assert.equal((await flushRevisions({ tenant: T, workspace: W })).pending, 0);
  const first = await listRevisionSummaries(T, W);
  assert.equal(first.length, 1);
  assert.deepEqual(first[0].paths, ["AGENTS.md", "agents/writer/AGENTS.md"], "the whole tree, with this change in it");
  assert.equal(first[0].by, "user:a");
  assert.equal(await text("agents/writer/AGENTS.md"), AGENT("writer2"));

  writeWorkspaceFile(T, W, "flows/publish.md", "---\nname: publish\ntrigger: manual\nsteps:\n  - agent: writer\n---\n", { by: "user:b", message: "add flow" });
  await flushRevisions();
  const list = await listRevisionSummaries(T, W);
  assert.deepEqual(list.map((r) => r.message), ["add flow", "rename"]);
  assert.deepEqual(list[0].paths, ["flows/publish.md"]);
  assert.equal(await text("AGENTS.md"), "---\nname: desk\n---\n", "an untouched file is still there");
  assert.equal(await readAtHead(T, W, "agents/none.md"), null);
  assert.equal(await readAtHead(T, W, "runs/x.json"), null, "a path on neither side is not a workspace file");
});

test("every writer is journalled: save, delete and rename, in order", async () => {
  setRevisionBackend(deps);
  writeWorkspaceFile(T, W, "memory/notes.md", "one\n", { by: "user:a" });
  writeWorkspaceFile(T, W, "memory/notes.md", "two\n", { by: "assistant" });
  renameWorkspaceFile(T, W, "memory/notes.md", "memory/old.md", { by: "user:a" });
  deleteWorkspacePath(T, W, "memory/old.md", { by: "user:a" });
  await flushRevisions();
  const list = await listRevisionSummaries(T, W);
  assert.equal(list.length, 4);
  assert.deepEqual(list.map((r) => r.by).reverse(), ["user:a", "assistant", "user:a", "user:a"]);
  assert.equal(await text("memory/notes.md"), null);
  assert.equal(await text("memory/old.md"), null);
});

test("a revision's detail and snapshot come back in history.ts's shapes", async () => {
  setRevisionBackend(deps);
  writeWorkspaceFile(T, W, "memory/notes.md", "one\n", { by: "user:a", message: "first" });
  await flushRevisions();
  writeWorkspaceFile(T, W, "memory/notes.md", "two\n", { by: "user:a", message: "second" });
  await flushRevisions();
  const [second, first] = await listRevisionSummaries(T, W);
  const d = (await readRevisionDetail(T, W, second.id))!;
  assert.deepEqual(d.files, [{ path: "memory/notes.md", before: "one\n", after: "two\n" }]);
  assert.equal(d.commit, null);
  assert.deepEqual((await readRevisionDetail(T, W, second.id, "AGENTS.md"))!.files, []);
  const snap = (await snapshotFiles(T, W, first.id))!;
  assert.equal(snap.find((f) => f.path === "memory/notes.md")!.content, "one\n");
  assert.ok(snap.some((f) => f.path === "AGENTS.md"));
  assert.equal(await readRevisionDetail(T, W, "rev_nope"), null);
  assert.deepEqual((await listRevisionSummaries(T, W, { forPath: "memory/notes.md" })).map((r) => r.id), [second.id, first.id]);
  assert.deepEqual((await listRevisionSummaries(T, W, { forPath: "agents/writer/AGENTS.md" })).map((r) => r.id), [first.id], "only the baseline touched it");
});

test("restore is a NEW revision pointing at old blobs; history is kept; the folder write that follows is a no-op", async () => {
  setRevisionBackend(deps);
  writeWorkspaceFile(T, W, "memory/notes.md", "one\n", { by: "user:a" });
  await flushRevisions();
  const [first] = await listRevisionSummaries(T, W);
  writeWorkspaceFile(T, W, "memory/notes.md", "two\n", { by: "user:a" });
  await flushRevisions();
  const res = (await restoreRevision(T, W, first.id, { by: "user:a", opId: "restore-test-0001" }))!;
  assert.equal(res.status, "committed");
  assert.equal(res.revision!.restoredFrom, first.id);
  assert.equal(await text("memory/notes.md"), "one\n");
  assert.equal((await listRevisionSummaries(T, W)).length, 3, "restore added a revision; nothing was rewritten");
  // The route then writes the folder; the head already holds that content.
  writeWorkspaceFile(T, W, "memory/notes.md", "one\n", { by: "user:a", message: "restore" });
  await flushRevisions();
  assert.equal((await listRevisionSummaries(T, W)).length, 3, "no fourth revision for the same content");
  const again = (await restoreRevision(T, W, first.id, { by: "user:a", opId: "restore-test-0001" }))!;
  assert.equal(again.status, "duplicate", "a retry never restores twice");
});

test("state/ moves on its own head: a state write never makes a source revision", async () => {
  setRevisionBackend(deps);
  writeWorkspaceFile(T, W, "memory/notes.md", "one\n", { by: "user:a" });
  await flushRevisions();
  fs.mkdirSync(path.join(workspaceDir(T, W), "state"), { recursive: true });
  fs.writeFileSync(path.join(workspaceDir(T, W), "state", "cursor.json"), "{}\n");
  // state/ is not an editable path for people; a run's checkpoint writes it and records it.
  const { recordRevision } = await import("../src/history.ts");
  recordRevision(T, W, [{ path: "state/cursor.json", before: null, after: "{}\n" }], { by: "run:run-1:writer", message: "checkpoint" });
  await flushRevisions();
  const heads = await headsOf(deps, { tenant: T, workspace: W });
  assert.ok(heads.state, "a state head exists");
  assert.equal((await listRevisionSummaries(T, W)).length, 1, "the source history did not grow");
  assert.equal(await text("state/cursor.json"), "{}\n");
});

test("an executable script keeps its mode", async () => {
  setRevisionBackend(deps);
  fs.mkdirSync(path.join(workspaceDir(T, W), "scripts"), { recursive: true });
  fs.writeFileSync(path.join(workspaceDir(T, W), "scripts", "run.sh"), "#!/bin/sh\necho hi\n", { mode: 0o755 });
  const { recordRevision } = await import("../src/history.ts");
  recordRevision(T, W, [{ path: "scripts/run.sh", before: null, after: "#!/bin/sh\necho hi\n" }], { by: "deploy", message: "script" });
  await flushRevisions();
  const heads = await headsOf(deps, { tenant: T, workspace: W });
  const m = await manifestsAt(deps, T, heads);
  assert.equal(m.authored.files["scripts/run.sh"].mode, MODE_EXEC);
  assert.notEqual(m.authored.files["AGENTS.md"].mode, MODE_EXEC);
});

test("a revision store that is down loses nothing: changes stay queued in order and commit when it is back", async () => {
  let down = true;
  const inner = deps.revisions;
  const flaky: RevisionStore = new Proxy(inner, {
    get(target, prop, recv) {
      const v = Reflect.get(target, prop, recv);
      if (prop === "commit" && typeof v === "function") return (...a: unknown[]) => (down ? Promise.reject(new Error("database down")) : (v as Function).apply(target, a));
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
  setRevisionBackend({ ...deps, revisions: flaky });
  writeWorkspaceFile(T, W, "memory/a.md", "a\n", { by: "user:a", message: "a" });
  writeWorkspaceFile(T, W, "memory/b.md", "b\n", { by: "user:a", message: "b" });
  const r = await flushRevisions({ tenant: T, workspace: W });
  assert.equal(r.pending, 2, "both still queued");
  assert.equal(await text("memory/a.md"), null, "nothing was committed");
  down = false;
  assert.equal((await flushRevisions({ tenant: T, workspace: W })).pending, 0);
  // The first commit is the baseline: the folder as it is NOW, which already holds b.
  assert.equal(await text("memory/a.md"), "a\n");
  assert.equal(await text("memory/b.md"), "b\n");
  assert.equal((await listRevisionSummaries(T, W)).length, 1, "b was in the baseline, so its own entry changed nothing");
});

test("a change the manifest refuses is dropped and named, not retried for ever: later changes still commit", async () => {
  setRevisionBackend(deps);
  fs.mkdirSync(path.join(workspaceDir(T, W), "memory"), { recursive: true });
  fs.writeFileSync(path.join(workspaceDir(T, W), "memory", "Notes.md"), "upper\n");
  fs.writeFileSync(path.join(workspaceDir(T, W), "memory", "notes.md"), "lower\n"); // on a case-sensitive disk
  if (fs.readdirSync(path.join(workspaceDir(T, W), "memory")).length < 2) return; // a case-insensitive disk cannot hold both
  const { recordRevision } = await import("../src/history.ts");
  recordRevision(T, W, [{ path: "memory/Notes.md", before: null, after: "upper\n" }], { by: "user:a", message: "collide" });
  const r = await flushRevisions({ tenant: T, workspace: W });
  assert.equal(r.pending, 0, "the queue is not stuck behind it");
  assert.equal(needsReconcile(T, W), true);
  fs.rmSync(path.join(workspaceDir(T, W), "memory", "Notes.md"));
  writeWorkspaceFile(T, W, "memory/fine.md", "ok\n", { by: "user:a", message: "fine" });
  await flushRevisions();
  assert.equal(await text("memory/fine.md"), "ok\n");
});

test("a retried flush never publishes twice", async () => {
  setRevisionBackend(deps);
  writeWorkspaceFile(T, W, "memory/a.md", "a\n", { by: "user:a", message: "a" });
  await Promise.all([flushRevisions(), flushRevisions(), flushRevisions()]);
  assert.equal((await listRevisionSummaries(T, W)).length, 1);
});

test("reconcile brings the heads to the folder's content in one revision, and is a no-op when they agree", async () => {
  setRevisionBackend(deps);
  assert.equal(needsReconcile(T, W), false);
  const r1 = (await reconcileWorkspace(T, W, "importer"))!;
  assert.equal(r1.status, "committed");
  assert.equal(await text("agents/writer/AGENTS.md"), AGENT("writer"));
  assert.equal(await reconcileWorkspace(T, W), null, "nothing differs");
  fs.writeFileSync(path.join(workspaceDir(T, W), "agents", "writer", "AGENTS.md"), AGENT("edited outside"));
  fs.rmSync(path.join(workspaceDir(T, W), "AGENTS.md"));
  const r2 = (await reconcileWorkspace(T, W, "importer"))!;
  assert.equal(r2.status, "committed");
  assert.equal(await text("agents/writer/AGENTS.md"), AGENT("edited outside"));
  assert.equal(await text("AGENTS.md"), null, "a file that is gone from the folder is gone from the head");
});

test("the cache seam: a read asks the cache first, fills it on a miss, and a hit never touches the store", async () => {
  setRevisionBackend(deps);
  writeWorkspaceFile(T, W, "memory/a.md", "a\n", { by: "user:a" });
  await flushRevisions();
  const seen: string[] = [];
  const mem = new Map<string, Buffer>();
  const cache: BlobCache = {
    async get(_t, sha) { seen.push(`get ${sha.slice(0, 6)}`); return mem.get(sha) ?? null; },
    async put(_t, sha, b) { seen.push(`put ${sha.slice(0, 6)}`); mem.set(sha, b); },
  };
  setBlobCache(cache);
  assert.equal(await text("memory/a.md"), "a\n");
  await new Promise((r) => setImmediate(r));
  assert.ok(seen.some((s) => s.startsWith("put")), "filled on a miss");
  // Break the store: a hit must be served from the cache alone.
  let blobReads = 0;
  setRevisionBackend({ ...deps, blobs: new Proxy(deps.blobs, { get: (t, p, r) => (p === "get" ? (...a: unknown[]) => { blobReads++; return (t.get as Function)(...a); } : Reflect.get(t, p, r)) }) });
  assert.equal(await text("memory/a.md"), "a\n");
  assert.ok(blobReads <= 1, `only the manifest was read from the store, not the file (${blobReads})`);
});
