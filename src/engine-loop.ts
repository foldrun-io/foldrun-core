// foldrun's own agent loop: a model, its tools, and the turns between them.
//
// Until now every step's turns ran inside the Claude Agent SDK's `query()`,
// which starts the Claude Code binary. This is the same job done here: call
// the model, run the tools it asks for, hand back the results, repeat until
// it answers. It is a QueryFn (step-exec.ts), so executeStep drives it
// exactly as it drives the SDK — the same options in, the same messages out
// — and everything above the loop (hooks, limits, confinement, verify, the
// run record) is unchanged.
//
// It is NOT the default, and nothing a tenant writes can select it: the
// caller of executeStep passes `engine: "foldrun"` (ExecOptions), and no
// caller in the runner does yet. Deliberately not an environment variable —
// a step's environment carries its secrets under names the tenant chose
// (runner.ts), so a secret called after the switch would have thrown it.
// It moves to a written setting, and then to the default, only when it
// matches the SDK on the coding evals (foldrun-infra
// docs/coding-api-adr.md, "Build order").
//
// What this first slice does:
//   - the turns, against an Anthropic-format Messages endpoint — the step's
//     ANTHROPIC_BASE_URL, which is also what the translator (translator.ts)
//     presents for every other provider;
//   - Read, Write, Edit, Glob, Grep and Bash (engine-tools.ts);
//   - the permission order the SDK kept: PreToolUse hooks, then canUseTool
//     unless a hook allowed the call, then the tool, then PostToolUse;
//   - prompt-cache marks on the system prompt, the tools and the newest turn;
//   - interrupt and abort, which also end a running shell command.
//
// What it refuses, by name, rather than run without: MCP servers (so every
// tool that is not one of the six), sub-agents, and a shell on a host that
// asked for the SDK's OS sandbox, which this engine does not have (the
// caller may say `engineHostShell` for a person's own machine). It does
// not summarise a full context yet: the model's own stop reason comes back
// on the result, as it does from the SDK.

import crypto from "node:crypto";
import type { QueryFn, QueryLike } from "./step-exec.ts";
import { killGroups, type EngineTool, type ToolContext, type ToolOutcome } from "./engine-tools.ts";
import { connectMcp, type McpConnection } from "./engine-mcp.ts";
import { SUMMARIZATION_SYSTEM_PROMPT, compacted, cutPoints, estimateTokens, fileLists, findCut, isContextOverflow, previousSummary, summaryRequest } from "./engine-compact.ts";
import { DEFAULT_MAX_TOKENS, readOptions, decide, after, emptyUsage, addUsage, type Json, type Block, type LoopOptions, type Decision, type Usage } from "./engine-common.ts";

/** Which loop runs a step's turns. */
export type Engine = "sdk" | "foldrun";

const DEFAULT_BASE = "https://api.anthropic.com";
const API_VERSION = "2023-06-01";
const MODEL_TRIES = 4;
const RETRY_AFTER_CAP_MS = 30_000;

function requestHeaders(env: Record<string, string | undefined>): Record<string, string> {
  const headers: Record<string, string> = { "content-type": "application/json", "anthropic-version": API_VERSION };
  if (env.ANTHROPIC_API_KEY) headers["x-api-key"] = env.ANTHROPIC_API_KEY;
  else if (env.ANTHROPIC_AUTH_TOKEN) headers.authorization = `Bearer ${env.ANTHROPIC_AUTH_TOKEN}`;
  for (const line of (env.ANTHROPIC_CUSTOM_HEADERS ?? "").split("\n")) {
    const at = line.indexOf(":");
    if (at > 0) headers[line.slice(0, at).trim().toLowerCase()] = line.slice(at + 1).trim();
  }
  return headers;
}

/** The request body for one turn. Cache marks go on the three places a
 *  prefix ends: the tools, the system prompt, and the newest message — so
 *  each turn reads everything before it from the cache and writes only
 *  what is new. The conversation itself is never mutated. */
