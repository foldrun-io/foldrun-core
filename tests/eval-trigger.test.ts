// An eval runs after every deploy unless it says `trigger: manual` — the
// escape hatch for a flow eval that costs a whole run and touches real
// systems every time somebody pushes.

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseEval } from "../packages/core/src/evals.ts";

const CASE = `## a case\ntask: say hi\nexpect:\n  - contains: hi\n`;

test("an eval runs on deploy by default", () => {
  const e = parseEval("greeter.md", `---\nname: greeter\nagent: greeter\n---\n${CASE}`);
  assert.equal(e.trigger, "deploy");
});

test("trigger: manual is honoured; anything else means deploy", () => {
  assert.equal(parseEval("a.md", `---\nagent: a\ntrigger: manual\n---\n${CASE}`).trigger, "manual");
  assert.equal(parseEval("b.md", `---\nagent: b\ntrigger: sometimes\n---\n${CASE}`).trigger, "deploy");
});
