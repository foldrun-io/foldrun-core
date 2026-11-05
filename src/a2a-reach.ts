// What an agent behind a published flow can reach, and what a change to it
// widens (FOL-112, 5 Nov 2026).
//
// A flow published over A2A takes its first input from an outside caller,
// and the last step's answer goes back to that caller. So the answer is a way
// out: an agent that holds a secret in its sandbox and may run code can be
// told to `echo $TOKEN` into its reply, with no network at all. Kousha's A2A
// e2e on dev (v2026.11.01.6) found two gaps around that:
//
//   N1  check said nothing about such a flow — only the model's refusal kept
//       the test secret in. Now the scanner warns, and the platform refuses
//       to publish a flow (or to make a published one) whose agent holds a
//       secret and runs code, unless an admin lists that agent under the
//       flow's `a2a.accept_risk` (an admin's key, like all of `a2a:`).
//   N2  publishing is an admin's, but an editor could then give the agent
//       behind the flow more tools, secrets or network. Now a change that
//       widens an agent of a published flow is an admin's too.
//
// Pure — fronts in, facts out, no fs — so the scanner (files), the platform's
// write doors (before/after trees) and the dashboard read the same answer.

import { refList, refNames } from "./refs.ts";
import { TOOL_MAP, ownToolNames } from "./tool-names.ts";
import { resolveNetwork, type NetworkLevel } from "./network.ts";
import { parseRemotes } from "./a2a-remotes.ts";
import { isA2aPublished, parseA2aPublish } from "./a2a-publish.ts";
import { configMatter } from "./matter.ts";
import { readBrowseSettings, readSearchSettings, resolveSearch, webConfig } from "./providers.ts";
import { NEWER_ACTIONS, resolveActionApi } from "./web-actions.ts";
import { parseFlow, type FlowInfo } from "./store.ts";

/** What one agent may reach, as a run would grant it. Every list sorted. */
export interface AgentReach {
  /** Tool names granted: built-in groups expanded to the SDK's names, the
   *  author's own tools by name; `disallowedTools` taken away (by the names
   *  it lists, against the expanded ones — the runner's order); a `{X: ask}`
   *  entry (approval mode) is not a grant. `permissionMode: plan` leaves the
   *  read group and the author's own tools (the runner keeps API and script
   *  tools in plan mode), never Bash. */
  tools: string[];
  /** Bash is granted: it can run any code in its sandbox — read its
   *  environment, the files, and put what it found in its answer. */
  runsCode: boolean;
  /** Secrets that reach its sandbox's environment, as runner.ts declares
   *  them: its own `secrets:`; the ones its `apis:` name as `${NAME}`; a
   *  granted folder tool's `secrets:` and `${NAME}`s, when that tool's file
   *  is known; and the key of a web provider its (or its workspace's) `web:`
   *  names — `web: {search: exa}` declares EXA_API_KEY. A secret bound to sites is
   *  still counted: the scanner cannot see binding, and the binding is the
   *  vault's, changed elsewhere. */
  secrets: string[];
  network: { level: NetworkLevel; hosts: string[] };
  /** name → the spec as written (stable JSON): a changed spec can point
   *  somewhere new, so it counts as a change. */
  apis: Record<string, string>;
  mcpServers: Record<string, string>;
  /** name → card URL. */
  remotes: Record<string, string>;
  /** name → the entry as written (stable JSON): a new script, or a changed
   *  command, is a change. */
  scripts: Record<string, string>;
  /** The author's own folder tools named in `tools:` → their definition as
   *  written (stable JSON), when the file is known: a changed base URL or
   *  MCP server is a change, as an inline API's is. */
  toolSpecs: Record<string, string>;
  subagents: string[];
  /** Hooks that run at its tool calls — its own and its workspace's. Fewer
   *  is wider: a hook is a gate. */
  hooks: string[];
  /** permissionMode: plan — read-only until a person approves. */
  plan: boolean;
  /** sandbox: own — delegated to, it runs in its own sandbox with its own
   *  tools, secrets and network rather than inside its parent's caps. */
  ownSandbox: boolean;
}

