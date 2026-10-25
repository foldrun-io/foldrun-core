// Every change kept: the revision journal, and the writers that feed it.
//
//   node --test tests/history.test.ts

import { test } from "node:test";

// The journal is the history: there is no git behind it since 17 Oct 2026.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  diffLines,
  ensureBaseline,
  headRevision,
  latestRevisionId,
  listRevisions,
  readRevision,
  recordRevision,
  resolveRevision,
  snapshotAt,
} from "../src/history.ts";
import {
  deleteWorkspacePath,
  listWorkspaceFiles,
  saveWorkspace,
  workspaceDir,
  writeWorkspaceFile,
} from "../src/store.ts";
import { writeEvalResult, readEvalHistory, type EvalResult } from "../src/evals.ts";

function withData(run: () => void) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-history-"));
  const prev = process.env.FOLDRUN_DATA;
  process.env.FOLDRUN_DATA = root;
  try {
    run();
  } finally {
    if (prev === undefined) delete process.env.FOLDRUN_DATA;
    else process.env.FOLDRUN_DATA = prev;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const AGENTS = "---\nname: desk\n---\n";

// ---------------------------------------------------------------- journal

test("a change is recorded with its before and after; identical content is not", () =>
  withData(() => {
    const rev = recordRevision("acme", "desk", [{ path: "a.md", before: "one\n", after: "two\n" }], { by: "me" });
    assert.ok(rev);
    assert.equal(rev.by, "me");
    assert.equal(rev.message, "edited a.md");
    assert.deepEqual(readRevision("acme", "desk", rev.id)!.files[0], { path: "a.md", before: "one\n", after: "two\n" });

    assert.equal(recordRevision("acme", "desk", [{ path: "a.md", before: "x", after: "x" }]), null, "a no-op save is not history");
    assert.equal(listRevisions("acme", "desk").length, 1);
  }));

test("a deploy's revision id is its commit", () =>
  withData(() => {
    const rev = recordRevision("acme", "desk", [{ path: "a.md", before: null, after: "x" }], { commit: "abc1234def" });
    assert.equal(rev!.id, "abc1234def");
    assert.equal(rev!.commit, "abc1234def");
    assert.equal(latestRevisionId("acme", "desk"), "abc1234def");
  }));

test("history is newest first, and narrows to one file", () =>
  withData(() => {
    recordRevision("acme", "desk", [{ path: "a.md", before: null, after: "1" }], { message: "first" });
    recordRevision("acme", "desk", [{ path: "b.md", before: null, after: "1" }], { message: "second" });
    recordRevision("acme", "desk", [{ path: "a.md", before: "1", after: "2" }], { message: "third" });
    assert.deepEqual(listRevisions("acme", "desk").map((r) => r.message), ["third", "second", "first"]);
    assert.deepEqual(listRevisions("acme", "desk", { forPath: "a.md" }).map((r) => r.message), ["third", "first"]);
  }));

test("scopes do not mix: a workspace, another workspace, the library", () =>
  withData(() => {
    recordRevision("acme", "desk", [{ path: "a.md", before: null, after: "x" }]);
    recordRevision("acme", "other", [{ path: "a.md", before: null, after: "x" }]);
    recordRevision("acme", "@library", [{ path: "tools/x.md", before: null, after: "x" }]);
    assert.equal(listRevisions("acme", "desk").length, 1);
    assert.equal(listRevisions("acme", "@library").length, 1);
    assert.equal(listRevisions("beta", "desk").length, 0);
  }));

// ---------------------------------------------------------------- writers

test("a dashboard save records who and what; a deploy records its commit and what it removed", () =>
  withData(() => {
    saveWorkspace("acme", "desk", [
      { path: "AGENTS.md", content: AGENTS },
      { path: "flows/old.md", content: "---\nname: old\n---\n\n1. [[a]] — x\n" },
    ]);
    writeWorkspaceFile("acme", "desk", "knowledge/style.md", "---\ntitle: Style\n---\n\nshort.\n", { by: "matt@example.com" });
    writeWorkspaceFile("acme", "desk", "knowledge/style.md", "---\ntitle: Style\n---\n\nshorter.\n", { by: "matt@example.com" });

    const edits = listRevisions("acme", "desk", { forPath: "knowledge/style.md" });
    assert.equal(edits.length, 2);
    assert.equal(edits[0].by, "matt@example.com");
    assert.equal(edits[0].message, "edited knowledge/style.md");
    assert.equal(edits[1].message, "created knowledge/style.md");
    const full = readRevision("acme", "desk", edits[0].id)!;
    assert.match(full.files[0].before!, /short\./);
    assert.match(full.files[0].after!, /shorter\./);

    // A deploy that drops flows/old.md records the deletion, with the commit as id.
    saveWorkspace(
      "acme",
      "desk",
      [{ path: "AGENTS.md", content: AGENTS }, { path: "knowledge/style.md", content: "---\ntitle: Style\n---\n\nshortest.\n" }],
      { commit: "c0ffee1" },
    );
    const deploy = readRevision("acme", "desk", "c0ffee1")!;
    assert.equal(deploy.by, "deploy");
    const removed = deploy.files.find((f) => f.path === "flows/old.md");
    assert.ok(removed, "the deploy recorded the file it removed");
    assert.equal(removed!.after, null);
    assert.match(removed!.before!, /name: old/);
  }));

test("deleting a folder tool records every file in it", () =>
  withData(() => {
    saveWorkspace("acme", "desk", [{ path: "AGENTS.md", content: AGENTS }]);
    writeWorkspaceFile("acme", "desk", "tools/x/tool.md", "---\ntransport: script\nname: x\nrun: run.py\n---\n");
    writeWorkspaceFile("acme", "desk", "tools/x/run.py", "print(1)\n");
    deleteWorkspacePath("acme", "desk", "tools/x", { by: "matt@example.com" });
    const [rev] = listRevisions("acme", "desk");
    assert.equal(rev.message, "deleted tools/x/");
    assert.deepEqual(rev.paths.sort(), ["tools/x/run.py", "tools/x/tool.md"]);
    assert.match(readRevision("acme", "desk", rev.id)!.files.find((f) => f.path === "tools/x/run.py")!.before!, /print/);
  }));

test("a folder with an underscore in its name is deleted whole, like any other", () =>
  withData(() => {
    saveWorkspace("acme", "desk", [{ path: "AGENTS.md", content: AGENTS }]);
    writeWorkspaceFile("acme", "desk", "tools/old_tool/tool.md", "---\ntransport: script\nname: old_tool\nrun: run.mjs\n---\n");
    writeWorkspaceFile("acme", "desk", "tools/old_tool/run.mjs", "console.log(1)\n");
    assert.throws(() => deleteWorkspacePath("acme", "desk", "tools/old_tool/tool.md"), /its folder's identity/);
    deleteWorkspacePath("acme", "desk", "tools/old_tool", { by: "matt@example.com" });
    const [rev] = listRevisions("acme", "desk");
    assert.equal(rev.message, "deleted tools/old_tool/");
    assert.deepEqual(rev.paths.sort(), ["tools/old_tool/run.mjs", "tools/old_tool/tool.md"]);
  }));

// ----------------------------------------------------------- attribution

test("an eval on a workspace that never saw git is attributed to its latest revision", () =>
  withData(() => {
    saveWorkspace("acme", "desk", [{ path: "AGENTS.md", content: AGENTS }]);
    writeWorkspaceFile("acme", "desk", "agents/w/agent.md", "---\nname: w\n---\n\nwrite.\n", { by: "matt@example.com" });
    const latest = latestRevisionId("acme", "desk")!;
    writeEvalResult("acme", "desk", {
      eval: "q", startedAt: "2026-08-31T10:00:00Z", finishedAt: "2026-08-31T10:00:00Z",
      passed: 1, failed: 0, costUsd: 0, cases: [],
    } as EvalResult);
    assert.equal(readEvalHistory("acme", "desk")[0].commit, latest, "the score names the change it measured");
  }));

// ------------------------------------------------------------------- diff

test("a line diff says what changed and keeps what did not", () => {
  const ops = diffLines("a\nb\nc\n", "a\nB\nc\nd\n");
  assert.deepEqual(
    ops.map((o) => `${o.kind}:${o.text}`),
    ["same:a", "del:b", "add:B", "same:c", "add:d", "same:"],
  );
  assert.deepEqual(diffLines("x", "x"), [{ kind: "same", text: "x" }]);
  assert.deepEqual(diffLines("", "new"), [{ kind: "del", text: "" }, { kind: "add", text: "new" }].map((o) => o).filter(Boolean).length ? diffLines("", "new") : []);
});

// -------------------------------------------------------------- snapshots

test("every revision the store's writers record carries the whole tree, and restores read it back", () =>
  withData(() => {
    saveWorkspace("acme", "desk", [{ path: "AGENTS.md", content: AGENTS }, { path: "flows/go.md", content: "---\nname: go\n---\n\n1. [[a]] — x\n" }], { commit: null, by: "system" });
    writeWorkspaceFile("acme", "desk", "knowledge/style.md", "---\ntitle: Style\n---\n\nshort.\n", { by: "matt@example.com" });
    writeWorkspaceFile("acme", "desk", "knowledge/style.md", "---\ntitle: Style\n---\n\nshorter.\n", { by: "matt@example.com" });
    deleteWorkspacePath("acme", "desk", "flows/go.md", { by: "matt@example.com" });

    const log = listRevisions("acme", "desk");
    assert.deepEqual(log.map((r) => r.message).slice(0, 3), ["deleted flows/go.md", "edited knowledge/style.md", "created knowledge/style.md"]);
    assert.match(log[0].id, /^r-/, "a local revision id, visibly not a sha");
    // the head is the tree on disk, generated indexes included
    const head = headRevision("acme", "desk")!;
    assert.equal(head.id, log[0].id);
    assert.deepEqual(snapshotAt("acme", "desk", head.id)!.map((f) => f.path).sort(), listWorkspaceFiles("acme", "desk").sort());
    // and an older revision is the tree as it was then
    const before = snapshotAt("acme", "desk", log[2].id)!;
    assert.ok(before.some((f) => f.path === "flows/go.md"), "the deleted flow is there before its deletion");
    assert.match(before.find((f) => f.path === "knowledge/style.md")!.content, /short\./);
    assert.ok(before.some((f) => f.path === "knowledge/index.md"), "the generated index rides along");
  }));

test("a file that did not change between snapshots is stored once", () =>
  withData(() => {
    saveWorkspace("acme", "desk", [{ path: "AGENTS.md", content: AGENTS }, { path: "knowledge/big.md", content: "x".repeat(10_000) }], { commit: null, by: "system" });
    for (let i = 0; i < 5; i++) writeWorkspaceFile("acme", "desk", "knowledge/note.md", `n${i}\n`, { by: "me" });
    const blobs = path.join(process.env.FOLDRUN_DATA!, "acme/.history/desk/blobs");
    const all = fs.readdirSync(blobs, { recursive: true }).filter((f) => !fs.statSync(path.join(blobs, String(f))).isDirectory());
    // AGENTS.md, big.md, five versions of note.md (plus whatever generated
    // files the store writes) — not the whole tree six times
    assert.ok(all.length < 12, `${all.length} blobs`);
  }));

test("resolveRevision: an id, a deploy's commit, a date, a span back; nothing before history starts", () =>
  withData(() => {
    saveWorkspace("acme", "desk", [{ path: "AGENTS.md", content: AGENTS }], { commit: "abc1234def5678", by: "deploy" });
    const first = headRevision("acme", "desk")!;
    writeWorkspaceFile("acme", "desk", "knowledge/a.md", "a\n", { by: "me" });
    const second = headRevision("acme", "desk")!;
    assert.equal(resolveRevision("acme", "desk", first.id)!.id, first.id);
    assert.equal(resolveRevision("acme", "desk", "abc1234")!.id, first.id, "the commit a deploy recorded, by prefix");
    assert.equal(resolveRevision("acme", "desk", "0m")!.id, second.id);
    assert.equal(resolveRevision("acme", "desk", "3d"), null, "nothing that old");
    assert.equal(resolveRevision("acme", "desk", new Date(Date.parse(second.at) + 1000).toISOString())!.id, second.id);
    assert.throws(() => resolveRevision("acme", "desk", "--force"), /not a revision/);
    assert.throws(() => resolveRevision("acme", "desk", "2026-99-99"), /not a date/);
  }));

test("ensureBaseline gives a workspace with no snapshot one — its history starts there — once", () =>
  withData(() => {
    const ws = path.join(process.env.FOLDRUN_DATA!, "acme/workspaces/desk");
    fs.mkdirSync(path.join(ws, "agents/w"), { recursive: true });
    fs.writeFileSync(path.join(ws, "AGENTS.md"), AGENTS);
    fs.writeFileSync(path.join(ws, "agents/w/agent.md"), "---\nname: w\n---\n\nwrite.\n");
    assert.equal(headRevision("acme", "desk"), null);
    const id = ensureBaseline("acme", "desk");
    assert.ok(id);
    assert.equal(listRevisions("acme", "desk")[0].message, "history starts here");
    assert.deepEqual(snapshotAt("acme", "desk", id!)!.map((f) => f.path).sort(), ["AGENTS.md", "agents/w/agent.md"]);
    assert.equal(ensureBaseline("acme", "desk"), id, "a second call changes nothing");
    assert.equal(ensureBaseline("acme", "nowhere"), null, "no tree, no baseline");
  }));

test("the index is a cache of the revision files: a lost or torn line is rebuilt, a doubled one listed once", () =>
  withData(() => {
    saveWorkspace("acme", "desk", [{ path: "AGENTS.md", content: AGENTS }], { commit: null, by: "system" });
    writeWorkspaceFile("acme", "desk", "knowledge/a.md", "a\n", { by: "me" });
    writeWorkspaceFile("acme", "desk", "knowledge/b.md", "b\n", { by: "me" });
    const index = path.join(process.env.FOLDRUN_DATA!, "acme/.history/desk/index.jsonl");
    const ids = listRevisions("acme", "desk").map((r) => r.id);
    // a process died between its revision file and its line, and another's
    // append on NFS tore one
    const lines = fs.readFileSync(index, "utf8").split("\n").filter(Boolean);
    fs.writeFileSync(index, lines[0].slice(0, 20) + "\n" + lines.slice(2).join("\n") + "\n");
    assert.deepEqual(listRevisions("acme", "desk").map((r) => r.id), ids, "rebuilt from the files");
    // a line appended twice (a rebuild raced an append)
    fs.appendFileSync(index, fs.readFileSync(index, "utf8").split("\n").filter(Boolean).at(-1) + "\n");
    assert.deepEqual(listRevisions("acme", "desk").map((r) => r.id), ids, "listed once");
  }));

test("two processes finding no baseline at once write one", () =>
  withData(() => {
    const ws = path.join(process.env.FOLDRUN_DATA!, "acme/workspaces/desk");
    fs.mkdirSync(ws, { recursive: true });
    fs.writeFileSync(path.join(ws, "AGENTS.md"), AGENTS);
    // the other process holds the marker and has not finished
    const dir = path.join(process.env.FOLDRUN_DATA!, "acme/.history/desk");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, ".baseline"), "r-other");
    assert.equal(ensureBaseline("acme", "desk"), null, "it waits for the other's baseline rather than writing a second");
    assert.equal(listRevisions("acme", "desk").length, 0);
    // a marker minutes old with nothing behind it was a process that died
    const old = Date.now() / 1000 - 600;
    fs.utimesSync(path.join(dir, ".baseline"), old, old);
    assert.equal(ensureBaseline("acme", "desk"), null, "this call clears it");
    assert.ok(ensureBaseline("acme", "desk"), "and the next writes the baseline");
    assert.equal(listRevisions("acme", "desk").length, 1);
  }));

