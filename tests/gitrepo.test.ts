// The workspace as a git repository: plumbing commits, log, diffs, refs —
// and history.ts reading git without its callers knowing.
//
//   node --test tests/gitrepo.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { commitChanges, filesAt, gitAvailable, headSha, listCommits, listRefs, listTree, readCommit, repoDir, repoExists } from "../packages/core/src/gitrepo.ts";
import { ensureImported, listRevisions, readRevision, latestRevisionId } from "../packages/core/src/history.ts";
import { saveWorkspace, writeWorkspaceFile, deleteWorkspacePath, listWorkspaceFiles } from "../packages/core/src/store.ts";

const HAVE_GIT = gitAvailable();

function withData(run: () => void) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-git-"));
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

test("a change set becomes one commit; an unchanged tree becomes none", { skip: !HAVE_GIT }, () =>
  withData(() => {
    const a = commitChanges("acme", "desk", [{ path: "AGENTS.md", before: null, after: "---\nname: desk\n---\n" }], { by: "matt@example.com", message: "start" });
    assert.ok(a);
    assert.equal(headSha("acme", "desk"), a);
    const b = commitChanges("acme", "desk", [{ path: "AGENTS.md", before: "x", after: "---\nname: desk\n---\n" }], { message: "same bytes" });
    assert.equal(b, null, "identical tree is not a commit");
    const c = commitChanges("acme", "desk", [
      { path: "tools/x/run.py", before: null, after: "print(1)\n" },
      { path: "AGENTS.md", before: null, after: null },
    ], { message: "add a tool, drop AGENTS" });
    assert.ok(c);
    assert.deepEqual(listTree("acme", "desk").map((t) => `${t.mode} ${t.path}`), ["100755 tools/x/run.py"], "code under tools/ is executable");
  }));

test("log, one commit in full, refs, and the tree at a ref", { skip: !HAVE_GIT }, () =>
  withData(() => {
    commitChanges("acme", "desk", [{ path: "a.md", before: null, after: "one\n" }], { by: "matt@example.com", message: "first" });
    const second = commitChanges("acme", "desk", [{ path: "a.md", before: "one\n", after: "two\n" }, { path: "b.md", before: null, after: "b\n" }], { by: "deploy", message: "second" })!;

    const log = listCommits("acme", "desk");
    assert.deepEqual(log.map((c) => c.message), ["second", "first"]);
    assert.equal(log[0].by, "deploy", "a platform actor has no domain and shows as itself");
    assert.equal(log[1].by, "matt@example.com");
    assert.deepEqual(log[0].paths.sort(), ["a.md", "b.md"]);
    assert.deepEqual(listCommits("acme", "desk", { forPath: "b.md" }).map((c) => c.message), ["second"]);

    const full = readCommit("acme", "desk", second)!;
    assert.deepEqual(full.files.find((f) => f.path === "a.md"), { path: "a.md", before: "one\n", after: "two\n" });
    assert.deepEqual(full.files.find((f) => f.path === "b.md"), { path: "b.md", before: null, after: "b\n" });
    assert.equal(readCommit("acme", "desk", second.slice(0, 8))!.id, second, "an abbreviated sha resolves");

    assert.deepEqual(listRefs("acme", "desk", "heads").map((r) => r.name), ["main"]);
    spawnSync("git", ["--git-dir", repoDir("acme", "desk"), "tag", "v1", second]);
    assert.deepEqual(listRefs("acme", "desk", "tags").map((r) => `${r.name}@${r.sha.slice(0, 7)}`), [`v1@${second.slice(0, 7)}`]);
    assert.deepEqual(filesAt("acme", "desk", "v1").map((f) => f.path).sort(), ["a.md", "b.md"]);
  }));

test("the store's writers commit to git, and history reads it back", { skip: !HAVE_GIT }, () =>
  withData(() => {
    saveWorkspace("acme", "desk", [{ path: "AGENTS.md", content: "---\nname: desk\n---\n" }, { path: "flows/go.md", content: "---\nname: go\n---\n\n1. [[a]] — x\n" }], { commit: null, by: "system" });
    assert.ok(repoExists("acme", "desk"), "the first write created the repository");
    const first = listRevisions("acme", "desk");
    assert.equal(first.length, 1);
    assert.match(first[0].message, /initial import/);
    assert.deepEqual(first[0].paths.sort(), ["AGENTS.md", "flows/go.md"], "the first commit is the whole tree");

    writeWorkspaceFile("acme", "desk", "knowledge/style.md", "---\ntitle: Style\n---\n\nshort.\n", { by: "matt@example.com" });
    writeWorkspaceFile("acme", "desk", "knowledge/style.md", "---\ntitle: Style\n---\n\nshorter.\n", { by: "matt@example.com" });
    deleteWorkspacePath("acme", "desk", "flows/go.md", { by: "matt@example.com" });

    const log = listRevisions("acme", "desk");
    assert.deepEqual(log.map((r) => r.message), ["deleted flows/go.md", "edited knowledge/style.md", "created knowledge/style.md", "initial import"]);
    assert.equal(log[0].by, "matt@example.com");
    assert.equal(latestRevisionId("acme", "desk"), log[0].id);
    assert.match(log[0].id, /^[0-9a-f]{40}$/, "a revision id is a commit sha");

    // By path: the commit also carries the regenerated knowledge/index.md and
    // log.md, and git lists a commit's files alphabetically.
    const edit = readRevision("acme", "desk", log[1].id)!;
    const style = edit.files.find((f) => f.path === "knowledge/style.md")!;
    assert.match(style.before!, /short\./);
    assert.match(style.after!, /shorter\./);
    // The generated index rode along with the CREATION (that is when the
    // index gained a row); the later edit changed the concept, not the index,
    // and git records only what changed.
    const created = readRevision("acme", "desk", log[2].id)!;
    assert.ok(created.files.some((f) => f.path === "knowledge/index.md"), "the generated index rides along, so a clone's index matches its files");

    // What git has is exactly what the disk has — the editable tree, generated
    // indexes included.
    assert.deepEqual(listTree("acme", "desk").map((t) => t.path).sort(), listWorkspaceFiles("acme", "desk").sort());
  }));

test("ensureImported gives an untouched workspace a complete first commit, once", { skip: !HAVE_GIT }, () =>
  withData(() => {
    const ws = path.join(process.env.FOLDRUN_DATA!, "acme/workspaces/desk");
    fs.mkdirSync(path.join(ws, "agents/w"), { recursive: true });
    fs.writeFileSync(path.join(ws, "AGENTS.md"), "---\nname: desk\n---\n");
    fs.writeFileSync(path.join(ws, "agents/w/agent.md"), "---\nname: w\n---\n\nwrite.\n");
    const sha = ensureImported("acme", "desk");
    assert.ok(sha);
    assert.deepEqual(listTree("acme", "desk").map((t) => t.path).sort(), ["AGENTS.md", "agents/w/agent.md"]);
    assert.equal(ensureImported("acme", "desk"), sha, "a second call changes nothing");
  }));
