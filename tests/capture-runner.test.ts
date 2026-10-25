// FOL-54 step 4, through the runner: a step's model calls land on
// step.calls (numbered, not as trace lines), its tool content beside the run
// with only `captured` on the event, `capture: metadata` keeps none, and the
// run says which revision it ran and when a worker picked it up.
//
//   node --test tests/capture-runner.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startFlowRun, waitForRun } from "../src/runner.ts";
import { readCapturedCall } from "../src/store.ts";

async function stubbed(agentsMd: string, stub: string) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-caprun-"));
  const prev = { data: process.env.FOLDRUN_DATA, stub: process.env.FOLDRUN_STUB_STEP };
  process.env.FOLDRUN_DATA = root;
  process.env.FOLDRUN_STUB_STEP = "1";
  try {
    const ws = path.join(root, "acme/workspaces/desk");
    fs.mkdirSync(path.join(ws, "agents", "writer"), { recursive: true });
    fs.writeFileSync(path.join(ws, "agents", "writer", "agent.md"), "---\nname: writer\ndescription: stub\n---\n\nStub.\n");
    fs.writeFileSync(path.join(ws, "agents", "writer", "stub.md"), stub);
    fs.writeFileSync(path.join(ws, "AGENTS.md"), agentsMd);
    const run = startFlowRun("acme", "desk", [{ agent: "writer", instruction: "go", group: 1, optional: false }], "cap-test");
    const { run: done } = await waitForRun("acme", "desk", run.id, 30_000);
    // Read while FOLDRUN_DATA still points at this run's root.
    const saved = new Map(["toolu_stub1", "toolu_stub2"].map((id) => [id, readCapturedCall("acme", "desk", run.id, id)]));
    return { done: done!, read: (id: string) => saved.get(id) ?? null };
  } finally {
    if (prev.data === undefined) delete process.env.FOLDRUN_DATA;
    else process.env.FOLDRUN_DATA = prev.data;
    if (prev.stub === undefined) delete process.env.FOLDRUN_STUB_STEP;
    else process.env.FOLDRUN_STUB_STEP = prev.stub;
  }
}

test("full (the default): calls on the step, content beside the run, the event keeps only `captured`", async () => {
  const { done, read } = await stubbed("---\nname: desk\n---\n", "call: Read {\"file_path\":\"a.txt\"} => hello\ncall: Bash {\"command\":\"ls\"} => a.txt\nGOOD — read it");
  const step = done.steps[0]!;
  assert.equal(done.status, "completed");
  assert.deepEqual(step.calls?.map((c) => c.n), [1, 2], "a turn sent twice under one id is one call (review)");
  assert.deepEqual(step.calls?.map((c) => [c.stop, c.tools]), [["tool_use", 1], ["tool_use", 1]], "the later message updates it");
  assert.ok(!step.events.some((e) => e.type === "info" && e.text === ""), "a model call is not a trace line");
  const tools = step.events.filter((e) => e.type === "tool");
  assert.equal(tools.length, 4);
  assert.ok(tools.every((e) => e.captured === true && !("io" in e)));
  assert.deepEqual(read("toolu_stub1"), { id: "toolu_stub1", tool: "Read", input: '{"file_path":"a.txt"}', inputChars: 21, output: "hello", outputChars: 5 });
  assert.ok(done.drivenAt && Date.parse(done.drivenAt) >= Date.parse(done.startedAt));
  assert.equal(done.revision, null, "never deployed or edited: no revision to name");
});

test("capture: metadata keeps the calls and no content", async () => {
  const { done, read } = await stubbed("---\nname: desk\ncapture: metadata\n---\n", "call: Read {} => secret stuff\nGOOD");
  const step = done.steps[0]!;
  assert.equal(step.calls?.length, 1);
  assert.ok(step.events.filter((e) => e.type === "tool").every((e) => !e.captured));
  assert.equal(read("toolu_stub1"), null);
});
