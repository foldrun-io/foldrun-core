// What any loop behind executeStep reads the same way (engine-loop.ts
// today): the SDK's options, what it refuses before a model call is paid
// for, the permission order every tool call goes through, and token usage.
// One copy, so a second loop (a bake-off, FOL-213) cannot hold a hook,
// limit or confinement check differently. Internal: not part of
// @foldrun/core's public API.

import path from "node:path";
import { ENGINE_TOOLS, type EngineTool, type ToolOutcome } from "./engine-tools.ts";
import { checkMcpSpecs, grantedServer, type McpSpec } from "./mcp-specs.ts";
import { COMPACTION_DEFAULTS, MIN_CONTEXT_WINDOW, compactionFor } from "./engine-compact.ts";

export const DEFAULT_MAX_TOKENS = 16_000;

export interface Usage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
}

export const emptyUsage = (): Usage => ({ input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 });

export function addUsage(into: Usage, u: Partial<Record<keyof Usage, unknown>> | undefined): void {
  if (!u) return;
  // The closing delta repeats the counts it knows; one that leaves the input
  // side at zero is not saying the input was free.
  for (const k of Object.keys(into) as (keyof Usage)[]) {
    const v = u[k];
    if (typeof v === "number" && (v > 0 || k === "output_tokens")) into[k] = v;
  }
}

/** The tier names an agent may write, where the environment names no model
 *  for them. The SDK's binary resolves these itself; here it is said. */
export const TIER_DEFAULTS: Record<string, string> = {
  haiku: "claude-haiku-5-5",
  sonnet: "claude-sonnet-5-5",
  opus: "claude-opus-5-5",
};

export type Json = Record<string, unknown>;
export type Block = Json & { type: string };
export type HookFn = (input: Json, toolUseId?: string, extra?: { signal: AbortSignal }) => Promise<Json | undefined> | Json | undefined;
export type CanUseTool = (name: string, input: Json, extra: { signal: AbortSignal; toolUseID: string }) =>
  Promise<{ behavior: "allow"; updatedInput?: Json } | { behavior: "deny"; message: string }>;

/** What the loop needs of a local sandbox — LocalSandbox has it. */
export interface SandboxWalls {
  /** How to run `command` inside, with `env` as its environment: LAUNCHER
   *  -c line, started with exactly the env given back. */
  launch(command: string, env: Record<string, string | undefined>): Promise<{ line: string; env: Record<string, string>; token?: string }>;
  /** Whether a long-lived process launched with `token` still runs under
   *  the walls as they are now (false: stop it). */
  fresh?(token: string): boolean;
  /** Call `listener` with the new token whenever a launch finds the
   *  protections changed; returns how to stop listening. */
  onChange?(listener: (token: string) => void | Promise<void>): () => void;
  canRead(file: string): boolean;
  canWrite(file: string): boolean;
  /** A fetch through the walls' site proxy: a remote MCP server is reached
   *  only this way inside the walls; without it such a server is refused. */
  fetch?: typeof fetch;
}

