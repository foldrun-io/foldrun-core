// A pod's folders as a copy of the heads (FOL-126, the shared volume retired;
// revisions.mirror). Two pods are two data roots over one revision store and
// one blob store: what one writes and publishes, the other's sync brings; a
// change made on a pod is published against the version it synced, so a
// change made meanwhile elsewhere is a conflict (both kept), never lost.
//
//   node --test tests/workspace-mirror.test.ts

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { writeWorkspaceFile, deleteWorkspacePath, workspaceDir } from "../src/store.ts";
import { fsBlobStore, bounded } from "../src/blob-store.ts";
import { localRevisionStore } from "../src/revision-store.ts";
import {
  setRevisionBackend, resetJournalForTests, flushRevisions, readAtHead, reconcileWorkspace, syncFromHeads, syncAllFromHeads, dropWorkspaceRevisions,
} from "../src/workspace-revisions.ts";
import { setMirrorGate, readMirrorBase } from "../src/mirror-base.ts";
import type { Deps } from "../src/publish.ts";

const T = "acme";
const W = "desk";
const ON = { journal: () => true, read: () => true };
let shared: string;
let podA: string;
let podB: string;

const on = (pod: string) => (process.env.FOLDRUN_DATA = pod);
const file = (rel: string) => path.join(workspaceDir(T, W), rel);
const read = (rel: string) => (fs.existsSync(file(rel)) ? fs.readFileSync(file(rel), "utf8") : null);
const head = async (rel: string) => (await readAtHead(T, W, rel))?.toString("utf8") ?? null;

beforeEach(() => {
  shared = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-mirror-shared-"));
  podA = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-mirror-a-"));
  podB = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-mirror-b-"));
  const deps: Deps = { blobs: bounded(fsBlobStore(path.join(shared, ".objects")), { backoffMs: 1 }), revisions: localRevisionStore(path.join(shared, ".revisions")) };
  setRevisionBackend(deps, ON);
  setMirrorGate(() => true);
  // Pod A has the workspace (made there), pod B starts empty, as a new pod does.
  on(podA);
  fs.mkdirSync(path.join(workspaceDir(T, W), "agents", "writer"), { recursive: true });
  fs.writeFileSync(file("AGENTS.md"), "---\nname: desk\n---\n");
  fs.writeFileSync(file("agents/writer/agent.md"), "---\nname: writer\n---\nv1\n");
});
afterEach(() => {
  setRevisionBackend(null);
  setMirrorGate(null);
  resetJournalForTests();
  for (const d of [shared, podA, podB]) fs.rmSync(d, { recursive: true, force: true });
  delete process.env.FOLDRUN_DATA;
});

test("a new pod's sync brings every workspace from the heads, and records what it brought", async () => {
  writeWorkspaceFile(T, W, "memory/notes.md", "from A\n", { by: "user:a" });
  await flushRevisions();
  on(podB);
  assert.equal(fs.existsSync(workspaceDir(T, W)), false);
  const r = await syncAllFromHeads();
  assert.deepEqual(r, { synced: 1, removed: 0, failed: 0 });
  assert.equal(read("memory/notes.md"), "from A\n");
  assert.equal(read("agents/writer/agent.md"), "---\nname: writer\n---\nv1\n");
  assert.ok(readMirrorBase(T, W)?.files["memory/notes.md"]);
  assert.equal(await syncFromHeads(T, W), "unchanged", "nothing moved since");
});

test("a later change on one pod reaches the other; a delete there removes it here", async () => {
  writeWorkspaceFile(T, W, "memory/notes.md", "one\n", { by: "user:a" });
  await flushRevisions();
  on(podB);
  await syncAllFromHeads();
  on(podA);
  writeWorkspaceFile(T, W, "memory/notes.md", "two\n", { by: "user:a" });
  writeWorkspaceFile(T, W, "memory/old.md", "old\n", { by: "user:a" });
  await flushRevisions();
  on(podB);
  await syncFromHeads(T, W);
  assert.equal(read("memory/old.md"), "old\n");
  on(podA);
  deleteWorkspacePath(T, W, "memory/old.md", { by: "user:a" });
  await flushRevisions();
  on(podB);
  assert.equal(await syncFromHeads(T, W), "synced");
  assert.equal(read("memory/notes.md"), "two\n");
  assert.equal(read("memory/old.md"), null, "deleted in the heads, untouched here: removed");
});

