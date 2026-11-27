// A verify result that ends the whole run (FOL-450).
//
// A failed `verify:` fails the step; `retry:` then runs it again and
// `on-fail:` hands it to a rescuer. A check that finds something no further
// attempt can mend (evidence from another attempt, wrong inputs, a broken
// invariant) had no way to say so: every retry and the rescue still ran.
// A shell check now writes one line, the reason, to the file named in
// FOLDRUN_FAIL_RUN_FILE and exits non-zero. An exit code was not used:
// codes already mean things to shells and tools, and a stray one must not
// end a run.
//
//   node --test tests/verify-fail-run.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createFlowRun, driveRun, startFlowRun, waitForRun, runEndedByCheck, FAIL_RUN_REASON_MAX } from "../src/runner.ts";
import { readRun, writeRun, type FlowStep } from "../src/store.ts";
import { checkVerify, FAIL_RUN_FILE_ENV } from "../src/step-exec.ts";
import { registerPlatform, platform } from "../src/platform.ts";
import { parseDriverLine, type RunInContainerArgs, type ContainerStepOutcome } from "../src/run-container.ts";

type Fake = (args: RunInContainerArgs) => Promise<ContainerStepOutcome>;

async function withFake(fake: Fake, body: (ws: string) => Promise<void>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-failrun-"));
  const prev = { data: process.env.FOLDRUN_DATA, iso: process.env.FOLDRUN_RUN_ISOLATION, base: process.env.FOLDRUN_RETRY_BASE_MS };
  process.env.FOLDRUN_DATA = root;
  process.env.FOLDRUN_RUN_ISOLATION = "fake";
  process.env.FOLDRUN_RETRY_BASE_MS = "20";
  const prevIso = platform.isolation;
  registerPlatform({ isolation: { fake } });
  try {
    const ws = path.join(root, "acme/workspaces/desk");
    fs.mkdirSync(path.join(ws, "runs"), { recursive: true });
    fs.writeFileSync(path.join(ws, "AGENTS.md"), "---\nname: desk\n---\n");
    for (const a of ["worker", "fixer", "later"]) {
      fs.mkdirSync(path.join(ws, "agents", a), { recursive: true });
      fs.writeFileSync(path.join(ws, "agents", a, "agent.md"), `---\nname: ${a}\ndescription: works\n---\n\nWork.\n`);
    }
    await body(ws);
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
const agentOf = (args: RunInContainerArgs) => String(args.input.agentRel).split("/").pop()!;
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-failrun-check-"));

// ------------------------------------------------------------ the check

test("the name is FOLDRUN_FAIL_RUN_FILE", () => assert.equal(FAIL_RUN_FILE_ENV, "FOLDRUN_FAIL_RUN_FILE"));

test("a shell check that writes a reason and exits non-zero ends the run; the first line is the reason", async () => {
  const dir = tmp();
  try {
    const v = await checkVerify(dir, 'printf "\\n  the mark is from another attempt  \\nmore\\n" > "$FOLDRUN_FAIL_RUN_FILE"; exit 3', { env: {}, result: null });
    assert.equal(v.ok, false);
    assert.equal(v.headline, "exit 3");
    assert.equal(v.failRun, "the mark is from another attempt");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a check that passes ends nothing, whatever it wrote; a failed one that wrote nothing only fails the step", async () => {
  const dir = tmp();
  try {
    const passed = await checkVerify(dir, 'echo stop > "$FOLDRUN_FAIL_RUN_FILE"; exit 0', { env: {}, result: null });
    assert.equal(passed.ok, true);
    assert.equal(passed.failRun, undefined);
    const plain = await checkVerify(dir, "exit 1", { env: {}, result: null });
    assert.equal(plain.ok, false);
    assert.equal(plain.failRun, undefined);
    const blank = await checkVerify(dir, 'printf "  \\n" > "$FOLDRUN_FAIL_RUN_FILE"; exit 1', { env: {}, result: null });
    assert.equal(blank.failRun, undefined, "a blank file is not a reason");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the file is the check's own: a new path each time, a caller's value of the name is not used, and a link is not read through", async () => {
  const dir = tmp();
  try {
    const planted = path.join(dir, "planted");
    fs.writeFileSync(planted, "left by the step\n");
    // The step cannot pre-write it: the name the caller's env gives is replaced.
    const v = await checkVerify(dir, 'test "$FOLDRUN_FAIL_RUN_FILE" != "$PLANTED" && test ! -e "$FOLDRUN_FAIL_RUN_FILE"; exit 1', { env: { [FAIL_RUN_FILE_ENV]: planted, PLANTED: planted }, result: null });
    assert.equal(v.failRun, undefined, v.detail);
    const linked = await checkVerify(dir, 'ln -s "$PLANTED" "$FOLDRUN_FAIL_RUN_FILE"; exit 1', { env: { PLANTED: planted }, result: null });
    assert.equal(linked.failRun, undefined, "a link in its place is not a reason");
    const long = await checkVerify(dir, `printf '%s' "${"x".repeat(900)}" > "$FOLDRUN_FAIL_RUN_FILE"; exit 1`, { env: {}, result: null });
    assert.equal(long.failRun?.length, 900, "whole here: the runner scrubs secrets from it before cutting it");
    const huge = await checkVerify(dir, `head -c 3000000 /dev/zero | tr '\\0' 'y' > "$FOLDRUN_FAIL_RUN_FILE"; exit 1`, { env: {}, result: null });
    assert.equal(huge.failRun?.length, 1000, "only the start of the file is ever read");
    const pipe = await checkVerify(dir, 'rm -f "$FOLDRUN_FAIL_RUN_FILE"; mkfifo "$FOLDRUN_FAIL_RUN_FILE"; exit 1', { env: {}, result: null });
    assert.equal(pipe.failRun, undefined, "a pipe in its place is not read, and does not hold the step");
    const killed = await checkVerify(dir, 'echo stop > "$FOLDRUN_FAIL_RUN_FILE"; kill -9 $$', { env: {}, result: null });
    assert.equal(killed.ok, false);
    assert.equal(killed.failRun, undefined, "a check a signal ended did not finish saying anything");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the verdict crosses the sandbox boundary only beside a failure", () => {
  const failed = parseDriverLine(JSON.stringify({ e: "done", status: "failed", result: null, costUsd: 0, failRun: "  wrong inputs  " })) as ContainerStepOutcome;
  assert.equal(failed.failRun, "wrong inputs");
  const done = parseDriverLine(JSON.stringify({ e: "done", status: "completed", result: "ok", costUsd: 0, failRun: "wrong inputs" })) as ContainerStepOutcome;
  assert.equal(done.failRun, undefined);
  const noStatus = parseDriverLine(JSON.stringify({ e: "done", result: null, costUsd: 0, failRun: "wrong inputs" })) as ContainerStepOutcome;
  assert.equal(noStatus.status, "failed");
  assert.equal(noStatus.failRun, undefined, "only a driver that said failed");
  const odd = parseDriverLine(JSON.stringify({ e: "done", status: "failed", result: null, costUsd: 0, failRun: { a: 1 } })) as ContainerStepOutcome;
  assert.equal(odd.failRun, undefined);
});

// ------------------------------------------------------------ the run

test("the run ends: the step's retries are not used, its rescuer is not called, later steps do not run", async () => {
  const ran: string[] = [];
  const fake: Fake = async (args) => {
    ran.push(agentOf(args));
    if (agentOf(args) === "worker") return { status: "failed", result: null, costUsd: 0, failRun: "the mark is from another attempt" };
    return { status: "completed", result: "done", costUsd: 0 };
  };
  await withFake(fake, async () => {
    const run = startFlowRun("acme", "desk", [step({ retry: 2, onFail: "fixer", verify: "exit 1" }), step({ agent: "later", group: 2 })], "f");
    const { run: done } = await waitForRun("acme", "desk", run.id, 20_000);
    assert.equal(done?.status, "failed");
    assert.deepEqual(ran, ["worker"], "one go: no retry, no rescuer, no later step");
    const s = done!.steps[0];
    assert.equal(s.failRun, "the mark is from another attempt");
    assert.equal(s.attempts, 1);
    const said = s.events.map((e) => e.text).join("\n");
    assert.match(said, /not retried — its verify: ended the run \(2 left unused\)/);
    assert.match(said, /not handing to \[\[fixer\]\] \(on-fail\): its verify: ended the run/);
    assert.match(said, /the run ends here: the mark is from another attempt/);
  });
});

test("an optional step that ends the run does not let it go on; one that merely fails still does", async () => {
  for (const failRun of ["wrong inputs", undefined]) {
    const ran: string[] = [];
    const fake: Fake = async (args) => {
      ran.push(agentOf(args));
      if (agentOf(args) === "worker") return { status: "failed", result: null, costUsd: 0, ...(failRun ? { failRun } : {}) };
      return { status: "completed", result: "done", costUsd: 0 };
    };
    await withFake(fake, async () => {
      const run = startFlowRun("acme", "desk", [step({ optional: true, verify: "exit 1" }), step({ agent: "later", group: 2 })], "f");
      const { run: done } = await waitForRun("acme", "desk", run.id, 20_000);
      if (failRun) {
        assert.equal(done?.status, "failed");
        assert.deepEqual(ran, ["worker"]);
      } else {
        assert.equal(done?.status, "completed", "an ordinary failure of an optional step is as before");
        assert.deepEqual(ran, ["worker", "later"]);
        assert.equal(done!.steps[0].failRun, undefined);
      }
    });
  }
});

test("a rescuer owes the step's verify:, and its word ends the run the same", async () => {
  const ran: string[] = [];
  const fake: Fake = async (args) => {
    ran.push(agentOf(args));
    if (agentOf(args) === "worker") return { status: "failed", result: null, costUsd: 0 };
    if (agentOf(args) === "fixer") return { status: "failed", result: null, costUsd: 0, failRun: "nothing left to mend" };
    return { status: "completed", result: "done", costUsd: 0 };
  };
  await withFake(fake, async () => {
    const run = startFlowRun("acme", "desk", [step({ optional: true, onFail: "fixer", verify: "exit 1" }), step({ agent: "later", group: 2 })], "f");
    const { run: done } = await waitForRun("acme", "desk", run.id, 20_000);
    assert.equal(done?.status, "failed");
    assert.deepEqual(ran, ["worker", "fixer"]);
    assert.equal(done!.steps[0].failRun, "nothing left to mend");
  });
});

test("an attempt that ended the run and one that did not: only the last go's word stands", async () => {
  let calls = 0;
  const fake: Fake = async () => {
    calls += 1;
    if (calls === 1) return { status: "failed", result: null, costUsd: 0 };
    return { status: "completed", result: "done", costUsd: 0 };
  };
  await withFake(fake, async () => {
    const run = startFlowRun("acme", "desk", [step({ retry: 1, verify: "exit 1" })], "f");
    const { run: done } = await waitForRun("acme", "desk", run.id, 20_000);
    assert.equal(done?.status, "completed", "an ordinary failed check is retried as before");
    assert.equal(calls, 2);
    assert.equal(done!.steps[0].failRun, undefined);
  });
});

test("which records count: a pending one is another run's, a carried one failed where it came from", () => {
  assert.equal(runEndedByCheck([{ status: "failed", failRun: "x" }]), "x");
  assert.equal(runEndedByCheck([{ status: "running", failRun: "x" }]), "x", "saved before the step is settled");
  assert.equal(runEndedByCheck([{ status: "pending", failRun: "x" }]), null);
  assert.equal(runEndedByCheck([{ status: "skipped", failRun: "x" }]), null);
  assert.equal(runEndedByCheck([{ status: "failed" }]), null);
});

test("the reason on the record is one short line, and a step run again starts without the old one", async () => {
  let calls = 0;
  const fake: Fake = async () => {
    calls += 1;
    return calls === 1 ? { status: "failed", result: null, costUsd: 0, failRun: "z".repeat(900) } : { status: "completed", result: "done", costUsd: 0 };
  };
  await withFake(fake, async () => {
    const run = startFlowRun("acme", "desk", [step({ verify: "exit 1" })], "f");
    const { run: done } = await waitForRun("acme", "desk", run.id, 20_000);
    assert.equal(done!.steps[0].failRun?.length, FAIL_RUN_REASON_MAX);
    // A re-run copies the record it starts from: pending, with the old word on it.
    const again = createFlowRun("acme", "desk", [step({ verify: "exit 1" }), step({ agent: "later", group: 2 })], "f", "running");
    again.steps[0].failRun = "the earlier run's";
    writeRun("acme", "desk", again);
    await driveRun("acme", "desk", readRun("acme", "desk", again.id)!);
    const redone = readRun("acme", "desk", again.id)!;
    assert.equal(redone.status, "completed");
    assert.equal(redone.steps[0].failRun, undefined);
    assert.equal(calls, 3);
  });
});

test("a step beside it is not retried or rescued once the run is ended, and one waiting never starts", async () => {
  const ran: string[] = [];
  const fake: Fake = async (args) => {
    const who = agentOf(args);
    ran.push(who);
    if (who === "worker") return { status: "failed", result: null, costUsd: 0, failRun: "wrong inputs" };
    // The sibling fails a moment later, in the ordinary way.
    await new Promise((r) => setTimeout(r, 150));
    return { status: "failed", result: null, costUsd: 0 };
  };
  await withFake(fake, async () => {
    const run = startFlowRun("acme", "desk", [step({ verify: "exit 1" }), step({ agent: "later", retry: 2, onFail: "fixer" })], "f");
    const { run: done } = await waitForRun("acme", "desk", run.id, 20_000);
    assert.equal(done?.status, "failed");
    assert.deepEqual(ran.sort(), ["later", "worker"], "no retry of the sibling, no rescuer");
    const said = done!.steps.find((s) => s.agent === "later")!.events.map((e) => e.text).join("\n");
    assert.match(said, /not retried — another step's verify: ended the run \(2 left unused\)/);
    assert.match(said, /not handing to \[\[fixer\]\] \(on-fail\): another step's verify: ended the run/);
  });
});

test("a worker that died after the check spoke: the next driver fails the step, and does not run it again", async () => {
  const ran: string[] = [];
  const fake: Fake = async (args) => {
    ran.push(agentOf(args));
    return { status: "completed", result: "done", costUsd: 0 };
  };
  await withFake(fake, async () => {
    const run = createFlowRun("acme", "desk", [step({ retry: 1, onFail: "fixer", verify: "exit 1" }), step({ agent: "later", group: 2 })], "f", "running");
    run.steps[0].status = "running";
    run.steps[0].attempts = 1;
    run.steps[0].failRun = "wrong inputs";
    writeRun("acme", "desk", run);
    await driveRun("acme", "desk", readRun("acme", "desk", run.id)!);
    const done = readRun("acme", "desk", run.id)!;
    assert.equal(done.status, "failed");
    assert.deepEqual(ran, [], "nothing ran: not the step, not its rescuer, not the next step");
    assert.equal(done.steps[0].status, "failed");
    assert.equal(done.steps[0].failRun, "wrong inputs");
  });
});

test("a re-run that carries a failed step: its old word is dropped, and its rescuer's new one ends this run", async () => {
  for (const rescuerEnds of [true, false]) {
    const ran: string[] = [];
    const fake: Fake = async (args) => {
      ran.push(agentOf(args));
      if (agentOf(args) === "fixer") return rescuerEnds ? { status: "failed", result: null, costUsd: 0, failRun: "still wrong" } : { status: "completed", result: "mended", costUsd: 0 };
      return { status: "completed", result: "done", costUsd: 0 };
    };
    await withFake(fake, async () => {
      const run = createFlowRun("acme", "desk", [step({ onFail: "fixer", verify: "exit 1" }), step({ agent: "later", group: 2 })], "f", "running");
      run.steps[0].status = "failed";
      run.steps[0].carriedFrom = "run-earlier";
      run.steps[0].failRun = "the earlier run's";
      writeRun("acme", "desk", run);
      await driveRun("acme", "desk", readRun("acme", "desk", run.id)!);
      const done = readRun("acme", "desk", run.id)!;
      if (rescuerEnds) {
        assert.equal(done.status, "failed", "never completed after a verdict");
        assert.deepEqual(ran, ["fixer"]);
        assert.equal(done.steps[0].failRun, "still wrong");
      } else {
        assert.notEqual(done.steps[0].failRun, "the earlier run's", "the earlier run's word ends nothing here");
        assert.ok(ran.includes("fixer"));
      }
    });
  }
});
