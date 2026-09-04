// The "Test tool" button, and the one property that makes its answer mean
// anything: it must stand where a run stands.
//
//   node --test tests/tool-test.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { testTool } from "../packages/core/src/tool-test.ts";
import { workspaceTools } from "../packages/core/src/store.ts";

/** A throwaway installation with one workspace, for one callback. */
function withWorkspace(files: Record<string, string>, run: () => Promise<void>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-tooltest-"));
  const previous = process.env.FOLDRUN_DATA;
  process.env.FOLDRUN_DATA = root;
  return (async () => {
    try {
      for (const [rel, content] of Object.entries(files)) {
        const file = path.join(root, "acme/workspaces/desk", rel);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, content);
      }
      await run();
    } finally {
      if (previous === undefined) delete process.env.FOLDRUN_DATA;
      else process.env.FOLDRUN_DATA = previous;
      fs.rmSync(root, { recursive: true, force: true });
    }
  })();
}

// `path.resolve(process.cwd(), "..", "..", "state", f)` is the ordinary way a
// tool reaches workspace state, and it is correct only from an agent's own
// folder. Testing from the workspace root sent it to <data>/<tenant>/state —
// a real read of the wrong directory, which comes back as an empty result
// rather than an error. That is a worse answer than a failure: the button
// said the tool worked and showed nothing in it.
const PROGRAM = `import fs from "node:fs";
import path from "node:path";
const target = path.resolve(process.cwd(), "..", "..", "state", "rows.txt");
console.log(fs.existsSync(target) ? fs.readFileSync(target, "utf8").trim() : "NOT FOUND");
`;

const DEFINITION = `---
transport: script
name: rows
run: run.mjs
description: Reads the workspace's state the way every other tool does.
---

The program is beside this file.
`;

const AGENT = `---
name: keeper
description: Grants the tool under test.
tools: [rows]
---

work.
`;

test("a script tool is tested from an agent's folder, where a run runs", () =>
  withWorkspace(
    {
      "AGENTS.md": "---\nname: desk\n---\n",
      "agents/keeper/agent.md": AGENT,
      "state/rows.txt": "two live rows",
      "tools/rows/tool.md": DEFINITION,
      "tools/rows/run.mjs": PROGRAM,
    },
    async () => {
      const def = workspaceTools("acme", "desk").rows;
      const result = await testTool("acme", "desk", def);

      assert.equal(result.ok, true, `expected exit 0, got: ${result.summary}`);
      assert.match(
        result.detail,
        /two live rows/,
        "the tool read the workspace's state — from the workspace root it would find nothing",
      );
      // And the result says where it stood, so the output can be read.
      assert.match(result.detail, /ran from agents\/keeper\//);
    },
  ));

// Depth is what matters, but standing in the granting agent's folder is what
// makes the test the call that would actually happen — an agent's own
// scripts/, skills/ and memory/ are all resolved from there too.
test("the agent that granted the tool is the one stood in for", () =>
  withWorkspace(
    {
      "AGENTS.md": "---\nname: desk\n---\n",
      // Alphabetically first, and does NOT grant the tool.
      "agents/aaa-bystander/agent.md":
        "---\nname: aaa-bystander\ndescription: no grant.\n---\n\nwork.\n",
      "agents/keeper/agent.md": AGENT,
      "state/rows.txt": "two live rows",
      "tools/rows/tool.md": DEFINITION,
      "tools/rows/run.mjs": PROGRAM,
    },
    async () => {
      const def = workspaceTools("acme", "desk").rows;
      const result = await testTool("acme", "desk", def);
      assert.match(result.detail, /ran from agents\/keeper\//);
    },
  ));

// A workspace with no agents cannot run anything yet. The tester should still
// answer, and should say that its footing is not a run's footing rather than
// quietly reporting from the wrong depth.
test("with no agents, the tester says its footing is not a run's", () =>
  withWorkspace(
    {
      "AGENTS.md": "---\nname: desk\n---\n",
      "state/rows.txt": "two live rows",
      "tools/rows/tool.md": DEFINITION,
      "tools/rows/run.mjs": PROGRAM,
    },
    async () => {
      const def = workspaceTools("acme", "desk").rows;
      const result = await testTool("acme", "desk", def);
      assert.match(result.detail, /no agent to stand in for/);
    },
  ));
