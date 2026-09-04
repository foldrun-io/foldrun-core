// The runtime's Anthropic-to-Chat-Completions translator, driven two ways:
// the pure mappings on their own, and the loopback server end to end
// against a fake OpenAI-shaped upstream that records what it was sent and
// streams back a scripted reply.
//
//   node --test tests/translator.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { toChatCompletions, fromChatCompletion, StreamTranslator, startTranslator } from "../packages/core/src/translator.ts";

type Json = Record<string, unknown>;

// ------------------------------------------------------------- request

test("request: system, text, images, tool definitions and tool_choice cross over", () => {
  const out = toChatCompletions(
    {
      model: "gpt-x",
      max_tokens: 500,
      system: [{ type: "text", text: "Be brief." }],
      messages: [
        { role: "user", content: [{ type: "text", text: "Look at this" }, { type: "image", source: { type: "base64", media_type: "image/png", data: "AAA" } }] },
      ],
      tools: [
        { name: "lookup", description: "Find a thing", input_schema: { type: "object", properties: { q: { type: "string" } } } },
        { type: "web_search_20250305", name: "web_search" },
      ],
      tool_choice: { type: "any", disable_parallel_tool_use: true },
      temperature: 0.2,
      top_k: 40,
      stop_sequences: ["END"],
      metadata: { user_id: "u1" },
    },
    { stream: true, maxTokensParam: "max_completion_tokens" },
  );
  assert.equal(out.model, "gpt-x");
  assert.equal(out.max_completion_tokens, 500);
  assert.equal(out.max_tokens, undefined);
  const messages = out.messages as Json[];
  assert.deepEqual(messages[0], { role: "system", content: "Be brief." });
  assert.equal(messages[1].role, "user");
  const parts = messages[1].content as Json[];
  assert.equal(parts[0].type, "text");
  assert.match(String((parts[1].image_url as Json).url), /^data:image\/png;base64,AAA$/);
  const tools = out.tools as Json[];
  assert.equal(tools.length, 1, "the server-side tool is dropped, not translated");
  assert.equal((tools[0].function as Json).name, "lookup");
  assert.equal(out.tool_choice, "required");
  assert.equal(out.parallel_tool_calls, false);
  assert.equal(out.temperature, 0.2);
  assert.deepEqual(out.stop, ["END"]);
  assert.equal(out.user, "u1");
  assert.deepEqual(out.stream_options, { include_usage: true });
  assert.equal(out.top_k, undefined);
});

test("request: a tool call and its result become an assistant tool_calls turn and a tool message, in order", () => {
  const out = toChatCompletions(
    {
      model: "m",
      max_tokens: 10,
      messages: [
        { role: "user", content: "What is the price?" },
        { role: "assistant", content: [{ type: "text", text: "Checking." }, { type: "tool_use", id: "call_1", name: "lookup", input: { q: "price" } }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "call_1", content: [{ type: "text", text: "$34" }] }, { type: "text", text: "and the colour?" }] },
      ],
    },
    { stream: false },
  );
  const m = out.messages as Json[];
  assert.deepEqual(m[0], { role: "user", content: "What is the price?" });
  assert.equal(m[1].role, "assistant");
  assert.equal(m[1].content, "Checking.");
  assert.deepEqual(m[1].tool_calls, [{ id: "call_1", type: "function", function: { name: "lookup", arguments: '{"q":"price"}' } }]);
  assert.deepEqual(m[2], { role: "tool", tool_call_id: "call_1", content: "$34" });
  assert.deepEqual(m[3], { role: "user", content: "and the colour?" });
});

test("request: thinking becomes reasoning_effort only where the endpoint has it", () => {
  const withEffort = toChatCompletions({ model: "m", max_tokens: 1, messages: [], thinking: { type: "enabled", budget_tokens: 4000 } }, { stream: false, reasoningEffort: true });
  assert.equal(withEffort.reasoning_effort, "medium");
  const without = toChatCompletions({ model: "m", max_tokens: 1, messages: [], thinking: { type: "enabled", budget_tokens: 4000 } }, { stream: false });
  assert.equal(without.reasoning_effort, undefined);
  const word = toChatCompletions({ model: "m", max_tokens: 1, messages: [], output_config: { effort: "xhigh" } }, { stream: false, reasoningEffort: true });
  assert.equal(word.reasoning_effort, "high");
});

