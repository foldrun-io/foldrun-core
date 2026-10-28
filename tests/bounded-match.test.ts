// Tenant patterns matched on the shared worker/web pod must not be able to
// hold its event loop (29 Oct 2026, OWASP review).
import { test } from "node:test";
import assert from "node:assert/strict";
import { globMatch, boundedRegexTest } from "../src/bounded-match.ts";
import { isSourcePath } from "../src/deploy.ts";

test("globMatch: * within a segment, ** across", () => {
  assert.equal(globMatch("*.md", "a.md"), true);
  assert.equal(globMatch("*.md", "x/a.md"), false);
  assert.equal(globMatch("**/*.md", "x/y/a.md"), true);
  assert.equal(globMatch("draft/*.mdx", "draft/b/a.mdx"), false);
  assert.equal(globMatch("a?b", "axb"), false, "? is a literal, as before");
});

test("globMatch: a backtracking pattern is still linear", () => {
  const t0 = Date.now();
  globMatch("**a**a**a**a**a**a**a**a**b", "a".repeat(5000));
  assert.ok(Date.now() - t0 < 500);
});

test("boundedRegexTest gives up on catastrophic backtracking", () => {
  assert.equal(boundedRegexTest("(a+)+$", "", "a".repeat(40) + "!", 100), "timeout");
  assert.equal(boundedRegexTest("hello", "i", "Say HELLO"), true);
  assert.throws(() => boundedRegexTest("(", "", "x"));
});

test("isSourcePath refuses paths that climb or are absolute", () => {
  assert.equal(isSourcePath("agents/../../../../.ssh/authorized_keys"), false);
  assert.equal(isSourcePath("/etc/passwd"), false);
  assert.equal(isSourcePath("agents//x.md"), false);
  assert.equal(isSourcePath("AGENTS.md"), true);
});
