// An option's VALUE is read, or refused — never guessed at.
//
// `timeout: 15m` was Math.max(1, Number("15m") || 0): one second. Every
// step wearing it was cut off before its first tool call came back, and
// nothing said why, because the line looked right and the parser had
// quietly read a number the author never wrote. Same family: retry: 9
// clamped to 5, loop: abc read as nothing, each: columns read as no
// fan-out at all. Now the parser keeps the step, records the problem, and
// the lint reports it at error level so `foldrun check` fails.
//
//   node --test tests/option-values.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseFlow, parseTimeout } from "../src/store.ts";
import { lintFlow } from "../src/flow-lint.ts";

const flow = (body: string) => parseFlow("f.md", `---\nname: f\n---\n\n1. [[a]] — do it\n${body}`);
const errors = (body: string) => lintFlow(flow(body)).filter((w) => w.level === "error").map((w) => w.message);

test("timeout: takes the units wait: takes, and plain seconds", () => {
  assert.equal(parseTimeout("900"), 900);
  assert.equal(parseTimeout("15m"), 900);
  assert.equal(parseTimeout("4h"), 14_400);
  assert.equal(parseTimeout("3d"), 259_200);
  assert.equal(parseTimeout("1.5h"), 5400);
  assert.equal(parseTimeout("abc"), undefined);
  assert.equal(parseTimeout("0"), undefined);
  assert.equal(flow("   timeout: 15m\n").steps[0].timeout, 900, "fifteen minutes, not one second");
  assert.equal(flow("   timeout: 2700\n").steps[0].timeout, 2700);
  // No thirty-day ceiling on a timeout: the platform sets no clock of its
  // own, so the author's number stands.
  assert.equal(flow("   timeout: 45d\n").steps[0].timeout, 45 * 86_400);
});

test("timeout: abc is a check error, not a one-second step", () => {
  const [step] = flow("   timeout: abc\n").steps;
  assert.equal(step.timeout, undefined, "nothing is read from a value that is not a duration");
  assert.deepEqual(step.problems, ["timeout: abc — not a duration; write seconds (900) or 15m, 4h, 3d"]);
  const errs = errors("   timeout: abc\n");
  assert.equal(errs.length, 1);
  assert.match(errs[0], /^timeout: abc/);
  const [w] = lintFlow(flow("   timeout: abc\n")).filter((x) => x.level === "error");
  assert.equal(w.line, 5, "the error names the step's line");
});

test("counts are whole numbers within their caps", () => {
  assert.deepEqual(errors("   retry: 2\n   loop: 3\n   until: DONE\n   max: 20\n"), []);
  assert.match(errors("   retry: 9\n")[0], /^retry: 9 — .*at most 5/);
  assert.equal(flow("   retry: 9\n").steps[0].retry, 5, "over the cap still runs, capped — the check fails, the run does not");
  assert.match(errors("   retry: two\n")[0], /^retry: two/);
  assert.match(errors("   loop: 0\n")[0], /^loop: 0/);
  assert.match(errors("   loop: 2.5\n")[0], /^loop: 2\.5/);
  assert.match(errors("   max: 50\n")[0], /^max: 50 — .*1 to 20/);
  assert.match(errors("   max: abc\n")[0], /^max: abc/);
});

test("each:, output: and wait: refuse a shape they do not have", () => {
  assert.match(errors("   each: columns\n")[0], /^each: columns — lines, items, or rows of <path>/);
  assert.equal(flow("   each: columns\n").steps[0].each, undefined);
  assert.match(errors("   each: rows\n")[0], /^each: rows — rows needs a file/);
  assert.deepEqual(errors("   each: rows of ../../storage/leads.csv\n"), []);
  assert.match(errors("   output: yaml\n")[0], /^output: yaml — the only shape is json/);
  assert.deepEqual(errors("   output: json\n"), []);
  assert.match(errors("   wait: soon\n")[0], /^wait: soon — event, or a duration/);
  assert.deepEqual(errors("   wait: event\n"), []);
  assert.deepEqual(errors("   wait: 30m\n"), []);
});

test("a good flow has no errors, and the structural warnings stay advisory", () => {
  const f = flow("   timeout: 30m\n   retry: 1\n2. [[b]] — review both\n   when: BAD\n");
  const all = lintFlow(f);
  assert.deepEqual(all.filter((w) => w.level === "error"), []);
  for (const w of all) assert.notEqual(w.level, "error");
});
