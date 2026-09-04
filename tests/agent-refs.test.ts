// The references nothing used to check.
//
// A step's target is validated by the parser; its `delegate:` and `on-fail:`
// are not, and neither is an agent's `agents:` or `skills:`. All four fail
// the same quiet way the `use:` bug did — the name resolves to nothing and
// the run looks fine. A misspelled delegate is simply never chosen (the
// runner filters picks to the declared set); a misspelled on-fail is found
// only once something has already gone wrong.
//
//   node --test tests/agent-refs.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { lintFlow } from "../packages/core/src/flow-lint.ts";
import { listAgents, parseFlow } from "../packages/core/src/store.ts";

const flow = (body: string) => parseFlow("flows/x.md", `---\nname: x\n---\n\n${body}`);
const KNOWN = { agents: ["writer", "editor", "recovery"] };
const messages = (body: string, known = KNOWN) => lintFlow(flow(body), known).map((w) => w.message);

test("delegate: and on-fail: are checked against the workspace's agents", () => {
  const m = messages(
    "1. [[writer]] — draft\n2. [[editor]] — route it\n   delegate: recovery, edtior\n   on-fail: recovry\n",
  );
  assert.ok(m.some((x) => x.includes('delegate: "edtior"')), m.join(" | "));
  assert.ok(m.some((x) => x.includes('on-fail: "recovry"')), m.join(" | "));
  // The names that do exist are not reported.
  assert.ok(!m.some((x) => x.includes("recovery")));
});

test("on-fail: naming the agent that just failed is retry: with extra steps", () => {
  const m = messages("1. [[writer]] — draft\n2. [[editor]] — review\n   on-fail: editor\n");
  assert.ok(m.some((x) => x.includes("is the agent that just failed")), m.join(" | "));
});

test("without the known names the lint still runs, and says nothing about references", () => {
  // Every existing caller passed one argument; they must keep their warnings
  // and gain no false ones.
  const f = flow("1. [[writer]] — draft\n2. [[editor]] — route\n   delegate: nobody\n");
  assert.deepEqual(lintFlow(f), []);
  assert.equal(lintFlow(f, KNOWN).length, 1);
});

test("a link is the same name as a bare one, in both step options", () => {
  const f = flow("1. [[writer]] — draft\n2. [[editor]] — route\n   delegate: [[recovery]], [[writer]]\n   on-fail: [[recovery]]\n");
  assert.deepEqual(f.steps[1].delegate, ["recovery", "writer"]);
  assert.equal(f.steps[1].onFail, "recovery");
  assert.deepEqual(lintFlow(f, KNOWN), []);
});

/** Build a throwaway account on disk and point core at it for one callback. */
function withAccount(files: Record<string, string>, run: () => void) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-agentrefs-"));
  const previous = process.env.FOLDRUN_DATA;
  process.env.FOLDRUN_DATA = root;
  try {
    for (const [rel, content] of Object.entries(files)) {
      const file = path.join(root, rel);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, content);
    }
    run();
  } finally {
    if (previous === undefined) delete process.env.FOLDRUN_DATA;
    else process.env.FOLDRUN_DATA = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test("an agent record carries its consults and its skills allowlist", () => {
  withAccount(
    {
      "acme/workspaces/desk/AGENTS.md": "---\nname: desk\n---\n",
      "acme/workspaces/desk/agents/writer/agent.md":
        "---\nname: writer\ndescription: t\nagents:\n  - [[editor]]\n  - fact-checker\nskills: [[[house-style]]]\n---\n\nwork.\n",
      "acme/workspaces/desk/agents/editor/agent.md": "---\nname: editor\ndescription: t\n---\n\nwork.\n",
      // No `skills:` at all — which inherits every skill in scope, and is
      // not the same as an empty list.
      "acme/workspaces/desk/agents/quiet/agent.md": "---\nname: quiet\ndescription: t\n---\n\nwork.\n",
      "acme/workspaces/desk/agents/none/agent.md": "---\nname: none\ndescription: t\nskills: []\n---\n\nwork.\n",
    },
    () => {
      const by = Object.fromEntries(listAgents("acme", "desk").map((a) => [a.name, a]));
      assert.deepEqual(by.writer.consults, ["editor", "fact-checker"]);
      assert.deepEqual(by.writer.skills, ["house-style"]);
      assert.equal(by.quiet.skills, null, "absent inherits everything");
      assert.deepEqual(by.none.skills, [], "an empty list withholds everything");
      assert.deepEqual(by.editor.consults, []);
    },
  );
});
