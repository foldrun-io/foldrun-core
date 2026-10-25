// FOL-54 step 4: what a step records of itself — each model call as a span
// (`turn`), and under `capture: "full"` each tool call's input and output
// (`io`), capped; what crosses from the sandbox is validated; what is stored
// lives beside the run.
//
//   node --test tests/capture.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { executeStep, type QueryFn, type EventExtra } from "../src/step-exec.ts";
import { parseDriverLine } from "../src/run-container.ts";
import { writeCapturedCall, CAPTURE_CAP } from "../src/store.ts";

// Key armour, assembled: written out whole it is a "private key" to the scan.
const BEGIN = (kind: string) => ["-----BEGIN", kind, "PRIVATE", "KEY-----"].join(" ");
const END = (kind: string) => ["-----END", kind, "PRIVATE", "KEY-----"].join(" ");

function withAgent(body: (agentDir: string) => Promise<void>) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-capture-")));
  const agentDir = path.join(root, "agents", "scout");
  fs.mkdirSync(agentDir, { recursive: true });
  return body(agentDir).finally(() => fs.rmSync(root, { recursive: true, force: true }));
}

// Two turns: one that calls a tool (its blocks arriving as two messages
// under one id, as the SDK sends them), and the answer.
const fake: QueryFn = () =>
  Object.assign(
    (async function* () {
      const usage1 = { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 20 };
      yield { type: "assistant", message: { id: "msg_1", model: "claude-x", stop_reason: null, usage: usage1, content: [{ type: "text", text: "looking" }] } };
      yield { type: "assistant", message: { id: "msg_1", model: "claude-x", stop_reason: "tool_use", usage: { ...usage1, output_tokens: 9 }, content: [{ type: "tool_use", id: "toolu_1", name: "Read", input: { file_path: "a.txt" } }] } };
      yield { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "x".repeat(CAPTURE_CAP + 10) }] } };
      yield { type: "assistant", message: { id: "msg_2", model: "claude-x", stop_reason: "end_turn", usage: { input_tokens: 3, output_tokens: 2 }, content: [{ type: "text", text: "done" }] } };
      yield { type: "result", subtype: "success", result: "done", total_cost_usd: 0 };
    })(),
    { async interrupt() {} },
  );

const run = (agentDir: string, capture: "metadata" | "full" | undefined) => {
  const events: { type: string; text: string; extra?: EventExtra }[] = [];
  return executeStep(
    {
      agentDir, workspaceRoot: path.dirname(path.dirname(agentDir)), libraryRoot: "/nonexistent",
      prompt: "p", model: "haiku", systemPrompt: "s", allowed: ["Read"], mcpNames: [], mcpServers: {}, env: {},
      ...(capture ? { capture } : {}),
      emit: (type, text, extra) => events.push({ type, text, extra }),
    },
    fake,
  ).then(() => events);
};

test("full: each model call is one span kept up to date; the tool's input and output ride its events, capped", () =>
  withAgent(async (agentDir) => {
    const events = await run(agentDir, "full");
    const turns = events.filter((e) => e.extra?.turn).map((e) => e.extra!.turn!);
    const last = new Map(turns.map((t) => [t.id, t]));
    assert.deepEqual([...last.keys()], ["msg_1", "msg_2"]);
    const one = last.get("msg_1")!;
    assert.equal(one.n, 1);
    assert.equal(one.stop, "tool_use");
    assert.equal(one.tools, 1);
    assert.deepEqual(one.tokens, { input: 130, output: 9, cacheRead: 100, cacheWrite: 20 });
    assert.equal(last.get("msg_2")!.n, 2);
    const call = events.find((e) => e.type === "tool" && e.extra?.io?.input !== undefined)!;
    assert.equal(call.extra!.io!.input, JSON.stringify({ file_path: "a.txt" }));
    assert.equal(call.extra!.inCall, "msg_1", "the tool call names the model call that asked for it (FOL-72)");
    const done = events.find((e) => e.type === "tool" && e.extra?.io?.output !== undefined)!;
    assert.equal(done.extra!.io!.output!.length, CAPTURE_CAP + 10, "sent whole up to the slack: the runner masks, then cuts");
    assert.equal(done.extra!.io!.outputChars, CAPTURE_CAP + 10);
    assert.equal(done.extra!.io!.truncated, undefined);
  }));

