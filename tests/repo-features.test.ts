// The repository's features beyond clone and push: branches, diffs, merge,
// the library as a tree, and the pre-receive check.
//
//   node --test tests/repo-features.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { commitChanges, deleteBranch, diffRefs, gitAvailable, headSha, listCommits, listRefs, mergeBranch, repoDir, listTree } from "../packages/core/src/gitrepo.ts";
import { syncLibraryFromTree, libraryDir, listLibrary } from "../packages/core/src/library.ts";
import { listRevisions } from "../packages/core/src/history.ts";

const HAVE_GIT = gitAvailable();

function withData(run: () => void) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-repo-"));
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

const gitIn = (dir: string, ...args: string[]) => spawnSync("git", ["--git-dir", dir, ...args], { encoding: "utf8" });

/** A branch off main with one extra commit, made the way a push would leave it. */
function branchWith(tenant: string, ws: string, name: string, files: { path: string; content: string }[]) {
  const dir = repoDir(tenant, ws);
  const main = headSha(tenant, ws)!;
  // Build the tree with the same plumbing, then point the branch at it.
  const sha = commitChanges(tenant, ws, files.map((f) => ({ path: f.path, before: null, after: f.content })), { by: "dev@example.com", message: `on ${name}` })!;
  gitIn(dir, "update-ref", `refs/heads/${name}`, sha);
  gitIn(dir, "update-ref", "refs/heads/main", main); // main did not move
  return sha;
}

test("a branch's net change against main, with both sides", { skip: !HAVE_GIT }, () =>
  withData(() => {
    commitChanges("acme", "desk", [{ path: "AGENTS.md", before: null, after: "---\nname: desk\n---\n" }, { path: "a.md", before: null, after: "one\n" }], { message: "start" });
    branchWith("acme", "desk", "tighten", [{ path: "a.md", content: "two\n" }, { path: "b.md", content: "new\n" }]);

    const diff = diffRefs("acme", "desk", "refs/heads/main", "refs/heads/tighten");
    assert.deepEqual(diff.map((f) => f.path).sort(), ["a.md", "b.md"]);
    assert.deepEqual(diff.find((f) => f.path === "a.md"), { path: "a.md", before: "one\n", after: "two\n" });
    assert.deepEqual(diff.find((f) => f.path === "b.md"), { path: "b.md", before: null, after: "new\n" });
    assert.deepEqual(listRefs("acme", "desk", "heads").map((r) => r.name).sort(), ["main", "tighten"]);
  }));

test("merging a branch that main has not moved past is a fast-forward", { skip: !HAVE_GIT }, () =>
  withData(() => {
    commitChanges("acme", "desk", [{ path: "a.md", before: null, after: "one\n" }], { message: "start" });
    const tip = branchWith("acme", "desk", "ff", [{ path: "a.md", content: "two\n" }]);
    const merged = mergeBranch("acme", "desk", "ff", { by: "matt@example.com" });
    assert.equal(merged.fastForward, true);
    assert.equal(merged.sha, tip);
    assert.equal(headSha("acme", "desk"), tip);
  }));

test("merging a diverged branch takes the branch's tree and records both parents", { skip: !HAVE_GIT }, () =>
  withData(() => {
    commitChanges("acme", "desk", [{ path: "a.md", before: null, after: "one\n" }], { message: "start" });
    const tip = branchWith("acme", "desk", "diverged", [{ path: "a.md", content: "branch\n" }]);
    // main moves on independently.
    commitChanges("acme", "desk", [{ path: "b.md", before: null, after: "main moved\n" }], { message: "main moved" });

    const merged = mergeBranch("acme", "desk", "diverged", { by: "matt@example.com" });
    assert.equal(merged.fastForward, false);
    assert.equal(headSha("acme", "desk"), merged.sha);
    const parents = gitIn(repoDir("acme", "desk"), "log", "-1", "--format=%P", merged.sha).stdout.trim().split(" ");
    assert.equal(parents.length, 2, "a merge commit");
    assert.ok(parents.includes(tip));
    // The branch's tree, exactly: what was reviewed is what went live.
    assert.deepEqual(listTree("acme", "desk").map((t) => t.path), ["a.md"], "main's independent b.md is not silently kept");
    assert.equal(listCommits("acme", "desk")[0].message, "merge diverged into main");

    deleteBranch("acme", "desk", "diverged");
    assert.deepEqual(listRefs("acme", "desk", "heads").map((r) => r.name), ["main"]);
    assert.throws(() => deleteBranch("acme", "desk", "main"), /default branch/);
  }));

test("a pushed tree replaces the library shelf, as one revision", { skip: !HAVE_GIT }, () =>
  withData(() => {
    fs.mkdirSync(libraryDir("acme", "tools"), { recursive: true });
    fs.writeFileSync(path.join(libraryDir("acme", "tools"), "old.md"), "---\ntransport: http\nname: old\nbase: https://x\n---\n");
    const n = syncLibraryFromTree("acme", [
      { path: "tools/email.md", content: "---\ntransport: http\nname: email\nbase: https://api.resend.com\n---\n" },
      { path: "skills/tone/SKILL.md", content: "---\nname: tone\ndescription: t\n---\n\nbe plain.\n" },
    ], { commit: "abc1234", by: "deploy" });
    assert.equal(n, 3, "two written, one removed");
    assert.deepEqual(listLibrary("acme", "tools").map((e) => e.path), ["email.md"]);
    assert.ok(fs.existsSync(path.join(libraryDir("acme", "skills"), "tone/SKILL.md")));
    const [rev] = listRevisions("acme", "@library");
    assert.match(rev.message, /deployed abc1234|initial import/);
  }));

test("the pre-receive check refuses a push whose tree fails the deploy checks", { skip: !HAVE_GIT }, () =>
  withData(() => {
    // A repository whose main is fine, and a candidate commit that is not:
    // a flow naming an agent that does not exist.
    const ok = commitChanges("acme", "desk", [{ path: "AGENTS.md", before: null, after: "---\nname: desk\n---\n" }, { path: "agents/w/agent.md", before: null, after: "---\nname: w\n---\n\nwrite.\n" }], { message: "good" })!;
    const bad = commitChanges("acme", "desk", [{ path: "flows/go.md", before: null, after: "---\nname: go\n---\n\n1. [[nobody]] — x\n" }], { message: "bad" })!;
    gitIn(repoDir("acme", "desk"), "update-ref", "refs/heads/main", ok);

    const run = (line: string) =>
      spawnSync(process.execPath, ["--experimental-strip-types", path.join(import.meta.dirname, "../packages/core/src/git-hook.ts")], {
        input: line,
        env: { ...process.env, GIT_DIR: repoDir("acme", "desk") },
        encoding: "utf8",
      });
    const refused = run(`${ok} ${bad} refs/heads/main\n`);
    assert.equal(refused.status, 1, "refused");
    assert.match(refused.stderr, /refusing this push/);
    assert.match(refused.stderr, /nobody/);

    const accepted = run(`${bad} ${ok} refs/heads/main\n`);
    assert.equal(accepted.status, 0, "a good tree is accepted");
    const otherBranch = run(`${ok} ${bad} refs/heads/wip\n`);
    assert.equal(otherBranch.status, 0, "a branch is not checked — it is not live");
  }));
