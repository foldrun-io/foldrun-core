// The runtime's own translator: Anthropic Messages in, Chat Completions out.
//
// The Agent SDK speaks one wire format. Most of the providers people bring
// keys for speak another — OpenAI's Chat Completions, which OpenAI, Gemini,
// xAI, Groq, Mistral, Hugging Face, Cloudflare and every local runtime all
// implement. Rather than teach the runtime a second format, or install a
// gateway beside it, this listens on localhost inside the run sandbox,
// presents an Anthropic endpoint to the SDK, and rewrites each request and
// each streamed reply between the two shapes. It exists only for the
// duration of a step, holds only that step's key, and dies with it.
//
// It is deliberately small. It translates what the SDK actually sends — a
// system prompt, text and image blocks, tools with JSON schemas, tool calls
// and their results, streaming — and drops what a Chat-Completions endpoint
// has no word for (cache_control, top_k, server-side tools, thinking on
// endpoints that lack reasoning_effort). Anything dropped is said once in
// the run trace. The translation is pure functions over JSON so the tests
// can drive every mapping without a network; the server around them is a
// few dozen lines.

import http from "node:http";
import crypto from "node:crypto";
import { PROTECTED_PARAMS } from "./providers.ts";

// ------------------------------------------------------------------ shapes

type Json = Record<string, unknown>;

export interface TranslatorSpec {
  /** The provider's Chat-Completions base, e.g. https://api.openai.com/v1 —
   *  `/chat/completions` is appended. */
  upstreamBase: string;
  /** Already resolved. Sent as `Authorization: Bearer`. */
  upstreamKey: string;
  /** Extra headers the provider wants, already resolved. */
  headers?: Record<string, string>;
  maxTokensParam?: "max_tokens" | "max_completion_tokens";
  /** Map Anthropic `thinking:` to OpenAI `reasoning_effort`; off drops it. */
  reasoningEffort?: boolean;
  /** The provider block's `params:` — merged into the outgoing body after
   *  the translation, so a file can set what this format does not model. */
  params?: Record<string, unknown>;
  /** How the endpoint is named in the trace. */
  label?: string;
}

export interface RunningTranslator {
  port: number;
  /** The key the SDK must present — random per translator, so nothing but
   *  this step's SDK process can use the localhost door. */
  key: string;
  baseUrl: string;
  /** The env that points the SDK here. Overrides whatever provider env the
   *  caller assembled: the translator is now the endpoint. */
  env: Record<string, string>;
  /** One line per request, drained by the caller into the run trace. */
  drainLog: () => string[];
  close: () => Promise<void>;
}

interface Dropped {
  add(what: string): void;
  lines(): string[];
}

function dropped(): Dropped {
  const seen = new Set<string>();
  return {
    add: (w) => void seen.add(w),
    lines: () => [...seen].map((w) => `translator: dropped ${w} — the endpoint has no equivalent`),
  };
}

// ------------------------------------------------------- request mapping

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((b) => b && typeof b === "object" && (b as Json).type === "text")
    .map((b) => String((b as Json).text ?? ""))
    .join("\n");
}

function imagePart(block: Json): Json | null {
  const src = block.source as Json | undefined;
  if (!src) return null;
  if (src.type === "base64" && typeof src.data === "string") {
    return { type: "image_url", image_url: { url: `data:${String(src.media_type ?? "image/png")};base64,${src.data}` } };
  }
  if (src.type === "url" && typeof src.url === "string") return { type: "image_url", image_url: { url: src.url } };
  return null;
}

/**
 * An Anthropic Messages request as a Chat Completions request. Pure.
 *
 * Message order matters to the other side: a tool result must directly
 * follow the assistant turn that called the tool. Anthropic puts results
 * inside the next user message, so those blocks become `tool` messages
 * first and whatever else the user said follows as a user message.
 */