test("metadata sends the spans and no content; unset sends neither (the consult, the probe)", () =>
  withAgent(async (agentDir) => {
    const meta = await run(agentDir, "metadata");
    assert.ok(meta.some((e) => e.extra?.turn));
    assert.ok(!meta.some((e) => e.extra?.io));
    const none = await run(agentDir, undefined);
    assert.ok(!none.some((e) => e.extra?.turn || e.extra?.io));
  }));

test("from the sandbox: io and turn are kept only when well-formed, and capped", () => {
  const ok = parseDriverLine(JSON.stringify({ e: "event", type: "tool", text: "Read", call: "toolu_1", io: { input: "x".repeat(CAPTURE_CAP + 9000), inputChars: CAPTURE_CAP + 9000, truncated: true } }));
  assert.ok(ok && ok.e === "event" && ok.io?.input?.length === CAPTURE_CAP + 4096, "the cap plus the masking slack");
  const turn = parseDriverLine(JSON.stringify({ e: "event", type: "info", text: "", turn: { id: "msg_1", n: 1, at: "2026-10-19T00:00:00.000Z", ms: 12, tokens: { input: 5, output: -3 }, tools: 1, subagent: "Bad Name" } }));
  assert.ok(turn && turn.e === "event" && turn.turn);
  assert.equal(turn.turn!.tokens.output, 0, "a negative count is not a count");
  assert.equal(turn.turn!.subagent, undefined);
  const bad = parseDriverLine(JSON.stringify({ e: "event", type: "info", text: "", turn: { id: 5 }, io: { input: 7 } }));
  assert.ok(bad && bad.e === "event" && !bad.turn && !bad.io);
});

