// `tools: [site_repo, ` must complete like `tools:\n  - ` — the inline and
// block spellings of a list are one field.
//
//   node --test tests/inline-list-completions.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { completionsAt, type Vocabulary } from "../packages/core/src/completions.ts";

const VOCAB: Vocabulary = {
  agents: ["enricher", "emailer"],
  flows: [],
  skills: ["outreach"],
  tools: ["site_repo", "site_run", "cf_deploy"],
  secrets: ["CF_TOKEN"],
  scripts: [],
  types: [],
};

const at = (text: string) => completionsAt("agents/dev/agent.md", text, text.length, VOCAB);

test("tools: [ offers the workspace's own tools, minus ones already chosen", () => {
  const ctx = at("---\ntools: [site_repo, ")!;
  assert.ok(ctx, "inline tools: completes");
  const labels = ctx.items.map((i) => i.label);
  assert.ok(labels.includes("site_run"), "remaining tools offered");
  assert.ok(labels.includes("cf_deploy"));
  assert.ok(!labels.includes("site_repo"), "already chosen — not offered again");
});

test("tools: [ offers groups, own tools and SDK names alike", () => {
  const labels = at("---\ntools: [")!.items.map((i) => i.label);
  assert.ok(labels.includes("files"), "runtime group");
  assert.ok(labels.includes("site_repo"), "your own tool");
  assert.ok(labels.includes("Read"), "exact SDK name");
});

test("secrets:, delegate: and a typed prefix all behave", () => {
  assert.ok(at("---\nsecrets: [")!.items.some((i) => i.label === "CF_TOKEN"));
  assert.ok(at("---\ndelegate: [en")!.items.some((i) => i.label === "enricher"));
  assert.equal(at("---\ndelegate: [en")!.items.some((i) => i.label === "emailer"), false, "prefix filters");
});