export function toChatCompletions(
  req: Json,
  opts: {
    maxTokensParam?: "max_tokens" | "max_completion_tokens";
    reasoningEffort?: boolean;
    stream: boolean;
    /** Merged in last, so the file wins over the translation. */
    params?: Record<string, unknown>;
  },
  drop: Dropped = dropped(),
): Json {
  const out: Json = { model: req.model, stream: opts.stream };
  const messages: Json[] = [];

  const system = textOf(req.system);
  if (system) messages.push({ role: "system", content: system });

  for (const m of (Array.isArray(req.messages) ? req.messages : []) as Json[]) {
    const content = m.content;
    if (m.role === "assistant") {
      const text = textOf(content);
      const toolCalls: Json[] = [];
      for (const b of Array.isArray(content) ? (content as Json[]) : []) {
        if (b.type === "tool_use") {
          toolCalls.push({
            id: String(b.id),
            type: "function",
            function: { name: String(b.name), arguments: JSON.stringify(b.input ?? {}) },
          });
        } else if (b.type === "thinking" || b.type === "redacted_thinking") {
          drop.add("thinking blocks in the transcript");
        }
      }
      const msg: Json = { role: "assistant" };
      if (text) msg.content = text;
      else if (!toolCalls.length) msg.content = "";
      if (toolCalls.length) msg.tool_calls = toolCalls;
      messages.push(msg);
      continue;
    }
    // user
    if (typeof content === "string") {
      messages.push({ role: "user", content });
      continue;
    }
    const parts: Json[] = [];
    for (const b of Array.isArray(content) ? (content as Json[]) : []) {
      if (b.type === "tool_result") {
        const inner = b.content;
        const text = typeof inner === "string" ? inner : textOf(inner);
        messages.push({
          role: "tool",
          tool_call_id: String(b.tool_use_id),
          content: text || (b.is_error ? "error" : "ok"),
        });
        if (Array.isArray(inner) && (inner as Json[]).some((x) => x.type === "image")) drop.add("images inside tool results");
      } else if (b.type === "text") {
        parts.push({ type: "text", text: String(b.text ?? "") });
      } else if (b.type === "image") {
        const p = imagePart(b);
        if (p) parts.push(p);
      } else if (b.type === "document") {
        drop.add("document blocks");
      }
    }
    if (parts.length) {
      // A single text part reads as a plain string on every endpoint;
      // a list is only needed when an image is among them.
      messages.push({
        role: "user",
        content: parts.length === 1 && parts[0].type === "text" ? parts[0].text : parts,
      });
    }
  }
  out.messages = messages;

  const tools: Json[] = [];
  for (const t of (Array.isArray(req.tools) ? req.tools : []) as Json[]) {
    if (t.type && t.type !== "custom") {
      drop.add(`server-side tool ${String(t.type)}`);
      continue;
    }
    tools.push({
      type: "function",
      function: {
        name: String(t.name),
        ...(t.description ? { description: String(t.description) } : {}),
        parameters: t.input_schema ?? { type: "object", properties: {} },
      },
    });
  }
  if (tools.length) out.tools = tools;

  const tc = req.tool_choice as Json | undefined;
  if (tc && tools.length) {
    if (tc.type === "auto") out.tool_choice = "auto";
    else if (tc.type === "any") out.tool_choice = "required";
    else if (tc.type === "none") out.tool_choice = "none";
    else if (tc.type === "tool" && tc.name) out.tool_choice = { type: "function", function: { name: String(tc.name) } };
    if (tc.disable_parallel_tool_use === true) out.parallel_tool_calls = false;
  }

  if (typeof req.max_tokens === "number") out[opts.maxTokensParam ?? "max_tokens"] = req.max_tokens;
  if (typeof req.temperature === "number") out.temperature = req.temperature;
  if (typeof req.top_p === "number") out.top_p = req.top_p;
  if (req.top_k !== undefined) drop.add("top_k");
  if (Array.isArray(req.stop_sequences) && req.stop_sequences.length) out.stop = req.stop_sequences;
  const meta = req.metadata as Json | undefined;
  if (meta && typeof meta.user_id === "string") out.user = meta.user_id;
  if (opts.stream) out.stream_options = { include_usage: true };

  // Thinking: budget → effort where the endpoint has the word, dropped
  // where it does not. `effort` spelled directly is honoured the same way.
  const thinking = req.thinking as Json | undefined;
  const effortWord =
    typeof req.effort === "string" ? req.effort : (req.output_config as Json | undefined)?.effort;
  let effort: string | null = null;
  if (typeof effortWord === "string") effort = { low: "low", medium: "medium", high: "high", xhigh: "high", max: "high" }[effortWord] ?? null;
  else if (thinking && thinking.type === "enabled") {
    const b = Number(thinking.budget_tokens) || 0;
    effort = b <= 2048 ? "low" : b <= 8192 ? "medium" : "high";
  } else if (thinking && thinking.type === "adaptive") effort = "medium";
  if (effort) {
    if (opts.reasoningEffort) out.reasoning_effort = effort;
    else drop.add("thinking / effort");
  }

  // The author's own fields, last, so the file wins over anything decided
  // above — including a `reasoning_effort` they would rather set by hand.
  // `null` removes a field the translation would otherwise have sent, which
  // is the only way to say "do not send temperature at all" to an endpoint
  // that rejects it. Structural keys were dropped at parse time.
  for (const [key, value] of Object.entries(opts.params ?? {})) {
    if ((PROTECTED_PARAMS as readonly string[]).includes(key)) continue;
    if (value === null) delete out[key];
    else out[key] = value;
  }

  return out;
}

