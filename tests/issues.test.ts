// FOL-54 step 3: an issue stays open until a person closes it; a later good
// run says "fine since" but closes nothing; a failure after a resolve opens
// it again; platform causes are one issue across desks.
//
//   node --test tests/issues.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { foldIssues, applyIssueAction, issueKeyOf, snoozeMs, isActiveIssue, platformCause, issueDoctor, type IssueRun } from "../src/issues.ts";

test("issueDoctor: the newest run, its workspace, and the run page's question; nothing for a missed schedule", () => {
  const runs = [{ workspace: "rank-desk", id: "run-new", at: "2026-10-19" }, { workspace: "rank-desk", id: "run-old", at: "2026-10-18" }];
  assert.deepEqual(issueDoctor({ kind: "failed", runs }), { workspace: "rank-desk", runId: "run-new", prompt: "Doctor: why did run run-new fail, and how do I fix it?" });
  assert.equal(issueDoctor({ kind: "blocked", runs })!.prompt, "Doctor: why did run run-new end BLOCKED, and how do I fix it?");
  assert.equal(issueDoctor({ kind: "bad", runs })!.prompt, "Doctor: why did run run-new end BAD, and how do I fix it?");
  // A platform cause spans desks: the newest run names the one to read.
  assert.equal(issueDoctor({ kind: "platform", runs: [{ workspace: "gbp-desk", id: "run-p", at: "2026-10-19" }, ...runs] })!.workspace, "gbp-desk");
  assert.equal(issueDoctor({ kind: "missed", runs: [{ workspace: "rank-desk", id: "miss-1", at: "2026-10-19", missed: true }] }), null);
  assert.equal(issueDoctor({ kind: "failed", runs: [] }), null);
});

const NOW = Date.parse("2026-10-19T12:00:00Z");
const at = (h: number) => new Date(NOW - h * 3_600_000).toISOString();
const run = (p: Partial<IssueRun>): IssueRun => ({ workspace: "blog", id: `r${Math.random()}`, what: "daily", outcome: "good", startedAt: at(1), ...p });
const fail = (h: number, agent = "writer", reason = "exit 1", ws = "blog") => run({ startedAt: at(h), outcome: "failed", failure: { agent, reason }, workspace: ws });

test("the same flow failing at the same agent is one issue, counted, first and last seen", () => {
  const [i, ...rest] = foldIssues([fail(30), fail(5), fail(2, "editor")], {}, NOW);
  assert.equal(rest.length, 1, "a failure at another agent is its own issue");
  const writer = [i, ...rest].find((x) => x.agent === "writer")!;
  assert.equal(writer.count, 2);
  assert.equal(writer.firstSeen, at(30));
  assert.equal(writer.lastSeen, at(5));
  const slow = run({ startedAt: at(4), finishedAt: at(1), outcome: "failed", failure: { agent: "writer", reason: "slow one" } });
  const quick = run({ startedAt: at(3), finishedAt: at(2), outcome: "failed", failure: { agent: "writer", reason: "quick one" } });
  const [o] = foldIssues([slow, quick], {}, NOW);
  assert.equal(o.reason, "writer: slow one", "of two overlapping failures, the one that ended last (Codex review)");
  assert.equal(o.lastSeen, at(1));
  assert.equal(writer.status, "open");
});

test("a later good run shows 'fine since' and closes nothing — older than a day is still there", () => {
  const [i] = foldIssues([fail(50), run({ startedAt: at(1) })], {}, NOW);
  assert.equal(i.status, "open");
  assert.equal(i.recoveredAt, at(1));
});

test("resolve closes it; a failure after the resolve opens it again, counting only the new ones", () => {
  const id = issueKeyOf(fail(10))!.id;
  const state = applyIssueAction(null, { at: at(8), by: "a@x", action: "resolve" }, NOW);
  assert.equal(foldIssues([fail(10)], { [id]: state }, NOW)[0].status, "resolved");
  const [again] = foldIssues([fail(10), fail(3)], { [id]: state }, NOW);
  assert.equal(again.status, "open");
  assert.equal(again.count, 1);
  assert.equal(again.resolved, null);
  assert.equal(again.history.length, 1, "the history says it was resolved before");
});