/** What a turn that asks for no tool comes to. Only a reply the model ended
 *  itself (`end_turn`, `stop_sequence`) finishes the step. Until 22 Nov 2026
 *  every such turn was "success" — a reply cut off at the output limit
 *  included, so a half-written answer passed as a finished step (FOL-211).
 *  The partial reply is still the result's text; `errors` says why it is not
 *  a finish, the way the SDK's error results do. */
/** What this engine can do that a caller may ask about before relying on
 *  it: `steer` — messages sent while a turn runs (FOL-213). */
export const ENGINE_FEATURES = { steer: true } as const;

export function endOf(stopReason: string | null, calls: number): { subtype: string; error?: string } {
  switch (stopReason) {
    case "end_turn":
    case "stop_sequence":
      return { subtype: "success" };
    case "max_tokens":
      return { subtype: "error_max_output", error: "the reply was cut off at the output limit (max_output_tokens: in the flow file raises it) — the step did not finish" };
    case "refusal":
      return { subtype: "error_refusal", error: "the model declined to answer (stop reason: refusal) — the step did not finish" };
    case "model_context_window_exceeded":
      return { subtype: "error_context_full", error: "the conversation filled the model's context window — the step did not finish" };
    case "tool_use":
      if (!calls) return { subtype: "error_empty_tool_turn", error: "the model said it would call a tool and sent none — the step did not finish" };
      return { subtype: "success" };
    default:
      return { subtype: "error_unknown_stop", error: `the model stopped for a reason this engine does not know (${stopReason ?? "none given"}) — the step did not finish` };
  }
}

export function buildRequest(o: Pick<LoopOptions, "model" | "systemPrompt" | "tools" | "env">, messages: { role: string; content: Block[] }[], cache = true, maxTokens?: number): Json {
  // A one-off request (a summary) writes nothing to the cache.
  const mark = cache ? { cache_control: { type: "ephemeral" } } : {};
  const tools = o.tools.map((t, i) => ({
    name: t.name,
    description: t.description,
    input_schema: t.input_schema,
    ...(i === o.tools.length - 1 ? mark : {}),
  }));
  const sent = messages.map((m, i) => {
    if (i !== messages.length - 1 || !m.content.length) return m;
    const last = m.content.length - 1;
    return { ...m, content: m.content.map((b, j) => (j === last ? { ...b, ...mark } : b)) };
  });
  const asked = Number(o.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS);
  return {
    model: o.model,
    max_tokens: Math.min(maxTokens ?? Infinity, Number.isFinite(asked) && asked > 0 ? asked : DEFAULT_MAX_TOKENS),
    ...(o.systemPrompt ? { system: [{ type: "text", text: o.systemPrompt, ...mark }] } : {}),
    ...(tools.length ? { tools } : {}),
    messages: sent,
    stream: true,
  };
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    const t = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => { clearTimeout(t); resolve(); }, { once: true });
  });

/** POST the turn, retrying what is worth retrying: a rate limit, an
 *  overloaded or failing upstream, a connection that never opened. Nothing
 *  is retried once a response has begun — the caller has seen part of it. */
async function openStream(o: LoopOptions, body: Json, signal: AbortSignal): Promise<Response> {
  const base = (o.env.ANTHROPIC_BASE_URL || DEFAULT_BASE).replace(/\/+$/, "");
  let lastError = "";
  for (let attempt = 1; attempt <= MODEL_TRIES; attempt++) {
    let res: Response | null = null;
    try {
      res = await fetch(`${base}/v1/messages`, { method: "POST", headers: requestHeaders(o.env), body: JSON.stringify(body), signal });
    } catch (err) {
      if (signal.aborted) throw err;
      lastError = `the model endpoint could not be reached: ${(err as Error).message}`;
    }
    if (res?.ok && res.body) return res;
    if (res) {
      const text = (await res.text().catch(() => "")).slice(0, 500);
      lastError = `the model endpoint answered ${res.status}: ${text}`;
      const retryable = res.status === 408 || res.status === 409 || res.status === 429 || res.status >= 500;
      if (!retryable) throw Object.assign(new Error(lastError), { status: res.status });
      const after = Number(res.headers.get("retry-after"));
      if (attempt < MODEL_TRIES) await sleep(Math.min(RETRY_AFTER_CAP_MS, Number.isFinite(after) && after > 0 ? after * 1000 : 1000 * 2 ** (attempt - 1)), signal);
    } else if (attempt < MODEL_TRIES) {
      await sleep(1000 * 2 ** (attempt - 1), signal);
    }
    if (signal.aborted) throw new Error("aborted");
  }
  throw new Error(`${lastError} (after ${MODEL_TRIES} tries)`);
}