export interface ReachContext {
  /** The workspace AGENTS.md frontmatter (network:, hooks:). */
  workspace?: Record<string, unknown> | null;
  /** The account AGENTS.md's `network:`. */
  accountNetwork?: unknown;
  /** A folder tool's frontmatter by name, when known — for its `secrets:`. */
  toolDefs?: ReadonlyMap<string, Record<string, unknown>>;
}

const SECRET_NAME = /^[A-Z][A-Z0-9_]*$/;

/** Same value, whatever order a mapping's keys were written in. */
function stable(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  const o = value as Record<string, unknown>;
  return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${stable(o[k])}`).join(",")}}`;
}

const sorted = (xs: Iterable<string>) => [...new Set(xs)].sort();
const listOf = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : typeof v === "string" && v.trim() ? v.split(",").map((s) => s.trim()).filter(Boolean) : []);

/** What this agent's frontmatter grants, read the way runner.ts does. */
export function agentReach(front: Record<string, unknown>, ctx: ReachContext = {}): AgentReach {
  const plan = front.permissionMode === "plan";
  const denied = new Set(refNames(front.disallowedTools));
  const granted: string[] = [];
  const own: string[] = [];
  for (const ref of refList(front.tools)) {
    if (ref.mode === "ask") continue; // approval mode: the runner does not grant it
    if (!ref.linked && TOOL_MAP[ref.name]) granted.push(...TOOL_MAP[ref.name]!);
    else {
      granted.push(ref.name);
      if (ref.linked || !TOOL_MAP[ref.name]) own.push(ref.name);
    }
  }
  // `install` is every agent's unless plan mode or disallowedTools: [install]
  // takes it away (runner.ts, install-tool.ts): dropping that deny widens.
  if (!plan) granted.push("install");
  const tools = plan ? sorted([...TOOL_MAP.read!, ...own].filter((t) => !denied.has(t) && t !== "Bash" && t !== "install")) : sorted(granted.filter((t) => !denied.has(t)));
  const runsCode = tools.includes("Bash");

  const apis: Record<string, string> = {};
  if (Array.isArray(front.apis)) {
    front.apis.forEach((a, i) => {
      const name = a && typeof a === "object" && typeof (a as { name?: unknown }).name === "string" ? (a as { name: string }).name : `#${i + 1}`;
      apis[name] = stable(a);
    });
  }
  const mcpServers: Record<string, string> = {};
  if (front.mcpServers && typeof front.mcpServers === "object" && !Array.isArray(front.mcpServers)) {
    for (const [k, v] of Object.entries(front.mcpServers as Record<string, unknown>)) mcpServers[k] = stable(v);
  }
  const remotes: Record<string, string> = {};
  for (const r of parseRemotes(front.remotes)) remotes[r.name] = r.card;

  const secrets = new Set(listOf(front.secrets));
  const named = (v: unknown) => {
    for (const m of (JSON.stringify(v ?? null) ?? "").matchAll(/\$\{([A-Z][A-Z0-9_]*)\}/g)) secrets.add(m[1]!);
  };
  named(front.apis);
  // Every folder tool `tools:` names — ask-mode and disallowed ones too: the
  // runner resolves them (ownToolNames) and loads their secrets into the
  // step's environment before it filters what may be called (Codex review).
  const toolSpecs: Record<string, string> = {};
  for (const name of ownToolNames(front)) {
    const def = ctx.toolDefs?.get(name);
    if (!def) continue;
    toolSpecs[name] = stable(def);
    for (const s of listOf(def.secrets)) if (SECRET_NAME.test(s)) secrets.add(s);
    named(def);
  }
  for (const s of webSecrets(front, ctx.workspace ?? undefined)) secrets.add(s);

  const scripts: Record<string, string> = {};
  for (const [i, e] of (Array.isArray(front.scripts) ? front.scripts : listOf(front.scripts)).entries()) {
    const name = typeof e === "string" ? e : e && typeof e === "object" && typeof (e as { name?: unknown }).name === "string" ? (e as { name: string }).name : `#${i + 1}`;
    scripts[name] = stable(e);
  }

  // The runner's own test (runner.ts, the network: lease): the web tool
  // granted, and fetch or browse among its actions (all, when unsaid).
  let actions: string[] | null = null;
  try {
    actions = webConfig(front, ctx.workspace ?? undefined).actions;
  } catch {
    actions = null;
  }
  const readsWeb = tools.includes("web") && (!actions || actions.some((a) => a === "fetch" || a === "browse"));
  // Hosts a grant implies (an API's base, an MCP server's url, a remote's
  // card): the runner adds them to the list, so a new one is a wider list.
  const implied: string[] = [];
  const hostOf = (u: unknown) => {
    if (typeof u !== "string") return;
    try {
      implied.push(new URL(u).hostname);
    } catch {
      // not a URL: nothing implied
    }
  };
  for (const a of Array.isArray(front.apis) ? front.apis : []) hostOf((a as { base?: unknown } | null)?.base);
  for (const m of Object.values((front.mcpServers && typeof front.mcpServers === "object" ? front.mcpServers : {}) as Record<string, { url?: unknown } | null>)) hostOf(m?.url);
  for (const r of Object.values(remotes)) hostOf(r);
  for (const name of Object.keys(toolSpecs)) {
    const def = ctx.toolDefs?.get(name);
    hostOf(def?.base);
    hostOf(def?.url);
  }
  const net = resolveNetwork({ account: ctx.accountNetwork, workspace: ctx.workspace?.network, agent: front.network, readsWeb, implied });

  return {
    tools,
    runsCode,
    secrets: sorted([...secrets].filter((s) => s.trim())),
    network: { level: net.level, hosts: sorted(net.hosts) },
    apis,
    mcpServers,
    remotes,
    scripts,
    toolSpecs,
    subagents: sorted(refNames(front.subagents)),
    hooks: sorted([...refNames(front.hooks), ...refNames(ctx.workspace?.hooks)]),
    plan,
    ownSandbox: front.sandbox === "own",
  };
}

