// output: json — the one structured handoff the grammar ADR allowed instead
// of variables. A step declares it returns data; the runner parses it, fails
// the step when it cannot, hands the value to the next group beside the
// prose, and `each: items` fans out over it. Proven with the stub executor,
// so the mechanics cost nothing to run.
//
//   node --test tests/structured-output.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startFlowRun, waitForRun } from "../packages/core/src/runner.ts";
import { parseFlow, readRun, runSummary, type FlowStep, type RunRecord } from "../packages/core/src/store.ts";
import { extractJson, checkVerify } from "../packages/core/src/step-exec.ts";
import { lintFlow } from "../packages/core/src/flow-lint.ts";

async function withStubbedRun(
  agents: Record<string, string>,
  steps: FlowStep[],
  body: (finished: NonNullable<ReturnType<typeof readRun>>) => void,
) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-output-"));
  const prevData = process.env.FOLDRUN_DATA;
  const prevStub = process.env.FOLDRUN_STUB_STEP;
  process.env.FOLDRUN_DATA = root;
  process.env.FOLDRUN_STUB_STEP = "1";
  try {
    const ws = path.join(root, "acme/workspaces/desk");
    for (const [name, stub] of Object.entries(agents)) {
      const dir = path.join(ws, "agents", name);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "agent.md"), `---\nname: ${name}\ndescription: stub\n---\n\nStub.\n`);
      fs.writeFileSync(path.join(dir, "stub.md"), stub);
    }
    fs.writeFileSync(path.join(ws, "AGENTS.md"), "---\nname: desk\n---\n");
    const run = startFlowRun("acme", "desk", steps, "output-test");
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

test("output: json and each: items parse; anything else is ignored", () => {
  const flow = parseFlow(
    "f.md",
    `1. [[finder]] — list the leads
   output: json
2. [[worker]] — handle one
   each: items
3. [[other]] — no shape
   output: yaml
`,
  );
  assert.equal(flow.steps[0].output, "json");
  assert.equal(flow.steps[1].each, "items");
  assert.equal(flow.steps[2].output, undefined);
});

test("lint: each: items with no data step before it is a warning", () => {
  const bad = parseFlow("f.md", "1. [[finder]] — list\n2. [[worker]] — one\n   each: items\n");
  assert.ok(lintFlow(bad).some((w) => /each: items/.test(w.message)));
  const good = parseFlow("f.md", "1. [[finder]] — list\n   output: json\n2. [[worker]] — one\n   each: items\n");
  assert.ok(!lintFlow(good).some((w) => /each: items/.test(w.message)));
});

// ------------------------------------------------------------- extraction

test("extractJson: the last fenced block wins; bare trailing JSON is accepted", () => {
  const fenced = "Draft:\n```json\n{\"a\": 1}\n```\nFinal:\n```json\n{\"a\": 2}\n```";
  assert.deepEqual(extractJson(fenced), { ok: true, value: { a: 2 } });
  assert.deepEqual(extractJson("Found three.\n[1, 2, 3]"), { ok: true, value: [1, 2, 3] });
  assert.deepEqual(extractJson("Total is {\"n\": 3} and that is all {\"n\": 4}"), { ok: true, value: { n: 4 } });
  assert.equal(extractJson("no data here").ok, false);
  assert.equal(extractJson("```json\n{not json}\n```").ok, false);
  assert.equal(extractJson(null).ok, false);
});

test("runSummary skips a fence and bracket lines to find the headline", () => {
  const run = {
    id: "r", flow: "f", status: "completed", startedAt: "", finishedAt: null,
    steps: [{ agent: "a", instruction: "", group: 1, optional: false, status: "completed", events: [],
      result: "```json\n{\n  \"x\": 1\n}\n```", costUsd: null }],
  } as unknown as RunRecord;
  assert.equal(runSummary(run), "\"x\": 1");
  const headed = { ...run, steps: [{ ...run.steps[0], result: "Three leads found.\n\n```json\n[1,2,3]\n```" }] } as RunRecord;
  assert.equal(runSummary(headed), "Three leads found.");
});

