// budget: on a flow — the most one run may spend. A literal in frontmatter,
// checked between groups, stamped on the record.
//
//   node --test tests/flow-budget.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startFlowRun, waitForRun } from "../src/runner.ts";
import { parseFlow, listAgents, type FlowStep } from "../src/store.ts";

async function withStubbedRun(
  agents: Record<string, string>,
  flowFile: string,
  body: (run: NonNullable<Awaited<ReturnType<typeof waitForRun>>["run"]>) => void,
  /** Extra frontmatter lines per agent — `budget: 0.5` and the like. */
  agentFront: Record<string, string> = {},
) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-budget-"));
  const prevData = process.env.FOLDRUN_DATA;
  const prevStub = process.env.FOLDRUN_STUB_STEP;
  process.env.FOLDRUN_DATA = root;
  process.env.FOLDRUN_STUB_STEP = "1";
  try {
    const ws = path.join(root, "acme/workspaces/desk");
    for (const [name, stub] of Object.entries(agents)) {
      const dir = path.join(ws, "agents", name);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "agent.md"), `---\nname: ${name}\ndescription: stub\n${agentFront[name] ? agentFront[name] + "\n" : ""}---\n\nStub.\n`);
      fs.writeFileSync(path.join(dir, "stub.md"), stub);
    }
    fs.mkdirSync(path.join(ws, "flows"), { recursive: true });
    fs.writeFileSync(path.join(ws, "flows", "capped.md"), flowFile);
    fs.writeFileSync(path.join(ws, "AGENTS.md"), "---\nname: desk\n---\n");
    const flow = parseFlow("capped.md", flowFile);
    const run = startFlowRun("acme", "desk", flow.steps as FlowStep[], flow.name);
    const { run: finished } = await waitForRun("acme", "desk", run.id, 30_000);
    assert.ok(finished);
    body(finished);
  } finally {
    if (prevData === undefined) delete process.env.FOLDRUN_DATA;
    else process.env.FOLDRUN_DATA = prevData;
    if (prevStub === undefined) delete process.env.FOLDRUN_STUB_STEP;
    else process.env.FOLDRUN_STUB_STEP = prevStub;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test("budget: parses as a positive number, else null", () => {
  assert.equal(parseFlow("f.md", "---\nname: f\nbudget: 2.5\n---\n1. [[a]] — x\n").budget, 2.5);
  assert.equal(parseFlow("f.md", "---\nname: f\nbudget: lots\n---\n1. [[a]] — x\n").budget, null);
  assert.equal(parseFlow("f.md", "1. [[a]] — x\n").budget, null);
});

test("the group that crosses the cap is the last one that runs", () =>
  withStubbedRun(
    { a: "cost: 0.60\nfirst", b: "cost: 0.60\nsecond", c: "third" },
    "---\nname: capped\nbudget: 1\n---\n1. [[a]] — one\n2. [[b]] — two\n3. [[c]] — three\n",
    (run) => {
      assert.equal(run.budgetUsd, 1);
      assert.equal(run.status, "failed");
      const [a, b, c] = run.steps;
      assert.equal(a.status, "completed");
      assert.equal(b.status, "completed");
      assert.equal(c.status, "skipped");
      assert.equal(c.skipReason, "over budget");
      assert.ok(b.events.some((e) => /over budget/.test(e.text)));
    },
  ));

test("under the cap, nothing changes", () =>
  withStubbedRun(
    { a: "cost: 0.10\nfirst", b: "cost: 0.10\nsecond" },
    "---\nname: capped\nbudget: 1\n---\n1. [[a]] — one\n2. [[b]] — two\n",
    (run) => {
      assert.equal(run.status, "completed");
      assert.equal(run.budgetUsd, 1);
    },
  ));

test("no budget: the record says so and the run is unbounded", () =>
  withStubbedRun(
    { a: "cost: 9\nfirst", b: "cost: 9\nsecond" },
    "---\nname: capped\n---\n1. [[a]] — one\n2. [[b]] — two\n",
    (run) => {
      assert.equal(run.status, "completed");
      assert.equal(run.budgetUsd, null);
    },
  ));

test("an agent's own budget: is per run — its next step in the same run is refused when it has spent the cap", () =>
  withStubbedRun(
    { a: "cost: 0.60\nfirst", b: "cost: 0.10\nsecond" },
    "---\nname: capped\n---\n1. [[a]] — one\n2. [[b]] — two\n3. [[a]] — again\n",
    (run) => {
      assert.equal(run.budgetUsd, null, "the flow itself set no cap");
      const [one, two, again] = run.steps;
      assert.equal(one.status, "completed");
      assert.equal(two.status, "completed", "another agent is not bound by a's cap");
      assert.equal(again.status, "failed");
      assert.equal(again.attempts ?? 0, 0, "it was never started");
      assert.match(again.events.at(-1)!.text, /over budget — nothing left to spend before this step \(budget: on the a agent\)/);
      assert.equal(run.status, "failed");
    },
    { a: "budget: 0.5" },
  ));

test("an agent's budget: written with a period is not a cap — the lint names it, the run ignores it", () =>
  withStubbedRun(
    { a: "cost: 0.60\nfirst" },
    "---\nname: capped\n---\n1. [[a]] — one\n2. [[a]] — again\n",
    (run) => {
      assert.equal(run.status, "completed");
      const a = listAgents("acme", "desk").find((x) => x.name === "a")!;
      assert.equal(a.budget, null);
      assert.match(a.budgetProblem!, /per run/);
    },
    { a: "budget: 0.5/day" },
  ));