/** Server-sent events from a response body, one parsed `data:` at a time. */
async function* sse(res: Response): AsyncGenerator<Json> {
  const decoder = new TextDecoder();
  let buffer = "";
  // SSE ends a line with CRLF, LF or a bare CR (WHATWG). Every one becomes
  // LF here; a CR at the end of a chunk waits for the next, in case it is
  // the first half of a CRLF split across them.
  let held = "";
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    let text = held + decoder.decode(chunk, { stream: true });
    held = text.endsWith("\r") ? "\r" : "";
    if (held) text = text.slice(0, -1);
    buffer += text.replace(/\r\n?/g, "\n");
    for (let at = buffer.indexOf("\n\n"); at >= 0; at = buffer.indexOf("\n\n")) {
      const frame = buffer.slice(0, at);
      buffer = buffer.slice(at + 2);
      const data = frame.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).replace(/^ /, "")).join("\n");
      if (!data || data === "[DONE]") continue;
      let parsed: Json;
      try {
        parsed = JSON.parse(data) as Json;
      } catch {
        // A frame that is not JSON may be a lost piece of the reply: a reply
        // missing words would otherwise pass as whole (Codex, 22 Nov 2026).
        throw new Error("the model stream sent a frame that is not JSON — the reply cannot be trusted whole");
      }
      yield parsed;
    }
  }
}

interface Turn {
  id: string;
  model: string;
  content: Block[];
  stopReason: string | null;
  usage: Usage;
  /** tool_use ids whose arguments did not arrive as valid JSON. */
  malformed: Set<string>;
}

