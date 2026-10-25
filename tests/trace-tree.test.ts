// FOL-72 step 5: a run as one tree — run → step → model call → tool call —
// with the tool calls nested under the call that asked for them (by
// `inCall`, or by time on older records), errors as leaves, and the path the
// view opens on.
//
//   node --test tests/trace-tree.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTraceTree, failurePath } from "../src/trace-tree.ts";
import type { RunRecord, StepRecord } from "../src/store.ts";

const T = (s: number) => new Date(Date.parse("2026-10-19T00:00:00.000Z") + s * 1000).toISOString();
const tokens = { input: 100, output: 10, cacheRead: 50, cacheWrite: 0 };
const step = (over: Partial<StepRecord>): StepRecord =>
  ({ agent: "writer", instruction: "", group: 1, optional: false, status: "completed", events: [], result: null, costUsd: 0.01, startedAt: T(0), finishedAt: T(10), ...over }) as StepRecord;
const run = (steps: StepRecord[], over: Partial<RunRecord> = {}): RunRecord => ({ id: "r", flow: "daily", status: "completed", startedAt: T(0), finishedAt: T(20), steps, ...over }) as RunRecord;

test("tool calls nest under the model call that asked for them; a call lasts until its tools finish", () => {
  const s = step({
    calls: [
      { id: "m1", n: 1, at: T(2), ms: 1500, model: "haiku", stop: "tool_use", tokens, tools: 2 },
      { id: "m2", n: 2, at: T(6), ms: 1000, model: "haiku", stop: "end_turn", tokens, tools: 0 },
    ],
    events: [
      { t: T(2), type: "tool", text: "Read", call: "a", inCall: "m1", captured: true },
      { t: T(2), type: "tool", text: "Bash", call: "b", inCall: "m1" },
      { t: T(3), type: "tool", text: "Read", call: "a", ms: 500, captured: true },
      { t: T(5), type: "tool", text: "Bash", call: "b", ms: 2500, err: true },
    ],
  });
  const tree = buildTraceTree(run([s]));
  const [st] = tree.children;
  assert.equal(st!.kind, "step");
  assert.deepEqual(st!.children.map((c) => c.id), ["s0/m1", "s0/m2"]);
  const m1 = st!.children[0]!;
  assert.deepEqual(m1.children.map((c) => [c.label, c.status, c.captured === true]), [["Read", "ok", true], ["Bash", "error", false]]);
  assert.equal(m1.start, Date.parse(T(2)) - 1500, "the request went out ms before the answer");
  assert.equal(m1.end, Date.parse(T(2)) + 2500, "until its last tool finished");
  assert.equal(m1.stop, "tool_use");
});

test("an older record (no inCall) nests a tool under the last call that answered before it", () => {
  const s = step({
    calls: [{ id: "m1", n: 1, at: T(1), ms: 500, tokens, tools: 1 }, { id: "m2", n: 2, at: T(4), ms: 500, tokens, tools: 1 }],
    events: [
      { t: T(1), type: "tool", text: "Read", call: "a" },
      { t: T(4), type: "tool", text: "Grep", call: "b" },
    ],
  });
  const [st] = buildTraceTree(run([s])).children;
  assert.deepEqual(st!.children.map((m) => m.children.map((t) => t.label)), [["Read"], ["Grep"]]);
});

test("a step with no model calls on record keeps its tools under itself; errors are leaves", () => {
  const s = step({ status: "failed", events: [{ t: T(1), type: "tool", text: "Read", call: "a" }, { t: T(2), type: "error", text: "boom" }] });
  const [st] = buildTraceTree(run([s], { status: "failed" })).children;
  assert.deepEqual(st!.children.map((c) => [c.kind, c.label]), [["tool", "Read"], ["error", "error"]]);
  assert.equal(st!.children[1]!.text, "boom");
});

test("the view opens on the failed tool, else the error line, else the failed step", () => {
  const failedTool = step({ status: "failed", calls: [{ id: "m1", n: 1, at: T(1), ms: 1, tokens, tools: 1 }], events: [{ t: T(1), type: "tool", text: "Bash", call: "b", inCall: "m1" }, { t: T(2), type: "tool", text: "Bash", call: "b", ms: 9, err: true }, { t: T(3), type: "error", text: "exit 1" }] });
  assert.deepEqual(failurePath(buildTraceTree(run([step({}), failedTool], { status: "failed" }))), ["run", "s1", "s1/m1", "s1/t:b"]);
  const onlyError = step({ status: "failed", events: [{ t: T(3), type: "error", text: "exit 1" }] });
  assert.deepEqual(failurePath(buildTraceTree(run([onlyError], { status: "failed" }))), ["run", "s0", "s0/e0"]);
  assert.deepEqual(failurePath(buildTraceTree(run([step({})]))), []);
});

test("a running step and run end at now; a retry's calls get their own ids", () => {
  const now = Date.parse(T(30));
  const s = step({ status: "running", finishedAt: undefined, calls: [{ id: "m1", n: 1, at: T(1), ms: 1, tokens, tools: 0 }, { id: "m1", n: 2, at: T(9), ms: 1, tokens, tools: 0, attempt: 2 }] });
  const tree = buildTraceTree(run([s], { status: "running", finishedAt: null }), now);
  assert.equal(tree.end, now);
  assert.equal(tree.children[0]!.end, now);
  assert.deepEqual(tree.children[0]!.children.map((c) => c.id), ["s0/m1", "s0/m2.2"]);
});
