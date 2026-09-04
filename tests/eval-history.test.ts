// Eval scores, attributed to commits — so a drop names the change.
//
//   node --test tests/eval-history.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { evalTrends, evaluateDeployed, readEvalHistory, writeEvalResult, type EvalResult } from "../packages/core/src/evals.ts";
import { writeDeployedCommit } from "../packages/core/src/deploy.ts";

function withWorkspace(run: (tenant: string, ws: string) => Promise<void> | void) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-evalhist-"));
  const prev = process.env.FOLDRUN_DATA;
  process.env.FOLDRUN_DATA = root;
  return (async () => {
    try {
      fs.mkdirSync(path.join(root, "acme/workspaces/desk/evals"), { recursive: true });
      fs.writeFileSync(path.join(root, "acme/workspaces/desk/AGENTS.md"), "---\nname: desk\n---\n");
      await run("acme", "desk");
    } finally {
      if (prev === undefined) delete process.env.FOLDRUN_DATA;
      else process.env.FOLDRUN_DATA = prev;
      fs.rmSync(root, { recursive: true, force: true });
    }
  })();
}

const result = (name: string, passed: number, failed: number, at: string): EvalResult =>
  ({ eval: name, startedAt: at, finishedAt: at, passed, failed, costUsd: 0.01, cases: [] }) as EvalResult;

test("every result is one line of history, stamped with the deployed commit", () =>
  withWorkspace((t, w) => {
    writeDeployedCommit(t, w, "aaa1111");
    writeEvalResult(t, w, result("writer-quality", 3, 0, "2026-08-30T10:00:00Z"));
    const [h] = readEvalHistory(t, w);
    assert.equal(h.commit, "aaa1111", "a manual run is attributed to what was running");
    assert.equal(h.passed, 3);
    // The latest-result file the evals page reads is still written.
    assert.ok(fs.existsSync(path.join(process.env.FOLDRUN_DATA!, "acme/workspaces/desk/evals/.results/writer-quality.json")));
  }));

test("a drop is compared against the previous commit, not the previous run", () =>
  withWorkspace((t, w) => {
    writeEvalResult(t, w, result("writer-quality", 3, 0, "2026-08-28T10:00:00Z"), "aaa1111");
    writeEvalResult(t, w, result("writer-quality", 3, 0, "2026-08-28T11:00:00Z"), "aaa1111");
    writeEvalResult(t, w, result("writer-quality", 1, 2, "2026-08-30T10:00:00Z"), "bbb2222");
    // A second run on the new commit — variance, not a second regression.
    writeEvalResult(t, w, result("writer-quality", 2, 1, "2026-08-30T11:00:00Z"), "bbb2222");

    const [trend] = evalTrends(t, w);
    assert.equal(trend.latest.commit, "bbb2222");
    assert.equal(trend.previous!.commit, "aaa1111", "previous is the last run on a different commit");
    assert.equal(trend.delta, -1, "2/3 now against 3/3 before");
  }));

test("the first commit with a run has nothing to compare to, and says so", () =>
  withWorkspace((t, w) => {
    writeEvalResult(t, w, result("x", 2, 0, "2026-08-30T10:00:00Z"), "aaa1111");
    writeEvalResult(t, w, result("x", 1, 1, "2026-08-30T11:00:00Z"), "aaa1111");
    const [trend] = evalTrends(t, w);
    assert.equal(trend.previous, null);
    assert.equal(trend.delta, null, "two runs on one commit are not a trend");
  }));

test("regressions sort first", () =>
  withWorkspace((t, w) => {
    writeEvalResult(t, w, result("steady", 2, 0, "2026-08-28T10:00:00Z"), "aaa1111");
    writeEvalResult(t, w, result("steady", 2, 0, "2026-08-30T10:00:00Z"), "bbb2222");
    writeEvalResult(t, w, result("broke", 2, 0, "2026-08-28T10:00:00Z"), "aaa1111");
    writeEvalResult(t, w, result("broke", 0, 2, "2026-08-30T10:00:00Z"), "bbb2222");
    assert.deepEqual(evalTrends(t, w).map((x) => x.eval), ["broke", "steady"]);
  }));

test("a torn history line loses one entry, not the file", () =>
  withWorkspace((t, w) => {
    writeEvalResult(t, w, result("x", 1, 0, "2026-08-30T10:00:00Z"), "aaa1111");
    const file = path.join(process.env.FOLDRUN_DATA!, "acme/workspaces/desk/evals/.results/history.jsonl");
    fs.appendFileSync(file, '{"eval":"x","at":"2026-08-30T11:00:00Z","pas');
    assert.equal(readEvalHistory(t, w).length, 1);
  }));

test("a deploy with no evals spends nothing, and a running evaluation is not doubled", () =>
  withWorkspace(async (t, w) => {
    assert.deepEqual(await evaluateDeployed(t, w, "aaa1111"), { ran: 0, skipped: "no evals" });

    // One eval exists, and a lock says an earlier deploy is still evaluating.
    fs.writeFileSync(
      path.join(process.env.FOLDRUN_DATA!, "acme/workspaces/desk/evals/q.md"),
      "---\nname: q\nagent: a\n---\n\n## c\ntask: t\nexpect:\n  - contains: x\n",
    );
    const results = path.join(process.env.FOLDRUN_DATA!, "acme/workspaces/desk/evals/.results");
    fs.mkdirSync(results, { recursive: true });
    fs.writeFileSync(path.join(results, ".evaluating"), "aaa1111");
    const second = await evaluateDeployed(t, w, "bbb2222");
    assert.equal(second.ran, 0);
    assert.match(second.skipped!, /already running/);
  }));
