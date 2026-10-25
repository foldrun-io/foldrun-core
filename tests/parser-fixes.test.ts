// Three things that were quietly wrong: a wrapped instruction losing most
// of itself, a `when:` marker matching a word in a sentence, and the Test
// button refusing a tool the runtime runs happily.
//
//   node --test tests/parser-fixes.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseFlow, markerPresent } from "../src/store.ts";
import { lintFlow } from "../src/flow-lint.ts";

// ------------------------------------------- wrapped instructions

const flow = (body: string) => parseFlow("x.md", `---\nname: x\n---\n\n${body}`);

test("an instruction wrapped over several lines keeps all of itself", () => {
  // It used to keep the first line and silently drop the rest. The run went
  // green and the agent worked from an instruction nobody wrote.
  const [step] = flow(
    "1. [[writer]] — write the article and make sure it covers\n" +
      "   the three points we agreed, then hand it to the editor\n" +
      "   with a note about tone\n",
  ).steps;
  assert.equal(
    step.instruction,
    "write the article and make sure it covers the three points we agreed, then hand it to the editor with a note about tone",
  );
});

test("options still parse, and a continuation before them still joins", () => {
  const [step] = flow(
    "1. [[writer]] — write it\n   and keep going here\n   timeout: 600\n   verify: contains: DONE\n",
  ).steps;
  assert.equal(step.instruction, "write it and keep going here");
  assert.equal(step.timeout, 600);
  assert.equal(step.verify, "contains: DONE");
});

test("unindented prose between steps is still prose", () => {
  const f = flow(
    "Some commentary about this flow.\n\n1. [[a]] — do it\n\nMore commentary.\n\n2. [[b]] — then this\n",
  );
  assert.deepEqual(f.steps.map((s) => s.instruction), ["do it", "then this"]);
});

test("a blank line ends the instruction — what follows is not orders", () => {
  // It used to keep reading after the blank line, which is how prose below
  // the last step became part of that step's instruction.
  const [step] = flow("1. [[a]] — do it\n\n   and also this\n").steps;
  assert.equal(step.instruction, "do it");
  assert.equal(step.wrapped, undefined);
});

test("the gbp-desk shape: prose and bullets after the last step stay out", () => {
  // Live evidence. flows/posts.md in gbp-desk had its publisher told to
  // "publish Tuesday's five every way step 3 could fail was also a way
  // Thursday's five silently never went out" — the WRAPPED LINES of a
  // bullet three paragraphs down, whose own "- " line was ignored.
  const f = flow(
    "3! [[post-publisher]] — publish Tuesday's five\n" +
      "   preview: post-plan.csv\n" +
      "   verify: matches: lpsid=\n" +
      "\n" +
      "**One planning session, two publications — but not one run.** The expensive,\n" +
      "thoughtful part is choosing ten topics.\n" +
      "\n" +
      "- *A failed Tuesday ate Thursday.* A step that fails skips the one after it, so\n" +
      "  every way step 3 could fail was also a way Thursday's five silently never\n" +
      "  went out. On 2026-09-08 that happened for nothing.\n",
  );
  assert.equal(f.steps.length, 1);
  assert.equal(f.steps[0].instruction, "publish Tuesday's five");
  assert.equal(f.steps[0].approve, true);
  assert.equal(f.steps[0].verify, "matches: lpsid=");
});

test("an instruction followed straight by indented options keeps just itself", () => {
  const [step] = flow("1. [[a]] — do the thing\n   model: max\n   retry: 2\n").steps;
  assert.equal(step.instruction, "do the thing");
  assert.equal(step.wrapped, undefined);
  assert.equal(step.model, "max");
  assert.equal(step.retry, 2);
});

test("an indented heading under a step is a document, not a continuation", () => {
  const [step] = flow("1. [[a]] — do it\n   ## Notes\n   more words\n").steps;
  assert.equal(step.instruction, "do it");
});

test("an indented bold paragraph under a step is not a continuation", () => {
  const [step] = flow("1. [[a]] — do it\n   **Why it left.** It used to be step 4.\n").steps;
  assert.equal(step.instruction, "do it");
});

test("a genuinely wrapped instruction is marked wrapped, so check can say so", () => {
  const [step] = flow("1. [[a]] — do it\n   and then do the other thing\n").steps;
  assert.equal(step.instruction, "do it and then do the other thing");
  assert.equal(step.wrapped, true);
});

