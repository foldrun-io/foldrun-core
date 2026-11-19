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
import { ENGINE_TOOLS, killGroups, type EngineTool, type ToolContext, type ToolOutcome } from "./engine-tools.ts";

/** Which loop runs a step's turns. */
export type Engine = "sdk" | "foldrun";

const DEFAULT_BASE = "https://api.anthropic.com";
const API_VERSION = "2023-06-01";
const DEFAULT_MAX_TOKENS = 16_000;
const MODEL_TRIES = 4;
const RETRY_AFTER_CAP_MS = 30_000;

/** The tier names an agent may write, where the environment names no model
 *  for them. The SDK's binary resolves these itself; here it is said. */
const TIER_DEFAULTS: Record<string, string> = {
  haiku: "claude-haiku-5-5",
  sonnet: "claude-sonnet-5-5",
  opus: "claude-opus-5-5",
};

type Json = Record<string, unknown>;
type Block = Json & { type: string };
type HookFn = (input: Json, toolUseId?: string, extra?: { signal: AbortSignal }) => Promise<Json | undefined> | Json | undefined;
type CanUseTool = (name: string, input: Json, extra: { signal: AbortSignal; toolUseID: string }) =>
  Promise<{ behavior: "allow"; updatedInput?: Json } | { behavior: "deny"; message: string }>;

interface Usage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
}

interface LoopOptions {
  cwd: string;
  env: Record<string, string | undefined>;
  /** What the tools (Bash) get; `env` when not given. foldrun code passes
   *  the person's own environment here, so the model key stays with the loop. */
  shellEnv: Record<string, string | undefined>;
  model: string;
  systemPrompt: string;
  tools: EngineTool[];
  maxTurns: number | null;
  partial: boolean;
  pre: HookFn[];
  post: HookFn[];
  canUseTool: CanUseTool | null;
  outer: AbortSignal | null;
  /** The conversation so far, before this prompt: earlier user turns, the
   *  model's replies and tool results, as the loop yielded them. */
  history: { role: string; content: Block[] }[];
}

function hookFns(hooks: unknown, event: string): HookFn[] {
  const groups = (hooks as Record<string, { hooks?: HookFn[] }[] | undefined> | undefined)?.[event];
  return (groups ?? []).flatMap((g) => g.hooks ?? []);
}

/** The SDK's options, as this engine reads them. What it cannot honour it
 *  refuses here, before a model call is paid for. */
function readOptions(options: Json): LoopOptions {
  const env = (options.env as Record<string, string | undefined> | undefined) ?? process.env;
  const names = Array.isArray(options.tools) ? (options.tools as unknown[]).map(String) : [];
  const unsupported = names.filter((n) => !ENGINE_TOOLS[n]);
  if (unsupported.length) {
    throw new Error(`the foldrun engine has no tool named ${unsupported.join(", ")} yet — it has ${Object.keys(ENGINE_TOOLS).join(", ")}. Run this agent on the default engine.`);
  }
  const servers = Object.keys((options.mcpServers as Json | undefined) ?? {});
  if (servers.length) {
    throw new Error(`the foldrun engine does not connect MCP servers yet (${servers.join(", ")}) — run this agent on the default engine.`);
  }
  if (options.agents && Object.keys(options.agents as Json).length) {
    throw new Error("the foldrun engine does not run sub-agents yet — run this agent on the default engine.");
  }
  const sandbox = options.sandbox as { enabled?: boolean } | undefined;
  // Never read from `env`: that is where a tenant's secrets live.
  if (names.includes("Bash") && sandbox?.enabled !== false && options.engineHostShell !== true) {
    throw new Error("the foldrun engine has no OS sandbox for the shell on this host — run the step in a container.");
  }
  const model = String(options.model ?? "");
  if (!model) throw new Error("the foldrun engine needs a model");
  // Tools the host brings, as EngineTool objects: they sit beside the
  // built-in ones and go through canUseTool and the hooks like them.
  // foldrun code's cloud_agents is one. A name may not shadow a built-in.
  const extra: EngineTool[] = [];
  for (const t of Array.isArray(options.extraTools) ? (options.extraTools as unknown[]) : []) {
    const tool = t as Partial<EngineTool> | null;
    if (!tool || typeof tool.name !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(tool.name) || typeof tool.run !== "function" || typeof tool.input_schema !== "object") {
      throw new Error("extraTools: each needs a name (letters, digits, _ and -), an input_schema and a run function");
    }
    if (ENGINE_TOOLS[tool.name] || extra.some((x) => x.name === tool.name)) throw new Error(`extraTools: ${tool.name} is already a tool`);
    extra.push({ name: tool.name, description: String(tool.description ?? ""), input_schema: tool.input_schema as Record<string, unknown>, readOnly: tool.readOnly === true, run: tool.run });
  }
  return {
    cwd: String(options.cwd ?? process.cwd()),
    env,
    shellEnv: options.shellEnv && typeof options.shellEnv === "object" ? (options.shellEnv as Record<string, string | undefined>) : env,
    model: env[`ANTHROPIC_DEFAULT_${model.toUpperCase()}_MODEL`] || TIER_DEFAULTS[model] || model,
    systemPrompt: typeof options.systemPrompt === "string" ? options.systemPrompt : "",
    tools: [...names.map((n) => ENGINE_TOOLS[n]), ...extra],
    maxTurns: typeof options.maxTurns === "number" && options.maxTurns > 0 ? options.maxTurns : null,
    partial: options.includePartialMessages === true,
    pre: hookFns(options.hooks, "PreToolUse"),
    post: hookFns(options.hooks, "PostToolUse"),
    canUseTool: typeof options.canUseTool === "function" ? (options.canUseTool as CanUseTool) : null,
    outer: (options.abortController as AbortController | undefined)?.signal ?? null,
    history: readHistory(options.history),
  };
}

