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
  httpChannel,
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

test("ask_person: an unanswered question is closed on the proxy, best effort", async () => {
  let clock = 0;
  const closed: string[] = [];
  const base = {
    async ask() {
      return { id: "q_3" };
    },
    async poll(_id: string, maxMs: number) {
      clock += Math.min(maxMs, 25_000);
      return null;
    },
    async inbox() {
      return [];
    },
  };
  const r = recorder();
  const ok = buildAskTool({ channel: { ...base, async close(id) { closed.push(id); } }, timeoutSec: 60, emit: r.emit as never, now: () => clock });
  assert.equal(textOf((await ok.call({ question: "Which list?" })) as never), NO_ANSWER);
  assert.deepEqual(closed, ["q_3"], "the question no longer shows as waiting");
  clock = 0;
  const failing = buildAskTool({ channel: { ...base, async close() { throw new Error("proxy down"); } }, timeoutSec: 60, emit: r.emit as never, now: () => clock });
  assert.equal(textOf((await failing.call({ question: "Which list?" })) as never), NO_ANSWER, "a failed close changes nothing for the agent");
});

test("httpChannel.close sends DELETE /ask/<lease>/<id>", async () => {
  const calls: { url: string; method?: string }[] = [];
  const fake = (async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), method: init?.method });
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  const ch = httpChannel(`http://w:8090/e/${"t".repeat(24)}`, fake)!;
  await ch.close!("q_9");
  assert.deepEqual(calls, [{ url: `http://w:8090/ask/${"t".repeat(24)}/q_9`, method: "DELETE" }]);
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

// ---------------------------------------------------------------------------
// tools: [peers] — colleagues in one parallel group (20 Oct 2026)

import { PEER_BY_PREFIX, PEER_TOOLS, buildPeerTools, localPeerBus, peerAddress, peerMatches, peerOf, peersPromptLine, type PeerInfo } from "../src/operator.ts";

const SIBS: PeerInfo[] = [
  { agent: "writer", step: 1, instruction: "write the copy" },
  { agent: "image-maker", step: 2, instruction: "make the card image" },
];

