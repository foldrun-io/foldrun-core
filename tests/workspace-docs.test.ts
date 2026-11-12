// A workspace's small state as rows (FOL-126): webhook generations and
// deliveries, eval results, grades, the deployed commit and captured calls go
// through the records port's `docs` when the platform has them and the switch
// is on — and a switch either way never loses what was written the other way.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { registerPlatform, resetPlatform } from "../src/platform.ts";
import type { RecordsPort } from "../src/records.ts";
import { fakeRecords } from "./fake-records.ts";
import { hookGeneration, rotateWebhook, recordDelivery, readDeliveries } from "../src/webhook.ts";
import { writeEvalResult, readEvalResult, readEvalHistory, type EvalResult } from "../src/evals.ts";
import { recordGrade, readGrades, graderSince, pruneGrades, type Grade } from "../src/grades.ts";
import { writeDeployedCommit, deployedCommit } from "../src/deploy.ts";
import { writeCapturedCall, readCapturedCall, deleteRun, workspaceDir } from "../src/store.ts";

const T = "docs-acct";
let on = true;
function setup(ws: string) {
  resetPlatform();
  const fake = fakeRecords();
  const mem = { port: fake.docs! };
  on = true;
  registerPlatform({ records: { ...fake, docsOn: () => on } as RecordsPort });
  fs.mkdirSync(workspaceDir(T, ws), { recursive: true });
  return mem;
}
const files = (ws: string) => fs.readdirSync(workspaceDir(T, ws), { recursive: true }).map(String).sort();

test("a hook rotation is a row, and holds whichever way the switch stands", (t) => {
  t.after(resetPlatform);
  const ws = "hooks";
  const mem = setup(ws);
  assert.equal(hookGeneration(T, ws, "f"), 0);
  rotateWebhook(T, ws, "f");
  assert.equal(hookGeneration(T, ws, "f"), 1);
  assert.deepEqual(files(ws), [], "nothing was written into the folder");
  // Switched off: the next rotation goes to the file, past the row.
  on = false;
  rotateWebhook(T, ws, "f");
  assert.equal(hookGeneration(T, ws, "f"), 2);
  assert.equal(JSON.parse(fs.readFileSync(path.join(workspaceDir(T, ws), "hooks.json"), "utf8")).f.gen, 2);
  // Back on: past the file.
  on = true;
  rotateWebhook(T, ws, "f");
  assert.equal(hookGeneration(T, ws, "f"), 3);
  assert.equal((mem.port.get(T, ws, "hook", "f") as { gen: number }).gen, 3);
});

test("a database that cannot answer fails the generation, it does not fall back to the file", (t) => {
  t.after(resetPlatform);
  const ws = "hooks-down";
  const mem = setup(ws);
  rotateWebhook(T, ws, "f");
  mem.port.get = () => {
    throw new Error("database is down");
  };
  assert.throws(() => hookGeneration(T, ws, "f"), /database is down/);
});

test("deliveries are rows: a flood of refusals is one entry, and old file lines still read", (t) => {
  t.after(resetPlatform);
  const ws = "deliveries";
  setup(ws);
  fs.writeFileSync(path.join(workspaceDir(T, ws), "hook-deliveries.jsonl"), JSON.stringify({ t: "2026-01-01T00:00:00.000Z", flow: "old", outcome: "accepted" }) + "\n");
  recordDelivery(T, ws, { t: "2026-02-01T00:00:00.000Z", flow: "a", outcome: "accepted" });
  for (let i = 0; i < 5; i++) recordDelivery(T, ws, { t: `2026-02-02T00:00:0${i}.000Z`, flow: `x${i}`, outcome: "invalid-token" });
  const all = readDeliveries(T, ws, 20);
  assert.deepEqual(all.map((d) => d.outcome), ["invalid-token", "accepted", "accepted"]);
  assert.equal(all[0].count, 5);
  assert.equal(all[0].first, "2026-02-02T00:00:00.000Z");
  assert.equal(all[0].detail, "more than one flow name");
  assert.equal(all[2].flow, "old");
});

test("eval results and their history are rows; the later result wins over an older file", (t) => {
  t.after(resetPlatform);
  const ws = "evals";
  setup(ws);
  const result = (finishedAt: string, passed: number): EvalResult => ({ eval: "smoke", startedAt: finishedAt, finishedAt, passed, failed: 0, costUsd: 0, cases: [] }) as EvalResult;
  on = false;
  writeEvalResult(T, ws, result("2026-01-01T00:00:00.000Z", 1), "c1");
  on = true;
  writeEvalResult(T, ws, result("2026-01-02T00:00:00.000Z", 2), "c2");
  assert.equal(readEvalResult(T, ws, "smoke")?.passed, 2);
  assert.deepEqual(readEvalHistory(T, ws).map((h) => h.commit), ["c1", "c2"]);
  on = false;
  writeEvalResult(T, ws, result("2026-01-03T00:00:00.000Z", 3), "c3");
  assert.equal(readEvalResult(T, ws, "smoke")?.passed, 3);
  assert.deepEqual(readEvalHistory(T, ws).map((h) => h.commit), ["c1", "c2", "c3"]);
});

