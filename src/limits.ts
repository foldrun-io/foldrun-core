// Per-step call limits: how many times a step may call a tool before the
// next call is refused.
//
//   limits:
//     web.search: 40      # one action of the web tool
//     web: 150            # every web action together
//     crm: 20             # an API, script or MCP tool, by the name it is granted as
//     calls: 300          # every tool call in the step, whatever the tool
//
// Counted per step and enforced in step-exec.ts's PreToolUse hook — the one
// place every call passes, the step's own and its sub-agents', on the
// in-process path and inside a run container alike. A call past a limit is
// refused before it runs: the tool never sees it, so a paid search API is
// never asked and the cost is capped exactly. The refusal counts toward
// nothing. A retry of the step starts from zero; so does each fan-out
// instance, which is its own step.
//
// Nearest wins per key: the account's AGENTS.md, then the workspace's, then
// the agent's own `limits:`, then a flow step's `limits:` option.

import { WEB_ACTIONS } from "./providers.ts";
import { DELEGATE_TOOLS } from "./subagents.ts";

export type Limits = Record<string, number>;

/** The key that caps every call in the step. */
export const TOTAL_KEY = "calls";

/** SDK built-ins, counted under the foldrun group that grants them — and
 *  under their own SDK name, so `Bash: 5` works for a Claude Code file. */
const BUILTIN_GROUP: Record<string, string> = {
  Read: "read", Glob: "read", Grep: "read",
  Write: "write", Edit: "write", MultiEdit: "write", NotebookEdit: "write",
  Bash: "code",
};

/** Retired spellings an author may still write as a key. */
const KEY_ALIASES: Record<string, string> = { files: "write", bash: "code" };

/** The platform's own in-process servers and the name each is granted as. */
const PLATFORM_SERVERS: Record<string, string> = {
  foldrun_search: "search",
  foldrun_history: "history",
  foldrun_desks: "desks",
  foldrun_ask: "ask",
};

/** One spelling for comparing: `desk-email` and `desk_email` are the same
 *  tool (a script tool's SDK name has its dashes made underscores). */
export function normKey(key: string): string {
  const k = key.trim();
  return (KEY_ALIASES[k] ?? k).replace(/-/g, "_");
}

const KEY_RE = /^[A-Za-z0-9_-]+(\.[a-z]+)?$/;

/**
 * A `limits:` block as written: the values that can be read, and a sentence
 * for each that cannot. Shape only — whether a key names a tool this agent
 * has is `limitKeyProblems`, which needs the grants.
 */
export function readLimits(raw: unknown, where = "limits"): { limits: Limits; problems: string[] } {
  const limits: Limits = {};
  const problems: string[] = [];
  if (raw === undefined || raw === null) return { limits, problems };
  if (typeof raw !== "object" || Array.isArray(raw)) {
    problems.push(`${where}: is a block of tool: count, e.g. \`limits: {web.search: 40, calls: 300}\`.`);
    return { limits, problems };
  }
  // A YAML block written `web: {search: 40}` arrives nested; read it as the
  // dotted keys it means rather than refusing a natural spelling.
  const flat: [string, unknown][] = [];
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      for (const [sub, n] of Object.entries(v as Record<string, unknown>)) flat.push([`${k}.${sub}`, n]);
    } else flat.push([k, v]);
  }
  for (const [key, value] of flat) {
    const k = key.trim();
    if (!KEY_RE.test(k)) {
      problems.push(`${where}: "${k}" is not a key — a tool's name, web.<action>, or calls.`);
      continue;
    }
    if (k.includes(".")) {
      const [head, action] = k.split(".");
      if (head !== "web" || !(WEB_ACTIONS as readonly string[]).includes(action)) {
        problems.push(`${where}: "${k}" is not a key — the dotted keys are web.<action>: ${WEB_ACTIONS.map((a) => `web.${a}`).join(", ")}.`);
        continue;
      }
    }
    const n = typeof value === "number" ? value : typeof value === "string" && /^\s*\d+\s*$/.test(value) ? Number(value) : NaN;
    if (!Number.isInteger(n) || n < 1) {
      problems.push(`${where}: ${k}: ${String(value)} — a whole number of calls, 1 or more. To withhold a tool, leave it out of tools:.`);
      continue;
    }
    limits[k] = n;
  }
  return { limits, problems };
}

