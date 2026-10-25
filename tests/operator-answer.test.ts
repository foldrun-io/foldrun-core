// What a gate's approver said reaching the step, and why a refused tool call
// failed reaching the trail.
//
//   node --test tests/operator-answer.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import { operatorBlock } from "../src/runner.ts";
import { toolResultText } from "../src/step-exec.ts";

const root = os.tmpdir();

test("an ask: gate approved with no note still tells the step it was answered", () => {
  const out = operatorBlock({ ask: "Which offices?", approvedAt: "2026-10-04T23:07:43Z" }, root);
  assert.match(out, /<operator_answer>/);
  assert.match(out, /This step asked a human: Which offices\?/);
  assert.match(out, /approved it with no note/);
});

test("a note is the answer to an ask:, and guidance without one", () => {
  assert.match(operatorBlock({ ask: "Which offices?", approvalNote: "NSW only", approvedAt: "x" }, root), /Their answer:\nNSW only\n<\/operator_answer>/);
  assert.match(operatorBlock({ approvalNote: "skip Sydney", approvedAt: "x" }, root), /<operator_guidance>\nThe human who approved this step added:\nskip Sydney/);
});

test("nothing is added for a plain gate, or an ask: not yet approved", () => {
  assert.equal(operatorBlock({ approvedAt: "x" }, root), "");
  assert.equal(operatorBlock({ ask: "Which offices?" }, root), "");
});

test("a tool result's text is read from a string or from text blocks", () => {
  assert.equal(toolResultText("denied"), "denied");
  assert.equal(toolResultText([{ type: "text", text: "a" }, { type: "image" }, { type: "text", text: "b" }]), "a b");
  assert.equal(toolResultText(undefined), "");
});