// ------------------------------------------------------------------- runs

test("data flows to the next group, and each: items fans out over the array", () =>
  withStubbedRun(
    {
      finder: 'Found two.\n```json\n[{"name": "acme", "url": "https://a"}, {"name": "beta", "url": "https://b"}]\n```',
      worker: "handled",
      closer: "done",
    },
    [step("finder", 1, { output: "json" }), step("worker", 2, { each: "items" }), step("closer", 3)],
    (run) => {
      assert.equal(run.status, "completed");
      const finder = run.steps.find((s) => s.agent === "finder");
      assert.deepEqual(finder?.data, [{ name: "acme", url: "https://a" }, { name: "beta", url: "https://b" }]);
      const instances = run.steps.filter((s) => s.item);
      assert.equal(instances.length, 2);
      assert.deepEqual(instances.map((s) => JSON.parse(s.item!).name), ["acme", "beta"]);
      assert.ok(instances.every((s) => s.status === "completed"));
    },
  ));

test("an object with one array field fans out over that field", () =>
  withStubbedRun(
    { finder: '```json\n{"count": 2, "leads": ["x", "y"]}\n```', worker: "ok" },
    [step("finder", 1, { output: "json" }), step("worker", 2, { each: "items" })],
    (run) => {
      assert.deepEqual(run.steps.filter((s) => s.item).map((s) => s.item), ["x", "y"]);
    },
  ));

test("a step that promised data and returned none fails, and says why", () =>
  withStubbedRun(
    { finder: "I could not find anything, sorry.", worker: "ok" },
    [step("finder", 1, { output: "json" }), step("worker", 2)],
    (run) => {
      assert.equal(run.status, "failed");
      const finder = run.steps.find((s) => s.agent === "finder");
      assert.equal(finder?.status, "failed");
      assert.ok(finder?.events.some((e) => e.type === "error" && /output: json/.test(e.text)));
    },
  ));

test("each: items with no data before it is skipped with the reason on the record", () =>
  withStubbedRun(
    { finder: "just prose", worker: "ok" },
    [step("finder", 1), step("worker", 2, { each: "items" })],
    (run) => {
      const tmpl = run.steps.find((s) => s.each === "items");
      assert.equal(tmpl?.status, "skipped");
      assert.match(tmpl?.skipReason ?? "", /output: json/);
    },
  ));

// ----------------------------------------------------------------- verify:

test("verify: borrows the eval vocabulary, and a shell check reads the data on stdin", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-verify-"));
  try {
    const result = "The price is $34 for the RG-40.";
    const ok = await checkVerify(dir, "contains: $34", { env: {}, result });
    assert.equal(ok.ok, true);
    const missing = await checkVerify(dir, "contains: $99", { env: {}, result });
    assert.equal(missing.ok, false);
    assert.equal((await checkVerify(dir, "not-contains: leverage", { env: {}, result })).ok, true);
    assert.equal((await checkVerify(dir, "matches: RG-\\d+", { env: {}, result })).ok, true);
    assert.equal((await checkVerify(dir, "matches: (", { env: {}, result })).ok, false);
    fs.mkdirSync(path.join(dir, "outputs"));
    fs.writeFileSync(path.join(dir, "outputs", "report.md"), "x");
    assert.equal((await checkVerify(dir, "file: outputs/report.md", { env: {}, result })).ok, true);
    assert.equal((await checkVerify(dir, "file: outputs/nope.md", { env: {}, result })).ok, false);
    assert.equal((await checkVerify(dir, "file: ../../etc/passwd", { env: {}, result })).ok, false);
    // A shell verify sees the step's data on stdin.
    const shell = await checkVerify(dir, "grep -q '\"total\":3' -", { env: {}, result, data: { total: 3 } });
    assert.equal(shell.ok, true, shell.detail);
    const none = await checkVerify(dir, "test -z \"$(cat)\"", { env: {}, result });
    assert.equal(none.ok, true, "no data → empty stdin");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
