// A step that can act on the outside world, with nothing to say whether it
// did. `check` refuses it: the two acceptable answers are a verify the
// runtime can fail on, or a person.
import test from "node:test";
import assert from "node:assert/strict";
import { lintFlow } from "../src/flow-lint.ts";
import { toolIsOutward } from "../src/store.ts";

const flow = (step: Record<string, unknown>) => ({
  name: "f", file: "f.md", steps: [{ group: 1, agent: "sender", line: 3, ...step }],
}) as never;
const known = { agents: ["sender"], outwardAgents: ["sender"] };
const outwardErrors = (f: never, k = known) =>
  lintFlow(f, k).filter((w) => w.message.includes("act outside this workspace"));

test("no verify and no gate on an outward step is an error, not a warning", () => {
  const [w] = outwardErrors(flow({}));
  assert.ok(w, "the rule fired");
  assert.equal(w.level, "error");
  assert.match(w.message, /\[\[sender\]\] can act outside this workspace/);
  assert.match(w.detail, /sends, posts, buys or publishes/);
  assert.equal(w.line, 3, "it points at the step");
});

test("a verify satisfies it, and so does a person", () => {
  assert.equal(outwardErrors(flow({ verify: "test -s ../../storage/sent.md" })).length, 0);
  assert.equal(outwardErrors(flow({ approve: true })).length, 0);
  assert.equal(outwardErrors(flow({ ask: "Send these?" })).length, 0);
});

test("an agent that cannot act outward is not asked to prove anything", () => {
  assert.equal(outwardErrors(flow({}), { agents: ["sender"], outwardAgents: [] }).length, 0);
});

test("a caller that did not resolve the grants skips the rule rather than guessing", () => {
  assert.equal(outwardErrors(flow({}), { agents: ["sender"] }).length, 0);
});

test("outward is opt-in and explicit: only `outward: true` counts", () => {
  assert.equal(toolIsOutward({ outward: true }), true);
  assert.equal(toolIsOutward({ outward: "yes" }), false);
  assert.equal(toolIsOutward({}), false);
});

test("retry: on an outward step is a warning — a retry can send twice", () => {
  const warn = (step: Record<string, unknown>) => lintFlow(flow(step), known).filter((w) => /has retry:/.test(w.message));
  const [w] = warn({ verify: "test -s ../../storage/sent.md", retry: 2 });
  assert.ok(w, "the rule fired");
  assert.equal(w.level, undefined, "advisory, not an error");
  assert.match(w.message, /\[\[sender\]\] can act outside this workspace and this step has retry: 2/);
  assert.equal(warn({ verify: "x" }).length, 0, "no retry, nothing to say");
  assert.equal(lintFlow(flow({ verify: "x", retry: 2 }), { agents: ["sender"], outwardAgents: [] }).filter((w) => /has retry:/.test(w.message)).length, 0);
});

test("the runner declines a retry only when the tools ran and then the check failed", () => {
  const tool = { type: "tool", text: "mcp__scripts__send" };
  assert.equal(actedThenFailedCheck([tool, { type: "error", text: "verify `test -s sent.md` → exit 1" }]), true);
  assert.equal(actedThenFailedCheck([tool, { type: "error", text: "output: json — no JSON value found in the reply" }]), true);
  assert.equal(actedThenFailedCheck([tool, { type: "error", text: "schema: the value does not fit — .total is missing" }]), true);
  assert.equal(actedThenFailedCheck([{ type: "error", text: "verify `x` → exit 1" }]), false, "no tool ran: nothing could have been sent");
  assert.equal(actedThenFailedCheck([tool, { type: "error", text: "timed out after 60s (timeout: in the flow file)" }]), false, "a failure mid-way is not this case");
});

import { actedThenFailedCheck } from "../src/runner.ts";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { executeStep, type QueryFn } from "../src/step-exec.ts";

test("a failed shell verify or judge writes its detail after the headline — still no retry", () => {
  const tool = { type: "tool", text: "mcp__scripts__send" };
  // As executeStep writes them: the headline, then the detail, both tagged.
  const shell = [tool, { type: "error", text: "verify `test -s sent.md` → exit 1", check: true }, { type: "error", text: "test: sent.md: no such file", check: true }];
  assert.equal(actedThenFailedCheck(shell), true, "shell verify: the detail is the last error event");
  const judge = [tool, { type: "error", text: "verify `judge: the email went` → FAIL", check: true }, { type: "error", text: "FAIL — the reply never names a recipient", check: true }];
  assert.equal(actedThenFailedCheck(judge), true, "judge: the reasoning is the last error event");
  // A check failed, then something else failed after: the check is still what
  // failed after the tools ran.
  assert.equal(actedThenFailedCheck([tool, { type: "error", text: "free text", check: true }]), true, "the tag decides, not the wording");
  assert.equal(actedThenFailedCheck([tool, { type: "error", text: "the model stream ended without a result" }]), false);
});

test("executeStep tags every event of a failed check, detail included", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-outward-"));
  const agentDir = path.join(root, "agents", "sender");
  fs.mkdirSync(agentDir, { recursive: true });
  try {
    const query: QueryFn = () => Object.assign((async function* () {
      yield { type: "assistant", message: { id: "m1", content: [{ type: "tool_use", id: "c1", name: "mcp__scripts__send", input: {} }] } };
      yield { type: "assistant", message: { id: "m2", content: [{ type: "text", text: "Sent." }] } };
      yield { type: "result", subtype: "success", total_cost_usd: 0 };
    })(), { async interrupt() {} });
    const events: { type: string; text: string; check?: boolean }[] = [];
    const out = await executeStep({
      agentDir, workspaceRoot: root, libraryRoot: path.join(root, "library"),
      prompt: "send", model: "haiku", systemPrompt: "you send", allowed: [], mcpNames: [], mcpServers: {}, env: {},
      verify: "echo nothing was written >&2; exit 1",
      emit: (type, text, extra) => events.push({ type, text, ...(extra as { check?: boolean }) }),
    }, query);
    assert.equal(out.status, "failed");
    const errors = events.filter((e) => e.type === "error");
    assert.ok(errors.length >= 2, "headline and detail");
    assert.ok(errors.every((e) => e.check === true), "both carry the tag");
    assert.equal(actedThenFailedCheck(events), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

