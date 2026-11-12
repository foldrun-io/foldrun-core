// Inputs on a run (FOL-163): what the run reads is fixed when it is made —
// held by foldrun's own records, zero copies — and an overwrite or a delete
// in between changes nothing; the holds are never listed, mirrored or
// harvested, no one else may write under them, and they go with the run.
// Staging writes the held bytes fresh; copy-back never takes inputs/ back.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  putFile, listStorage, getFile, deleteFile, usedBytes, materializeFiles, storageBaseline, registerUpload, uploadUrl,
  resolveRunInputs, holdRunInputs, releaseRunInputs, stageRunInputs, sweepHeldInputs, MissingInput, RUN_INPUTS_PREFIX, isReservedPath, readIndex,
} from "../src/storage.ts";
import { INPUT_LIMITS, inputsNote, inputsProblem, inputsSizeProblem, stagedLine } from "../src/run-inputs.ts";
import { applyContainerChanges } from "../src/run-container.ts";
import { createFlowRun } from "../src/runner.ts";
import { workspaceDir, deleteRun, readRun } from "../src/store.ts";

let root: string;
const T = "default";
const W = "demo";
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-inputs-"));
  process.env.FOLDRUN_DATA = root;
  delete process.env.FOLDRUN_STORAGE_DRIVER;
  fs.mkdirSync(path.join(workspaceDir(T, W), "agents", "reader"), { recursive: true });
  fs.writeFileSync(path.join(workspaceDir(T, W), "AGENTS.md"), "---\nname: demo\n---\n");
  fs.writeFileSync(path.join(workspaceDir(T, W), "agents", "reader", "agent.md"), "---\nname: reader\n---\n\nRead.\n");
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  delete process.env.FOLDRUN_DATA;
});

const heldOf = (runId: string) => readIndex(T, W).files.filter((f) => f.path.startsWith(`${RUN_INPUTS_PREFIX}${runId}/`));

test("resolve: storage paths to the blob each names; missing, reserved and escaping paths refused; duplicates dropped", async () => {
  await putFile(T, W, "reports/q4.pdf", Buffer.from("%PDF q4"), "user:a@x");
  const got = resolveRunInputs(T, W, ["reports/q4.pdf", "reports/q4.pdf"]);
  assert.equal(got.length, 1);
  assert.equal(got[0]!.path, "reports/q4.pdf");
  assert.equal(got[0]!.mime, "application/pdf");
  assert.match(got[0]!.sha, /^[0-9a-f]{64}$/);
  for (const bad of ["nope.pdf", "../x", ".foldrun/run-inputs/r/x", ""]) {
    assert.throws(() => resolveRunInputs(T, W, [bad]), (e: unknown) => e instanceof MissingInput, bad);
  }
});

test("held: an overwrite or a delete after the hold changes nothing the run reads; holds are not listed, mirrored or counted twice", async () => {
  await putFile(T, W, "data/in.csv", Buffer.from("a,b\n1,2\n"), "user:a@x");
  const files = resolveRunInputs(T, W, ["data/in.csv"]);
  await holdRunInputs(T, W, "run-one", files);
  assert.equal(heldOf("run-one").length, 1);
  const used = usedBytes(T, W);
  assert.deepEqual(listStorage(T, W).map((f) => f.path), ["data/in.csv"], "a hold is not one of the workspace's files");
  assert.deepEqual(Object.keys(storageBaseline(T, W)), ["data/in.csv"]);
  await materializeFiles(T, W);
  assert.equal(fs.existsSync(path.join(workspaceDir(T, W), "storage", ".foldrun")), false, "never mirrored into a sandbox");
  assert.equal(used, Buffer.from("a,b\n1,2\n").length, "the same bytes count once");

  await putFile(T, W, "data/in.csv", Buffer.from("CHANGED"), "user:a@x");
  const into = path.join(root, "stage1");
  const s1 = await stageRunInputs(T, W, "run-one", files, into);
  assert.equal(fs.readFileSync(path.join(into, "data/in.csv"), "utf8"), "a,b\n1,2\n", "the bytes it was given, not today's");
  assert.deepEqual(s1, { files: 1, bytes: 8 });

  await deleteFile(T, W, "data/in.csv");
  const into2 = path.join(root, "stage2");
  fs.mkdirSync(path.join(into2, "stale"), { recursive: true });
  fs.writeFileSync(path.join(into2, "stale", "old.txt"), "old");
  await stageRunInputs(T, W, "run-one", files, into2);
  assert.equal(fs.readFileSync(path.join(into2, "data/in.csv"), "utf8"), "a,b\n1,2\n", "still there after the delete");
  assert.equal(fs.existsSync(path.join(into2, "stale")), false, "staged fresh: a folder already there never mixes in");
});