/** The vault names a `web:` block declares — runner.ts's `declared` list:
 *  a direct search, fetch or browse API's key, a newer action's provider
 *  key, your own proxy for a vendor's session. Read loosely: a block that
 *  does not resolve declares nothing (check reports it). */
function webSecrets(front: Record<string, unknown>, workspace?: Record<string, unknown>): string[] {
  try {
    const web = webConfig(front, workspace);
    const out: string[] = [];
    const browse = readBrowseSettings(web.raw.browse);
    const proxy = (browse.settings as { vendor_session?: { proxy?: unknown } }).vendor_session?.proxy;
    if (proxy && typeof proxy === "object" && typeof (proxy as { own?: unknown }).own === "string") out.push((proxy as { own: string }).own);
    for (const c of [resolveSearch(readSearchSettings(web.raw.search).rest, "search"), resolveSearch(web.raw.fetch, "fetch"), resolveSearch(browse.rest, "browse")]) {
      if (c.shape === "direct" && c.secret && !c.error) out.push(c.secret);
    }
    for (const action of NEWER_ACTIONS) {
      const c = resolveActionApi(action, web.raw[action]) as { provider?: string | null; secret?: string };
      if (c.provider && c.secret) out.push(c.secret);
    }
    return out.filter((n) => SECRET_NAME.test(n));
  } catch {
    return [];
  }
}

const OPENNESS: Record<NetworkLevel, number> = { none: 0, trusted: 1, open: 2 };

/**
 * What `after` can reach that `before` could not, one phrase each — empty
 * when nothing widened. `before` null: the agent was not there (or not behind
 * the flow), so everything it can reach is new.
 */