/**
 * The limits a step runs under, nearest last: account, workspace, agent,
 * step. A key set nearer replaces the same key further out; the others
 * stand. Unreadable values are dropped here — `check` and the deploy gate
 * say so where they were written.
 */
export function cascadeLimits(levels: unknown[]): Limits {
  const out: Limits = {};
  const at = new Map<string, string>(); // normalised → the key as last written
  for (const level of levels) {
    for (const [k, n] of Object.entries(readLimits(level).limits)) {
      const nk = normKey(k);
      const prev = at.get(nk);
      if (prev !== undefined) delete out[prev];
      out[k] = n;
      at.set(nk, k);
    }
  }
  return out;
}

/** SDK tool name → the foldrun name it is granted as, for the tools whose
 *  SDK name does not say (an openapi tool's operations, a script whose name
 *  was made safe). Built host-side; plain JSON so it crosses into a pod. */
export function toolOwners(apis: { name: string }[], apiToolNames: string[], scripts: { name: string }[]): Record<string, string> {
  const out: Record<string, string> = {};
  // Longest API name first, so `crm_admin`'s operations are not claimed by `crm`.
  const byLength = [...apis].sort((a, b) => b.name.length - a.name.length);
  for (const sdk of apiToolNames) {
    const local = sdk.replace(/^mcp__foldrun_apis__/, "");
    const owner = byLength.find((a) => local === `call_${a.name}` || local.startsWith(`${a.name}_`));
    if (owner) out[sdk] = owner.name;
  }
  for (const s of scripts) out[`mcp__foldrun_scripts__${s.name}`] = s.name;
  return out;
}

/**
 * Every key one call counts under, `calls` included. Pure: the SDK's tool
 * name, its input, and the owners map.
 */
export function limitKeysFor(toolName: string, input: Record<string, unknown> | undefined, owners: Record<string, string> = {}): string[] {
  const keys = [TOTAL_KEY];
  const webAction = (action: unknown) => {
    keys.push("web");
    const a = typeof action === "string" ? action.trim().toLowerCase() : "";
    if (a) keys.push(`web.${a}`);
  };
  // A model provider's own search or fetch, standing in for the web tool's.
  if (toolName === "WebSearch") { webAction("search"); return keys; }
  if (toolName === "WebFetch") { webAction("fetch"); return keys; }
  if ((DELEGATE_TOOLS as readonly string[]).includes(toolName)) return keys;
  const owner = owners[toolName];
  const mcp = /^mcp__(.+?)__(.+)$/.exec(toolName);
  const name = owner
    ?? (mcp
      ? mcp[1] === "foldrun_scripts" ? mcp[2]
        : mcp[1] === "foldrun_apis" ? mcp[2].replace(/^call_/, "")
        : mcp[1] === "foldrun_agents" ? mcp[2].replace(/^consult_/, "")
        : PLATFORM_SERVERS[mcp[1]] ?? mcp[1]
      : null);
  if (name !== null) {
    if (normKey(name) === "web") webAction(input?.action);
    else keys.push(name);
    return keys;
  }
  const group = BUILTIN_GROUP[toolName];
  if (group) keys.push(group);
  keys.push(toolName);
  return keys;
}

export interface LimitRefusal {
  key: string;
  used: number;
  limit: number;
  message: string;
}

/**
 * One step's counts. `take` checks every key the call counts under and
 * either refuses — counting nothing — or counts it under all of them.
 */
export class CallCounter {
  private readonly limits = new Map<string, { key: string; limit: number }>();
  private readonly used = new Map<string, number>();
  refused = 0;

  constructor(limits: Limits | undefined | null) {
    for (const [k, n] of Object.entries(limits ?? {})) this.limits.set(normKey(k), { key: k, limit: n });
  }

  get active(): boolean {
    return this.limits.size > 0;
  }

  take(keys: string[]): LimitRefusal | null {
    const norm = [...new Set(keys.map(normKey))];
    for (const k of norm) {
      const l = this.limits.get(k);
      if (!l) continue;
      const used = this.used.get(k) ?? 0;
      if (used >= l.limit) {
        this.refused++;
        return {
          key: l.key, used, limit: l.limit,
          message: `limit reached: ${l.key} ${used} of ${l.limit} in this step — work with what you have, or say what more you would need`,
        };
      }
    }
    for (const k of norm) this.used.set(k, (this.used.get(k) ?? 0) + 1);
    return null;
  }

