// Three things that were quietly wrong: a wrapped instruction losing most
// of itself, a `when:` marker matching a word in a sentence, and the Test
// button refusing a tool the runtime runs happily.
//
//   node --test tests/parser-fixes.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseFlow, markerPresent } from "../src/store.ts";

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

test("a blank line inside a step's block does not become part of the instruction", () => {
  const [step] = flow("1. [[a]] — do it\n\n   and also this\n").steps;
  assert.equal(step.instruction, "do it and also this");
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
