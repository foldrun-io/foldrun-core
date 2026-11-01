// A flow's `a2a:` block (1 Nov 2026): what it publishes, what check says
// about it, and that a block with any problem publishes nothing.
//
//   node --test tests/a2a-publish.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseA2aPublish, a2aPublishProblems, a2aPublishProblem, isA2aPublished, A2A_LIMITS } from "../src/a2a-publish.ts";
import { frontmatterProblems, FRONTMATTER } from "../src/frontmatter-schema.ts";
import { parseFlow } from "../src/store.ts";
import { nearestField } from "../src/scan.ts";

test("a full block reads as written; absent reads as nothing", () => {
  assert.equal(parseA2aPublish(undefined), null);
  assert.equal(parseA2aPublish(null), null);
  const p = parseA2aPublish({
    publish: true,
    name: " Lead finder ",
    description: "Finds leads",
    examples: ["dentists in Perth"],
    public_card: true,
    input: { type: "object", required: ["city"], properties: { city: { type: "string" } } },
  });
  assert.deepEqual(p, {
    publish: true,
    name: "Lead finder",
    description: "Finds leads",
    examples: ["dentists in Perth"],
    publicCard: true,
    input: { type: "object", required: ["city"], properties: { city: { type: "string" } } },
  });
  assert.ok(isA2aPublished(p));
  const minimal = parseA2aPublish({ publish: true })!;
  assert.deepEqual(minimal, { publish: true, name: null, description: null, examples: [], publicCard: false, input: null }, "the card is private unless said");
  assert.ok(!isA2aPublished(parseA2aPublish({ publish: false })));
});

test("a block with any problem publishes nothing — fail closed", () => {
  for (const bad of [
    true,
    "yes",
    ["publish"],
    {},
    { publish: "true" },
    { publish: true, pubilc_card: true },
    { publish: true, examples: "one" },
    { publish: true, examples: Array.from({ length: A2A_LIMITS.examples + 1 }, (_, i) => `e${i}`) },
    { publish: true, name: "x".repeat(A2A_LIMITS.name + 1) },
    { publish: true, public_card: "yes" },
    { publish: true, input: "a schema" },
    { publish: true, input: [1, 2] },
  ]) {
    assert.ok(a2aPublishProblems(bad).length > 0, JSON.stringify(bad));
    assert.equal(parseA2aPublish(bad), null, JSON.stringify(bad));
    assert.ok(!isA2aPublished(parseA2aPublish(bad)));
  }
  assert.match(a2aPublishProblem({ publish: true, nope: 1 })!, /not published/);
  assert.equal(a2aPublishProblem({ publish: true }), null);
});

test("the schema knows a2a: on a flow, and check reports a bad one by rule", () => {
  assert.ok(FRONTMATTER.flow.some((f) => f.key === "a2a"));
  assert.ok(!FRONTMATTER.agent.some((f) => f.key === "a2a"), "an agent is not served in the MVP");
  assert.deepEqual(frontmatterProblems("flow", { a2a: { publish: true } }, nearestField), []);
  const wrong = frontmatterProblems("flow", { a2a: { publish: "yes" } }, nearestField);
  assert.equal(wrong.length, 1);
  assert.equal(wrong[0]!.rule, "config/invalid-value");
  assert.match(wrong[0]!.message, /^`a2a:` /);
  const notAMap = frontmatterProblems("flow", { a2a: "publish" }, nearestField);
  assert.equal(notAMap[0]!.rule, "config/wrong-type");
});

test("parseFlow carries the publication; a broken block is none", () => {
  const flow = parseFlow("leads.md", "---\nname: leads\na2a:\n  publish: true\n  examples: [dentists]\n---\n\n1. [[writer]] — find leads\n");
  assert.deepEqual(flow.a2a, { publish: true, name: null, description: null, examples: ["dentists"], publicCard: false, input: null });
  assert.equal(parseFlow("plain.md", "---\nname: plain\n---\n\n1. [[writer]] — x\n").a2a, null);
  assert.equal(parseFlow("bad.md", "---\nname: bad\na2a:\n  publish: yes please\n---\n\n1. [[writer]] — x\n").a2a, null);
});
