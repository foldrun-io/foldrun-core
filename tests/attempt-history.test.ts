// Every attempt of a step is on the record, and the step's cost is the sum.
//
// A retried step used to carry only its last attempt's cost, tokens and
// sandbox seconds — each attempt overwrote the one before — and the run's
// spend, the flow's budget: and the platform's bill all read the step's
// figure. A `retry: 2` step could spend three shares while reporting one.
// The budget ceiling was also computed once before the attempt loop, so a
// retry was handed the same share the failed attempt had already spent.
//
//   node --test tests/attempt-history.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startFlowRun, waitForRun } from "../src/runner.ts";
import { sumAttempts, type FlowStep } from "../src/store.ts";
import { registerPlatform, platform } from "../src/platform.ts";
import type { RunInContainerArgs, ContainerStepOutcome } from "../src/run-container.ts";

type Fake = (args: RunInContainerArgs) => Promise<ContainerStepOutcome>;

async function withFake(fake: Fake, flowFile: string | null, body: () => Promise<void>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-tries-"));
  const prev = { data: process.env.FOLDRUN_DATA, iso: process.env.FOLDRUN_RUN_ISOLATION, base: process.env.FOLDRUN_RETRY_BASE_MS };
  process.env.FOLDRUN_DATA = root;
  process.env.FOLDRUN_RUN_ISOLATION = "fake";
  process.env.FOLDRUN_RETRY_BASE_MS = "20";
  const prevIso = platform.isolation;
  registerPlatform({ isolation: { fake } });
  try {
    const ws = path.join(root, "acme/workspaces/desk");
    fs.mkdirSync(path.join(ws, "agents/worker"), { recursive: true });
    fs.mkdirSync(path.join(ws, "runs"), { recursive: true });
    fs.mkdirSync(path.join(ws, "flows"), { recursive: true });
    fs.writeFileSync(path.join(ws, "AGENTS.md"), "---\nname: desk\n---\n");
    fs.writeFileSync(path.join(ws, "agents/worker/agent.md"), "---\nname: worker\ndescription: works\n---\n\nWork.\n");
    if (flowFile) fs.writeFileSync(path.join(ws, "flows/f.md"), flowFile);
    await body();
  } finally {
    registerPlatform({ isolation: prevIso });
    for (const [k, v] of [["FOLDRUN_DATA", prev.data], ["FOLDRUN_RUN_ISOLATION", prev.iso], ["FOLDRUN_RETRY_BASE_MS", prev.base]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const step = (extra: Partial<FlowStep> = {}): FlowStep => ({ agent: "worker", instruction: "work", group: 1, optional: false, ...extra });

test("each attempt is a row, and the step's cost, tokens and seconds are the sum of the rows", async () => {
  let calls = 0;
  const fake: Fake = async () => {
    calls += 1;
    if (calls === 1) {
      return { status: "failed", result: "half done", costUsd: 0.01, usage: { inputTokens: 100, outputTokens: 10 }, reason: "OOMKilled (exit 137)", timing: { sandboxMs: 500, firstOutputMs: null, totalMs: 4000 } };
    }
    return { status: "completed", result: "done", costUsd: 0.02, usage: { inputTokens: 200, outputTokens: 20 }, timing: { sandboxMs: 500, firstOutputMs: null, totalMs: 6000 } };
  };
  await withFake(fake, null, async () => {
    const run = startFlowRun("acme", "desk", [step({ retry: 2 })], "f");
    const { run: done } = await waitForRun("acme", "desk", run.id, 20_000);
    assert.equal(done?.status, "completed");
    const s = done!.steps[0];
    assert.equal(s.attempts, 2);
    assert.equal(s.tries?.length, 2, "one row per attempt");
    const [first, second] = s.tries!;
    assert.equal(first.n, 1);
    assert.equal(first.status, "failed");
    assert.equal(first.costUsd, 0.01);
    assert.deepEqual(first.tokens, { input: 100, output: 10 });
    assert.equal(first.computeSecs, 4);
    assert.match(first.error ?? "", /OOMKilled/, "the attempt's own last error is on its row");
    assert.ok(first.startedAt <= first.finishedAt);
    assert.equal(second.n, 2);
    assert.equal(second.status, "completed");
    assert.equal(second.error, undefined);
    // The totals, which the run's spend and the bill read.
    assert.ok(Math.abs((s.costUsd ?? 0) - 0.03) < 1e-9, `cost is the sum: ${s.costUsd}`);
    assert.deepEqual(s.tokens, { input: 300, output: 30 });
    assert.equal(s.computeSecs, 10);
  });
});

test("sumAttempts: null where no attempt reported the figure, never a made-up zero", () => {
  assert.deepEqual(sumAttempts([]), { costUsd: null, tokens: null, computeSecs: null });
  const rows = [
    { n: 1, status: "failed" as const, costUsd: null, tokens: null, computeSecs: null, startedAt: "a", finishedAt: "b" },
    { n: 2, status: "completed" as const, costUsd: 0.5, tokens: { input: 1, output: 2 }, computeSecs: 3, startedAt: "a", finishedAt: "b" },
  ];
  assert.deepEqual(sumAttempts(rows), { costUsd: 0.5, tokens: { input: 1, output: 2 }, computeSecs: 3 });
});

test("a retry's ceiling is what is left after the failed attempt spent", async () => {
  const ceilings: (number | null | undefined)[] = [];
  let calls = 0;
  const fake: Fake = async (args) => {
    calls += 1;
    ceilings.push(args.input.budgetUsd);
    if (calls === 1) return { status: "failed", result: null, costUsd: 0.04, reason: "Evicted" };
    return { status: "completed", result: "done", costUsd: 0.005 };
  };
  await withFake(fake, "---\nname: f\nbudget: 0.05\n---\n\n1. [[worker]] — work\n   retry: 1\n", async () => {
    const run = startFlowRun("acme", "desk", [step({ retry: 1 })], "f");
    const { run: done } = await waitForRun("acme", "desk", run.id, 20_000);
    assert.equal(done?.status, "completed");
    assert.equal(ceilings.length, 2);
    assert.ok(Math.abs(ceilings[0]! - 0.05) < 1e-9, `the first attempt had the whole share: ${ceilings[0]}`);
    assert.ok(Math.abs(ceilings[1]! - 0.01) < 1e-9, `the retry had what was left, not the share again: ${ceilings[1]}`);
  });
});

test("nothing left after a failed attempt means no retry, said on the record", async () => {
  let calls = 0;
  const fake: Fake = async () => {
    calls += 1;
    return { status: "failed", result: null, costUsd: 0.05, reason: "Evicted" };
  };
  await withFake(fake, "---\nname: f\nbudget: 0.05\n---\n\n1. [[worker]] — work\n   retry: 2\n", async () => {
    const run = startFlowRun("acme", "desk", [step({ retry: 2 })], "f");
    const { run: done } = await waitForRun("acme", "desk", run.id, 20_000);
    assert.equal(done?.status, "failed");
    assert.equal(calls, 1, "the executor was not asked for a second attempt");
    const s = done!.steps[0];
    assert.equal(s.tries?.length, 1);
    assert.ok(s.events.some((e) => /over budget — nothing left to spend for attempt 2/.test(e.text)), s.events.map((e) => e.text).join(" | "));
  });
});