export function reachWidening(before: AgentReach | null, after: AgentReach): string[] {
  const out: string[] = [];
  const added = (what: string, a: string[], b: string[]) => {
    const extra = b.filter((x) => !a.includes(x));
    if (extra.length) out.push(`${what} ${extra.join(", ")}`);
  };
  const b = before;
  if (!b) {
    if (after.tools.length) out.push(`tools ${after.tools.join(", ")}`);
    if (after.secrets.length) out.push(`secrets ${after.secrets.join(", ")}`);
    if (after.network.level !== "none") out.push(`network ${after.network.level}`);
    for (const k of ["apis", "mcpServers", "remotes"] as const) if (Object.keys(after[k]).length) out.push(`${k} ${Object.keys(after[k]).sort().join(", ")}`);
    if (Object.keys(after.scripts).length) out.push(`scripts ${Object.keys(after.scripts).sort().join(", ")}`);
    if (after.subagents.length) out.push(`subagents ${after.subagents.join(", ")}`);
    return out.length ? out : ["a new agent behind the flow"];
  }
  added("tools", b.tools, after.tools);
  added("secrets", b.secrets, after.secrets);
  if (OPENNESS[after.network.level] > OPENNESS[b.network.level]) out.push(`network ${b.network.level} → ${after.network.level}`);
  else if (after.network.level !== "open") added("network sites", b.network.hosts, after.network.hosts);
  for (const k of ["apis", "mcpServers", "remotes", "scripts", "toolSpecs"] as const) {
    const changed = Object.keys(after[k]).filter((n) => b[k][n] !== after[k][n]).sort();
    // A new folder tool is already a new tool above; here only a changed one.
    const said = k === "toolSpecs" ? changed.filter((n) => n in b[k]) : changed;
    if (said.length) out.push(`${k === "toolSpecs" ? "tools" : k} ${said.map((n) => (n in b[k] ? `${n} (changed)` : n)).join(", ")}`);
  }
  added("subagents", b.subagents, after.subagents);
  const gone = b.hooks.filter((h) => !after.hooks.includes(h));
  if (gone.length) out.push(`hooks removed: ${gone.join(", ")}`);
  if (b.plan && !after.plan) out.push("permissionMode: plan removed");
  if (!b.ownSandbox && after.ownSandbox) out.push("sandbox: own");
  return out;
}

/**
 * Every agent a run of this flow may put to work: each step's agent, its
 * `on-fail:` rescuer and its `delegate:` choices; the steps of every
 * `[[flow:…]]` it runs, all the way down; and the sub-agents each of those
 * may delegate to. A sub-agent's tools are capped by its parent's in a shared
 * sandbox but not with `sandbox: own`, so each one counts. `subagentsOf`
 * names an agent's `subagents:` (null: no such agent); `flowOf` reads another
 * flow by name (null: none). Sorted.
 */
export function flowAgents(
  flow: Pick<FlowInfo, "steps">,
  subagentsOf: (agent: string) => string[] | null,
  flowOf: (name: string) => Pick<FlowInfo, "steps"> | null = () => null,
): string[] {
  const seen = new Set<string>();
  const queue: string[] = [];
  const flowsSeen = new Set<string>();
  const walk = (f: Pick<FlowInfo, "steps">) => {
    for (const s of f.steps ?? []) {
      if (s.subflow) {
        if (flowsSeen.has(s.subflow)) continue;
        flowsSeen.add(s.subflow);
        const sub = flowOf(s.subflow);
        if (sub) walk(sub);
        continue;
      }
      for (const n of [s.agent, ...(s.onFail ? [s.onFail] : []), ...(s.delegate ?? [])]) if (n) queue.push(n);
    }
  };
  walk(flow);
  while (queue.length) {
    const n = queue.shift()!;
    if (seen.has(n)) continue;
    seen.add(n);
    for (const s of subagentsOf(n) ?? []) if (!seen.has(s)) queue.push(s);
  }
  return [...seen].sort();
}

/** The agents an admin accepted holding a secret while running code in this
 *  published flow (`a2a.accept_risk`). */
export function acceptedRisk(a2a: unknown): string[] {
  return parseA2aPublish(a2a)?.acceptRisk ?? [];
}

/** Is this flow open to A2A callers? (Its parsed `a2a:`.) */
export function publishedFlow(flow: Pick<FlowInfo, "a2a">): boolean {
  return isA2aPublished(flow.a2a);
}

/** One agent of a published flow that holds a secret and may run code. */
export interface SecretCodeExposure {
  agent: string;
  secrets: string[];
  accepted: boolean;
}

/** The agents of a published flow that hold a secret and run code — each
 *  one a way for a caller to have the secret put in the answer. */
export function secretCodeExposures(agents: string[], reachOf: (agent: string) => AgentReach | null, accepted: string[]): SecretCodeExposure[] {
  const out: SecretCodeExposure[] = [];
  for (const a of agents) {
    const r = reachOf(a);
    if (!r || !r.runsCode || !r.secrets.length) continue;
    out.push({ agent: a, secrets: r.secrets, accepted: accepted.includes(a) });
  }
  return out;
}

