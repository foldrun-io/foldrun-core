// foldrun's own agent loop (src/engine-loop.ts), driven the way production
// drives it: through executeStep, with `engine: "foldrun"`, against a
// model endpoint that plays back scripted turns. So what is tested is the
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
import { buildRequest, foldrunQuery } from "../src/engine-loop.ts";
import { ENGINE_TOOLS } from "../src/engine-tools.ts";

type Block = { type: "text"; text: string } | { type: "tool_use"; id: string; name: string; input: unknown; rawInput?: string };
interface Scripted {
  content: Block[];
  /** End the stream after the first block's text, with no closing events. */
  cut?: boolean;
  stop?: string;
  status?: number;
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
        res.writeHead(turn.status, { "content-type": "application/json" });
        return res.end(JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "busy" } }));
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
        send({ type: "content_block_stop", index });
      });
      if (turn.cut) return res.end();
      const stop = turn.stop ?? (turn.content.some((b) => b.type === "tool_use") ? "tool_use" : "end_turn");
      send({ type: "message_delta", delta: { stop_reason: stop }, usage: { output_tokens: u.output_tokens ?? 5 } });
      send({ type: "message_stop" });
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

test("no environment variable chooses the engine or drops the shell's sandbox — a secret's name is the tenant's to pick", () => {
  // A step's environment carries its secrets under names the tenant chose,
  // so a switch read from it would be the tenant's to throw. The choice is
  // ExecOptions.engine, and nothing in the engine reads a name for it.
  const src = path.join(import.meta.dirname, "..", "src");
  for (const file of ["engine-loop.ts", "engine-tools.ts", "step-exec.ts"]) {
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

test("a coding step: read, edit, answer — the file changes and the record says what happened", async () => {
  const r = await runStep([
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

test("confinement is step-exec's, unchanged: a path outside the workspace is refused and never read", async () => {
  const secret = path.join(os.tmpdir(), `foldrun-engine-secret-${process.pid}.txt`);
  fs.writeFileSync(secret, "TOP SECRET");
  try {
    const r = await runStep([
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

test("workspace/ paths are expanded by the hook's rewrite, and the tool runs on the rewritten input", async () => {
  const r = await runStep([
    { content: [use("t1", "Write", { file_path: "workspace/storage/report.txt", content: "done" })] },
    { content: [say("Written.")] },
  ]);
  assert.equal(r.out!.status, "completed");
  assert.equal(fs.readFileSync(path.join(r.root, "storage", "report.txt"), "utf8"), "done");
});

test("limits: a call past the limit never runs, and the model is told", async () => {
  const r = await runStep([
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

test("a tool the agent was not given, and arguments that are not JSON, come back as errors the model can act on", async () => {
  const r = await runStep([
    { content: [use("t1", "Bash", { command: "echo hi" }), { type: "tool_use", id: "t2", name: "Read", input: {}, rawInput: '{"file_path": "a' }] },
    { content: [say("ok")] },
  ]);
  assert.equal(r.out!.status, "completed");
  const [bash, read] = r.requests[1].body.messages[2].content;
  assert.equal(bash.content, "Tool Bash is not enabled for this agent.");
  assert.match(read.content, /were not valid JSON/);
  assert.equal(bash.is_error && read.is_error, true);
});

test("several reads in one turn all answer, in the order asked", async () => {
  const r = await runStep([
    { content: [use("a", "Read", { file_path: "1.txt" }), use("b", "Read", { file_path: "2.txt" }), use("c", "Glob", { pattern: "*.txt" })] },
    { content: [say("read both")] },
  ], { files: { "1.txt": "one", "2.txt": "two" } });
  const results = r.requests[1].body.messages[2].content;
  assert.deepEqual(results.map((b: any) => b.tool_use_id), ["a", "b", "c"]);
  assert.equal(results[0].content, "1\tone");
  assert.equal(results[1].content, "1\ttwo");
});

test("max_turns ends the step as failed, saying so", async () => {
  const r = await runStep([{ content: [use("t", "Glob", { pattern: "*" })] }], { maxTurns: 2 });
  assert.equal(r.out!.status, "failed");
  assert.equal(r.requests.length, 2);
  assert.ok(r.events.some((e) => e.type === "error" && /stopped after 2 turns/.test(e.text)));
});

test("only a reply the model ended itself finishes the step (FOL-211)", async () => {
  const finished = await runStep([{ content: [say("All done.")], stop: "end_turn" }]);
  assert.equal(finished.out!.status, "completed");
  assert.equal(finished.out!.stopReason, "end_turn");

  // Cut off at the output limit: failed, saying why, the partial reply kept.
  const cut = await runStep([{ content: [say("Here is the first half of the")], stop: "max_tokens" }]);
  assert.equal(cut.out!.status, "failed");
  assert.equal(cut.out!.stopReason, "max_tokens");
  assert.equal(cut.events.filter((e) => e.type === "error").length, 1, "said once");
  assert.ok(cut.events.some((e) => e.type === "error" && /cut off at the output limit/.test(e.text)));
  assert.equal(cut.out!.result, "Here is the first half of the");

  // A pause the provider made is carried on, then the finish counts.
  const paused = await runStep([{ content: [say("part one")], stop: "pause_turn" }, { content: [say("and done")], stop: "end_turn" }]);
  assert.equal(paused.out!.status, "completed");
  assert.equal(paused.requests.length, 2);


  const refused = await runStep([{ content: [say("I can't help with that.")], stop: "refusal" }]);
  assert.equal(refused.out!.status, "failed");
  assert.ok(refused.events.some((e) => e.type === "error" && /declined/.test(e.text)));

  const strange = await runStep([{ content: [say("hm")], stop: "something_new" }]);
  assert.equal(strange.out!.status, "failed");
  assert.ok(strange.events.some((e) => e.type === "error" && /something_new/.test(e.text)));

  // Said it would call a tool and sent none.
  const empty = await runStep([{ content: [say("calling now")], stop: "tool_use" }]);
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

test("an overloaded endpoint is retried; a refused request is not", async () => {
  const retried = await runStep([{ status: 529, content: [] }, { content: [say("there now")] }]);
  assert.equal(retried.out!.status, "completed");
  assert.equal(retried.requests.length, 2);
  const refused = await runStep([{ status: 400, content: [] }]);
  assert.match(refused.error!.message, /the model endpoint answered 400/);
  assert.equal(refused.requests.length, 1);
});

test("the shell: refused on a host that asked for an OS sandbox, run where the caller is the boundary", async () => {
  const turns: Scripted[] = [
    { content: [use("t1", "Bash", { command: "echo built > out.txt && cat out.txt" })] },
    { content: [say("Built.")] },
  ];
  const host = await runStep(turns, { allowed: ["Bash"] });
  assert.match(host.error!.message, /no OS sandbox for the shell on this host/);
  assert.equal(host.requests.length, 0, "refused before a model call was paid for");

  const contained = await runStep(turns, { allowed: ["Bash"], sandboxBash: false });
  assert.equal(contained.out!.status, "completed");
  assert.equal(contained.read("out.txt"), "built\n");
  assert.equal(contained.requests[1].body.messages[2].content[0].content, "built");
});

test("the shell is still confined by step-exec: a command reaching outside the workspace is refused", async () => {
  const r = await runStep([
    { content: [use("t1", "Bash", { command: "cat ../../../secrets.json" })] },
    { content: [say("refused")] },
  ], { allowed: ["Bash"], sandboxBash: false });
  const result = r.requests[1].body.messages[2].content[0];
  assert.equal(result.is_error, true);
  assert.match(result.content, /^Bash was denied/);
});

test("a timeout ends a running command and the step, with the cost of the turns it took", async () => {
  const started = Date.now();
  const r = await runStep([{ content: [use("t1", "Bash", { command: "sleep 60" })] }], { allowed: ["Bash"], sandboxBash: false, timeoutSec: 1 });
  assert.equal(r.out!.status, "failed");
  assert.ok(Date.now() - started < 10_000, "the step did not wait for the command");
  assert.ok(r.events.some((e) => e.type === "error" && /^timed out after 1s/.test(e.text)));
  assert.equal(r.out!.usage?.outputTokens, 5, "the turn it took is still counted");
});

test("what this engine cannot run yet is refused by name, not run without", () => {
  const base = { cwd: "/tmp", model: "m", env: {}, tools: [] as string[] };
  assert.throws(() => foldrunQuery({ prompt: "p", options: { ...base, mcpServers: { crm: {} } } }), /does not connect MCP servers yet \(crm\)/);
  assert.throws(() => foldrunQuery({ prompt: "p", options: { ...base, agents: { helper: {} } } }), /does not run sub-agents yet/);
  assert.throws(() => foldrunQuery({ prompt: "p", options: { ...base, tools: ["Read", "TodoWrite"] } }), /no tool named TodoWrite yet/);
});

test("a call is checked just before it runs: a link made by an earlier command in the same turn does not open a way out", async () => {
  // knowledge/ may not be written by an agent. Checked ahead of the turn,
  // the Write below named a path that did not exist yet; checked in its
  // turn, it names a link into knowledge/ and is refused.
  const r = await runStep([
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

test("a stream cut part-way is a failure, never the model's answer", async () => {
  const r = await runStep([{ content: [say("The answer is forty-")], cut: true }]);
  assert.equal(r.out, null);
  assert.match(r.error!.message, /ended part-way through a reply/);
});

test("on a person's own machine the caller may say the shell runs unsandboxed", async () => {
  const r = await runStep([
    { content: [use("t1", "Bash", { command: "echo local" })] },
    { content: [say("ok")] },
  ], { allowed: ["Bash"], engineHostShell: true });
  assert.equal(r.out!.status, "completed");
  assert.equal(r.requests[1].body.messages[2].content[0].content, "local");
});

test("history: an earlier conversation goes before the prompt, as given; a broken one is refused before a model call", async () => {
  const { foldrunQuery } = await import("../src/engine-loop.ts");
  const model = await fakeModel([{ content: [say("Still 5.")] }]);
  try {
    const history = [
      { role: "user", content: [{ type: "text", text: "what is 2+3?" }] },
      { role: "assistant", content: [{ type: "text", text: "5." }] },
    ];
    const q = foldrunQuery({ prompt: "and now?", options: { cwd: os.tmpdir(), model: "test-model", tools: [], history, env: { ANTHROPIC_BASE_URL: model.url, ANTHROPIC_API_KEY: "k" } } });
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
        for await (const _ of foldrunQuery({ prompt: "p", options: { cwd: os.tmpdir(), model: "m", tools: [], history: bad, env: { ANTHROPIC_BASE_URL: model.url } } })) void _;
      });
      assert.equal(model.requests.length, before, "refused before any model call");
    }
  } finally {
    await model.close();
  }
});

test("shellEnv: the tools get it, the model call keeps env's key", async () => {
  const { foldrunQuery } = await import("../src/engine-loop.ts");
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-shellenv-")));
  const model = await fakeModel([{ content: [use("b1", "Bash", { command: "echo key=${ANTHROPIC_AUTH_TOKEN:-none} own=$OWN > out.txt" })] }, { content: [say("ok")] }]);
  try {
    const q = foldrunQuery({ prompt: "p", options: { cwd: dir, model: "m", tools: ["Bash"], engineHostShell: true, sandbox: { enabled: false }, env: { PATH: process.env.PATH, ANTHROPIC_BASE_URL: model.url, ANTHROPIC_AUTH_TOKEN: "secret-gw" }, shellEnv: { PATH: process.env.PATH, OWN: "mine" } } });
    for await (const _ of q) void _;
    assert.equal(fs.readFileSync(path.join(dir, "out.txt"), "utf8").trim(), "key=none own=mine");
    assert.equal(model.requests[0]!.headers.authorization, "Bearer secret-gw");
  } finally {
    await model.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("extraTools: a host's own tool is offered, asked through canUseTool, and run with the step's signal", async () => {
  const { foldrunQuery } = await import("../src/engine-loop.ts");
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
    const q = foldrunQuery({
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
        for await (const _ of foldrunQuery({ prompt: "p", options: { cwd: os.tmpdir(), model: "m", tools: ["Read"], extraTools: bad, env: { ANTHROPIC_BASE_URL: model.url } } })) void _;
      }, /extraTools/);
    }
  } finally {
    await model.close();
  }
});
