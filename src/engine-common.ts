// What any loop behind executeStep reads the same way (engine-loop.ts
// today): the SDK's options, what it refuses before a model call is paid
// for, the permission order every tool call goes through, and token usage.
// One copy, so a second loop (a bake-off, FOL-213) cannot hold a hook,
// limit or confinement check differently. Internal: not part of
// @foldrun/core's public API.

import { ENGINE_TOOLS, type EngineTool, type ToolOutcome } from "./engine-tools.ts";

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

export interface LoopOptions {
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

export function hookFns(hooks: unknown, event: string): HookFn[] {
  const groups = (hooks as Record<string, { hooks?: HookFn[] }[] | undefined> | undefined)?.[event];
  return (groups ?? []).flatMap((g) => g.hooks ?? []);
}

/** The SDK's options, as this engine reads them. What it cannot honour it
 *  refuses here, before a model call is paid for. */
/** `engine` names the loop in what it refuses. */
export function readOptions(options: Json, engine = "foldrun"): LoopOptions {
  const env = (options.env as Record<string, string | undefined> | undefined) ?? process.env;
  const names = Array.isArray(options.tools) ? (options.tools as unknown[]).map(String) : [];
  const unsupported = names.filter((n) => !ENGINE_TOOLS[n]);
  if (unsupported.length) {
    throw new Error(`the ${engine} engine has no tool named ${unsupported.join(", ")} yet — it has ${Object.keys(ENGINE_TOOLS).join(", ")}. Run this agent on the default engine.`);
  }
  const servers = Object.keys((options.mcpServers as Json | undefined) ?? {});
  if (servers.length) {
    throw new Error(`the ${engine} engine does not connect MCP servers yet (${servers.join(", ")}) — run this agent on the default engine.`);
  }
  if (options.agents && Object.keys(options.agents as Json).length) {
    throw new Error(`the ${engine} engine does not run sub-agents yet — run this agent on the default engine.`);
  }
  const sandbox = options.sandbox as { enabled?: boolean } | undefined;
  // Never read from `env`: that is where a tenant's secrets live.
  if (names.includes("Bash") && sandbox?.enabled !== false && options.engineHostShell !== true) {
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

