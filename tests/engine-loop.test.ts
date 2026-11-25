// foldrun's own agent loop (src/engine-loop.ts), driven the way production
// drives it: through executeStep, with `engine: "foldrun"`, against a model
// endpoint that plays back scripted turns. The behaviour tests are written
// per loop (`both`, ENGINES): a second loop put behind executeStep — Pi was
// tried and set aside on 22 Nov 2026 (FOL-213) — must pass every one. So what is tested is the
// loop under step-exec's real hooks, confinement, limits and clocks — not a
// stand-in for them.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { executeStep, type ExecOptions } from "../src/step-exec.ts";
import { buildRequest, foldrunQuery, showsThinking, thinkingParam, effortParam, takesEffort, ENGINE_FEATURES } from "../src/engine-loop.ts";
import type { QueryFn } from "../src/step-exec.ts";
import { ENGINE_TOOLS } from "../src/engine-tools.ts";
import { checkMcpSpecs, outcomeOf, connectMcp } from "../src/engine-mcp.ts";
import { SUMMARY_PREFIX, findCut, compacted, previousSummary, summaryRequest, serializeConversation, isContextOverflow } from "../src/engine-compact.ts";
import { readOptions } from "../src/engine-common.ts";
import { readHistory } from "../src/engine-common.ts";
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

type Block = { type: "text"; text: string } | { type: "tool_use"; id: string; name: string; input: unknown; rawInput?: string };
interface Scripted {
  content: Block[];
  /** End the stream after the first block's text, with no closing events. */
  cut?: boolean;
  stop?: string;
  status?: number;
  /** The error message a `status` answer carries. */
  error?: string;
  /** Headers a `status` answer carries. */
  headers?: Record<string, string>;
  /** Leave the blocks open: the closing events come, the block stops do not. */
  unclosed?: boolean;
  /** End after message_delta, with no message_stop. */
  noStop?: boolean;
  /** Counts the closing message_delta carries, over output_tokens. */
  deltaUsage?: Record<string, number>;
  usage?: { input_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number; output_tokens?: number };
}

/** A Messages endpoint that answers each request with the next scripted turn. */
async function fakeModel(turns: Scripted[]) {
  const requests: { headers: http.IncomingHttpHeaders; body: any }[] = [];
  let n = 0;
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      requests.push({ headers: req.headers, body: JSON.parse(raw) });
      const turn = turns[Math.min(n, turns.length - 1)];
      n++;
      if (turn.status) {
        res.writeHead(turn.status, { "content-type": "application/json", ...(turn.headers ?? {}) });
        return res.end(JSON.stringify({ type: "error", error: { type: turn.status === 400 ? "invalid_request_error" : "overloaded_error", message: turn.error ?? "busy" } }));
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      const send = (ev: Record<string, unknown>) => res.write(`event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`);
      const u = turn.usage ?? {};
      send({ type: "message_start", message: { id: `msg_${n}`, model: "test-model", usage: { input_tokens: u.input_tokens ?? 10, cache_read_input_tokens: u.cache_read_input_tokens ?? 0, cache_creation_input_tokens: u.cache_creation_input_tokens ?? 0, output_tokens: 1 } } });
      turn.content.forEach((b, index) => {
        if (b.type === "text") {
          send({ type: "content_block_start", index, content_block: { type: "text", text: "" } });
          // In two pieces, as a real stream would send it.
          const half = Math.ceil(b.text.length / 2);
          send({ type: "content_block_delta", index, delta: { type: "text_delta", text: b.text.slice(0, half) } });
          if (turn.cut) return;
          send({ type: "content_block_delta", index, delta: { type: "text_delta", text: b.text.slice(half) } });
        } else {
          send({ type: "content_block_start", index, content_block: { type: "tool_use", id: b.id, name: b.name, input: {} } });
          const json = b.rawInput ?? JSON.stringify(b.input);
          const half = Math.ceil(json.length / 2);
          send({ type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: json.slice(0, half) } });
          send({ type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: json.slice(half) } });
        }
        if (!turn.unclosed) send({ type: "content_block_stop", index });
      });
      if (turn.cut) return res.end();
      const stop = turn.stop ?? (turn.content.some((b) => b.type === "tool_use") ? "tool_use" : "end_turn");
      send({ type: "message_delta", delta: { stop_reason: stop }, usage: { output_tokens: u.output_tokens ?? 5, ...(turn.deltaUsage ?? {}) } });
      if (!turn.noStop) send({ type: "message_stop" });
      res.end();
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { url, requests, close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }) };
}

interface Event { type: string; text: string; extra?: Record<string, unknown> }

const roots: string[] = [];
process.once("exit", () => { for (const r of roots) fs.rmSync(r, { recursive: true, force: true }); });

async function runStep(turns: Scripted[], over: Partial<ExecOptions> & { files?: Record<string, string> } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-engine-loop-")));
  const agentDir = path.join(root, "agents", "coder");
  fs.mkdirSync(agentDir, { recursive: true });
  const { files, ...opts } = over;
  for (const [f, text] of Object.entries(files ?? {})) {
    fs.mkdirSync(path.dirname(path.join(agentDir, f)), { recursive: true });
    fs.writeFileSync(path.join(agentDir, f), text);
  }
  const model = await fakeModel(turns);
  const events: Event[] = [];
  try {
    const run = () => executeStep({
      engine: "foldrun",
      agentDir, workspaceRoot: root, libraryRoot: "/nonexistent",
      prompt: "do the task", model: "test-model", systemPrompt: "You write code.",
      allowed: ["Read", "Write", "Edit", "Glob", "Grep"], mcpNames: [], mcpServers: {},
      emit: (type, text, extra) => events.push({ type, text, extra: extra as Record<string, unknown> }),
      ...opts,
      env: { PATH: process.env.PATH, ANTHROPIC_BASE_URL: model.url, ANTHROPIC_API_KEY: "test-key", ...(opts.env ?? {}) },
    });
    let out: Awaited<ReturnType<typeof executeStep>> | null = null;
    let error: Error | null = null;
    try {
      out = await run();
    } catch (err) {
      error = err as Error;
    }
    return { out, error, events, requests: model.requests, agentDir, root, read: (f: string) => fs.readFileSync(path.join(agentDir, f), "utf8") };
  } finally {
    await model.close();
    // The caller reads the files after this resolves, so the tree goes
    // when the process does.
    roots.push(root);
  }
}

const use = (id: string, name: string, input: unknown): Block => ({ type: "tool_use", id, name, input });
const say = (text: string): Block => ({ type: "text", text });

const ENGINES: Record<"foldrun", QueryFn> = { foldrun: foldrunQuery };
type EngineName = keyof typeof ENGINES;
interface On { engine: EngineName; step: typeof runStep; loop: QueryFn }
/** One behaviour, tested on each loop. */
function both(name: string, fn: (on: On) => unknown) {
  for (const engine of Object.keys(ENGINES) as EngineName[]) {
    test(`${name} [${engine}]`, () => fn({ engine, step: (turns, over = {}) => runStep(turns, { engine, ...over }), loop: ENGINES[engine] }));
  }
}

test("no environment variable chooses the engine or drops the shell's sandbox — a secret's name is the tenant's to pick", () => {
  // A step's environment carries its secrets under names the tenant chose,
  // so a switch read from it would be the tenant's to throw. The choice is
  // ExecOptions.engine, and nothing in the engine reads a name for it.
  const src = path.join(import.meta.dirname, "..", "src");
  for (const file of ["engine-loop.ts", "engine-common.ts", "engine-tools.ts", "step-exec.ts"]) {
    const code = fs.readFileSync(path.join(src, file), "utf8").split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
    assert.equal(/FOLDRUN_ENGINE/.test(code), false, `${file} reads no FOLDRUN_ENGINE* name`);
  }
  assert.match(fs.readFileSync(path.join(src, "step-exec.ts"), "utf8"), /runQuery: QueryFn = opts\.engine === "foldrun" \? foldrunQuery : \(query as unknown as QueryFn\)/);
  // And the engine itself does not take the word of its environment.
  assert.throws(
    () => foldrunQuery({ prompt: "p", options: { cwd: "/tmp", model: "m", tools: ["Bash"], env: { FOLDRUN_ENGINE_HOST_BASH: "1", FOLDRUN_ENGINE: "foldrun" } } }),
    /no OS sandbox for the shell on this host/,
  );
});

both("a coding step: read, edit, answer — the file changes and the record says what happened", async ({ engine, step, loop }) => {
  const r = await step([
    { content: [say("I'll read it first."), use("t1", "Read", { file_path: "math.js" })] },
    { content: [use("t2", "Edit", { file_path: "math.js", old_string: "a - b", new_string: "a + b" })], usage: { input_tokens: 4, cache_read_input_tokens: 30, output_tokens: 7 } },
    { content: [say("Fixed: add() now adds.")] },
  ], { files: { "math.js": "export const add = (a, b) => a - b;\n" }, capture: "full" });

  assert.equal(r.error, null);
  assert.equal(r.out!.status, "completed");
  assert.equal(r.read("math.js"), "export const add = (a, b) => a + b;\n");
  assert.equal(r.out!.conclusion, "Fixed: add() now adds.");
  assert.equal(r.out!.result, "I'll read it first.\nFixed: add() now adds.");
  assert.equal(r.out!.turns, 3);
  assert.equal(r.out!.stopReason, "end_turn");
  // Three turns' tokens, cache reads counted inside the input total.
  assert.deepEqual(r.out!.usage, { inputTokens: 10 + 4 + 30 + 10, outputTokens: 5 + 7 + 5, cacheReadTokens: 30, cacheWriteTokens: 0 });

  // Each call is opened and closed on the trace, paired by its id.
  const tools = r.events.filter((e) => e.type === "tool");
  assert.deepEqual(tools.map((e) => [e.text, e.extra?.call, typeof e.extra?.ms]), [
    ["Read", "t1", "undefined"], ["Read", "t1", "number"], ["Edit", "t2", "undefined"], ["Edit", "t2", "number"],
  ]);
  assert.ok(r.events.some((e) => e.extra?.responding === true), "siblings waiting on the prompt cache are released");
  const spans = r.events.filter((e) => e.extra?.turn).map((e) => e.extra!.turn as { id: string; stop?: string; tools: number });
  assert.equal(spans.find((s) => s.id === "msg_1")?.stop, "tool_use");
  assert.equal(spans.filter((s) => s.id === "msg_3").at(-1)?.stop, "end_turn");

  // The conversation is carried: the second request holds the first turn and its result.
  const second = r.requests[1].body.messages;
  assert.equal(second.length, 3);
  assert.equal(second[1].role, "assistant");
  assert.equal(second[2].content[0].type, "tool_result");
  assert.equal(second[2].content[0].tool_use_id, "t1");
  assert.match(second[2].content[0].content, /^1\texport const add/);
  assert.equal(r.requests[0].headers["x-api-key"], "test-key");
});

test("cache marks sit on the tools, the system prompt and the newest message — and nowhere else", () => {
  const messages = [
    { role: "user", content: [{ type: "text", text: "task" }] },
    { role: "assistant", content: [{ type: "tool_use", id: "t", name: "Read", input: {} }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: "x" }, { type: "text", text: "note" }] },
  ];
  const body = buildRequest({ model: "m", systemPrompt: "sys", tools: [ENGINE_TOOLS.Read, ENGINE_TOOLS.Edit], env: { CLAUDE_CODE_MAX_OUTPUT_TOKENS: "4096" } }, messages) as any;
  const mark = { type: "ephemeral" };
  assert.deepEqual(body.system, [{ type: "text", text: "sys", cache_control: mark }]);
  assert.deepEqual(body.tools.map((t: any) => t.cache_control), [undefined, mark]);
  assert.deepEqual(body.messages.flatMap((m: any) => m.content.map((b: any) => b.cache_control)), [undefined, undefined, undefined, mark]);
  assert.equal(body.max_tokens, 4096);
  assert.equal(JSON.stringify(messages).includes("cache_control"), false, "the conversation itself is not marked");
});

both("confinement is step-exec's, unchanged: a path outside the workspace is refused and never read", async ({ engine, step, loop }) => {
  const secret = path.join(os.tmpdir(), `foldrun-engine-secret-${process.pid}.txt`);
  fs.writeFileSync(secret, "TOP SECRET");
  try {
    const r = await step([
      { content: [use("t1", "Read", { file_path: secret })] },
      { content: [say("I could not read it.")] },
    ]);
    assert.equal(r.out!.status, "completed");
    const result = r.requests[1].body.messages[2].content[0];
    assert.equal(result.is_error, true);
    assert.equal(JSON.stringify(r.requests[1].body).includes("TOP SECRET"), false, "the file's text never reached the model");
    assert.ok(r.events.some((e) => e.type === "error" && e.extra?.call === "t1"), "the refusal is on the trail against its call");
  } finally {
    fs.rmSync(secret, { force: true });
  }
});

