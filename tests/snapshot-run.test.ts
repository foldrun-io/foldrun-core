// A snapshot run (Part B3): the folder rides on the run record, only an
// executor that says it can hold one runs it, and what comes back from the
// sandbox is the agent's outputs/ alone.
//
//   node --test tests/snapshot-run.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { applyContainerChanges, type RunInContainerArgs, type ContainerStepOutcome } from "../src/run-container.ts";
import { createFlowRun, driveRun } from "../src/runner.ts";
import { readRun } from "../src/store.ts";
import { registerPlatform, platform, type IsolatedStepRunner } from "../src/platform.ts";

const SNAP = "a".repeat(64);

test("keepOnly: only that folder comes back — the snapshot and anything copied elsewhere stay in the sandbox", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-keeponly-"));
  const host = path.join(base, "host");
  const out = path.join(base, "out");
  const handed = path.join(base, "in");
  for (const d of [host, out, handed]) fs.mkdirSync(d, { recursive: true });
  const put = (root: string, rel: string, text: string) => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  };
  put(out, "agents/coder/outputs/notes.md", "kept");
  put(out, "agents/coder/snapshot/src/x.ts", "the user's code, changed");
  put(out, "state/copied.ts", "the user's code, copied out");
  put(out, "agents/coder/memory/m.md", "what it learned about the code");
  put(out, "agents/other/outputs/y.md", "another agent's folder");
  const applied = applyContainerChanges(host, out, handed, undefined, undefined, { keepOnly: "agents/coder/outputs/" });
  assert.deepEqual(applied.map((p) => p.replaceAll("\\", "/")), ["agents/coder/outputs/notes.md"]);
  assert.equal(fs.existsSync(path.join(host, "state/copied.ts")), false);
  assert.equal(fs.existsSync(path.join(host, "agents/coder/snapshot")), false);
  fs.rmSync(base, { recursive: true, force: true });
});

async function withWorkspace(iso: string | undefined, runners: Record<string, IsolatedStepRunner>, fn: (ws: string) => Promise<void>, holds: string[] = []) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-snaprun-"));
  const prev = { data: process.env.FOLDRUN_DATA, iso: process.env.FOLDRUN_RUN_ISOLATION };
  const prevIso = platform.isolation;
  const prevHolds = platform.holdsSnapshot;
  process.env.FOLDRUN_DATA = root;
  if (iso) process.env.FOLDRUN_RUN_ISOLATION = iso;
  else delete process.env.FOLDRUN_RUN_ISOLATION;
  registerPlatform({ isolation: runners, holdsSnapshot: (i) => holds.includes(i) });
  try {
    const ws = path.join(root, "acme/workspaces/desk");
    fs.mkdirSync(path.join(ws, "agents/coder"), { recursive: true });
    fs.mkdirSync(path.join(ws, "runs"), { recursive: true });
    fs.writeFileSync(path.join(ws, "AGENTS.md"), "---\nname: desk\n---\n");
    fs.writeFileSync(path.join(ws, "agents/coder/agent.md"), "---\nname: coder\ndescription: codes\n---\n\nCode.\n");
    await fn(ws);
  } finally {
    registerPlatform({ isolation: prevIso, holdsSnapshot: prevHolds });
    for (const [k, v] of [["FOLDRUN_DATA", prev.data], ["FOLDRUN_RUN_ISOLATION", prev.iso]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const go = async () => {
  const run = createFlowRun("acme", "desk", [{ agent: "coder", instruction: "fix it", group: 1, optional: false }], "adhoc:coder", "running", [], null, {}, undefined, SNAP);
  assert.deepEqual(run.snapshot, { id: SNAP }, "on the record from the start");
  await driveRun("acme", "desk", readRun("acme", "desk", run.id)!);
  return readRun("acme", "desk", run.id)!;
};

test("a supporting executor gets the snapshot id, and the step is told where the folder is", async () => {
  let seen: RunInContainerArgs | null = null;
  const able: IsolatedStepRunner = async (args: RunInContainerArgs): Promise<ContainerStepOutcome> => {
    seen = args;
    return { status: "completed", result: "done", costUsd: 0, applied: [] };
  };
  await withWorkspace("able", { able }, async () => {
    const done = await go();
    assert.equal(done.status, "completed", JSON.stringify(done.steps[0]));
    assert.deepEqual(seen!.snapshot, { id: SNAP });
    assert.match(seen!.input.prompt, /snapshot\//);
  }, ["able"]);
});

test("an executor that cannot hold one, and a step with no sandbox, fail before anything runs", async () => {
  let ran = false;
  const unable: IsolatedStepRunner = async () => {
    ran = true;
    return { status: "completed", result: "done", costUsd: 0, applied: [] };
  };
  await withWorkspace("unable", { unable }, async () => {
    const done = await go();
    assert.equal(done.status, "failed");
    assert.equal(ran, false, "the sandbox was never started");
    assert.match(JSON.stringify(done.steps[0]), /cannot hold one/);
  });
  await withWorkspace(undefined, {}, async () => {
    const done = await go();
    assert.equal(done.status, "failed", "in-process: the step would work in the real workspace folder");
    assert.match(JSON.stringify(done.steps[0]), /cannot hold one/);
  });
});
