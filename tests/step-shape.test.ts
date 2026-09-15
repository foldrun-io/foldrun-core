// schema:, parallel: and max_turns: — the three step options that bound
// what a step returns, how wide a fan-out runs, and how long a model may
// keep going.
//
//   node --test tests/step-shape.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseFlow, readRun, type FlowStep, PARALLEL_CAP, MAX_TURNS_CAP } from "../src/store.ts";
import { lintFlow } from "../src/flow-lint.ts";
import { startFlowRun, waitForRun, readSchemaFile, slotPool } from "../src/runner.ts";
import { executeStep, type ExecOptions, type QueryFn } from "../src/step-exec.ts";
import { registerPlatform, platform } from "../src/platform.ts";
import type { RunInContainerArgs, ContainerStepOutcome } from "../src/run-container.ts";

const flow = (body: string) => parseFlow("f.md", `---\nname: f\n---\n\n${body}`);
const errors = (body: string) => lintFlow(flow(body)).filter((w) => w.level === "error").map((w) => w.message);

// ---------------------------------------------------------------- parsing

test("schema: inline JSON, a YAML block, or a path; anything else is a check error", () => {
  const inline = flow("1. [[a]] — find\n   output: json\n   schema: {\"type\": \"array\", \"items\": {\"type\": \"string\"}}\n").steps[0];
  assert.deepEqual(inline.schema, { type: "array", items: { type: "string" } });

  const block = flow(
    "1. [[a]] — find\n   output: json\n   schema:\n     type: object\n     required: [url]\n     properties:\n       url:\n         type: string\n\n       n: { type: integer }\n   retry: 1\n2. [[b]] — next\n",
  );
  assert.deepEqual(block.steps[0].schema, { type: "object", required: ["url"], properties: { url: { type: "string" }, n: { type: "integer" } } }, "the block ends where the indentation does");
  assert.equal(block.steps[0].retry, 1, "the option after the block still belongs to the step");
  assert.equal(block.steps.length, 2);
  assert.equal(block.steps[1].instruction, "next");

  const file = flow("1. [[a]] — find\n   output: json\n   schema: ../../schemas/lead.json\n").steps[0];
  assert.equal(file.schemaPath, "../../schemas/lead.json");
  assert.equal(file.schema, undefined);

  assert.match(errors("1. [[a]] — find\n   output: json\n   schema: {not json\n")[0], /^schema: \{not json — cannot read the schema/);
  assert.match(errors("1. [[a]] — find\n   output: json\n   schema: 3\n")[0], /a JSON object, a path under the workspace \(schemas\/lead\.json\), or a YAML block/);
  assert.match(errors("1. [[a]] — find\n   output: json\n   schema: just some words\n")[0], /^schema: just some words/);
  assert.match(errors("1. [[a]] — find\n   output: json\n   schema:\n2. [[b]] — next\n")[0], /the block under it is empty/);
  // lint: a schema on a step that returns no data checks nothing.
  const w = lintFlow(flow("1. [[a]] — find\n   schema: {\"type\": \"object\"}\n"));
  assert.ok(w.some((x) => /schema: but no output: json/.test(x.message)));
});

test("parallel: and max_turns: are counts within their caps", () => {
  const s = flow("1. [[a]] — list\n2. [[b]] — one\n   each: lines\n   parallel: 3\n   max_turns: 12\n").steps[1];
  assert.equal(s.parallel, 3);
  assert.equal(s.maxTurns, 12);
  assert.match(errors("1. [[a]] — one\n   each: lines\n   parallel: 0\n")[0], /^parallel: 0 — .*1 to 20/);
  assert.match(errors(`1. [[a]] — one\n   each: lines\n   parallel: ${PARALLEL_CAP + 1}\n`)[0], /^parallel: 21/);
  assert.match(errors("1. [[a]] — one\n   max_turns: many\n")[0], /^max_turns: many/);
  assert.match(errors(`1. [[a]] — one\n   max_turns: ${MAX_TURNS_CAP + 1}\n`)[0], /^max_turns: 501/);
  const w = lintFlow(flow("1. [[a]] — one\n   parallel: 2\n"));
  assert.ok(w.some((x) => /parallel: but no each:/.test(x.message)));
  // An underscore key is an option, not a line of the instruction.
  assert.equal(flow("1. [[a]] — one\n   max_turns: 4\n").steps[0].instruction, "one");
});

// ------------------------------------------------------------------ runs

async function withStubbedRun(
  agents: Record<string, string>,
  steps: FlowStep[],
  files: Record<string, string>,
  body: (finished: NonNullable<ReturnType<typeof readRun>>) => void,
) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-shape-"));
  const prev = { data: process.env.FOLDRUN_DATA, stub: process.env.FOLDRUN_STUB_STEP };
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
    for (const [rel, content] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(ws, rel)), { recursive: true });
      fs.writeFileSync(path.join(ws, rel), content);
    }
    fs.writeFileSync(path.join(ws, "AGENTS.md"), "---\nname: desk\n---\n");
    const run = startFlowRun("acme", "desk", steps, "shape-test");
    const { run: finished } = await waitForRun("acme", "desk", run.id, 30_000);
    assert.ok(finished);
    body(finished);
  } finally {
    for (const [k, v] of [["FOLDRUN_DATA", prev.data], ["FOLDRUN_STUB_STEP", prev.stub]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const step = (agent: string, group: number, extra: Partial<FlowStep> = {}): FlowStep => ({
  agent, instruction: `do the ${agent} thing`, group, optional: false, ...extra,
});

const leadSchema = { type: "object", required: ["name", "url"], properties: { url: { type: "string", pattern: "^https://" } } };

test("a value that fits the schema passes; one that does not fails the step naming the field", async () => {
  await withStubbedRun(
    { finder: '```json\n{"name": "acme", "url": "https://a"}\n```', next: "ok" },
    [step("finder", 1, { output: "json", schema: leadSchema }), step("next", 2)],
    {},
    (run) => {
      assert.equal(run.status, "completed");
      assert.deepEqual(run.steps[0].data, { name: "acme", url: "https://a" });
    },
  );
  await withStubbedRun(
    { finder: '```json\n{"name": "acme", "url": "ftp://a"}\n```', next: "ok" },
    [step("finder", 1, { output: "json", schema: leadSchema }), step("next", 2)],
    {},
    (run) => {
      assert.equal(run.status, "failed");
      assert.equal(run.steps[0].status, "failed");
      const err = run.steps[0].events.find((e) => e.type === "error")?.text ?? "";
      assert.match(err, /^schema: the value does not fit — \/url: does not match \^https:\/\//);
      assert.equal(run.steps[1].status, "skipped");
    },
  );
});

test("schema: <path> reads a JSON or YAML file under the workspace", async () => {
  await withStubbedRun(
    { finder: '```json\n{"name": "acme"}\n```' },
    [step("finder", 1, { output: "json", schemaPath: "../../schemas/lead.yaml" })],
    { "schemas/lead.yaml": "type: object\nrequired: [name, url]\n" },
    (run) => {
      assert.equal(run.status, "failed");
      assert.match(run.steps[0].events.find((e) => e.type === "error")?.text ?? "", /missing required field "url"/);
    },
  );
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-schemafile-"));
  try {
    fs.mkdirSync(path.join(root, "schemas"));
    fs.writeFileSync(path.join(root, "schemas/x.json"), '{"type": "array"}');
    assert.deepEqual(readSchemaFile(root, "../../schemas/x.json"), { type: "array" });
    assert.deepEqual(readSchemaFile(root, "schemas/x.json"), { type: "array" }, "workspace-relative lands on the same file");
    assert.equal(readSchemaFile(root, "../../../etc/passwd"), null, "confined to the workspace");
    assert.equal(readSchemaFile(root, "schemas/missing.json"), null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------- parallel:

test("slotPool hands out N slots and queues the rest in order", async () => {
  const pool = slotPool(2);
  await pool.acquire();
  await pool.acquire();
  let third = false;
  const p = pool.acquire().then(() => (third = true));
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(third, false, "no third slot");
  pool.release();
  await p;
  assert.equal(third, true);
});

async function withFake(fake: (args: RunInContainerArgs) => Promise<ContainerStepOutcome>, body: () => Promise<void>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-parallel-"));
  const prev = { data: process.env.FOLDRUN_DATA, iso: process.env.FOLDRUN_RUN_ISOLATION };
  process.env.FOLDRUN_DATA = root;
  process.env.FOLDRUN_RUN_ISOLATION = "fake";
  const prevIso = platform.isolation;
  registerPlatform({ isolation: { fake } });
  try {
    const ws = path.join(root, "acme/workspaces/desk");
    for (const name of ["lister", "worker"]) {
      fs.mkdirSync(path.join(ws, "agents", name), { recursive: true });
      fs.writeFileSync(path.join(ws, "agents", name, "agent.md"), `---\nname: ${name}\ndescription: x\n---\n\nWork.\n`);
    }
    fs.mkdirSync(path.join(ws, "runs"), { recursive: true });
    fs.writeFileSync(path.join(ws, "AGENTS.md"), "---\nname: desk\n---\n");
    await body();
  } finally {
    registerPlatform({ isolation: prevIso });
    for (const [k, v] of [["FOLDRUN_DATA", prev.data], ["FOLDRUN_RUN_ISOLATION", prev.iso]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test("parallel: 2 runs a six-wide fan-out two at a time; without it all six run at once", async () => {
  for (const parallel of [2, undefined]) {
    let active = 0, peak = 0;
    const fake = async (args: RunInContainerArgs): Promise<ContainerStepOutcome> => {
      if (args.input.agentRel.endsWith("lister")) return { status: "completed", result: "a\nb\nc\nd\ne\nf", conclusion: "a\nb\nc\nd\ne\nf", costUsd: 0 };
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 60));
      active -= 1;
      return { status: "completed", result: "done", costUsd: 0 };
    };
    await withFake(fake, async () => {
      const run = startFlowRun("acme", "desk", [step("lister", 1), step("worker", 2, { each: "lines", parallel })], "f");
      const { run: done } = await waitForRun("acme", "desk", run.id, 30_000);
      assert.equal(done?.status, "completed");
      assert.equal(done!.steps.filter((s) => s.item && s.status === "completed").length, 6);
      if (parallel) {
        assert.ok(peak <= 2, `at most two at once, saw ${peak}`);
        assert.ok(done!.steps.some((s) => s.events.some((e) => /fan-out: 6 instances, 2 at a time \(parallel:\)/.test(e.text))));
      } else {
        assert.equal(peak, 6, "unset is what fan-out always did: everything at once");
      }
    });
  }
});

// ------------------------------------------------------------- max_turns:

test("max_turns: reaches the model loop, and the loop's own stop is on the record", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-turns-"));
  const agentDir = path.join(root, "agents", "worker");
  fs.mkdirSync(agentDir, { recursive: true });
  try {
    let seen: Record<string, unknown> = {};
    const query: QueryFn = ({ options }) => {
      seen = options;
      const stream = (async function* () {
        yield { type: "assistant", message: { usage: { input_tokens: 1, output_tokens: 1 }, content: [{ type: "text", text: "still going" }] } };
        yield { type: "result", subtype: "error_max_turns", total_cost_usd: 0.002 };
      })();
      return Object.assign(stream, { interrupt: async () => {} });
    };
    const events: string[] = [];
    const opts: ExecOptions = {
      agentDir, workspaceRoot: root, libraryRoot: path.join(root, "library"), prompt: "work", model: "haiku",
      systemPrompt: "", allowed: [], mcpNames: [], mcpServers: {}, env: {}, maxTurns: 3,
      emit: (type, text) => events.push(`${type}: ${text}`),
    };
    const out = await executeStep(opts, query);
    assert.equal(seen.maxTurns, 3, "the cap is the SDK's maxTurns");
    assert.equal(out.status, "failed");
    assert.ok(events.includes("error: stopped after 3 turns (max_turns: in the flow file) — the step did not finish"), events.join(" | "));
    assert.equal(out.costUsd, 0.002, "what it spent getting there is still counted");
    // Unset: nothing is passed, so the SDK's own default stands.
    await executeStep({ ...opts, maxTurns: undefined }, query);
    assert.equal("maxTurns" in seen, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