both("workspace/ paths are expanded by the hook's rewrite, and the tool runs on the rewritten input", async ({ engine, step, loop }) => {
  const r = await step([
    { content: [use("t1", "Write", { file_path: "workspace/storage/report.txt", content: "done" })] },
    { content: [say("Written.")] },
  ]);
  assert.equal(r.out!.status, "completed");
  assert.equal(fs.readFileSync(path.join(r.root, "storage", "report.txt"), "utf8"), "done");
});

both("limits: a call past the limit never runs, and the model is told", async ({ engine, step, loop }) => {
  const r = await step([
    { content: [use("t1", "Write", { file_path: "a.txt", content: "1" })] },
    { content: [use("t2", "Write", { file_path: "b.txt", content: "2" })] },
    { content: [say("One written.")] },
  ], { limits: { calls: 1 } });
  assert.equal(r.out!.status, "completed");
  assert.equal(fs.existsSync(path.join(r.agentDir, "a.txt")), true);
  assert.equal(fs.existsSync(path.join(r.agentDir, "b.txt")), false, "the refused call wrote nothing");
  const refused = r.requests[2].body.messages[4].content[0];
  assert.equal(refused.is_error, true);
  assert.match(refused.content, /^limit reached: calls 1 of 1/);
});

both("a tool the agent was not given, and arguments that are not JSON, come back as errors the model can act on", async ({ engine, step, loop }) => {
  const r = await step([
    { content: [use("t1", "Bash", { command: "echo hi" }), { type: "tool_use", id: "t2", name: "Read", input: {}, rawInput: '{"file_path": "a' }] },
    { content: [say("ok")] },
  ]);
  assert.equal(r.out!.status, "completed");
  const [bash, read] = r.requests[1].body.messages[2].content;
  assert.equal(bash.content, "Tool Bash is not enabled for this agent.");
  assert.match(read.content, /were not valid JSON/);
  assert.equal(bash.is_error && read.is_error, true);
});

both("several reads in one turn all answer, in the order asked", async ({ engine, step, loop }) => {
  const r = await step([
    { content: [use("a", "Read", { file_path: "1.txt" }), use("b", "Read", { file_path: "2.txt" }), use("c", "Glob", { pattern: "*.txt" })] },
    { content: [say("read both")] },
  ], { files: { "1.txt": "one", "2.txt": "two" } });
  const results = r.requests[1].body.messages[2].content;
  assert.deepEqual(results.map((b: any) => b.tool_use_id), ["a", "b", "c"]);
  assert.equal(results[0].content, "1\tone");
  assert.equal(results[1].content, "1\ttwo");
});

both("max_turns ends the step as failed, saying so", async ({ engine, step, loop }) => {
  const r = await step([{ content: [use("t", "Glob", { pattern: "*" })] }], { maxTurns: 2 });
  assert.equal(r.out!.status, "failed");
  assert.equal(r.requests.length, 2);
  assert.ok(r.events.some((e) => e.type === "error" && /stopped after 2 turns/.test(e.text)));
});

both("only a reply the model ended itself finishes the step (FOL-211)", async ({ engine, step, loop }) => {
  const finished = await step([{ content: [say("All done.")], stop: "end_turn" }]);
  assert.equal(finished.out!.status, "completed");
  assert.equal(finished.out!.stopReason, "end_turn");

  // Cut off at the output limit: failed, saying why, the partial reply kept.
  const cut = await step([{ content: [say("Here is the first half of the")], stop: "max_tokens" }]);
  assert.equal(cut.out!.status, "failed");
  assert.equal(cut.out!.stopReason, "max_tokens");
  assert.equal(cut.events.filter((e) => e.type === "error").length, 1, "said once");
  assert.ok(cut.events.some((e) => e.type === "error" && /cut off at the output limit/.test(e.text)));
  assert.equal(cut.out!.result, "Here is the first half of the");

  // A pause the provider made is carried on, then the finish counts.
  const paused = await step([{ content: [say("part one")], stop: "pause_turn" }, { content: [say("and done")], stop: "end_turn" }]);
  assert.equal(paused.out!.status, "completed");
  assert.equal(paused.requests.length, 2);


  const refused = await step([{ content: [say("I can't help with that.")], stop: "refusal" }]);
  assert.equal(refused.out!.status, "failed");
  assert.ok(refused.events.some((e) => e.type === "error" && /declined/.test(e.text)));

  const strange = await step([{ content: [say("hm")], stop: "something_new" }]);
  assert.equal(strange.out!.status, "failed");
  assert.ok(strange.events.some((e) => e.type === "error" && /something_new/.test(e.text)));

  // Said it would call a tool and sent none.
  const empty = await step([{ content: [say("calling now")], stop: "tool_use" }]);
  assert.equal(empty.out!.status, "failed");
  assert.ok(empty.events.some((e) => e.type === "error" && /sent none/.test(e.text)));
});

test("endOf: each stop reason, and the result keeps the partial reply", async () => {
  const { endOf } = await import("../src/engine-loop.ts");
  assert.equal(endOf("end_turn", 0).subtype, "success");
  assert.equal(endOf("stop_sequence", 0).subtype, "success");
  assert.equal(endOf("max_tokens", 0).subtype, "error_max_output");
  assert.equal(endOf("max_tokens", 2).subtype, "error_max_output");
  assert.equal(endOf("refusal", 0).subtype, "error_refusal");
  assert.equal(endOf("model_context_window_exceeded", 0).subtype, "error_context_full");
  assert.equal(endOf("tool_use", 0).subtype, "error_empty_tool_turn");
  assert.equal(endOf(null, 0).subtype, "error_unknown_stop");
  assert.equal(endOf("end_turn", 0).error, undefined);

  const server = await fakeModel([{ content: [say("half a sent")], stop: "max_tokens" }]);
  try {
    const out: any[] = [];
    for await (const m of foldrunQuery({ prompt: "go", options: { cwd: os.tmpdir(), model: "test-model", tools: [], env: { ANTHROPIC_BASE_URL: server.url, ANTHROPIC_API_KEY: "k" } } })) out.push(m);
    const result = out.find((m) => m.type === "result");
    assert.equal(result.subtype, "error_max_output");
    assert.equal(result.is_error, true);
    assert.equal(result.result, "half a sent");
    assert.match(result.errors[0], /output limit/);
  } finally {
    await server.close();
  }

  // A refusal after a tool turn carries the refusal's (empty) words in the
  // loop's result — what the CLI reads — not the earlier turn's "I'll check".
  const late = await fakeModel([{ content: [say("I'll check"), use("g", "Glob", { pattern: "*" })] }, { content: [], stop: "refusal" }]);
  try {
    const out: any[] = [];
    for await (const m of foldrunQuery({ prompt: "go", options: { cwd: os.tmpdir(), model: "test-model", tools: ["Glob"], env: { ANTHROPIC_BASE_URL: late.url, ANTHROPIC_API_KEY: "k" } } })) out.push(m);
    const result = out.find((m) => m.type === "result");
    assert.equal(result.subtype, "error_refusal");
    assert.equal(result.result, "");
  } finally {
    await late.close();
  }
});

test("x-should-retry is believed (23 Nov 2026): false stops at the first answer, true retries a status that would not be; the engine names itself", async () => {
  const run = async (turns: Scripted[], extra: Record<string, unknown> = {}, env: Record<string, string> = {}) => {
    const server = await fakeModel(turns);
    const out: any[] = [];
    let error: Error | null = null;
    try {
      for await (const m of foldrunQuery({ prompt: "go", options: { cwd: os.tmpdir(), model: "test-model", tools: [], env: { ANTHROPIC_BASE_URL: server.url, ANTHROPIC_API_KEY: "k", ...env }, ...extra } })) out.push(m);
    } catch (err) {
      error = err as Error;
    } finally {
      await server.close();
    }
    return { out, error, requests: server.requests };
  };
  const once = await run([{ status: 503, content: [], error: "anthropic has no usable key on this platform", headers: { "x-should-retry": "false" } }]);
  assert.equal(once.requests.length, 1, "no retry of a 503 the server says will not change");
  assert.match(String(once.error?.message), /no usable key/);
  const again = await run([{ status: 400, content: [], headers: { "x-should-retry": "true" } }, { content: [say("ok")] }]);
  assert.equal(again.requests.length, 2);
  assert.equal(once.requests[0].headers["user-agent"], "foldrun-engine");
  const named = await run([{ content: [say("hi")] }], { userAgent: "foldrun-cli/9.9.9" });
  assert.equal(named.requests[0].headers["user-agent"], "foldrun-cli/9.9.9");
  // Not from the environment (a tenant's secret could be named anything),
  // and never another product's name.
  const fromEnv = await run([{ content: [say("hi")] }], {}, { FOLDRUN_USER_AGENT: "claude-cli/1.0.0" });
  assert.equal(fromEnv.requests[0].headers["user-agent"], "foldrun-engine");
  const posing = await run([{ content: [say("hi")] }], { userAgent: "claude-cli/2.0.0 (external, cli)" });
  assert.equal(posing.requests[0].headers["user-agent"], "foldrun-engine");
  const custom = await run([{ content: [say("hi")] }], { userAgent: "foldrun-cli/9.9.9" }, { ANTHROPIC_CUSTOM_HEADERS: "User-Agent: claude-cli/2.0.0\nx-team: blue" });
  assert.equal(custom.requests[0].headers["user-agent"], "foldrun-cli/9.9.9", "a custom header does not replace the caller's name");
  assert.equal(custom.requests[0].headers["x-team"], "blue", "other custom headers still go");
});

both("an overloaded endpoint is retried; a refused request is not", async ({ engine, step, loop }) => {
  const retried = await step([{ status: 529, content: [] }, { content: [say("there now")] }]);
  assert.equal(retried.out!.status, "completed");
  assert.equal(retried.requests.length, 2);
  const refused = await step([{ status: 400, content: [] }]);
  assert.match(refused.error!.message, /the model endpoint answered 400/);
  assert.equal(refused.requests.length, 1);
});

both("the shell: refused on a host that asked for an OS sandbox, run where the caller is the boundary", async ({ engine, step, loop }) => {
  const turns: Scripted[] = [
    { content: [use("t1", "Bash", { command: "echo built > out.txt && cat out.txt" })] },
    { content: [say("Built.")] },
  ];
  const host = await step(turns, { allowed: ["Bash"] });
  assert.match(host.error!.message, /no OS sandbox for the shell on this host/);
  assert.equal(host.requests.length, 0, "refused before a model call was paid for");

  const contained = await step(turns, { allowed: ["Bash"], sandboxBash: false });
  assert.equal(contained.out!.status, "completed");
  assert.equal(contained.read("out.txt"), "built\n");
  assert.equal(contained.requests[1].body.messages[2].content[0].content, "built");
});

both("the shell is still confined by step-exec: a command reaching outside the workspace is refused", async ({ engine, step, loop }) => {
  const r = await step([
    { content: [use("t1", "Bash", { command: "cat ../../../secrets.json" })] },
    { content: [say("refused")] },
  ], { allowed: ["Bash"], sandboxBash: false });
  const result = r.requests[1].body.messages[2].content[0];
  assert.equal(result.is_error, true);
  assert.match(result.content, /^Bash was denied/);
});

both("a timeout ends a running command and the step, with the cost of the turns it took", async ({ engine, step, loop }) => {
  const started = Date.now();
  const r = await step([{ content: [use("t1", "Bash", { command: "sleep 60" })] }], { allowed: ["Bash"], sandboxBash: false, timeoutSec: 1 });
  assert.equal(r.out!.status, "failed");
  assert.ok(Date.now() - started < 10_000, "the step did not wait for the command");
  assert.ok(r.events.some((e) => e.type === "error" && /^timed out after 1s/.test(e.text)));
  assert.equal(r.out!.usage?.outputTokens, 5, "the turn it took is still counted");
});