test("a change made here is never overwritten by a sync; the reconcile publishes it, and the other pod gets it", async () => {
  writeWorkspaceFile(T, W, "memory/notes.md", "one\n", { by: "user:a" });
  await flushRevisions();
  on(podB);
  await syncAllFromHeads();
  // On B, a file written outside the journal (a tool's output, say).
  fs.writeFileSync(file("memory/b-only.md"), "made on B\n");
  fs.writeFileSync(file("memory/notes.md"), "edited on B\n");
  // Meanwhile A changes another file.
  on(podA);
  writeWorkspaceFile(T, W, "AGENTS.md", "---\nname: desk2\n---\n", { by: "user:a" });
  await flushRevisions();
  on(podB);
  await syncFromHeads(T, W);
  assert.equal(read("memory/notes.md"), "edited on B\n", "this pod's edit is kept");
  assert.equal(read("memory/b-only.md"), "made on B\n");
  assert.equal(read("AGENTS.md"), "---\nname: desk2\n---\n", "the other pod's change still came");
  const rec = await reconcileWorkspace(T, W);
  assert.equal(await head("memory/notes.md"), "edited on B\n", JSON.stringify(rec));
  assert.equal(await head("memory/b-only.md"), "made on B\n");
  assert.equal(await head("AGENTS.md"), "---\nname: desk2\n---\n", "the reconcile did not undo A's change it had not seen");
  on(podA);
  await syncFromHeads(T, W);
  assert.equal(read("memory/notes.md"), "edited on B\n");
});

test("the same file changed on both pods: both versions are kept", async () => {
  writeWorkspaceFile(T, W, "memory/notes.md", "base\n", { by: "user:a" });
  await flushRevisions();
  on(podB);
  await syncAllFromHeads();
  fs.writeFileSync(file("memory/notes.md"), "B's version\n");
  on(podA);
  writeWorkspaceFile(T, W, "memory/notes.md", "A's version\n", { by: "user:a" });
  await flushRevisions();
  on(podB);
  await syncFromHeads(T, W);
  assert.equal(read("memory/notes.md"), "B's version\n", "not overwritten here");
  await reconcileWorkspace(T, W);
  assert.equal(await head("memory/notes.md"), "A's version\n", "the head keeps the version that got there first");
  const copies = fs.readdirSync(path.join(podB, T, "workspaces", W, "memory"));
  on(podA);
  await syncFromHeads(T, W);
  const conflict = fs.readdirSync(path.join(workspaceDir(T, W), "memory")).find((n) => n.includes(".conflict-"));
  assert.ok(conflict, `B's version kept beside it (B had ${copies.join(",")})`);
  assert.equal(read(`memory/${conflict}`), "B's version\n");
});

test("a workspace deleted elsewhere is removed here; one this pod never synced is left alone", async () => {
  writeWorkspaceFile(T, W, "memory/notes.md", "x\n", { by: "user:a" });
  await flushRevisions();
  on(podB);
  await syncAllFromHeads();
  fs.mkdirSync(path.join(podB, T, "workspaces", "local-only"), { recursive: true });
  on(podA);
  await dropWorkspaceRevisions(T, W, () => fs.rmSync(workspaceDir(T, W), { recursive: true, force: true }));
  on(podB);
  assert.deepEqual(await syncAllFromHeads(), { synced: 0, removed: 1, failed: 0 });
  assert.equal(fs.existsSync(workspaceDir(T, W)), false);
  assert.equal(readMirrorBase(T, W), null);
  assert.ok(fs.existsSync(path.join(podB, T, "workspaces", "local-only")));
});

test("no sync while this pod has changes still to publish", async () => {
  writeWorkspaceFile(T, W, "memory/notes.md", "x\n", { by: "user:a" });
  // Not flushed: the entry is queued here.
  assert.equal(await syncFromHeads(T, W), "skipped");
  await flushRevisions();
  assert.equal(await syncFromHeads(T, W), "synced");
});

test("off (a laptop, the CLI, until switched on): nothing is synced", async () => {
  setMirrorGate(null);
  writeWorkspaceFile(T, W, "memory/notes.md", "x\n", { by: "user:a" });
  await flushRevisions();
  on(podB);
  assert.deepEqual(await syncAllFromHeads(), { synced: 0, removed: 0, failed: 0 });
  assert.equal(fs.existsSync(workspaceDir(T, W)), false);
});

