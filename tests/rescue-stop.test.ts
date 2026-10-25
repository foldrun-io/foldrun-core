// Two failures from 21 Oct 2026, through a fake executor the way
// retry-resume.test.ts drives one:
//
// - A worker that died mid-rescue left its rescue record pending; the drive
//   that resumed launched it as an ordinary member of the group and then
//   rescued the step again, one new record per restart (blog-desk
//   run-mvh1zra7-ae4k collected ~80 fixers).
// - A stop written by another process did not stop a group: the driver's
//   save() put the record back to `running` with its steps pending, and a
//   step still waiting for room started its pod anyway (medium-desk
//   run-mvho48wp-99e1, stopped twice, ended only by deleting pods by hand).

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createFlowRun, driveRun } from "../src/runner.ts";
import { readRun, writeRun, type FlowStep, type StepRecord } from "../src/store.ts";
import { registerPlatform, platform } from "../src/platform.ts";
import type { RunInContainerArgs, ContainerStepOutcome } from "../src/run-container.ts";

type Fake = (args: RunInContainerArgs) => Promise<ContainerStepOutcome>;

async function withFake(fake: Fake, agents: string[], body: (ws: string) => Promise<void>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-rescue-"));
  const prev = { data: process.env.FOLDRUN_DATA, iso: process.env.FOLDRUN_RUN_ISOLATION };
  process.env.FOLDRUN_DATA = root;
  process.env.FOLDRUN_RUN_ISOLATION = "fake";
  const prevIso = platform.isolation;
  const prevRes = platform.sandboxResumable;
  registerPlatform({ isolation: { fake }, sandboxResumable: () => false });
  try {
    const ws = path.join(root, "acme/workspaces/desk");
    fs.mkdirSync(path.join(ws, "runs"), { recursive: true });
    fs.writeFileSync(path.join(ws, "AGENTS.md"), "---\nname: desk\n---\n");
    for (const a of agents) {
      fs.mkdirSync(path.join(ws, "agents", a), { recursive: true });
      fs.writeFileSync(path.join(ws, "agents", a, "agent.md"), `---\nname: ${a}\ndescription: ${a}\n---\n\nDo it.\n`);
    }
    await body(ws);
  } finally {
    registerPlatform({ isolation: prevIso, sandboxResumable: prevRes });
    for (const [k, v] of [["FOLDRUN_DATA", prev.data], ["FOLDRUN_RUN_ISOLATION", prev.iso]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const agentOf = (args: RunInContainerArgs) => String(args.input.agentRel).split("/").pop();
const step = (agent: string, extra: Partial<FlowStep> = {}): FlowStep => ({ agent, instruction: "work", group: 1, optional: false, ...extra });

test("a resumed run picks up the leftover rescue once, and launches none of them as group steps", async () => {
  const ran: string[] = [];
  const fake: Fake = async (args) => {
    ran.push(agentOf(args)!);
    return agentOf(args) === "worker" ? { status: "failed", result: "BAD", costUsd: 0 } : { status: "completed", result: "fixed", costUsd: 0 };
  };
  await withFake(fake, ["worker", "fixer"], async () => {
    // What a crash loop left: the step failed, three rescue records behind
    // it from three dead drives (old format: no rescueOf, the marker only).
    const run = createFlowRun("acme", "desk", [step("worker", { onFail: "fixer" })], "f", "running");
    run.steps[0].status = "failed";
    const leftover = (): StepRecord => ({
      agent: "fixer",
      instruction: "work\n\n<rescue>\nYou are taking this step over: [[worker]] attempted it and failed. Its failure, for whatever it is worth:\nBAD\n</rescue>",
      group: 1, optional: false, attempts: 0, status: "pending", events: [], result: null, costUsd: null,
    });
    run.steps.push(leftover(), leftover(), leftover());
    writeRun("acme", "desk", run);

    await driveRun("acme", "desk", readRun("acme", "desk", run.id)!);
    const done = readRun("acme", "desk", run.id)!;
    assert.deepEqual(ran, ["fixer"], "one rescue ran; no leftover was launched as a group member, and the worker was not re-run");
    assert.equal(done.steps.filter((s) => s.agent === "fixer").length, 3, "no fourth rescue was spliced in");
    assert.equal(done.steps[0].status, "completed", "the resumed rescue's success stands as the step's");
    assert.equal(done.steps.filter((s) => s.skipReason?.startsWith("superseded on resume")).length, 2);
    assert.equal(done.status, "completed", done.steps.map((s) => `${s.agent}:${s.status}`).join(","));
  });
});

test("a new rescue is marked rescueOf, and a finished one is never reused for a later failure", async () => {
  let fixes = 0;
  const fake: Fake = async (args) => {
    if (agentOf(args) === "fixer") fixes++;
    return { status: "failed", result: "BAD", costUsd: 0 };
  };
  await withFake(fake, ["worker", "fixer"], async () => {
    const run = createFlowRun("acme", "desk", [step("worker", { onFail: "fixer" })], "f", "running");
    // An earlier failure's rescue, finished (an evaluator loop's previous
    // cycle): it answered that failure, not this one.
    run.steps[0].status = "failed";
    run.steps.push({
      agent: "fixer", rescueOf: "worker", instruction: "work\n\n<rescue>\nYou are taking this step over: [[worker]] attempted it and failed.\n</rescue>",
      group: 1, optional: false, attempts: 1, status: "completed", events: [], result: "fixed last cycle", costUsd: 0,
    });
    writeRun("acme", "desk", run);
    await driveRun("acme", "desk", readRun("acme", "desk", run.id)!);
    const done = readRun("acme", "desk", run.id)!;
    assert.equal(fixes, 1, "this failure got its own rescue");
    const rescues = done.steps.filter((s) => s.agent === "fixer");
    assert.equal(rescues.length, 2);
    assert.ok(rescues.every((r) => r.rescueOf === "worker"));
    assert.equal(done.steps[0].status, "failed", "the old rescue's success did not stand for the new failure");
    assert.equal(done.status, "failed");
  });
});

test("a stop from another process ends the group: no step starts, and no save writes the run back to running", async () => {
  let stopped = false;
  let sawStopWhileWaiting = false;
  const fake: Fake = async (args) => {
    if (agentOf(args) === "c") {
      // Waiting for room, as the k8s executor does before its pod exists:
      // it asks the run whether it was stopped.
      for (let i = 0; i < 300; i++) {
        if (args.stopRequested?.()) {
          sawStopWhileWaiting = true;
          return { status: "failed", result: null, costUsd: 0, reason: "stopped while waiting for room to start" };
        }
        await new Promise((r) => setTimeout(r, 10));
      }
      return { status: "completed", result: "started after all", costUsd: 0 };
    }
    while (!stopped) await new Promise((r) => setTimeout(r, 10));
    await new Promise((r) => setTimeout(r, 50));
    return { status: "failed", result: null, costUsd: 0 };
  };
  await withFake(fake, ["a", "b", "c"], async () => {
    const run = createFlowRun("acme", "desk", [step("a"), step("b"), step("c"), step("a", { group: 2 })], "f", "running");
    const drive = driveRun("acme", "desk", readRun("acme", "desk", run.id)!);
    await new Promise((r) => setTimeout(r, 300));

    // What stopRun writes, from the web tier.
    const rec = readRun("acme", "desk", run.id)!;
    rec.status = "failed";
    rec.stopRequested = true;
    rec.finishedAt = new Date().toISOString();
    for (const s of rec.steps) if (s.status === "pending" || s.status === "running") { s.status = "skipped"; s.skipReason = "run stopped"; }
    writeRun("acme", "desk", rec);
    stopped = true;

    const seen = new Set<string>();
    const watch = setInterval(() => seen.add(readRun("acme", "desk", run.id)!.status), 5);
    await drive;
    clearInterval(watch);
    const done = readRun("acme", "desk", run.id)!;
    assert.ok(sawStopWhileWaiting, "the waiting step was told about the stop");
    assert.ok(!seen.has("running"), `the record went back to running after the stop: ${[...seen].join(",")}`);
    assert.equal(done.status, "failed");
    assert.equal(done.steps[3].status, "skipped", "the next group never started");
    assert.ok(done.steps.every((s) => s.status !== "pending" && s.status !== "running"), done.steps.map((s) => `${s.agent}:${s.status}`).join(","));
  });
});

test("an evaluator loop's rewind leaves an earlier cycle's rescue as it ended", async () => {
  let cycle = 0;
  const prompts: string[] = [];
  const fake: Fake = async (args) => {
    const a = agentOf(args);
    if (a === "fixer") prompts.push(String(args.input.prompt));
    if (a === "worker") return { status: "failed", result: `BAD ${++cycle}`, costUsd: 0 };
    if (a === "fixer") return { status: "completed", result: `fixed ${cycle}`, costUsd: 0 };
    return { status: "completed", result: "not yet", costUsd: 0 }; // judge never says PASS
  };
  await withFake(fake, ["worker", "fixer", "judge"], async () => {
    const run = createFlowRun("acme", "desk", [
      step("worker", { onFail: "fixer" }),
      step("judge", { group: 2, loop: 1, until: "PASS" }),
    ], "f", "running");
    await driveRun("acme", "desk", readRun("acme", "desk", run.id)!);
    const done = readRun("acme", "desk", run.id)!;
    const rescues = done.steps.filter((s) => s.agent === "fixer");
    assert.equal(prompts.length, 2, "each cycle's failure got a rescue");
    assert.match(prompts[1], /BAD 2/, "the second rescue was told the second failure");
    assert.ok(rescues.every((r) => r.status === "completed"), rescues.map((r) => r.status).join(","));
  });
});

// 23 Oct 2026: a spent weekly window failed every desk's first step, each
// on-fail fixer was then refused the same way, and every issue read "fixer
// also failed" instead of the cap.
const SPENT = "the subscription at api.anthropic.com refused this burst — the 7-day window is 100% used but overage is off (org level disabled); it resets at 16:00 Sydney on Sun 25 Oct";

test("a step refused by a spent model window is not handed to a rescuer on the same supply", async () => {
  const ran: string[] = [];
  const fake: Fake = async (args) => {
    ran.push(agentOf(args)!);
    args.emit("error", SPENT);
    return { status: "failed", result: null, costUsd: 0 };
  };
  await withFake(fake, ["worker", "fixer"], async () => {
    const run = createFlowRun("acme", "desk", [step("worker", { onFail: "fixer" })], "f", "running");
    writeRun("acme", "desk", run);
    await driveRun("acme", "desk", readRun("acme", "desk", run.id)!);
    const done = readRun("acme", "desk", run.id)!;
    assert.deepEqual(ran, ["worker"], "the fixer never started");
    assert.equal(done.status, "failed");
    const errors = done.steps[0].events.filter((e) => e.type === "error");
    assert.equal(errors.at(-1)?.text, SPENT, "the step's last error is still the refusal, so the issue is the cap");
    assert.ok(done.steps[0].events.some((e) => /not handing to \[\[fixer\]\]/.test(e.text)));
  });
});

test("a rescuer with its own provider: block still takes a spent-window failure over", async () => {
  const ran: string[] = [];
  const fake: Fake = async (args) => {
    ran.push(agentOf(args)!);
    if (agentOf(args) === "worker") {
      args.emit("error", SPENT);
      return { status: "failed", result: null, costUsd: 0 };
    }
    return { status: "completed", result: "fixed", costUsd: 0 };
  };
  await withFake(fake, ["worker", "fixer"], async (ws) => {
    fs.writeFileSync(
      path.join(ws, "agents", "fixer", "agent.md"),
      "---\nname: fixer\ndescription: fixer\nprovider:\n  base_url: https://gateway.example.com\n---\n\nFix it.\n",
    );
    const run = createFlowRun("acme", "desk", [step("worker", { onFail: "fixer" })], "f", "running");
    writeRun("acme", "desk", run);
    await driveRun("acme", "desk", readRun("acme", "desk", run.id)!);
    assert.deepEqual(ran, ["worker", "fixer"]);
    assert.equal(readRun("acme", "desk", run.id)!.status, "completed");
  });
});

test("a rescuer on the default supply still takes over from an agent whose own provider was refused (Codex review)", async () => {
  const ran: string[] = [];
  const fake: Fake = async (args) => {
    ran.push(agentOf(args)!);
    if (agentOf(args) === "worker") {
      args.emit("error", SPENT);
      return { status: "failed", result: null, costUsd: 0 };
    }
    return { status: "completed", result: "fixed", costUsd: 0 };
  };
  await withFake(fake, ["worker", "fixer"], async (ws) => {
    fs.writeFileSync(
      path.join(ws, "agents", "worker", "agent.md"),
      "---\nname: worker\ndescription: worker\nprovider:\n  base_url: https://gateway.example.com\n---\n\nWork.\n",
    );
    const run = createFlowRun("acme", "desk", [step("worker", { onFail: "fixer" })], "f", "running");
    writeRun("acme", "desk", run);
    await driveRun("acme", "desk", readRun("acme", "desk", run.id)!);
    assert.deepEqual(ran, ["worker", "fixer"]);
  });
});

test("an ordinary failure is still handed to the rescuer", async () => {
  const ran: string[] = [];
  const fake: Fake = async (args) => {
    ran.push(agentOf(args)!);
    if (agentOf(args) === "worker") {
      args.emit("error", "verify `file: storage/x.txt` → storage/x.txt is missing or empty");
      return { status: "failed", result: null, costUsd: 0 };
    }
    return { status: "completed", result: "fixed", costUsd: 0 };
  };
  await withFake(fake, ["worker", "fixer"], async () => {
    const run = createFlowRun("acme", "desk", [step("worker", { onFail: "fixer" })], "f", "running");
    writeRun("acme", "desk", run);
    await driveRun("acme", "desk", readRun("acme", "desk", run.id)!);
    assert.deepEqual(ran, ["worker", "fixer"]);
  });
});

test("an agent naming the workspace's own provider is on the same supply as one inheriting it (Codex review)", async () => {
  const ran: string[] = [];
  const fake: Fake = async (args) => {
    ran.push(agentOf(args)!);
    args.emit("error", SPENT);
    return { status: "failed", result: null, costUsd: 0 };
  };
  await withFake(fake, ["worker", "fixer"], async (ws) => {
    fs.writeFileSync(path.join(ws, "AGENTS.md"), "---\nname: desk\nprovider:\n  base_url: https://gateway.example.com\n  token: ${GW}\n---\n");
    fs.writeFileSync(
      path.join(ws, "agents", "worker", "agent.md"),
      "---\nname: worker\ndescription: worker\nprovider:\n  token: ${GW}\n  base_url: https://gateway.example.com\n---\n\nWork.\n",
    );
    const run = createFlowRun("acme", "desk", [step("worker", { onFail: "fixer" })], "f", "running");
    writeRun("acme", "desk", run);
    await driveRun("acme", "desk", readRun("acme", "desk", run.id)!);
    assert.deepEqual(ran, ["worker"], "same endpoint and key, other key order: no doomed rescue");
  });
});

test("a step refused by a spent model window is not retried (23 Oct 2026)", async () => {
  const ran: string[] = [];
  const fake: Fake = async (args) => {
    ran.push(agentOf(args)!);
    args.emit("error", SPENT);
    return { status: "failed", result: null, costUsd: 0 };
  };
  await withFake(fake, ["worker"], async () => {
    const run = createFlowRun("acme", "desk", [step("worker", { retry: 2 })], "f", "running");
    writeRun("acme", "desk", run);
    await driveRun("acme", "desk", readRun("acme", "desk", run.id)!);
    const done = readRun("acme", "desk", run.id)!;
    assert.deepEqual(ran, ["worker"], "one attempt, no retries");
    assert.ok(done.steps[0].events.some((e) => /not retried — the model usage cap/.test(e.text)));
  });
});
