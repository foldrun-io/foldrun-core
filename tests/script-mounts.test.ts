// What a script run in Docker can see. A folder tool's code lives in
// tools/<name>/, and the executor mounted only scripts/ — so every folder
// tool was handed a host path the container did not have.

import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { containerPath } from "../src/script-tools.ts";
import { scriptMounts } from "../src/runner.ts";

const ws = path.resolve("/acct/workspaces/main");
const agent = path.join(ws, "agents/notetaker");

test("a Docker-run script sees the workspace's and the account's tools/, not only scripts/", () => {
  const mounts = scriptMounts(agent, "default");
  assert.equal(mounts[path.join(ws, "tools")], "/workspace-tools");
  assert.equal(mounts[path.join(ws, "scripts")], "/workspace-scripts");
  assert.ok(Object.values(mounts).includes("/library-tools"), "the account's tools/ is mounted");
  assert.ok(Object.values(mounts).includes("/library-scripts"), "the account's scripts/ is mounted");
});

test("a folder tool's code maps into its mount; the agent's own files into /workspace", () => {
  const mounts = scriptMounts(agent, "default");
  assert.equal(containerPath(path.join(ws, "tools/wordcount/run.py"), agent, mounts), "/workspace-tools/wordcount/run.py");
  assert.equal(containerPath(path.join(agent, "scripts/x.py"), agent, mounts), "/workspace/scripts/x.py");
  assert.equal(containerPath(path.join(ws, "scripts/y.py"), agent, mounts), "/workspace-scripts/y.py");
});

test("a path is mapped by containment, not by a text prefix; text that is not a path is left alone", () => {
  const mounts = { [path.join(ws, "scripts")]: "/workspace-scripts" };
  assert.equal(containerPath(path.join(ws, "scripts-old/x.py"), agent, mounts), path.join(ws, "scripts-old/x.py"));
  assert.equal(containerPath(`${agent}-other/x.py`, agent, mounts), `${agent}-other/x.py`);
  assert.equal(containerPath("hello world", agent, mounts), "hello world");
  assert.equal(containerPath("scripts/y.py", agent, mounts), "scripts/y.py");
});

test("the longest mount wins, so a nested one is not shadowed", () => {
  const mounts = { "/a": "/m1", "/a/b": "/m2" };
  assert.equal(containerPath("/a/b/c.py", "/agent", mounts), "/m2/c.py");
  assert.equal(containerPath("/a/c.py", "/agent", mounts), "/m1/c.py");
});

test("a workspace/… argument is staged under /workspace-root; one that climbs out is not", async () => {
  const { stageWorkspaceArg } = await import("../src/script-tools.ts");
  assert.deepEqual(stageWorkspaceArg("workspace/storage/a.csv", ws), { host: path.join(ws, "storage/a.csv"), container: "/workspace-root/storage/a.csv" });
  assert.equal(stageWorkspaceArg("workspace/../../etc/passwd", ws), null);
  assert.equal(stageWorkspaceArg("workspaces/x", ws), null);
  assert.equal(stageWorkspaceArg("storage/a.csv", ws), null);
});

test("copy-back writes what changed and leaves an unchanged input's mtime alone", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const { syncChanged } = await import("../src/container.ts");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sync-"));
  try {
    const from = path.join(root, "from"), to = path.join(root, "to");
    fs.mkdirSync(from); fs.mkdirSync(to);
    fs.writeFileSync(path.join(from, "same.csv"), "a\n"); fs.writeFileSync(path.join(to, "same.csv"), "a\n");
    fs.writeFileSync(path.join(from, "new.txt"), "new\n");
    fs.writeFileSync(path.join(from, "changed.txt"), "2\n"); fs.writeFileSync(path.join(to, "changed.txt"), "1\n");
    const old = new Date("2026-01-01T00:00:00Z");
    fs.utimesSync(path.join(to, "same.csv"), old, old);
    syncChanged(from, to);
    assert.equal(fs.statSync(path.join(to, "same.csv")).mtime.getTime(), old.getTime(), "unchanged input untouched");
    assert.equal(fs.readFileSync(path.join(to, "new.txt"), "utf8"), "new\n");
    assert.equal(fs.readFileSync(path.join(to, "changed.txt"), "utf8"), "2\n");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("the script image is told the languages its scripts are written in", async () => {
  const { scriptLanguages } = await import("../src/runner.ts");
  const spec = (run: string, extra = {}) => ({ name: "x", run, args: {}, description: "", ...extra }) as never;
  assert.equal(scriptLanguages([spec("tools/a/run.py")]), null, "python alone is the base image");
  assert.deepEqual(scriptLanguages([spec("tools/a/run.mjs")]), { node: true, packages: [], npm: [] });
  assert.deepEqual(scriptLanguages([spec("a.py"), spec("b.js")]), { node: true, python: true, packages: [], npm: [] }, "python kept beside node");
  assert.deepEqual(scriptLanguages([spec("", { code: "x", codeExt: ".mjs" })]), { node: true, packages: [], npm: [] }, "inline JS code");
  assert.deepEqual(scriptLanguages([spec("tools/a/run", { interpreter: "/usr/bin/node" })]), { node: true, packages: [], npm: [] });
});