test("edited here, deleted elsewhere: the delete stands and this pod's version is kept as a copy — never brought back (Codex review)", async () => {
  writeWorkspaceFile(T, W, "memory/notes.md", "base\n", { by: "user:a" });
  await flushRevisions();
  on(podB);
  await syncAllFromHeads();
  fs.writeFileSync(file("memory/notes.md"), "edited on B\n");
  on(podA);
  deleteWorkspacePath(T, W, "memory/notes.md", { by: "user:a" });
  await flushRevisions();
  on(podB);
  await syncFromHeads(T, W);
  assert.equal(read("memory/notes.md"), "edited on B\n", "not removed under the edit");
  assert.ok(readMirrorBase(T, W)?.files["memory/notes.md"], "its base is kept");
  await reconcileWorkspace(T, W);
  assert.equal(await head("memory/notes.md"), null, "the delete stands");
  assert.equal(read("memory/notes.md"), null, "the original went here too");
  assert.equal(await syncFromHeads(T, W), "synced", "the copy comes with the next sync");
  const copy = fs.readdirSync(path.join(workspaceDir(T, W), "memory")).find((n) => n.includes(".conflict-"));
  assert.ok(copy && read(`memory/${copy}`) === "edited on B\n", "this pod's version kept beside it");
  await reconcileWorkspace(T, W);
  assert.equal(await head("memory/notes.md"), null, "and a second reconcile does not bring it back");
});

test("a sync that stops partway keeps what it wrote as synced, so the rest comes next time without false conflicts (Codex review)", async () => {
  writeWorkspaceFile(T, W, "memory/a.md", "a1\n", { by: "user:a" });
  writeWorkspaceFile(T, W, "memory/b.md", "b1\n", { by: "user:a" });
  await flushRevisions();
  on(podB);
  await syncAllFromHeads();
  on(podA);
  writeWorkspaceFile(T, W, "memory/a.md", "a2\n", { by: "user:a" });
  writeWorkspaceFile(T, W, "memory/b.md", "b2\n", { by: "user:a" });
  await flushRevisions();
  on(podB);
  // The second download fails: the blob is gone.
  const shared2 = fs.readdirSync(path.join(shared, ".objects"), { recursive: true }).map(String);
  const bSha = (await import("../src/manifest.ts")).sha256Hex(Buffer.from("b2\n"));
  const hide = shared2.find((n) => n.includes(bSha));
  assert.ok(hide, "the blob is where the test expects");
  fs.renameSync(path.join(shared, ".objects", hide!), path.join(shared, "hidden"));
  await assert.rejects(syncFromHeads(T, W));
  assert.equal(read("memory/a.md"), "a2\n");
  fs.renameSync(path.join(shared, "hidden"), path.join(shared, ".objects", hide!));
  assert.equal(await syncFromHeads(T, W), "synced");
  assert.equal(read("memory/b.md"), "b2\n");
  assert.equal(await reconcileWorkspace(T, W), null, "nothing here is taken for this pod's own change");
});

test("a file the heads turned into a folder (and back) is followed; a symlinked folder is never written through (Codex review)", async () => {
  writeWorkspaceFile(T, W, "knowledge/item.md", "a file\n", { by: "user:a" });
  await flushRevisions();
  on(podB);
  await syncAllFromHeads();
  assert.equal(read("knowledge/item.md"), "a file\n");
  on(podA);
  deleteWorkspacePath(T, W, "knowledge/item.md", { by: "user:a" });
  writeWorkspaceFile(T, W, "knowledge/item.md/note.md", "now a folder\n", { by: "user:a" });
  await flushRevisions();
  on(podB);
  assert.equal(await syncFromHeads(T, W), "synced");
  assert.equal(read("knowledge/item.md/note.md"), "now a folder\n");
  // A symlinked folder on B: a new file under it in the heads is not written through it.
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-mirror-outside-"));
  fs.symlinkSync(outside, file("skills"));
  on(podA);
  writeWorkspaceFile(T, W, "skills/new/SKILL.md", "---\nname: new\ndescription: d\n---\nx\n", { by: "user:a" });
  await flushRevisions();
  on(podB);
  await syncFromHeads(T, W);
  assert.deepEqual(fs.readdirSync(outside), [], "nothing written outside the workspace");
  fs.rmSync(outside, { recursive: true, force: true });
  // The link removed here: the next pass brings the file, without another commit.
  fs.unlinkSync(file("skills"));
  assert.equal(await syncFromHeads(T, W), "synced");
  assert.match(read("skills/new/SKILL.md") ?? "", /name: new/);
});

test("a copy whose folder was cleared is brought back from the heads, never published as deleted (Codex review)", async () => {
  writeWorkspaceFile(T, W, "memory/notes.md", "keep me\n", { by: "user:a" });
  await flushRevisions();
  on(podB);
  await syncAllFromHeads();
  fs.rmSync(workspaceDir(T, W), { recursive: true, force: true });
  assert.ok(readMirrorBase(T, W), "the record survived");
  assert.equal(await syncFromHeads(T, W), "synced");
  assert.equal(read("memory/notes.md"), "keep me\n");
  assert.equal(await reconcileWorkspace(T, W), null);
  assert.equal(await head("memory/notes.md"), "keep me\n");
});

