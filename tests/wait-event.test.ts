// `wait: event` — a step that holds until the outside world POSTs the run's
// event URL. Same park as an approval, a machine holds the key, and the body
// it sends reaches the step. Proven with the stub executor.
//
//   node --test tests/wait-event.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startFlowRun, waitForRun } from "../src/runner.ts";
import { parseFlow, readRun, type FlowStep } from "../src/store.ts";
import { deliverEvent, eventGatesFor } from "../src/approvals.ts";
import { eventToken, approveToken, eventUrl } from "../src/webhook.ts";

function workspace(agents: Record<string, string>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-event-"));
  const prevData = process.env.FOLDRUN_DATA;
  const prevStub = process.env.FOLDRUN_STUB_STEP;
  process.env.FOLDRUN_DATA = root;
  process.env.FOLDRUN_STUB_STEP = "1";
  const ws = path.join(root, "acme/workspaces/desk");
  for (const [name, stub] of Object.entries(agents)) {
    const dir = path.join(ws, "agents", name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "agent.md"), `---\nname: ${name}\ndescription: stub\n---\n\nStub.\n`);
    fs.writeFileSync(path.join(dir, "stub.md"), stub);
  }
  fs.mkdirSync(path.join(ws, "flows"), { recursive: true });
  fs.writeFileSync(path.join(ws, "AGENTS.md"), "---\nname: desk\n---\n");
  return {
    ws,
    done() {
      if (prevData === undefined) delete process.env.FOLDRUN_DATA;
      else process.env.FOLDRUN_DATA = prevData;
      if (prevStub === undefined) delete process.env.FOLDRUN_STUB_STEP;
      else process.env.FOLDRUN_STUB_STEP = prevStub;
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

const step = (agent: string, group: number, extra: Partial<FlowStep> = {}): FlowStep => ({
  agent,
  instruction: `do the ${agent} thing`,
  group,
  optional: false,
  ...extra,
});

const until = async (pred: () => boolean, ms = 10_000) => {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 50));
  }
};

test("wait: event parses beside wait: durations", () => {
  const flow = parseFlow("f.md", "1. [[sender]] — send the quote\n2. [[chaser]] — follow up\n   wait: event\n3. [[x]] — later\n   wait: 2h\n");
  assert.equal(flow.steps[1].waitFor, "event");
  assert.equal(flow.steps[1].waitSecs, undefined);
  assert.equal(flow.steps[2].waitSecs, 7200);
  assert.equal(flow.steps[2].waitFor, undefined);
});

test("tokens: the event family is distinct from the approval family, and the URL carries it", () => {
  assert.notEqual(eventToken("acme", "desk", "r1"), approveToken("acme", "desk", "r1"));
  assert.notEqual(eventToken("acme", "desk", "r1"), eventToken("acme", "desk", "r2"));
  assert.match(eventUrl("acme", "desk", "r1"), /\/api\/events\/acme\/desk\/r1\?token=[0-9a-f]{32}$/);
});