test("acknowledge and snooze; a snooze that ran out is open again; a snooze in the past is refused", () => {
  const id = issueKeyOf(fail(10))!.id;
  let s = applyIssueAction(null, { at: at(9), by: "a@x", action: "acknowledge" }, NOW);
  let [i] = foldIssues([fail(10)], { [id]: s }, NOW);
  assert.equal(i.status, "acknowledged");
  assert.ok(isActiveIssue(i));
  s = applyIssueAction(s, { at: at(8), by: "a@x", action: "snooze", until: at(-2) }, NOW);
  [i] = foldIssues([fail(10)], { [id]: s }, NOW);
  assert.equal(i.status, "snoozed");
  assert.ok(!isActiveIssue(i));
  [i] = foldIssues([fail(10)], { [id]: s }, NOW + 3 * 3_600_000);
  assert.equal(i.status, "acknowledged", "the snooze ran out");
  assert.throws(() => applyIssueAction(s, { at: at(0), by: "a@x", action: "snooze", until: at(1) }, NOW), /future/);
});

test("a platform cause is one issue across desks, with its fix", () => {
  const issues = foldIssues([fail(3, "a", "pod never became ready", "blog"), fail(2, "b", "pod never became ready", "seo")], {}, NOW);
  assert.equal(issues.length, 1);
  assert.equal(issues[0].kind, "platform");
  assert.deepEqual(issues[0].workspaces, ["blog", "seo"]);
  assert.match(issues[0].action, /^Fix the runner image/);
});

test("BLOCKED and BAD are issues; stopped, waiting and good runs are not", () => {
  const issues = foldIssues([run({ outcome: "blocked", headline: "BLOCKED: no login" }), run({ outcome: "bad" }), run({ outcome: "stopped" }), run({ outcome: "waiting" })], {}, NOW);
  assert.deepEqual(issues.map((i) => i.kind).sort(), ["bad", "blocked"]);
  assert.equal(issues.find((i) => i.kind === "blocked")!.reason, "BLOCKED: no login");
});

test("snooze lengths", () => {
  assert.equal(snoozeMs("1d"), 86_400_000);
  assert.equal(snoozeMs("30m"), 1_800_000);
  assert.equal(snoozeMs("soon"), null);
  assert.equal(snoozeMs("0h"), null);
});

test("a run that started before the resolve and failed after it opens the issue again (Codex review)", () => {
  const first = fail(10);
  const id = issueKeyOf(first)!.id;
  const state = applyIssueAction(null, { at: at(5), by: "a@x", action: "resolve" }, NOW);
  const late = run({ startedAt: at(6), finishedAt: at(4), outcome: "failed", failure: { agent: "writer", reason: "exit 1" } });
  const [i] = foldIssues([first, late], { [id]: state }, NOW);
  assert.equal(i.status, "open");
  assert.equal(i.count, 1);
});

test("'fine since' only when the flow's newest finished run is fine (Codex review)", () => {
  const issues = foldIssues([fail(10, "a"), run({ startedAt: at(8) }), fail(2, "b")], {}, NOW);
  assert.ok(issues.every((i) => i.recoveredAt === null), "a success between two failures is not a recovery");
});

test("a long history keeps the acts the state is read from (Codex review)", () => {
  const first = fail(300);
  const id = issueKeyOf(first)!.id;
  let s = applyIssueAction(null, { at: at(299), by: "a@x", action: "acknowledge" }, NOW);
  for (let k = 0; k < 120; k++) s = applyIssueAction(s, { at: at(298 - k), by: "a@x", action: "snooze", until: at(297 - k) }, NOW - 400 * 3_600_000);
  assert.ok(s.history.length <= 101);
  assert.ok(s.history.some((e) => e.action === "acknowledge"));
  assert.equal(foldIssues([first], { [id]: s }, NOW)[0].status, "acknowledged", "the snoozes ran out; it is still acknowledged");
});

test("overlapping runs: a success that finished before a later failure finished is not a recovery (Codex review)", () => {
  const slowFail = run({ startedAt: at(4), finishedAt: at(1), outcome: "failed", failure: { agent: "writer", reason: "exit 1" } });
  const quickOk = run({ startedAt: at(3), finishedAt: at(2) });
  assert.equal(foldIssues([slowFail, quickOk], {}, NOW)[0].recoveredAt, null);
  const later = run({ startedAt: at(0.5), finishedAt: at(0.2) });
  assert.equal(foldIssues([slowFail, quickOk, later], {}, NOW)[0].recoveredAt, at(0.2));
});