// ------------------------------------------------------- response mapping

function stopReason(finish: unknown): string {
  switch (finish) {
    case "tool_calls":
    case "function_call":
      return "tool_use";
    case "length":
      return "max_tokens";
    default:
      return "end_turn";
  }
}

function parseArgs(raw: unknown): unknown {
  if (typeof raw !== "string" || !raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return { _unparsed: raw };
  }
}

/** A finished Chat Completion as an Anthropic message. Pure. */
export function fromChatCompletion(res: Json, requestedModel: string): Json {
  const choice = ((res.choices as Json[] | undefined) ?? [])[0] ?? {};
  const msg = (choice.message as Json | undefined) ?? {};
  const content: Json[] = [];
  const text = typeof msg.content === "string" ? msg.content : textOf(msg.content);
  if (text) content.push({ type: "text", text });
  for (const tc of (Array.isArray(msg.tool_calls) ? msg.tool_calls : []) as Json[]) {
    const fn = (tc.function as Json | undefined) ?? {};
    content.push({
      type: "tool_use",
      id: String(tc.id ?? `call_${crypto.randomBytes(6).toString("hex")}`),
      name: String(fn.name ?? ""),
      input: parseArgs(fn.arguments),
    });
  }
  const usage = (res.usage as Json | undefined) ?? {};
  return {
    id: String(res.id ?? `msg_${crypto.randomBytes(8).toString("hex")}`),
    type: "message",
    role: "assistant",
    model: String(res.model ?? requestedModel),
    content,
    stop_reason: stopReason(choice.finish_reason),
    stop_sequence: null,
    usage: {
      input_tokens: Number(usage.prompt_tokens ?? 0),
      output_tokens: Number(usage.completion_tokens ?? 0),
    },
  };
}

/**
 * The streaming half: Chat-Completions chunks in, Anthropic SSE events out.
 * A state machine because the two streams disagree about structure — one
 * is a flat sequence of deltas, the other is blocks with explicit starts and
 * stops — and a tool call's arguments arrive as fragments that the other
 * side wants as `input_json_delta`s inside one open block.
 */
export class StreamTranslator {
  private started = false;
  private nextIndex = 0;
  private textIndex: number | null = null;
  /** Chat-Completions tool index → Anthropic block index. */
  private tools = new Map<number, { block: number; argsSeen: boolean }>();
  private finish: unknown = null;
  private usage: { input: number; output: number } | null = null;
  private id = `msg_${crypto.randomBytes(8).toString("hex")}`;
  private readonly model: string;
  constructor(model: string) {
    this.model = model;
  }

