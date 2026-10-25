// A fan-out's first instance warms the prompt cache; its siblings wait for
// its first reply and then read what it wrote.
//
//   node --test tests/warm-gate.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { warmGate, untilFirstReply, markResponding, startFlowRun, waitForRun } from "../src/runner.ts";
import { parseDriverLine } from "../src/run-container.ts";
import { executeStep, type QueryFn } from "../src/step-exec.ts";
import { parseFlow, type FlowStep, type StepRecord } from "../src/store.ts";

const step = (agent: string, model?: string) =>
  ({ agent, model, events: [], status: "pending" } as unknown as StepRecord);
const tick = () => new Promise((r) => setTimeout(r, 20));

test("untilFirstReply: a text or tool event opens it; so does the step ending without one", async () => {
  const s = step("a");
  let open = false;
  const never = new Promise<void>(() => {});
  untilFirstReply(s, never, 5).then(() => (open = true));
  await tick();
  assert.equal(open, false);
  s.events.push({ t: "", type: "info", text: "stub call 1" });
  await tick();
  assert.equal(open, false, "an info line is not a reply");
  s.events.push({ t: "", type: "tool", text: "Read" });
  await tick();
  assert.equal(open, true);

  const failed = step("b");
  let openedByEnd = false;
  untilFirstReply(failed, Promise.reject(new Error("no start")), 5).then(() => (openedByEnd = true));
  await tick();
  assert.equal(openedByEnd, true);
});

test("untilFirstReply: the response starting opens it, before any text or tool call", async () => {
  const s = step("a");
  let open = false;
  untilFirstReply(s, new Promise<void>(() => {}), 5).then(() => (open = true));
  await tick();
  assert.equal(open, false);
  markResponding(s);
  await tick();
  assert.equal(open, true);
});

test("a step says once that its response began, and the signal crosses from the driver as a field", async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-resp-")));
  const agentDir = path.join(root, "agents", "a");
  fs.mkdirSync(agentDir, { recursive: true });
  const seen: { text: string; responding?: true }[] = [];
  const query: QueryFn = () =>
    Object.assign((async function* () {
      // Two responses of the step's own model, and one of a sub-agent's.
      yield { type: "stream_event", parent_tool_use_id: "toolu_sub", event: { type: "message_start", message: { id: "msg_sub" } } };
      yield { type: "stream_event", parent_tool_use_id: null, event: { type: "message_start", message: { id: "msg_1" } } };
      yield { type: "stream_event", parent_tool_use_id: null, event: { type: "message_start", message: { id: "msg_2" } } };
      yield { type: "result", subtype: "success", result: "done", total_cost_usd: 0 };
    })(), { async interrupt() {} });
  try {
    await executeStep({
      agentDir, workspaceRoot: root, libraryRoot: "/nonexistent", prompt: "p", model: "haiku", systemPrompt: "s",
      allowed: ["Read"], mcpNames: [], mcpServers: {}, env: {}, capture: "metadata",
      emit: (_type, text, extra) => void seen.push({ text, ...(extra?.responding ? { responding: true as const } : {}) }),
    }, query);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
  const said = seen.filter((e) => e.responding);
  assert.equal(said.length, 1, "once, for the step's own model — not a sub-agent's, not every turn");
  const line = parseDriverLine(JSON.stringify({ e: "event", type: "info", text: "", responding: true }));
  assert.ok(line && line.e === "event" && line.responding === true);
  const plain = parseDriverLine(JSON.stringify({ e: "event", type: "info", text: "", responding: "yes" }));
  assert.ok(plain && plain.e === "event" && !("responding" in plain), "only a literal true crosses");
});

