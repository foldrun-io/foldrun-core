// Sub-agents: delegate a job to a colleague with its OWN context and its own
// tools, inside the step that asked.
//
//   agents: [editor]          # consult: a quick opinion, no tools (agent-tools.ts)
//   subagents: [researcher]   # delegate: own context, own tools
//
// Built on the Agent SDK's native sub-agents (query()'s `agents` option and
// its Agent tool), so a delegation behaves as it does in Claude Code: a fresh
// context does the work — reads forty pages, runs the checks — and hands back
// a summary, keeping the parent's context on its own job.
//
// What keeps it the platform's and not a second, wider agent:
//   - never wider than the parent: a sub-agent's tools are its own `tools:`
//     resolved exactly as a step's, INTERSECTED with what the parent step
//     holds — and always an explicit list: the SDK gives a definition with
//     no `tools` every tool the parent has
//   - depth one: the Agent/Task tool is never in a sub-agent's list, so it
//     cannot delegate again
//   - the same step: same sandbox, files, secrets, egress lease, and the
//     parent's hooks — the SDK runs a sub-agent's tool calls through the
//     session's PreToolUse and canUseTool (tagged agent_id/agent_type), so
//     confinement applies unchanged; subagentGuard() below refuses anything
//     outside the sub-agent's own list there too, belt and braces
//   - cost and trace land on the parent step; flows still decide what runs
//     next — a sub-agent is a helper inside one step, never a step.

import fs from "node:fs";
import path from "node:path";
import { refNames } from "./refs.ts";
import { TOOL_MAP } from "./tool-names.ts";

/** Plain JSON: this crosses into the run container. */
export interface SubagentSpec {
  name: string;
  description: string;
  prompt: string;
  /** Always explicit — never absent, never inherited. */
  tools: string[];
  disallowedTools: string[];
  /** A model alias (haiku/sonnet/opus, remapped by the step's provider like
   *  the step's own) or "inherit". */
  model: string;
}

/** The SDK's delegation tool, under both names it has had. Never granted to a
 *  sub-agent: that is what makes the depth one. */
export const DELEGATE_TOOLS = ["Agent", "Task"] as const;
export const DELEGATE_TOOL = "Agent";

const NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** The named sub-agents' folders, host-side. Unknown names are reported. */
export function gatherSubagents(
  workspaceRoot: string,
  names: unknown,
): { found: { name: string; dir: string }[]; missing: string[] } {
  const found: { name: string; dir: string }[] = [];
  const missing: string[] = [];
  for (const name of refNames(names)) {
    const dir = path.join(workspaceRoot, "agents", name);
    if (!NAME.test(name) || !fs.existsSync(path.join(dir, "agent.md"))) missing.push(name);
    else if (!found.some((f) => f.name === name)) found.push({ name, dir });
  }
  return { found, missing };
}

/**
 * A sub-agent's tools: its own, only where the parent holds them too. An MCP
 * tool is held when the parent holds that exact name or its whole server
 * (`mcp__<server>` / `mcp__<server>__*`). The delegate tool never passes.
 */
export function subagentTools(own: string[], parent: string[]): string[] {
  const held = new Set(parent);
  const servers = new Set(
    parent.filter((t) => /^mcp__[^_]/.test(t)).map((t) => t.replace(/__\*$/, "")).filter((t) => !t.slice(5).includes("__")),
  );
  const out: string[] = [];
  for (const t of own) {
    if ((DELEGATE_TOOLS as readonly string[]).includes(t) || out.includes(t)) continue;
    const server = /^mcp__([^_].*?)__/.exec(t)?.[1];
    if (held.has(t) || (server && servers.has(`mcp__${server}`))) out.push(t);
  }
  return out;
}

/** The sub-agent's system prompt: its own prose, told where it stands. It
 *  works in the PARENT's directory — the SDK shares the session's cwd. */