test("stored beside the run: the call's two parts merge; an id that is a path is refused", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-calls-"));
  try {
    writeCapturedCall(root, "run-1", { id: "toolu_1", tool: "Read", input: "{}", inputChars: 2 });
    writeCapturedCall(root, "run-1", { id: "toolu_1", tool: "Read", output: "hi", outputChars: 2 });
    const file = path.join(root, "runs", "run-1", "calls", "toolu_1.json");
    assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { id: "toolu_1", tool: "Read", input: "{}", inputChars: 2, output: "hi", outputChars: 2 });
    writeCapturedCall(root, "run-1", { id: "../../x", tool: "Read", input: "evil" });
    writeCapturedCall(root, "..", { id: "toolu_2", tool: "Read", input: "evil" });
    assert.ok(!fs.existsSync(path.join(root, "x.json")) && !fs.existsSync(path.join(root, "runs", "..", "calls")));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("what is stored is masked: the step's secrets by value, and anything shaped like a key", async () => {
  const { recordCallIo } = await import("../src/capture.ts");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-mask-"));
  try {
    const vault = "s3cr3t-vault-value-123";
    // Made at run time: a key-shaped literal in the source is what the
    // commit's own secret scan refuses.
    const loose = ["sk", "ant", "api03", crypto.randomBytes(30).toString("hex")].join("-");
    const redact = (t: string) => t.split(vault).join("[redacted:CRM_TOKEN]");
    assert.ok(recordCallIo(root, "run-1", "toolu_9", "Bash", { input: `curl -H "x: ${vault}"`, output: `found ${loose} in .env` }, redact));
    const saved = fs.readFileSync(path.join(root, "runs", "run-1", "calls", "toolu_9.json"), "utf8");
    assert.ok(!saved.includes(vault), "the vault value is gone");
    assert.match(saved, /\[redacted:CRM_TOKEN\]/);
    assert.ok(!saved.includes(loose), "a key the agent found is gone too");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("the scrub's values: an @file secret by its content and line by line, every value also as JSON escapes it (review)", async () => {
  const { redactionsFor, maskCall } = await import("../src/capture.ts");
  const pemBody = [crypto.randomBytes(48).toString("base64"), crypto.randomBytes(48).toString("base64")];
  const pem = [BEGIN("RSA"), ...pemBody, END("RSA")].join("\n");
  const pairs = redactionsFor({ DEPLOY_KEY: `@file ${pem}`, TOKEN: 'ab"cd\\ef-123456', SHORT: "abc" });
  const values = pairs.map(([v]) => v);
  assert.ok(values.includes(pem) && values.includes(pemBody[0]!), "the content, and each long line");
  assert.ok(!values.some((v) => v.startsWith("@file")) || values.includes(pem));
  assert.ok(values.includes('ab\\"cd\\\\ef-123456'), "the JSON-escaped form");
  assert.ok(!values.includes("abc"));
  const redact = (t: string) => pairs.reduce((out, [v, n]) => out.split(v).join(`[redacted:${n}]`), t);
  // The Read tool numbers every line, so the block is never there whole.
  const numbered = pem.split("\n").map((l, i) => `${String(i + 1).padStart(6)}\t${l}`).join("\n");
  const read = maskCall(numbered, redact).text;
  assert.ok(!pemBody.some((l) => read.includes(l)), read);
  const json = maskCall(JSON.stringify({ command: `curl -H 'x: ab"cd\\ef-123456'` }), redact).text;
  assert.ok(!json.includes("cd\\\\ef"), json);
});

test("masked first, cut second: a secret on the cap's edge is masked whole; a private key found anywhere is masked", async () => {
  const { maskCall } = await import("../src/capture.ts");
  const secret = "edge-secret-value-0123456789";
  const text = "x".repeat(CAPTURE_CAP - 10) + secret + "tail";
  const out = maskCall(text, (t) => t.split(secret).join("[redacted:EDGE]"));
  // Cut the other way round, the first 10 characters would be kept bare.
  assert.ok(!out.text.includes(secret.slice(0, 10)), "no part of it survives the cut");
  assert.ok(out.text.length <= CAPTURE_CAP);
  const long = maskCall("y".repeat(CAPTURE_CAP + 100), (t) => t);
  assert.equal(long.text.length, CAPTURE_CAP);
  assert.equal(long.cut, true);
  const found = maskCall(`${BEGIN("OPENSSH")}\n${crypto.randomBytes(24).toString("base64")}\n${END("OPENSSH")}`, (t) => t).text;
  assert.equal(found, "[redacted:private key]");
  const unterminated = maskCall(`key:\n${BEGIN("RSA")}\n${crypto.randomBytes(24).toString("base64")}`, (t) => t).text;
  assert.equal(unterminated, "key:\n[redacted:private key]", "cut short or printed without its END line (review)");
});

test("the raw stream gives each call its true output tokens and stop reason; without it a call that used tools stopped for them (FOL-72)", () =>
  withAgent(async (agentDir) => {
    let opts: Record<string, unknown> = {};
    const streamed: QueryFn = ({ options }) => {
      opts = options;
      return Object.assign(
        (async function* () {
          yield { type: "stream_event", parent_tool_use_id: null, event: { type: "message_start", message: { id: "msg_a" } } };
          yield { type: "assistant", message: { id: "msg_a", model: "m", stop_reason: null, usage: { input_tokens: 5, output_tokens: 2 }, content: [{ type: "tool_use", id: "toolu_a", name: "Read", input: {} }] } };
          yield { type: "stream_event", parent_tool_use_id: null, event: { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 140 } } };
          yield { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "toolu_a", content: "ok" }] } };
          yield { type: "stream_event", parent_tool_use_id: null, event: { type: "message_start", message: { id: "msg_b" } } };
          yield { type: "assistant", message: { id: "msg_b", model: "m", stop_reason: null, usage: { input_tokens: 6, output_tokens: 1 }, content: [{ type: "text", text: "done" }] } };
          yield { type: "stream_event", parent_tool_use_id: null, event: { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 33 } } };
          yield { type: "result", subtype: "success", result: "done", total_cost_usd: 0 };
        })(),
        { async interrupt() {} },
      );
    };
    const events: { extra?: EventExtra }[] = [];
    await executeStep(
      { agentDir, workspaceRoot: path.dirname(path.dirname(agentDir)), libraryRoot: "/nonexistent", prompt: "p", model: "haiku", systemPrompt: "s", allowed: ["Read"], mcpNames: [], mcpServers: {}, env: {}, capture: "metadata", emit: (_t, _x, extra) => events.push({ extra }) },
      streamed,
    );
    assert.equal(opts.includePartialMessages, true, "asked for the stream when recording");
    const last = new Map(events.filter((e) => e.extra?.turn).map((e) => [e.extra!.turn!.id, e.extra!.turn!]));
    assert.deepEqual([last.get("msg_a")!.tokens.output, last.get("msg_a")!.stop], [140, "tool_use"]);
    assert.deepEqual([last.get("msg_b")!.tokens.output, last.get("msg_b")!.stop], [33, "end_turn"]);
    // No stream (an older CLI): the fallback.
    const plain = await run(agentDir, "metadata");
    const one = new Map(plain.filter((e) => e.extra?.turn).map((e) => [e.extra!.turn!.id, e.extra!.turn!])).get("msg_1")!;
    assert.equal(one.stop, "tool_use");
  }));