test("resolving a recurring issue again shows the episode it closed, not every run ever (Codex review)", () => {
  const a = fail(20), b = fail(5);
  const id = issueKeyOf(a)!.id;
  let st = applyIssueAction(null, { at: at(10), by: "x", action: "resolve" }, NOW);
  st = applyIssueAction(st, { at: at(1), by: "x", action: "resolve" }, NOW);
  const [i] = foldIssues([a, b], { [id]: st }, NOW);
  assert.equal(i.status, "resolved");
  assert.equal(i.count, 1);
  assert.equal(i.firstSeen, at(5));
});

test("the refusals the runner knows are one platform issue, not a desk's (Codex review)", () => {
  for (const r of ["Failed to authenticate: OAuth token revoked", "OAuth access token has been revoked", "API Error: 401 {\"type\":\"error\"}", "OAuth token has expired", "authentication_error"]) {
    assert.equal(platformCause(r)?.key, "model-auth", r);
  }
  assert.equal(platformCause("writer: exit 1"), null);
});

test("trimming keeps the resolve before the last, so a resolved issue still shows only its episode (Codex review)", () => {
  const a = fail(300), b = fail(200);
  const id = issueKeyOf(a)!.id;
  let st = applyIssueAction(null, { at: at(250), by: "x", action: "resolve" }, NOW);
  st = applyIssueAction(st, { at: at(150), by: "x", action: "resolve" }, NOW);
  for (let k = 0; k < 120; k++) st = applyIssueAction(st, { at: at(140 - k), by: "x", action: "snooze", until: at(139 - k) }, NOW - 400 * 3_600_000);
  const [i] = foldIssues([a, b], { [id]: st }, NOW);
  assert.equal(i.status, "resolved");
  assert.equal(i.count, 1);
});

test("reopening by hand brings back the episode it closed, not every one before it (Codex review)", () => {
  const a = fail(20), b = fail(5);
  const id = issueKeyOf(a)!.id;
  let st = applyIssueAction(null, { at: at(10), by: "x", action: "resolve" }, NOW);
  st = applyIssueAction(st, { at: at(2), by: "x", action: "resolve" }, NOW);
  st = applyIssueAction(st, { at: at(1), by: "x", action: "reopen" }, NOW);
  const [i] = foldIssues([a, b], { [id]: st }, NOW);
  assert.equal(i.status, "open");
  assert.equal(i.count, 1);
  assert.equal(i.firstSeen, at(5));
});

test("resolve, reopen, resolve with nothing new closes the same episode; it can be reopened again (Codex review)", () => {
  const a = fail(20);
  const id = issueKeyOf(a)!.id;
  let st = applyIssueAction(null, { at: at(10), by: "x", action: "resolve" }, NOW);
  st = applyIssueAction(st, { at: at(9), by: "x", action: "reopen" }, NOW);
  st = applyIssueAction(st, { at: at(8), by: "x", action: "resolve" }, NOW);
  let [i] = foldIssues([a], { [id]: st }, NOW);
  assert.equal(i?.status, "resolved");
  assert.equal(i.count, 1);
  st = applyIssueAction(st, { at: at(7), by: "x", action: "reopen" }, NOW);
  [i] = foldIssues([a], { [id]: st }, NOW);
  assert.equal(i?.status, "open");
  assert.equal(i.count, 1);
});

test("resolve, reopen, a new failure, resolve: the episode it closes holds both failures (Codex review)", () => {
  const a = fail(20), b = fail(5);
  const id = issueKeyOf(a)!.id;
  let st = applyIssueAction(null, { at: at(10), by: "x", action: "resolve" }, NOW);
  st = applyIssueAction(st, { at: at(9), by: "x", action: "reopen" }, NOW);
  st = applyIssueAction(st, { at: at(2), by: "x", action: "resolve" }, NOW);
  let [i] = foldIssues([a, b], { [id]: st }, NOW);
  assert.equal(i.status, "resolved");
  assert.equal(i.count, 2);
  assert.equal(i.firstSeen, at(20));
  st = applyIssueAction(st, { at: at(1), by: "x", action: "reopen" }, NOW);
  [i] = foldIssues([a, b], { [id]: st }, NOW);
  assert.equal(i.status, "open");
  assert.equal(i.count, 2);
});

