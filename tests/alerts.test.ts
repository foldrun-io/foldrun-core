// FOL-72 step 7: `alerts:` thresholds — read, refused when unreadable, and
// what crosses them.
//
//   node --test tests/alerts.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseAlerts, evaluateAlerts } from "../src/alerts.ts";

const NOW = Date.parse("2026-10-19T12:00:00.000Z");

test("read: percent or fraction, numbers as numbers or text; problems in words", () => {
  assert.deepEqual(parseAlerts({ failure_rate: "30%", credits_day: 2000, run_minutes: "45" }).config, { minRuns: 5, failureRate: 0.3, creditsDay: 2000, runMinutes: 45 });
  assert.equal(parseAlerts({ failure_rate: 0.5 }).config?.failureRate, 0.5);
  assert.equal(parseAlerts(undefined).config, null);
  const bad = parseAlerts({ failure_rate: "lots", credits: 5, run_minutes: 0 });
  assert.equal(bad.config, null);
  assert.equal(bad.problems.length, 3);
  assert.match(bad.problems.join("\n"), /credits — not a threshold/);
  assert.match(parseAlerts("30%").problems[0]!, /is a block/);
});

test("failure rate over enough runs, credits in a day, and each slow run", () => {
  const cfg = parseAlerts({ failure_rate: "30%", credits_day: 1000, run_minutes: 30 }).config!;
  const alerts = evaluateAlerts(
    cfg,
    {
      outcomes: ["failed", "failed", "good", "done", "blocked", "running", "stopped"],
      chargedUsd: 12.5,
      live: [{ id: "r1", flow: "daily", startedAt: new Date(NOW - 40 * 60_000).toISOString() }, { id: "r2", flow: "daily", startedAt: new Date(NOW - 5 * 60_000).toISOString() }],
    },
    "blog",
    NOW,
  );
  assert.deepEqual(alerts.map((a) => a.key), ["failure_rate", "credits_day", "run_minutes/r1"]);
  assert.match(alerts[0]!.headline, /2 of its last 5 runs failed/, "stopped and live runs are not finished");
  assert.match(alerts[1]!.headline, /1,250 credits/);
  assert.deepEqual(evaluateAlerts(cfg, { outcomes: ["failed", "failed", "good"], chargedUsd: 0, live: [] }, "blog", NOW), [], "under min_runs, no rate alert");
});

test("stale_days: an agent idle past it, counted from its last run or, never run, from its file", () => {
  const now = Date.parse("2026-10-21T00:00:00Z");
  const { config } = parseAlerts({ stale_days: 30 });
  assert.equal(config?.staleDays, 30, "stale_days alone is a config");
  const alerts = evaluateAlerts(config!, {
    outcomes: [], chargedUsd: 0, live: [],
    agents: [
      { name: "busy", lastRunAt: "2026-10-20T09:00:00Z", since: "2026-01-01T00:00:00Z" },
      { name: "idle", lastRunAt: "2026-08-01T09:00:00Z", since: "2026-01-01T00:00:00Z" },
      { name: "new", lastRunAt: null, since: "2026-10-15T00:00:00Z" },
      { name: "forgotten", lastRunAt: null, since: "2026-06-01T00:00:00Z" },
    ],
  }, "desk", now);
  assert.deepEqual(alerts.map((a) => a.key), ["stale_days/idle/2026-08-01T09:00:00Z", "stale_days/forgotten/never"]);
  assert.ok(alerts.every((a) => a.once));
  assert.match(alerts[0].headline, /agent idle has not run in 80 days/);
  assert.match(parseAlerts({ stale_days: 0 }).problems.join(), /stale_days 0 — a number, at least 1/);
});

test("cost_spike: a run far above its flow's week; runs_per_hour: a flow started too often", () => {
  const now = Date.parse("2026-10-21T12:00:00Z");
  const at = (h: number) => new Date(now - h * 3_600_000).toISOString();
  const run = (id: string, flow: string, h: number, costUsd: number) => ({ id, flow, startedAt: at(h + 0.1), finishedAt: at(h), costUsd });
  const { config } = parseAlerts({ cost_spike: 3, runs_per_hour: 4 });
  const runs = [
    run("a", "daily", 72, 1), run("b", "daily", 48, 1.2), run("c", "daily", 24.5, 0.8),
    run("d", "daily", 2, 3.5),                       // 3.5× the average of 1.0
    run("e", "daily", 1, 1.1),                       // ordinary
    ...[0.1, 0.2, 0.3, 0.4].map((h, i) => run(`h${i}`, "hook", h, 0)),
  ];
  const keys = evaluateAlerts(config!, { outcomes: [], chargedUsd: 0, live: [], runs }, "desk", now).map((a) => a.key);
  assert.deepEqual(keys, ["cost_spike/d", "runs_per_hour/hook"]);
  const few = evaluateAlerts(config!, { outcomes: [], chargedUsd: 0, live: [], runs: [run("x", "new", 3, 1), run("y", "new", 1, 9)] }, "desk", now);
  assert.deepEqual(few.map((a) => a.key), [], "too few earlier runs to call anything a spike");
  assert.match(parseAlerts({ cost_spike: 1 }).problems.join(), /cost_spike 1 — a number, at least 1.5/);
});

test("new_host: true is a config on its own; anything but a boolean is a problem", () => {
  assert.equal(parseAlerts({ new_host: true }).config?.newHost, true);
  assert.equal(parseAlerts({ new_host: false }).config, null);
  assert.match(parseAlerts({ new_host: "yes" }).problems.join(), /new_host yes — true or false/);
});
