// `inputs: true` marks a file of saved inputs for a flow — named tasks the
// dashboard's "Run with…" and `foldrun invoke --inputs` start it with. It is
// parsed like an eval (so `foldrun check` validates the flow it names) but
// never run as one: no case carries an assertion, and running them would
// bill a run per case only to report every one failed.

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseEval, runEval } from "../src/evals.ts";

const FILE = `---
name: publish-inputs
flow: publish
inputs: true
trigger: manual
---

## rain gauges
task: Write about cleaning a rain gauge.

## long brief
task: |
  Two paragraphs.
  * a bullet
`;

test("an inputs file parses: its sets are the cases, the flow is named", () => {
  const e = parseEval("publish-inputs.md", FILE);
  assert.equal(e.inputs, true);
  assert.equal(e.flow, "publish");
  assert.deepEqual(e.cases.map((c) => [c.name, c.task]), [
    ["rain gauges", "Write about cleaning a rain gauge."],
    ["long brief", "Two paragraphs.\n* a bullet"],
  ]);
});

test("an ordinary eval is not an inputs file", () => {
  assert.equal(parseEval("a.md", `---\nflow: publish\n---\n## x\ntask: y\nexpect:\n  - contains: y\n`).inputs, false);
});

test("running an inputs file starts nothing", async () => {
  const r = await runEval("t", "w", parseEval("publish-inputs.md", FILE));
  assert.equal(r.cases.length, 0);
  assert.equal(r.costUsd, 0);
});