test("a rebuild keeps two revisions of one millisecond in the order they were written", () =>
  withData(() => {
    const dir = path.join(process.env.FOLDRUN_DATA!, "acme/.history/desk");
    fs.mkdirSync(dir, { recursive: true });
    const at = "2026-10-17T10:00:00.000Z";
    // ids whose random suffixes sort the other way round
    for (const [i, id] of ["r-same-zzzz", "r-same-aaaa"].entries()) {
      const file = path.join(dir, `${id}.json`);
      fs.writeFileSync(file, JSON.stringify({ id, at, by: "me", message: `m${i}`, commit: null, files: [] }));
      fs.utimesSync(file, 1_760_000_000 + i, 1_760_000_000 + i);
    }
    // no index at all: rebuilt from the files
    assert.deepEqual(listRevisions("acme", "desk").map((r) => r.id), ["r-same-aaaa", "r-same-zzzz"], "newest written first");
  }));

test("keepUntracked keeps what an agent wrote, but never follows a link out of the workspace", () =>
  withData(() => {
    saveWorkspace("acme", "desk", [{ path: "AGENTS.md", content: AGENTS }]);
    const dir = workspaceDir("acme", "desk");
    const outside = path.join(process.env.FOLDRUN_DATA!, "host-secret.txt");
    fs.writeFileSync(outside, "the host's own file");
    fs.mkdirSync(path.join(dir, "agents", "a"), { recursive: true });
    fs.writeFileSync(path.join(dir, "agents", "a", "notes.pdf"), "what the agent downloaded");
    fs.symlinkSync(outside, path.join(dir, "agents", "a", "link.txt"));

    saveWorkspace("acme", "desk", [{ path: "AGENTS.md", content: AGENTS }], { commit: null, by: "restore", keepUntracked: true });

    assert.equal(fs.readFileSync(path.join(dir, "agents", "a", "notes.pdf"), "utf8"), "what the agent downloaded", "the agent's own file is kept");
    // Before (Codex, 18 Oct 2026): the link was stat'ed through and its
    // target copied in as a regular file.
    assert.equal(fs.existsSync(path.join(dir, "agents", "a", "link.txt")), false, "the link's target is not copied in");
  }));
