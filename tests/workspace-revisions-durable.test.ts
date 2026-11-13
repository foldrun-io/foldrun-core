// The revision journal is durable and opt-in (FOL-126 phase 3b): a change is
// written down before it is queued, a crash leaves the file, boot replays it,
// and whatever still disagrees with the folder is reconciled. History and
// reads come from revisions only where the switches say so.
//
//   node --test tests/workspace-revisions-durable.test.ts

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { writeWorkspaceFile, deleteWorkspacePath, workspaceDir } from "../src/store.ts";
import { fsBlobStore, bounded } from "../src/blob-store.ts";
import { localRevisionStore, type RevisionStore } from "../src/revision-store.ts";
import {
  setRevisionBackend, resetJournalForTests, flushRevisions, pendingRevisions, readAtHead, listRevisionSummaries, recoverJournal, reconcileAll,
  asRestoreOf, dropJournal, readHeadText, readHeadTree, revisionReadsOn, readWorkspaceFileVia,
} from "../src/workspace-revisions.ts";
import { listRevisions, listRevisionsRestorable, readRevision, snapshotAt, headRevision, resolveRevision, hasSnapshot, latestRevisionId, changedPathsBetween, recordRevision } from "../src/history.ts";
import { headsOf, type Deps } from "../src/publish.ts";

const T = "acme";
const W = "desk";
let root: string;
let deps: Deps;
const ON = { journal: () => true, read: () => true };
const journalDir = () => path.join(root, ".revision-journal", T, W);
const text = async (rel: string) => (await readAtHead(T, W, rel))?.toString("utf8") ?? null;

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

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-wsrev-d-"));
  process.env.FOLDRUN_DATA = root;
  fs.mkdirSync(path.join(workspaceDir(T, W), "agents", "writer"), { recursive: true });
  fs.writeFileSync(path.join(workspaceDir(T, W), "AGENTS.md"), "---\nname: desk\n---\n");
  deps = { blobs: bounded(fsBlobStore(path.join(root, ".objects")), { backoffMs: 1 }), revisions: localRevisionStore(path.join(root, ".revisions")) };
});
afterEach(() => {
  setRevisionBackend(null);
  resetJournalForTests();
  fs.rmSync(root, { recursive: true, force: true });
  delete process.env.FOLDRUN_DATA;
});

test("registering a backend alone changes nothing: the journal and the reads are opt-in", async () => {
  setRevisionBackend(deps); // no switches
  writeWorkspaceFile(T, W, "memory/a.md", "a\n", { by: "user:a" });
  assert.equal(pendingRevisions(), 0);
  assert.equal(fs.existsSync(journalDir()), false);
  assert.equal(revisionReadsOn(), false);
  assert.equal(fs.existsSync(path.join(root, ".revisions")), false);
  // history is the local one
  assert.equal((await listRevisions(T, W)).length, 1);
});

test("a change is on disk before it is queued, and gone once it is committed", async () => {
  setRevisionBackend(deps, ON);
  writeWorkspaceFile(T, W, "memory/a.md", "a\n", { by: "user:a" });
  assert.equal(fs.readdirSync(journalDir()).filter((n) => n.endsWith(".json")).length, 1, "written before the commit");
  await flushRevisions();
  assert.equal(fs.existsSync(journalDir()), false, "removed after");
  assert.equal(await text("memory/a.md"), "a\n");
});

test("a crash with changes queued: boot replays the journal, in order, once", async () => {
  const state = { down: true };
  setRevisionBackend(downStore(state), ON);
  // an established head first, so the entries are incremental
  state.down = false;
  writeWorkspaceFile(T, W, "memory/base.md", "base\n", { by: "user:a" });
  await flushRevisions();
  state.down = true;
  // A few ms apart: the history lists newest first by time, and two writes
  // in one millisecond are a tie it may list either way (seen on the dev
  // gate, 12 Nov 2026: "second" before "third").
  const tick = () => new Promise((r) => setTimeout(r, 3));
  writeWorkspaceFile(T, W, "memory/a.md", "one\n", { by: "user:a", message: "first" });
  await tick();
  writeWorkspaceFile(T, W, "memory/a.md", "two\n", { by: "user:b", message: "second" });
  await tick();
  deleteWorkspacePath(T, W, "memory/base.md", { by: "user:a", message: "third" });
  assert.equal((await flushRevisions()).pending, 3);
  // the process dies: memory is gone, the files stay
  resetJournalForTests();
  assert.equal(fs.readdirSync(journalDir()).length, 3);
  // a new process, a healthy store
  setRevisionBackend(deps, ON);
  assert.equal((await recoverJournal({ minAgeMs: 0 })).entries, 3);
  assert.equal(await text("memory/a.md"), "two\n");
  assert.equal(await text("memory/base.md"), null);
  // (memory writes also touch memory/index.md and log.md outside recordRevision;
  // the reconcile after the replay records those, which is the folder winning)
  assert.deepEqual((await listRevisionSummaries(T, W)).filter((r) => r.by !== "reconcile").map((r) => r.message), ["third", "second", "first", "created memory/base.md"]);
  assert.equal(fs.existsSync(journalDir()), false);
  // a second pod replaying the same files finds nothing left, and a replay of an entry
  // already committed does not publish again
  const before = (await listRevisionSummaries(T, W)).length;
  assert.equal((await recoverJournal({ minAgeMs: 0 })).entries, 0);
  assert.equal((await listRevisionSummaries(T, W)).length, before);
});

