// FOL-54: one way to count outcomes, shared by every page, the API and the
// CLI. Completed = ran to the end without failing (whatever it found);
// the rate is over completed + failed, with stopped runs left out; what the
// runs found (BLOCKED, BAD, QUIET) is counted beside it.
//
//   node --test tests/outcome.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { outcomeOf, tally, isCompleted, isFinished, needsAttention, needsAction } from "../src/outcome.ts";

test("status and verdict read together into one outcome", () => {
  assert.equal(outcomeOf("completed", "BLOCKED"), "blocked");
  assert.equal(outcomeOf("completed", null), "done");
  assert.equal(outcomeOf("failed", "GOOD"), "failed");
  assert.equal(outcomeOf("stopped", null), "stopped");
  assert.equal(outcomeOf("awaiting-approval", null), "waiting");
});

test("the tally: stopped and live runs are not in the rate; findings are counted beside it", () => {
  const t = tally(["good", "done", "quiet", "blocked", "bad", "failed", "stopped", "running", "waiting"]);
  assert.deepEqual(
    { runs: t.runs, live: t.live, waiting: t.waiting, stopped: t.stopped, finished: t.finished, completed: t.completed, failed: t.failed, ok: t.ok, quiet: t.quiet, blocked: t.blocked, bad: t.bad },
    { runs: 9, live: 2, waiting: 1, stopped: 1, finished: 6, completed: 5, failed: 1, ok: 2, quiet: 1, blocked: 1, bad: 1 },
  );
  assert.equal(t.completedPct, 83, "5 of 6: a BLOCKED or BAD run still ran to the end");
  assert.equal(tally(["stopped", "running"]).completedPct, null, "nothing finished, no rate");
  assert.ok(isCompleted("bad") && !isFinished("stopped"));
});

test("a run waiting on a person needs action, though it has not gone wrong", () => {
  const waiting = outcomeOf("awaiting-approval", null);
  assert.equal(needsAttention(waiting), false);
  assert.equal(needsAction(waiting), true);
  assert.equal(needsAction("good"), false);
  assert.equal(needsAction("blocked"), true);
});
