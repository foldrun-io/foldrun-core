// The translator's second shape: Anthropic Messages in, OpenAI Responses
// out. The pure mappings on their own, the stream machine on a scripted
// event sequence, and the loopback server end to end against a fake
// Responses upstream that records what it was sent.
//
//   node --test tests/translator-responses.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { toResponses, fromResponses, ResponsesStreamTranslator, startTranslator, translatorSpecFor, modelRejectsReasoning } from "../src/translator.ts";

type Json = Record<string, unknown>;

function events(sse: string[]): { event: string; data: Json }[] {
  return sse.join("").split("\n\n").filter(Boolean).map((block) => {
    const [e, d] = block.split("\n");
    return { event: e.replace("event: ", ""), data: JSON.parse(d.replace("data: ", "")) as Json };
  });
}

// ------------------------------------------------------------- request

test("request: system → instructions; text, image and a PDF cross; tools are flat function items", () => {
  const out = toResponses(
    {
      model: "gpt-5",
      max_tokens: 200,
      temperature: 0.2,
      system: [{ type: "text", text: "Be terse." }],
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "What does the report say?" },
            { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
            { type: "document", title: "strata.pdf", source: { type: "base64", media_type: "application/pdf", data: "JVBERi0=" } },
          ],
        },
      ],
      tools: [{ name: "lookup", description: "find a thing", input_schema: { type: "object", properties: { q: { type: "string" } } } }],
      tool_choice: { type: "auto" },
    },
    { stream: false },
  ) as Json;
  assert.equal(out.instructions, "Be terse.");
  assert.equal(out.max_output_tokens, 200);
  // OpenAI caps safety_identifier at 64 characters; the SDK's user id is
  // longer. A stable digest, same user → same id, inside the limit.
  const long = toResponses({ model: "m", messages: [], metadata: { user_id: "u".repeat(150) } }, { stream: false }) as Json;
  assert.equal(String(long.safety_identifier).length, 64);
  assert.equal(long.safety_identifier, (toResponses({ model: "m", messages: [], metadata: { user_id: "u".repeat(150) } }, { stream: false }) as Json).safety_identifier, "stable");
  const short = toResponses({ model: "m", messages: [], metadata: { user_id: "user-1" } }, { stream: false }) as Json;
  assert.equal(short.safety_identifier, "user-1", "a short id passes through");
  assert.equal(out.temperature, 0.2);
  assert.equal(out.store, false, "nothing is kept on the provider's side");
  const user = (out.input as Json[])[0];
  assert.equal(user.role, "user");
  const parts = user.content as Json[];
  assert.deepEqual(parts[0], { type: "input_text", text: "What does the report say?" });
  assert.equal(parts[1].type, "input_image");
  assert.match(String(parts[1].image_url), /^data:image\/png;base64,AAAA$/);
  // The PDF crosses — the thing Chat Completions drops.
  assert.deepEqual(parts[2], { type: "input_file", filename: "strata.pdf", file_data: "data:application/pdf;base64,JVBERi0=" });
  assert.deepEqual(out.tools, [{ type: "function", name: "lookup", description: "find a thing", parameters: { type: "object", properties: { q: { type: "string" } } }, strict: false }]);
  assert.equal(out.tool_choice, "auto");
});

test("request: a tool call and its result become function_call and function_call_output items, in order", () => {
  const out = toResponses(
    {
      model: "gpt-5",
      messages: [
        { role: "user", content: "go" },
        { role: "assistant", content: [{ type: "text", text: "Looking." }, { type: "tool_use", id: "call_1", name: "lookup", input: { q: "x" } }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "call_1", content: [{ type: "text", text: "found it" }] }, { type: "text", text: "and?" }] },
      ],
    },
    { stream: false },
  ) as Json;
  const input = out.input as Json[];
  assert.deepEqual(input.map((i) => i.type ?? i.role), ["user", "assistant", "function_call", "function_call_output", "user"]);
  assert.deepEqual(input[2], { type: "function_call", call_id: "call_1", name: "lookup", arguments: '{"q":"x"}' });
  assert.deepEqual(input[3], { type: "function_call_output", call_id: "call_1", output: "found it" });
  assert.deepEqual(input[4], { role: "user", content: [{ type: "input_text", text: "and?" }] });
});

