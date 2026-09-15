// An eval's run goes through the platform's queue whenever a platform owns
// one — whatever process asks.
//
// The old test was FOLDRUN_ROLE === "web". On a worker the role says
// "worker", so the eval started its run in-process and walked around the
// queue every other run passes through: the account cap, the lanes, the
// per-pod lease. The seam is the fact; the role was a guess about it.
//
//   node --test tests/eval-queue.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { runEval, type EvalInfo } from "../src/evals.ts";
import { writeRun, type RunRecord } from "../src/store.ts";
import { registerPlatform, resetPlatform, platformQueues } from "../src/platform.ts";

function withWorkspace(run: (tenant: string, ws: string) => Promise<void>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-evalq-"));
  const prev = { data: process.env.FOLDRUN_DATA, role: process.env.FOLDRUN_ROLE };
  process.env.FOLDRUN_DATA = root;
  return (async () => {
    try {
      const ws = path.join(root, "acme/workspaces/desk");
      fs.mkdirSync(path.join(ws, "agents/writer"), { recursive: true });
      fs.mkdirSync(path.join(ws, "runs"), { recursive: true });
      fs.writeFileSync(path.join(ws, "AGENTS.md"), "---\nname: desk\n---\n");
      fs.writeFileSync(path.join(ws, "agents/writer/agent.md"), "---\nname: writer\ndescription: writes\n---\n\nWrite.\n");
      await run("acme", "desk");
    } finally {
      resetPlatform();
      for (const [k, v] of [["FOLDRUN_DATA", prev.data], ["FOLDRUN_ROLE", prev.role]] as const) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      fs.rmSync(root, { recursive: true, force: true });
    }
  })();
}

const info: EvalInfo = {
  name: "writer-quality",
  file: "writer-quality.md",
  agent: "writer",
  flow: null,
  cases: [{ name: "says hello", task: "say hello", expect: [{ type: "contains", value: "hello" }] }],
} as unknown as EvalInfo;

test("on a worker — role set, platform registered — the eval's run is enqueued, not driven here", () =>
  withWorkspace(async (tenant, ws) => {
    process.env.FOLDRUN_ROLE = "worker";
    const enqueued: string[] = [];
    registerPlatform({
      async enqueueFlowRun(t, w, steps, flowName, _model, _tags, _by, opts) {
        enqueued.push(flowName);
        const run: RunRecord = {
          id: "run-queued-1",
          flow: flowName,
          status: "completed",
          startedAt: new Date().toISOString(),
          finishedAt: new Date().toISOString(),
          test: opts?.test,
          steps: steps.map((s) => ({
            agent: s.agent, instruction: s.instruction, group: s.group, optional: s.optional,
            status: "completed" as const, events: [], result: "hello from the queue", costUsd: 0,
          })),
        };
        writeRun(t, w, run);
        return run;
      },
    });
    assert.ok(platformQueues(), "a registered enqueueFlowRun means the platform owns the queue");
    const result = await runEval(tenant, ws, info);
    assert.deepEqual(enqueued, ["eval:writer-quality"], "the run went through the platform's queue");
    assert.equal(result.passed, 1);
    assert.equal(result.cases[0].runId, "run-queued-1");
  }));

test("with no platform registered, nothing is queued — the local default is the in-process start", () => {
  resetPlatform();
  assert.equal(platformQueues(), false);
});