both("what this engine cannot run yet is refused by name, not run without", ({ engine, step, loop }) => {
  const base = { cwd: "/tmp", model: "m", env: {}, tools: [] as string[] };
  assert.throws(() => loop({ prompt: "p", options: { ...base, mcpServers: { crm: {} } } }), /cannot connect the MCP server crm \(type stdio\)/);
  assert.throws(() => loop({ prompt: "p", options: { ...base, mcpServers: { crm: { type: "ws", url: "ws://x" } } } }), /cannot connect the MCP server crm \(type ws\)/);
  assert.throws(() => loop({ prompt: "p", options: { ...base, agents: { helper: {} } } }), /does not run sub-agents yet/);
  assert.throws(() => loop({ prompt: "p", options: { ...base, tools: ["Read", "TodoWrite"] } }), /no tool named TodoWrite yet/);
});

both("a call is checked just before it runs: a link made by an earlier command in the same turn does not open a way out", async ({ engine, step, loop }) => {
  // knowledge/ may not be written by an agent. Checked ahead of the turn,
  // the Write below named a path that did not exist yet; checked in its
  // turn, it names a link into knowledge/ and is refused.
  const r = await step([
    { content: [
      use("t1", "Bash", { command: "ln -s ../../knowledge outputs/link" }),
      use("t2", "Write", { file_path: "outputs/link/planted.md", content: "planted" }),
    ] },
    { content: [say("done")] },
  ], { allowed: ["Bash", "Write"], sandboxBash: false, files: { "../../knowledge/real.md": "real" } });
  assert.equal(r.out!.status, "completed");
  assert.equal(fs.existsSync(path.join(r.root, "knowledge", "planted.md")), false, "nothing was written into knowledge/");
  const [, write] = r.requests[1].body.messages[2].content;
  assert.equal(write.is_error, true, JSON.stringify(write));
});

both("a stream cut part-way is a failure, never the model's answer", async ({ engine, step, loop }) => {
  const r = await step([{ content: [say("The answer is forty-")], cut: true }]);
  assert.equal(r.out, null);
  assert.match(r.error!.message, /ended part-way through a reply/);
});

both("on a person's own machine the caller may say the shell runs unsandboxed", async ({ engine, step, loop }) => {
  const r = await step([
    { content: [use("t1", "Bash", { command: "echo local" })] },
    { content: [say("ok")] },
  ], { allowed: ["Bash"], engineHostShell: true });
  assert.equal(r.out!.status, "completed");
  assert.equal(r.requests[1].body.messages[2].content[0].content, "local");
});

both("history: an earlier conversation goes before the prompt, as given; a broken one is refused before a model call", async ({ engine, step, loop }) => {
  const model = await fakeModel([{ content: [say("Still 5.")] }]);
  try {
    const history = [
      { role: "user", content: [{ type: "text", text: "what is 2+3?" }] },
      { role: "assistant", content: [{ type: "text", text: "5." }] },
    ];
    const q = loop({ prompt: "and now?", options: { cwd: os.tmpdir(), model: "test-model", tools: [], history, env: { ANTHROPIC_BASE_URL: model.url, ANTHROPIC_API_KEY: "k" } } });
    let result: any = null;
    for await (const m of q) if ((m as any).type === "result") result = m;
    assert.equal(result?.result, "Still 5.");
    const sent = model.requests[0]!.body.messages;
    assert.equal(sent.length, 3);
    assert.equal(sent[0].content[0].text, "what is 2+3?");
    assert.equal(sent[1].role, "assistant");
    assert.equal(sent[2].content[0].text, "and now?");
    for (const bad of [[{ role: "assistant", content: [say("x")] }], [{ role: "user", content: "text" }], [{ role: "user", content: [say("x")] }], "nope"]) {
      const before = model.requests.length;
      await assert.rejects(async () => {
        for await (const _ of loop({ prompt: "p", options: { cwd: os.tmpdir(), model: "m", tools: [], history: bad, env: { ANTHROPIC_BASE_URL: model.url } } })) void _;
      });
      assert.equal(model.requests.length, before, "refused before any model call");
    }
  } finally {
    await model.close();
  }
});