test("boot leaves a live process's recent files alone, drops a deleted workspace's, and sets aside a torn one", async () => {
  const state = { down: true };
  setRevisionBackend(downStore(state), ON);
  writeWorkspaceFile(T, W, "memory/a.md", "a\n", { by: "user:a" });
  await flushRevisions();
  resetJournalForTests();
  setRevisionBackend(deps, ON);
  assert.equal((await recoverJournal()).entries, 0, "fresh files belong to a process that may still be retrying");
  fs.writeFileSync(path.join(journalDir(), "00000000000001-000000-torn.json"), "{not json");
  const gone = path.join(root, ".revision-journal", T, "deleted-ws");
  fs.mkdirSync(gone, { recursive: true });
  fs.writeFileSync(path.join(gone, "00000000000001-000000-x.json"), JSON.stringify({ v: 1, id: "x", files: [], by: "a", message: "m", at: "t" }));
  await recoverJournal({ minAgeMs: 0 });
  assert.equal(await text("memory/a.md"), "a\n");
  assert.equal(fs.existsSync(path.join(gone, "00000000000001-000000-x.json")), false);
  assert.ok(fs.readdirSync(journalDir()).some((n) => n.endsWith(".unreadable")), "a torn file is kept aside, not replayed");
});

test("reconcile at boot repairs a head that disagrees with the folder (a lost entry, a run's direct write)", async () => {
  setRevisionBackend(deps, ON);
  writeWorkspaceFile(T, W, "memory/a.md", "a\n", { by: "user:a" });
  await flushRevisions();
  // the folder changes behind the journal's back
  fs.writeFileSync(path.join(workspaceDir(T, W), "memory", "a.md"), "changed by a run\n");
  fs.writeFileSync(path.join(workspaceDir(T, W), "memory", "new.md"), "new\n");
  fs.rmSync(path.join(workspaceDir(T, W), "AGENTS.md"));
  resetJournalForTests();
  const r = await reconcileAll();
  assert.deepEqual({ checked: r.checked, repaired: r.repaired, failed: r.failed }, { checked: 1, repaired: 1, failed: 0 });
  assert.equal(await text("memory/a.md"), "changed by a run\n");
  assert.equal(await text("memory/new.md"), "new\n");
  assert.equal(await text("AGENTS.md"), null);
  // nothing left to repair: no new revision
  const n = (await listRevisionSummaries(T, W)).length;
  assert.equal((await reconcileAll()).repaired, 0);
  assert.equal((await listRevisionSummaries(T, W)).length, n);
});

test("a workspace is reconciled once per process on its first drain: a journal that was off for a while catches up", async () => {
  let on = true;
  setRevisionBackend(deps, { journal: () => on });
  writeWorkspaceFile(T, W, "memory/a.md", "a\n", { by: "user:a" });
  await flushRevisions();
  on = false;
  writeWorkspaceFile(T, W, "memory/b.md", "b\n", { by: "user:a" }); // not journalled
  assert.equal(await text("memory/b.md"), null);
  on = true;
  writeWorkspaceFile(T, W, "memory/c.md", "c\n", { by: "user:a" });
  await flushRevisions();
  assert.equal(await text("memory/c.md"), "c\n");
  assert.equal(await text("memory/b.md"), "b\n", "the head caught up with the folder");
});

