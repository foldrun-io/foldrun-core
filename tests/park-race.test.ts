// A gate is approvable from the moment it is saved, and the driver keeps
// working for a moment after (storing files) before it stamps the park. A
// decision that lands in that window is on disk only; the driver's next
// save, from memory, would erase it. adoptDecisions is the merge that keeps it.

import test from "node:test";
import assert from "node:assert/strict";
import { adoptDecisions } from "../src/runner.ts";
import type { RunRecord, StepRecord } from "../src/store.ts";

const step = (status: StepRecord["status"], extra: Partial<StepRecord> = {}): StepRecord =>
  ({ agent: "a", instruction: "", group: 1, optional: false, status, events: [], result: null, costUsd: null, ...extra }) as StepRecord;
const run = (steps: StepRecord[]): RunRecord =>
  ({ id: "run-1", flow: "f", status: "awaiting-approval", startedAt: "", finishedAt: null, steps }) as RunRecord;

test("an approval that landed on disk during the park survives the driver's save", () => {
  const memory = run([step("completed"), step("awaiting-approval", { events: [{ t: "t0", type: "info", text: "waiting" }] })]);
  const disk = run([
    step("completed"),
    step("pending", { approvedAt: "2026-09-06T13:30:40.000Z", approvalNote: "GO", events: [{ t: "t0", type: "info", text: "waiting" }, { t: "t1", type: "info", text: "approved by a human — continuing" }] }),
  ]);
  assert.equal(adoptDecisions(memory, disk), true);
  assert.equal(memory.steps[1].status, "pending");
  assert.equal(memory.steps[1].approvedAt, "2026-09-06T13:30:40.000Z");
  assert.equal(memory.steps[1].approvalNote, "GO");
  assert.equal(memory.steps[1].events.length, 2);
});

test("a rejection that landed is kept too", () => {
  const memory = run([step("awaiting-approval")]);
  const disk = run([step("failed", { events: [{ t: "t1", type: "error", text: "rejected" }] })]);
  assert.equal(adoptDecisions(memory, disk), true);
  assert.equal(memory.steps[0].status, "failed");
});

test("nothing landed: memory is untouched and the caller does not enqueue", () => {
  const memory = run([step("completed", { events: [{ t: "t0", type: "info", text: "mine, newer" }] }), step("awaiting-approval")]);
  const disk = run([step("completed"), step("awaiting-approval")]);
  assert.equal(adoptDecisions(memory, disk), false);
  assert.equal(memory.steps[0].events.length, 1, "the driver's own steps are never overwritten from disk");
  assert.equal(adoptDecisions(memory, null), false);
});
