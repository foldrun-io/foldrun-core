// Frontmatter edited one key at a time, everything else byte for byte.

import test from "node:test";
import assert from "node:assert/strict";
import matter from "gray-matter";
import { patchFrontmatter } from "../packages/core/src/agents-md.ts";

const FILE = `---
name: leads
# the desk's purpose
description: Finds leads.
notify:
  email: ops@example.com
  events: [failed]
budget: 40
---

Context every agent works under.
`;

test("a scalar is replaced in place; comments and neighbours survive", () => {
  const out = patchFrontmatter(FILE, { budget: 60 });
  assert.ok(out.includes("budget: 60\n---"));
  assert.ok(out.includes("# the desk's purpose"));
  assert.ok(out.includes("description: Finds leads."));
  assert.ok(out.endsWith("Context every agent works under.\n"));
});

test("a nested block is replaced whole, and null removes a key", () => {
  const out = patchFrontmatter(FILE, { notify: { url: "${SLACK}", events: ["failed", "completed"] }, budget: null });
  assert.ok(!out.includes("email: ops@example.com"));
  assert.deepEqual(matter(out).data.notify, { url: "${SLACK}", events: ["failed", "completed"] });
  assert.ok(out.includes("notify:\n  url:"));
  assert.ok(!out.includes("budget"));
  assert.ok(out.includes("description: Finds leads.\n"));
});

test("a missing key is appended; a file without frontmatter gets one", () => {
  const out = patchFrontmatter(FILE, { timezone: "Australia/Sydney" });
  assert.ok(out.includes("budget: 40\ntimezone: Australia/Sydney\n---"));
  const fresh = patchFrontmatter("Just a body.\n", { budget: 5 });
  assert.equal(fresh, "---\nbudget: 5\n---\nJust a body.\n");
  const empty = patchFrontmatter("", { budget: 5 });
  assert.equal(empty, "---\nbudget: 5\n---\n");
});

test("removing the last key removes the frontmatter", () => {
  const out = patchFrontmatter("---\nbudget: 5\n---\n\nBody.\n", { budget: null });
  assert.equal(out, "Body.\n");
});