test("the provider being overloaded is its own cause, not the usage cap (Codex review)", () => {
  assert.equal(platformCause('API Error: 529 {"type":"error","error":{"type":"overloaded_error"}}')?.key, "model-busy");
  assert.equal(platformCause("You've reached your weekly limit")?.key, "model-cap");
});

test("the runner's own sentence for a spent subscription window is the usage cap (23 Oct 2026)", () => {
  const spent = "the subscription at api.anthropic.com refused this burst — the 7-day window is 100% used but overage is off (org level disabled); it resets at 16:00 Sydney on Sun 25 Oct";
  assert.equal(platformCause(spent)?.key, "model-cap");
  assert.equal(platformCause("the subscription refused this burst — the 5-hour window is spent")?.key, "model-cap");
  assert.equal(platformCause("the subscription refused this burst — the 5-hour window is 62% used but overage is off"), null, "room left is not the cap");
});

// ---------------------------------------------------------------- FOL-72 step 7

test("a resolved issue that comes back is regressed, since the revision it came back on", () => {
  const a = fail(20), b = { ...fail(5), revision: "r-new" };
  const id = issueKeyOf(a)!.id;
  const st = applyIssueAction(null, { at: at(10), by: "x", action: "resolve" }, NOW);
  const [i] = foldIssues([a, b], { [id]: st }, NOW);
  assert.equal(i.regressed, true);
  assert.equal(i.sinceRevision, "r-new");
  const [first] = foldIssues([a], {}, NOW);
  assert.equal(first.regressed, false);
});

test("snooze until it happens N more times; then it is back", () => {
  const a = fail(20);
  const id = issueKeyOf(a)!.id;
  const st = applyIssueAction(null, { at: at(15), by: "x", action: "snooze", untilCount: 2 }, NOW);
  let [i] = foldIssues([a, fail(10)], { [id]: st }, NOW);
  assert.equal(i.status, "snoozed");
  assert.equal(i.snoozedFor, 1);
  [i] = foldIssues([a, fail(10), fail(5)], { [id]: st }, NOW);
  assert.equal(i.status, "open", "the second one since the snooze ends it");
  assert.throws(() => applyIssueAction(null, { at: at(1), by: "x", action: "snooze" }, NOW), /number of times/);
});

test("issues: auto-close — a later good run closes it, a failure after that opens a fresh one; platform causes never auto-close", () => {
  const a = fail(20);
  const fineRun = run({ startedAt: at(10) });
  const auto = { autoClose: () => true };
  let [i] = foldIssues([a, fineRun], {}, NOW, auto);
  assert.equal(i.status, "resolved");
  assert.equal(i.resolved?.by, "auto: a later run went fine");
  [i] = foldIssues([a, fineRun, fail(5)], {}, NOW, auto);
  assert.equal(i.status, "open");
  assert.equal(i.count, 1);
  assert.equal(i.regressed, true);
  assert.equal(foldIssues([a, fineRun], {}, NOW)[0].status, "open", "without the flow saying so, it stays open");
  const sandbox = fail(20, "a", "pod never became ready");
  assert.equal(foldIssues([sandbox, fineRun], {}, NOW, auto)[0].status, "open");
});

test("a missed schedule is its own issue per flow, counted, with no run to open", () => {
  const miss = (h: number) => ({ workspace: "blog", id: `missed-${at(h)}`, what: "daily", outcome: "failed" as const, startedAt: at(h), missed: true, headline: `due ${at(h).slice(11, 16)} UTC, no run started` });
  const issues = foldIssues([miss(48), miss(24), fail(3)], {}, NOW);
  const missed = issues.find((i) => i.kind === "missed")!;
  assert.equal(missed.count, 2);
  assert.ok(missed.runs.every((r) => r.missed));
  assert.match(missed.reason, /^due \d\d:\d\d UTC, no run started$/);
  assert.match(missed.action, /did not start/);
  assert.equal(issues.filter((i) => i.kind === "failed").length, 1, "a failure of the same flow stays its own issue");
});

test("an auto-close resets an earlier acknowledge or snooze: a recurrence is open again (Codex review)", () => {
  const a = fail(20);
  const id = issueKeyOf(a)!.id;
  const st = applyIssueAction(null, { at: at(15), by: "x", action: "acknowledge" }, NOW);
  const [i] = foldIssues([a, run({ startedAt: at(10) }), fail(5)], { [id]: st }, NOW, { autoClose: () => true });
  assert.equal(i.status, "open");
  assert.equal(i.acknowledged, null);
});