/** The sentence a refusal and the dashboard say about one exposure. */
export function secretCodeSentence(flow: string, e: Pick<SecretCodeExposure, "agent" | "secrets">): string {
  const held = `${e.secrets.slice(0, 3).join(", ")}${e.secrets.length > 3 ? ", …" : ""}`;
  return `${e.agent} holds ${held} and can run code (Bash), and ${flow} is published over A2A — its answer goes back to the outside caller, who can ask for the secret in it`;
}

// ── a whole tree: the scanner's files, a write's before and after ───────────

export interface TreeFile {
  /** Workspace-relative (`agents/x/agent.md`), or `library/…` for the
   *  account's library. */
  path: string;
  content: string;
}

/** The A2A facts of one workspace tree. */
export interface A2aTree {
  /** Every flow that parses, by name. */
  flows: Map<string, { file: string; info: FlowInfo }>;
  /** An agent's reach, or null when the tree has no such agent. */
  reachOf: (agent: string) => AgentReach | null;
  /** The agents a run of this flow may put to work (flowAgents). */
  agentsOf: (flow: string) => string[];
}

/** Frontmatter as the runtime reads an agent, a flow or AGENTS.md (job
 *  blocks folded): null when there is none or YAML cannot read it. */
function frontOf(content: string): Record<string, unknown> | null {
  if (!/^\uFEFF?---\r?\n/.test(content)) return null;
  try {
    const d = configMatter(content).data;
    return d && typeof d === "object" && !Array.isArray(d) ? (d as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const AGENT_FILE = /^agents\/([^/]+)\/agent\.md$/;
const CLAUDE_AGENT = /^\.(?:claude|agents)\/agents\/([^/]+)\.md$/;
const FLOW_FILE = /^flows\/([^/]+)\.md$/;
const TOOL_FILE = /^(?:library\/)?tools\/(?:([^/]+)\/tool|([^/]+))\.md$/;

/**
 * Read a workspace tree (and, mixed in under `library/`, the account's
 * library tools) as A2A sees it. An agent at agents/<n>/agent.md wins over a
 * Claude Code file of the same name, as a deploy imports it; a workspace
 * tool wins over the library's.
 */
export function a2aTree(files: TreeFile[], opts: { accountNetwork?: unknown } = {}): A2aTree {
  const agents = new Map<string, Record<string, unknown>>();
  const claude = new Map<string, Record<string, unknown>>();
  const tools = new Map<string, Record<string, unknown>>();
  const libTools = new Map<string, Record<string, unknown>>();
  const flows = new Map<string, { file: string; info: FlowInfo }>();
  let workspace: Record<string, unknown> | null = null;
  let project: Record<string, unknown> | null = null;
  for (const f of files) {
    const rel = f.path.replaceAll("\\", "/").replace(/^\.\//, "");
    let m: RegExpExecArray | null;
    if (rel === "AGENTS.md") workspace = frontOf(f.content) ?? {};
    else if (rel === "project.md") project = frontOf(f.content) ?? {};
    else if ((m = AGENT_FILE.exec(rel))) agents.set(m[1]!, frontOf(f.content) ?? {});
    else if ((m = CLAUDE_AGENT.exec(rel))) claude.set(m[1]!, frontOf(f.content) ?? {});
    else if ((m = FLOW_FILE.exec(rel))) {
      try {
        const info = parseFlow(`${m[1]}.md`, f.content);
        if (!flows.has(info.name)) flows.set(info.name, { file: rel, info });
      } catch {
        // a flow that does not parse runs nothing; check reports it
      }
    } else if ((m = TOOL_FILE.exec(rel))) {
      const d = frontOf(f.content) ?? {};
      const name = typeof d.name === "string" && d.name.trim() ? d.name.trim() : (m[1] ?? m[2])!;
      (rel.startsWith("library/") ? libTools : tools).set(name, d);
    }
  }
  for (const [n, d] of claude) if (!agents.has(n)) agents.set(n, d);
  const toolDefs = new Map([...libTools, ...tools]);
  const ws = workspace ?? project;
  const reaches = new Map<string, AgentReach>();
  const reachOf = (agent: string): AgentReach | null => {
    const front = agents.get(agent);
    if (!front) return null;
    let r = reaches.get(agent);
    if (!r) reaches.set(agent, (r = agentReach(front, { workspace: ws, accountNetwork: opts.accountNetwork, toolDefs })));
    return r;
  };
  const agentsOf = (flow: string): string[] => {
    const f = flows.get(flow);
    if (!f) return [];
    return flowAgents(f.info, (a) => (agents.has(a) ? reachOf(a)!.subagents : null), (n) => flows.get(n)?.info ?? null);
  };
  return { flows, reachOf, agentsOf };
}

/** One published flow's secret-and-code exposures in a tree (empty when it
 *  is not published, or has none). */
export function flowSecretCode(tree: A2aTree, flow: string): SecretCodeExposure[] {
  const f = tree.flows.get(flow);
  if (!f || !isA2aPublished(f.info.a2a)) return [];
  return secretCodeExposures(tree.agentsOf(flow), tree.reachOf, f.info.a2a.acceptRisk ?? []);
}

/** What a write does to the flows published over A2A, compared tree to tree. */
export interface A2aWriteEffect {
  /** An agent behind a flow published before or after the write that can
   *  reach more after it: an admin's change (N2). */
  widened: { flow: string; agent: string; what: string[] }[];
  /** An agent of a flow published after the write that holds a secret and
   *  runs code, with no `accept_risk` entry, and did not before the write
   *  (a new exposure): refused for everyone (N1). One already there is the
   *  serve path's to refuse, not a write's: a deploy that leaves it alone
   *  still goes through. */
  unaccepted: { flow: string; agent: string; secrets: string[] }[];
  /** `accept_risk` entries the write adds, with what each agent holds then —
   *  the audit's record of what was accepted. */
  accepted: { flow: string; agent: string; secrets: string[] }[];
  /** `accept_risk` names the write adds that no agent of the flow answers
   *  to: refused, so an entry never waits to cover whatever is given that
   *  name next. */
  stale: { flow: string; agents: string[] }[];
}

export function a2aWriteEffect(before: A2aTree, after: A2aTree): A2aWriteEffect {
  const out: A2aWriteEffect = { widened: [], unaccepted: [], accepted: [], stale: [] };
  const names = [...new Set([...before.flows.keys(), ...after.flows.keys()])].sort();
  for (const flow of names) {
    const b = before.flows.get(flow);
    const a = after.flows.get(flow);
    const pubBefore = Boolean(b && isA2aPublished(b.info.a2a));
    const pubAfter = Boolean(a && isA2aPublished(a.info.a2a));
    if (!pubBefore && !pubAfter) continue;
    const agentsBefore = pubBefore ? before.agentsOf(flow) : [];
    const agentsAfter = a ? after.agentsOf(flow) : [];
    // N2 — only a flow that was published already: publishing one is an
    // admin's change by itself (a2a: is policy).
    if (pubBefore && a) {
      for (const agent of agentsAfter) {
        const ra = after.reachOf(agent);
        if (!ra) continue;
        const rb = agentsBefore.includes(agent) ? before.reachOf(agent) : null;
        const what = reachWidening(rb, ra);
        if (what.length) out.widened.push({ flow, agent, what });
      }
    }
    if (!pubAfter || !a) continue;
    const accepted = a.info.a2a?.acceptRisk ?? [];
    const acceptedBefore = pubBefore ? (b!.info.a2a?.acceptRisk ?? []) : [];
    // Stale: a name the write adds that no agent of the flow answers to. One
    // left behind when a step went is not refused — an editor may remove a
    // step and cannot touch a2a: — and the next agent given that name behind
    // a published flow is a widening, an admin's change by itself.
    const listedBefore = b?.info.a2a?.acceptRisk ?? [];
    const stale = accepted.filter((n) => !agentsAfter.includes(n) && !listedBefore.includes(n));
    if (stale.length) out.stale.push({ flow, agents: stale });
    const had = new Set(pubBefore ? secretCodeExposures(agentsBefore, before.reachOf, []).map((e) => e.agent) : []);
    for (const e of secretCodeExposures(agentsAfter, after.reachOf, accepted)) {
      if (e.accepted) {
        if (!acceptedBefore.includes(e.agent)) out.accepted.push({ flow, agent: e.agent, secrets: e.secrets });
      } else if (!had.has(e.agent)) out.unaccepted.push({ flow, agent: e.agent, secrets: e.secrets });
    }
  }
  return out;
}
