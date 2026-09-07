import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createFlowRun, driveRun, startFlowRun, waitForRun } from "../src/runner.ts";
import { readRun, writeRun, type FlowStep } from "../src/store.ts";
import { registerPlatform, platform } from "../src/platform.ts";
import type { RunInContainerArgs, ContainerStepOutcome } from "../src/run-container.ts";

// The retry policy and the resume, exercised through a fake executor
// registered under FOLDRUN_RUN_ISOLATION=fake. The fake sees exactly what
// the k8s executor sees — the args — and answers what a cluster would.

type Fake = (args: RunInContainerArgs) => Promise<ContainerStepOutcome>;

async function withFake(fake: Fake, resumable: boolean, body: (ws: string) => Promise<void>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-retry-"));
  const prev = { data: process.env.FOLDRUN_DATA, iso: process.env.FOLDRUN_RUN_ISOLATION, base: process.env.FOLDRUN_RETRY_BASE_MS };
  process.env.FOLDRUN_DATA = root;
  process.env.FOLDRUN_RUN_ISOLATION = "fake";
  process.env.FOLDRUN_RETRY_BASE_MS = "40"; // 40 ms, 80 ms, … instead of 15 s, 30 s, …
  const prevIso = platform.isolation;
  const prevRes = platform.sandboxResumable;
  registerPlatform({ isolation: { fake }, sandboxResumable: (kind) => resumable && kind === "fake" });
  try {
    const ws = path.join(root, "acme/workspaces/desk");
    fs.mkdirSync(path.join(ws, "agents/worker"), { recursive: true });
    fs.mkdirSync(path.join(ws, "runs"), { recursive: true });
    fs.writeFileSync(path.join(ws, "AGENTS.md"), "---\nname: desk\n---\n");
    fs.writeFileSync(path.join(ws, "agents/worker/agent.md"), "---\nname: worker\ndescription: works\n---\n\nWork.\n");
    await body(ws);
  } finally {
    registerPlatform({ isolation: prevIso, sandboxResumable: prevRes });
    for (const [k, v] of [["FOLDRUN_DATA", prev.data], ["FOLDRUN_RUN_ISOLATION", prev.iso], ["FOLDRUN_RETRY_BASE_MS", prev.base]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const step = (extra: Partial<FlowStep> = {}): FlowStep => ({ agent: "worker", instruction: "work", group: 1, optional: false, ...extra });

test("retry: waits with backoff, and an OOM-killed attempt comes back one size up", async () => {
  const seen: { size?: string; at: number }[] = [];
  const fake: Fake = async (args) => {
    seen.push({ size: args.size, at: Date.now() });
    if (seen.length === 1) return { status: "failed", result: null, costUsd: null, reason: "OOMKilled (exit 137)" };
    if (seen.length === 2) return { status: "failed", result: null, costUsd: null, reason: "Evicted: ephemeral-storage" };
    return { status: "completed", result: "done", costUsd: 0 };
  };
  await withFake(fake, false, async () => {
    const run = startFlowRun("acme", "desk", [step({ retry: 2 })], "f");
    const { run: done } = await waitForRun("acme", "desk", run.id, 20_000);
    assert.equal(done?.status, "completed");
    const s = done!.steps[0];
    assert.equal(s.attempts, 3);
    assert.equal(s.sizeUp, "heavy", "large → heavy after the OOM; heavy stays heavy after the eviction");
    assert.deepEqual(seen.map((x) => x.size), ["large", "heavy", "heavy"], "the executor was asked for the bigger class");
    const waits = s.events.filter((e) => /retrying in \d+s/.test(e.text));
    assert.equal(waits.length, 2);
    assert.match(waits[0].text, /at size: heavy/);
    assert.ok(s.events.some((e) => /sandbox ended: OOMKilled/.test(e.text)), "the cluster's reason is on the record");
    // The second wait is longer than the first: backoff, not a fixed pause.
    assert.ok(seen[2].at - seen[1].at >= 60, `second wait ${seen[2].at - seen[1].at}ms should be ~80ms`);
    assert.equal(s.sandbox, null, "no sandbox left on a settled step");
  });
});

test("a step whose driver died is re-attached, not re-run, when the executor can resume", async () => {
  const calls: RunInContainerArgs[] = [];
  const fake: Fake = async (args) => {
    calls.push(args);
    return { status: "completed", result: "carried on", costUsd: 0 };
  };
  await withFake(fake, true, async (ws) => {
    // The record a rolled worker leaves behind: the step running, its pod
    // named, two lines already applied, attempt 1 of 2.
    const run = createFlowRun("acme", "desk", [step({ retry: 1 })], "f", "running");
    run.steps[0].status = "running";
    run.steps[0].attempts = 1;
    run.steps[0].sandbox = { kind: "fake", ref: "pod-abc", consumed: 2, since: new Date().toISOString() };
    writeRun("acme", "desk", run);
    await driveRun("acme", "desk", readRun("acme", "desk", run.id)!);
    const done = readRun("acme", "desk", run.id)!;
    assert.equal(done.status, "completed");
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].resume, { ref: "pod-abc", consumed: 2 }, "the executor was told where to attach");
    assert.equal(done.steps[0].attempts, 1, "a resume is the same attempt, not a retry");
    assert.ok(done.steps[0].events.some((e) => /re-attaching to the running sandbox \(pod-abc, 2 lines already applied\)/.test(e.text)));
    assert.equal(done.steps[0].sandbox, null);
    assert.ok(fs.existsSync(path.join(ws, "runs", `${run.id}.json`)));
  });
});

test("the same orphan is run again from the start when the executor cannot resume", async () => {
  const calls: RunInContainerArgs[] = [];
  const fake: Fake = async (args) => {
    calls.push(args);
    return { status: "completed", result: "from scratch", costUsd: 0 };
  };
  await withFake(fake, false, async () => {
    const run = createFlowRun("acme", "desk", [step()], "f", "running");
    run.steps[0].status = "running";
    run.steps[0].sandbox = { kind: "fake", ref: "pod-abc", consumed: 2, since: new Date().toISOString() };
    writeRun("acme", "desk", run);
    await driveRun("acme", "desk", readRun("acme", "desk", run.id)!);
    const done = readRun("acme", "desk", run.id)!;
    assert.equal(done.status, "completed");
    assert.equal(calls[0].resume ?? null, null, "no resume for an executor that cannot");
    assert.ok(done.steps[0].events.some((e) => /interrupted mid-step/.test(e.text)));
  });
});