/** One model call: yields the raw stream events, returns the whole turn. */
async function* modelTurn(o: LoopOptions, messages: { role: string; content: Block[] }[], signal: AbortSignal, cache = true, maxTokens?: number, track?: { turn?: Turn }): AsyncGenerator<Json, Turn> {
  const res = await openStream(o, buildRequest(o, messages, cache, maxTokens), signal);
  const turn: Turn = { id: "", model: o.model, content: [], stopReason: null, usage: emptyUsage(), malformed: new Set() };
  // A caller that must count what a stream that breaks part-way had
  // already reported (a summary request) reads it here.
  if (track) track.turn = turn;
  const partialJson = new Map<number, string>();
  const open = new Set<number>();
  let stopped = false;
  for await (const ev of sse(res)) {
    const type = ev.type as string;
    if (type === "error") {
      const e = ev.error as { type?: string; message?: string } | undefined;
      throw new Error(`the model stream failed: ${e?.type ?? "error"}${e?.message ? ` — ${e.message}` : ""}`);
    }
    if (type === "message_start") {
      const m = ev.message as { id?: string; model?: string; usage?: Json } | undefined;
      turn.id = m?.id ?? `msg_${crypto.randomUUID()}`;
      if (m?.model) turn.model = m.model;
      addUsage(turn.usage, m?.usage);
    } else if (type === "content_block_start") {
      const block = { ...(ev.content_block as Block) };
      if (block.type === "tool_use") block.input = {};
      turn.content[ev.index as number] = block;
      open.add(ev.index as number);
    } else if (type === "content_block_delta") {
      const block = turn.content[ev.index as number];
      const d = ev.delta as { type?: string; text?: string; partial_json?: string; thinking?: string; signature?: string } | undefined;
      if (!block || !d) continue;
      if (d.type === "text_delta") block.text = String(block.text ?? "") + (d.text ?? "");
      else if (d.type === "input_json_delta") partialJson.set(ev.index as number, (partialJson.get(ev.index as number) ?? "") + (d.partial_json ?? ""));
      else if (d.type === "thinking_delta") block.thinking = String(block.thinking ?? "") + (d.thinking ?? "");
      else if (d.type === "signature_delta") block.signature = d.signature;
    } else if (type === "content_block_stop") {
      open.delete(ev.index as number);
      const block = turn.content[ev.index as number];
      if (block?.type === "tool_use") {
        const raw = partialJson.get(ev.index as number) ?? "";
        try {
          const parsed: unknown = raw ? JSON.parse(raw) : {};
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) block.input = parsed;
          else turn.malformed.add(String(block.id));
        } catch {
          turn.malformed.add(String(block.id));
        }
      }
    } else if (type === "message_delta") {
      const d = ev.delta as { stop_reason?: string | null } | undefined;
      if (d?.stop_reason) turn.stopReason = d.stop_reason;
      addUsage(turn.usage, ev.usage as Json | undefined);
    } else if (type === "message_stop") stopped = true;
    if (o.partial || type === "message_start" || type === "message_delta") yield ev;
  }
  if (!turn.id) throw new Error("the model stream ended before it began a message");
  // A stream that just stops is not an answer: half a reply must not read
  // as the model's last word, nor half a tool call as none.
  if (!stopped || open.size || !turn.stopReason) throw new Error("the model stream ended part-way through a reply — the connection to the model was cut");
  turn.content = turn.content.filter(Boolean);
  return turn;
}