test("peers: the group is a platform group, the names are fixed, and `by` tells a colleague from a person", () => {
  assert.ok(PLATFORM_GROUPS.has("peers"));
  assert.deepEqual(PEER_TOOLS, ["mcp__foldrun_peers__peers_list", "mcp__foldrun_peers__peers_message"]);
  assert.equal(peerOf(`${PEER_BY_PREFIX}writer`), "writer");
  assert.equal(peerOf("dev@example.com"), null);
  assert.equal(peerOf(null), null);
  assert.match(peersPromptLine(SIBS), /writer#2 \(write the copy\); image-maker#3/);
  assert.match(peersPromptLine([]), /runs alone/);
});

test("peers_list names the siblings; peers_message reaches one, or all, and is refused for a stranger", async () => {
  const { events, emit } = recorder();
  const told: { to: string; text: string }[] = [];
  const channel: OperatorChannel = {
    async ask() { throw new Error("no"); },
    async poll() { return null; },
    async inbox() { return []; },
    async peers() { return SIBS; },
    async tell(to, text) {
      told.push({ to, text });
      return { to: SIBS.filter((p) => peerMatches(p, to)).map(peerAddress) };
    },
  };
  const peers = buildPeerTools({ channel, self: "planner", siblings: SIBS, emit });
  const roster = textOf(await peers.list());
  assert.match(roster, /writer#2: write the copy/);
  assert.match(roster, /image-maker#3/);

  const one = await peers.message({ to: "writer", text: "the card is storage/images/2026-10-20.jpg" });
  assert.match(textOf(one), /Delivered to writer#2/);
  assert.deepEqual(told, [{ to: "writer", text: "the card is storage/images/2026-10-20.jpg" }]);
  const ev = events.find((e) => e.operator?.kind === "told")!;
  assert.ok(ev, "a `told` event is on the trace");
  assert.deepEqual((ev.operator as { to: string[] }).to, ["writer#2"]);

  const all = await peers.message({ to: "all", text: "plan changed: the date is 2026-10-21" });
  assert.match(textOf(all), /Delivered to writer#2, image-maker#3/);
  assert.match(textOf(await peers.message({ to: "image-maker#3", text: "by address" })), /Delivered to image-maker#3\./);

  const stranger = (await peers.message({ to: "editor", text: "hi" })) as { isError?: boolean };
  assert.equal(stranger.isError, true);
  assert.equal(told.length, 3, "a stranger is refused before the line is used");

  const alone = buildPeerTools({ channel: null, self: "solo", siblings: [], emit });
  assert.match(textOf(await alone.list()), /runs alone/);
  assert.equal(((await alone.message({ to: "all", text: "x" })) as { isError?: boolean }).isError, true);
});

test("a colleague's message reads as a colleague's in the inbox, and folds onto the record with `from`; a sent one with `to`", async () => {
  const { events, emit } = recorder();
  const channel: OperatorChannel = {
    async ask() { throw new Error("no"); },
    async poll() { return null; },
    async inbox() {
      return [
        { text: "which file is the card?", by: `${PEER_BY_PREFIX}writer`, at: "2026-10-20T00:00:00.000Z" },
        { text: "use the 2025 figures", by: "dev@example.com", at: "2026-10-20T00:00:01.000Z" },
      ];
    },
  };
  const read = inboxReader(channel, emit, 0);
  const context = (await read())!;
  assert.match(context, /Your colleague writer, running beside you/);
  assert.match(context, /<message from="writer">/);
  assert.match(context, /A person running this desk \(dev@example.com\)/);
  const kinds = events.map((e) => e.operator?.kind);
  assert.deepEqual(kinds, ["peer", "message"]);

  const step = {} as StepRecord;
  for (const e of events) applyOperatorEvent(step, e.operator!, "2026-10-20T00:00:02.000Z");
  applyOperatorEvent(step, { kind: "told", to: ["writer"], text: "storage/images/2026-10-20.jpg", at: "2026-10-20T00:00:03.000Z" }, "2026-10-20T00:00:03.000Z");
  assert.equal(step.messages!.length, 3);
  assert.equal(step.messages![0].from, "writer");
  assert.equal(step.messages![1].from, undefined);
  assert.deepEqual(step.messages![2].to, ["writer"]);

  assert.ok(isOperatorEvent({ kind: "peer", from: "writer", text: "hi", at: "2026-10-20T00:00:00.000Z" }));
  assert.ok(isOperatorEvent({ kind: "told", to: ["writer"], text: "hi", at: "2026-10-20T00:00:00.000Z" }));
  assert.equal(isOperatorEvent({ kind: "peer", text: "hi", at: "x" }), false, "a colleague's message names the colleague");
  assert.equal(isOperatorEvent({ kind: "told", to: "writer", text: "hi", at: "x" }), false, "`to` is a list");
});

test("localPeerBus: siblings in one process reach each other's inboxes, and nobody else's", async () => {
  const bus = localPeerBus();
  const planner = bus.channelFor({ agent: "planner", step: 0 }, SIBS);
  const writer = bus.channelFor({ agent: "writer", step: 1 }, [{ agent: "planner", step: 0, instruction: "plan" }, SIBS[1]]);
  const image = bus.channelFor({ agent: "image-maker", step: 2 }, []);
  assert.deepEqual(await planner.tell!("writer", "the date is 2026-10-20"), { to: ["writer#2"] });
  assert.deepEqual(await image.inbox(), [], "image-maker was not addressed");
  const got = await writer.inbox();
  assert.equal(got.length, 1);
  assert.equal(got[0].by, `${PEER_BY_PREFIX}planner#1`, "signed with the sender's address");
  assert.deepEqual(await writer.inbox(), [], "read once");
  assert.deepEqual(await writer.tell!("all", "got it"), { to: ["planner#1", "image-maker#3"] });
  assert.equal((await planner.inbox()).length, 1);
  assert.equal((await image.inbox()).length, 1);
  assert.deepEqual(await planner.tell!("editor", "x"), { to: [] }, "a stranger reaches nobody");
  // image-maker finishes (every attempt): it leaves every roster, and a message to it reaches nobody.
  bus.leave(2);
  assert.deepEqual(await planner.peers!(), [SIBS[0]]);
  assert.deepEqual(await planner.tell!("image-maker", "too late"), { to: [] });
  assert.deepEqual(await planner.tell!("all", "still here?"), { to: ["writer#2"] });

  // A fan-out: two instances of one agent. The bare name reaches both, the
  // address reaches one — so a reply to the instance that asked stays with it.
  const fan = localPeerBus();
  const lead = fan.channelFor({ agent: "lead", step: 0 }, [{ agent: "worker", step: 1, instruction: "item a" }, { agent: "worker", step: 2, instruction: "item b" }]);
  const wa = fan.channelFor({ agent: "worker", step: 1 }, []);
  const wb = fan.channelFor({ agent: "worker", step: 2 }, []);
  assert.deepEqual(await lead.tell!("worker", "both of you"), { to: ["worker#2", "worker#3"] });
  assert.deepEqual(await lead.tell!("worker#3", "only b"), { to: ["worker#3"] });
  assert.equal((await wa.inbox()).length, 1);
  assert.equal((await wb.inbox()).length, 2);
});

test("the http channel speaks the proxy's /peers doors", async () => {
  const calls: { url: string; method: string; body?: string }[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    calls.push({ url, method: init?.method ?? "GET", ...(init?.body ? { body: String(init.body) } : {}) });
    const body = url.endsWith("/message") ? { to: ["writer"] } : { peers: SIBS };
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  const ch = httpChannel(`http://proxy:8090/e/${"a".repeat(24)}`, fetchImpl)!;
  assert.deepEqual(await ch.peers!(), SIBS);
  assert.deepEqual(await ch.tell!("writer", "hello"), { to: ["writer"] });
  assert.equal(calls[0].url, `http://proxy:8090/peers/${"a".repeat(24)}`);
  assert.equal(calls[1].url, `http://proxy:8090/peers/${"a".repeat(24)}/message`);
  assert.equal(calls[1].method, "POST");
  assert.deepEqual(JSON.parse(calls[1].body!), { to: "writer", text: "hello" });
});
