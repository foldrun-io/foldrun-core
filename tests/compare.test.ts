// FOL-72 step 6: two runs of one flow side by side — what differs step by
// step, in words, and which earlier run to compare with when none is named.
//
//   node --test tests/compare.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { compareRuns, lastGoodBefore } from "../src/compare.ts";
import type { RunRecord, StepRecord } from "../src/store.ts";

const T = (s: number) => new Date(Date.parse("2026-10-19T00:00:00.000Z") + s * 1000).toISOString();
const step = (over: Partial<StepRecord>): StepRecord =>
  ({ agent: "writer", instruction: "write it", group: 1, optional: false, status: "completed", events: [], result: "GOOD — done", costUsd: 0, startedAt: T(0), finishedAt: T(10), tokens: { input: 10000, output: 500 }, ...over }) as StepRecord;
const run = (id: string, steps: StepRecord[], over: Partial<RunRecord> = {}): RunRecord => ({ id, flow: "daily", status: "completed", startedAt: T(0), finishedAt: T(60), steps, revision: "r1", ...over }) as RunRecord;
const tool = (name: string, call: string, err = false) => [
  { t: T(1), type: "tool" as const, text: name, call },
  { t: T(2), type: "tool" as const, text: name, call, ms: 5, ...(err ? { err: true } : {}) },
];

test("what changed, in words: status, the new error, the instruction, tools, time, tokens", () => {
  const good = run("a", [step({ events: [...tool("Read", "1")] })]);
  const bad = run("b", [
    step({
      status: "failed",
      instruction: "write it better",
      finishedAt: T(50),
      tokens: { input: 40000, output: 900 },
      result: null,
      events: [...tool("Read", "1"), ...tool("web", "2", true), ...tool("web", "3", true), { t: T(9), type: "error", text: "web: 403 forbidden\nmore" }],
    }),
  ], { status: "failed", revision: "r2" });
  const c = compareRuns(good, bad, ["agents/writer/agent.md"]);
  assert.equal(c.revisionChanged, true);
  assert.deepEqual(c.changedFiles, ["agents/writer/agent.md"]);
  const [s] = c.steps;
  assert.deepEqual(s!.changes, [
    "status: completed → failed",
    "new error: web: 403 forbidden",
    "instruction changed",
    "tool errors: 0 → 2",
    "tools: +web ×2",
    "took 10s → 50s",
    "tokens in 10.0k → 40.0k",
  ]);
  assert.equal(s!.base!.tools.Read, 1, "a call/complete pair is one call");
});

test("identical runs differ in nothing; small wobbles are not changes", () => {
  const a = run("a", [step({})]);
  const b = run("b", [step({ finishedAt: T(13), tokens: { input: 11000, output: 520 } })]);
  assert.deepEqual(compareRuns(a, b).steps[0]!.changes, []);
});

test("steps line up by position where the agents agree, else by agent; extras are said", () => {
  const a = run("a", [step({ agent: "researcher" }), step({ agent: "writer" })]);
  const b = run("b", [step({ agent: "researcher" }), step({ agent: "editor" }), step({ agent: "writer" })]);
  const c = compareRuns(a, b);
  assert.deepEqual(c.steps.map((s) => [s.agent, s.changes[0] ?? ""]), [["researcher", ""], ["editor", "new step: not in the base run"], ["writer", ""]]);
});

test("the default baseline is the newest earlier good run of the same flow", () => {
  const runs = [
    { id: "x1", flow: "daily", startedAt: T(1), ok: true },
    { id: "x2", flow: "daily", startedAt: T(2), ok: false },
    { id: "x3", flow: "other", startedAt: T(3), ok: true },
    { id: "x4", flow: "daily", startedAt: T(4), ok: true },
  ];
  assert.equal(lastGoodBefore(runs, { id: "x5", flow: "daily", startedAt: T(5) }, (r) => r.ok)?.id, "x4");
  assert.equal(lastGoodBefore(runs, { id: "x2", flow: "daily", startedAt: T(2) }, (r) => r.ok)?.id, "x1");
  assert.equal(lastGoodBefore(runs, { id: "x1", flow: "daily", startedAt: T(1) }, (r) => r.ok), null);
});