export interface LoopOptions {
  cwd: string;
  env: Record<string, string | undefined>;
  /** What the tools (Bash) get; `env` when not given. foldrun code passes
   *  the person's own environment here, so the model key stays with the loop. */
  shellEnv: Record<string, string | undefined>;
  /** The walls on a person's own machine (local-sandbox.ts): every command
   *  runs through `wrap`, the file tools ask canRead / canWrite. */
  localSandbox: SandboxWalls | null;
  /** Programs run unasked here: the local walls are up, or the step is in a container (its own boundary). */
  programs?: boolean;
  /** Where Symbols installs language servers, and the client's own read rule (FOL-297; ToolContext). */
  toolsDir?: string;
  readable?: (file: string) => boolean;
  /** The User-Agent the model calls carry: the caller's own name
   *  (`userAgent`, e.g. foldrun-cli/27.8.0), else foldrun-engine. An option,
   *  never an environment name — a step's env holds the tenant's secrets
   *  under names it chose. Never another product's name (claude-…). */
  userAgent: string;
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
  /** Images the person sent with the prompt, as they are (FOL-268): after its text, in the same turn. */
  images?: { data: string; mediaType: string }[];
  /** The step's MCP servers (engine-mcp.ts), connected when the loop starts. */
  mcpServers: Record<string, McpSpec>;
  /** MCP tools the step was granted by name, with the server each names:
   *  each must be offered by that server once connected, or the step is refused. */
  mcpGranted: { name: string; server: string }[];
  /** Compaction (engine-compact.ts): the model's context window, and false
   *  when the caller turned it off (`compaction: false`). */
  compaction: { contextWindow: number; reserveTokens: number; keepRecentTokens: number } | false;
  /** Steering (FOL-213): what a person sent while the turn runs, taken
   *  (and so removed) each time it is called. The model reads it after the
   *  calls it is making, or, about to finish, reads it and goes on. */
  steer: (() => unknown[]) | null;
  /** "summarized": ask the model for a readable summary of its thinking
   *  (`thinking.display`), on the models that take it (showsThinking).
   *  Thinking happens and is billed the same either way; null leaves the
   *  request as it was. The caller sets it only for an endpoint that takes
   *  the field for these model names — Anthropic's, or foldrun's gateway,
   *  which shapes `thinking` per provider (model-supply.ts); an endpoint
   *  that serves another model under a Claude name is not known from here. */
  thinkingDisplay?: "summarized" | null;
  /** How hard the model works, the agent's `effort:` (low … max): sent as
   *  `output_config.effort`, the field a cloud step's runtime sends, on a
   *  model that takes one (takesEffort). Null leaves the request as it was
   *  and the model at its own default. */
  effort?: string | null;
}

/** foldrun's effort words (frontmatter-fields EFFORT_LEVELS), low to high. */
const EFFORT_WORDS = ["low", "medium", "high", "xhigh", "max"];

/**
 * The effort a model is sent for a foldrun word, or null to send none.
 * The Claude 5 models take all five words. Of the Claude 4 models (Claude
 * API docs, 24 Nov 2026): `max` is supported on Opus 4.6 and later and
 * Sonnet 4.6, `xhigh` is new on Opus 4.7, Opus 4.5 takes low to high; a
 * word a model lacks runs as the nearest below it has. An older Claude
 * (Sonnet 4.5, Haiku 4.5: no `effort` parameter) is sent none. Another provider's
 * model, or a tier the gateway resolves, is sent the word: foldrun's
 * gateway fits it to what that provider runs (model-supply.ts
 * shapeRequest), and a provider's own endpoint is fitted by the caller
 * (fitEffortFor in engine-loop.ts).
 */
export function effortFor(model: string, word: string | null | undefined): string | null {
  if (!word || !EFFORT_WORDS.includes(word)) return null;
  const id = String(model).split("/").pop() ?? "";
  if (!/^claude-/.test(id) || showsThinking(id)) return word;
  const four = /^claude-(opus|sonnet)-4-(\d+)(?:-|$)/.exec(id);
  if (!four) return null;
  const minor = Number(four[2]);
  const has = four[1] === "opus"
    ? minor >= 7 ? EFFORT_WORDS : minor === 6 ? ["low", "medium", "high", "max"] : minor === 5 ? ["low", "medium", "high"] : []
    : minor >= 6 ? ["low", "medium", "high", "max"] : [];
  for (let i = EFFORT_WORDS.indexOf(word); i >= 0; i--) if (has.includes(EFFORT_WORDS[i]!)) return EFFORT_WORDS[i]!;
  return null;
}

/** Whether a model is sent an effort at all (effortFor). */
export function takesEffort(model: string): boolean {
  return effortFor(model, "low") !== null;
}