  private event(name: string, data: Json): string {
    return `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
  }

  private start(chunk: Json): string[] {
    if (this.started) return [];
    this.started = true;
    if (typeof chunk.id === "string") this.id = chunk.id;
    return [
      this.event("message_start", {
        type: "message_start",
        message: {
          id: this.id,
          type: "message",
          role: "assistant",
          model: String(chunk.model ?? this.model),
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      }),
    ];
  }

  private closeText(): string[] {
    if (this.textIndex === null) return [];
    const i = this.textIndex;
    this.textIndex = null;
    return [this.event("content_block_stop", { type: "content_block_stop", index: i })];
  }

  /** One parsed chunk in, zero or more SSE events out. */
  feed(chunk: Json): string[] {
    const out = this.start(chunk);
    const u = chunk.usage as Json | undefined;
    if (u && (u.prompt_tokens !== undefined || u.completion_tokens !== undefined)) {
      this.usage = { input: Number(u.prompt_tokens ?? 0), output: Number(u.completion_tokens ?? 0) };
    }
    const choice = ((chunk.choices as Json[] | undefined) ?? [])[0];
    if (!choice) return out;
    if (choice.finish_reason) this.finish = choice.finish_reason;
    const delta = (choice.delta as Json | undefined) ?? {};

    const text = typeof delta.content === "string" ? delta.content : "";
    if (text) {
      if (this.textIndex === null) {
        this.textIndex = this.nextIndex++;
        out.push(
          this.event("content_block_start", {
            type: "content_block_start",
            index: this.textIndex,
            content_block: { type: "text", text: "" },
          }),
        );
      }
      out.push(
        this.event("content_block_delta", {
          type: "content_block_delta",
          index: this.textIndex,
          delta: { type: "text_delta", text },
        }),
      );
    }

    for (const [n, tc] of ((Array.isArray(delta.tool_calls) ? delta.tool_calls : []) as Json[]).entries()) {
      const idx = typeof tc.index === "number" ? tc.index : this.tools.size + n;
      const fn = (tc.function as Json | undefined) ?? {};
      let entry = this.tools.get(idx);
      if (!entry) {
        // A new call: text stops here (a block is one thing), the tool
        // block opens with the id and name the first fragment carries.
        out.push(...this.closeText());
        entry = { block: this.nextIndex++, argsSeen: false };
        this.tools.set(idx, entry);
        out.push(
          this.event("content_block_start", {
            type: "content_block_start",
            index: entry.block,
            content_block: {
              type: "tool_use",
              id: String(tc.id ?? `call_${crypto.randomBytes(6).toString("hex")}`),
              name: String(fn.name ?? ""),
              input: {},
            },
          }),
        );
      }
      const args = typeof fn.arguments === "string" ? fn.arguments : "";
      if (args) {
        entry.argsSeen = true;
        out.push(
          this.event("content_block_delta", {
            type: "content_block_delta",
            index: entry.block,
            delta: { type: "input_json_delta", partial_json: args },
          }),
        );
      }
    }
    return out;
  }

  /** The stream ended: close what is open, say why, and stop. */
  finishStream(): string[] {
    const out = this.start({});
    out.push(...this.closeText());
    for (const entry of this.tools.values()) {
      // Anthropic expects the concatenated partial_json to parse; a call
      // that streamed no arguments at all needs an explicit empty object.
      if (!entry.argsSeen) {
        out.push(
          this.event("content_block_delta", {
            type: "content_block_delta",
            index: entry.block,
            delta: { type: "input_json_delta", partial_json: "{}" },
          }),
        );
      }
      out.push(this.event("content_block_stop", { type: "content_block_stop", index: entry.block }));
    }
    const reason = this.tools.size && this.finish !== "length" ? "tool_use" : stopReason(this.finish);
    out.push(
      this.event("message_delta", {
        type: "message_delta",
        delta: { stop_reason: reason, stop_sequence: null },
        usage: { input_tokens: this.usage?.input ?? 0, output_tokens: this.usage?.output ?? 0 },
      }),
    );
    out.push(this.event("message_stop", { type: "message_stop" }));
    return out;
  }
}

// ---------------------------------------------------------------- errors

function errorType(status: number): string {
  if (status === 400) return "invalid_request_error";
  if (status === 401) return "authentication_error";
  if (status === 403) return "permission_error";
  if (status === 404) return "not_found_error";
  if (status === 429) return "rate_limit_error";
  if (status === 529) return "overloaded_error";
  return "api_error";
}

function errorBody(status: number, message: string): string {
  return JSON.stringify({ type: "error", error: { type: errorType(status), message } });
}

/** The provider's own words for what went wrong, whatever shape it used. */
function upstreamMessage(text: string, status: number): string {
  try {
    const parsed = JSON.parse(text) as Json;
    const err = parsed.error as Json | string | undefined;
    if (typeof err === "string") return err;
    if (err && typeof err.message === "string") return err.message;
    if (typeof parsed.message === "string") return parsed.message;
  } catch {
    // not JSON — the text is the message
  }
  return text.slice(0, 500) || `upstream returned HTTP ${status}`;
}

// ---------------------------------------------------------------- server

/**
 * Start the translator for one step. Binds an ephemeral port on loopback,
 * mints the key the SDK will present, and returns the env that points the
 * SDK at it. Close it when the step is over.
 */
export async function startTranslator(spec: TranslatorSpec): Promise<RunningTranslator> {
  const key = `fr-${crypto.randomBytes(16).toString("hex")}`;
  const log: string[] = [];
  const base = spec.upstreamBase.replace(/\/+$/, "");
  const label = spec.label ?? base;

  const server = http.createServer(async (req, res) => {
    const started = Date.now();
    const send = (status: number, body: string, type = "application/json") => {
      res.writeHead(status, { "content-type": type });
      res.end(body);
    };
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const presented = req.headers["x-api-key"] ?? (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
      const ok = typeof presented === "string" && presented.length === key.length && crypto.timingSafeEqual(Buffer.from(presented), Buffer.from(key));
      if (!ok) return send(401, errorBody(401, "translator: wrong key for this step"));

      const raw = await new Promise<string>((resolve, reject) => {
        let body = "";
        req.on("data", (c: Buffer) => (body += c.toString()));
        req.on("end", () => resolve(body));
        req.on("error", reject);
      });

      if (req.method === "POST" && url.pathname === "/v1/messages/count_tokens") {
        // No endpoint on the other side counts for us; four characters a
        // token is the estimate every tokenizer lands near for English.
        const chars = raw.length;
        return send(200, JSON.stringify({ input_tokens: Math.ceil(chars / 4) }));
      }
      if (req.method !== "POST" || url.pathname !== "/v1/messages") {
        return send(404, errorBody(404, `translator: no ${req.method} ${url.pathname} — only POST /v1/messages`));
      }

      let body: Json;
      try {
        body = JSON.parse(raw) as Json;
      } catch {
        return send(400, errorBody(400, "translator: request body is not JSON"));
      }
      const stream = body.stream === true;
      const drop = dropped();
      const chat = toChatCompletions(body, { maxTokensParam: spec.maxTokensParam, reasoningEffort: spec.reasoningEffort, params: spec.params, stream }, drop);
      for (const line of drop.lines()) if (!log.includes(line)) log.push(line);

      let upstream: Response;
      try {
        upstream = await fetch(`${base}/chat/completions`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${spec.upstreamKey}`,
            ...(spec.headers ?? {}),
          },
          body: JSON.stringify(chat),
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.push(`POST ${label} → unreachable: ${message}`);
        return send(502, errorBody(502, `translator: could not reach ${label}: ${message}`));
      }

      if (!upstream.ok) {
        const text = await upstream.text();
        const message = upstreamMessage(text, upstream.status);
        log.push(`POST ${label} → ${upstream.status} (${Date.now() - started}ms): ${message.slice(0, 160)}`);
        // The status crosses unchanged, so a 401 or 429 from the provider
        // reads as one to the SDK — and to the fallback decision upstream.
        return send(upstream.status, errorBody(upstream.status, message));
      }

      const model = String(body.model ?? "");
      if (!stream) {
        const text = await upstream.text();
        let parsed: Json;
        try {
          parsed = JSON.parse(text) as Json;
        } catch {
          return send(502, errorBody(502, `translator: ${label} answered with something that is not JSON`));
        }
        log.push(`POST ${label} → 200 (${Date.now() - started}ms, ${model})`);
        return send(200, JSON.stringify(fromChatCompletion(parsed, model)));
      }

      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      const machine = new StreamTranslator(model);
      const reader = upstream.body?.getReader();
      if (!reader) {
        for (const e of machine.finishStream()) res.write(e);
        return res.end();
      }
      const decoder = new TextDecoder();
      let buffer = "";
      let chunks = 0;
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (!line.startsWith("data:")) continue;
          const data = line.slice(5).trim();
          if (data === "[DONE]") continue;
          try {
            chunks++;
            for (const e of machine.feed(JSON.parse(data) as Json)) res.write(e);
          } catch {
            // a malformed chunk is skipped, not fatal — the stream goes on
          }
        }
      }
      for (const e of machine.finishStream()) res.write(e);
      res.end();
      log.push(`POST ${label} → 200 (stream, ${chunks} chunks, ${Date.now() - started}ms, ${model})`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.push(`translator error: ${message}`);
      if (!res.headersSent) send(500, errorBody(500, `translator: ${message}`));
      else res.end();
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  const baseUrl = `http://127.0.0.1:${port}`;

  return {
    port,
    key,
    baseUrl,
    env: {
      ANTHROPIC_BASE_URL: baseUrl,
      // The SDK sends ANTHROPIC_API_KEY as x-api-key, which is what the
      // server above checks; the bearer slot is blanked so the SDK cannot
      // fall back to Anthropic's own endpoint with a stale credential.
      ANTHROPIC_API_KEY: key,
      ANTHROPIC_AUTH_TOKEN: "",
      CLAUDE_CODE_OAUTH_TOKEN: "",
    },
    drainLog: () => log.splice(0, log.length),
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

/**
 * What a provider block needs from the translator, or null when the block
 * speaks Anthropic and needs none. Values only — this crosses into the run
 * container as JSON.
 */
export function translatorSpecFor(spec: {
  format: string;
  baseUrl: string;
  token: string;
  headers: Record<string, string>;
  params?: Record<string, unknown>;
  name?: string | null;
  maxTokensParam?: "max_tokens" | "max_completion_tokens";
  reasoningEffort?: boolean;
}): TranslatorSpec | null {
  if (spec.format !== "openai") return null;
  return {
    upstreamBase: spec.baseUrl,
    upstreamKey: spec.token,
    headers: spec.headers,
    params: spec.params,
    maxTokensParam: spec.maxTokensParam,
    reasoningEffort: spec.reasoningEffort,
    label: spec.name ? `${spec.name} (${spec.baseUrl})` : spec.baseUrl,
  };
}