test("a step parks on the event, and what is POSTed reaches it", async () => {
  const w = workspace({ sender: "quote sent", chaser: "followed up" });
  try {
    const run = startFlowRun("acme", "desk", [step("sender", 1), step("chaser", 2, { waitFor: "event" })], "quote");
    await until(() => readRun("acme", "desk", run.id)?.status === "awaiting-approval");
    const parked = readRun("acme", "desk", run.id)!;
    const chaser = parked.steps.find((s) => s.agent === "chaser")!;
    assert.equal(chaser.status, "awaiting-approval");
    assert.ok(chaser.events.some((e) => /external event/.test(e.text) && /\/api\/events\//.test(e.text)));

    const { steps } = await deliverEvent("acme", "desk", run.id, "Customer replied: yes, go ahead");
    assert.deepEqual(steps, [1]);
    // waitForRun also returns at a park; the release is polled by the
    // driver, so wait for the run to actually finish.
    await until(() => ["completed", "failed"].includes(readRun("acme", "desk", run.id)?.status ?? ""), 20_000);
    const finished = readRun("acme", "desk", run.id);
    assert.equal(finished?.status, "completed");
    const done = finished!.steps.find((s) => s.agent === "chaser")!;
    assert.equal(done.eventPayload, "Customer replied: yes, go ahead");
    assert.ok(done.approvedAt, "released is recorded as an approval");
    assert.ok(done.events.some((e) => /by an external event/.test(e.text)));
  } finally {
    w.done();
  }
});

test("an event for a run that is not waiting on one is refused", async () => {
  const w = workspace({ sender: "sent" });
  try {
    const run = startFlowRun("acme", "desk", [step("sender", 1)], "plain");
    await waitForRun("acme", "desk", run.id, 20_000);
    await assert.rejects(deliverEvent("acme", "desk", run.id, "x"), (e: Error & { status?: number }) => e.status === 409);
    await assert.rejects(deliverEvent("acme", "desk", "nope", "x"), (e: Error & { status?: number }) => e.status === 404);
  } finally {
    w.done();
  }
});

test("an event delivered by a named person records them, and a step that is not waiting on one is refused", async () => {
  const w = workspace({ sender: "quote sent", chaser: "followed up" });
  try {
    const run = startFlowRun("acme", "desk", [step("sender", 1), step("chaser", 2, { waitFor: "event" })], "quote");
    await until(() => readRun("acme", "desk", run.id)?.status === "awaiting-approval");
    await assert.rejects(deliverEvent("acme", "desk", run.id, "x", { step: 0 }), (e: Error & { status?: number }) => e.status === 409);
    const { steps } = await deliverEvent("acme", "desk", run.id, "paid", { by: "by ann@acme.test", step: 1 });
    assert.deepEqual(steps, [1]);
    await until(() => ["completed", "failed"].includes(readRun("acme", "desk", run.id)?.status ?? ""), 20_000);
    const done = readRun("acme", "desk", run.id)!.steps[1];
    assert.equal(done.eventPayload, "paid");
    assert.ok(done.events.some((e) => /approved by ann@acme\.test/.test(e.text)));
    assert.ok(!done.events.some((e) => /by an external event/.test(e.text)));
  } finally {
    w.done();
  }
});

// 30 Oct 2026: the event URL is one step's, for one park. The per-run token
// released every later `wait: event` of the run and never expired.
test("an event URL opens its own step's park only; the old per-run form only a step parked under it", async () => {
  const w = workspace({ sender: "sent", first: "one", second: "two" });
  try {
    const run = startFlowRun(
      "acme", "desk",
      [step("sender", 1), step("first", 2, { waitFor: "event" }), step("second", 3, { waitFor: "event" })],
      "two-gates",
    );
    await until(() => readRun("acme", "desk", run.id)?.status === "awaiting-approval");
    const parked = readRun("acme", "desk", run.id)!;
    const line = parked.steps[1].events.find((e) => /external event/.test(e.text))!;
    const url = /POST (\S+)/.exec(line.text)![1];
    assert.match(url, /\?token=[0-9a-f]{32}&step=1$/, "the printed URL names its step");
    const token = new URL(url, "http://x").searchParams.get("token")!;
    assert.equal(token, eventToken("acme", "desk", run.id, { step: 1, at: line.t }));
    assert.notEqual(token, eventToken("acme", "desk", run.id), "not the per-run token");

    assert.deepEqual(eventGatesFor("acme", "desk", parked, token, 1), { known: true, steps: [1] });
    assert.deepEqual(eventGatesFor("acme", "desk", parked, token, 2), { known: false, steps: [] }, "not another step's");
    assert.deepEqual(eventGatesFor("acme", "desk", parked, "0".repeat(32), 1), { known: false, steps: [] });
    // The old form opens nothing parked since: its line names a step.
    assert.deepEqual(eventGatesFor("acme", "desk", parked, eventToken("acme", "desk", run.id), null), { known: true, steps: [] });

    await deliverEvent("acme", "desk", run.id, "first", { step: 1 });
    await until(() => readRun("acme", "desk", run.id)?.steps[2].status === "awaiting-approval", 20_000);
    const later = readRun("acme", "desk", run.id)!;
    // The first URL, once released, is spent — and never opens the second gate.
    assert.deepEqual(eventGatesFor("acme", "desk", later, token, 1), { known: true, steps: [] });
    assert.deepEqual(eventGatesFor("acme", "desk", later, token, 2), { known: false, steps: [] });

    // A step parked under the old URL (printed before 30 Oct 2026) is still released by it.
    const legacy = structuredClone(later);
    const second = legacy.steps[2].events.find((e) => /external event/.test(e.text))!;
    second.text = `waiting for an external event — release it with POST ${eventUrl("acme", "desk", run.id)}`;
    assert.deepEqual(eventGatesFor("acme", "desk", legacy, eventToken("acme", "desk", run.id), null), { known: true, steps: [2] });
  } finally {
    w.done();
  }
});