both("shellEnv: the tools get it, the model call keeps env's key", async ({ engine, step, loop }) => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-shellenv-")));
  const model = await fakeModel([{ content: [use("b1", "Bash", { command: "echo key=${ANTHROPIC_AUTH_TOKEN:-none} own=$OWN > out.txt" })] }, { content: [say("ok")] }]);
  try {
    const q = loop({ prompt: "p", options: { cwd: dir, model: "m", tools: ["Bash"], engineHostShell: true, sandbox: { enabled: false }, env: { PATH: process.env.PATH, ANTHROPIC_BASE_URL: model.url, ANTHROPIC_AUTH_TOKEN: "secret-gw" }, shellEnv: { PATH: process.env.PATH, OWN: "mine" } } });
    for await (const _ of q) void _;
    assert.equal(fs.readFileSync(path.join(dir, "out.txt"), "utf8").trim(), "key=none own=mine");
    assert.equal(model.requests[0]!.headers.authorization, "Bearer secret-gw");
  } finally {
    await model.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

both("extraTools: a host's own tool is offered, asked through canUseTool, and run with the step's signal", async ({ engine, step, loop }) => {
  const model = await fakeModel([{ content: [use("c1", "cloud_agents", { tasks: ["fix the tests"] })] }, { content: [say("done")] }]);
  try {
    const asked: string[] = [];
    let got: unknown = null;
    let hadSignal = false;
    const extraTools = [
      {
        name: "cloud_agents",
        description: "run agents elsewhere",
        input_schema: { type: "object", properties: { tasks: { type: "array", items: { type: "string" } } }, required: ["tasks"] },
        run: async (input: Record<string, unknown>, ctx: { signal: AbortSignal }) => {
          got = input;
          hadSignal = ctx.signal instanceof AbortSignal;
          return { text: "1 agent finished" };
        },
      },
    ];
    const q = loop({
      prompt: "p",
      options: {
        cwd: os.tmpdir(),
        model: "m",
        tools: ["Read"],
        extraTools,
        canUseTool: async (name: string, input: Record<string, unknown>) => {
          asked.push(name);
          return { behavior: "allow", updatedInput: input };
        },
        env: { ANTHROPIC_BASE_URL: model.url, ANTHROPIC_API_KEY: "k" },
      },
    });
    for await (const _ of q) void _;
    assert.deepEqual(model.requests[0]!.body.tools.map((t: { name: string }) => t.name), ["Read", "cloud_agents"]);
    assert.deepEqual(asked, ["cloud_agents"]);
    assert.deepEqual(got, { tasks: ["fix the tests"] });
    assert.ok(hadSignal);
    assert.equal(model.requests[1]!.body.messages[2].content[0].content, "1 agent finished");
    for (const bad of [[{ name: "Read", input_schema: {}, run: async () => ({ text: "" }) }], [{ name: "bad name", input_schema: {}, run: async () => ({ text: "" }) }], [{ name: "x", input_schema: {} }]]) {
      await assert.rejects(async () => {
        for await (const _ of loop({ prompt: "p", options: { cwd: os.tmpdir(), model: "m", tools: ["Read"], extraTools: bad, env: { ANTHROPIC_BASE_URL: model.url } } })) void _;
      }, /extraTools/);
    }
  } finally {
    await model.close();
  }
});

both("pause_turn: the conversation goes back as it stands and the model carries on", async ({ step }) => {
  const r = await step([
    { content: [say("Searching the long way round")], stop: "pause_turn" },
    { content: [say("found it.")] },
  ]);
  assert.equal(r.out!.status, "completed");
  assert.equal(r.requests.length, 2, "a paused turn is not the end");
  const sent = r.requests[1].body.messages;
  assert.equal(sent.at(-1).role, "assistant", "the paused turn is sent back for the model to carry on");
  assert.match(JSON.stringify(sent.at(-1).content), /Searching the long way round/);
});

both("a reply cut off at the output limit mid-call: the call never runs and the step did not finish (FOL-211)", async ({ step }) => {
  const r = await step([
    { content: [say("Writing it"), use("w1", "Write", { file_path: "out.txt", content: "half" })], stop: "max_tokens" },
    { content: [say("should not be asked")] },
  ]);
  assert.equal(r.out!.status, "failed");
  assert.equal(r.requests.length, 1, "no further turn");
  assert.equal(fs.existsSync(path.join(r.agentDir, "out.txt")), false, "a half-written call is not run");
  assert.ok(r.events.some((e) => e.type === "error" && /cut off at the output limit/.test(e.text)));
});


// ---- What the Pi trial found (FOL-213, Codex): each held on foldrun's loop too.

const collect = async (q: AsyncIterable<unknown>, stopAfter?: (m: any) => boolean) => {
  const seen: any[] = [];
  for await (const m of q) {
    seen.push(m);
    if (stopAfter?.(m)) {
      await new Promise((r) => setTimeout(r, 30));
      break;
    }
  }
  return seen;
};

both("a tool block in a turn the model ended (end_turn) is not run, and the step finishes there", async ({ step }) => {
  const r = await step([{ content: [say("done"), use("w", "Write", { file_path: "x.txt", content: "no" })], stop: "end_turn" }, { content: [say("again")] }]);
  assert.equal(r.out!.status, "completed");
  assert.equal(r.requests.length, 1);
  assert.equal(fs.existsSync(path.join(r.agentDir, "x.txt")), false);
});

both("max_turns counts a paused turn", async ({ step }) => {
  const r = await step([{ content: [say("a")], stop: "pause_turn" }, { content: [say("done")] }], { maxTurns: 1 });
  assert.equal(r.out!.status, "failed");
  assert.equal(r.requests.length, 1);
});

both("a stream whose blocks never closed, or that never sent message_stop, is a failure — not the answer", async ({ step }) => {
  const open = await step([{ content: [say("The answer is 42.")], unclosed: true }]);
  assert.equal(open.out, null);
  assert.match(open.error!.message, /ended part-way through a reply/);
  const noStop = await step([{ content: [say("The answer is 42.")], stop: "stop_sequence", noStop: true }]);
  assert.equal(noStop.out, null);
  assert.match(noStop.error!.message, /ended part-way through a reply/);
});

both("nothing runs after the reader stops reading: a call in a turn it never asked past is not made", async ({ loop }) => {
  const model = await fakeModel([{ content: [use("w", "Write", { file_path: "late.txt", content: "x" })] }, { content: [say("done")] }]);
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-reader-")));
  roots.push(dir);
  try {
    await collect(loop({ prompt: "p", options: { cwd: dir, model: "m", tools: ["Write"], env: { ANTHROPIC_BASE_URL: model.url, ANTHROPIC_API_KEY: "k" } } }), (m) => m.type === "assistant");
    assert.equal(fs.existsSync(path.join(dir, "late.txt")), false);
    assert.equal(model.requests.length, 1);
  } finally {
    await model.close();
  }
});

both("a PreToolUse hook that throws fails the step; the model is not asked again", async ({ loop }) => {
  const model = await fakeModel([{ content: [use("g", "Glob", { pattern: "*" })] }, { content: [say("done")] }]);
  try {
    const hooks = { PreToolUse: [{ hooks: [() => { throw new Error("hook failed"); }] }] };
    await assert.rejects(() => collect(loop({ prompt: "p", options: { cwd: "/nonexistent-foldrun", model: "m", tools: ["Glob"], hooks, env: { ANTHROPIC_BASE_URL: model.url, ANTHROPIC_API_KEY: "k" } } })), /hook failed/);
    assert.equal(model.requests.length, 1);
  } finally {
    await model.close();
  }
});

both("usage: a closing count of 0 input does not undo the opening one; an unknown stop keeps its output count", async ({ loop }) => {
  const model = await fakeModel([{ content: [say("hi")], deltaUsage: { input_tokens: 0 } }, { content: [say("x")], stop: "novel", usage: { output_tokens: 5 } }]);
  try {
    const a = (await collect(loop({ prompt: "p", options: { cwd: os.tmpdir(), model: "m", tools: [], env: { ANTHROPIC_BASE_URL: model.url, ANTHROPIC_API_KEY: "k" } } }))).find((m) => m.type === "result");
    assert.equal(a.usage.input_tokens, 10);
    const b = (await collect(loop({ prompt: "p", options: { cwd: os.tmpdir(), model: "m", tools: [], env: { ANTHROPIC_BASE_URL: model.url, ANTHROPIC_API_KEY: "k" } } }))).find((m) => m.type === "result");
    assert.equal(b.subtype, "error_unknown_stop");
    assert.equal(b.usage.output_tokens, 5);
  } finally {
    await model.close();
  }
});

both("the output limit asked for is the one sent; partial events only when asked for", async ({ loop }) => {
  const model = await fakeModel([{ content: [say("done")] }]);
  try {
    const seen = await collect(loop({ prompt: "p", options: { cwd: os.tmpdir(), model: "m", tools: [], env: { ANTHROPIC_BASE_URL: model.url, ANTHROPIC_API_KEY: "k", CLAUDE_CODE_MAX_OUTPUT_TOKENS: "200000" } } }));
    assert.equal(model.requests[0]!.body.max_tokens, 200000);
    assert.deepEqual(seen.filter((m) => m.type === "stream_event").map((m) => m.event.type), ["message_start", "message_delta"]);
  } finally {
    await model.close();
  }
});

both("history: an image in an earlier tool result is sent again as an image", async ({ loop }) => {
  const model = await fakeModel([{ content: [say("I see it")] }]);
  try {
    const image = { type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" } };
    const history = [
      { role: "user", content: [{ type: "text", text: "look" }] },
      { role: "assistant", content: [{ type: "tool_use", id: "t", name: "Read", input: { file_path: "a.png" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: [image] }] },
      { role: "assistant", content: [{ type: "text", text: "a picture" }] },
    ];
    await collect(loop({ prompt: "again", options: { cwd: os.tmpdir(), model: "m", tools: ["Read"], history, env: { ANTHROPIC_BASE_URL: model.url, ANTHROPIC_API_KEY: "k" } } }));
    const sent = JSON.stringify(model.requests[0]!.body.messages[2]);
    assert.match(sent, /"type":"image"/);
    assert.match(sent, /iVBORw0KGgo=/);
  } finally {
    await model.close();
  }
});

both("a cut-off tool turn yields no tool results; the record is what the model was sent", async ({ loop }) => {
  const model = await fakeModel([{ content: [use("g", "Glob", { pattern: "*" })], stop: "max_tokens" }]);
  try {
    const seen = await collect(loop({ prompt: "p", options: { cwd: "/nonexistent-foldrun", model: "m", tools: ["Glob"], env: { ANTHROPIC_BASE_URL: model.url, ANTHROPIC_API_KEY: "k" } } }));
    assert.deepEqual(seen.map((m) => m.type).filter((t) => t !== "stream_event"), ["system", "assistant", "result"]);
  } finally {
    await model.close();
  }
  const ctxModel = await fakeModel([{ content: [use("g", "Glob", { pattern: "*" })] }, { content: [say("done")] }]);
  try {
    const hooks = { PostToolUse: [{ hooks: [() => ({ hookSpecificOutput: { additionalContext: "ctx" } })] }] };
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-ctx-")));
    roots.push(dir);
    fs.writeFileSync(path.join(dir, "a.txt"), "a");
    const seen = await collect(loop({ prompt: "p", options: { cwd: dir, model: "m", tools: ["Glob"], hooks, env: { ANTHROPIC_BASE_URL: ctxModel.url, ANTHROPIC_API_KEY: "k" } } }));
    const recorded = seen.find((m) => m.type === "user").message.content;
    const sent = ctxModel.requests[1]!.body.messages.at(-1).content;
    // Spelling aside (a cache mark, `is_error: false`, text as one string or blocks).
    const strip = (c: any[]) => c.map(({ cache_control: _, is_error, ...b }: any) => ({ ...b, ...(is_error ? { is_error } : {}), content: Array.isArray(b.content) ? b.content.map((x: any) => x.text).join("\n") : b.content }));
    assert.deepEqual(strip(sent), strip(recorded), "the record is what was sent");
    assert.match(JSON.stringify(sent), /ctx/);
  } finally {
    await ctxModel.close();
  }
});


test("a stream frame that is not JSON fails the step — a reply missing a piece is never taken as whole", async () => {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    const send = (ev: Record<string, unknown>) => res.write(`event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`);
    send({ type: "message_start", message: { id: "m1", model: "m", usage: { input_tokens: 1, output_tokens: 1 } } });
    send({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
    send({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "The answer is " } });
    res.write("event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"not\n\n");
    send({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: " 42." } });
    send({ type: "content_block_stop", index: 0 });
    send({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 3 } });
    send({ type: "message_stop" });
    res.end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    await assert.rejects(async () => {
      for await (const _ of foldrunQuery({ prompt: "p", options: { cwd: os.tmpdir(), model: "m", tools: [], env: { ANTHROPIC_BASE_URL: url, ANTHROPIC_API_KEY: "k" } } })) void _;
    }, /a frame that is not JSON/);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test("SSE line endings: CRLF, LF and a bare CR all read, a CRLF split across chunks too; pings and comments pass", async () => {
  const ev = (e: Record<string, unknown>, eol: string) => `event: ${e.type}${eol}data: ${JSON.stringify(e)}${eol}${eol}`;
  const reply = (eol: string) =>
    `event: ping${eol}data: {"type":"ping"}${eol}: keepalive${eol}${eol}` +
    ev({ type: "message_start", message: { id: "m1", model: "m", usage: { input_tokens: 1, output_tokens: 1 } } }, eol) +
    ev({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }, eol) +
    ev({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } }, eol) +
    ev({ type: "content_block_stop", index: 0 }, eol) +
    ev({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } }, eol) +
    ev({ type: "message_stop" }, eol) + `data: [DONE]${eol}${eol}`;
  for (const eol of ["\n", "\r\n", "\r"]) {
    const body = reply(eol);
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      // Cut after every CR, so a CRLF lands across two chunks.
      for (const piece of body.split(/(?<=\r)/)) res.write(piece);
      res.end();
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    try {
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      let result: any = null;
      for await (const m of foldrunQuery({ prompt: "p", options: { cwd: os.tmpdir(), model: "m", tools: [], env: { ANTHROPIC_BASE_URL: url, ANTHROPIC_API_KEY: "k" } } })) if ((m as any).type === "result") result = m;
      assert.equal(result?.subtype, "success", JSON.stringify(eol));
      assert.equal(result?.result, "ok");
    } finally {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    }
  }
});

// ---- MCP servers on foldrun's loop (FOL-213): web, browse, agents, apis and
// an agent's own servers all reach a step this way.

/** An in-process server, the shape foldrun's own tools take (script-tools.ts). */
function echoServer(seen: unknown[] = []) {
  return createSdkMcpServer({ name: "kit", version: "1.0.0", tools: [
    tool("echo", "Say it back.", { words: z.string() }, async (a) => { seen.push(a); return { content: [{ type: "text" as const, text: `echo: ${a.words}` }] }; }),
    tool("shot", "A picture.", {}, async () => ({ content: [
      { type: "text" as const, text: "before" }, { type: "image" as const, data: "iVBORw0KGgo=", mimeType: "image/png" },
      { type: "text" as const, text: "after" }, { type: "image" as const, data: "R0lGODlh", mimeType: "image/gif" },
    ] })),
  ] });
}

both("an in-process MCP tool is offered under its SDK name, run through the step's checks, and its answer goes back", async ({ step }) => {
  const seen: unknown[] = [];
  const r = await step([
    { content: [use("t1", "mcp__kit__echo", { words: "hi" })] },
    { content: [use("t2", "mcp__kit__shot", {})] },
    { content: [say("done")] },
  ], { mcpServers: { kit: echoServer(seen) } as never, mcpNames: ["kit"], allowed: ["Read", "mcp__kit__echo", "mcp__kit__shot"] });
  assert.equal(r.error, null);
  assert.equal(r.out!.status, "completed", JSON.stringify(r.events.filter((e) => e.type === "error")));
  assert.deepEqual(seen, [{ words: "hi" }]);
  const offered = r.requests[0].body.tools.map((t: { name: string }) => t.name);
  assert.ok(offered.includes("mcp__kit__echo") && offered.includes("mcp__kit__shot"), offered.join(","));
  const echo = r.requests[0].body.tools.find((t: { name: string }) => t.name === "mcp__kit__echo");
  assert.equal(echo.input_schema.properties.words.type, "string");
  const first = r.requests[1].body.messages.at(-1).content[0];
  assert.equal(first.content, "echo: hi");
  // An image a tool returns reaches the model as an image, each caption in its place.
  const second = r.requests[2].body.messages.at(-1).content[0];
  assert.deepEqual(second.content, [
    { type: "text", text: "before" }, { type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" } },
    { type: "text", text: "after" }, { type: "image", source: { type: "base64", media_type: "image/gif", data: "R0lGODlh" } },
  ]);
});

both("a tool from a server the agent was not granted is refused, never run", async ({ step }) => {
  const seen: unknown[] = [];
  const r = await step([
    { content: [use("t1", "mcp__kit__echo", { words: "hi" })] },
    { content: [say("ok")] },
  ], { mcpServers: { kit: echoServer(seen) } as never, mcpNames: [] });
  assert.deepEqual(seen, []);
  const result = r.requests[1].body.messages.at(-1).content[0];
  assert.equal(result.is_error, true);
  assert.match(result.content, /Tool mcp__kit__echo is not enabled for this agent/);
});

/** A stdio MCP server, as an agent's own `mcpServers:` names one. */
function stdioServer(dir: string) {
  const file = path.join(dir, "server.mjs");
  const sdk = path.join(import.meta.dirname, "..", "node_modules", "@modelcontextprotocol", "sdk", "dist", "esm");
  fs.writeFileSync(file, `
import fs from "node:fs";
import { McpServer } from ${JSON.stringify(path.join(sdk, "server", "mcp.js"))};
import { StdioServerTransport } from ${JSON.stringify(path.join(sdk, "server", "stdio.js"))};
fs.writeFileSync(${JSON.stringify(path.join(dir, "pid"))}, String(process.pid));
const s = new McpServer({ name: "own", version: "1.0.0" });
s.registerTool("env", { description: "What the server sees.", annotations: { readOnlyHint: true } }, async () => ({
  content: [{ type: "text", text: JSON.stringify({ secret: process.env.STEP_SECRET ?? null, host: process.env.HOST_ONLY ?? null, given: process.env.GIVEN ?? null, cwd: process.cwd() }) }],
}));
await s.connect(new StdioServerTransport());
`);
  return { command: process.execPath, args: [file], env: { GIVEN: "yes" } };
}

both("an agent's own stdio MCP server, granted as the runner grants it: started in the agent's folder with the step's environment (never this process's), gone when the step ends", async ({ step }) => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-mcp-")));
  roots.push(dir);
  process.env.HOST_ONLY = "platform-key";
  let r;
  try {
    r = await step([
      { content: [use("t1", "mcp__own__env", {})] },
      { content: [say("ok")] },
    ], { mcpServers: { own: stdioServer(dir) } as never, mcpNames: ["own"], allowed: ["Read", "mcp__own", "mcp__own__*"], env: { STEP_SECRET: "declared" } });
  } finally {
    delete process.env.HOST_ONLY;
  }
  assert.equal(r.out!.status, "completed", JSON.stringify(r.events.filter((e) => e.type === "error")));
  const seen = JSON.parse(r.requests[1].body.messages.at(-1).content[0].content);
  // As the SDK did: the step's environment (already the allowlisted one,
  // with the secrets the agent declared) — and nothing of the host's.
  assert.equal(seen.secret, "declared");
  assert.equal(seen.host, null, "this process's environment does not reach the server");
  assert.equal(seen.given, "yes");
  assert.equal(seen.cwd, r.agentDir);
  const pid = Number(fs.readFileSync(path.join(dir, "pid"), "utf8"));
  let alive = true;
  for (let i = 0; i < 50 && alive; i++) {
    try { process.kill(pid, 0); await new Promise((res) => setTimeout(res, 50)); } catch { alive = false; }
  }
  assert.equal(alive, false, "the server process ended with the step");
});

both("a server that does not start refuses the step by name, before a model call is paid for", async ({ step }) => {
  const r = await step([{ content: [say("should not be asked")] }], {
    mcpServers: { crm: { command: "/nonexistent/mcp-server" } } as never, mcpNames: ["crm"],
  });
  assert.equal(r.requests.length, 0);
  const why = r.error?.message ?? JSON.stringify(r.events.filter((e) => e.type === "error"));
  assert.match(why, /MCP server crm did not start/);
  assert.notEqual(r.out?.status, "completed");
});

both("a granted MCP tool with no server, or one its server does not offer, refuses the step — it never runs without a tool it was given", async ({ step, loop }) => {
  const base = { cwd: "/tmp", model: "m", env: {} };
  assert.throws(() => loop({ prompt: "p", options: { ...base, tools: ["mcp__crm__find"] } }), /the tool mcp__crm__find was granted, but the step has no MCP server for it/);
  const r = await step([{ content: [say("should not be asked")] }], {
    mcpServers: { kit: echoServer() } as never, mcpNames: ["kit"], allowed: ["mcp__kit__echo", "mcp__kit__gone"],
  });
  assert.equal(r.requests.length, 0);
  assert.match(r.error?.message ?? JSON.stringify(r.events.filter((e) => e.type === "error")), /granted but not offered by its MCP server: mcp__kit__gone/);
});

both("MCP grants: a server named with __ is read whole; a host tool cannot stand in for a granted server tool; a per-tool policy is refused", async ({ loop }) => {
  const base = { cwd: "/tmp", model: "m", env: {} };
  const kit = echoServer();
  // `sales__eu` is one server, not `sales`.
  assert.doesNotThrow(() => loop({ prompt: "p", options: { ...base, tools: ["mcp__sales__eu__find", "mcp__sales__eu"], mcpServers: { sales__eu: { command: "x" } } } }));
  assert.throws(() => loop({ prompt: "p", options: { ...base, mcpServers: { kit: { type: "sdk", name: "kit", instance: kit.instance, tools: [{ name: "echo", permission_policy: "always_deny" }] } } } }), /does not apply per-tool permission policies \(MCP server kit\)/);
  const model = await fakeModel([{ content: [say("should not be asked")] }]);
  try {
    const gen = loop({ prompt: "p", options: { ...base, env: { ANTHROPIC_BASE_URL: model.url, ANTHROPIC_API_KEY: "k" }, tools: ["mcp__kit__gone"], mcpServers: { kit },
      extraTools: [{ name: "mcp__kit__gone", description: "", input_schema: { type: "object" }, run: async () => ({ text: "fake" }) }] } });
    await assert.rejects(async () => { for await (const _ of gen) void _; }, /granted but not offered by its MCP server: mcp__kit__gone/);
    assert.equal(model.requests.length, 0);
  } finally {
    await model.close();
  }
});

both("a server that offers no tools connects, with none", async ({ step }) => {
  const r = await step([{ content: [say("fine")] }], { mcpServers: { empty: createSdkMcpServer({ name: "empty", version: "1.0.0", tools: [] }) } as never, mcpNames: ["empty"] });
  assert.equal(r.out!.status, "completed", JSON.stringify(r.events.filter((e) => e.type === "error")));
});

both("an SSE server that never sends its endpoint does not hold the step: a stop ends it", async ({ loop }) => {
  const sse = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(": hello\n\n");
    const beat = setInterval(() => res.write(": beat\n\n"), 50);
    res.on("close", () => clearInterval(beat));
  });
  await new Promise<void>((r) => sse.listen(0, "127.0.0.1", r));
  const abort = new AbortController();
  const started = Date.now();
  try {
    const gen = loop({ prompt: "p", options: { cwd: "/tmp", model: "m", env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:9", ANTHROPIC_API_KEY: "k" }, abortController: abort,
      mcpServers: { slow: { type: "sse", url: `http://127.0.0.1:${(sse.address() as AddressInfo).port}/sse` } } } });
    setTimeout(() => abort.abort(), 200);
    await assert.rejects(async () => { for await (const _ of gen) void _; }, /MCP server slow did not start/);
    assert.ok(Date.now() - started < 5000, "ended by the stop, not the connect timeout");
  } finally {
    sse.closeAllConnections();
    await new Promise<void>((r) => sse.close(() => r()));
  }
});

both("a streamable HTTP server's session is ended (DELETE) when the step ends", async ({ step }) => {
  const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
  const { StreamableHTTPServerTransport } = await import("@modelcontextprotocol/sdk/server/streamableHttp.js");
  const methods: string[] = [];
  const transports = new Map<string, InstanceType<typeof StreamableHTTPServerTransport>>();
  const web = http.createServer(async (req, res) => {
    methods.push(req.method!);
    let raw = "";
    for await (const c of req) raw += c;
    const sid = req.headers["mcp-session-id"] as string | undefined;
    let t = sid ? transports.get(sid) : undefined;
    if (!t) {
      t = new StreamableHTTPServerTransport({ sessionIdGenerator: () => crypto.randomUUID(), onsessioninitialized: (id) => { transports.set(id, t!); } });
      const srv = new McpServer({ name: "web", version: "1.0.0" });
      srv.registerTool("ping", { description: "pong" }, async () => ({ content: [{ type: "text", text: "pong" }] }));
      await srv.connect(t);
    }
    await t.handleRequest(req, res, raw ? JSON.parse(raw) : undefined);
  });
  await new Promise<void>((r) => web.listen(0, "127.0.0.1", r));
  try {
    const url = `http://127.0.0.1:${(web.address() as AddressInfo).port}/mcp`;
    const r = await step([{ content: [use("t1", "mcp__web__ping", {})] }, { content: [say("ok")] }], { mcpServers: { web: { type: "http", url } } as never, mcpNames: ["web"] });
    assert.equal(r.out!.status, "completed", JSON.stringify(r.events.filter((e) => e.type === "error")));
    assert.equal(r.requests[1].body.messages.at(-1).content[0].content, "pong");
    assert.ok(methods.includes("DELETE"), `the session was ended: ${methods.join(",")}`);
  } finally {
    web.closeAllConnections();
    await new Promise<void>((r) => web.close(() => r()));
  }
});

both("foldrun's own script server (foldrun_scripts, as the runner builds it) runs on this loop: the script runs and its output comes back", async ({ step }) => {
  const { parseScripts, buildScriptTools } = await import("../src/script-tools.ts");
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-mcp-scripts-")));
  roots.push(dir);
  fs.writeFileSync(path.join(dir, "greet.mjs"), `console.log("hello " + process.argv.slice(2).join(" "));`);
  const built = buildScriptTools(dir, parseScripts([{ name: "greet", description: "Says hello.", run: "greet.mjs", args: { who: "who to greet" } }]), {});
  assert.deepEqual(built.toolNames, ["mcp__foldrun_scripts__greet"]);
  const r = await step([
    { content: [use("t1", "mcp__foldrun_scripts__greet", { who: "ana" })] },
    { content: [say("greeted")] },
  ], { mcpServers: { foldrun_scripts: built.server } as never, mcpNames: [], allowed: ["Read", ...built.toolNames] });
  assert.equal(r.out!.status, "completed", JSON.stringify(r.events.filter((e) => e.type === "error")));
  assert.match(r.requests[1].body.messages.at(-1).content[0].content, /^exit 0\n\nhello/);
});

test("MCP results: one text budget, the newlines between counted, nothing kept empty", () => {
  const out = outcomeOf({ content: Array.from({ length: 60_000 }, () => ({ type: "text", text: "ab" })) });
  assert.ok(out.text.length <= 100_000 + 40, `${out.text.length}`);
  assert.match(out.text, /\[cut: \d+ more characters\]$/);
  assert.equal(/\n\n/.test(out.text), false);
  assert.equal(outcomeOf({ content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] }).text, "a\nb");
});

test("an MCP server named __proto__ is a server, not a prototype", () => {
  const out = checkMcpSpecs(JSON.parse('{"__proto__":{"command":"node"}}'), "foldrun");
  assert.deepEqual(Object.keys(out), ["__proto__"]);
});

test("MCP connect: a step already stopped leaves no unhandled rejection; a granted tool must come from the server it names", async () => {
  const unhandled: unknown[] = [];
  const on = (e: unknown) => unhandled.push(e);
  process.on("unhandledRejection", on);
  try {
    const abort = new AbortController();
    abort.abort();
    await assert.rejects(connectMcp({ kit: { type: "sdk", instance: echoServer().instance } }, { env: {}, toolEnv: {}, cwd: "/tmp", signal: abort.signal }), /did not start: connect: stopped/);
    await new Promise((r) => setTimeout(r, 100));
    assert.deepEqual(unhandled, []);
  } finally {
    process.off("unhandledRejection", on);
  }
});

both("a granted tool is checked against the server its name points to — a same-named tool from another server does not stand in", async ({ loop }) => {
  const sales = createSdkMcpServer({ name: "sales", version: "1.0.0", tools: [tool("eu__find", "x", {}, async () => ({ content: [{ type: "text" as const, text: "wrong one" }] }))] });
  const eu = createSdkMcpServer({ name: "sales__eu", version: "1.0.0", tools: [] });
  const model = await fakeModel([{ content: [say("should not be asked")] }]);
  try {
    const gen = loop({ prompt: "p", options: { cwd: "/tmp", model: "m", env: { ANTHROPIC_BASE_URL: model.url, ANTHROPIC_API_KEY: "k" }, tools: ["mcp__sales__eu__find"], mcpServers: { sales, sales__eu: eu } } });
    // Refused when the servers connect: the name reads as sales__eu's.
    await assert.rejects(async () => { for await (const _ of gen) void _; }, /mcp__sales__eu__find from sales reads as server sales__eu's/);
    assert.equal(model.requests.length, 0);
  } finally {
    await model.close();
  }
});

both("MCP tools: a stdio server starts from the tool environment (shellEnv), not the model's; MCP_TOOL_TIMEOUT holds a call", async ({ loop }) => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-mcp-env-")));
  roots.push(dir);
  const slow = createSdkMcpServer({ name: "slow", version: "1.0.0", tools: [tool("wait", "x", {}, async () => { await new Promise((r) => setTimeout(r, 1500)); return { content: [{ type: "text" as const, text: "late" }] }; })] });
  const model = await fakeModel([
    { content: [use("t1", "mcp__own__env", {}), use("t2", "mcp__slow__wait", {})] },
    { content: [say("ok")] },
  ]);
  try {
    const gen = loop({ prompt: "p", options: { cwd: dir, model: "m", tools: [],
      env: { ANTHROPIC_BASE_URL: model.url, ANTHROPIC_API_KEY: "k", STEP_SECRET: "model-side", MCP_TOOL_TIMEOUT: "1000" },
      shellEnv: { PATH: process.env.PATH, GIVEN_TOOL: "t" },
      mcpServers: { own: stdioServer(dir), slow } } });
    for await (const _ of gen) void _;
    const results = model.requests[1].body.messages.at(-1).content;
    const seen = JSON.parse(results[0].content);
    assert.equal(seen.secret, null, "the model's side of the environment does not reach a tool's process");
    assert.equal(results[1].is_error, true);
    assert.match(results[1].content, /timed out|timeout/i);
  } finally {
    await model.close();
  }
});

test("a script tool stops when its call is stopped — no child outlives the step", async () => {
  const { parseScripts, buildScriptTools } = await import("../src/script-tools.ts");
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-mcp-stop-")));
  roots.push(dir);
  fs.writeFileSync(path.join(dir, "long.mjs"), `import fs from "node:fs"; fs.writeFileSync("pid", String(process.pid)); setTimeout(() => {}, 30000);`);
  const built = buildScriptTools(dir, parseScripts([{ name: "long", description: "runs long", run: "long.mjs" }]), {});
  const tools = (built.server as unknown as { instance: { _registeredTools: Record<string, { handler: (a: object, e: object) => Promise<{ content: { text: string }[] }> }> } }).instance._registeredTools;
  const abort = new AbortController();
  const call = tools.long.handler({}, { signal: abort.signal });
  for (let i = 0; i < 100 && !fs.existsSync(path.join(dir, "pid")); i++) await new Promise((r) => setTimeout(r, 30));
  abort.abort();
  const reply = await call;
  assert.match(reply.content[0].text, /stopped/);
  const pid = Number(fs.readFileSync(path.join(dir, "pid"), "utf8"));
  let alive = true;
  for (let i = 0; i < 50 && alive; i++) { try { process.kill(pid, 0); await new Promise((r) => setTimeout(r, 50)); } catch { alive = false; } }
  assert.equal(alive, false);
});

test("MCP round three: no server starts for a stopped step; a long timeout is held to the timer's limit; the text budget counts every newline and never cuts a character in half", async () => {
  let connects = 0;
  const kit = echoServer();
  const counted = { type: "sdk", instance: { connect: (t: never) => { connects++; return kit.instance.connect(t); } } };
  await assert.rejects(connectMcp({ kit: counted }, { env: {}, toolEnv: {}, cwd: "/tmp", signal: AbortSignal.abort() }), /connect: stopped/);
  assert.equal(connects, 0);

  const c = await connectMcp({ kit: { type: "sdk", instance: echoServer().instance } }, { env: { MCP_TOOL_TIMEOUT: "2592000000" }, toolEnv: {}, cwd: "/tmp", signal: new AbortController().signal });
  try {
    const echo = c.tools.find((t) => t.name === "mcp__kit__echo")!;
    const out = await echo.run({ words: "x" }, { signal: new AbortController().signal } as never);
    assert.equal(out.text, "echo: x");
  } finally {
    await c.close();
  }

  const lead = outcomeOf({ content: [{ type: "text", text: "" }, { type: "text", text: "a".repeat(100_000) }] });
  assert.ok(lead.text.length <= 100_000 + 40 && /\[cut: 1 more characters\]$/.test(lead.text), `${lead.text.length} ${lead.text.slice(-30)}`);
  const emoji = outcomeOf({ content: [{ type: "text", text: "a".repeat(99_999) + "😀" }] });
  assert.equal(emoji.text.isWellFormed(), true);
});

test("MCP instructions a server gives reach the model's system prompt, as the SDK put them", async () => {
  const kit = createSdkMcpServer({ name: "kit", version: "1.0.0", instructions: "Use UTC dates.", tools: [tool("t", "x", {}, async () => ({ content: [{ type: "text" as const, text: "ok" }] }))] } as never);
  const model = await fakeModel([{ content: [say("ok")] }]);
  try {
    for await (const _ of foldrunQuery({ prompt: "p", options: { cwd: "/tmp", model: "m", tools: [], systemPrompt: "You help.", env: { ANTHROPIC_BASE_URL: model.url, ANTHROPIC_API_KEY: "k" }, mcpServers: { kit } } })) void _;
    const system = JSON.stringify(model.requests[0].body.system);
    assert.match(system, /You help\./);
    assert.match(system, /## kit\\nUse UTC dates\./);
  } finally {
    await model.close();
  }
});

test("a granted server does not grant another whose name it begins: sales does not grant sales__eu's tools (step-exec's grant check, which the SDK path shares)", async () => {
  const seen: string[] = [];
  const eu = createSdkMcpServer({ name: "sales__eu", version: "1.0.0", tools: [tool("find", "x", {}, async () => { seen.push("eu"); return { content: [{ type: "text" as const, text: "eu" }] }; })] });
  const sales = createSdkMcpServer({ name: "sales", version: "1.0.0", tools: [tool("list", "x", {}, async () => ({ content: [{ type: "text" as const, text: "s" }] }))] });
  const r = await runStep([
    { content: [use("t1", "mcp__sales__eu__find", {})] },
    { content: [say("ok")] },
  ], { mcpServers: { sales, sales__eu: eu } as never, mcpNames: ["sales"], allowed: ["Read", "mcp__sales", "mcp__sales__*"] });
  assert.deepEqual(seen, []);
  const result = r.requests[1].body.messages.at(-1).content[0];
  assert.equal(result.is_error, true);
  assert.match(result.content, /not enabled for this agent/);
});

test("MCP round four: a tool name that reads as another server's refuses the step; an exact-fit result keeps its last newline", async () => {
  const sales = createSdkMcpServer({ name: "sales", version: "1.0.0", tools: [tool("eu__find", "x", {}, async () => ({ content: [{ type: "text" as const, text: "s" }] }))] });
  const eu = createSdkMcpServer({ name: "sales__eu", version: "1.0.0", tools: [] });
  await assert.rejects(connectMcp({ sales: sales as never, sales__eu: eu as never }, { env: {}, toolEnv: {}, cwd: "/tmp", signal: new AbortController().signal }), /mcp__sales__eu__find from sales reads as server sales__eu's/);
  const fit = outcomeOf({ content: [{ type: "text", text: "a".repeat(99_999) }, { type: "text", text: "" }] });
  assert.equal(fit.text.length, 100_000);
  assert.doesNotMatch(fit.text, /\[cut/);
});

test("an unattended script's stop ends what it started too (its process group)", { skip: process.platform === "win32" || process.stdout.isTTY || process.stdin.isTTY }, async () => {
  const { parseScripts, buildScriptTools } = await import("../src/script-tools.ts");
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-mcp-group-")));
  roots.push(dir);
  fs.writeFileSync(path.join(dir, "parent.sh"), `#!/bin/sh\nsleep 30 &\necho $! > child\nwait\n`, { mode: 0o755 });
  const built = buildScriptTools(dir, parseScripts([{ name: "parent", description: "x", run: "parent.sh" }]), {});
  const tools = (built.server as unknown as { instance: { _registeredTools: Record<string, { handler: (a: object, e: object) => Promise<{ content: { text: string }[] }> }> } }).instance._registeredTools;
  const abort = new AbortController();
  const call = tools.parent.handler({}, { signal: abort.signal });
  for (let i = 0; i < 100 && !fs.existsSync(path.join(dir, "child")); i++) await new Promise((r) => setTimeout(r, 30));
  const pid = Number(fs.readFileSync(path.join(dir, "child"), "utf8"));
  abort.abort();
  await call;
  let alive = true;
  for (let i = 0; i < 50 && alive; i++) { try { process.kill(pid, 0); await new Promise((r) => setTimeout(r, 50)); } catch { alive = false; } }
  assert.equal(alive, false, "the script's own child ended with it");
});

// ---- Compaction (FOL-213): Pi's approach on foldrun's loop.

// Read returns ~30k characters of it (~7.7k tokens by the estimate); three
// reads make a conversation with an older part worth summarising.
const BIG = `${"x".repeat(99)}\n`.repeat(1000);
// `last` is what the third turn counts as sent: past the line only then.
const threeReads = (last = 10): Scripted[] => [1, 2, 3].map((n) => ({ content: [use(`t${n}`, "Read", { file_path: "big.txt" })], usage: { input_tokens: n === 3 ? last : 10 } }));

both("near the context window, the older part is summarised before the next turn and the step goes on", async ({ step }) => {
  const r = await step([
    ...threeReads(50_000),
    { content: [say("## Goal\nRead the big file.\n\n## Next Steps\n1. Answer.")] },
    { content: [say("It is all x.")] },
  ], { files: { "big.txt": BIG }, contextWindow: 60_000 } as never);
  assert.equal(r.error, null);
  assert.equal(r.out!.status, "completed", JSON.stringify(r.events.filter((e) => e.type === "error")));
  // Three reads, the third counting 50k sent (past 60k less the 15k
  // reserve); the summary; the answer.
  const summaryAt = r.requests.findIndex((q) => /context summarization assistant/.test(JSON.stringify(q.body.system ?? "")));
  assert.ok(summaryAt > 0, "a summary was asked for");
  assert.equal(r.requests.length, summaryAt + 2);
  // The summary request: its own system prompt, no tools, nothing cached.
  const ask = r.requests[summaryAt].body;
  assert.match(ask.system[0].text, /context summarization assistant/);
  assert.equal(ask.tools, undefined);
  assert.equal(JSON.stringify(ask).includes("cache_control"), false);
  assert.match(ask.messages[0].content[0].text, /<conversation>\n\[User\]: do the task/);
  // The next turn opens on the summary, then the kept part: a call and its result together.
  const next = r.requests[summaryAt + 1].body.messages;
  assert.equal(next[0].role, "user");
  assert.ok(next[0].content[0].text.startsWith(SUMMARY_PREFIX));
  assert.match(next[0].content[0].text, /## Goal\nRead the big file\.[\s\S]*<read-files>\nbig\.txt\n<\/read-files>/);
  assert.equal(next[1].role, "assistant");
  assert.equal(next[1].content[0].type, "tool_use");
  assert.equal(next[2].content[0].type, "tool_result");
  assert.ok(next.length < 7, "older turns were summarised away");
  assert.ok(r.events.some((e) => e.type === "info" && /compacted the conversation from about/.test(e.text)));
  // The summary was paid for, like every request.
  assert.equal(r.out!.usage!.inputTokens, 10 + 10 + 50_000 + (r.requests.length - 3) * 10);
});

both("when the endpoint says the prompt is too long, the conversation is compacted and the turn asked again — once", async ({ step }) => {
  const tooLong = { content: [], status: 400, error: "prompt is too long: 250000 tokens > 200000 maximum" };
  const r = await step([
    ...threeReads(),
    tooLong,
    { content: [say("## Goal\nsummary")] },
    { content: [say("done")] },
  ], { files: { "big.txt": BIG } });
  assert.equal(r.out!.status, "completed", JSON.stringify(r.events.filter((e) => e.type === "error")));
  assert.equal(r.requests.length, 6);
  assert.ok(r.events.some((e) => e.type === "info" && /the model said it was too long/.test(e.text)));

  // Too long again after compacting: the step fails, it does not loop.
  const again = await step([
    ...threeReads(),
    tooLong,
    { content: [say("## Goal\nsummary")] },
    tooLong,
    { content: [say("never")] },
  ], { files: { "big.txt": BIG } });
  assert.equal(again.requests.length, 6);
  assert.notEqual(again.out?.status, "completed");
});

both("a summary that does not come back whole is not used: the turn goes on as it was, and compaction is not tried again", async ({ step }) => {
  const r = await step([
    ...threeReads(50_000),
    { content: [say("## Goal\nhalf")], stop: "max_tokens" },
    { content: [use("t4", "Read", { file_path: "big.txt" })], usage: { input_tokens: 30_000 } },
    { content: [say("done")] },
  ], { files: { "big.txt": BIG }, contextWindow: 60_000 } as never);
  assert.equal(r.out!.status, "completed", JSON.stringify(r.events.filter((e) => e.type === "error")));
  const summaries = r.requests.filter((q) => /context summarization assistant/.test(JSON.stringify(q.body.system ?? "")));
  assert.equal(summaries.length, 1, "one summary request, not one before every turn");
  assert.equal(r.requests.at(-1)!.body.messages[0].content[0].text, "do the task");
});

both("compaction: false leaves the conversation whole", async ({ step }) => {
  const r = await step([
    { content: [use("t1", "Read", { file_path: "big.txt" })], usage: { input_tokens: 30_000 } },
    { content: [say("done")] },
  ], { files: { "big.txt": BIG }, contextWindow: 60_000, compaction: false } as never);
  assert.equal(r.requests.length, 2);
});

both("a history past the window is compacted before the first request, and what the loop hands back is a valid history", async ({ loop }) => {
  const history = [];
  for (let i = 0; i < 4; i++) history.push({ role: "user", content: [{ type: "text", text: `question ${i} ${BIG}` }] }, { role: "assistant", content: [{ type: "text", text: `answer ${i}` }] });
  const model = await fakeModel([{ content: [say("## Goal\nfour questions")] }, { content: [say("five")] }]);
  try {
    const seen: any[] = [];
    for await (const m of loop({ prompt: "question 4", options: { cwd: "/tmp", model: "m", tools: [], history, contextWindow: 60_000, env: { ANTHROPIC_BASE_URL: model.url, ANTHROPIC_API_KEY: "k" } } })) seen.push(m);
    const boundary = seen.find((m) => m.type === "system" && m.subtype === "compact_boundary");
    assert.ok(boundary, "a compact_boundary message");
    assert.equal(boundary.compact_metadata.trigger, "auto");
    assert.ok(boundary.compact_metadata.pre_tokens > boundary.compact_metadata.post_tokens);
    const conv = boundary.conversation;
    assert.equal(conv.at(-1).content.at(-1).text, "question 4");
    // As history for the next turn: alternating, ending on... the prompt, so with the reply it is whole.
    readHistory([...conv, { role: "assistant", content: [{ type: "text", text: "five" }] }]);
    assert.equal(seen.find((m) => m.type === "result").subtype, "success");
    assert.ok(model.requests[1].body.messages.length < history.length + 1);
  } finally {
    await model.close();
  }
});

test("compaction pieces: the cut never separates a call from its result; a second compaction updates the first summary", () => {
  const big = (t: string) => ({ type: "text", text: t + "y".repeat(40_000) });
  const msgs = [
    { role: "user", content: [big("q")] },
    { role: "assistant", content: [{ type: "tool_use", id: "a", name: "Read", input: { file_path: "f" } }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "a", content: "z".repeat(90_000) }] },
  ];
  // The last message alone is past the budget: keep it with its call.
  assert.equal(findCut(msgs, 20_000), 1);
  const after = compacted("first summary", msgs.slice(1));
  assert.equal(after[0].role, "user");
  assert.equal(after[1].role, "assistant");
  assert.equal(previousSummary(after), "first summary");
  const asked = summaryRequest(after.slice(0, 1), previousSummary(after));
  assert.match(asked, /<previous-summary>\nfirst summary\n<\/previous-summary>/);
  assert.match(asked, /PRESERVE all existing information/);
  assert.equal(asked.includes(SUMMARY_PREFIX), false, "the earlier summary is not summarised as conversation");
  // Joined to a user turn rather than doubling it.
  const joined = compacted("s", [{ role: "user", content: [{ type: "text", text: "next" }] }]);
  assert.equal(joined.length, 1);
  assert.equal(joined[0].content[1].text, "next");
});

// ---- Compaction, Codex round 1 (each verified, then fixed).

both("compaction round 1: only a 400/413 that says the prompt is too long compacts; the summary is in the step's cost", async ({ step }) => {
  assert.equal(isContextOverflow(403, "context window metadata access denied"), false);
  assert.equal(isContextOverflow(400, "prompt is too long: 250000 tokens > 200000 maximum"), true);
  assert.equal(isContextOverflow(413, "request exceeds the model's context window"), true);
  const denied = await step([...threeReads(), { content: [], status: 403, error: "context window metadata access denied" }, { content: [say("never")] }], { files: { "big.txt": BIG } });
  assert.equal(denied.requests.length, 4, "no summary, no retry");
  assert.notEqual(denied.out?.status, "completed");

  // Priced at $1 a million in and out (TokenPrice is per token): the summary's tokens are in the cost.
  const price = { input: 1e-6, output: 1e-6 };
  const r = await step([
    ...threeReads(50_000),
    { content: [say("## Goal\nx")], usage: { input_tokens: 5_000, output_tokens: 1_000 } },
    { content: [say("done")] },
  ], { files: { "big.txt": BIG }, contextWindow: 60_000, price } as never);
  assert.equal(r.out!.status, "completed", JSON.stringify(r.events.filter((e) => e.type === "error")));
  assert.equal(r.requests.length, 5);
  const expected = ((10 + 5) * 2 + (50_000 + 5) + (5_000 + 1_000) + (10 + 5)) / 1e6;
  assert.ok(Math.abs(r.out!.costUsd! - expected) < 1e-9, `${r.out!.costUsd} vs ${expected}`);
});

both("compaction round 1: no compaction while the model's paused turn is being continued", async ({ step }) => {
  const r = await step([
    ...threeReads(50_000),
    { content: [say("thinking it over")], stop: "pause_turn", usage: { input_tokens: 51_000 } },
    { content: [say("## Goal\nx")] },
    { content: [say("done")] },
  ], { files: { "big.txt": BIG }, contextWindow: 60_000 } as never);
  assert.equal(r.out!.status, "completed", JSON.stringify(r.events.filter((e) => e.type === "error")));
  // The paused turn is continued before anything is summarised; every
  // compacted conversation handed out ends on a user turn.
  const sys = r.requests.map((q) => /context summarization assistant/.test(JSON.stringify(q.body.system ?? "")));
  const pausedAt = 3;
  assert.equal(sys[pausedAt + 1], false, "the request after the pause continues it");
});

test("compaction round 1: cuts, windows and the summary request", () => {
  const u = (t: string) => ({ role: "user", content: [{ type: "text", text: t }] });
  const a = (t: string) => ({ role: "assistant", content: [{ type: "text", text: t }] });
  // A large first message with a short tail: it is what gets summarised.
  assert.equal(findCut([u("y".repeat(200_000)), a("ok"), u("continue")], 20_000), 1);
  // A kept part too large to leave room moves to a later cut.
  assert.equal(findCut([u("hello"), a("z".repeat(164_000)), u("continue")], 20_000), 1);
  assert.equal(findCut([u("hello"), a("z".repeat(164_000)), u("continue")], 20_000, 19_000), 2);
  // The summary request is held to a size, newest part kept.
  const asked = summaryRequest([u("first " + "y".repeat(50_000)), a("z".repeat(50_000)), u("newest words")], null, 30_000);
  assert.ok(asked.length < 32_000, `${asked.length}`);
  assert.match(asked, /left out[\s\S]*newest words/);
  // A user's own text that looks like a summary is still the user's.
  assert.match(serializeConversation([u("Hello"), a("hi"), u(SUMMARY_PREFIX + "literal example")]), /literal example/);
  // A 32k window is honoured, with the reserve and keep scaled to it.
  const small = readOptions({ model: "m", contextWindow: 32_768 }).compaction;
  assert.deepEqual(small, { contextWindow: 32_768, reserveTokens: 8_192, keepRecentTokens: 9_830 });
  assert.equal((readOptions({ model: "m", contextWindow: 1_000 }).compaction as { contextWindow: number }).contextWindow, 200_000);
});

both("compaction round 1: after an overflow, the compacted request is asked again at once — not summarised again first", async ({ loop }) => {
  const history = [{ role: "user", content: [{ type: "text", text: "hello" }] }, { role: "assistant", content: [{ type: "text", text: "z".repeat(164_000) }] }];
  const tooLong = { content: [], status: 400, error: "prompt is too long" };
  const model = await fakeModel([tooLong, { content: [say("## Goal\nx")] }, { content: [say("done")] }]);
  try {
    const seen: any[] = [];
    for await (const m of loop({ prompt: "continue", options: { cwd: "/tmp", model: "m", tools: [], history, contextWindow: 400_000, env: { ANTHROPIC_BASE_URL: model.url, ANTHROPIC_API_KEY: "k" } } })) seen.push(m);
    const kinds = model.requests.map((q) => /context summarization assistant/.test(JSON.stringify(q.body.system ?? "")) ? "summary" : "normal");
    assert.deepEqual(kinds, ["normal", "summary", "normal"]);
    assert.equal(seen.find((m) => m.type === "result").subtype, "success");
  } finally {
    await model.close();
  }
});

// ---- Compaction, Codex round 2 (each verified, then fixed).

test("compaction round 2: overflow words; message and summary budgets; cut search stays linear", () => {
  assert.equal(isContextOverflow(400, "unknown parameter: context_window"), false);
  // Anthropic's own words when input and the reply's limit do not fit: compacting helps.
  assert.equal(isContextOverflow(400, "input length and `max_tokens` exceed context limit: 188240 + 21333 > 200000"), true);
  assert.equal(isContextOverflow(400, "This model's maximum context length is 32768 tokens"), true);
  const u = (...t: string[]) => ({ role: "user", content: t.map((x) => ({ type: "text", text: x })) });
  const a = (t: string) => ({ role: "assistant", content: [{ type: "text", text: t }] });
  assert.ok(serializeConversation([u("a".repeat(20_000), "b".repeat(20_000))]).length < 20_100, "the cap is the message's, across its blocks");
  const asked = summaryRequest([u("c".repeat(20_000))], "p".repeat(40_000), 12_576);
  assert.ok(asked.length < 12_576 + 3_000, `${asked.length}`);
  const many = Array.from({ length: 8_000 }, (_, i) => (i % 2 ? a("ok") : u("hi")));
  const t0 = Date.now();
  findCut(many, 20_000, 1);
  assert.ok(Date.now() - t0 < 200, `${Date.now() - t0} ms`);
  // A summary's reply is held to the reserve.
  assert.equal(buildRequest({ model: "m", systemPrompt: "", tools: [], env: {} }, [u("x")], false, 2_048).max_tokens, 2_048);
});

both("compaction round 2: a paused turn's continuation joins it — the conversation alternates, through a compaction too", async ({ loop }) => {
  const model = await fakeModel([
    { content: [say("part one")], stop: "pause_turn" },
    { content: [say(" part two")] },
  ]);
  try {
    const seen: any[] = [];
    for await (const m of loop({ prompt: "go", options: { cwd: "/tmp", model: "m", tools: [], env: { ANTHROPIC_BASE_URL: model.url, ANTHROPIC_API_KEY: "k" } } })) seen.push(m);
    // The continuation was asked with the paused turn as the last message, once.
    assert.equal(model.requests[1].body.messages.length, 2);
    assert.equal(model.requests[1].body.messages[1].role, "assistant");
    assert.equal(seen.find((m) => m.type === "result").subtype, "success");
  } finally {
    await model.close();
  }
});

both("compaction round 2: a summary stream that breaks part-way is still counted; overflow moves the cut to summarise enough", async ({ loop }) => {
  // The summary request answers a message_start counting 5,000 and then the stream ends.
  const history = [{ role: "user", content: [{ type: "text", text: "hi" }] }, { role: "assistant", content: [{ type: "text", text: "x".repeat(12_000) }] }];
  const model = await fakeModel([
    { content: [], status: 400, error: "prompt is too long" },
    { content: [say("partial summary")], cut: true, usage: { input_tokens: 5_000 } },
  ]);
  try {
    const seen: any[] = [];
    await assert.rejects(async () => {
      for await (const m of loop({ prompt: "continue", options: { cwd: "/tmp", model: "m", tools: [], history, contextWindow: 32_768, env: { ANTHROPIC_BASE_URL: model.url, ANTHROPIC_API_KEY: "k" } } })) seen.push(m);
    }, /could not be compacted: the summary request failed/);
    assert.equal(model.requests.length, 2, "the cut moved to summarise the long reply, so a summary was asked for");
    const failed = seen.find((m) => m.type === "system" && m.subtype === "compact_failed");
    assert.equal(failed?.usage?.input_tokens, 5_000);
  } finally {
    await model.close();
  }
});

// ---- Steering (FOL-213): what a person sends while the turn runs.

both("steering: a message sent mid-turn reaches the model after its calls; one waiting at the end keeps it going", async ({ loop }) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "steer-"));
  fs.writeFileSync(path.join(dir, "a.txt"), "hello");
  const model = await fakeModel([
    { content: [use("r1", "Read", { file_path: path.join(dir, "a.txt") })], stop: "tool_use" },
    { content: [say("done reading")] },
    { content: [say("and the second thing too")] },
  ]);
  const queue: unknown[] = [];
  let drained = 0;
  try {
    const seen: any[] = [];
    for await (const m of loop({ prompt: "read it", options: { cwd: dir, model: "m", tools: ["Read"], env: { ANTHROPIC_BASE_URL: model.url, ANTHROPIC_API_KEY: "k" }, steer: () => { drained++; return queue.splice(0); } } })) {
      seen.push(m);
      // Sent while the first call runs: read with its result.
      if (m.type === "assistant" && seen.filter((x) => x.type === "assistant").length === 1) queue.push("use British spelling", 42, "  ");
      // Sent while the model writes what would be its last word.
      if (m.type === "user" && seen.filter((x) => x.type === "user").length === 1) queue.push("also do the second thing");
    }
    const second = model.requests[1].body.messages.at(-1).content;
    assert.equal(second[0].type, "tool_result");
    const words = (bs: any[]) => bs.map((b) => ({ type: b.type, text: b.text }));
    assert.deepEqual(words(second.slice(1)), [{ type: "text", text: "use British spelling" }], "only strings with words in them are sent");
    assert.equal(model.requests.length, 3, "the waiting message kept the turn going");
    const last = model.requests[2].body.messages.at(-1);
    assert.equal(last.role, "user");
    assert.deepEqual(words(last.content), [{ type: "text", text: "also do the second thing" }]);
    assert.equal(seen.at(-1).subtype, "success");
    assert.ok(seen.some((m) => m.type === "user" && m.message.content[0]?.text === "also do the second thing"), "the caller sees it as a user turn, to keep");
    assert.ok(drained >= 2);
  } finally {
    await model.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

both("steering: a turn that fails leaves the waiting message with the caller", async ({ loop }) => {
  const model = await fakeModel([{ content: [say("cut")], stop: "max_tokens" }]);
  const queue: unknown[] = ["later"];
  try {
    const seen: any[] = [];
    for await (const m of loop({ prompt: "go", options: { cwd: "/tmp", model: "m", tools: [], env: { ANTHROPIC_BASE_URL: model.url, ANTHROPIC_API_KEY: "k" }, steer: () => queue.splice(0) } })) seen.push(m);
    assert.equal(seen.at(-1).subtype, "error_max_output");
    assert.deepEqual(queue, ["later"], "not taken, so not lost");
  } finally {
    await model.close();
  }
});

both("steering, Codex round 1: no message is taken when the model cannot get it — maxTurns spent, or the turn stopped", async ({ loop }) => {
  const env = (url: string) => ({ ANTHROPIC_BASE_URL: url, ANTHROPIC_API_KEY: "k" });
  {
    const model = await fakeModel([{ content: [say("answer")] }]);
    const queue: unknown[] = ["use metric"];
    try {
      const seen: any[] = [];
      for await (const m of loop({ prompt: "go", options: { cwd: "/tmp", model: "m", tools: [], maxTurns: 1, env: env(model.url), steer: () => queue.splice(0) } })) seen.push(m);
      assert.equal(seen.at(-1).subtype, "success", "the answer stands");
      assert.deepEqual(queue, ["use metric"]);
    } finally {
      await model.close();
    }
  }
  {
    const model = await fakeModel([{ content: [say("answer")] }, { content: [say("more")] }]);
    const queue: unknown[] = ["use metric"];
    const abortController = new AbortController();
    try {
      for await (const m of loop({ prompt: "go", options: { cwd: "/tmp", model: "m", tools: [], abortController, env: env(model.url), steer: () => queue.splice(0) } })) {
        if (m.type === "assistant") abortController.abort();
      }
    } catch {
      /* a stop may end it either way */
    } finally {
      await model.close();
    }
    assert.deepEqual(queue, ["use metric"], "stopped: not taken");
    assert.equal(model.requests.length, 1);
  }
});

both("steering, Codex round 2: a steered follow-up's result is its own words, never the answer before it", async ({ loop }) => {
  const model = await fakeModel([{ content: [say("first answer")] }, { content: [use("r", "Read", { file_path: "/nope" })], stop: "tool_use" }]);
  const queue: unknown[] = [];
  try {
    const seen: any[] = [];
    for await (const m of loop({ prompt: "go", options: { cwd: "/tmp", model: "m", tools: ["Read"], maxTurns: 2, env: { ANTHROPIC_BASE_URL: model.url, ANTHROPIC_API_KEY: "k" }, steer: () => queue.splice(0) } })) {
      seen.push(m);
      if (m.type === "assistant" && seen.filter((x) => x.type === "assistant").length === 1) queue.push("use metric");
    }
    const end = seen.at(-1);
    assert.equal(end.subtype, "error_max_turns");
    assert.notEqual(end.result, "first answer");
  } finally {
    await model.close();
  }
});

test("killOnClose: a stdio server kept for a session goes with everything it started; without it only the server is closed", async () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-mcp-kill-")));
  const spec = stdioServer(dir);
  // The server leaves a child running, as a launcher script or a dev server would.
  fs.appendFileSync(path.join(dir, "server.mjs"), `
import { spawn } from "node:child_process";
const kid = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
fs.writeFileSync(${JSON.stringify(path.join(dir, "kid"))}, String(kid.pid));
`);
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  const c = await connectMcp({ own: { type: "stdio", ...spec } }, { env: {}, toolEnv: {}, cwd: dir, signal: new AbortController().signal, killOnClose: true });
  assert.deepEqual(c.tools.map((t) => t.name), ["mcp__own__env"]);
  for (let i = 0; i < 100 && !fs.existsSync(path.join(dir, "kid")); i++) await new Promise((r) => setTimeout(r, 50));
  const kid = Number(fs.readFileSync(path.join(dir, "kid"), "utf8"));
  const server = Number(fs.readFileSync(path.join(dir, "pid"), "utf8"));
  assert.ok(alive(kid) && alive(server));
  await c.close();
  for (let i = 0; i < 60 && (alive(kid) || alive(server)); i++) await new Promise((r) => setTimeout(r, 50));
  assert.equal(alive(server), false, "the server");
  assert.equal(alive(kid), false, "what it started");
});

test("maxTools refuses a server while its list is still arriving; kill() ends a stdio server at once", async () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-mcp-max-")));
  const spec = stdioServer(dir);
  await assert.rejects(connectMcp({ own: { type: "stdio", ...spec } }, { env: {}, toolEnv: {}, cwd: dir, signal: new AbortController().signal, maxTools: 0 }), /the MCP server own did not start: it offers more than 0 tools/);
  const c = await connectMcp({ own: { type: "stdio", ...spec } }, { env: {}, toolEnv: {}, cwd: dir, signal: new AbortController().signal, maxTools: 5 });
  const server = Number(fs.readFileSync(path.join(dir, "pid"), "utf8"));
  c.kill();
  let alive = true;
  for (let i = 0; i < 60 && alive; i++) {
    await new Promise((r) => setTimeout(r, 50));
    try {
      process.kill(server, 0);
    } catch {
      alive = false;
    }
  }
  assert.equal(alive, false);
  await c.close();
});

test("thinkingDisplay: the summary is asked only of a model that answers it; the request is otherwise as it was", async () => {
  assert.deepEqual(thinkingParam({ model: "claude-sonnet-5-5", thinkingDisplay: "summarized" }), { type: "adaptive", display: "summarized" });
  assert.equal(thinkingParam({ model: "claude-sonnet-5-5" }), null);
  assert.equal(thinkingParam({ model: "claude-sonnet-5-5", thinkingDisplay: null }), null);
  // An older Claude would refuse the field or start thinking; another provider has no such field.
  for (const model of ["claude-haiku-4-5", "claude-opus-4-8", "claude-sonnet-4-6", "deepseek-chat", "gpt-5", "m"]) {
    assert.equal(thinkingParam({ model, thinkingDisplay: "summarized" }), null, model);
    assert.equal(showsThinking(model), false, model);
  }
  for (const model of ["claude-fable-5-2", "claude-opus-5-5", "claude-opus-5", "claude-sonnet-5", "claude-haiku-5-5"]) assert.equal(showsThinking(model), true, model);
});

test("effort: the agent's level goes out as output_config.effort, on a model that takes one; none asked, the request is as it was", async () => {
  assert.equal(ENGINE_FEATURES.effort, true);
  assert.deepEqual(effortParam({ model: "claude-sonnet-5-5", effort: "xhigh" }), { effort: "xhigh" });
  assert.equal(effortParam({ model: "claude-sonnet-5-5" }), null);
  assert.equal(effortParam({ model: "claude-sonnet-5-5", effort: null }), null);
  // The Claude 5 models take all five words; a Claude from before them has no such parameter and would refuse it.
  for (const model of ["claude-fable-5-2", "claude-opus-5-5", "claude-opus-5", "claude-sonnet-5", "claude-haiku-5-5", "anthropic/claude-sonnet-5-5"]) assert.equal(takesEffort(model), true, model);
  for (const model of ["claude-haiku-4-5", "claude-sonnet-4-5", "claude-opus-4-1", "anthropic/claude-haiku-4-5"]) {
    assert.equal(takesEffort(model), false, model);
    assert.equal(effortParam({ model, effort: "high" }), null, model);
  }
  // The Claude 4 models that take one, each at the levels it has (max from Opus 4.6 and Sonnet 4.6, xhigh from Opus 4.7).
  assert.deepEqual(effortParam({ model: "claude-sonnet-4-6", effort: "medium" }), { effort: "medium" });
  assert.deepEqual(effortParam({ model: "claude-sonnet-4-6", effort: "xhigh" }), { effort: "high" });
  assert.deepEqual(effortParam({ model: "claude-sonnet-4-6", effort: "max" }), { effort: "max" });
  assert.deepEqual(effortParam({ model: "claude-opus-4-8", effort: "xhigh" }), { effort: "xhigh" });
  assert.deepEqual(effortParam({ model: "claude-opus-4-7", effort: "max" }), { effort: "max" });
  assert.deepEqual(effortParam({ model: "claude-opus-4-6", effort: "max" }), { effort: "max" });
  assert.deepEqual(effortParam({ model: "claude-opus-4-6", effort: "xhigh" }), { effort: "high" });
  assert.deepEqual(effortParam({ model: "claude-opus-4-5-20251101", effort: "max" }), { effort: "high" });
  // Straight to a provider's own endpoint: its table, as foldrun's gateway applies it (Moonshot: low | high | max).
  const moonshot = { ANTHROPIC_BASE_URL: "https://api.moonshot.ai/anthropic" };
  assert.deepEqual(effortParam({ model: "kimi-k3", effort: "medium", env: moonshot }), { effort: "high" });
  assert.deepEqual(effortParam({ model: "kimi-k3", effort: "max", env: moonshot }), { effort: "max" });
  assert.deepEqual(effortParam({ model: "kimi-k3", effort: "medium", env: { ANTHROPIC_BASE_URL: "https://api.foldrun.dev" } }), { effort: "medium" }, "the gateway fits it itself");
  // An endpoint whose fields have no output_config is sent none.
  assert.equal(effortParam({ model: "mimo-v2", effort: "high", env: { ANTHROPIC_BASE_URL: "https://api.xiaomimimo.com/anthropic" } }), null);
  // Another provider's model, or a tier the gateway resolves: sent the word, which the gateway fits to what it runs.
  for (const model of ["deepseek/deepseek-chat", "gpt-6-sol", "foldrun/default", "m"]) assert.deepEqual(effortParam({ model, effort: "max" }), { effort: "max" }, model);

  const sent = async (model: string, effort: unknown) => {
    const server = await fakeModel([{ content: [say("ok")] }]);
    try {
      for await (const _ of foldrunQuery({ prompt: "go", options: { cwd: os.tmpdir(), model, tools: [], ...(effort === undefined ? {} : { effort }), env: { ANTHROPIC_BASE_URL: server.url, ANTHROPIC_API_KEY: "k" } } })) void _;
      return server.requests[0].body;
    } finally {
      await server.close();
    }
  };
  assert.deepEqual((await sent("claude-sonnet-5-5", "low")).output_config, { effort: "low" });
  assert.equal("output_config" in (await sent("claude-sonnet-5-5", undefined)), false, "none asked: the field is not sent");
  assert.equal("output_config" in (await sent("claude-haiku-4-5", "high")), false, "a model with no such parameter is not sent it");
  assert.equal("output_config" in (await sent("claude-sonnet-5-5", "extreme")), false, "a word that is not a level is not sent");
});


test("server tools (FOL-304): sent first in tools, the gateway's announcement passed up once, its blocks kept in the conversation", async () => {
  const bodies: any[] = [];
  let n = 0;
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      bodies.push(JSON.parse(raw));
      n++;
      res.writeHead(200, { "content-type": "text/event-stream", "foldrun-server-tools": "web_search_20250305,web_fetch_20250910, bad value" });
      const send = (ev: Record<string, unknown>) => res.write(`event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`);
      send({ type: "message_start", message: { id: `msg_${n}`, model: "m", usage: { input_tokens: 5, output_tokens: 1 } } });
      if (n === 1) {
        send({ type: "content_block_start", index: 0, content_block: { type: "server_tool_use", id: "srv_1", name: "web_search", input: {} } });
        send({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"query":"hats"}' } });
        send({ type: "content_block_stop", index: 0 });
        send({ type: "content_block_start", index: 1, content_block: { type: "web_search_tool_result", tool_use_id: "srv_1", content: [{ type: "web_search_result", url: "https://h.example", title: "Hats" }] } });
        send({ type: "content_block_stop", index: 1 });
        send({ type: "message_delta", delta: { stop_reason: "pause_turn" }, usage: { output_tokens: 3 } });
      } else {
        send({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
        send({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Found hats." } });
        send({ type: "content_block_stop", index: 0 });
        send({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 3 } });
      }
      send({ type: "message_stop" });
      res.end();
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const out: any[] = [];
    const serverTools = [{ type: "web_search_20250305", name: "web_search" }, { type: "web_fetch_20250910", name: "web_fetch" }, { type: "code_execution_20250522", name: "code_execution" }];
    for await (const m of foldrunQuery({ prompt: "find hats", options: { cwd: os.tmpdir(), model: "m", tools: ["Glob"], serverTools, env: { ANTHROPIC_BASE_URL: url, ANTHROPIC_API_KEY: "k" } } as any })) out.push(m);
    assert.deepEqual(bodies[0].tools.slice(0, 2), serverTools.slice(0, 2), "the two known server tools first, as written");
    assert.ok(!bodies[0].tools.some((t: any) => t.name === "code_execution"), "a server tool the engine does not know is never sent");
    assert.equal(bodies[0].tools.at(-1).name, "Glob");
    const said = out.filter((m) => m.type === "system" && m.subtype === "server_tools");
    assert.equal(said.length, 1, "said once");
    assert.deepEqual(said[0].tools, ["web_search_20250305", "web_fetch_20250910"]);
    const sent = JSON.stringify(bodies[1].messages);
    assert.match(sent, /"server_tool_use"[\s\S]*"query":"hats"[\s\S]*web_search_tool_result/, "pause_turn resent with the server blocks kept");
    assert.equal(out.at(-1).subtype, "success");
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
});
