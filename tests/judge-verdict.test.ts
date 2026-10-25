// A judge's verdict: the word alone on the last line, after the reasoning;
// the old word-first shape still reads; no word at all is a FAIL that says so.
//
//   node --test tests/judge-verdict.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { judgeVerdict, JUDGE_VERDICT_INSTRUCTION } from "../src/judge-verdict.ts";

test("the last line decides, not a word in the reasoning", () => {
  const v = judgeVerdict("It picks candidate 1 and rejects the off-topic one.\nIt never says FAIL-worthy things.\nPASS");
  assert.equal(v.passed, true);
  assert.match(v.detail, /^PASS — It picks candidate 1/);
  assert.equal(judgeVerdict("Part two does not hold: it files a brief.\n**FAIL**").passed, false);
});

test("the old shape — the word first — still reads", () => {
  assert.equal(judgeVerdict("PASS\nThe sentence makes no guarantee.").passed, true);
  assert.equal(judgeVerdict("FAIL: it promises rankings").passed, false);
});

test("no verdict is a FAIL that says so", () => {
  const v = judgeVerdict("I think it mostly works.");
  assert.equal(v.passed, false);
  assert.match(v.detail, /^judge gave no PASS or FAIL/);
  assert.match(JUDGE_VERDICT_INSTRUCTION, /last line/);
});
