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
import { startFlowRun, waitForRun } from "../packages/core/src/runner.ts";
import { parseFlow, readRun, type FlowStep } from "../packages/core/src/store.ts";
import { deliverEvent } from "../packages/core/src/approvals.ts";
import { eventToken, approveToken, eventUrl } from "../packages/core/src/webhook.ts";

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
