// A run's outputs through the real runner (FOL-126 phase 5): with a backend
// registered and the setting on, archive() publishes each agent's outputs to
// the blob store, writes what it refused on the run and in the step's trail,
// and leaves nothing under runs/<id>/outputs on the volume; with the setting
// off (or no backend) it copies the folder as before.
//
//   node --test tests/run-outputs-runner.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startFlowRun, waitForRun } from "../src/runner.ts";
import { workspaceDir, deleteRun } from "../src/store.ts";
import { fsBlobStore, bounded } from "../src/blob-store.ts";
import { localRunOutputStore, listRunOutputs, readRunOutput, setRunOutputsBackend, settleRunOutputs, type RunOutputsBackend } from "../src/run-outputs.ts";
import { memoryPins } from "./run-outputs-contract.ts";

const MIB = 1048576;

async function inWorkspace<T>(stub: string, backend: (root: string) => RunOutputsBackend | null, fn: (a: { run: Awaited<ReturnType<typeof waitForRun>>["run"]; root: string; be: RunOutputsBackend | null }) => Promise<T>): Promise<T> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-rorun-"));
  const prev = { data: process.env.FOLDRUN_DATA, stub: process.env.FOLDRUN_STUB_STEP };
  process.env.FOLDRUN_DATA = root;
  process.env.FOLDRUN_STUB_STEP = "1";
  const be = backend(root);
  setRunOutputsBackend(be);
  try {
    const ws = path.join(root, "acme/workspaces/desk");
    fs.mkdirSync(path.join(ws, "agents", "writer"), { recursive: true });
    fs.writeFileSync(path.join(ws, "agents", "writer", "agent.md"), "---\nname: writer\ndescription: stub\n---\n\nStub.\n");
    fs.writeFileSync(path.join(ws, "agents", "writer", "stub.md"), stub);
    fs.writeFileSync(path.join(ws, "AGENTS.md"), "---\nname: desk\n---\n");
    const started = startFlowRun("acme", "desk", [{ agent: "writer", instruction: "go", group: 1, optional: false }], "outputs-test");
    const { run } = await waitForRun("acme", "desk", started.id, 30_000);
    return await fn({ run: run!, root, be });
  } finally {
    await settleRunOutputs();
    setRunOutputsBackend(null);
    for (const [k, v] of [["FOLDRUN_DATA", prev.data], ["FOLDRUN_STUB_STEP", prev.stub]] as const) v === undefined ? delete process.env[k] : (process.env[k] = v);
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const backendOf = (opts: { on?: boolean; fileMb?: number; runMb?: number } = {}) => (root: string): RunOutputsBackend => ({
  blobs: bounded(fsBlobStore(path.join(root, ".objects")), { backoffMs: 1 }),
  pins: memoryPins().pins,
  store: localRunOutputStore(path.join(root, ".run-outputs")),
  enabled: () => opts.on ?? true,
  fileMaxBytes: () => (opts.fileMb ?? 1) * MIB,
  runMaxBytes: () => (opts.runMb ?? 4) * MIB,
});

test("on: the outputs are published, none is left on the volume, and the run page can read them", async () => {
  await inWorkspace("write: report.md => # done\nwrite: data/rows.csv => a,b\nfinished", backendOf(), async ({ run }) => {
    assert.equal(run.status, "completed");
    assert.equal(run.outputsRefused, undefined);
    const onVolume = path.join(workspaceDir("acme", "desk"), "runs", run.id, "outputs");
    assert.equal(fs.existsSync(onVolume), false, "nothing is copied to the volume");
    assert.deepEqual((await listRunOutputs("acme", "desk", run.id)).map((f) => f.path), ["data/rows.csv", "report.md"]);
    assert.equal((await readRunOutput("acme", "desk", run.id, "writer", "report.md"))?.toString(), "# done");
  });
});

test("on: an over-cap file is refused, on the run and in the step's trail, and not kept anywhere", async () => {
  await inWorkspace(`write: small.txt => ok\nbytes: huge.bin => ${2 * MIB}\nfinished`, backendOf({ fileMb: 1 }), async ({ run }) => {
    assert.equal(run.status, "completed", "a refused file does not fail the run");
    assert.deepEqual(run.outputsRefused, [{ agent: "writer", path: "huge.bin", bytes: 2 * MIB, reason: "file-cap", limit: MIB }]);
    assert.equal(run.outputsRefusedCount, 1);
    assert.ok(run.steps[0].events.some((e) => e.type === "error" && /outputs: writer\/huge\.bin \(2\.0 MiB\) was not kept: a file may be at most 1\.0 MiB/.test(e.text)));
    assert.deepEqual((await listRunOutputs("acme", "desk", run.id)).map((f) => f.path), ["small.txt"]);
    const onVolume = path.join(workspaceDir("acme", "desk"), "runs", run.id, "outputs");
    assert.equal(fs.existsSync(onVolume), false);
  });
});

test("setting off: the folder is copied to the volume as before, nothing is published", async () => {
  await inWorkspace("write: report.md => # done\nfinished", backendOf({ on: false }), async ({ run, be }) => {
    const onVolume = path.join(workspaceDir("acme", "desk"), "runs", run.id, "outputs", "writer", "report.md");
    assert.equal(fs.readFileSync(onVolume, "utf8"), "# done");
    assert.deepEqual(await be!.store.list("acme", "desk", run.id), []);
    assert.deepEqual((await listRunOutputs("acme", "desk", run.id)).map((f) => f.path), ["report.md"]);
  });
});

test("no backend (a laptop): as before", async () => {
  await inWorkspace("write: report.md => # done\nfinished", () => null, async ({ run }) => {
    assert.equal(fs.readFileSync(path.join(workspaceDir("acme", "desk"), "runs", run.id, "outputs", "writer", "report.md"), "utf8"), "# done");
    assert.equal(run.outputsRefused, undefined);
  });
});

test("TEMPORARY fallback: a store that fails the publish still keeps the outputs, on the volume", async () => {
  const dead = (root: string): RunOutputsBackend => ({ ...backendOf()(root), blobs: { ...bounded(fsBlobStore(path.join(root, ".objects"))), putIfAbsent: async () => Promise.reject(new Error("bucket unreachable")) } as never });
  await inWorkspace("write: report.md => # done\nfinished", dead, async ({ run }) => {
    assert.equal(run.status, "completed");
    assert.equal(fs.readFileSync(path.join(workspaceDir("acme", "desk"), "runs", run.id, "outputs", "writer", "report.md"), "utf8"), "# done");
  });
});

test("deleting the run removes its published outputs", async () => {
  await inWorkspace("write: report.md => # done\nfinished", backendOf(), async ({ run, be }) => {
    assert.equal((await be!.store.list("acme", "desk", run.id)).length, 1);
    deleteRun("acme", "desk", run.id);
    await settleRunOutputs();
    assert.deepEqual(await be!.store.list("acme", "desk", run.id), []);
  });
});