async function* run(prompt: string, o: LoopOptions, signal: AbortSignal, interrupted: () => boolean): AsyncGenerator<Json> {
  const sessionId = crypto.randomUUID();
  const startedAt = Date.now();
  const byName = new Map(o.tools.map((t) => [t.name, t]));
  /** What the person sent meanwhile, as text blocks: each a string with
   *  words in it, held to a sane size; anything else is dropped. */
  // Taken only when the model will get it: not once the turn is stopped,
  // nor when no request is left under maxTurns (Codex) — it stays with the
  // caller, unsent.
  const steered = (): Block[] => {
    if (!o.steer || interrupted() || signal.aborted || (o.maxTurns !== null && turns >= o.maxTurns)) return [];
    const taken = o.steer();
    return (Array.isArray(taken) ? taken : [])
      .filter((t): t is string => typeof t === "string" && t.trim() !== "")
      .map((t) => ({ type: "text", text: t.slice(0, 20_000) }));
  };
  const ctx: ToolContext = { cwd: o.cwd, env: o.shellEnv, signal, reads: new Map(), groups: new Set(), sandbox: o.localSandbox };
  // Inside the walls, what a command left running (a server in the
  // background) holds the rules it started under: when a later launch finds
  // them changed, it is ended before that launch goes ahead.
  const unwatch = o.localSandbox?.onChange?.(() => killGroups(ctx));
  // An earlier conversation comes first (foldrun code's local turns carry
  // theirs, 19 Nov 2026); the prompt is always the newest user turn.
  if (o.history.length % 2 !== 0) throw new Error("history must end with the model's turn, so the prompt is the next user turn");
  const messages: { role: string; content: Block[] }[] = [...o.history, { role: "user", content: [{ type: "text", text: prompt }] }];
  const total = emptyUsage();
  let turns = 0;
  let lastText = "";

  const result = (subtype: string, stopReason: string | null): Json => ({
    type: "result",
    subtype,
    is_error: subtype !== "success",
    result: lastText,
    stop_reason: stopReason,
    num_turns: turns,
    duration_ms: Date.now() - startedAt,
    usage: { ...total },
    permission_denials: [],
    session_id: sessionId,
  });

  // The step's MCP servers, connected before the first model call: their
  // tools sit after the built-in and host ones (engine-mcp.ts). One that
  // does not start refuses the step here, before anything is paid for.
  let mcp: McpConnection | null = null;
  try {
  if (Object.keys(o.mcpServers).length) {
    mcp = await connectMcp(o.mcpServers, { env: o.env, toolEnv: o.shellEnv, cwd: o.cwd, signal, sandbox: o.localSandbox });
    for (const t of mcp.tools) {
      if (byName.has(t.name)) throw new Error(`the MCP tool ${t.name} has the name of a tool the step already has`);
      byName.set(t.name, t);
    }
    o.tools = [...o.tools, ...mcp.tools];
    if (mcp.instructions.length) {
      o.systemPrompt = [o.systemPrompt, "# MCP Server Instructions", ...mcp.instructions.map((i) => `## ${i.server}\n${i.text}`)].filter(Boolean).join("\n\n");
    }
  }
  // A tool the step was granted that its server does not offer: the step
  // would run without it, and the model be told it has none.
  const missing = o.mcpGranted.filter((g) => mcp?.owner.get(g.name) !== g.server).map((g) => g.name);
  if (missing.length) throw new Error(`granted but not offered by its MCP server: ${missing.join(", ")}`);

  yield { type: "system", subtype: "init", session_id: sessionId, cwd: o.cwd, model: o.model, tools: o.tools.map((t) => t.name), mcp_servers: mcp?.servers ?? [], engine: "foldrun" };

  // ---- Compaction (engine-compact.ts). What the context holds is the last
  // turn's own count (everything it was sent, and its reply) plus an
  // estimate of what has been added since; before any turn, an estimate of
  // it all.
  let measured: { tokens: number; at: number } | null = null;
  const filesRead = new Set<string>();
  const filesChanged = new Set<string>();
  let autoCompaction = o.compaction !== false;
  const contextNow = (): number => {
    if (measured) return measured.tokens + messages.slice(measured.at).reduce((n, m) => n + estimateTokens(m), 0);
    const fixed = Math.ceil((o.systemPrompt.length + JSON.stringify(o.tools.map((t) => [t.name, t.description, t.input_schema])).length) / 4);
    return fixed + messages.reduce((n, m) => n + estimateTokens(m), 0);
  };
  /** Summarise the older part and go on from the summary and the newest
   *  part. False, with the reason, when there is nothing to cut or the
   *  summary did not come back whole. */
  // `asked`: a summary was asked for (and paid for) and did not come back.
  async function* compactNow(trigger: "auto" | "overflow", before: number): AsyncGenerator<Json, { ok: boolean; asked?: boolean; why?: string }> {
    if (o.compaction === false) return { ok: false, why: "compaction is off" };
    const room = o.compaction.contextWindow - o.compaction.reserveTokens;
    // The kept part leaves room for the summary (a few thousand tokens).
    // After an overflow the real window is smaller than assumed: the kept
    // part is held to the keep budget itself.
    let cut = findCut(messages, o.compaction.keepRecentTokens, trigger === "overflow" ? o.compaction.keepRecentTokens : Math.max(0, room - 4_096));
    if (cut < 1) return { ok: false, why: "there was nothing older to summarise" };
    // A summary of a few words makes no room and is not worth paying for:
    // a later cut is tried (the newest message is always kept).
    const older = (c: number) => messages.slice(0, c).reduce((n, m) => n + estimateTokens(m), 0);
    for (const later of cutPoints(messages)) if (later > cut && older(cut) < 1_024) cut = later;
    if (older(cut) < 1_024) return { ok: false, why: "there was too little older to summarise" };
    const ask = { ...o, systemPrompt: SUMMARIZATION_SYSTEM_PROMPT, tools: [], partial: false };
    // The request itself must fit: the conversation's text is held to the
    // window less the reply's reserve and the prompts, newest part kept.
    const request = [{ role: "user", content: [{ type: "text", text: summaryRequest(messages.slice(0, cut), previousSummary(messages), Math.max(4_000, (room - 3_000) * 4)) }] }];
    let reply: Turn;
    const track: { turn?: Turn } = {};
    try {
      // Its reply is held to the window's reserve: input and output must fit.
      const stream = modelTurn(ask, request, signal, false, o.compaction.reserveTokens, track);
      for (;;) {
        const step = await stream.next();
        if (step.done) { reply = step.value; break; }
      }
    } catch (err) {
      // What the endpoint had counted before the stream broke was paid for.
      const spent = track.turn?.usage;
      if (spent && Object.values(spent).some((n) => n > 0)) {
        for (const k of Object.keys(total) as (keyof Usage)[]) total[k] += spent[k];
        yield { type: "system", subtype: "compact_failed", session_id: sessionId, error: `the summary request failed: ${(err as Error).message}`, model: track.turn!.model, usage: { ...spent } };
      }
      if (signal.aborted) throw err;
      return { ok: false, asked: true, why: `the summary request failed: ${(err as Error).message}` };
    }
    // Paid for like any turn: in the total, and reported with what it
    // came to so the step's cost and budget count it (step-exec).
    for (const k of Object.keys(total) as (keyof Usage)[]) total[k] += reply.usage[k];
    const summary = reply.content.filter((b) => b.type === "text").map((b) => String(b.text ?? "")).join("\n").trim();
    if (reply.stopReason !== "end_turn" || reply.content.some((b) => b.type === "tool_use") || !summary) {
      const why = `the summary did not come back whole (stop reason ${reply.stopReason ?? "none"})`;
      yield { type: "system", subtype: "compact_failed", session_id: sessionId, error: why, model: reply.model, usage: { ...reply.usage } };
      return { ok: false, asked: true, why };
    }
    const next = compacted(summary + fileLists(filesRead, filesChanged), messages.slice(cut));
    messages.splice(0, messages.length, ...next);
    measured = null;
    yield {
      type: "system",
      subtype: "compact_boundary",
      session_id: sessionId,
      compact_metadata: { trigger, pre_tokens: before, post_tokens: contextNow(), summarized_messages: cut },
      model: reply.model,
      usage: { ...reply.usage },
      // The conversation as it now stands, so a caller that keeps one
      // (foldrun code) goes on from it rather than the whole history.
      conversation: messages.map((m) => ({ role: m.role, content: [...m.content] })),
    };
    return { ok: true };
  }

  // Set when a request was refused as too long and compacted: the same
  // request is asked again once, not compacted again and again.
  let overflowed = false;
  for (;;) {
    if (o.maxTurns !== null && turns >= o.maxTurns) {
      yield result("error_max_turns", null);
      return;
    }
    // Not on the retry after an overflow (that request is asked again as
    // compacted), and not while the model's own turn is being continued
    // (pause_turn): the conversation must end on a user turn to be cut.
    if (autoCompaction && !overflowed && o.compaction !== false && messages.at(-1)?.role === "user") {
      const now = contextNow();
      if (now > o.compaction.contextWindow - o.compaction.reserveTokens) {
        let done: { ok: boolean; asked?: boolean; why?: string };
        try {
          done = yield* compactNow("auto", now);
        } catch (err) {
          if (interrupted() || signal.aborted) return;
          throw err;
        }
        if (interrupted() || signal.aborted) return;
        // A summary asked for and not given is not asked for again before
        // every turn after: the request goes as it is, and the endpoint says
        // if it is too long. Nothing to cut yet costs nothing: looked at
        // again next turn.
        if (!done.ok && done.asked) autoCompaction = false;
        // A summary that could not bring the context under the line will
        // not by summarising again before every turn.
        if (done.ok && contextNow() > o.compaction.contextWindow - o.compaction.reserveTokens) autoCompaction = false;
      }
    }
    let turn: Turn;
    try {
      const stream = modelTurn(o, messages, signal);
      for (;;) {
        const step = await stream.next();
        if (step.done) {
          turn = step.value;
          break;
        }
        yield { type: "stream_event", event: step.value, parent_tool_use_id: null, session_id: sessionId };
      }
    } catch (err) {
      // An interrupt we were asked for ends the loop quietly: the caller
      // knows why and reports it. Anything else is the step's failure.
      if (interrupted() || signal.aborted) return;
      // The endpoint said the prompt does not fit (a model with a smaller
      // window than assumed): compact and ask again — once per request.
      if (!overflowed && o.compaction !== false && messages.at(-1)?.role === "user" && isContextOverflow((err as { status?: number }).status, (err as Error).message)) {
        overflowed = true;
        const done = yield* compactNow("overflow", contextNow());
        if (interrupted() || signal.aborted) return;
        if (!done.ok) throw new Error(`${(err as Error).message} — and the conversation could not be compacted: ${done.why}`);
        continue;
      }
      throw err;
    }
    turns++;
    overflowed = false;
    for (const k of Object.keys(total) as (keyof Usage)[]) total[k] += turn.usage[k];
    const text = turn.content.filter((b) => b.type === "text").map((b) => String(b.text ?? "")).join("\n").trim();
    if (text) lastText = text;
    yield {
      type: "assistant",
      message: { id: turn.id, type: "message", role: "assistant", model: turn.model, content: turn.content, stop_reason: turn.stopReason, usage: { ...turn.usage } },
      parent_tool_use_id: null,
      session_id: sessionId,
    };
    // A paused turn's continuation is the same turn: joined to it, so the
    // conversation still alternates (what foldrun code keeps, and a cut).
    const prev = messages[messages.length - 1];
    if (prev?.role === "assistant") prev.content = [...prev.content, ...turn.content];
    else messages.push({ role: "assistant", content: turn.content });
    // The turn's own count: all it was sent, and its reply.
    measured = { tokens: turn.usage.input_tokens + turn.usage.cache_read_input_tokens + turn.usage.cache_creation_input_tokens + turn.usage.output_tokens, at: messages.length };
    if (interrupted()) return;

    const calls = turn.content.filter((b) => b.type === "tool_use");
    // `pause_turn`: the provider stopped a long turn part-way; sending the
    // conversation back as it stands lets it carry on.
    if (turn.stopReason === "pause_turn" && !calls.length) continue;
    if (turn.stopReason !== "tool_use" || !calls.length) {
      const end = endOf(turn.stopReason, calls.length);
      // About to finish with a message from the person waiting: it is the
      // next user turn, and the model goes on. Not after a turn that failed
      // (it stays with the caller, unsent).
      if (end.subtype === "success") {
        const more = steered();
        if (more.length) {
          // A new question: the answer to come is its own, not this one (Codex).
          lastText = "";
          messages.push({ role: "user", content: more });
          yield { type: "user", message: { role: "user", content: more }, parent_tool_use_id: null, session_id: sessionId };
          continue;
        }
      }
      // A turn that did not finish carries ITS text, empty included — not an
      // earlier turn's "I'll check" passed off as a refusal's words (Codex).
      yield end.error ? { ...result(end.subtype, turn.stopReason), result: text, errors: [end.error] } : result(end.subtype, turn.stopReason);
      return;
    }

    // What each call comes to: refused, or run. A call is decided
    // immediately before it runs, never ahead of a call that runs first: a
    // command can change what a later path points at (a link it makes, a
    // file it moves), and a check made before that would be a check of
    // something else.
    type Planned = { block: Block; tool: EngineTool | null; decision: Decision };
    const settle = async (block: Block): Promise<Planned> => {
      const name = String(block.name);
      const id = String(block.id);
      const tool = byName.get(name) ?? null;
      if (!tool) return { block, tool, decision: { input: {}, refusal: `Tool ${name} is not enabled for this agent.` } };
      if (turn.malformed.has(id)) return { block, tool, decision: { input: {}, refusal: `the arguments for ${name} were not valid JSON — send the call again` } };
      return { block, tool, decision: await decide(o, name, id, (block.input ?? {}) as Json, sessionId, signal) };
    };
    const execute = async (p: Planned): Promise<{ outcome: ToolOutcome; context: string[] }> => {
      if (p.decision.refusal || !p.tool) return { outcome: { text: p.decision.refusal ?? "refused", isError: true }, context: [] };
      let outcome: ToolOutcome;
      try {
        outcome = await p.tool.run(p.decision.input, ctx);
      } catch (err) {
        outcome = { text: `${p.tool.name} failed: ${(err as Error).message}`, isError: true };
      }
      // For a summary's file lists: what ran, as the hooks left it, and did not fail.
      const file = p.decision.input.file_path;
      if (!outcome.isError && typeof file === "string") {
        if (p.tool.name === "Read") filesRead.add(file);
        else if (p.tool.name === "Write" || p.tool.name === "Edit") filesChanged.add(file);
      }
      const context = await after(o, p.tool.name, String(p.block.id), p.decision.input, outcome, sessionId, signal);
      return { outcome, context };
    };
    const planned: Planned[] = [];
    const done: { outcome: ToolOutcome; context: string[] }[] = [];
    if (calls.every((b) => byName.get(String(b.name))?.readOnly !== false)) {
      // Only reads (or names that are refused anyway): none can change what
      // another is checked against, so they are decided in the order asked
      // — limits count in that order — and then run side by side.
      for (const block of calls) planned.push(await settle(block));
      done.push(...(await Promise.all(planned.map(execute))));
    } else {
      // Anything that changes a file or runs a command: one at a time, in
      // the order asked, each decided just before it runs.
      for (const block of calls) {
        if (interrupted()) break;
        const p = await settle(block);
        planned.push(p);
        done.push(await execute(p));
      }
    }
    if (interrupted()) return;

    const results: Block[] = planned.map((p, i) => {
      const { text, isError, parts } = done[i].outcome;
      // An image a tool returned (an MCP server's screenshot) goes to the
      // model as an image, in its place among the text.
      const content = parts
        ? parts.map((p) => p.type === "text" ? { type: "text", text: p.text } : { type: "image", source: { type: "base64", media_type: p.mediaType, data: p.data } })
        : text;
      return { type: "tool_result", tool_use_id: String(p.block.id), content, ...(isError ? { is_error: true } : {}) };
    });
    const context = done.flatMap((d) => d.context);
    // After the results: what hooks add, then what the person sent meanwhile.
    const content: Block[] = [...results, ...context.map((c) => ({ type: "text", text: c })), ...steered()];
    messages.push({ role: "user", content });
    yield { type: "user", message: { role: "user", content }, parent_tool_use_id: null, session_id: sessionId };
  }
  } finally {
    // However the loop ended — an answer, a stop, a consumer that walked
    // away — nothing a command started outlives the step, and no MCP server
    // it started either.
    killGroups(ctx);
    unwatch?.();
    await mcp?.close();
  }
}

/** The foldrun engine, as executeStep's model loop. */
export const foldrunQuery: QueryFn = ({ prompt, options }) => {
  const o = readOptions(options);
  const controller = new AbortController();
  let interrupted = false;
  if (o.outer) {
    if (o.outer.aborted) controller.abort();
    else o.outer.addEventListener("abort", () => controller.abort(), { once: true });
  }
  const stream = run(prompt, o, controller.signal, () => interrupted);
  return Object.assign(stream, {
    // Ends the model call in flight and any running command. The loop then
    // returns without a result; the caller says why it asked.
    async interrupt() {
      interrupted = true;
      controller.abort();
    },
  }) as QueryLike;
};
