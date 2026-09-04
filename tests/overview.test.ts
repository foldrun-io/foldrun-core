// The account overview's numbers: one card per workspace, the usage window,
// the alerts — from run records alone.

import test from "node:test";
import assert from "node:assert/strict";
import { buildCards, filterCards, usageWindow, alertsFor, lastRunOf, fmtCount, fmtSecs, fmtMoney } from "../web/components/overview-model.ts";
import type { RunRecord, StepRecord, WorkspaceSummary } from "../packages/core/src/store.ts";

const NOW = Date.parse("2026-09-04T00:00:00Z");
const DAY = 24 * 60 * 60 * 1000;
const at = (daysAgo: number) => new Date(NOW - daysAgo * DAY).toISOString();

const step = (over: Partial<StepRecord>): StepRecord => ({
  agent: "writer", instruction: "", group: 1, optional: false, status: "completed", events: [], result: null, costUsd: null, ...over,
});
const run = (over: Partial<RunRecord> & { workspace?: string }): RunRecord & { workspace: string } => ({
  id: "r", flow: "weekly", status: "completed", startedAt: at(0), finishedAt: null, steps: [], workspace: "ws", ...over,
});
const ws = (name: string, over: Partial<WorkspaceSummary> = {}): WorkspaceSummary => ({
  name, description: "", agents: 1, flows: 1, deployedAt: at(1), runCount: 0, ...over,
});

test("a card carries its newest run, the window's runs and spend, and what is live", () => {
  const cards = buildCards(
    [ws("a"), ws("b")],
    [
      run({ id: "old", workspace: "a", startedAt: at(40), steps: [step({ costUsd: 9 })] }),
      run({ id: "new", workspace: "a", startedAt: at(1), status: "failed", stopRequested: true, summary: "  stopped early ", steps: [step({ costUsd: 1 })] }),
      run({ id: "live", workspace: "a", startedAt: at(0), status: "running" }),
    ],
    NOW,
  );
  const a = cards.find((c) => c.name === "a")!;
  assert.equal(a.lastRun?.id, "live");
  assert.equal(a.runsInWindow, 2);
  assert.equal(a.spendInWindow, 1);
  assert.equal(a.live, 1);
  assert.equal(cards.find((c) => c.name === "b")!.lastRun, null);
});

test("the last run reads as stopped, with a trimmed headline", () => {
  const last = lastRunOf([run({ status: "failed", stopRequested: true, summary: " done \n" })]);
  assert.equal(last?.status, "stopped");
  assert.equal(last?.headline, "done");
});

test("search matches name, description, last headline and flow; sort orders as asked", () => {
  const cards = buildCards(
    [ws("seo", { description: "search desk" }), ws("leads"), ws("quiet")],
    [
      run({ workspace: "seo", startedAt: at(2), steps: [step({ costUsd: 5 })] }),
      run({ workspace: "leads", startedAt: at(1), flow: "nightly", summary: "89 verified", steps: [step({ costUsd: 1 })] }),
    ],
    NOW,
  );
  assert.deepEqual(filterCards(cards, "verified", "activity").map((c) => c.name), ["leads"]);
  assert.deepEqual(filterCards(cards, "search", "activity").map((c) => c.name), ["seo"]);
  assert.deepEqual(filterCards(cards, "nightly", "activity").map((c) => c.name), ["leads"]);
  assert.deepEqual(filterCards(cards, "", "activity").map((c) => c.name), ["leads", "seo", "quiet"]);
  assert.deepEqual(filterCards(cards, "", "name").map((c) => c.name), ["leads", "quiet", "seo"]);
  assert.deepEqual(filterCards(cards, "", "spend").map((c) => c.name), ["seo", "leads", "quiet"]);
});

test("the usage window sums its days only, skips carried steps, counts failures by display status", () => {
  const u = usageWindow(
    [
      run({ startedAt: at(45), steps: [step({ costUsd: 100 })] }),
      run({ startedAt: at(3), status: "failed", steps: [step({ costUsd: 1, tokens: { input: 1000, output: 200 }, computeSecs: 30 })] }),
      run({ startedAt: at(1), status: "failed", stopRequested: true, steps: [step({ costUsd: 2, carriedFrom: "x" }), step({ costUsd: 3, computeSecs: 10 })] }),
    ],
    NOW,
  );
  assert.deepEqual(u, { runs: 2, failed: 1, spendUsd: 4, inputTokens: 1000, outputTokens: 200, computeSecs: 40 });
});

test("alerts: worst first, wallet only when billing is enforced, none means all clear", () => {
  const none = alertsFor({ approvals: 0, failedInDay: 0, balanceUsd: null, warnBelowUsd: 20, daysLeft: null, nearCap: [], qs: "" });
  assert.deepEqual(none, []);
  const some = alertsFor({
    approvals: 2, failedInDay: 1, balanceUsd: 5, warnBelowUsd: 20, daysLeft: 3,
    nearCap: [{ workspace: "leads", spent: 95, budget: 100 }], qs: "tenant=acme",
  });
  assert.deepEqual(some.map((a) => a.level), ["error", "warn", "warn", "warn"]);
  assert.ok(some[0].text.includes("failed"));
  assert.ok(some.every((a) => a.href.includes("tenant=acme")));
  const empty = alertsFor({ approvals: 0, failedInDay: 0, balanceUsd: 0, warnBelowUsd: 20, daysLeft: 0, nearCap: [], qs: "" });
  assert.equal(empty[0].level, "error");
});

test("the words", () => {
  assert.equal(fmtCount(950), "950");
  assert.equal(fmtCount(1500), "1.5k");
  assert.equal(fmtCount(120_000), "120k");
  assert.equal(fmtSecs(45), "45s");
  assert.equal(fmtSecs(600), "10m");
  assert.equal(fmtSecs(5400), "1.5h");
  assert.equal(fmtMoney(0), "$0");
  assert.equal(fmtMoney(12.345), "$12.35");
});
