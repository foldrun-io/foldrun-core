// `?wait=true` — the difference between a job queue and an API you can call.
//
// Starting a run returns a receipt, which is right for a schedule and wrong
// for a caller putting an agent behind their own endpoint. These are the two
// pieces that turn one into the other: waiting for a verdict, and knowing
// which of a flow's steps holds the answer.
//
//   node --test tests/wait.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { waitForRun, runResult } from "../packages/core/src/runner.ts";

const HOUR = 60 * 60 * 1000;

function withRun(run: unknown, body: (ws: string) => Promise<void> | void) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-wait-"));
  const previous = process.env.FOLDRUN_DATA;
  const previousWs = process.env.FOLDRUN_WORKSPACE;
  process.env.FOLDRUN_DATA = root;
  delete process.env.FOLDRUN_WORKSPACE;
  const ws = path.join(root, "acme/workspaces/desk");
  fs.mkdirSync(path.join(ws, "runs"), { recursive: true });
  const write = (r: unknown) =>
    fs.writeFileSync(
      path.join(ws, "runs", `${(r as { id: string }).id}.json`),
      JSON.stringify(r, null, 2),
    );
  write(run);
  return Promise.resolve(body(ws)).finally(() => {
    if (previous === undefined) delete process.env.FOLDRUN_DATA;
    else process.env.FOLDRUN_DATA = previous;
    if (previousWs !== undefined) process.env.FOLDRUN_WORKSPACE = previousWs;
    fs.rmSync(root, { recursive: true, force: true });
  });
}

const step = (agent: string, status: string, result: string | null = null) => ({
  agent,
  instruction: "do it",
  group: 1,
  optional: false,
  status,
  events: [],
  result,
  costUsd: null,
});

const record = (over: Record<string, unknown> = {}) => ({
  id: "r1",
  flow: "publish",
  status: "running",
  startedAt: new Date(Date.now() - HOUR).toISOString(),
  finishedAt: null,
  steps: [step("writer", "running")],
  ...over,
});

test("a finished run is returned immediately", async () => {
  await withRun(record({ status: "completed", steps: [step("writer", "completed", "done")] }), async () => {
    const { run, timedOut } = await waitForRun("acme", "desk", "r1", 5_000);
    assert.equal(timedOut, false);
    assert.equal(run?.status, "completed");
  });
});

// The run is written by another process — a job the server started, or one
// this call started and did not keep a handle on. Waiting means watching the
// record, so a status written elsewhere has to be what ends the wait.
test("a run that finishes while we wait is picked up", async () => {
  await withRun(record(), async (ws) => {
    setTimeout(() => {
      fs.writeFileSync(
        path.join(ws, "runs/r1.json"),
        JSON.stringify(record({ status: "completed", steps: [step("writer", "completed", "late")] })),
      );
    }, 400);

    const started = Date.now();
    const { run, timedOut } = await waitForRun("acme", "desk", "r1", 10_000);
    assert.equal(timedOut, false);
    assert.equal(run?.status, "completed");
    assert.ok(Date.now() - started >= 300, "it should have actually waited");
  });
});

// Not finished, but not going anywhere either. A caller blocked on this would
// hang for as long as the approval window allows — up to a day.
test("waiting stops when a run needs a person", async () => {
  await withRun(record({ status: "awaiting-approval" }), async () => {
    const { run, timedOut } = await waitForRun("acme", "desk", "r1", 5_000);
    assert.equal(timedOut, false);
    assert.equal(run?.status, "awaiting-approval");
  });
});

// The run keeps going; only the waiting stops. The record is still on disk and
// still readable at /runs/{id}, which is what makes returning early safe.
test("a slow run times out without being disturbed", async () => {
  await withRun(record(), async (ws) => {
    const { run, timedOut } = await waitForRun("acme", "desk", "r1", 600);
    assert.equal(timedOut, true);
    assert.equal(run?.status, "running", "timing out must not rewrite the run");
    assert.equal(
      JSON.parse(fs.readFileSync(path.join(ws, "runs/r1.json"), "utf8")).status,
      "running",
    );
  });
});

test("waiting on a run that is not there says so rather than hanging", async () => {
  await withRun(record(), async () => {
    const { run } = await waitForRun("acme", "desk", "nope", 5_000);
    assert.equal(run, null);
  });
});

// ── which step holds the answer ──────────────────────────────────────────────

// A flow's last step is its conclusion, so the answer is read from the end.
test("the result is the last step that produced one", () => {
  const run = record({
    status: "completed",
    steps: [step("a", "completed", "first"), step("b", "completed", "final")],
  });
  assert.equal(runResult(run as never), "final");
});

// A `when:` that did not match, or an optional step that failed, leaves later
// steps empty — and returning null there would hide an answer the flow really
// did produce.
test("skipped and empty steps are stepped over", () => {
  const run = record({
    status: "completed",
    steps: [
      step("a", "completed", "the answer"),
      step("b", "skipped", null),
      step("c", "completed", "   "),
    ],
  });
  assert.equal(runResult(run as never), "the answer");
});

test("a run that produced nothing returns null, not an empty string", () => {
  const run = record({ status: "failed", steps: [step("a", "failed", null)] });
  assert.equal(runResult(run as never), null);
});
