// budget: is a number and a period. One grammar for four files; unset is no
// limit; the window follows the account's calendar; an agent's cap is per
// run and the tighter of two caps wins.
//
//   node --test tests/budget-grammar.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseBudget, budgetProblem, formatBudget, windowStartMs, windowName } from "../src/budget.ts";
import { stepCeilingFor } from "../src/step-exec.ts";

test("a bare number takes the file's default period; a period can be written four ways", () => {
  assert.deepEqual(parseBudget(60, "month"), { usd: 60, period: "month" });
  assert.deepEqual(parseBudget("60", "run"), { usd: 60, period: "run" });
  assert.deepEqual(parseBudget("60/day", "month"), { usd: 60, period: "day" });
  assert.deepEqual(parseBudget("60 / week", "month"), { usd: 60, period: "week" });
  assert.deepEqual(parseBudget("60 per month", "day"), { usd: 60, period: "month" });
  assert.deepEqual(parseBudget("$2.50 a day", "month"), { usd: 2.5, period: "day" });
  assert.deepEqual(parseBudget("60 daily", "month"), { usd: 60, period: "day" });
  assert.deepEqual(parseBudget("60/weekly", "month"), { usd: 60, period: "week" });
});

test("unset, unlimited and zero all mean no limit — the platform invents no default", () => {
  for (const raw of [undefined, null, "", "unlimited", "UNLIMITED", "none", "no limit", "off", 0, "0"]) {
    assert.equal(parseBudget(raw, "month"), null, `${String(raw)} is no cap`);
    assert.equal(budgetProblem(raw, ["day", "week", "month"]), null, `${String(raw)} is not a problem`);
  }
  assert.equal(parseBudget(-5, "month"), null, "a negative number caps nothing when running");
});

test("a value nobody can read is no cap when running, and a named problem when linting", () => {
  assert.equal(parseBudget("lots", "month"), null);
  assert.equal(parseBudget("60/fortnight", "month"), null);
  assert.equal(parseBudget({ usd: 5 }, "month"), null);
  assert.match(budgetProblem("lots", ["month"])!, /not a number/);
  assert.match(budgetProblem("60/fortnight", ["month"])!, /not a period/);
  assert.match(budgetProblem(-1, ["month"])!, /not an amount/);
});

test("a period the file cannot have is named, with where it belongs", () => {
  assert.match(budgetProblem("5/day", ["run"])!, /per run/);
  assert.match(budgetProblem("5/day", ["run"])!, /workspace's or the account's/);
  assert.equal(budgetProblem("5", ["run"]), null);
  assert.equal(budgetProblem("5/run", ["run"]), null, "saying run where run is the default is fine");
  assert.equal(budgetProblem("5/day", ["day", "week", "month"]), null);
  assert.match(budgetProblem("5/run", ["day", "week", "month"])!, /per run here already|does not apply/);
});

test("formatting reads back the way it was written", () => {
  assert.equal(formatBudget({ usd: 60, period: "day" }), "$60/day");
  assert.equal(formatBudget({ usd: 2.5, period: "month" }), "$2.50/month");
  assert.equal(windowName("day"), "today");
  assert.equal(windowName("week"), "this week");
  assert.equal(windowName("month"), "this month");
});

test("the window starts at local midnight in the account's calendar, not UTC's", () => {
  // 2026-09-09 08:00 UTC is 18:00 in Sydney (AEST, +10). Sydney's day began
  // at 2026-09-08T14:00Z; UTC's began at 2026-09-09T00:00Z.
  const now = new Date("2026-09-09T08:00:00Z");
  assert.equal(new Date(windowStartMs("day", "Australia/Sydney", now)!).toISOString(), "2026-09-08T14:00:00.000Z");
  assert.equal(new Date(windowStartMs("day", "UTC", now)!).toISOString(), "2026-09-09T00:00:00.000Z");
  // The week starts on Monday. 2026-09-09 is a Wednesday in both calendars.
  assert.equal(new Date(windowStartMs("week", "Australia/Sydney", now)!).toISOString(), "2026-09-06T14:00:00.000Z");
  assert.equal(new Date(windowStartMs("week", "UTC", now)!).toISOString(), "2026-09-07T00:00:00.000Z");
  // The month starts on the first.
  assert.equal(new Date(windowStartMs("month", "Australia/Sydney", now)!).toISOString(), "2026-08-31T14:00:00.000Z");
  assert.equal(new Date(windowStartMs("month", "America/New_York", now)!).toISOString(), "2026-09-01T04:00:00.000Z");
  // Per run has no window, and an unknown zone is UTC rather than a crash.
  assert.equal(windowStartMs("run", "UTC", now), null);
  assert.equal(new Date(windowStartMs("day", "Mars/Olympus", now)!).toISOString(), "2026-09-09T00:00:00.000Z");
});

test("late on a Sunday in Sydney is still Saturday's week in UTC — the calendars disagree, and the account's wins", () => {
  // 2026-09-13 is a Sunday. 23:30 Sydney = 13:30Z the same day, so both
  // calendars say Sunday; the week began Monday the 7th in each, at each
  // zone's own midnight.
  const now = new Date("2026-09-13T13:30:00Z");
  assert.equal(new Date(windowStartMs("week", "Australia/Sydney", now)!).toISOString(), "2026-09-06T14:00:00.000Z");
  // 2026-09-14 00:30 Sydney = 2026-09-13T14:30Z — Monday in Sydney (a fresh
  // week), still Sunday in UTC (the old one).
  const past = new Date("2026-09-13T14:30:00Z");
  assert.equal(new Date(windowStartMs("week", "Australia/Sydney", past)!).toISOString(), "2026-09-13T14:00:00.000Z");
  assert.equal(new Date(windowStartMs("week", "UTC", past)!).toISOString(), "2026-09-07T00:00:00.000Z");
});

test("an agent's per-run cap is the tighter of two, and the note names the line to raise", () => {
  // Flow share $3, agent has $10 and has spent $1: the flow's share is tighter.
  assert.deepEqual(stepCeilingFor(3, 10, 1, "writer"), { ceilingUsd: 3, note: "budget: in the flow file" });
  // Flow share $3, agent has $2.50 and has spent $1: $1.50 left is tighter.
  assert.deepEqual(stepCeilingFor(3, 2.5, 1, "writer"), { ceilingUsd: 1.5, note: "budget: on the writer agent" });
  // No flow budget at all: the agent's cap alone.
  assert.deepEqual(stepCeilingFor(null, 2.5, 1, "writer"), { ceilingUsd: 1.5, note: "budget: on the writer agent" });
  // The agent has spent its cap already in this run: nothing left.
  assert.deepEqual(stepCeilingFor(null, 2.5, 4, "writer"), { ceilingUsd: 0, note: "budget: on the writer agent" });
  // No agent cap: the flow's share, or nothing.
  assert.deepEqual(stepCeilingFor(3, null, 1, "writer"), { ceilingUsd: 3, note: "budget: in the flow file" });
  assert.deepEqual(stepCeilingFor(null, undefined, 1, "writer"), { ceilingUsd: null, note: "budget: in the flow file" });
});
