// A gate that shares its number with another step, and a gap in the numbers.
//
// medium-desk's articles flow read 3, 3, 4, 5, 5!, 7 after a renumbering:
// the publisher kept `5!` where it meant `6!`. Same number means "run
// together", so on approval the publisher started beside the cta-editor,
// found post.json still empty, rebuilt the article's parts itself and
// assembled a draft Medium then corrupted (run-mukdjeh8-cr66, 2026-09-28).
// The approver had also been shown an empty post.json. Nothing checked.
//
//   node --test tests/flow-numbering.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { lintFlow } from "../src/flow-lint.ts";
import { parseFlow } from "../src/store.ts";

const messages = (body: string) =>
  lintFlow(parseFlow("flows/x.md", `---\nname: x\n---\n\n${body}`)).map((w) => w.message);

test("the medium-desk shape: a gate beside a step, and the number it should have had", () => {
  const m = messages(
    "4. [[validator]] — check\n5. [[cta-editor]] — add the CTA\n5! [[publisher]] — publish\n7. [[verifier]] — read back\n",
  );
  assert.ok(m.includes('"publisher" waits for a person but shares number 5 with "cta-editor"'), m.join(" | "));
  assert.ok(m.includes("step numbers go from 5 to 7; nothing is numbered 6"), m.join(" | "));
});

test("ask: and wait: event are gates too", () => {
  assert.ok(messages("1. [[a]] — x\n2. [[b]] — y\n2. [[c]] — z\n   ask: which one?\n").some((x) => x.includes('"c" waits for a person')));
  assert.ok(messages("1. [[a]] — x\n2. [[b]] — y\n2. [[c]] — z\n   wait: event\n").some((x) => x.includes('"c" waits for a person')));
});

test("a gate on its own number, or two gates together, is not warned about", () => {
  const m = [
    ...messages("1. [[a]] — x\n2! [[b]] — y\n3. [[c]] — z\n"),
    ...messages("1. [[a]] — x\n2! [[b]] — y\n2! [[c]] — z\n"),
  ];
  assert.ok(!m.some((x) => x.includes("waits for a person")), m.join(" | "));
});

test("parallel steps with consecutive numbers are fine", () => {
  const m = messages("1. [[a]] — x\n2. [[b]] — y\n2. [[c]] — z\n3. [[d]] — w\n");
  assert.ok(!m.some((x) => x.includes("step numbers go from")), m.join(" | "));
});

test("a wider gap names the whole range", () => {
  assert.ok(messages("1. [[a]] — x\n4. [[b]] — y\n").includes("step numbers go from 1 to 4; nothing is numbered 2 to 3"));
});