test("a restore is a new revision with restoredFrom, written through the folder", async () => {
  setRevisionBackend(deps, ON);
  writeWorkspaceFile(T, W, "memory/n.md", "v1\n", { by: "user:a", message: "v1" });
  await flushRevisions();
  const v1 = (await listRevisionSummaries(T, W))[0];
  writeWorkspaceFile(T, W, "memory/n.md", "v2\n", { by: "user:a", message: "v2" });
  await flushRevisions();
  // what applyRestore does: write the older content to the folder, tagged
  asRestoreOf(T, W, v1.id, () => writeWorkspaceFile(T, W, "memory/n.md", "v1\n", { by: "user:a", message: `restored to ${v1.id}` }));
  await flushRevisions();
  const head = (await listRevisionSummaries(T, W))[0];
  assert.equal(head.message, `restored to ${v1.id}`);
  assert.equal(await text("memory/n.md"), "v1\n");
  const heads = await headsOf(deps, { tenant: T, workspace: W });
  assert.equal(heads.workspace?.restoredFrom, v1.id);
  assert.equal((await listRevisionSummaries(T, W)).length, 3, "history is kept");
  // a tag for a revision that is not in the store is ignored, not fatal
  asRestoreOf(T, W, "no-such-revision", () => writeWorkspaceFile(T, W, "memory/n.md", "v3\n", { by: "user:a" }));
  await flushRevisions();
  assert.equal(await text("memory/n.md"), "v3\n");
});

test("history comes from revisions, with the older local history after them; ids from either resolve", async () => {
  // local history exists before the journal is switched on
  writeWorkspaceFile(T, W, "memory/a.md", "old\n", { by: "user:a", message: "before" });
  const [localOnly] = await listRevisions(T, W);
  await new Promise((r) => setTimeout(r, 5));
  setRevisionBackend(deps, ON);
  writeWorkspaceFile(T, W, "memory/a.md", "new\n", { by: "user:b", message: "after" });
  await flushRevisions();
  const list = await listRevisions(T, W);
  assert.deepEqual(list.map((r) => r.message).slice(0, 1), ["after"]);
  assert.ok(list.some((r) => r.id === localOnly.id), "the older local entry is still listed");
  assert.notEqual(list[0].id, localOnly.id);
  const rev = (await readRevision(T, W, list[0].id))!;
  assert.equal(rev.files.find((f) => f.path === "memory/a.md")?.after, "new\n");
  assert.equal((await snapshotAt(T, W, list[0].id))?.find((f) => f.path === "memory/a.md")?.content, "new\n");
  assert.equal((await snapshotAt(T, W, localOnly.id))?.find((f) => f.path === "memory/a.md")?.content, "old\n", "a local id still resolves");
  assert.equal(await hasSnapshot(T, W, list[0].id), true);
  assert.equal((await headRevision(T, W))?.id, list[0].id);
  assert.equal((await latestRevisionId(T, W)), list[0].id);
  assert.equal((await resolveRevision(T, W, list[0].id))?.id, list[0].id);
  assert.equal((await resolveRevision(T, W, localOnly.id))?.id, localOnly.id);
  assert.equal((await resolveRevision(T, W, "0m"))?.id, list[0].id);
  assert.ok((await changedPathsBetween(T, W, localOnly.id, list[0].id))?.includes("memory/a.md"), "across both kinds of id (the first revision is the whole tree)");
});

test("a store that errors on history falls back to the local history, not to an error page", async () => {
  writeWorkspaceFile(T, W, "memory/a.md", "x\n", { by: "user:a", message: "local" });
  const broken = { ...deps, revisions: new Proxy(deps.revisions, { get: (t, p, r) => (p === "revisions" ? () => Promise.reject(new Error("db down")) : Reflect.get(t, p, r)) }) };
  setRevisionBackend(broken as Deps, ON);
  const list = await listRevisions(T, W);
  assert.deepEqual(list.map((r) => r.message), ["local"]);
});

test("reads through heads: head first, the folder as the fallback; a stage-in tree from blobs", async () => {
  setRevisionBackend(deps, { journal: () => true, read: () => false });
  writeWorkspaceFile(T, W, "memory/a.md", "head\n", { by: "user:a" });
  await flushRevisions();
  assert.equal(await readHeadText(T, W, "memory/a.md"), null, "reads are off: the caller reads the folder");
  assert.equal(await readHeadTree(T, W), null);
  setRevisionBackend(deps, ON);
  assert.equal(await readHeadText(T, W, "memory/a.md"), "head\n");
  assert.equal(await readHeadText(T, W, "memory/none.md"), null, "not in the head: the folder decides");
  const tree = (await readHeadTree(T, W))!;
  assert.ok(tree.some((f) => f.path === "memory/a.md" && f.bytes.toString() === "head\n"));
  // a missing blob: no partial tree
  fs.rmSync(path.join(root, ".objects"), { recursive: true, force: true });
  assert.equal(await readHeadTree(T, W), null);
  assert.equal(await readHeadText(T, W, "memory/a.md"), null, "a store that cannot give the bytes: the folder answers");
  // no head yet
  assert.equal(await readHeadTree(T, "other"), null);
});

