// Promote a run to an eval — a finished run's task and conclusion become a
// regression case the eval runner can read back.
//
//   node --test tests/promote-eval.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Journal history, not git: the test wants a file, not a repository.
process.env.FOLDRUN_HISTORY = "journal";

import { promoteRunToEval, listEvals, parseEval } from "../packages/core/src/evals.ts";

function withWorkspace(runs: unknown[], body: (ws: string) => Promise<void> | void) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-promote-"));
  const previous = process.env.FOLDRUN_DATA;
  const previousWs = process.env.FOLDRUN_WORKSPACE;
  process.env.FOLDRUN_DATA = root;
  delete process.env.FOLDRUN_WORKSPACE;
  const ws = path.join(root, "acme/workspaces/desk");
  fs.mkdirSync(path.join(ws, "runs"), { recursive: true });
  for (const r of runs) {
    fs.writeFileSync(
      path.join(ws, "runs", `${(r as { id: string }).id}.json`),
      JSON.stringify(r, null, 2),
    );
  }
  return Promise.resolve(body(ws)).finally(() => {
    if (previous === undefined) delete process.env.FOLDRUN_DATA;
    else process.env.FOLDRUN_DATA = previous;
    if (previousWs !== undefined) process.env.FOLDRUN_WORKSPACE = previousWs;
    fs.rmSync(root, { recursive: true, force: true });
  });
}

const step = (agent: string, instruction: string, status: string, result: string | null = null) => ({
  agent,
  instruction,
  group: 1,
  optional: false,
  status,
  events: [],
  result,
  costUsd: 0.01,
});

const TASK = "Write one line quoting the price of the RG-40.";

const completed = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  flow: "publish",
  status: "completed",
  startedAt: "2026-09-02T01:02:03.000Z",
  finishedAt: "2026-09-02T01:03:03.000Z",
  summary: "The RG-40 costs $34 and ships Tuesday.",
  steps: [
    step("writer", `Draft the piece.\n\n<run_task>\n${TASK}\n</run_task>`, "completed", "Draft: the RG-40 is $34."),
    step("editor", "Tighten it.", "completed", "The RG-40 costs $34 and ships Tuesday.\n\nMore detail below."),
  ],
  ...over,
});

test("a completed flow run becomes a manual flow eval with its task and a judge", async () => {
  await withWorkspace([completed("run-aaa-1111")], async (ws) => {
    const out = promoteRunToEval("acme", "desk", "run-aaa-1111");
    assert.equal(out.file, "evals/publish-regressions.md");
    assert.equal(out.created, true);
    assert.equal(out.caseName, "run run-aaa-1111 (2026-09-02)");
    assert.ok(fs.existsSync(path.join(ws, out.file)));

    const evals = listEvals("acme", "desk");
    assert.equal(evals.length, 1);
    const info = evals[0];
    assert.equal(info.name, "publish-regressions");
    assert.equal(info.flow, "publish");
    assert.equal(info.agent, null);
    assert.equal(info.trigger, "manual", "a flow eval costs a whole run — it must not follow every push");
    assert.equal(info.cases.length, 1);
    assert.equal(info.cases[0].name, out.caseName);
    // The task is what was inside <run_task>, not the step's own instruction.
    assert.equal(info.cases[0].task, TASK);
    assert.deepEqual(info.cases[0].expect, [
      {
        type: "judge",
        value: "reaches the same conclusion as the recorded run: The RG-40 costs $34 and ships Tuesday.",
      },
    ]);
  });
});

test("a second promote appends a second case to the same file", async () => {
  await withWorkspace([completed("run-aaa-1111"), completed("run-bbb-2222")], async (ws) => {
    const first = promoteRunToEval("acme", "desk", "run-aaa-1111");
    const second = promoteRunToEval("acme", "desk", "run-bbb-2222", {
      caseName: "quotes the real price",
      expect: ["contains: $34", "judge: names the ship day"],
    });
    assert.equal(second.file, first.file);
    assert.equal(second.created, false);
    assert.equal(second.caseName, "quotes the real price");

    const info = parseEval(first.file, fs.readFileSync(path.join(ws, first.file), "utf8"));
    assert.equal(info.cases.length, 2);
    assert.equal(info.cases[0].name, first.caseName, "the first case is still there, untouched");
    assert.equal(info.cases[1].name, "quotes the real price");
    assert.equal(info.cases[1].task, TASK);
    assert.deepEqual(info.cases[1].expect, [
      { type: "contains", value: "$34" },
      { type: "judge", value: "names the ship day" },
    ]);
    // Frontmatter is written once; a second case does not get a second header.
    const raw = fs.readFileSync(path.join(ws, first.file), "utf8");
    assert.equal(raw.split("\n---\n").length, 2);
  });
});