test("warmGate: siblings of one agent wait for the lead's first reply; other agents and lone steps do not", async () => {
  const [a1, a2, a3, b1, c1] = [step("a"), step("a"), step("a"), step("b"), step("a", "max")];
  const gate = warmGate([a1, a2, a3, b1, c1], 5);
  // Claims are synchronous and in launch order: the first of an agent
  // leads, the rest get its gate — before anyone has awaited anything.
  assert.equal(gate.claim(a1), null, "the first of its agent leads");
  const a2Gate = gate.claim(a2);
  const a3Gate = gate.claim(a3);
  assert.ok(a2Gate && a3Gate, "the siblings have the lead's gate to await");
  assert.equal(a2Gate, a3Gate, "one gate per agent");
  assert.equal(gate.claim(b1), null, "the only step of its agent waits for nothing");
  assert.equal(gate.claim(c1), null, "another model is another cache");

  const started: string[] = [];
  let finishLead!: () => void;
  const leadRun = gate.run(a1, () => {
    started.push("a1");
    return new Promise<void>((r) => (finishLead = r));
  });
  let a2Through = false;
  a2Gate!.then(() => (a2Through = true));
  await tick();
  assert.equal(a2Through, false, "closed until the lead replies");
  a1.events.push({ t: "", type: "text", text: "Found three sources." });
  await tick();
  assert.equal(a2Through, true, "the first reply opens it");
  // Siblings run at once after that — no second gate.
  await gate.run(a2, async () => void started.push("a2"));
  await gate.run(a3, async () => void started.push("a3"));
  finishLead();
  await leadRun;
  assert.deepEqual(started, ["a1", "a2", "a3"]);
});

test("warmGate: a lead that fails before replying still opens the gate, and its failure is the caller's", async () => {
  const [a1, a2] = [step("a"), step("a")];
  const gate = warmGate([a1, a2], 5);
  assert.equal(gate.claim(a1), null);
  const a2Gate = gate.claim(a2)!;
  await assert.rejects(gate.run(a1, () => Promise.reject(new Error("pod never came up"))), /pod never came up/);
  let through = false;
  await a2Gate.then(() => (through = true));
  assert.equal(through, true);
});

test("warmGate: a lead that is skipped instead of run still opens its gate", async () => {
  const [a1, a2] = [step("a"), step("a")];
  const gate = warmGate([a1, a2], 5);
  assert.equal(gate.claim(a1), null);
  const a2Gate = gate.claim(a2)!;
  let through = false;
  a2Gate.then(() => (through = true));
  await tick();
  assert.equal(through, false);
  gate.release(a2);
  await tick();
  assert.equal(through, false, "releasing a follower is a no-op");
  gate.release(a1);
  await tick();
  assert.equal(through, true, "releasing the lead opens the gate");
});

test("in a stub run, the copies of a fan-out after the first say they waited", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-warm-"));
  const prevData = process.env.FOLDRUN_DATA;
  const prevStub = process.env.FOLDRUN_STUB_STEP;
  process.env.FOLDRUN_DATA = root;
  process.env.FOLDRUN_STUB_STEP = "1";
  try {
    const ws = path.join(root, "acme/workspaces/desk");
    for (const [name, stub] of Object.entries({ maker: "one\ntwo\nthree", a: "handled" })) {
      const dir = path.join(ws, "agents", name);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "agent.md"), `---\nname: ${name}\ndescription: stub\n---\n\nStub.\n`);
      fs.writeFileSync(path.join(dir, "stub.md"), stub);
    }
    fs.mkdirSync(path.join(ws, "flows"), { recursive: true });
    const flowFile = "---\nname: fan\n---\n1. [[maker]] — list\n2. [[a]] — one\n   each: lines\n";
    fs.writeFileSync(path.join(ws, "flows", "fan.md"), flowFile);
    fs.writeFileSync(path.join(ws, "AGENTS.md"), "---\nname: desk\n---\n");
    const flow = parseFlow("fan.md", flowFile);
    const run = startFlowRun("acme", "desk", flow.steps as FlowStep[], flow.name);
    const { run: finished } = await waitForRun("acme", "desk", run.id, 30_000);
    assert.ok(finished);
    assert.equal(finished.status, "completed");
    const copies = finished.steps.filter((s) => s.item);
    assert.equal(copies.length, 3);
    const waited = copies.filter((s) => s.events.some((e) => e.text.startsWith("prompt cache: waiting")));
    assert.equal(waited.length, 2, "every copy but the lead waited");
    assert.ok(!finished.steps[0]!.events.some((e) => e.text.startsWith("prompt cache: waiting")), "a lone step never waits");
  } finally {
    if (prevData === undefined) delete process.env.FOLDRUN_DATA;
    else process.env.FOLDRUN_DATA = prevData;
    if (prevStub === undefined) delete process.env.FOLDRUN_STUB_STEP;
    else process.env.FOLDRUN_STUB_STEP = prevStub;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
