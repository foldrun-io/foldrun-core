// The three orchestration patterns beyond plain groups: bounded evaluator
// loops (`loop:`/`until:`), dynamic fan-out (`each:`/`max:`), and consults
// (`agents:` — tested at the gathering layer; the tool call itself is a
// model call). All exercised through real runs with the stub executor, so
// the mechanics are proven end to end at zero cost.
//
//   node --test tests/flow-patterns.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startFlowRun, waitForRun } from "../packages/core/src/runner.ts";
import { parseFlow, readRun, type FlowStep } from "../packages/core/src/store.ts";
import { gatherConsults, buildConsultTools } from "../packages/core/src/agent-tools.ts";

/** A workspace whose agents answer from stub.md scripts instead of a model. */
async function withStubbedRun(
  agents: Record<string, string>, // name → stub.md content ("\n---\n"-separated answers)
  steps: FlowStep[],
  body: (finished: NonNullable<ReturnType<typeof readRun>>) => void,
) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-patterns-"));
  const prevData = process.env.FOLDRUN_DATA;
  const prevStub = process.env.FOLDRUN_STUB_STEP;
  process.env.FOLDRUN_DATA = root;
  process.env.FOLDRUN_STUB_STEP = "1";
  try {
    const ws = path.join(root, "acme/workspaces/desk");
    fs.writeFileSync(path.join(root, "acme"), "", { flag: "wx" });
    fs.rmSync(path.join(root, "acme"));
    for (const [name, stub] of Object.entries(agents)) {
      const dir = path.join(ws, "agents", name);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "agent.md"), `---\nname: ${name}\ndescription: stub\n---\n\nStub.\n`);
      fs.writeFileSync(path.join(dir, "stub.md"), stub);
    }
    fs.writeFileSync(path.join(ws, "AGENTS.md"), "---\nname: desk\n---\n");

    const run = startFlowRun("acme", "desk", steps, "pattern-test");
    const { run: finished } = await waitForRun("acme", "desk", run.id, 30_000);
    assert.ok(finished, "the run record survived");
    body(finished);
  } finally {
    if (prevData === undefined) delete process.env.FOLDRUN_DATA;
    else process.env.FOLDRUN_DATA = prevData;
    if (prevStub === undefined) delete process.env.FOLDRUN_STUB_STEP;
    else process.env.FOLDRUN_STUB_STEP = prevStub;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const step = (agent: string, group: number, extra: Partial<FlowStep> = {}): FlowStep => ({
  agent,
  instruction: `do the ${agent} thing`,
  group,
  optional: false,
  ...extra,
});

// ---------------------------------------------------------------- parsing

test("loop, until, each and max parse from indented options, clamped", () => {
  const flow = parseFlow(
    "f.md",
    `1. [[maker]] — produce a list
2. [[worker]] — handle one item
   each: lines
   max: 99
3. [[editor]] — judge it
   loop: 99
   until: APPROVED
`,
  );
  assert.equal(flow.steps[1].each, "lines");
  assert.equal(flow.steps[1].max, 20, "max clamps to 20");
  assert.equal(flow.steps[2].loop, 5, "loop clamps to 5");
  assert.equal(flow.steps[2].until, "APPROVED");
});

// ---------------------------------------------------------------- fan-out

test("each: one instance per line of the previous result, results labeled per item", () =>
  withStubbedRun(
    {
      maker: "alpha\nbeta\ngamma",
      worker: "handled",
      closer: "done",
    },
    [step("maker", 1), step("worker", 2, { each: "lines" }), step("closer", 3)],
    (run) => {
      assert.equal(run.status, "completed");
      const template = run.steps.find((s) => s.each);
      assert.equal(template?.status, "skipped");
      assert.match(template?.skipReason ?? "", /expanded into 3 items/);

      const instances = run.steps.filter((s) => s.item);
      assert.deepEqual(instances.map((s) => s.item), ["alpha", "beta", "gamma"]);
      assert.ok(instances.every((s) => s.status === "completed"));

      // The next group sees which answer came from which item.
      const closer = run.steps.find((s) => s.agent === "closer");
      assert.equal(closer?.status, "completed");
      for (const inst of instances) {
        assert.match(inst.result ?? "", new RegExp(`item: ${inst.item}`));
      }
    },
  ));

test("each: the cap holds and says so; markdown bullets are unwrapped", () =>
  withStubbedRun(
    {
      maker: "- one\n- two\n- three\n- four",
      worker: "handled",
    },
    [step("maker", 1), step("worker", 2, { each: "lines", max: 2 })],
    (run) => {
      const instances = run.steps.filter((s) => s.item);
      assert.deepEqual(instances.map((s) => s.item), ["one", "two"]);
      const template = run.steps.find((s) => s.each);
      assert.ok(
        template?.events.some((e) => /capped at 2/.test(e.text)),
        "the drop is logged, not silent",
      );
    },
  ));

test("each: with nothing to fan over, the step skips and the flow continues", () =>
  withStubbedRun(
    {
      maker: "", // stub answers empty
      worker: "handled",
      closer: "done",
    },
    [step("maker", 1), step("worker", 2, { each: "lines" }), step("closer", 3)],
    (run) => {
      assert.equal(run.status, "completed");
      const template = run.steps.find((s) => s.each);
      assert.equal(template?.status, "skipped");
      assert.match(template?.skipReason ?? "", /no items/);
    },
  ));

// ---------------------------------------------------------------- loops

test("loop: winds back one group until the marker appears", () =>
  withStubbedRun(
    {
      writer: "draft v1\n---\ndraft v2",
      // The marker stands alone on its line; notes may follow it. Written
              // inline ("APPROVED — ship v2") this is a conditional-shaped
              // reply and no longer ends the loop — see tests/until-marker.
              editor: "needs work\n---\nAPPROVED\nship draft v2",
    },
    [step("writer", 1), step("editor", 2, { loop: 3, until: "APPROVED" })],
    (run) => {
      assert.equal(run.status, "completed");
      const writer = run.steps.find((s) => s.agent === "writer")!;
      const editor = run.steps.find((s) => s.agent === "editor")!;
      assert.equal(writer.events.filter((e) => e.text.startsWith("stub call")).length, 2, "the writer went again");
      assert.match(editor.result ?? "", /APPROVED/);
      assert.equal(editor.loopRemaining, 2, "one cycle spent of three");
      assert.ok(editor.events.some((e) => /winding back/.test(e.text)));
    },
  ));

test("loop: exhausting the budget without the marker fails the step, with the reason", () =>
  withStubbedRun(
    {
      writer: "draft",
      editor: "needs work",
    },
    [step("writer", 1), step("editor", 2, { loop: 1, until: "APPROVED" })],
    (run) => {
      assert.equal(run.status, "failed");
      const editor = run.steps.find((s) => s.agent === "editor")!;
      assert.equal(editor.status, "failed");
      assert.ok(editor.events.some((e) => /loop exhausted/.test(e.text)));
    },
  ));

// ---------------------------------------------------------------- consults

test("gatherConsults reads personas and reports what does not exist", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-consult-"));
  try {
    const ws = path.join(root, "desk");
    fs.mkdirSync(path.join(ws, "agents/researcher"), { recursive: true });
    fs.writeFileSync(
      path.join(ws, "agents/researcher/agent.md"),
      "---\nname: researcher\nmodel: fast\n---\n\nYou research things thoroughly.\n",
    );
    const { consults, missing } = gatherConsults(ws, ["researcher", "nobody", "../escape"]);
    assert.equal(consults.length, 1);
    assert.match(consults[0].systemPrompt, /You research things thoroughly/);
    assert.match(consults[0].systemPrompt, /being consulted/);
    assert.equal(consults[0].model, "haiku", "the fast tier resolved");
    assert.deepEqual(missing, ["nobody", "../escape"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("consult tools exist exactly when colleagues are declared", () => {
  assert.equal(buildConsultTools([], {}, () => {}).server, null);
  const built = buildConsultTools(
    [{ name: "fact-checker", systemPrompt: "check", model: "haiku" }],
    {},
    () => {},
  );
  assert.ok(built.server);
  assert.deepEqual(built.toolNames, ["mcp__foldrun_agents__consult_fact_checker"]);
  assert.equal(built.drainCost(), 0);
});

// ---------------------------------------------------------------- routing

test("case: first match wins, later cases and else are routed past", () =>
  withStubbedRun(
    {
      classifier: "This looks like a BUG in the parser.",
      debugger: "fixed it",
      writer: "here is prose",
      triager: "unclear",
    },
    [
      step("classifier", 1),
      step("debugger", 2, { case: "BUG" }),
      step("writer", 2, { case: "QUESTION" }),
      step("triager", 2, { else: true }),
    ],
    (run) => {
      assert.equal(run.status, "completed");
      const by = (name: string) => run.steps.find((s) => s.agent === name)!;
      assert.equal(by("debugger").status, "completed");
      assert.equal(by("writer").status, "skipped");
      assert.match(by("writer").skipReason ?? "", /routed past/);
      assert.equal(by("triager").status, "skipped");
      assert.match(by("triager").skipReason ?? "", /routed past/);
    },
  ));

test("case: nothing matches, the else route runs", () =>
  withStubbedRun(
    {
      classifier: "I honestly cannot tell what this is.",
      debugger: "fixed it",
      writer: "here is prose",
      triager: "escalating to a human",
    },
    [
      step("classifier", 1),
      step("debugger", 2, { case: "BUG" }),
      step("writer", 2, { case: "QUESTION" }),
      step("triager", 2, { else: true }),
    ],
    (run) => {
      assert.equal(run.status, "completed");
      const by = (name: string) => run.steps.find((s) => s.agent === name)!;
      assert.equal(by("debugger").status, "skipped");
      assert.match(by("debugger").skipReason ?? "", /not matched/);
      assert.equal(by("writer").status, "skipped");
      assert.equal(by("triager").status, "completed");
      assert.match(by("triager").result ?? "", /escalating/);
    },
  ));

test("when: stays independent — routing did not change its semantics", () =>
  withStubbedRun(
    {
      classifier: "urgent and important",
      a: "ran",
      b: "ran too",
    },
    [
      step("classifier", 1),
      step("a", 2, { when: "urgent" }),
      step("b", 2, { when: "important" }),
    ],
    (run) => {
      assert.equal(run.steps.filter((s) => s.status === "completed").length, 3, "both whens ran");
    },
  ));