export function subagentPrompt(o: {
  body: string;
  name: string;
  parent: string;
  workspace: string;
  shared?: string | null;
}): string {
  return [
    o.body.trim(),
    `# Where you are\n\n` +
      `You are ${o.name}, a sub-agent started by ${o.parent} to do one job and report back. ` +
      `You work in ${o.parent}'s directory, \`agents/${o.parent}/\` in the \`${o.workspace}\` workspace: ` +
      `\`../../\` is the workspace root, its knowledge is at \`../../knowledge/\`, and absolute paths are refused. ` +
      `You have only the tools listed for you. When the job is done, reply with what you found or made — ` +
      `your reply is all ${o.parent} sees of your work, so put the facts and file paths in it.`,
    ...(o.shared?.trim() ? [o.shared.trim()] : []),
  ].join("\n\n");
}

/** SDK definitions. `tools` is always set — an absent list inherits every
 *  tool the parent has, which is the one thing this module exists to stop. */
export function toAgentDefinitions(specs: SubagentSpec[]): Record<string, {
  description: string;
  prompt: string;
  tools: string[];
  disallowedTools: string[];
  model: string;
}> {
  const out: Record<string, { description: string; prompt: string; tools: string[]; disallowedTools: string[]; model: string }> = {};
  for (const s of specs) {
    out[s.name] = {
      description: s.description,
      prompt: s.prompt,
      tools: [...s.tools],
      disallowedTools: [...new Set([...s.disallowedTools, ...DELEGATE_TOOLS])],
      model: s.model || "inherit",
    };
  }
  return out;
}

/** One tool call as the parent's PreToolUse hook sees it. */
export interface GuardedCall {
  /** The SDK's agent_id: set when the call comes from inside a sub-agent. */
  agentId?: string;
  /** The SDK's agent_type: which sub-agent. */
  agentType?: string;
  tool: string;
  input: Record<string, unknown>;
}

/**
 * For the parent's PreToolUse hook, on a step that has sub-agents: a reason
 * to refuse the call — or null.
 *
 * Only DECLARED sub-agents may run. The SDK also offers its built-ins
 * (general-purpose and the rest, with every tool the session has); they are
 * switched off in executeStep, and refused here too. A call from inside a
 * sub-agent whose type is missing or not declared used to pass unjudged —
 * `general-purpose` was a way round every sub-agent's own list.
 */
export function subagentGuard(specs: SubagentSpec[]): (call: GuardedCall) => string | null {
  const by = new Map(specs.map((s) => [s.name, s]));
  const declared = specs.map((s) => s.name).join(", ");
  const isDelegate = (tool: string) => (DELEGATE_TOOLS as readonly string[]).includes(tool);
  return ({ agentId, agentType, tool, input }) => {
    if (!agentId) {
      // The main thread: its tools are canUseTool's business — except the
      // delegation itself, which may name only a declared sub-agent.
      if (!isDelegate(tool)) return null;
      const to = typeof input.subagent_type === "string" ? input.subagent_type : "";
      if (by.has(to)) return null;
      return `${to ? `"${to}" is not a sub-agent this step declared` : "name the sub-agent to delegate to"} — subagent_type must be one of: ${declared}`;
    }
    const s = agentType ? by.get(agentType) : undefined;
    if (!s) return `${agentType ? `"${agentType}"` : "an unnamed sub-agent"} is not declared in subagents: for this step (only ${declared}) — its calls are refused`;
    if (isDelegate(tool)) {
      return `${s.name} is a sub-agent and cannot start another — do the work with your own tools`;
    }
    if (s.disallowedTools.includes(tool)) return `${tool} is disallowed for ${s.name}`;
    if (subagentTools([tool], s.tools).length === 0) return `${tool} is not one of ${s.name}'s tools`;
    return null;
  };
}

/**
 * What `foldrun check` can say without running anything: the SDK and built-in
 * tool names two `tools:` lists grant, and their overlap. Own tools compare by
 * name. Used to warn when a sub-agent would be left with nothing.
 */
export function grantedNames(tools: string[]): Set<string> {
  const out = new Set<string>();
  for (const t of tools) {
    for (const n of TOOL_MAP[t] ?? [t]) out.add(n);
  }
  return out;
}

export function checkOverlap(parentTools: string[], subTools: string[]): string[] {
  const parent = grantedNames(parentTools);
  return [...grantedNames(subTools)].filter((t) => parent.has(t) && !(DELEGATE_TOOLS as readonly string[]).includes(t));
}
