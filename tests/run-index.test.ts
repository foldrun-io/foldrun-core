// The run index: what a list needs, kept beside the records, repaired from
// the directory whenever it is missing or stale.
//
// listAllRuns parsed every run file of every workspace on every call, and
// the dashboard calls it every twenty seconds per open tab. The index holds
// one row per run — id, flow, status, summary, times, each step's agent,
// status, cost and last error — and never a reply or a trace.
//
//   node --test tests/run-index.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  writeRun,
  deleteRun,
  listRuns,
  listRunSummaries,
  listAllRuns,
  listAllRunSummaries,
  listWorkspaces,
  runFailure,
  runCost,
  runFilePath,
  workspaceDir,
  type RunRecord,
} from "../src/store.ts";

function withWorkspace(body: (tenant: string, ws: string) => void) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-runindex-"));
  const prev = process.env.FOLDRUN_DATA;
  process.env.FOLDRUN_DATA = root;
  try {
    fs.mkdirSync(path.join(root, "acme/workspaces/desk/runs"), { recursive: true });
    fs.writeFileSync(path.join(root, "acme/workspaces/desk/AGENTS.md"), "---\nname: desk\n---\n");
    body("acme", "desk");
  } finally {
    if (prev === undefined) delete process.env.FOLDRUN_DATA;
    else process.env.FOLDRUN_DATA = prev;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const run = (id: string, at: string, extra: Partial<RunRecord> = {}): RunRecord => ({
  id,
  flow: "publish",
  status: "completed",
  startedAt: at,
  finishedAt: at,
  summary: `${id} did its thing`,
  steps: [
    {
      agent: "writer", instruction: "write the long article about everything", group: 1, optional: false,
      status: "completed", events: [{ t: at, type: "tool", text: "Write" }, { t: at, type: "text", text: "a long reply" }],
      result: "a very long reply that no list should have to carry", conclusion: "done", costUsd: 0.25,
      tokens: { input: 1000, output: 100 }, computeSecs: 12,
    },
  ],
  ...extra,
});

test("rows are written with the record, and a list reads rows not records", () =>
  withWorkspace((t, w) => {
    writeRun(t, w, run("r1", "2026-09-15T01:00:00Z"));
    writeRun(t, w, run("r2", "2026-09-15T02:00:00Z"));
    // First read builds the index; the file is beside the records.
    const rows = listRunSummaries(t, w);
    assert.deepEqual(rows.map((r) => r.id), ["r2", "r1"], "newest first");
    const file = path.join(workspaceDir(t, w), "runs", ".index.json");
    assert.ok(fs.existsSync(file));
    const raw = fs.readFileSync(file, "utf8");
    assert.ok(!raw.includes("a very long reply"), "no reply in the index");
    assert.ok(!raw.includes("write the long article"), "no instruction either");
    assert.equal(rows[0].steps[0].costUsd, 0.25);
    assert.deepEqual(rows[0].steps[0].tokens, { input: 1000, output: 100 });
    assert.equal(rows[0].summary, "r2 did its thing");
    // A later write updates its row through writeRun, no full scan needed.
    writeRun(t, w, run("r3", "2026-09-15T03:00:00Z", { status: "failed", steps: [{ ...run("x", "").steps[0], status: "failed", events: [{ t: "", type: "error", text: "boom" }] }] }));
    const after = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.equal(after.runs.r3.status, "failed");
    assert.equal(after.runs.r3.steps[0].error, "boom", "a failed step's last error rides the row");
    assert.equal(listRuns(t, w).length, 3, "listRuns never mistakes the index for a run");
    assert.equal(listWorkspaces(t)[0].runCount, 3, "nor does the workspace's run count");
  }));

test("the index is never trusted over the directory: foreign writes, deletions and edits are seen", () =>
  withWorkspace((t, w) => {
    writeRun(t, w, run("r1", "2026-09-15T01:00:00Z"));
    assert.equal(listRunSummaries(t, w).length, 1);
    // Another process (or a restore) drops a record in without writeRun.
    fs.writeFileSync(runFilePath(t, w, "r9"), JSON.stringify(run("r9", "2026-09-15T09:00:00Z")));
    assert.deepEqual(listRunSummaries(t, w).map((r) => r.id), ["r9", "r1"]);
    // ...edits one behind our back, with a moved mtime.
    const edited = run("r1", "2026-09-15T01:00:00Z", { status: "failed", summary: "edited elsewhere" });
    fs.writeFileSync(runFilePath(t, w, "r1"), JSON.stringify(edited));
    const later = new Date(Date.now() + 5000);
    fs.utimesSync(runFilePath(t, w, "r1"), later, later);
    assert.equal(listRunSummaries(t, w).find((r) => r.id === "r1")?.summary, "edited elsewhere");
    // ...and removes one by hand.
    fs.rmSync(runFilePath(t, w, "r9"));
    assert.deepEqual(listRunSummaries(t, w).map((r) => r.id), ["r1"]);
    // deleteRun keeps the index straight itself.
    deleteRun(t, w, "r1");
    assert.deepEqual(listRunSummaries(t, w), []);
    // A corrupt index is a full scan, not an error.
    writeRun(t, w, run("r2", "2026-09-15T02:00:00Z"));
    fs.writeFileSync(path.join(workspaceDir(t, w), "runs", ".index.json"), "{not json");
    assert.deepEqual(listRunSummaries(t, w).map((r) => r.id), ["r2"]);
  }));

test("listAllRuns: a finished run is the row's shape, a live one is read whole", () =>
  withWorkspace((t, w) => {
    writeRun(t, w, run("done", "2026-09-15T01:00:00Z", { status: "failed", steps: [{ ...run("x", "").steps[0], status: "failed", events: [{ t: "", type: "error", text: "the build broke" }] }] }));
    writeRun(t, w, run("parked", "2026-09-15T02:00:00Z", {
      status: "awaiting-approval",
      finishedAt: null,
      steps: [{ ...run("x", "").steps[0], status: "awaiting-approval", ask: "publish it?", events: [{ t: "2026-09-15T02:01:00Z", type: "info", text: "waiting for an answer" }] }],
    }));
    const all = listAllRuns(t);
    assert.deepEqual(all.map((r) => [r.id, r.workspace]), [["parked", "desk"], ["done", "desk"]]);
    const parked = all.find((r) => r.id === "parked")!;
    assert.equal(parked.steps[0].instruction, "write the long article about everything", "a live run is whole: the gate shows its question and its events");
    assert.equal(parked.steps[0].events.at(-1)?.text, "waiting for an answer");
    const done = all.find((r) => r.id === "done")!;
    assert.equal(done.steps[0].instruction, "", "a finished run is the row: no instruction");
    assert.equal(done.steps[0].result, null, "no reply");
    assert.deepEqual(runFailure(done), { agent: "writer", reason: "the build broke" }, "but the list's rollups still read true");
    assert.equal(runCost(done), 0.25);
    assert.deepEqual(listAllRunSummaries(t).map((r) => r.id), ["parked", "done"]);
    assert.equal(listAllRunSummaries(t)[0].awaitingApproval, true);
  }));