/** An earlier conversation, checked: user and assistant turns that
 *  alternate, starting with the user's, each a list of content blocks. A
 *  turn that is not one is refused, not sent half-right to the model. */
function readHistory(raw: unknown): { role: string; content: Block[] }[] {
  if (raw == null) return [];
  if (!Array.isArray(raw)) throw new Error("history must be a list of turns");
  return raw.map((t, i) => {
    const role = (t as Json)?.role;
    const content = (t as Json)?.content;
    if (role !== (i % 2 === 0 ? "user" : "assistant")) throw new Error(`history turn ${i + 1} must be the ${i % 2 === 0 ? "user's" : "model's"}`);
    if (!Array.isArray(content) || !content.every((b) => b && typeof (b as Json).type === "string")) throw new Error(`history turn ${i + 1} has no content blocks`);
    return { role: String(role), content: content as Block[] };
  });
}

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
export function buildRequest(o: Pick<LoopOptions, "model" | "systemPrompt" | "tools" | "env">, messages: { role: string; content: Block[] }[]): Json {
  const mark = { cache_control: { type: "ephemeral" } };
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
    max_tokens: Number.isFinite(asked) && asked > 0 ? asked : DEFAULT_MAX_TOKENS,
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
      if (!retryable) throw new Error(lastError);
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
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true });
    for (let at = buffer.search(/\r?\n\r?\n/); at >= 0; at = buffer.search(/\r?\n\r?\n/)) {
      const frame = buffer.slice(0, at);
      buffer = buffer.slice(at).replace(/^\r?\n\r?\n/, "");
      const data = frame.split(/\r?\n/).filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trimStart()).join("\n");
      if (!data || data === "[DONE]") continue;
      try {
        yield JSON.parse(data) as Json;
      } catch {
        // a frame that is not JSON carries nothing this loop reads
      }
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

const emptyUsage = (): Usage => ({ input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 });

function addUsage(into: Usage, u: Partial<Record<keyof Usage, unknown>> | undefined): void {
  if (!u) return;
  // The closing delta repeats the counts it knows; one that leaves the input
  // side at zero is not saying the input was free.
  for (const k of Object.keys(into) as (keyof Usage)[]) {
    const v = u[k];
    if (typeof v === "number" && (v > 0 || k === "output_tokens")) into[k] = v;
  }
}

