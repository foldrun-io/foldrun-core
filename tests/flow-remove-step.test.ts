// Deleting a step (flow-patterns.ts removeStep): the step line and its
// indented options go, prose stays, groups renumber with no gap, and an edit
// that would give `check` a new error is refused.
//
//   node --test tests/flow-remove-step.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseFlow } from "../src/store.ts";
import { removeStep, removeStepImpact, applyPatternEdit } from "../src/flow-patterns.ts";

const FLOW = `---
name: morning
trigger: schedule
schedule: "0 7 * * *"   # daily
---

Prose above the steps stays.

1. [[researcher]] — find the news
2. [[writer]] — draft the brief
   retry: 2
   verify: judge: cites every source
2. [[checker]] — check the facts
3. [[publisher]] — send it
4. [[watchdog]] — stray drop

Notes below stay too.
`;

const shape = (raw: string) => parseFlow("morning.md", raw).steps.map((s) => `${s.group}:${s.subflow ?? s.agent}`);

test("the last step: its line goes, the notes below stay", () => {
  const out = removeStep(FLOW, 4);
  assert.deepEqual(shape(out), ["1:researcher", "2:writer", "2:checker", "3:publisher"]);
  assert.equal(out, FLOW.replace("4. [[watchdog]] — stray drop\n", ""));
});

test("a middle step alone in its group: later groups renumber, no gap", () => {
  const out = removeStep(FLOW, 3);
  assert.deepEqual(shape(out), ["1:researcher", "2:writer", "2:checker", "3:watchdog"]);
  assert.match(out, /Prose above the steps stays\./);
  assert.match(out, /Notes below stay too\./);
  assert.match(out, /^3\. \[\[watchdog\]\] — stray drop$/m);
});

test("one of a parallel group: the group keeps its number, the others stay", () => {
  const out = removeStep(FLOW, 2);
  assert.deepEqual(shape(out), ["1:researcher", "2:writer", "3:publisher", "4:watchdog"]);
  assert.equal(out, FLOW.replace("2. [[checker]] — check the facts\n", ""));
});

test("a step with options: its indented option lines go with it", () => {
  const out = removeStep(FLOW, 1);
  assert.deepEqual(shape(out), ["1:researcher", "2:checker", "3:publisher", "4:watchdog"]);
  assert.doesNotMatch(out, /retry: 2|verify: judge/);
  assert.equal(parseFlow("m.md", out).steps[1].retry, undefined);
});

test("the first step: everything moves up one", () => {
  const out = removeStep(FLOW, 0);
  assert.deepEqual(shape(out), ["1:writer", "1:checker", "2:publisher", "3:watchdog"]);
  // the options under writer survived the renumber
  assert.equal(parseFlow("m.md", out).steps[0].retry, 2);
});

test("the edit is reachable as a pattern edit, and a bad index is refused", () => {
  assert.equal(applyPatternEdit(FLOW, { op: "remove", step: 4 }), removeStep(FLOW, 4));
  assert.throws(() => removeStep(FLOW, 9), /no step 10/);
  assert.throws(() => removeStep(FLOW, -1), /no step 0/);
});

const ROUTED = `---
name: triage
---

1. [[intake]] — read it
2. [[router]] — reply BUG or DOCS
3. [[fixer]] — fix it
   case: BUG
3. [[writer]] — document it
   else: true
`;

test("the impact says what else changes: routing, renumbering, the agent file", () => {
  const i = removeStepImpact(ROUTED, 1);
  assert.equal(i.label, "step 2 · router");
  assert.ok(i.notes.some((n) => /case:\/when: steps after it \(fixer, writer\) will route on step 1's result \(intake\)/.test(n)), i.notes.join("\n"));
  assert.ok(i.notes.some((n) => /Group 3 after it renumbers to 2/.test(n)), i.notes.join("\n"));
  assert.ok(i.notes.some((n) => /agents\/router\/agent\.md is not touched/.test(n)));
  const branch = removeStepImpact(ROUTED, 2);
  assert.ok(branch.notes.some((n) => /case: BUG/.test(n)));
  assert.ok(branch.notes.some((n) => /other step in group 3 still runs/.test(n)));
});

test("the routed steps still route after their router is removed (on the step before)", () => {
  const out = removeStep(ROUTED, 1);
  assert.deepEqual(shape(out), ["1:intake", "2:fixer", "2:writer"]);
  assert.match(out, /case: BUG/);
});

test("a case: step left first is allowed (check does not call it an error), and the impact says so", () => {
  const first = `---\nname: t\n---\n\n1. [[router]] — decide\n2. [[fixer]] — fix\n   case: BUG\n`;
  assert.ok(removeStepImpact(first, 0).notes.some((n) => /will route on nothing/.test(n)));
  assert.deepEqual(shape(removeStep(first, 0)), ["1:fixer"]);
});

test("an error the flow already had does not block a removal, even when its step renumbers", () => {
  const bad = `---\nname: t\n---\n\n1. [[a]] — one\n2. [[b]] — two\n3. [[c]] — three\n   verify: the reply names the file\n`;
  const out = removeStep(bad, 0);
  assert.deepEqual(shape(out), ["1:b", "2:c"]);
  assert.match(out, /verify: the reply names the file/);
});

test("the only step can go; the flow is left with none", () => {
  const one = `---\nname: t\n---\n\n1. [[a]] — one\n`;
  assert.ok(removeStepImpact(one, 0).notes.some((n) => /only step/.test(n)));
  assert.deepEqual(shape(removeStep(one, 0)), []);
});

// The parser gives a step every option line below it until the next step,
// blank lines and notes between or not. Deleting it stopped at the blank
// line, so the options landed on the step above (audit, 2026-10-01).
test("options after a blank line go with their step, not to the step above", () => {
  const f = "1. [[x]]\n2. [[a]]\n\n   approve: true\n   verify: contains: done\n3. [[b]]\n";
  const out = removeStep(f, 1);
  const s = parseFlow("t.md", out).steps;
  assert.deepEqual(s.map((x) => [x.group, x.agent, x.approve ?? false, x.verify ?? null]), [[1, "x", false, null], [2, "b", false, null]]);
  // A note between the step and its option is prose: it stays.
  const noted = "1. [[x]]\n2. [[a]]\n\nA note.\n   retry: 2\n2. [[b]]\n";
  assert.equal(removeStep(noted, 1), "1. [[x]]\n\nA note.\n2. [[b]]\n");
});

test("a CRLF flow: its steps parse, a delete finds its options, and CRLF stays", () => {
  const crlf = FLOW.replace(/\n/g, "\r\n");
  assert.deepEqual(shape(crlf), shape(FLOW));
  const out = removeStep(crlf, 1);
  assert.equal(out, removeStep(FLOW, 1).replace(/\n/g, "\r\n"));
});