test("a synced folder replaced here by a link: its files are out of reach, never published as deleted (Codex review)", async () => {
  writeWorkspaceFile(T, W, "knowledge/a.md", "a\n", { by: "user:a" });
  await flushRevisions();
  on(podB);
  await syncAllFromHeads();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-mirror-link-"));
  fs.rmSync(file("knowledge"), { recursive: true, force: true });
  fs.symlinkSync(outside, file("knowledge"));
  on(podA);
  writeWorkspaceFile(T, W, "memory/other.md", "moves the head\n", { by: "user:a" });
  await flushRevisions();
  on(podB);
  await syncFromHeads(T, W);
  await reconcileWorkspace(T, W);
  assert.equal(await head("knowledge/a.md"), "a\n", "still in the heads");
  fs.rmSync(outside, { recursive: true, force: true });
});

test("a save through the journal on a pod that has not seen another pod's change yet: both kept, nothing overwritten (Codex review)", async () => {
  writeWorkspaceFile(T, W, "memory/notes.md", "base\n", { by: "user:a" });
  await flushRevisions();
  on(podB);
  await syncAllFromHeads();
  on(podA);
  writeWorkspaceFile(T, W, "memory/notes.md", "A saved\n", { by: "user:a" });
  await flushRevisions();
  on(podB); // B has not synced A's save yet
  writeWorkspaceFile(T, W, "memory/notes.md", "B saved\n", { by: "user:b" });
  await flushRevisions();
  assert.equal(await head("memory/notes.md"), "A saved\n", "the first save stands");
  await syncFromHeads(T, W);
  const copy = fs.readdirSync(path.join(workspaceDir(T, W), "memory")).find((n) => n.includes(".conflict-"));
  assert.ok(copy && read(`memory/${copy}`) === "B saved\n", "B's save kept beside it");
});

test("the account shelf (account AGENTS.md + library/) is a scope of its own: a library write on one pod reaches the other (FOL-126)", async () => {
  const { writeLibraryFile } = await import("../src/library.ts");
  const { accountDir } = await import("../src/store.ts");
  fs.writeFileSync(path.join(accountDir(T), "AGENTS.md"), "---\nname: acme\n---\naccount rules\n");
  writeLibraryFile(T, "skills", "house-style/SKILL.md", "---\nname: house-style\ndescription: d\n---\nbe brief\n", { by: "user:a" });
  await flushRevisions();
  on(podB);
  await syncAllFromHeads();
  assert.equal(fs.readFileSync(path.join(accountDir(T), "library", "skills", "house-style", "SKILL.md"), "utf8"), "---\nname: house-style\ndescription: d\n---\nbe brief\n");
  assert.equal(fs.readFileSync(path.join(accountDir(T), "AGENTS.md"), "utf8"), "---\nname: acme\n---\naccount rules\n");
});

test("the account shelf's heads gone: only the shelf's files go, never the account folder (Codex review)", async () => {
  const { writeLibraryFile } = await import("../src/library.ts");
  const { accountDir } = await import("../src/store.ts");
  writeLibraryFile(T, "skills", "s/SKILL.md", "---\nname: s\ndescription: d\n---\nx\n", { by: "user:a" });
  writeWorkspaceFile(T, W, "memory/notes.md", "x\n", { by: "user:a" });
  await flushRevisions();
  on(podB);
  await syncAllFromHeads();
  const { setRevisionBackend: _ } = await import("../src/workspace-revisions.ts");
  // The shelf's history dropped in the store (by hand: no lifecycle drops it).
  fs.rmSync(path.join(shared, ".revisions", T, "@library"), { recursive: true, force: true });
  await syncAllFromHeads();
  assert.equal(fs.existsSync(path.join(accountDir(T), "library")), false, "the shelf went");
  assert.equal(read("memory/notes.md"), "x\n", "the workspace stays");
});

test("a blob whose bytes do not hash to its name is refused: never written into a pod's copy (security review)", async () => {
  writeWorkspaceFile(T, W, "memory/notes.md", "genuine\n", { by: "user:a" });
  await flushRevisions();
  const { sha256Hex } = await import("../src/manifest.ts");
  const sha = sha256Hex(Buffer.from("genuine\n"));
  const objects = fs.readdirSync(path.join(shared, ".objects"), { recursive: true }).map(String);
  const hit = objects.find((n) => n.endsWith(sha));
  assert.ok(hit);
  fs.writeFileSync(path.join(shared, ".objects", hit!), "tampered\n");
  on(podB);
  const r = await syncAllFromHeads();
  assert.equal(r.failed, 1);
  assert.notEqual(read("memory/notes.md"), "tampered\n");
});