/** One model call: yields the raw stream events, returns the whole turn. */
async function* modelTurn(o: LoopOptions, messages: { role: string; content: Block[] }[], signal: AbortSignal): AsyncGenerator<Json, Turn> {
  const res = await openStream(o, buildRequest(o, messages), signal);
  const turn: Turn = { id: "", model: o.model, content: [], stopReason: null, usage: emptyUsage(), malformed: new Set() };
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

interface Decision {
  input: Json;
  refusal: string | null;
}

/** May this call run, and with what input? The order the SDK kept, which
 *  step-exec's checks are written against: every PreToolUse hook first — a
 *  deny ends it, an allow carries the input the hook settled on and skips
 *  the question below — then canUseTool, where confinement lives. */
async function decide(o: LoopOptions, name: string, id: string, input: Json, sessionId: string, signal: AbortSignal): Promise<Decision> {
  let current = input;
  let allowed = false;
  for (const hook of o.pre) {
    const out = await hook({ hook_event_name: "PreToolUse", session_id: sessionId, cwd: o.cwd, tool_name: name, tool_input: current, tool_use_id: id }, id, { signal });
    const d = (out as { hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string; updatedInput?: Json } } | undefined)?.hookSpecificOutput;
    if (!d) continue;
    if (d.permissionDecision === "deny") return { input: current, refusal: d.permissionDecisionReason || `${name} was refused` };
    if (d.updatedInput) current = d.updatedInput;
    if (d.permissionDecision === "allow") allowed = true;
  }
  if (!allowed && o.canUseTool) {
    const r = await o.canUseTool(name, current, { signal, toolUseID: id });
    if (r.behavior === "deny") return { input: current, refusal: r.message || `${name} was refused` };
    if (r.updatedInput) current = r.updatedInput;
  }
  return { input: current, refusal: null };
}

/** After a call: tell the PostToolUse hooks, and collect what they add. */
async function after(o: LoopOptions, name: string, id: string, input: Json, outcome: ToolOutcome, sessionId: string, signal: AbortSignal): Promise<string[]> {
  const added: string[] = [];
  for (const hook of o.post) {
    const out = await hook({ hook_event_name: "PostToolUse", session_id: sessionId, cwd: o.cwd, tool_name: name, tool_input: input, tool_response: outcome.text, tool_use_id: id }, id, { signal });
    const context = (out as { hookSpecificOutput?: { additionalContext?: string } } | undefined)?.hookSpecificOutput?.additionalContext;
    if (context) added.push(context);
  }
  return added;
}

async function* run(prompt: string, o: LoopOptions, signal: AbortSignal, interrupted: () => boolean): AsyncGenerator<Json> {
  const sessionId = crypto.randomUUID();
  const startedAt = Date.now();
  const byName = new Map(o.tools.map((t) => [t.name, t]));
  const ctx: ToolContext = { cwd: o.cwd, env: o.shellEnv, signal, reads: new Map(), groups: new Set() };
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

  yield { type: "system", subtype: "init", session_id: sessionId, cwd: o.cwd, model: o.model, tools: o.tools.map((t) => t.name), mcp_servers: [], engine: "foldrun" };

  try {
  for (;;) {
    if (o.maxTurns !== null && turns >= o.maxTurns) {
      yield result("error_max_turns", null);
      return;
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
      throw err;
    }
    turns++;
    for (const k of Object.keys(total) as (keyof Usage)[]) total[k] += turn.usage[k];
    const text = turn.content.filter((b) => b.type === "text").map((b) => String(b.text ?? "")).join("\n").trim();
    if (text) lastText = text;
    yield {
      type: "assistant",
      message: { id: turn.id, type: "message", role: "assistant", model: turn.model, content: turn.content, stop_reason: turn.stopReason, usage: { ...turn.usage } },
      parent_tool_use_id: null,
      session_id: sessionId,
    };
    messages.push({ role: "assistant", content: turn.content });
    if (interrupted()) return;

    const calls = turn.content.filter((b) => b.type === "tool_use");
    // `pause_turn`: the provider stopped a long turn part-way; sending the
    // conversation back as it stands lets it carry on.
    if (turn.stopReason === "pause_turn" && !calls.length) continue;
    if (turn.stopReason !== "tool_use" || !calls.length) {
      yield result("success", turn.stopReason);
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

    const results: Block[] = planned.map((p, i) => ({
      type: "tool_result",
      tool_use_id: String(p.block.id),
      content: done[i].outcome.text,
      ...(done[i].outcome.isError ? { is_error: true } : {}),
    }));
    const context = done.flatMap((d) => d.context);
    const content: Block[] = [...results, ...context.map((c) => ({ type: "text", text: c }))];
    messages.push({ role: "user", content });
    yield { type: "user", message: { role: "user", content }, parent_tool_use_id: null, session_id: sessionId };
  }
  } finally {
    // However the loop ended — an answer, a stop, a consumer that walked
    // away — nothing a command started outlives the step.
    killGroups(ctx);
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
