// A step option's value keeps the quotes that belong to it.
//
// `schedule: "0 8 * * *"` is wrapped for readability and the cron parser
// must not see the quotes. The rule that did that stripped a leading or a
// trailing quote independently, so a shell command ending in a quoted
// variable lost its closing one and reached bash unbalanced — exit 2,
// "unexpected EOF", on every run, with the trace printing the already
// broken command. blog-desk's publisher could never pass its verify.
//
//   node --test tests/flow-quotes.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { unquote, parseFlow } from "../packages/core/src/store.ts";

test("a wholly wrapped value loses its wrapper", () => {
  assert.equal(unquote('"0 8 * * *"'), "0 8 * * *");
  assert.equal(unquote("'0 8 * * *'"), "0 8 * * *");
  assert.equal(unquote('  "spaced"  '), "spaced");
});

test("a value that merely ends with a quote keeps it — the regression", () => {
  const cmd = 'test -s ../../storage/draft/published.sha && test "$(cat ../../storage/draft/published.run)" = "$FOLDRUN_RUN_ID"';
  assert.equal(unquote(cmd), cmd);
  assert.equal(unquote('echo "hi"'), 'echo "hi"');
  assert.equal(unquote('"quoted" then more'), '"quoted" then more');
});

test("two pairs are not one wrapper", () => {
  assert.equal(unquote('"a" = "b"'), '"a" = "b"');
  assert.equal(unquote("'a' = 'b'"), "'a' = 'b'");
});

test("plain values and edge cases are untouched", () => {
  assert.equal(unquote("test -s out.md"), "test -s out.md");
  assert.equal(unquote('"'), '"');
  assert.equal(unquote(""), "");
  assert.equal(unquote('""'), "");
});

test("the flow parser now hands bash a balanced command", () => {
  const flow = parseFlow(
    "publish.md",
    `---
name: publish
trigger: schedule
schedule: "0 8 * * *"
---

1. [[publisher]] — publish it
   verify: test "$(cat ../../storage/draft/published.run)" = "$FOLDRUN_RUN_ID"
`,
  );
  assert.equal(flow.schedule, "0 8 * * *", "a wrapped cron still unwraps");
  const verify = flow.steps[0].verify!;
  assert.ok(verify.endsWith('"$FOLDRUN_RUN_ID"'), `closing quote lost: ${verify}`);
  const quotes = (verify.match(/"/g) ?? []).length;
  assert.equal(quotes % 2, 0, `unbalanced quotes (${quotes}) would fail bash with exit 2`);
});