  /** Give back a call that was counted and then refused by a later check. */
  refund(keys: string[]): void {
    for (const k of new Set(keys.map(normKey))) {
      const n = this.used.get(k) ?? 0;
      if (n > 0) this.used.set(k, n - 1);
    }
  }

  count(key: string): number {
    return this.used.get(normKey(key)) ?? 0;
  }

  /** `limits: web.search 40/40, crm 3/20` — null when no limits are set. */
  summary(): string | null {
    if (!this.active) return null;
    const parts = [...this.limits.entries()].map(([k, l]) => `${l.key} ${this.used.get(k) ?? 0}/${l.limit}`);
    return `limits: ${parts.join(", ")}${this.refused ? ` — ${this.refused} call${this.refused === 1 ? "" : "s"} refused` : ""}`;
  }
}

/**
 * Keys an agent's `limits:` names that it cannot use. `known` is every tool
 * name in reach (built-ins, the workspace's and library's tools, this
 * agent's APIs, scripts and MCP servers); `granted` is what this agent's
 * `tools:` (and `apis:`, `scripts:`, `mcpServers:`) gives it. A key that
 * names nothing is an error; a real tool this agent does not hold is a
 * warning — the limit is harmless, and probably a leftover.
 */
export function limitKeyProblems(
  limits: Limits,
  ctx: { known: Iterable<string>; granted: Iterable<string> },
): { level: "error" | "warn"; message: string }[] {
  const out: { level: "error" | "warn"; message: string }[] = [];
  const builtinKeys = ["read", "write", "code", ...Object.keys(BUILTIN_GROUP), "TodoWrite", "search", "history", "desks", "ask", "web"];
  const known = new Set([...builtinKeys, ...ctx.known].map(normKey));
  const granted = new Set([...ctx.granted].flatMap((g) => {
    const n = normKey(g);
    // A group grants its members' keys, and `write` holds Read too.
    if (n === "write") return [n, "read", "Read", "Write", "Edit", "MultiEdit", "NotebookEdit", "Glob", "Grep"];
    if (n === "read") return [n, "Read", "Glob", "Grep"];
    if (n === "code") return [n, "Bash"];
    if (BUILTIN_GROUP[g]) return [n, BUILTIN_GROUP[g]];
    return [n];
  }).map(normKey));
  for (const key of Object.keys(limits)) {
    if (key === TOTAL_KEY) continue;
    const base = key.startsWith("web.") ? "web" : key;
    const n = normKey(base);
    if (!known.has(n)) {
      const valid = [TOTAL_KEY, "web", ...WEB_ACTIONS.map((a) => `web.${a}`), ...[...new Set([...ctx.granted].map(String))].filter((g) => g !== "web")];
      out.push({ level: "error", message: `limits: ${key} — not a tool this agent could call. The keys: ${[...new Set(valid)].join(", ")}.` });
    } else if (!granted.has(n)) {
      out.push({ level: "warn", message: `limits: ${key} — this agent is not granted ${base}, so the limit never applies` });
    }
  }
  return out;
}

/**
 * A flow step's `limits:` option, written on one line:
 * `limits: {web.search: 10, calls: 50}` (the braces are optional). Read by
 * hand rather than as YAML, because `web.search` is a plain key here and one
 * line is all a step option has.
 */
export function parseStepLimits(text: string): { limits: Limits; problems: string[] } {
  const body = text.trim().replace(/^\{/, "").replace(/\}$/, "").trim();
  if (!body) return { limits: {}, problems: ["a block of tool: count on one line, e.g. {web.search: 10, calls: 50}"] };
  const raw: Record<string, unknown> = {};
  const problems: string[] = [];
  for (const part of body.split(",")) {
    const m = /^\s*([^:\s]+)\s*:\s*(\S+)\s*$/.exec(part);
    if (!m) {
      problems.push(`"${part.trim()}" is not tool: count`);
      continue;
    }
    raw[m[1]] = m[2];
  }
  const read = readLimits(raw, "limits");
  return { limits: read.limits, problems: [...problems, ...read.problems.map((p) => p.replace(/^limits: /, ""))] };
}
