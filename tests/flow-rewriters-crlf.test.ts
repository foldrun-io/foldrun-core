// The store's flow rewriters (the web route calls them directly for
// {groups} and {step, options}) on a CRLF flow: every step is seen, the
// edit lands once, and the file stays CRLF — the same rule the flow-pattern
// edits follow (6232bd0).
//
//   node --test tests/flow-rewriters-crlf.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseFlow,
  reorderFlowSteps,
  updateFlowStep,
  updateFlowStepInstruction,
  addFlowStep,
  removeFlowStep,
  setFlowTrigger,
} from "../src/store.ts";

const LF = `---
name: morning
trigger: manual
---

Prose above.

1. [[researcher]] — find the news
   retry: 2
2. [[writer]] — draft the brief
   model: fast
3. [[publisher]] — send it
`;
const CRLF = LF.replace(/\n/g, "\r\n");

const steps = (raw: string) => parseFlow("morning.md", raw).steps;
const shape = (raw: string) => steps(raw).map((s) => `${s.group}:${s.agent}`);
function staysCRLF(out: string) {
  assert.ok(out.includes("\r\n"), "file has CRLF");
  assert.ok(!/(^|[^\r])\n/.test(out), "no bare LF line ending");
  assert.ok(!out.includes("\r\r"), "no doubled CR");
}
const count = (s: string, sub: string) => s.split(sub).length - 1;

test("reorderFlowSteps on CRLF: every step, swapped once, still CRLF", () => {
  const out = reorderFlowSteps(CRLF, [[2], [0, 1]]);
  assert.deepEqual(shape(out), ["1:publisher", "2:researcher", "2:writer"]);
  assert.equal(out, reorderFlowSteps(LF, [[2], [0, 1]]).replace(/\n/g, "\r\n"));
  staysCRLF(out);
});

test("updateFlowStep on CRLF: an existing option is replaced, not duplicated", () => {
  const out = updateFlowStep(CRLF, 1, { model: "max", retry: 3 });
  assert.equal(count(out, "model:"), 1);
  assert.equal(steps(out)[1].model, steps(updateFlowStep(LF, 1, { model: "max" }))[1].model);
  assert.equal(steps(out)[1].retry, 3);
  assert.equal(out, updateFlowStep(LF, 1, { model: "max", retry: 3 }).replace(/\n/g, "\r\n"));
  staysCRLF(out);
});

test("updateFlowStepInstruction on CRLF: the instruction changes once", () => {
  const out = updateFlowStepInstruction(CRLF, 2, "post it");
  assert.equal(steps(out)[2].instruction, "post it");
  assert.equal(steps(out).length, 3);
  assert.equal(out, updateFlowStepInstruction(LF, 2, "post it").replace(/\n/g, "\r\n"));
  staysCRLF(out);
});

test("addFlowStep on CRLF: one step appended, still CRLF", () => {
  const out = addFlowStep(CRLF, { target: "checker", instruction: "check it" });
  assert.deepEqual(shape(out), ["1:researcher", "2:writer", "3:publisher", "4:checker"]);
  staysCRLF(out);
});

test("removeFlowStep on CRLF: the step and its options go, still CRLF", () => {
  const out = removeFlowStep(CRLF, 0);
  assert.deepEqual(shape(out), ["1:writer", "2:publisher"]);
  assert.equal(count(out, "retry:"), 0);
  staysCRLF(out);
});

test("setFlowTrigger on CRLF: the trigger is replaced in the frontmatter, still CRLF", () => {
  const out = setFlowTrigger(CRLF, { trigger: "schedule", schedule: "0 7 * * *" });
  const flow = parseFlow("morning.md", out);
  assert.equal(flow.trigger, "schedule");
  assert.equal(count(out, "trigger:"), 1);
  assert.equal(steps(out).length, 3);
  staysCRLF(out);
});
