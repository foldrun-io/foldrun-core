// The `verify:` that is a sentence, and the step whose agent does not exist.
//
// Both failures come from real runs on a live account. Three steps of one
// weekly flow carried a `verify:` written as an English claim — "the reply
// names the clone it made and reports all five link_check buckets" — and
// `checkVerify` hands anything without an assertion prefix to a shell, so
// every run died with `bash: line 1: the: command not found` (exit 127)
// while the agents themselves had done the work. A fourth flow, on a
// different desk, named `[[ping]]` in a workspace holding one agent called
// `prober`: three scheduled runs, three failures, nothing to run.
//
// Neither is a judgement about a model's output. Both are structural, both
// are certain before the flow ever starts, and both are what `foldrun check`
// is for.
//
//   node --test tests/verify-dialect.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { lintFlow } from "../src/flow-lint.ts";
import { checkVerify } from "../src/step-exec.ts";
import { parseFlow } from "../src/store.ts";

const flow = (body: string) => parseFlow("flows/x.md", `---\nname: x\n---\n\n${body}`);
const KNOWN = { agents: ["auditor", "crawler", "prober"] };
const lint = (body: string, known = KNOWN) => lintFlow(flow(body), known);
const messages = (body: string, known = KNOWN) => lint(body, known).map((w) => w.message);

test("a verify: written as a sentence is an error, not a silent shell command", () => {
  const w = lint(
    "1. [[auditor]] — clone the site\n" +
      "   verify: the reply names the clone it made and reports the orphan count\n",
  );
  const found = w.find((x) => x.message.includes("reads as a sentence"));
  assert.ok(found, w.map((x) => x.message).join(" | "));
  assert.equal(found.level, "error");
  // The detail has to carry the fix, because the runtime error never will:
  // `command not found` says nothing about verify: at all.
  assert.match(found.detail, /judge: /);
});

test("the same sentence behind judge: is fine, and so is every other dialect", () => {
  for (const v of [
    "judge: the reply names the clone it made and reports the orphan count",
    "matches: (^|\\n)[#*_>\\s]*(GOOD|BAD)\\b",
    "contains: the price",
    "not-contains: AUDIT FAILED",
    "file: storage/report.md",
  ]) {
    const m = messages(`1. [[auditor]] — audit\n   verify: ${v}\n`);
    assert.ok(!m.some((x) => x.includes("reads as a sentence")), `${v} → ${m.join(" | ")}`);
  }
});

test("a real shell command is left alone, however wordy", () => {
  for (const v of [
    'test -n "$(find ../../storage/js-capture.md -mmin -180 -size +0c)"',
    "node ../../tools/link-check/link-check.mjs && node ../../tools/post-check/post-check.mjs",
    "./check.sh",
    "npm run build",
    "n=$(grep -oE 'NEXT CURSOR:[0-9]+' a.md); test -n \"$n\"",
    "head -1 ../../storage/digest.md | grep -qE '^(GOOD|BAD)'",
  ]) {
    const m = messages(`1. [[auditor]] — audit\n   verify: ${v}\n`);
    assert.ok(!m.some((x) => x.includes("reads as a sentence")), `${v} → ${m.join(" | ")}`);
  }
});

test("the lint's rule and the runtime's rule are the same rule", async () => {
  // If these ever disagree the lint is worse than nothing: it would bless a
  // verify that the runtime then shells. The prose one must fail for the
  // reason the lint gives, and the judge: one must not reach a shell at all.
  const prose = "the reply names the clone it made and reports the orphan count";
  const v = await checkVerify(process.cwd(), prose, { env: {}, result: "GOOD — done", conclusion: "GOOD — done" });
  assert.equal(v.ok, false);
  assert.match(v.headline, /^exit /);
  assert.ok(messages(`1. [[auditor]] — audit\n   verify: ${prose}\n`).some((x) => x.includes("reads as a sentence")));
});

test("a step whose agent is not in the workspace is an error", () => {
  const w = lint("1. [[ping]] — say hello\n");
  const found = w.find((x) => x.message.includes("[[ping]] is not an agent"));
  assert.ok(found, w.map((x) => x.message).join(" | "));
  assert.equal(found.level, "error");
});

test("agents that do exist, and subflow steps, are not reported", () => {
  const m = messages("1. [[auditor]] — audit\n2. [[crawler]] — crawl\n");
  assert.ok(!m.some((x) => x.includes("is not an agent")), m.join(" | "));
  const sub = messages("1. [[flow:other]] — run the other flow\n");
  assert.ok(!sub.some((x) => x.includes("is not an agent")), sub.join(" | "));
});

test("without the known names neither reference check fires", () => {
  const m = lintFlow(flow("1. [[ping]] — say hello\n")).map((x) => x.message);
  assert.ok(!m.some((x) => x.includes("is not an agent")), m.join(" | "));
});
