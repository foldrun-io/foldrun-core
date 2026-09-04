// The counters on the graph's dots: how the last run ended, runs in the
// window, spend in the window — for each flow and each agent, from the run
// records alone.

import test from "node:test";
import assert from "node:assert/strict";
import { nodeStats, attachStats, fmtAgo, fmtCost, statsLine } from "../web/components/graph-stats-model.ts";
import type { RunRecord, StepRecord } from "../packages/core/src/store.ts";
import type { GNode } from "../web/server/graph.ts";

const NOW = Date.parse("2026-09-04T00:00:00Z");
const DAY = 24 * 60 * 60 * 1000;
const at = (daysAgo: number) => new Date(NOW - daysAgo * DAY).toISOString();

const step = (over: Partial<StepRecord>): StepRecord => ({
  agent: "writer",
  instruction: "",
  group: 1,
  optional: false,
  status: "completed",
  events: [],
  result: null,
  costUsd: null,
  ...over,
});

const run = (over: Partial<RunRecord> & { workspace?: string }): RunRecord & { workspace: string } => ({
  id: "r",
  flow: "weekly",
  status: "completed",
  startedAt: at(0),
  finishedAt: null,
  steps: [],
  workspace: "ws",
  ...over,
});

test("a flow's counters: last status, runs and cost inside the window only", () => {
  const stats = nodeStats(
    [
      run({ id: "old", startedAt: at(9), steps: [step({ costUsd: 5 })] }),
      run({ id: "a", startedAt: at(2), status: "failed", steps: [step({ costUsd: 1 })] }),
      run({ id: "b", startedAt: at(1), steps: [step({ costUsd: 0.5 }), step({ agent: "checker", costUsd: 0.25 })] }),
    ],
    NOW,
  );
  assert.deepEqual(stats["flow:ws:weekly"], { last: "completed", lastAt: at(1), runs: 2, cost: 1.75 });
});

test("the last run is the newest by start time, whatever order the records come in", () => {
  const stats = nodeStats(
    [run({ id: "new", startedAt: at(1), status: "failed" }), run({ id: "older", startedAt: at(3) })],
    NOW,
  );
  assert.equal(stats["flow:ws:weekly"].last, "failed");
});

test("a stopped run reads as stopped, for the flow and for its agents", () => {
  const stats = nodeStats(
    [
      run({
        status: "failed",
        stopRequested: true,
        steps: [step({ status: "completed" }), step({ agent: "later", status: "skipped", skipReason: "run stopped" })],
      }),
    ],
    NOW,
  );
  assert.equal(stats["flow:ws:weekly"].last, "stopped");
  assert.equal(stats["agent:ws:later"].last, "stopped");
  assert.equal(stats["agent:ws:writer"].last, "completed");
});

test("an adhoc run counts for its agent and for no flow; an eval run likewise", () => {
  const stats = nodeStats(
    [
      run({ flow: "adhoc:writer", steps: [step({ costUsd: 0.1 })] }),
      run({ flow: "eval:writer-regressions", steps: [step({ costUsd: 0.2 })] }),
    ],
    NOW,
  );
  assert.equal(Object.keys(stats).filter((k) => k.startsWith("flow:")).length, 0);
  assert.deepEqual(stats["agent:ws:writer"], { last: "completed", lastAt: at(0), runs: 2, cost: 0.30000000000000004 });
});

test("an agent's cost is its own steps'; a carried step belongs to the run it ran in", () => {
  const stats = nodeStats(
    [
      run({
        steps: [
          step({ agent: "a", costUsd: 1, carriedFrom: "earlier" }),
          step({ agent: "b", costUsd: 2, group: 2 }),
        ],
      }),
    ],
    NOW,
  );
  assert.equal(stats["agent:ws:a"], undefined);
  assert.equal(stats["agent:ws:b"].cost, 2);
  // The flow still paid for everything on its record.
  assert.equal(stats["flow:ws:weekly"].cost, 3);
});

test("an agent that stepped twice in one run counts one run, and reads worst-first", () => {
  const stats = nodeStats(
    [
      run({
        steps: [
          step({ agent: "a", status: "completed", costUsd: 1 }),
          step({ agent: "a", status: "failed", costUsd: 1, group: 2 }),
        ],
      }),
    ],
    NOW,
  );
  assert.equal(stats["agent:ws:a"].runs, 1);
  assert.equal(stats["agent:ws:a"].cost, 2);
  assert.equal(stats["agent:ws:a"].last, "failed");
});

test("ids are namespaced by workspace", () => {
  const stats = nodeStats([run({ workspace: "one" }), run({ workspace: "two", steps: [step({})] })], NOW);
  assert.ok(stats["flow:one:weekly"]);
  assert.ok(stats["flow:two:weekly"]);
  assert.ok(stats["agent:two:writer"]);
  assert.equal(stats["agent:one:writer"], undefined);
});

test("attachStats stamps matching nodes and leaves the rest without a field", () => {
  const nodes: GNode[] = [
    { id: "flow:ws:weekly", kind: "flow", label: "weekly", degree: 0 },
    { id: "agent:ws:idle", kind: "agent", label: "idle", degree: 0 },
  ];
  attachStats(nodes, nodeStats([run({})], NOW));
  assert.equal(nodes[0].stats?.runs, 1);
  assert.equal("stats" in nodes[1], false);
});

test("the line and the words", () => {
  assert.equal(statsLine({ last: "completed", lastAt: "", runs: 1, cost: 0 }), "1 run · $0");
  assert.equal(statsLine({ last: "completed", lastAt: "", runs: 12, cost: 3.214 }), "12 runs · $3.21");
  assert.equal(fmtCost(0.004), "<$0.01");
  assert.equal(fmtAgo(30_000), "just now");
  assert.equal(fmtAgo(5 * 60_000), "5m ago");
  assert.equal(fmtAgo(3 * 3_600_000), "3h ago");
  assert.equal(fmtAgo(3 * DAY), "3d ago");
});