test("grades and the grader's cursor are rows, read with the file's", (t) => {
  t.after(resetPlatform);
  const ws = "grades";
  setup(ws);
  const grade = (runId: string, at: string): Grade => ({ eval: "g", runId, at, verdict: "pass", costUsd: 0 }) as unknown as Grade;
  on = false;
  const first = graderSince(T, ws, "g", Date.parse("2026-03-01T00:00:00.000Z"));
  recordGrade(T, ws, grade("r1", new Date().toISOString()));
  on = true;
  assert.equal(graderSince(T, ws, "g", Date.now()), first, "a switch does not make the grader new");
  recordGrade(T, ws, grade("r2", new Date(Date.now() + 1000).toISOString()));
  assert.deepEqual(readGrades(T, ws, "g").map((g) => g.runId), ["r2", "r1"]);
  // A grade past the keeping window goes from the rows too.
  recordGrade(T, ws, grade("ancient", "2020-01-01T00:00:00.000Z"));
  assert.equal(pruneGrades(T, ws, "g"), 1);
  assert.deepEqual(readGrades(T, ws, "g").map((g) => g.runId), ["r2", "r1"]);
});

test("the deployed commit is a row; the later of row and file answers", (t) => {
  t.after(resetPlatform);
  const ws = "deployed";
  setup(ws);
  writeDeployedCommit(T, ws, "abc");
  assert.equal(deployedCommit(T, ws)?.commit, "abc");
  assert.equal(fs.existsSync(path.join(workspaceDir(T, ws), "..", `.${ws}.deployed`)), false);
});

test("a captured call's two parts merge in its row, and go with the run", (t) => {
  t.after(resetPlatform);
  const ws = "calls";
  const mem = setup(ws);
  const root = workspaceDir(T, ws);
  const scope = { tenant: T, workspace: ws };
  writeCapturedCall(root, "run-1", { id: "c1", tool: "web", input: "in", truncated: true }, scope);
  writeCapturedCall(root, "run-1", { id: "c1", tool: "web", output: "out" }, scope);
  writeCapturedCall(root, "run-10", { id: "c1", tool: "web", input: "other run" }, scope);
  assert.deepEqual(readCapturedCall(T, ws, "run-1", "c1"), { id: "c1", tool: "web", input: "in", output: "out", truncated: true });
  assert.equal(fs.existsSync(path.join(root, "runs")), false, "no file beside the run");
  // A call written as a file (the switch was off) still reads.
  on = false;
  writeCapturedCall(root, "run-2", { id: "c9", tool: "web", input: "file" }, scope);
  assert.equal(readCapturedCall(T, ws, "run-2", "c9")?.input, "file");
  // Deleting run-1 takes its calls, and only its own.
  fs.mkdirSync(path.join(root, "runs", "run-1"), { recursive: true });
  deleteRun(T, ws, "run-1");
  assert.equal(readCapturedCall(T, ws, "run-1", "c1"), null);
  assert.equal(readCapturedCall(T, ws, "run-10", "c1")?.input, "other run");
  assert.deepEqual(mem.port.list(T, ws, "call").map((c) => c.key), ["run-10/c1"]);
});

test("a call whose two parts straddle a switch reads whole (Codex review)", (t) => {
  t.after(resetPlatform);
  const ws = "calls-split";
  setup(ws);
  const root = workspaceDir(T, ws);
  const scope = { tenant: T, workspace: ws };
  on = false;
  writeCapturedCall(root, "run-1", { id: "c1", tool: "web", input: "in" }, scope);
  on = true;
  writeCapturedCall(root, "run-1", { id: "c1", tool: "web", output: "out", truncated: true }, scope);
  assert.deepEqual(readCapturedCall(T, ws, "run-1", "c1"), { id: "c1", tool: "web", input: "in", output: "out", truncated: true });
});

test("a deploy's eval lock taken in one place holds after the switch moves (Codex review)", async (t) => {
  t.after(resetPlatform);
  const { evaluateDeployed } = await import("../src/evals.ts");
  const ws = "eval-lock";
  const mem = setup(ws);
  fs.mkdirSync(path.join(workspaceDir(T, ws), "evals"), { recursive: true });
  fs.writeFileSync(path.join(workspaceDir(T, ws), "evals", "smoke.md"), "---\ntrigger: deploy\nflow: f\n---\n\n## case\ninput: x\nexpect: contains: y\n");
  // A lock on the file (the switch was off), then the switch turns on.
  fs.mkdirSync(path.join(workspaceDir(T, ws), "evals", ".results"), { recursive: true });
  fs.writeFileSync(path.join(workspaceDir(T, ws), "evals", ".results", ".evaluating"), "c0");
  on = true;
  assert.equal((await evaluateDeployed(T, ws, "c1")).skipped, "evals already running for an earlier deploy");
  // A lock as a row (on), then the switch turns off.
  fs.rmSync(path.join(workspaceDir(T, ws), "evals", ".results", ".evaluating"));
  mem.port.put(T, ws, "eval-lock", "deploy", { stamp: "c2", at: new Date().toISOString() });
  on = false;
  assert.equal((await evaluateDeployed(T, ws, "c3")).skipped, "evals already running for an earlier deploy");
});
