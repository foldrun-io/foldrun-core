// Model comparisons — one eval's cases under several settings.
//
//   node --test tests/eval-compare.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.FOLDRUN_HISTORY = "journal";

import { parseEval, runEval, type EvalInfo, type EvalRunOptions, type EvalResult } from "../src/evals.ts";
import { planComparison, compareEval, MAX_TRIALS } from "../src/eval-compare.ts";

const EVAL = `---\nname: writer-quality\nagent: writer\nmodel: fast\n---\n\n## one\ntask: a\nexpect:\n  - contains: x\n\n## two\ntask: b\nexpect:\n  - contains: y\n`;
const info = parseEval("w.md", EVAL);

test("planComparison: two to four settings, repeat 1–5, a cap on runs and on spend", () => {
  const plan = planComparison(info, { configs: [{ model: "fast" }, { model: "max", effort: "high" }], repeat: 2 });
  assert.equal(plan.trials, 2 * 2 * 2);
  assert.equal(plan.maxUsd, 5);
  assert.equal(plan.configs[1].effort, "high");
  const bad = (body: unknown, re: RegExp, i: EvalInfo = info) => assert.throws(() => planComparison(i, body), re);
  bad({ configs: [{ model: "fast" }] }, /two to four/);
  bad({ configs: [1, 2, 3, 4, 5].map((n) => ({ model: `m${n}` })) }, /at most 4/);
  bad({ configs: [{ model: "fast" }, { model: "fast" }] }, /the same/);
  bad({ configs: [{ model: "fast" }, { model: "max", effort: "huge" }] }, /effort is/);
  bad({ configs: [{ model: "fast" }, { model: "max" }], repeat: 9 }, /1 to 5/);
  bad({ configs: [{ model: "fast" }, { model: "max" }], maxUsd: 0 }, /spend limit/);
  bad({ configs: [{ model: "fast", agent: "writer" }, { model: "max" }] }, /picks one agent's steps of a flow eval/);
  bad({ configs: [{ model: "fast; rm -rf" }, { model: "max" }] }, /tier/);
  const big = parseEval("b.md", `---\nagent: w\n---\n${Array.from({ length: 16 }, (_, i) => `\n## c${i}\ntask: t\nexpect:\n  - contains: x\n`).join("")}`);
  assert.throws(() => planComparison(big, { configs: [{ model: "a" }, { model: "b" }], repeat: 2 }), (e: Error & { status?: number }) => e.status === 413 && new RegExp(`at most ${MAX_TRIALS}`).test(e.message));
  bad({ configs: [{ model: "a" }, { model: "b" }] }, /run: check/, parseEval("r.md", "---\nagent: w\n---\n\n## c\ntask: t\nexpect:\n  - run: ./deploy.sh\n"));
  bad({ configs: [{ model: "a" }, { model: "b" }] }, /grades real runs/, parseEval("g.md", "---\nagent: w\ntrigger: runs\n---\n\n## c\nexpect:\n  - contains: x\n"));
});

/** A runner that passes case one only on "max", costs $0.10 a run and $0.01 a judge, 2s a run. */
function fakeRun(seen: EvalRunOptions[]) {
  return (async (_t: string, _w: string, i: EvalInfo, opts: EvalRunOptions = {}): Promise<EvalResult> => {
    seen.push(opts);
    const cases = i.cases.map((c) => {
      const stop = opts.beforeCase?.();
      if (stop) return { name: c.name, task: c.task, runId: null, passed: false, error: `not run — ${stop}`, assertions: [], costUsd: 0, judgeCostUsd: 0, secs: null };
      const passed = c.name === "two" || opts.model === "max";
      const done = { name: c.name, task: c.task, runId: `run-${opts.model}-${c.name}-${seen.length}`, passed, error: null, assertions: [{ assertion: c.expect[0], passed, detail: "" }], costUsd: 0.1, judgeCostUsd: 0.01, secs: 2 };
      opts.afterCase?.(done);
      return done;
    });
    return { eval: i.name, startedAt: "", finishedAt: "", passed: cases.filter((c) => c.passed).length, failed: cases.filter((c) => !c.passed).length, costUsd: 0.2, cases };
  }) as typeof runEval;
}

test("compareEval: forced model, always a test run, results per setting and per case, repeats interleaved", async () => {
  const seen: EvalRunOptions[] = [];
  const plan = planComparison(info, { configs: [{ model: "fast" }, { model: "max", effort: "high" }], repeat: 2 });
  const progress: number[] = [];
  const r = await compareEval("t", "w", info, plan, { run: fakeRun(seen), onProgress: (d) => { progress.push(d); } });
  assert.deepEqual(seen.map((o) => o.model), ["fast", "max", "fast", "max"], "each setting once, then again");
  assert.ok(seen.every((o) => o.forceTest === true));
  assert.equal(seen[1].effort, "high");
  assert.deepEqual(progress, [2, 4, 6, 8]);
  const [fast, max] = r.configs;
  assert.equal(fast.passed, 2);
  assert.equal(fast.rate, 0.5);
  assert.equal(max.rate, 1);
  assert.equal(max.costUsd, 0.44, "four runs and four judges");
  assert.equal(max.avgCostUsd, 0.11);
  assert.equal(max.avgSecs, 2);
  assert.equal(max.runIds.length, 4);
  assert.deepEqual(r.cases.find((c) => c.case === "one"), { case: "one", passed: [0, 2], trials: [2, 2] });
  assert.equal(r.stopped, null);
  assert.equal(r.judge.model, info.model, "one judge for every setting");
});

test("the spend limit holds between the cases of one setting, not only after it", async () => {
  // Two cases, one setting at a time: the first case alone spends $0.11 of a $0.05 limit.
  const plan = planComparison(info, { configs: [{ model: "fast" }, { model: "max" }], maxUsd: 0.05 });
  const r = await compareEval("t", "w", info, plan, { run: fakeRun([]) });
  assert.equal(r.configs[0].runIds.length, 1, "the second case of the first setting never starts");
  assert.equal(r.configs[1].runIds.length, 0);
  assert.ok(r.spentUsd <= 0.11 + 1e-9);
});

test("compareEval stops starting runs once the spend limit is reached", async () => {
  const plan = planComparison(info, { configs: [{ model: "fast" }, { model: "max" }], repeat: 3, maxUsd: 0.3 });
  const r = await compareEval("t", "w", info, plan, { run: fakeRun([]) });
  assert.match(r.stopped ?? "", /spend limit of \$0.30/);
  const ran = r.configs.reduce((n, c) => n + c.runIds.length, 0);
  assert.ok(ran < plan.trials, `stopped early: ${ran} of ${plan.trials}`);
  assert.ok(r.configs.some((c) => c.notRun > 0));
});

test("runEval forces the model onto a flow eval's steps, all of them or one agent's", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-compare-"));
  const prev = process.env.FOLDRUN_DATA;
  process.env.FOLDRUN_DATA = root;
  try {
    const ws = path.join(root, "acme", "workspaces", "desk");
    fs.mkdirSync(path.join(ws, "flows"), { recursive: true });
    fs.writeFileSync(path.join(ws, "flows", "pub.md"), "---\nmodel: default\n---\n\n1. [[writer]] — Write.\n   model: max\n   effort: high\n2. [[editor]] — Edit.\n");
    const flowEval = parseEval("f.md", "---\nflow: pub\n---\n\n## c\ntask: t\nexpect:\n  - contains: x\n");
    // Through the queue hook: the steps a platform would be handed are what
    // is checked, and the run never starts (the fake refuses it).
    const { registerPlatform, resetPlatform } = await import("../src/platform.ts");
    const seen: { model?: string; agent: string }[][] = [];
    const efforts: (string | null)[][] = [];
    registerPlatform({
      enqueueFlowRun: (async (_t: string, _w: string, steps: { model?: string; agent: string }[]) => {
        seen.push(steps.map((s) => ({ model: s.model, agent: s.agent })));
        efforts.push(steps.map((s) => (s as { effort?: string }).effort ?? null));
        throw new Error("no worker in this test");
      }) as never,
    });
    try {
      const all = await runEval("acme", "desk", flowEval, { model: "fast", forceTest: true });
      assert.match(all.cases[0].error ?? "", /no worker in this test/);
      await runEval("acme", "desk", flowEval, { model: "fast", agent: "editor", forceTest: true });
    } finally {
      resetPlatform();
    }
    assert.deepEqual(seen[0], [{ model: "fast", agent: "writer" }, { model: "fast", agent: "editor" }], "every step, over the step's own model:");
    assert.deepEqual(seen[1], [{ model: "max", agent: "writer" }, { model: "fast", agent: "editor" }], "only the named agent's steps");
    assert.equal(efforts[0][0], "high", "a model-only setting keeps the step's own effort");
  } finally {
    if (prev === undefined) delete process.env.FOLDRUN_DATA;
    else process.env.FOLDRUN_DATA = prev;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
