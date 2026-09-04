// state/ — data a run carries to the next one.
//
// It was a directory in WORKSPACE_DIRS, preserved across deploys by
// saveWorkspace, and nothing else: never named to an agent, never loaded into a
// prompt, never written by the runtime. A workspace could hold a state file for
// months and no run would know it existed — which is what had happened.
//
// Two things are guarded here. That a state file is visible where it is
// writable, because the listing admitted fewer extensions than the writer did
// and `state/notes.md` could be written and then never appear in the tree. And
// that the runtime still names the directory to the agent, so the feature
// cannot silently return to being a reserved word.
//
//   node --test tests/state.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { listWorkspaceFiles, writeWorkspaceFile } from "../packages/core/src/store.ts";
import { starterFiles } from "../packages/core/src/starter.ts";

function withWorkspace(run: (root: string) => void) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-state-"));
  const previous = process.env.FOLDRUN_WORKSPACE;
  process.env.FOLDRUN_WORKSPACE = root;
  try {
    run(root);
  } finally {
    if (previous === undefined) delete process.env.FOLDRUN_WORKSPACE;
    else process.env.FOLDRUN_WORKSPACE = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

// The formats differed between the two rules, so markdown was writable and
// invisible — the worst of both, since nothing errors and nothing shows.
test("everything writable under state/ is also listed", () => {
  withWorkspace(() => {
    const files = ["state/cursor.json", "state/notes.md", "state/log.txt", "state/conf.yaml"];
    for (const rel of files) writeWorkspaceFile("default", "w", rel, "x\n");

    const listed = listWorkspaceFiles("default", "w").filter((f) => f.startsWith("state/"));
    assert.deepEqual(listed.sort(), [...files].sort());
  });
});

test("state holds data, so it is not restricted to markdown", () => {
  withWorkspace(() => {
    writeWorkspaceFile("default", "w", "state/cursor.json", '{"last_id": 7}\n');
    assert.ok(listWorkspaceFiles("default", "w").includes("state/cursor.json"));
  });
});

// A directory nothing mentions is a directory nothing uses. This asserts the
// runtime still tells an agent that state/ exists and how to reach it — the
// condition that was missing for as long as the directory has existed.
test("the runtime names state/ to the agent, with a reachable path", () => {
  const src = fs.readFileSync(
    path.join(import.meta.dirname, "..", "packages/core/src/runner.ts"),
    "utf8",
  );

  assert.match(src, /# State/, "the prompt should have a State section");
  assert.match(
    src,
    /\.\.\/\.\.\/state\//,
    "state/ is workspace-scoped, so an agent reaches it at ../../state/ from its own directory",
  );
  // The distinction that earns the directory its existence: if state and memory
  // are described the same way, one of them is redundant.
  assert.match(src, /This is not memory/, "the prompt should separate state from memory");
});

// A workspace is meant to be a git repository — that is the pitch. So the one
// file in it that must never be committed has to be ignored from the moment it
// is created: `foldrun init` writes the workspace, and the CLI later writes the
// key that decrypts every secret in it to `.foldrun/.secret-key`, inside that
// same directory. Without a shipped .gitignore the first `git add -A` after
// setting a secret commits the key.
test("a new workspace ignores its own secret key and run store", () => {
  const ignore = starterFiles("desk").find((f) => f.path === ".gitignore");
  assert.ok(ignore, "foldrun init must write a .gitignore");

  const rules = ignore.content
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));

  for (const required of [".foldrun/", "runs/", "outputs/"]) {
    assert.ok(rules.includes(required), `.gitignore must cover ${required}`);
  }
});

// The path the rule has to match, asserted against the code that builds it
// rather than against a copy of it — the ignore rule and the key's location
// are two statements about one path, and only one of them is enforceable.
test("the secret key really does live under .foldrun/", () => {
  const cli = fs.readFileSync(
    path.join(import.meta.dirname, "..", "packages/cli/bin/foldrun.mjs"),
    "utf8",
  );
  // The guarantee, not the wording: when a workspace keeps its own store, that
  // store is `.foldrun/` inside it — which is what the shipped .gitignore
  // covers. The CLI may pick a different root for a workspace that belongs to
  // an installation; that one lives under data/ and is ignored already.
  assert.match(
    cli,
    /path\.join\(workspace, "\.foldrun"\)/,
    "a self-contained workspace must keep its store where the shipped .gitignore looks",
  );
});
