// FOLDRUN_STEP_ATTEMPT_ID (FOL-449): which attempt of which step a script,
// the step's shell and its `verify:` belong to.
//
// A run's copy-back never carries a deletion, so a marker a first attempt
// (or an earlier step) left is still on disk when a retried step is
// checked. A check that could only compare it with FOLDRUN_RUN_ID passed a
// retry on the evidence of the attempt that failed. The id is new each time
// the step's work starts over, and the same when a drive re-attaches to the
// sandbox an earlier one left.
//
//   node --test tests/attempt-id.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ATTEMPT_ID_ENV, withAttemptId, createFlowRun, driveRun, startFlowRun, waitForRun } from "../src/runner.ts";
import { readRun, writeRun, type FlowStep } from "../src/store.ts";
import { registerPlatform, platform } from "../src/platform.ts";
import type { RunInContainerArgs, ContainerStepOutcome } from "../src/run-container.ts";
import { setSecret } from "../src/secrets.ts";

type Fake = (args: RunInContainerArgs) => Promise<ContainerStepOutcome>;

async function withFake(fake: Fake, body: () => Promise<void>, agent = "---\nname: worker\ndescription: works\n---\n\nWork.\n") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-attempt-"));
  const prev = { data: process.env.FOLDRUN_DATA, iso: process.env.FOLDRUN_RUN_ISOLATION, base: process.env.FOLDRUN_RETRY_BASE_MS };
  process.env.FOLDRUN_DATA = root;
  process.env.FOLDRUN_RUN_ISOLATION = "fake";
  process.env.FOLDRUN_RETRY_BASE_MS = "20";
  const prevIso = platform.isolation;
  const prevRes = platform.sandboxResumable;
  registerPlatform({ isolation: { fake }, sandboxResumable: (kind) => kind === "fake" });
  try {
    const ws = path.join(root, "acme/workspaces/desk");
    fs.mkdirSync(path.join(ws, "agents/worker"), { recursive: true });
    fs.mkdirSync(path.join(ws, "runs"), { recursive: true });
    fs.writeFileSync(path.join(ws, "AGENTS.md"), "---\nname: desk\n---\n");
    fs.writeFileSync(path.join(ws, "agents/worker/agent.md"), agent);
    await body();
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
const idOf = (args: RunInContainerArgs) => args.env[ATTEMPT_ID_ENV];

test("the name is one the host's allowlist passes to scripts and verify", async () => {
  const { hostEnvAllowed } = await import("../src/host-env.ts");
  assert.equal(ATTEMPT_ID_ENV, "FOLDRUN_STEP_ATTEMPT_ID");
  assert.equal(hostEnvAllowed(ATTEMPT_ID_ENV), true);
});

test("each attempt of a step gets its own id, each step its own, and the record holds the last", async () => {
  const seen: { group: string; id: string | undefined }[] = [];
  let calls = 0;
  const fake: Fake = async (args) => {
    calls += 1;
    seen.push({ group: String(args.input.prompt ?? "").includes("second") ? "second" : "first", id: idOf(args) });
    // Each go reports its sandbox, as the cluster's executor does: a later
    // go must not take that reference for one to re-attach to.
    assert.equal(args.resume, null, "a new attempt starts its own sandbox");
    args.checkpoint?.(`pod-${calls}`, 0);
    if (calls === 1) return { status: "failed", result: null, costUsd: 0, reason: "exit 1" };
    return { status: "completed", result: "done", costUsd: 0 };
  };
  await withFake(fake, async () => {
    const run = startFlowRun("acme", "desk", [step({ retry: 1 }), step({ group: 2, instruction: "second job" })], "f");
    const { run: done } = await waitForRun("acme", "desk", run.id, 20_000);
    assert.equal(done?.status, "completed");
    assert.equal(seen.length, 3, "attempt 1, its retry, then the second step");
    const ids = seen.map((s) => s.id);
    for (const id of ids) assert.match(id ?? "", /^att_[0-9a-f]{18}$/);
    assert.equal(new Set(ids).size, 3, `every attempt has its own id: ${ids.join(", ")}`);
    assert.equal(done!.steps[0].attemptId, ids[1], "the first step's record holds its last attempt");
    assert.equal(done!.steps[1].attemptId, ids[2]);
  });
});

test("work started over in a fresh sandbox inside one attempt is a new id too", async () => {
  const ids: (string | undefined)[] = [];
  const fake: Fake = async (args) => {
    ids.push(idOf(args));
    if (ids.length === 1) {
      return {
        status: "failed", result: null, costUsd: 0, image: { variant: "slim" as const, why: "browses through the account's browser pod", pod: true },
        browserPod: { reconnects: 3, reconnected: 0, lost: { cause: "lost", detail: "ECONNREFUSED" }, writes: [] },
      };
    }
    return { status: "completed", result: "found it", costUsd: 0, image: { variant: "full", why: "re-run after the browser pod was lost" } };
  };
  await withFake(fake, async () => {
    const run = startFlowRun("acme", "desk", [step()], "f");
    const { run: done } = await waitForRun("acme", "desk", run.id, 20_000);
    assert.equal(done?.status, "completed");
    assert.equal(ids.length, 2, "the slim go, then the full re-run");
    assert.equal(done!.steps[0].attempts, 1, "one attempt on the record");
    assert.notEqual(ids[0], ids[1], "the re-run cannot pass on what the lost go left");
    assert.equal(done!.steps[0].attemptId, ids[1]);
  });
});

test("a drive re-attaching to a live sandbox keeps the attempt's id", async () => {
  const calls: RunInContainerArgs[] = [];
  const fake: Fake = async (args) => {
    calls.push(args);
    return { status: "completed", result: "carried on", costUsd: 0 };
  };
  await withFake(fake, async () => {
    const run = createFlowRun("acme", "desk", [step({ retry: 1 })], "f", "running");
    run.steps[0].status = "running";
    run.steps[0].attempts = 1;
    run.steps[0].attemptId = "att_0123456789abcdef01";
    run.steps[0].sandbox = { kind: "fake", ref: "pod-abc", consumed: 2, since: new Date().toISOString() };
    writeRun("acme", "desk", run);
    await driveRun("acme", "desk", readRun("acme", "desk", run.id)!);
    const done = readRun("acme", "desk", run.id)!;
    assert.equal(done.status, "completed");
    assert.equal(calls.length, 1);
    assert.ok(calls[0].resume, "re-attached");
    assert.equal(done.steps[0].attemptId, "att_0123456789abcdef01", "the sandbox still holds the id it was started with");
  });
});

test("a go sent back for room takes no id: the record stays on the attempt that ran", async () => {
  const ids: (string | undefined)[] = [];
  const fake: Fake = async (args) => {
    ids.push(idOf(args));
    args.room!.waiting("the account's pool is full");
    if (args.room!.mayDefer()) return { status: "failed", deferred: "the account's pool is full", result: null, costUsd: null };
    throw new Error("expected to be allowed to wait in the queue");
  };
  const prev = process.env.FOLDRUN_ROOM_PARK_AFTER_SEC;
  process.env.FOLDRUN_ROOM_PARK_AFTER_SEC = "0";
  try {
    await withFake(fake, async () => {
      const run = createFlowRun("acme", "desk", [step({ retry: 1 })], "f", "running");
      run.steps[0].attemptId = "att_0123456789abcdef01";
      writeRun("acme", "desk", run);
      await driveRun("acme", "desk", readRun("acme", "desk", run.id)!, null, [], { parkOnApproval: true });
      const parked = readRun("acme", "desk", run.id)!;
      assert.equal(parked.steps[0].status, "pending");
      assert.equal(ids.length, 1);
      assert.notEqual(ids[0], "att_0123456789abcdef01", "the go that asked had its own");
      assert.equal(parked.steps[0].attemptId, "att_0123456789abcdef01", "nothing ran under the new one");
    });
  } finally {
    if (prev === undefined) delete process.env.FOLDRUN_ROOM_PARK_AFTER_SEC;
    else process.env.FOLDRUN_ROOM_PARK_AFTER_SEC = prev;
  }
});

test("a declared secret of the same name does not stand in for the id", async () => {
  const seen: Record<string, string | undefined>[] = [];
  const fake: Fake = async (args) => {
    seen.push({ id: idOf(args), other: args.env.OTHER_TOKEN });
    return { status: "completed", result: "done", costUsd: 0 };
  };
  await withFake(fake, async () => {
    setSecret("acme", "FOLDRUN_STEP_ATTEMPT_ID", "att_forged");
    setSecret("acme", "OTHER_TOKEN", "plain-value");
    const run = startFlowRun("acme", "desk", [step()], "f");
    const { run: done } = await waitForRun("acme", "desk", run.id, 20_000);
    assert.equal(done?.status, "completed", JSON.stringify(done?.steps[0].events.slice(-3)));
    assert.equal(seen[0].other, "plain-value", "declared secrets do reach the sandbox");
    assert.match(seen[0].id ?? "", /^att_[0-9a-f]{18}$/);
    assert.equal(done!.steps[0].attemptId, seen[0].id);
  }, "---\nname: worker\ndescription: works\nsecrets: [FOLDRUN_STEP_ATTEMPT_ID, OTHER_TOKEN]\n---\n\nWork.\n");
});

// In process a step's tools are built once and its work can start over
// (another model supply, a provider waited out): the id is read when a tool
// runs, not when it was built.
test("a tool's environment reads the id of the go it runs in, over anything of the same name", () => {
  const attempt: { id: string | undefined } = { id: "att_one" };
  const env = withAttemptId({ FOLDRUN_STEP_ATTEMPT_ID: "att_forged", KEEP: "1" } as Record<string, string>, attempt);
  assert.deepEqual({ ...env }, { FOLDRUN_STEP_ATTEMPT_ID: "att_one", KEEP: "1" });
  attempt.id = "att_two";
  assert.equal({ ...env }.FOLDRUN_STEP_ATTEMPT_ID, "att_two", "the next go's, with the tool built once");
  assert.deepEqual({ ...withAttemptId({ KEEP: "1" } as Record<string, string>, undefined) }, { KEEP: "1" }, "no attempt, no name");
});
