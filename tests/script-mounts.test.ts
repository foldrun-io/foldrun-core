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