// ------------------------------------------------------------ response

test("response: a completion with text and a tool call maps to Anthropic blocks", () => {
  const msg = fromChatCompletion(
    {
      id: "chatcmpl-1",
      model: "gpt-x",
      choices: [{ finish_reason: "tool_calls", message: { role: "assistant", content: "Let me check.", tool_calls: [{ id: "call_9", type: "function", function: { name: "lookup", arguments: '{"q":"x"}' } }] } }],
      usage: { prompt_tokens: 12, completion_tokens: 7 },
    },
    "gpt-x",
  );
  assert.equal(msg.id, "chatcmpl-1");
  assert.equal(msg.stop_reason, "tool_use");
  assert.deepEqual(msg.content, [{ type: "text", text: "Let me check." }, { type: "tool_use", id: "call_9", name: "lookup", input: { q: "x" } }]);
  assert.deepEqual(msg.usage, { input_tokens: 12, output_tokens: 7 });
  const cut = fromChatCompletion({ choices: [{ finish_reason: "length", message: { content: "…" } }] }, "m");
  assert.equal(cut.stop_reason, "max_tokens");
});

function events(sse: string[]): { event: string; data: Json }[] {
  return sse.join("").split("\n\n").filter(Boolean).map((block) => {
    const [e, d] = block.split("\n");
    return { event: e.replace("event: ", ""), data: JSON.parse(d.replace("data: ", "")) as Json };
  });
}

test("stream: text deltas then a tool call with fragmented arguments become well-formed blocks", () => {
  const m = new StreamTranslator("gpt-x");
  const out: string[] = [];
  out.push(...m.feed({ id: "c1", model: "gpt-x", choices: [{ delta: { role: "assistant", content: "Hel" } }] }));
  out.push(...m.feed({ choices: [{ delta: { content: "lo" } }] }));
  out.push(...m.feed({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "lookup", arguments: "" } }] } }] }));
  out.push(...m.feed({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"q":' } }] } }] }));
  out.push(...m.feed({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"x"}' } }] }, finish_reason: "tool_calls" }] }));
  out.push(...m.feed({ choices: [], usage: { prompt_tokens: 5, completion_tokens: 9 } }));
  out.push(...m.finishStream());
  const ev = events(out);
  assert.deepEqual(
    ev.map((e) => e.event),
    ["message_start", "content_block_start", "content_block_delta", "content_block_delta", "content_block_stop", "content_block_start", "content_block_delta", "content_block_delta", "content_block_stop", "message_delta", "message_stop"],
  );
  assert.equal((ev[0].data.message as Json).id, "c1");
  assert.equal(((ev[1].data.content_block as Json).type), "text");
  assert.equal(ev[1].data.index, 0);
  const toolStart = ev[5].data;
  assert.equal(toolStart.index, 1);
  assert.deepEqual(toolStart.content_block, { type: "tool_use", id: "call_1", name: "lookup", input: {} });
  const json = [ev[6], ev[7]].map((e) => String((e.data.delta as Json).partial_json)).join("");
  assert.deepEqual(JSON.parse(json), { q: "x" });
  assert.equal((ev[9].data.delta as Json).stop_reason, "tool_use");
  assert.deepEqual(ev[9].data.usage, { input_tokens: 5, output_tokens: 9 });
});

test("stream: a tool call that streamed no arguments still closes with a parseable input", () => {
  const m = new StreamTranslator("m");
  const out = [...m.feed({ choices: [{ delta: { tool_calls: [{ index: 0, id: "c", function: { name: "ping" } }] } }] }), ...m.finishStream()];
  const ev = events(out);
  const deltas = ev.filter((e) => e.event === "content_block_delta");
  assert.equal(deltas.length, 1);
  assert.equal((deltas[0].data.delta as Json).partial_json, "{}");
});

test("stream: a reply cut off by length says max_tokens; a plain reply says end_turn", () => {
  const a = new StreamTranslator("m");
  const cut = events([...a.feed({ choices: [{ delta: { content: "x" }, finish_reason: "length" }] }), ...a.finishStream()]);
  assert.equal((cut.find((e) => e.event === "message_delta")!.data.delta as Json).stop_reason, "max_tokens");
  const b = new StreamTranslator("m");
  const plain = events([...b.feed({ choices: [{ delta: { content: "x" }, finish_reason: "stop" }] }), ...b.finishStream()]);
  assert.equal((plain.find((e) => e.event === "message_delta")!.data.delta as Json).stop_reason, "end_turn");
});

// ------------------------------------------------------- end to end

/** A fake Chat-Completions provider: records the request, answers by script. */
function fakeUpstream(script: (body: Json) => { status?: number; json?: Json; chunks?: Json[] }) {
  const seen: { headers: http.IncomingHttpHeaders; body: Json; path: string }[] = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c: Buffer) => (raw += c.toString()));
    req.on("end", () => {
      const body = JSON.parse(raw) as Json;
      seen.push({ headers: req.headers, body, path: req.url ?? "" });
      const reply = script(body);
      if (reply.status && reply.status >= 400) {
        res.writeHead(reply.status, { "content-type": "application/json" });
        return res.end(JSON.stringify(reply.json ?? { error: { message: "nope" } }));
      }
      if (reply.chunks) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        for (const c of reply.chunks) res.write(`data: ${JSON.stringify(c)}\n\n`);
        res.write("data: [DONE]\n\n");
        return res.end();
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(reply.json ?? {}));
    });
  });
  return new Promise<{ base: string; seen: typeof seen; close: () => void }>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port;
      resolve({ base: `http://127.0.0.1:${port}/v1`, seen, close: () => server.close() });
    });
  });
}