test("check warns about a wrapped instruction and names the agent", () => {
  const f = flow("1. [[writer]] — write it\n   and keep going here\n");
  const w = lintFlow(f).filter((x) => /more than one line/.test(x.message));
  assert.equal(w.length, 1);
  assert.match(w[0].message, /writer/);
  assert.notEqual(w[0].level, "error");
  const quiet = lintFlow(flow("1. [[writer]] — write it\n   model: max\n"));
  assert.equal(quiet.filter((x) => /more than one line/.test(x.message)).length, 0);
});

// ------------------------------------------------- when: markers

test("a marker at the start of a line matches, with or without decoration", () => {
  assert.equal(markerPresent("BLOCKED: the gate is shut", "BLOCKED"), true);
  assert.equal(markerPresent("## BLOCKED\nmore text", "BLOCKED"), true);
  assert.equal(markerPresent("- **BLOCKED** by the vendor", "BLOCKED"), true);
  assert.equal(markerPresent("all fine\n> BLOCKED later on", "BLOCKED"), true);
  assert.equal(markerPresent("blocked: lower case still counts", "BLOCKED"), true);
});

test("a marker used inside a sentence does NOT match — the whole point", () => {
  // Saying a marker is absent necessarily names it, so the more carefully an
  // agent explains itself the more likely a substring search trips its own
  // condition. This bit one desk on its first run.
  assert.equal(markerPresent("There are no BLOCKED items this week.", "BLOCKED"), false);
  assert.equal(markerPresent("Nothing is BLOCKED.", "BLOCKED"), false);
  assert.equal(markerPresent("I checked whether anything was BLOCKED and it was not.", "BLOCKED"), false);
});

test("a longer word beginning the same way is not the marker", () => {
  assert.equal(markerPresent("BLOCKEDBY: vendor", "BLOCKED"), false);
  assert.equal(markerPresent("GOODISH news", "GOOD"), false);
  assert.equal(markerPresent("GOOD news", "GOOD"), true);
});

test("nothing matches an empty marker or empty text", () => {
  assert.equal(markerPresent("GOOD", ""), false);
  assert.equal(markerPresent("", "GOOD"), false);
  assert.equal(markerPresent(null, "GOOD"), false);
});

test("case: uses the same marker rule, which matters more because routing is exclusive", () => {
  // A label picked out of a sentence does not merely run an extra step: it
  // sends the flow down the wrong branch and skips the right one.
  assert.equal(markerPresent("This is not a COMPLAINT, it is a QUESTION.", "COMPLAINT"), false);
  assert.equal(markerPresent("QUESTION: how do I rotate a key?", "QUESTION"), true);
});

test("an indented line with a colon that is not a real option is still the instruction", () => {
  // "Warning: do not publish" used to be swallowed as an unknown option.
  const [step] = flow("1. [[a]] — do the thing\n   Warning: do not publish before Tuesday\n   timeout: 30\n").steps;
  assert.equal(step.instruction, "do the thing Warning: do not publish before Tuesday");
  assert.equal(step.timeout, 30);
});

test("hostile input cannot stall the parser — every flagged pattern is linear now", () => {
  // Each of these was a CodeQL polynomial-backtracking finding. A flow
  // file, a tool's base URL and an agent's reply are all customer input.
  const wide = " ".repeat(200_000);
  const t0 = performance.now();
  parseFlow("x.md", `---\nname: x\n---\n\n1. [[a]]${wide}\n   verify:${wide}\n`);
  parseFlow("x.md", `---\nname: x\n---\n\n9 [[-]]${wide}x\n`);
  const t1 = performance.now();
  assert.ok(t1 - t0 < 500, `parseFlow took ${Math.round(t1 - t0)}ms on 200k spaces`);
});

test("the step line still parses every shape it did", () => {
  const f = flow("1. [[a]] — with a dash\n2! [[b]]\n3? [[c]] no dash\n4. [[flow:sub]] — nested\n   retry: 2\n");
  assert.deepEqual(
    f.steps.map((s) => [s.group, s.agent, s.instruction, s.approve ?? false, s.optional]),
    [
      [1, "a", "with a dash", false, false],
      [2, "b", "", true, false],
      [3, "c", "no dash", false, true],
      [4, "sub", "nested", false, false],
    ],
  );
  assert.equal(f.steps[3].retry, 2);
});
