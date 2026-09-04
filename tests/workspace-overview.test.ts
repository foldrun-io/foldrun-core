// The workspace overview's rows: a flow's next fire and last run, an
// agent's last status and week, the shared search.

import test from "node:test";
import assert from "node:assert/strict";
import { flowRows, agentRows, matches, fmtIn } from "../web/components/workspace-overview-model.ts";
import { parseCron, nextFire } from "../packages/core/src/scheduler.ts";

const cronNext = (schedule: string, timezone: string | null, now: number) => {
  const cron = parseCron(schedule);
  return cron ? (nextFire(cron, new Date(now), timezone ?? "UTC")?.toISOString() ?? null) : null;
};
import type { AgentInfo, FlowInfo, RunRecord, StepRecord } from "../packages/core/src/store.ts";

const NOW = Date.parse("2026-09-04T10:00:00Z");
const DAY = 24 * 60 * 60 * 1000;
const at = (daysAgo: number) => new Date(NOW - daysAgo * DAY).toISOString();

const step = (over: Partial<StepRecord>): StepRecord => ({
  agent: "writer", instruction: "", group: 1, optional: false, status: "completed", events: [], result: null, costUsd: null, ...over,
});
const run = (over: Partial<RunRecord>): RunRecord => ({
  id: "r", flow: "weekly", status: "completed", startedAt: at(0), finishedAt: null, steps: [], ...over,
});
const flow = (over: Partial<FlowInfo>): FlowInfo =>
  ({ name: "weekly", file: "weekly.md", trigger: "schedule", schedule: "0 5 * * *", timezone: null, model: null, effort: null, steps: [{ agent: "writer", instruction: "", group: 1, optional: false }], ...over }) as FlowInfo;

test("a scheduled flow says when it next fires; a manual one does not", () => {
  const rows = flowRows([flow({}), flow({ name: "adhoc", file: "adhoc.md", trigger: "manual", schedule: null })], [], NOW, cronNext);
  assert.equal(rows[0].nextFireAt, "2026-09-05T05:00:00.000Z");
  assert.equal(rows[1].nextFireAt, null);
  assert.equal(rows[0].steps, 1);
});

test("a flow's last run, its week, and what is live", () => {
  const rows = flowRows(
    [flow({})],
    [
      run({ id: "old", startedAt: at(10), steps: [step({ costUsd: 5 })] }),
      run({ id: "new", startedAt: at(1), status: "failed", summary: "bounced", steps: [step({ costUsd: 1 })] }),
      run({ id: "live", startedAt: at(0), status: "running" }),
      run({ id: "other", flow: "else", startedAt: at(0), steps: [step({ costUsd: 9 })] }),
    ],
    NOW,
  );
  assert.equal(rows[0].last?.id, "live");
  assert.equal(rows[0].runs7d, 2);
  assert.equal(rows[0].spend7d, 1);
  assert.equal(rows[0].live, 1);
});

test("an agent reads its last status and its week from the runs it took part in", () => {
  const agents = [{ name: "writer", description: "writes", model: "sonnet" }, { name: "idle", description: "", model: "haiku" }] as AgentInfo[];
  const rows = agentRows(agents, [run({ startedAt: at(2), steps: [step({ status: "failed", costUsd: 0.5 })] })], NOW);
  assert.equal(rows[0].last, "failed");
  assert.equal(rows[0].runs7d, 1);
  assert.equal(rows[0].spend7d, 0.5);
  assert.equal(rows[1].last, null);
  assert.equal(rows[1].runs7d, 0);
});

test("the search and the words", () => {
  assert.equal(matches("", "anything"), true);
  assert.equal(matches("boun", "weekly", null, "bounced"), true);
  assert.equal(matches("zzz", "weekly", "schedule"), false);
  assert.equal(fmtIn(30_000), "in under a minute");
  assert.equal(fmtIn(5 * 60_000), "in 5m");
  assert.equal(fmtIn(3 * 3_600_000), "in 3h");
  assert.equal(fmtIn(3 * DAY), "in 3d");
});