/**
 * Whether a model returns a summary of its thinking when asked
 * (`thinking: {type: "adaptive", display: "summarized"}`): the Claude models
 * that think by default. Others are sent nothing — an older Claude would
 * refuse the field or start thinking where it did not, and another
 * provider's endpoint has no such field.
 */
export function showsThinking(model: string): boolean {
  return /^claude-(fable|mythos|opus|sonnet)-5(-\d+)?$|^claude-haiku-5-5$/.test(model);
}

export function hookFns(hooks: unknown, event: string): HookFn[] {
  const groups = (hooks as Record<string, { hooks?: HookFn[] }[] | undefined> | undefined)?.[event];
  return (groups ?? []).flatMap((g) => g.hooks ?? []);
}

/** The SDK's options, as this engine reads them. What it cannot honour it
 *  refuses here, before a model call is paid for. */
/** `engine` names the loop in what it refuses. */
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

/** Base64 of 3.75 MB, the most one image may be; 20 MB of base64 for all (FOL-268, Codex). */
const IMAGE_B64_MAX = Math.ceil((3.75 * 1024 * 1024) / 3) * 4;
const IMAGES_B64_TOTAL = 20 * 1024 * 1024;

/** Only well-formed images, at most 20, each and all within what a request takes — else refused whole. */
function readImages(v: unknown): { data: string; mediaType: string }[] {
  if (!Array.isArray(v)) return [];
  const out = v
    .filter((x): x is { data: string; mediaType: string } => !!x && typeof x === "object" && typeof (x as Json).data === "string" && IMAGE_TYPES.has(String((x as Json).mediaType)))
    .map((x) => ({ data: x.data, mediaType: x.mediaType }));
  if (out.length > 20) throw new Error("at most 20 images go with one prompt");
  let total = 0;
  for (const i of out) {
    if (!i.data || i.data.length > IMAGE_B64_MAX || i.data.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(i.data)) throw new Error("an image sent with the prompt is not base64 of at most 3.75 MB");
    total += i.data.length;
  }
  if (total > IMAGES_B64_TOTAL) throw new Error("the images sent with the prompt are more than 20 MB together");
  return out;
}

