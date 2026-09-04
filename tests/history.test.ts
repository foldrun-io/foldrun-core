// Every change kept: the revision journal, and the writers that feed it.
//
//   node --test tests/history.test.ts

import { test } from "node:test";

// These tests pin the JOURNAL — the fallback for an install with no git
// binary. With git present, history.ts delegates to it, and git's answers
// differ in two honest ways: a first commit has no "before", and a deploy's
// id is the commit the platform made, not the foreign sha it was told. Those
// are covered in gitrepo.test.ts. Here, the journal.
process.env.FOLDRUN_HISTORY = "journal";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  diffLines,
  latestRevisionId,
  listRevisions,
  readRevision,
  recordRevision,
} from "../packages/core/src/history.ts";
import {
  deleteWorkspacePath,
  saveWorkspace,
  writeWorkspaceFile,
} from "../packages/core/src/store.ts";
import { writeEvalResult, readEvalHistory, type EvalResult } from "../packages/core/src/evals.ts";

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