test("request: thinking becomes reasoning.effort; forced tool choice and parallel-off cross; unsupported knobs are said", () => {
  const drops: string[] = [];
  const drop = { add: (w: string) => drops.push(w), lines: () => drops };
  const out = toResponses(
    {
      model: "o-x",
      thinking: { type: "enabled", budget_tokens: 16000 },
      top_k: 5,
      stop_sequences: ["END"],
      tools: [{ name: "a", input_schema: { type: "object" } }],
      tool_choice: { type: "tool", name: "a", disable_parallel_tool_use: true },
      messages: [{ role: "user", content: "x" }],
    },
    { stream: false, reasoningEffort: true },
    drop,
  ) as Json;
  assert.deepEqual(out.reasoning, { effort: "high" });
  // A model that does not reason must not be sent the knob: OpenAI rejects
  // the request outright, and a gateway hid that.
  const plain = toResponses({ model: "gpt-4o-mini", thinking: { type: "adaptive" }, messages: [] }, { stream: false, reasoningEffort: true }, drop) as Json;
  assert.equal(plain.reasoning, undefined);
  assert.ok(drops.some((d) => /does not reason/.test(d)));
  for (const [id, no] of [["o3-mini", false], ["openai/o4-mini", false], ["gpt-5", false], ["gpt-5-chat-latest", true], ["gpt-oss-120b", false], ["gpt-4o", true], ["openai/gpt-4.1-mini", true], ["grok-4", false], ["deepseek-r1", false], ["llama-3.3-70b-versatile", false]] as const) {
    assert.equal(modelRejectsReasoning(id), no, id);
  }
  assert.deepEqual(out.tool_choice, { type: "function", name: "a" });
  assert.equal(out.parallel_tool_calls, false);
  assert.ok(drops.includes("top_k") && drops.includes("stop_sequences"));
  const off = toResponses({ model: "m", thinking: { type: "adaptive" }, messages: [] }, { stream: false, reasoningEffort: false }, drop) as Json;
  assert.equal(off.reasoning, undefined);
  assert.ok(drops.includes("thinking / effort"));
});

// ------------------------------------------------------------ response

test("response: output items become Anthropic blocks; the stop reason follows tool calls and truncation", () => {
  const msg = fromResponses(
    {
      id: "resp_1",
      model: "gpt-5",
      output: [
        { type: "reasoning", summary: [] },
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "On it." }] },
        { type: "function_call", call_id: "call_9", name: "lookup", arguments: '{"q":"x"}' },
      ],
      usage: { input_tokens: 12, output_tokens: 7 },
    },
    "gpt-5",
  ) as Json;
  assert.equal(msg.id, "resp_1");
  assert.deepEqual(msg.content, [
    { type: "text", text: "On it." },
    { type: "tool_use", id: "call_9", name: "lookup", input: { q: "x" } },
  ]);
  assert.equal(msg.stop_reason, "tool_use");
  assert.deepEqual(msg.usage, { input_tokens: 12, output_tokens: 7 });
  const cut = fromResponses({ output: [{ type: "message", content: [{ type: "output_text", text: "half" }] }], incomplete_details: { reason: "max_output_tokens" } }, "m") as Json;
  assert.equal(cut.stop_reason, "max_tokens");
  const plain = fromResponses({ output: [{ type: "message", content: [{ type: "output_text", text: "done" }] }] }, "m") as Json;
  assert.equal(plain.stop_reason, "end_turn");
});

test("stream: a text item then a tool item with fragmented arguments become well-formed blocks", () => {
  const m = new ResponsesStreamTranslator("gpt-5");
  const out: string[] = [];
  out.push(...m.feed({ type: "response.created", response: { id: "resp_7", model: "gpt-5" } }));
  out.push(...m.feed({ type: "response.output_item.added", output_index: 0, item: { type: "message", role: "assistant", content: [] } }));
  out.push(...m.feed({ type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "Hel" }));
  out.push(...m.feed({ type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "lo" }));
  out.push(...m.feed({ type: "response.output_item.done", output_index: 0, item: { type: "message" } }));
  out.push(...m.feed({ type: "response.output_item.added", output_index: 1, item: { type: "function_call", call_id: "call_1", name: "lookup", arguments: "" } }));
  out.push(...m.feed({ type: "response.function_call_arguments.delta", output_index: 1, delta: '{"q":' }));
  out.push(...m.feed({ type: "response.function_call_arguments.delta", output_index: 1, delta: '"x"}' }));
  out.push(...m.feed({ type: "response.output_item.done", output_index: 1, item: { type: "function_call", call_id: "call_1", name: "lookup", arguments: '{"q":"x"}' } }));
  out.push(...m.feed({ type: "response.completed", response: { id: "resp_7", usage: { input_tokens: 5, output_tokens: 9 } } }));
  out.push(...m.finishStream());
  const ev = events(out);
  assert.deepEqual(
    ev.map((e) => e.event),
    ["message_start", "content_block_start", "content_block_delta", "content_block_delta", "content_block_stop", "content_block_start", "content_block_delta", "content_block_delta", "content_block_stop", "message_delta", "message_stop"],
  );
  assert.equal((ev[0].data.message as Json).id, "resp_7");
  assert.deepEqual(ev[5].data.content_block, { type: "tool_use", id: "call_1", name: "lookup", input: {} });
  const json = [ev[6], ev[7]].map((e) => String((e.data.delta as Json).partial_json)).join("");
  assert.deepEqual(JSON.parse(json), { q: "x" });
  assert.equal((ev[9].data.delta as Json).stop_reason, "tool_use");
  assert.deepEqual(ev[9].data.usage, { input_tokens: 5, output_tokens: 9 });
});