export function readOptions(options: Json, engine = "foldrun"): LoopOptions {
  const env = (options.env as Record<string, string | undefined> | undefined) ?? process.env;
  const listed = Array.isArray(options.tools) ? (options.tools as unknown[]).map(String) : [];
  // A granted MCP tool (`mcp__<server>__<tool>`, what the runner lists for
  // web, apis, scripts, a2a, ask…) comes from its server, connected when the
  // loop starts; its server must be one of the step's.
  const mcpGranted = listed.filter((n) => n.startsWith("mcp__"));
  const names = listed.filter((n) => !n.startsWith("mcp__"));
  const unsupported = names.filter((n) => !ENGINE_TOOLS[n]);
  if (unsupported.length) {
    throw new Error(`the ${engine} engine has no tool named ${unsupported.join(", ")} yet — it has ${Object.keys(ENGINE_TOOLS).join(", ")}. Run this agent on the default engine.`);
  }
  // MCP servers: checked here, connected when the loop starts (engine-mcp.ts).
  const mcpServers = checkMcpSpecs((options.mcpServers as Json | undefined) ?? {}, engine);
  // A whole server granted (`mcp__crm`, `mcp__crm__*`) needs only the
  // server; a tool granted by name must be offered by it once connected.
  const mcpTools: { name: string; server: string }[] = [];
  for (const n of mcpGranted) {
    const g = grantedServer(n, Object.keys(mcpServers));
    if (!g) throw new Error(`the tool ${n} was granted, but the step has no MCP server for it`);
    if (g.tool) mcpTools.push({ name: g.tool, server: g.server });
  }
  if (options.agents && Object.keys(options.agents as Json).length) {
    throw new Error(`the ${engine} engine does not run sub-agents yet — run this agent on the default engine.`);
  }
  const sandbox = options.sandbox as { enabled?: boolean } | undefined;
  const walls = options.localSandbox as Partial<SandboxWalls> | undefined;
  const localSandbox =
    walls && typeof walls.launch === "function" && typeof walls.canRead === "function" && typeof walls.canWrite === "function"
      ? (walls as SandboxWalls)
      : null;
  if (walls && !localSandbox) throw new Error("localSandbox: needs launch, canRead and canWrite");
  // Inside the walls the tools' environment is said outright: falling back
  // to `env` would hand every command the model's key.
  if (localSandbox && !(options.shellEnv && typeof options.shellEnv === "object")) throw new Error("localSandbox: give shellEnv, the environment commands run with");
  // Never read from `env`: that is where a tenant's secrets live.
  if (names.includes("Bash") && !localSandbox && sandbox?.enabled !== false && options.engineHostShell !== true) {
    throw new Error(`the ${engine} engine has no OS sandbox for the shell on this host — run the step in a container.`);
  }
  const model = String(options.model ?? "");
  if (!model) throw new Error(`the ${engine} engine needs a model`);
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
    localSandbox,
    // The same test as the shell's above: walls, or a container that said it needs no OS sandbox — not a person's
    // machine without walls (engineHostShell), where each command is asked.
    programs: localSandbox !== null || (sandbox?.enabled === false && options.engineHostShell !== true),
    ...(typeof options.toolsDir === "string" && path.isAbsolute(options.toolsDir) ? { toolsDir: options.toolsDir } : {}),
    ...(typeof options.readable === "function" ? { readable: options.readable as (file: string) => boolean } : {}),
    userAgent: typeof options.userAgent === "string" && /^[!-~]{1,100}$/.test(options.userAgent) && !/^claude[-_/]/i.test(options.userAgent) ? options.userAgent : "foldrun-engine",
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
    ...(readImages(options.images).length ? { images: readImages(options.images) } : {}),
    mcpServers,
    mcpGranted: mcpTools,
    steer: typeof options.steer === "function" ? (options.steer as () => unknown[]) : null,
    thinkingDisplay: options.thinkingDisplay === "summarized" ? "summarized" : null,
    effort: typeof options.effort === "string" && EFFORT_WORDS.includes(options.effort) ? options.effort : null,
    compaction: options.compaction === false ? false : compactionFor(
      typeof options.contextWindow === "number" && Number.isFinite(options.contextWindow) && options.contextWindow >= MIN_CONTEXT_WINDOW ? Math.floor(options.contextWindow) : COMPACTION_DEFAULTS.contextWindow,
    ),
  };
}

/** An earlier conversation, checked: user and assistant turns that
 *  alternate, starting with the user's, each a list of content blocks. A
 *  turn that is not one is refused, not sent half-right to the model. */
export function readHistory(raw: unknown): { role: string; content: Block[] }[] {
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

export interface Decision {
  input: Json;
  refusal: string | null;
}

/** May this call run, and with what input? The order the SDK kept, which
 *  step-exec's checks are written against: every PreToolUse hook first — a
 *  deny ends it, an allow carries the input the hook settled on and skips
 *  the question below — then canUseTool, where confinement lives. */
export async function decide(o: LoopOptions, name: string, id: string, input: Json, sessionId: string, signal: AbortSignal): Promise<Decision> {
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
export async function after(o: LoopOptions, name: string, id: string, input: Json, outcome: ToolOutcome, sessionId: string, signal: AbortSignal): Promise<string[]> {
  const added: string[] = [];
  for (const hook of o.post) {
    const out = await hook({ hook_event_name: "PostToolUse", session_id: sessionId, cwd: o.cwd, tool_name: name, tool_input: input, tool_response: outcome.text, tool_use_id: id }, id, { signal });
    const context = (out as { hookSpecificOutput?: { additionalContext?: string } } | undefined)?.hookSpecificOutput?.additionalContext;
    if (context) added.push(context);
  }
  return added;
}

