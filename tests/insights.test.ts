// FOL-72 step 8: insights — recurring problems found in the runs, each with
// evidence, an estimate of what it cost and what to do.
//
//   node --test tests/insights.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { findInsights } from "../src/insights.ts";
import type { RunRecord, StepRecord } from "../src/store.ts";

const T = (s: number) => new Date(Date.parse("2026-10-19T00:00:00.000Z") + s * 1000).toISOString();
const step = (over: Partial<StepRecord>): StepRecord =>
  ({ agent: "writer", instruction: "", group: 1, optional: false, status: "completed", events: [], result: "ok", costUsd: 0.5, startedAt: T(0), finishedAt: T(60), ...over }) as StepRecord;
const run = (i: number, s: StepRecord): RunRecord & { workspace: string } => ({ id: `run-${i}`, flow: "daily", status: "completed", startedAt: T(i * 100), finishedAt: T(i * 100 + 60), steps: [s], workspace: "blog" }) as RunRecord & { workspace: string };
const three = (s: () => StepRecord) => [1, 2, 3].map((i) => run(i, s()));

test("cache: big prompts mostly uncached on most steps", () => {
  const [i] = findInsights(three(() => step({ tokens: { input: 50_000, output: 500, cacheRead: 5_000, cacheWrite: 40_000 } })));
  assert.equal(i!.kind, "cache");
  assert.match(i!.title, /10% from the cache/);
  assert.ok(i!.credits! > 0);
  assert.deepEqual(i!.evidence.map((e) => e.runId), ["run-3", "run-2", "run-1"]);
  assert.deepEqual(findInsights(three(() => step({ tokens: { input: 50_000, output: 500, cacheRead: 45_000, cacheWrite: 0 } }))), [], "a well-cached agent is fine");
});

test("big-result: a large tool result with several calls after it", () => {
  const s = () =>
    step({
      tokens: { input: 200_000, output: 900, cacheRead: 150_000, cacheWrite: 0 },
      calls: [1, 2, 3, 4].map((n) => ({ id: `m${n}`, n, at: T(n * 10), ms: 1, tokens: { input: 50_000, output: 1, cacheRead: 40_000, cacheWrite: 0 }, tools: 1 })),
      events: [{ t: T(5), type: "tool", text: "crm_export", call: "a" }, { t: T(6), type: "tool", text: "crm_export", call: "a", ms: 900, bytes: 60_000 }],
    });
  const [i] = findInsights(three(s));
  assert.equal(i!.kind, "big-result");
  assert.equal(i!.tool, "crm_export");
  assert.match(i!.title, /60k characters/);
});

test("retry-loop and timeout; fewer than the minimum steps says nothing", () => {
  const loop = () => step({ events: [1, 2, 3].flatMap((n) => [{ t: T(n), type: "tool" as const, text: "web", call: `c${n}` }, { t: T(n), type: "tool" as const, text: "web", call: `c${n}`, ms: 5, err: true }]) });
  assert.equal(findInsights([run(1, loop()), run(2, loop())])[0]?.kind, "retry-loop");
  const slow = () => step({ timeout: 100, startedAt: T(0), finishedAt: T(90) });
  assert.equal(findInsights([run(1, slow()), run(2, slow())])[0]?.kind, "timeout");
  assert.deepEqual(findInsights([run(1, slow())]), []);
});