test("the same run promoted twice gets two distinct case names", async () => {
  await withWorkspace([completed("run-aaa-1111")], async () => {
    const a = promoteRunToEval("acme", "desk", "run-aaa-1111");
    const b = promoteRunToEval("acme", "desk", "run-aaa-1111");
    assert.notEqual(a.caseName, b.caseName);
    assert.equal(listEvals("acme", "desk")[0].cases.length, 2);
  });
});

test("an ad-hoc agent run becomes an agent eval, its instruction as the task", async () => {
  await withWorkspace(
    [
      completed("run-ccc-3333", {
        flow: "adhoc:writer",
        summary: null,
        steps: [step("writer", "Say hello to the farmer.", "completed", "Hello, farmer.\nHope the rain gauge is clean.")],
      }),
    ],
    async () => {
      const out = promoteRunToEval("acme", "desk", "run-ccc-3333");
      assert.equal(out.file, "evals/writer-regressions.md");
      const info = listEvals("acme", "desk")[0];
      assert.equal(info.agent, "writer");
      assert.equal(info.flow, null);
      assert.equal(info.trigger, "deploy", "an agent eval is cheap enough to follow every push");
      assert.equal(info.cases[0].task, "Say hello to the farmer.");
      // No summary on the record: the judge holds the next run to the final
      // result itself, on one line.
      assert.equal(
        info.cases[0].expect[0].value,
        "reaches the same conclusion as the recorded run: Hello, farmer. Hope the rain gauge is clean.",
      );
    },
  );
});

test("a multi-line task survives the round trip", async () => {
  const task = "Write the piece.\n\nCover:\n- the price\n- the ship day";
  await withWorkspace(
    [completed("run-ddd-4444", { steps: [step("writer", `Draft.\n\n<run_task>\n${task}\n</run_task>`, "completed", "done")] })],
    async () => {
      promoteRunToEval("acme", "desk", "run-ddd-4444");
      const got = listEvals("acme", "desk")[0].cases[0].task;
      // Bullets are written as `*` so the eval parser does not read them as
      // the end of the block; the words are all still there.
      assert.equal(got, "Write the piece.\nCover:\n* the price\n* the ship day");
    },
  );
});

test("a failed run is refused with 409", async () => {
  await withWorkspace([completed("run-eee-5555", { status: "failed" })], async (ws) => {
    assert.throws(
      () => promoteRunToEval("acme", "desk", "run-eee-5555"),
      (err: Error & { status?: number }) => err.status === 409 && /completed/.test(err.message),
    );
    assert.ok(!fs.existsSync(path.join(ws, "evals")), "nothing is written on a refusal");
  });
});

test("a completed run with no result is refused with 409", async () => {
  await withWorkspace(
    [completed("run-fff-6666", { steps: [step("writer", "do it", "completed", "")] })],
    async () => {
      assert.throws(
        () => promoteRunToEval("acme", "desk", "run-fff-6666"),
        (err: Error & { status?: number }) => err.status === 409,
      );
    },
  );
});

test("an expect line that is not an assertion is refused with 400", async () => {
  await withWorkspace([completed("run-aaa-1111")], async (ws) => {
    for (const bad of ["equals: $34", "contains $34", "judge:", "just some words"]) {
      assert.throws(
        () => promoteRunToEval("acme", "desk", "run-aaa-1111", { expect: [bad] }),
        (err: Error & { status?: number }) => err.status === 400,
        `should refuse ${JSON.stringify(bad)}`,
      );
    }
    assert.ok(!fs.existsSync(path.join(ws, "evals")), "nothing is written on a refusal");
  });
});

test("a missing run is 404 and an eval's own run is refused", async () => {
  await withWorkspace([completed("run-ggg-7777", { flow: "eval:publish-regressions" })], async () => {
    assert.throws(
      () => promoteRunToEval("acme", "desk", "run-nope"),
      (err: Error & { status?: number }) => err.status === 404,
    );
    assert.throws(
      () => promoteRunToEval("acme", "desk", "run-ggg-7777"),
      (err: Error & { status?: number }) => err.status === 409,
    );
  });
});

test("appending to an eval that tests something else is refused", async () => {
  await withWorkspace([completed("run-aaa-1111")], async (ws) => {
    fs.mkdirSync(path.join(ws, "evals"), { recursive: true });
    fs.writeFileSync(
      path.join(ws, "evals/writer-quality.md"),
      "---\nname: writer-quality\nagent: writer\n---\n\n## says hi\ntask: Say hi.\nexpect:\n  - contains: hi\n",
    );
    assert.throws(
      () => promoteRunToEval("acme", "desk", "run-aaa-1111", { evalName: "writer-quality" }),
      (err: Error & { status?: number }) => err.status === 409 && /writer-quality/.test(err.message),
    );
  });
});