test("the editable-file read: the head when it has the file, the folder (same errors) otherwise", async () => {
  setRevisionBackend(deps, ON);
  writeWorkspaceFile(T, W, "memory/b.md", "b-folder\n", { by: "user:a" });
  await flushRevisions();
  fs.writeFileSync(path.join(workspaceDir(T, W), "memory", "b.md"), "b-edited-behind\n"); // the head is behind
  assert.equal(await readWorkspaceFileVia(T, W, "memory/b.md"), "b-folder\n", "served from the head");
  fs.writeFileSync(path.join(workspaceDir(T, W), "memory", "only-in-folder.md"), "f\n");
  assert.equal(await readWorkspaceFileVia(T, W, "memory/only-in-folder.md"), "f\n", "not in the head: the folder");
  await assert.rejects(readWorkspaceFileVia(T, W, "memory/nope.md"), /file not found/);
  await assert.rejects(readWorkspaceFileVia(T, W, "../etc/passwd"));
  setRevisionBackend(deps, { journal: () => true, read: () => false });
  assert.equal(await readWorkspaceFileVia(T, W, "memory/b.md"), "b-edited-behind\n", "reads off: the folder");
});

test("the account shelf is journalled as its own scope, its paths under library/ (FOL-126, 13 Nov 2026)", async () => {
  setRevisionBackend(deps, ON);
  fs.mkdirSync(path.join(root, T, "library", "tools"), { recursive: true });
  fs.writeFileSync(path.join(root, T, "library", "tools", "x.md"), "x");
  recordRevision(T, "@library", [{ path: "tools/x.md", before: null, after: "x" }], { by: "user:a", message: "lib" });
  await flushRevisions();
  assert.equal(pendingRevisions(), 0);
  assert.equal((await readAtHead(T, "@library", "library/tools/x.md"))?.toString(), "x");
});

test("the journal file holds the new content only, not the old text", async () => {
  const state = { down: true };
  setRevisionBackend(downStore(state), ON);
  writeWorkspaceFile(T, W, "memory/a.md", "x".repeat(5000), { by: "user:a" });
  writeWorkspaceFile(T, W, "memory/a.md", "y".repeat(5000), { by: "user:a" });
  const files = fs.readdirSync(journalDir()).filter((n) => n.endsWith(".json")).sort().map((n) => JSON.parse(fs.readFileSync(path.join(journalDir(), n), "utf8")));
  assert.equal(files.length, 2);
  for (const f of files) assert.ok(f.files.every((x: { before: unknown }) => x.before === null));
  assert.ok(String(files[1].files[0].after).startsWith("yyyy") && !String(files[1].files[0].after).includes("x"), "the new text");
});

test("the history page's list says which rows can be restored, from one listing", async () => {
  writeWorkspaceFile(T, W, "memory/a.md", "old\n", { by: "user:a", message: "before" });
  await new Promise((r) => setTimeout(r, 5));
  setRevisionBackend(deps, ON);
  writeWorkspaceFile(T, W, "memory/a.md", "new\n", { by: "user:b", message: "after" });
  await flushRevisions();
  const rows = await listRevisionsRestorable(T, W, { limit: 50 });
  assert.equal(rows[0].message, "after");
  assert.ok(rows.every((r) => r.restorable), "a stored revision, and a local one with a snapshot");
});

test("dropJournal forgets an account's queued changes and removes its files, nobody else's", async () => {
  const state = { down: true };
  setRevisionBackend(downStore(state), ON);
  writeWorkspaceFile(T, W, "memory/a.md", "a\n", { by: "user:a" });
  await flushRevisions();
  assert.equal(pendingRevisions(), 1);
  fs.mkdirSync(path.join(root, ".revision-journal", "other", "w"), { recursive: true });
  dropJournal(T);
  assert.equal(pendingRevisions(), 0);
  assert.equal(fs.existsSync(path.join(root, ".revision-journal", T)), false);
  assert.ok(fs.existsSync(path.join(root, ".revision-journal", "other", "w")));
  dropJournal(T); // repeatable
});

// ---- history past the first page of the store (FOL-152) ----

