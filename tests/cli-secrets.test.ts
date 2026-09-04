// `foldrun secrets` from the terminal must store where a run will look.
//
// The runner reads a workspace's secrets under workspaces/<folder name>/,
// and the CLI used to write under the literal name "workspace" — so every
// secret set from the terminal came back "not set" at run time. The flag
// parser also read `--account --value X` as account="--value", storing an
// empty value. Both are pinned here, offline, through the real binary.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const ROOT = path.join(import.meta.dirname, "..");
const CLI = path.join(ROOT, "packages/cli/bin/foldrun.mjs");
const foldrun = (...args: string[]) =>
  spawnSync(process.execPath, [CLI, ...args], {
    encoding: "utf8",
    cwd: ROOT,
    // A clean store: no inherited data root or master key from the shell.
    env: { ...process.env, FOLDRUN_DATA: undefined, FOLDRUN_SECRET_KEY: undefined },
  });

test("secrets set --workspace lands under the folder's name, --account under the account", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-secrets-"));
  const ws = path.join(root, "acme");
  fs.mkdirSync(path.join(ws, "agents"), { recursive: true });
  try {
    const set = foldrun("secrets", "set", "API_KEY", "--value", "s3cret", "--workspace", ws);
    assert.equal(set.status, 0, set.stdout + set.stderr);
    assert.ok(fs.existsSync(path.join(ws, ".foldrun/default/workspaces/acme/secrets.json")), "workspace-scoped store");
    assert.ok(!fs.existsSync(path.join(ws, ".foldrun/default/workspaces/workspace")), "no literal 'workspace' store");

    // The boolean flag no longer swallows the value that follows it.
    const acct = foldrun("secrets", "set", "SHARED", "--account", "--value", "acct", "--workspace", ws);
    assert.equal(acct.status, 0, acct.stdout + acct.stderr);
    assert.ok(fs.existsSync(path.join(ws, ".foldrun/default/secrets.json")), "account store");

    const ls = foldrun("secrets", "ls", "--workspace", ws);
    assert.equal(ls.status, 0, ls.stdout + ls.stderr);
    assert.match(ls.stdout, /API_KEY/);
    assert.match(ls.stdout, /SHARED/);
    assert.doesNotMatch(ls.stdout, /s3cret|acct/, "values are never printed");

    const rm = foldrun("secrets", "rm", "API_KEY", "--workspace", ws);
    assert.equal(rm.status, 0, rm.stdout + rm.stderr);
    assert.doesNotMatch(foldrun("secrets", "ls", "--workspace", ws).stdout, /API_KEY/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