test("end to end: the SDK-shaped request reaches the upstream translated, and the reply comes back Anthropic-shaped", async () => {
  const up = await fakeUpstream(() => ({
    json: { id: "chatcmpl-7", model: "llama", choices: [{ finish_reason: "stop", message: { content: "The price is $34." } }], usage: { prompt_tokens: 3, completion_tokens: 6 } },
  }));
  const t = await startTranslator({ upstreamBase: up.base, upstreamKey: "sk-real", headers: { "X-Title": "foldrun" }, label: "fake" });
  try {
    const res = await fetch(`${t.baseUrl}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": t.key, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: "llama", max_tokens: 50, system: "Be terse.", messages: [{ role: "user", content: "price?" }] }),
    });
    assert.equal(res.status, 200);
    const msg = (await res.json()) as Json;
    assert.equal(msg.type, "message");
    assert.deepEqual(msg.content, [{ type: "text", text: "The price is $34." }]);
    assert.equal(msg.stop_reason, "end_turn");
    assert.equal(up.seen.length, 1);
    assert.equal(up.seen[0].path, "/v1/chat/completions");
    assert.equal(up.seen[0].headers.authorization, "Bearer sk-real", "the provider gets the customer's key as a bearer");
    assert.equal(up.seen[0].headers["x-title"], "foldrun");
    assert.equal(up.seen[0].body.stream, false);
    assert.deepEqual((up.seen[0].body.messages as Json[])[0], { role: "system", content: "Be terse." });
    assert.ok(t.drainLog().some((l) => /200/.test(l)));
    assert.deepEqual(t.env.ANTHROPIC_BASE_URL, t.baseUrl);
    assert.equal(t.env.ANTHROPIC_API_KEY, t.key);
  } finally {
    await t.close();
    up.close();
  }
});

test("end to end: a streamed tool call arrives as Anthropic SSE with the arguments intact", async () => {
  const up = await fakeUpstream(() => ({
    chunks: [
      { id: "c9", model: "m", choices: [{ delta: { role: "assistant", content: "" } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_z", type: "function", function: { name: "probe_fetch_token", arguments: '{"reas' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'on":"go"}' } }] }, finish_reason: "tool_calls" }] },
      { choices: [], usage: { prompt_tokens: 20, completion_tokens: 8 } },
    ],
  }));
  const t = await startTranslator({ upstreamBase: up.base, upstreamKey: "k" });
  try {
    const res = await fetch(`${t.baseUrl}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${t.key}` },
      body: JSON.stringify({ model: "m", max_tokens: 50, stream: true, messages: [{ role: "user", content: "go" }], tools: [{ name: "probe_fetch_token", input_schema: { type: "object" } }] }),
    });
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /text\/event-stream/);
    const text = await res.text();
    const ev = events([text]);
    const start = ev.find((e) => e.event === "content_block_start" && (e.data.content_block as Json).type === "tool_use")!;
    assert.equal((start.data.content_block as Json).name, "probe_fetch_token");
    const args = ev.filter((e) => e.event === "content_block_delta").map((e) => String((e.data.delta as Json).partial_json)).join("");
    assert.deepEqual(JSON.parse(args), { reason: "go" });
    assert.equal(ev.at(-1)!.event, "message_stop");
    assert.equal(up.seen[0].body.stream, true);
  } finally {
    await t.close();
    up.close();
  }
});

test("end to end: the provider's status and message cross back unchanged, and the door is keyed", async () => {
  const up = await fakeUpstream(() => ({ status: 401, json: { error: { message: "Incorrect API key provided" } } }));
  const t = await startTranslator({ upstreamBase: up.base, upstreamKey: "bad" });
  try {
    const res = await fetch(`${t.baseUrl}/v1/messages`, { method: "POST", headers: { "x-api-key": t.key }, body: JSON.stringify({ model: "m", max_tokens: 1, messages: [] }) });
    assert.equal(res.status, 401);
    const err = (await res.json()) as Json;
    assert.equal((err.error as Json).type, "authentication_error");
    assert.match(String((err.error as Json).message), /Incorrect API key/);

    const wrongKey = await fetch(`${t.baseUrl}/v1/messages`, { method: "POST", headers: { "x-api-key": "nope" }, body: "{}" });
    assert.equal(wrongKey.status, 401);
    assert.equal(up.seen.length, 1, "a wrong translator key never reaches the provider");

    const count = await fetch(`${t.baseUrl}/v1/messages/count_tokens`, { method: "POST", headers: { "x-api-key": t.key }, body: JSON.stringify({ messages: [{ role: "user", content: "x".repeat(400) }] }) });
    assert.ok(((await count.json()) as Json).input_tokens as number > 50);

    const missing = await fetch(`${t.baseUrl}/v1/models`, { headers: { "x-api-key": t.key } });
    assert.equal(missing.status, 404);
  } finally {
    await t.close();
    up.close();
  }
});

// ---------------------------------------------------------------- params

test("params: merge in last, so the file wins; null removes a field", () => {
  const out = toChatCompletions(
    { model: "m", max_tokens: 100, temperature: 0.9, messages: [{ role: "user", content: "hi" }] },
    {
      stream: false,
      reasoningEffort: true,
      params: { temperature: 0.1, seed: 42, provider: { order: ["Groq"] }, top_p: null },
    },
  );
  assert.equal(out.temperature, 0.1, "the file beats what the loop sent");
  assert.equal(out.seed, 42);
  assert.deepEqual(out.provider, { order: ["Groq"] });
  assert.equal("top_p" in out, false, "null removes it");
  assert.equal((out.messages as unknown[]).length, 1, "the conversation is untouched");
});

test("params: an endpoint that rejects a field can be told to stop sending it", async () => {
  const up = await fakeUpstream(() => ({ json: { choices: [{ finish_reason: "stop", message: { content: "ok" } }] } }));
  const t = await startTranslator({
    upstreamBase: up.base,
    upstreamKey: "k",
    params: { temperature: null, reasoning_effort: "low", extra_body: { anything: true } },
  });
  try {
    await fetch(`${t.baseUrl}/v1/messages`, {
      method: "POST",
      headers: { "x-api-key": t.key },
      body: JSON.stringify({ model: "m", max_tokens: 10, temperature: 0.7, messages: [{ role: "user", content: "x" }] }),
    });
    const sent = up.seen[0].body;
    assert.equal("temperature" in sent, false);
    assert.equal(sent.reasoning_effort, "low");
    assert.deepEqual(sent.extra_body, { anything: true });
  } finally {
    await t.close();
    up.close();
  }
});