test("history is not the store's first page: older revisions list, restore and resolve by id or date", async () => {
  // A store that answers at most 3 revisions a page stands in for one with
  // more than 500 (the real page limit), without writing 500 revisions.
  const capped: RevisionStore = new Proxy(deps.revisions, {
    get(target, prop, recv) {
      const v = Reflect.get(target, prop, recv);
      if (prop === "revisions") return (ws: Parameters<RevisionStore["revisions"]>[0], o: { limit?: number; before?: number } = {}) => target.revisions(ws, { ...o, limit: Math.min(o.limit ?? 50, 3) });
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
  setRevisionBackend({ ...deps, revisions: capped }, ON);
  for (let i = 0; i < 7; i++) {
    writeWorkspaceFile(T, W, "memory/a.md", `v${i}\n`, { by: "user:a", message: `v${i}` });
    await flushRevisions();
    await new Promise((r) => setTimeout(r, 3)); // distinct times, for the date lookup
  }
  // Only the store answers: no local history to fall back on.
  fs.rmSync(path.join(root, T, ".history"), { recursive: true, force: true });
  const all = await listRevisions(T, W, { limit: 50 });
  assert.deepEqual(all.map((r) => r.message), ["v6", "v5", "v4", "v3", "v2", "v1", "v0"], "every page");
  const oldest = all[all.length - 1];
  assert.equal(await hasSnapshot(T, W, oldest.id), true, "found by id, not by looking in the first page");
  assert.equal((await resolveRevision(T, W, oldest.id))?.id, oldest.id);
  assert.equal((await resolveRevision(T, W, all[5].at))?.id, all[5].id, "a date older than the first page");
  const rows = await listRevisionsRestorable(T, W, { limit: 50 });
  assert.equal(rows.length, 7);
  assert.ok(rows.every((r) => r.restorable), `every stored revision can be restored to (${rows.filter((r) => !r.restorable).map((r) => r.message)})`);
  assert.deepEqual((await listRevisions(T, W, { limit: 4 })).map((r) => r.message), ["v6", "v5", "v4", "v3"], "a limit is still a limit");
});

// ---- a read agrees with the write's ifMatch while a commit is pending (FOL-152) ----

import { recordStepOutputs } from "../src/workspace-revisions.ts";

test("the editable-file read serves the folder while the head is known to be behind it: queued, marked, or written with the journal off", async () => {
  const state = { down: false };
  setRevisionBackend(downStore(state), ON);
  const folder = (rel: string) => fs.readFileSync(path.join(workspaceDir(T, W), rel), "utf8");
  writeWorkspaceFile(T, W, "memory/b.md", "v1\n", { by: "user:a" });
  await flushRevisions();
  assert.equal(await readWorkspaceFileVia(T, W, "memory/b.md"), "v1\n");

  // A save whose commit cannot land yet: the read is what the save's ifMatch
  // is checked against (the folder), not the older head.
  state.down = true;
  writeWorkspaceFile(T, W, "memory/b.md", "v2\n", { by: "user:a" });
  assert.equal((await flushRevisions({ tenant: T, workspace: W })).pending, 1);
  assert.equal(await text("memory/b.md"), "v1\n", "the head is behind");
  assert.equal(await readWorkspaceFileVia(T, W, "memory/b.md"), folder("memory/b.md"), "a queued change: the folder");
  state.down = false;
  await flushRevisions({ tenant: T, workspace: W });
  assert.equal(await text("memory/b.md"), "v2\n");
  fs.writeFileSync(path.join(workspaceDir(T, W), "memory", "b.md"), "behind, unrecorded\n");
  assert.equal(await readWorkspaceFileVia(T, W, "memory/b.md"), "v2\n", "nothing pending: the head again");

  // Marked for a repair (a file too big to journal): the folder, until the reconcile.
  recordStepOutputs(T, W, [{ path: "state/big.json", base: null, after: Buffer.alloc(1024 * 1024 + 1, 97) }], { runId: "r-big", step: "p" });
  assert.equal(await readWorkspaceFileVia(T, W, "memory/b.md"), "behind, unrecorded\n", "marked: the folder");
  writeWorkspaceFile(T, W, "memory/c.md", "c\n", { by: "user:a" }); // a drain runs, and the reconcile with it
  await flushRevisions({ tenant: T, workspace: W });
  fs.writeFileSync(path.join(workspaceDir(T, W), "memory", "b.md"), "behind again\n");
  assert.equal(await readWorkspaceFileVia(T, W, "memory/b.md"), "behind, unrecorded\n", "reconciled: the head again");

  // Written while the journal was off: the head never saw it.
  setRevisionBackend(downStore(state), { journal: () => false, read: () => false });
  writeWorkspaceFile(T, W, "memory/b.md", "while off\n", { by: "user:a" });
  setRevisionBackend(downStore(state), ON);
  assert.equal(await readWorkspaceFileVia(T, W, "memory/b.md"), "while off\n", "changed with the journal off: the folder");
});
