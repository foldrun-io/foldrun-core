// The two shapes a folder can have, and the one helper that tells them apart.
//
// Every command in the CLI branches on this answer, so a wrong answer here is
// a wrong answer in `check`, `deploy`, `status` and `pull` at once. The flat
// cases matter most: that shape is what every existing user has on disk.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  detectLayout,
  accountRootFor,
  isWorkspaceDir,
  listWorkspaceDirs,
  accountWorkspacesDir,
  installationDataRoot,
} from "../src/layout.ts";
import { singleAccountRoot } from "../src/paths.ts";
import { accountDir } from "../src/store.ts";
import { libraryDir } from "../src/library.ts";
import { readAccountTree, accountTreeFrom, readLibraryTree } from "../src/account.ts";

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-layout-"));
}
function write(file: string, content = "x") {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

/** A flat workspace — what `foldrun init` made until today. */
function flat(root: string, name = "my-desk"): string {
  const dir = path.join(root, name);
  write(path.join(dir, "AGENTS.md"), "# desk\n");
  write(path.join(dir, "agents", "writer", "agent.md"), "---\nname: writer\n---\nWrite.\n");
  write(path.join(dir, "flows", "publish.md"), "1. [[writer]] — go.\n");
  return dir;
}

/** An account folder — what it makes now. */
function account(root: string, names = ["my-desk"]): string {
  write(path.join(root, "AGENTS.md"), "# account\n");
  write(path.join(root, "library", "skills", "house-style", "SKILL.md"), "---\nname: house-style\ndescription: d\n---\n");
  write(path.join(root, "library", "tools", "crm.md"), "---\nname: crm\n---\n");
  for (const n of names) {
    const dir = path.join(root, "workspaces", n);
    write(path.join(dir, "AGENTS.md"), `# ${n}\n`);
    write(path.join(dir, "agents", "writer", "agent.md"), "---\nname: writer\n---\nWrite.\n");
    write(path.join(dir, "flows", "publish.md"), "1. [[writer]] — go.\n");
  }
  return root;
}

test("a flat workspace is flat, and its account scope is its parent", () => {
  const root = tmp();
  const dir = flat(root);
  const l = detectLayout(dir);
  assert.equal(l.kind, "flat");
  assert.equal(l.workspaceDir, dir);
  assert.equal(l.workspace, "my-desk");
  assert.equal(l.accountRoot, root);
  assert.equal(l.workspacesDir, null);
  assert.deepEqual(l.workspaces, ["my-desk"]);
  assert.equal(accountRootFor(dir), root);
});

test("an account root is an account, and lists its workspaces", () => {
  const root = tmp();
  account(root, ["blog", "ads"]);
  const l = detectLayout(root);
  assert.equal(l.kind, "account");
  assert.equal(l.accountRoot, root);
  assert.equal(l.workspace, null);
  assert.equal(l.workspaceDir, null);
  assert.deepEqual(l.workspaces, ["ads", "blog"]);
  assert.equal(accountWorkspacesDir(root), path.join(root, "workspaces"));
  assert.deepEqual(listWorkspaceDirs(root), ["ads", "blog"]);
});

test("inside a workspace of an account, the account root is two levels up", () => {
  const root = tmp();
  account(root, ["blog"]);
  const ws = path.join(root, "workspaces", "blog");
  const l = detectLayout(path.join(ws, "agents", "writer"));
  assert.equal(l.kind, "workspace-in-account");
  assert.equal(l.workspace, "blog");
  assert.equal(l.workspaceDir, ws);
  assert.equal(l.accountRoot, root);
  // The bug this exists to stop: one level up is `workspaces/`, which holds
  // neither AGENTS.md nor library/.
  assert.notEqual(l.accountRoot, path.join(root, "workspaces"));
  assert.equal(accountRootFor(ws), root);
});

test("a bare directory is empty, not a workspace", () => {
  const root = tmp();
  const l = detectLayout(root);
  assert.equal(l.kind, "empty");
  assert.deepEqual(l.workspaces, []);
  assert.equal(isWorkspaceDir(root), false);
});

test("the legacy projects/ directory still reads as an account", () => {
  const root = tmp();
  write(path.join(root, "AGENTS.md"));
  write(path.join(root, "projects", "old", "agents", "a", "agent.md"), "---\nname: a\n---\n");
  const l = detectLayout(root);
  assert.equal(l.kind, "account");
  assert.deepEqual(l.workspaces, ["old"]);
});

test("the runtime's account scope follows the layout, flat and nested", (t) => {
  const root = tmp();
  const flatDir = flat(root, "solo");
  const before = process.env.FOLDRUN_WORKSPACE;
  t.after(() => {
    if (before === undefined) delete process.env.FOLDRUN_WORKSPACE;
    else process.env.FOLDRUN_WORKSPACE = before;
    delete process.env.FOLDRUN_ACCOUNT;
  });

  process.env.FOLDRUN_WORKSPACE = flatDir;
  assert.equal(singleAccountRoot(), root);
  assert.equal(accountDir("default"), root);
  assert.equal(libraryDir("default"), path.join(root, "library"));

  const acct = tmp();
  account(acct, ["blog"]);
  process.env.FOLDRUN_WORKSPACE = path.join(acct, "workspaces", "blog");
  assert.equal(singleAccountRoot(), acct);
  assert.equal(accountDir("default"), acct);
  assert.equal(libraryDir("default", "skills"), path.join(acct, "library", "skills"));

  process.env.FOLDRUN_ACCOUNT = root;
  assert.equal(singleAccountRoot(), root, "FOLDRUN_ACCOUNT wins over the inferred answer");
});

test("an installation is told apart from an account folder by its key file", () => {
  const data = tmp();
  const tenant = path.join(data, "acme");
  account(tenant, ["blog"]);
  assert.equal(installationDataRoot(tenant), null);
  fs.writeFileSync(path.join(data, ".secret-key"), "deadbeef");
  assert.equal(installationDataRoot(tenant), data);
});

test("an account tree carries AGENTS.md, the library and every workspace", () => {
  const root = tmp();
  account(root, ["ads", "blog"]);
  const tree = readAccountTree(root);
  assert.equal(tree.agentsMd, "# account\n");
  assert.deepEqual(
    tree.library.map((f) => `${f.kind}/${f.path}`).sort(),
    ["skills/house-style/SKILL.md", "tools/crm.md"],
  );
  assert.deepEqual(tree.workspaces.map((w) => w.name), ["ads", "blog"]);
  for (const w of tree.workspaces) {
    assert.ok(w.files.some((f) => f.path === "agents/writer/agent.md"));
    assert.ok(w.files.some((f) => f.path === "flows/publish.md"));
  }
  assert.deepEqual(readLibraryTree(path.join(root, "nowhere")), []);
});

test("one workspace can be singled out, and an unknown name says what there is", () => {
  const root = tmp();
  account(root, ["ads", "blog"]);
  assert.deepEqual(readAccountTree(root, "blog").workspaces.map((w) => w.name), ["blog"]);
  assert.throws(() => readAccountTree(root, "nope"), /have: ads, blog/);
});

test("a flat folder plans as an account of one, and never pushes its AGENTS.md as account scope", () => {
  const root = tmp();
  const dir = flat(root);
  write(path.join(root, "library", "skills", "shared", "SKILL.md"), "---\nname: shared\ndescription: d\n---\n");
  const { layout, tree } = accountTreeFrom(dir);
  assert.equal(layout.kind, "flat");
  assert.equal(tree.agentsMd, null);
  assert.deepEqual(tree.workspaces.map((w) => w.name), ["my-desk"]);
  assert.ok(tree.workspaces[0].files.some((f) => f.path === "AGENTS.md"));
  assert.deepEqual(tree.library.map((f) => f.path), ["shared/SKILL.md"]);
});

test("standing in a workspace of an account plans that workspace alone", () => {
  const root = tmp();
  account(root, ["ads", "blog"]);
  const { tree } = accountTreeFrom(path.join(root, "workspaces", "blog", "flows"));
  assert.deepEqual(tree.workspaces.map((w) => w.name), ["blog"]);
  assert.equal(tree.agentsMd, "# account\n");
});
