// What an agent needs, worked out once, for the runner and for deploy alike.
//
// The runner builds a step's environment from the agent's `runtime:` (else
// its workspace's) merged with every granted script tool's. The platform now
// builds the same environments ahead of time when a workspace is deployed, so
// both must compute the same thing: agentRuntimeSpec is that one function.
//
//   node --test tests/runtime-plan.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { agentRuntimeSpec, workspaceRuntimePlan } from "../src/runner.ts";
import { folderRuntime, workspaceTools } from "../src/store.ts";
import { fingerprint, parseRuntime } from "../src/runtime.ts";

function withWorkspace(files: Record<string, string>, run: (root: string) => void) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-rtplan-"));
  const previous = process.env.FOLDRUN_DATA;
  process.env.FOLDRUN_DATA = root;
  try {
    for (const [rel, content] of Object.entries(files)) {
      const file = path.join(root, "acme/workspaces/desk", rel);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, content);
    }
    run(root);
  } finally {
    if (previous === undefined) delete process.env.FOLDRUN_DATA;
    else process.env.FOLDRUN_DATA = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const tool = (name: string, runtime = "") => `---
transport: script
name: ${name}
run: run.py
description: test tool
${runtime}---
`;

const agent = (tools: string, extra = "") => `---
name: a
tools: [${tools}]
${extra}---
Do the thing.
`;

test("requirements.txt and package.json beside a folder tool count as its runtime", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-folder-"));
  try {
    fs.writeFileSync(
      path.join(dir, "requirements.txt"),
      "# the sheet\nopenpyxl==3.1.5\n\nrequests >= 2  # http\n-r other.txt\n--index-url http://elsewhere\n",
    );
    fs.writeFileSync(
      path.join(dir, "package.json"),
      JSON.stringify({ dependencies: { sharp: "^0.33.5", lodash: "*" }, devDependencies: { typescript: "5" } }),
    );
    assert.deepEqual(folderRuntime(dir), {
      packages: ["openpyxl==3.1.5", "requests>=2"],
      npm: ["sharp@^0.33.5", "lodash"],
      node: true,
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a folder's files merge with tool.md's own runtime block", () => {
  withWorkspace(
    {
      "tools/sheet/tool.md": tool("sheet", "runtime:\n  packages: [pandas]\n"),
      "tools/sheet/run.py": "",
      "tools/sheet/requirements.txt": "openpyxl\npandas\n",
    },
    () => {
      const def = workspaceTools("acme", "desk").sheet;
      assert.ok(def && def.kind === "script");
      assert.deepEqual(parseRuntime((def.spec as { runtime?: unknown }).runtime)?.packages, ["pandas", "openpyxl"]);
    },
  );
});

test("an agent's runtime is its own block merged with every granted tool's", () => {
  withWorkspace(
    {
      "tools/sheet/tool.md": tool("sheet", "runtime:\n  packages: [openpyxl]\n"),
      "tools/sheet/run.py": "",
      "tools/plain.md": tool("plain"),
      "agents/compiler/agent.md": agent("read, sheet, plain", "runtime:\n  packages: [requests]\n"),
    },
    (root) => {
      const spec = agentRuntimeSpec("acme", "desk", path.join(root, "acme/workspaces/desk/agents/compiler"));
      assert.deepEqual(spec?.packages.sort(), ["openpyxl", "requests"]);
    },
  );
});

test("the plan groups agents by the environment they share and skips agents that need none", () => {
  withWorkspace(
    {
      "tools/sheet/tool.md": tool("sheet", "runtime:\n  packages: [openpyxl]\n"),
      "tools/sheet/run.py": "",
      "agents/one/agent.md": agent("sheet"),
      "agents/two/agent.md": agent("sheet"),
      "agents/three/agent.md": agent("read"),
      "agents/four/agent.md": agent("read", "runtime:\n  npm: [sharp]\n"),
    },
    () => {
      const plan = workspaceRuntimePlan("acme", "desk");
      assert.equal(plan.length, 2);
      const sheet = plan.find((p) => p.spec.packages.includes("openpyxl"))!;
      assert.deepEqual(sheet.agents, ["one", "two"]);
      assert.equal(sheet.fingerprint, fingerprint(sheet.spec));
      assert.deepEqual(plan.find((p) => p.spec.npm.includes("sharp"))!.agents, ["four"]);
    },
  );
});
