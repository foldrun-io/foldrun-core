// A `matches:` the runtime cannot compile. Flows' `verify: matches:` and
// evals' `- matches:` are both tested as a JavaScript RegExp with the `i`
// flag, and one that throws fails its check on every run with "invalid
// regular expression". On 2026-10-21 five eval checks on a live account were
// written with Python's inline `(?m)`, every case failed, and `foldrun check`
// had passed them all.
//
//   node --test tests/matches-regex.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { lintFlow, regexProblem } from "../src/flow-lint.ts";
import { checkFiles } from "../src/deploy.ts";
import { parseFlow } from "../src/store.ts";

test("regexProblem: fine patterns pass, inline flags are named", () => {
  assert.equal(regexProblem("(^|\\n)[#*_>\\s]*SKIP\\b"), null);
  assert.equal(regexProblem("^GOOD\\b"), null);
  const p = regexProblem("(?m)^[#*_>\\s]*SKIP\\b");
  assert.ok(p);
  assert.match(p, /not a valid JavaScript regular expression/);
  assert.match(p, /\(\?m\)/);
  assert.match(regexProblem("[unclosed") ?? "", /not a valid JavaScript regular expression/);
});

test("a flow's verify: matches: that cannot compile is reported on its line", () => {
  const flow = parseFlow("flows/x.md", "---\nname: x\n---\n\n1. [[auditor]] — check it\n   verify: matches: (?m)^GOOD\\b\n");
  const w = lintFlow(flow, { agents: ["auditor"] }).find((x) => x.message.startsWith("verify: matches:"));
  assert.ok(w, "expected a matches: warning");
  assert.equal(w.line, 5);
});

test("a flow's valid verify: matches: is not reported", () => {
  const flow = parseFlow("flows/x.md", "---\nname: x\n---\n\n1. [[auditor]] — check it\n   verify: matches: (^|\\n)GOOD\\b\n");
  assert.equal(lintFlow(flow, { agents: ["auditor"] }).filter((x) => x.message.startsWith("verify: matches:")).length, 0);
});

test("an eval's matches: that cannot compile is a check finding with its line", () => {
  const files = [
    { path: "AGENTS.md", content: "---\nname: lab\n---\n" },
    { path: "agents/validator/agent.md", content: "---\nname: validator\n---\nValidate.\n" },
    {
      path: "evals/validator-evidence.md",
      content:
        "---\nname: validator-evidence\nagent: validator\n---\n\n## skips\ntask: \"Decide.\"\nexpect:\n" +
        "  - matches: (?m)^[#*_>\\s]*SKIP\\b\n  - matches: (^|\\n)SKIP\\b\n",
    },
  ];
  const found = checkFiles(files as never).filter((f) => f.file === "evals/validator-evidence.md" && /matches:/.test(f.message));
  assert.equal(found.length, 1, JSON.stringify(found));
  assert.equal(found[0].line, 9);
  assert.equal(found[0].rule, "eval/config");
});

test("an eval's block-scalar matches: is tested as parsed, not by its first line", () => {
  const files = [
    { path: "AGENTS.md", content: "---\nname: lab\n---\n" },
    { path: "agents/validator/agent.md", content: "---\nname: validator\n---\nValidate.\n" },
    {
      path: "evals/block.md",
      content:
        "---\nname: block\nagent: validator\n---\n\n## bad block\ntask: \"Decide.\"\nexpect:\n" +
        "  - matches: |\n      (?m)^SKIP\n\n## good block\ntask: \"Decide.\"\nexpect:\n  - matches: |\n      (^|\\n)SKIP\n",
    },
  ];
  const found = checkFiles(files as never).filter((f) => f.file === "evals/block.md" && /matches:/.test(f.message));
  assert.equal(found.length, 1, JSON.stringify(found));
  assert.match(found[0].message, /bad block/);
  assert.equal(found[0].line, 9);
});

test("a quoted verify: matches: is checked after the quotes come off, as the runtime does", () => {
  const flow = parseFlow("flows/x.md", "---\nname: x\n---\n\n1. [[auditor]] — check it\n   verify: matches: 'abc\\'\n");
  const w = lintFlow(flow, { agents: ["auditor"] }).find((x) => x.message.startsWith("verify: matches:"));
  assert.ok(w, "a trailing backslash left once the quote is stripped must be reported");
});
