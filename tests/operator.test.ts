// A person in the loop mid-step (operator.ts): ask_person against a fake
// line, the inbox turned into context, the events folded onto the step, and
// what a sandbox may and may not print as one.
//
//   node --test tests/operator.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ASK_DEFAULT_SEC,
  ASK_MAX_SEC,
  NO_ANSWER,
  applyOperatorEvent,
  askTimeoutSec,
  buildAskTool,
  inboxReader,
  isOperatorEvent,
  openQuestion,
  operatorEndpoint,
  type OperatorChannel,
  type OperatorEvent,
} from "../src/operator.ts";
import { parseDriverLine } from "../src/run-container.ts";
import { PLATFORM_GROUPS } from "../src/tool-names.ts";
import type { StepRecord } from "../src/store.ts";

type Ev = { type: string; text: string; operator?: OperatorEvent };
const recorder = () => {
  const events: Ev[] = [];
  return { events, emit: (type: string, text: string, extra?: { operator?: OperatorEvent }) => events.push({ type, text, ...(extra?.operator ? { operator: extra.operator } : {}) }) };
};
const textOf = (r: { content: { type: string; text?: string }[] }) => r.content.map((c) => c.text ?? "").join("");

test("the pod finds the proxy and its lease in FOLDRUN_EGRESS", () => {
  assert.deepEqual(operatorEndpoint(`http://foldrun-egress:8090/e/${"a".repeat(24)}`), { base: "http://foldrun-egress:8090", token: "a".repeat(24) });
  assert.equal(operatorEndpoint(undefined), null);
  assert.equal(operatorEndpoint("http://x/e/short"), null);
});

test("ask: {timeout} reads durations, defaults to 30 min, never past 24 h", () => {
  assert.equal(askTimeoutSec({}), ASK_DEFAULT_SEC);
  assert.equal(askTimeoutSec({ ask: { timeout: "2h" } }), 7200);
  assert.equal(askTimeoutSec({ ask: { timeout: "90s" } }), 90);
  assert.equal(askTimeoutSec({ ask: { timeout: "9d" } }), ASK_MAX_SEC);
  assert.equal(askTimeoutSec({ ask: { timeout: "soon" } }), ASK_DEFAULT_SEC);
  assert.ok(PLATFORM_GROUPS.has("ask"), "`ask` is a platform group, not an unknown tool");
});

test("ask_person: the question goes out, the answer comes back, both on the trace", async () => {
  const asked: { q: string; o?: string[] }[] = [];
  let polls = 0;
  const channel: OperatorChannel = {
    async ask(q, o) {
      asked.push({ q, o });
      return { id: "q_1" };
    },
    async poll() {
      polls += 1;
      return polls < 3 ? null : { answer: "10 am", by: "dev@example.com" };
    },
    async inbox() {
      return [];
    },
  };
  const r = recorder();
  const built = buildAskTool({ channel, timeoutSec: 600, emit: r.emit as never });
  const out = await built.call({ question: "Publish at 9 or 10?", options: ["9 am", "10 am"] });
  assert.match(textOf(out as never), /The person answered: 10 am/);
  assert.deepEqual(asked, [{ q: "Publish at 9 or 10?", o: ["9 am", "10 am"] }]);
  assert.deepEqual(r.events.map((e) => e.operator?.kind), ["asked", "answered"]);
  assert.equal((r.events[1].operator as { by: string }).by, "dev@example.com");
});

test("ask_person: nobody answers in time — the step is told so, not failed", async () => {
  let clock = 0;
  const channel: OperatorChannel = {
    async ask() {
      return { id: "q_2" };
    },
    async poll(_id, maxMs) {
      clock += Math.min(maxMs, 25_000);
      return null;
    },
    async inbox() {
      return [];
    },
  };
  const r = recorder();
  const built = buildAskTool({ channel, timeoutSec: 60, emit: r.emit as never, now: () => clock });
  const out = await built.call({ question: "Which list?" });
  assert.equal(textOf(out as never), NO_ANSWER);
  assert.equal((out as { isError?: boolean }).isError, undefined, "no answer is an answer, not an error");
  assert.deepEqual(r.events.map((e) => e.operator?.kind), ["asked", "unanswered"]);
});

