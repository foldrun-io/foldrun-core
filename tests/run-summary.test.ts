// A run records its status and its cost. `summary` is the third thing a
// person actually wants — what it concluded — pulled from the reply that
// already says it rather than from a schema the author has to fill in.
//
//   node --test tests/run-summary.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { runSummary, type RunRecord, type StepRecord } from "../packages/core/src/store.ts";

const step = (agent: string, result: string | null, status: StepRecord["status"] = "completed") =>
  ({ agent, instruction: "", group: 1, optional: false, attempts: 1, status, events: [], result }) as unknown as StepRecord;

const run = (steps: StepRecord[]): RunRecord => ({
  id: "run-test-0001",
  flow: "health",
  status: "completed",
  startedAt: "2026-09-07T19:00:00.000Z",
  finishedAt: "2026-09-07T19:04:00.000Z",
  steps,
});

test("takes the first line of the last step that produced a result", () => {
  const r = run([
    step("crawler", "1487 pages crawled, 31 answered 4xx."),
    step("reporter", "Three new canonical faults, all on service pages.\n\nDetail follows."),
  ]);
  assert.equal(runSummary(r), "Three new canonical faults, all on service pages.");
});

test("skips steps that produced nothing, so a silent last step is not the answer", () => {
  const r = run([
    step("crawler", "Crawl finished clean."),
    step("reporter", null, "skipped"),
  ]);
  assert.equal(runSummary(r), "Crawl finished clean.");
});

test("a run that produced nothing has no summary rather than an empty one", () => {
  assert.equal(runSummary(run([step("crawler", null, "failed")])), null);
  assert.equal(runSummary(run([])), null);
});

test("markdown decoration is stripped — this lands in an email subject", () => {
  assert.equal(
    runSummary(run([step("reporter", "## **Three** new canonical faults")])),
    "Three new canonical faults",
  );
  assert.equal(runSummary(run([step("reporter", "- 24 of 30 terms rank the wrong page")])), "24 of 30 terms rank the wrong page");
  assert.equal(runSummary(run([step("reporter", "> quoted headline")])), "quoted headline");
});

test("leading blank lines and headings alone do not become the summary", () => {
  const r = run([step("reporter", "\n\n#\n\nThe first real line.\nThe second.")]);
  assert.equal(runSummary(r), "The first real line.");
});

test("a long line is cut rather than shipped whole into a subject", () => {
  const long = "x".repeat(400);
  const s = runSummary(run([step("reporter", long)]));
  assert.ok(s && s.length <= 200, `expected <= 200 chars, got ${s?.length}`);
  assert.ok(s!.endsWith("…"), "a cut line says it was cut");
});

test("a failed run still summarises — whatever got furthest is the useful line", () => {
  const r = run([
    step("auditor", "Audited 120 URLs; 24 missing."),
    step("reporter", null, "failed"),
  ]);
  r.status = "failed";
  assert.equal(runSummary(r), "Audited 120 URLs; 24 missing.");
});