test("stream: arguments that arrive whole on the done item, and a reply cut by length", () => {
  const m = new ResponsesStreamTranslator("m");
  const out: string[] = [];
  out.push(...m.feed({ type: "response.output_item.added", output_index: 0, item: { type: "function_call", call_id: "c", name: "f" } }));
  out.push(...m.feed({ type: "response.output_item.done", output_index: 0, item: { type: "function_call", call_id: "c", name: "f", arguments: '{"a":1}' } }));
  out.push(...m.finishStream());
  const ev = events(out);
  const deltas = ev.filter((e) => e.event === "content_block_delta").map((e) => String((e.data.delta as Json).partial_json)).join("");
  assert.deepEqual(JSON.parse(deltas), { a: 1 });

  const cut = new ResponsesStreamTranslator("m");
  const out2: string[] = [];
  out2.push(...cut.feed({ type: "response.output_item.added", output_index: 0, item: { type: "message" } }));
  out2.push(...cut.feed({ type: "response.output_text.delta", output_index: 0, delta: "half" }));
  out2.push(...cut.feed({ type: "response.incomplete", response: { incomplete_details: { reason: "max_output_tokens" }, usage: { input_tokens: 1, output_tokens: 2 } } }));
  out2.push(...cut.finishStream());
  const ev2 = events(out2);
  assert.equal((ev2.find((e) => e.event === "message_delta")!.data.delta as Json).stop_reason, "max_tokens");
});

// ---------------------------------------------------------- end to end

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
        for (const c of reply.chunks) res.write(`event: ${String(c.type)}\ndata: ${JSON.stringify(c)}\n\n`);
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

test("end to end: format responses posts to /responses and the reply comes back Anthropic-shaped", async () => {
  const up = await fakeUpstream(() => ({
    json: { id: "resp_1", model: "gpt-5", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "The price is $34." }] }], usage: { input_tokens: 3, output_tokens: 6 } },
  }));
  const spec = translatorSpecFor({ format: "responses", baseUrl: up.base, token: "sk-real", headers: {}, name: "openai" })!;
  assert.equal(spec.wire, "responses");
  const t = await startTranslator(spec);
  try {
    const res = await fetch(`${t.baseUrl}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": t.key },
      body: JSON.stringify({ model: "gpt-5", max_tokens: 50, system: "Be terse.", messages: [{ role: "user", content: "price?" }] }),
    });
    assert.equal(res.status, 200);
    const msg = (await res.json()) as Json;
    assert.deepEqual(msg.content, [{ type: "text", text: "The price is $34." }]);
    assert.equal(up.seen[0].path, "/v1/responses");
    assert.equal(up.seen[0].headers.authorization, "Bearer sk-real");
    assert.equal(up.seen[0].body.instructions, "Be terse.");
    assert.equal(up.seen[0].body.max_output_tokens, 50);
    assert.equal(up.seen[0].body.stream, false);
  } finally {
    await t.close();
    up.close();
  }
  assert.equal(translatorSpecFor({ format: "openai", baseUrl: "x", token: "k", headers: {} })!.wire, "chat");
  assert.equal(translatorSpecFor({ format: "anthropic", baseUrl: "x", token: "k", headers: {} }), null);
});

test("end to end: a streamed Responses tool call arrives as Anthropic SSE with the arguments intact", async () => {
  const up = await fakeUpstream(() => ({
    chunks: [
      { type: "response.created", response: { id: "resp_9", model: "gpt-5" } },
      { type: "response.output_item.added", output_index: 0, item: { type: "function_call", call_id: "call_z", name: "probe_fetch_token", arguments: "" } },
      { type: "response.function_call_arguments.delta", output_index: 0, delta: '{"reas' },
      { type: "response.function_call_arguments.delta", output_index: 0, delta: 'on":"go"}' },
      { type: "response.output_item.done", output_index: 0, item: { type: "function_call", call_id: "call_z", name: "probe_fetch_token", arguments: '{"reason":"go"}' } },
      { type: "response.completed", response: { id: "resp_9", usage: { input_tokens: 20, output_tokens: 8 } } },
    ],
  }));
  const t = await startTranslator({ wire: "responses", upstreamBase: up.base, upstreamKey: "k" });
  try {
    const res = await fetch(`${t.baseUrl}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${t.key}` },
      body: JSON.stringify({ model: "gpt-5", max_tokens: 50, stream: true, messages: [{ role: "user", content: "go" }], tools: [{ name: "probe_fetch_token", input_schema: { type: "object" } }] }),
    });
    assert.equal(res.status, 200);
    const ev = events([await res.text()]);
    const start = ev.find((e) => e.event === "content_block_start" && (e.data.content_block as Json).type === "tool_use")!;
    assert.equal((start.data.content_block as Json).name, "probe_fetch_token");
    const args = ev.filter((e) => e.event === "content_block_delta").map((e) => String((e.data.delta as Json).partial_json)).join("");
    assert.deepEqual(JSON.parse(args), { reason: "go" });
    assert.equal((ev.find((e) => e.event === "message_delta")!.data.delta as Json).stop_reason, "tool_use");
    assert.equal(ev.at(-1)!.event, "message_stop");
    assert.equal(up.seen[0].body.stream, true);
    assert.deepEqual((up.seen[0].body.tools as Json[])[0], { type: "function", name: "probe_fetch_token", parameters: { type: "object" }, strict: false });
  } finally {
    await t.close();
    up.close();
  }
});