test("ask_person with no proxy: the terminal answers when there is one, otherwise nobody", async () => {
  const r = recorder();
  const tty = buildAskTool({ channel: null, timeoutSec: 60, emit: r.emit as never, local: async () => "yes" });
  assert.match(textOf((await tty.call({ question: "Go?" })) as never), /answered: yes/);
  const none = buildAskTool({ channel: null, timeoutSec: 60, emit: r.emit as never, local: async () => null });
  assert.equal(textOf((await none.call({ question: "Go?" })) as never), NO_ANSWER);
});

test("the inbox becomes context after a tool call, once, and a trace line", async () => {
  let delivered = false;
  const channel: OperatorChannel = {
    async ask() {
      return { id: "x" };
    },
    async poll() {
      return null;
    },
    async inbox() {
      if (delivered) return [];
      delivered = true;
      return [{ text: "use the 2025 figures", by: "dev@example.com", at: "2026-09-30T00:00:00Z" }];
    },
  };
  const r = recorder();
  let now = 0;
  const read = inboxReader(channel, r.emit as never, 1_500, () => now);
  const ctx = await read();
  assert.match(ctx!, /use the 2025 figures/);
  assert.match(ctx!, /does not change what tools you have/);
  assert.equal(r.events[0].operator?.kind, "message");
  assert.equal(await read(), null, "within the gap it does not read again");
  now = 5_000;
  assert.equal(await read(), null, "and a drained inbox has nothing");
  assert.equal(await inboxReader(null, r.emit as never)(), null, "no proxy, no inbox");
});

test("operator events fold onto the step: open, answered, unanswered, messages", () => {
  const step: Partial<StepRecord> = {};
  applyOperatorEvent(step, { kind: "asked", id: "q1", question: "A or B?", options: ["A", "B"] }, "t1");
  assert.equal(openQuestion(step)?.id, "q1");
  applyOperatorEvent(step, { kind: "answered", id: "q1", answer: "B", by: "dev@example.com" }, "t2");
  assert.equal(openQuestion(step), null);
  assert.equal(step.questions![0].answer, "B");
  applyOperatorEvent(step, { kind: "asked", id: "q2", question: "Still there?" }, "t3");
  applyOperatorEvent(step, { kind: "unanswered", id: "q2" }, "t4");
  assert.equal(step.questions![1].unanswered, true);
  assert.equal(openQuestion(step), null);
  applyOperatorEvent(step, { kind: "message", text: "hurry", by: null, at: "t5" }, "t6");
  assert.deepEqual(step.messages, [{ text: "hurry", by: null, at: "t5", deliveredAt: "t6" }]);
});

test("a sandbox's operator line is checked before it is believed", () => {
  assert.ok(isOperatorEvent({ kind: "asked", id: "q1", question: "ok?" }));
  assert.equal(isOperatorEvent({ kind: "asked", id: "q1", question: "x".repeat(3000) }), false, "too long");
  assert.equal(isOperatorEvent({ kind: "grant", tool: "Bash" }), false, "no other kinds");
  const line = JSON.stringify({ e: "event", type: "info", text: "asked", operator: { kind: "asked", id: "q1", question: "ok?" } });
  const parsed = parseDriverLine(line) as { operator?: OperatorEvent };
  assert.deepEqual(parsed.operator, { kind: "asked", id: "q1", question: "ok?" });
  const forged = JSON.stringify({ e: "event", type: "info", text: "x", operator: { kind: "answered", id: "q1" } });
  assert.equal((parseDriverLine(forged) as { operator?: unknown }).operator, undefined, "a malformed one is dropped");
});