test("no one else writes under foldrun's prefix; holds go with release, and a blob nothing names is collected", async () => {
  for (const write of [
    () => putFile(T, W, ".foldrun/run-inputs/x/y", Buffer.from("z"), "user:a@x"),
    () => deleteFile(T, W, `${RUN_INPUTS_PREFIX}run-one/data/in.csv`),
    () => registerUpload(T, W, ".foldrun/x", "0".repeat(64), 1, "user:a@x"),
    () => uploadUrl(T, W, ".foldrun/x", "0".repeat(64), 1),
  ]) {
    await assert.rejects(write, /foldrun's own/);
  }
  assert.equal(isReservedPath(".foldrun"), true);
  assert.equal(isReservedPath(".foldrunner/x"), false);

  await putFile(T, W, "a.txt", Buffer.from("AAA"), "user:a@x");
  const files = resolveRunInputs(T, W, ["a.txt"]);
  await holdRunInputs(T, W, "run-two", files);
  await deleteFile(T, W, "a.txt");
  assert.equal(usedBytes(T, W), 3, "held bytes still occupy the store");
  assert.equal(await releaseRunInputs(T, W, "run-two"), 1);
  assert.equal(heldOf("run-two").length, 0);
  assert.equal(usedBytes(T, W), 0, "collected once nothing names it");
  await assert.rejects(stageRunInputs(T, W, "run-two", files, path.join(root, "s3")), (e: unknown) => e instanceof MissingInput, "a released hold stages nothing");
  await assert.rejects(holdRunInputs(T, W, "run-three", files), (e: unknown) => e instanceof MissingInput, "bytes that are gone cannot be held again");
});

test("a run's record carries its inputs and the step the task reaches; deleting the run releases them; the sweep finds leftovers", async () => {
  await putFile(T, W, "img/photo.png", Buffer.from("\x89PNG fake"), "user:a@x");
  const files = resolveRunInputs(T, W, ["img/photo.png"]);
  const run = createFlowRun(T, W, [{ agent: "reader", instruction: "look", group: 1, optional: false }, { agent: "reader", instruction: "again", group: 2, optional: false }], "adhoc:reader", "queued", [], null, {}, undefined, undefined, undefined, files);
  assert.deepEqual(run.inputs, files);
  assert.equal(run.steps[0]!.inputsTurn, true);
  assert.equal(run.steps[1]!.inputsTurn, undefined, "only the step the task reaches");
  await holdRunInputs(T, W, run.id, files);
  assert.equal(heldOf(run.id).length, 1);
  deleteRun(T, W, run.id);
  for (let i = 0; i < 50 && heldOf(run.id).length; i++) await new Promise((r) => setTimeout(r, 20));
  assert.equal(heldOf(run.id).length, 0, "released with the run");

  await holdRunInputs(T, W, "run-gone", files);
  await holdRunInputs(T, W, "run-kept", files);
  const swept = await sweepHeldInputs(T, W, (id) => id === "run-kept");
  assert.equal(swept, 1);
  assert.equal(heldOf("run-gone").length, 0);
  assert.equal(heldOf("run-kept").length, 1, "a live run's hold stays");
  assert.equal(readRun(T, W, run.id), null);
});

test("copy-back never takes a step's inputs/ back, whatever it did there; outputs still come", () => {
  const host = path.join(root, "host");
  const box = path.join(root, "box");
  for (const d of [host, box]) fs.mkdirSync(path.join(d, "agents/reader"), { recursive: true });
  fs.mkdirSync(path.join(box, "agents/reader/inputs/sub"), { recursive: true });
  fs.writeFileSync(path.join(box, "agents/reader/inputs/sub/x.csv"), "edited by the step");
  fs.mkdirSync(path.join(box, "agents/reader/outputs"), { recursive: true });
  fs.writeFileSync(path.join(box, "agents/reader/outputs/report.md"), "done");
  const applied = applyContainerChanges(host, box, {}, undefined, undefined, { drop: "agents/reader/inputs/" });
  assert.deepEqual(applied, ["agents/reader/outputs/report.md"]);
  assert.equal(fs.existsSync(path.join(host, "agents/reader/inputs")), false);
  // A file planted where the folder would be is dropped too.
  fs.rmSync(path.join(box, "agents/reader/inputs"), { recursive: true });
  fs.writeFileSync(path.join(box, "agents/reader/inputs"), "a file, not a folder");
  assert.deepEqual(applyContainerChanges(host, box, {}, undefined, undefined, { drop: "agents/reader/inputs/" }).filter((p) => p.includes("inputs")), []);
});

test("limits and what the step is told", () => {
  assert.equal(inputsProblem(["a"]), null);
  assert.match(inputsProblem("a") ?? "", /list/);
  assert.match(inputsProblem([1]) ?? "", /strings/);
  assert.match(inputsProblem(Array.from({ length: INPUT_LIMITS.files + 1 }, (_, i) => `f${i}`)) ?? "", /at most 20/);
  assert.match(inputsSizeProblem([{ path: "a", sha: "s", size: INPUT_LIMITS.totalBytes + 1, mime: "x" }]) ?? "", /at most 100 MiB/);
  const note = inputsNote([{ path: "reports/q4.pdf", sha: "s", size: 2048, mime: "application/pdf" }]);
  assert.match(note, /inputs\/reports\/q4\.pdf \(application\/pdf, 2 KiB\)/);
  assert.match(note, /Read tool/);
  assert.match(note, /not kept/);
  assert.equal(stagedLine(2, 3 * 1048576), "inputs: 2 files in inputs/ (3.0 MiB)");
});
