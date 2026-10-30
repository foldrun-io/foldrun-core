// Hooks: a person's own code at the points every model's step passes through.
//
// A hook is a folder — `hooks/<name>/hook.md` (what it listens for) beside
// `run.mjs` (what it does) — in a workspace, or in the account library for
// every workspace. An agent turns one on with `hooks: [name]`; a workspace's
// or the account's AGENTS.md turns one on for every agent under it.
//
// Where they run, and why there: at foldrun's own dispatch, the step's
// PreToolUse / PostToolUse callbacks in step-exec.ts. Every model goes
// through that one loop — another provider's model is the same loop with the
// translator changing the wire format underneath — so one hook decides the
// same way on every model. Nothing here is tied to one provider's features
// (thinking blocks, effort, server tools).
//
// The contract, kept to what the established agent tools agree on (Claude
// Code, the Agent SDK, Cursor, Copilot, Gemini CLI): the event goes in as
// one JSON object on stdin, an answer comes back as one JSON object on
// stdout. Exit 0 with an answer; exit 2 denies with stderr as the reason
// (the common convention); anything else is a failure.
//
// Gates fail closed. A tool.call or step.start hook that throws, times out or
// answers with the wrong shape refuses the call — a guard that crashes must
// not become an open door. A watcher (tool.result, step.end) that fails is
// recorded and the step goes on: what it watches has already happened.
//
// A hook has no more reach than the agent: it runs as a child of the step,
// inside the step's own sandbox, in the agent's directory, with an
// environment stripped to the basics — no secrets, no model key.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import matter from "./matter.ts";

export const HOOK_EVENTS = ["tool.call", "tool.result", "step.start", "step.end"] as const;
export type HookEvent = (typeof HOOK_EVENTS)[number];

/** Events that decide something before it happens: a failure refuses. */
const GATES: ReadonlySet<HookEvent> = new Set(["tool.call", "step.start"]);

export const HOOK_TIMEOUT_DEFAULT = { gate: 30, watch: 60 } as const;
export const HOOK_TIMEOUT_MAX = 120;
export const HOOK_CODE_MAX = 100 * 1024;
const NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** A hook's name: its folder's name, never a path. */
export function isHookName(name: unknown): name is string {
  return typeof name === "string" && NAME.test(name);
}

export interface HookDef {
  name: string;
  /** The folder holding hook.md and run.mjs. */
  dir: string;
  scope: "workspace" | "account";
  on: HookEvent;
  /** `tool:` — which tools a tool.call / tool.result hook sees. Unset is all. */
  tool?: string;
  timeoutSec: number;
  description?: string;
  /** run.mjs as it was when the step started. The hook runs from this copy,
   *  so an agent that edits the file mid-step changes nothing that runs. */
  code: string;
}

/** Read hook.md, or say in one sentence why it is not a hook. */
export function readHookDef(dir: string, scope: HookDef["scope"]): HookDef | { error: string } {
  const name = path.basename(dir);
  if (!NAME.test(name)) return { error: `hooks/${name}: a hook's folder name is lowercase letters, digits and dashes` };
  const md = path.join(dir, "hook.md");
  if (!fs.existsSync(md)) return { error: `hooks/${name}: no hook.md` };
  if (!fs.existsSync(path.join(dir, "run.mjs"))) return { error: `hooks/${name}: no run.mjs beside hook.md` };
  let data: Record<string, unknown>;
  try {
    data = (matter(fs.readFileSync(md, "utf8")).data ?? {}) as Record<string, unknown>;
  } catch (err) {
    return { error: `hooks/${name}/hook.md: frontmatter does not parse (${(err as Error).message.split("\n")[0]})` };
  }
  const on = data.on;
  if (typeof on !== "string" || !(HOOK_EVENTS as readonly string[]).includes(on)) {
    return { error: `hooks/${name}/hook.md: on: must be one of ${HOOK_EVENTS.join(", ")}${on === "run.end" ? " (run.end is not available yet)" : ""}` };
  }
  const event = on as HookEvent;
  if (data.tool !== undefined && (typeof data.tool !== "string" || !data.tool.trim())) {
    return { error: `hooks/${name}/hook.md: tool: is a tool name or pattern, like Bash, Write|Edit or mcp__*` };
  }
  if (data.tool !== undefined && event !== "tool.call" && event !== "tool.result") {
    return { error: `hooks/${name}/hook.md: tool: only means something on tool.call and tool.result` };
  }
  // It runs through `node --eval`, one argument, which Linux caps at 128 KB.
  const code = fs.readFileSync(path.join(dir, "run.mjs"), "utf8");
  if (Buffer.byteLength(code) > HOOK_CODE_MAX) {
    return { error: `hooks/${name}/run.mjs is ${Math.round(Buffer.byteLength(code) / 1024)} KB — a hook is one small self-contained module, at most ${HOOK_CODE_MAX / 1024} KB` };
  }
  const deflt = GATES.has(event) ? HOOK_TIMEOUT_DEFAULT.gate : HOOK_TIMEOUT_DEFAULT.watch;
  const timeout = data.timeout === undefined ? deflt : Number(data.timeout);
  if (!Number.isFinite(timeout) || timeout <= 0 || timeout > HOOK_TIMEOUT_MAX) {
    return { error: `hooks/${name}/hook.md: timeout: is seconds, 1 to ${HOOK_TIMEOUT_MAX}` };
  }
  return {
    name,
    dir,
    scope,
    on: event,
    ...(typeof data.tool === "string" ? { tool: data.tool.trim() } : {}),
    timeoutSec: timeout,
    ...(typeof data.description === "string" ? { description: data.description } : {}),
    code,
  };
}

/** Every hook folder in a hooks/ directory. */
export function listHookDirs(hooksDir: string): string[] {
  if (!fs.existsSync(hooksDir)) return [];
  return fs.readdirSync(hooksDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith("."))
    .map((d) => path.join(hooksDir, d.name))
    .sort();
}

/** The names a frontmatter `hooks:` holds — a list, or one name. */
export function hookNames(raw: unknown): string[] {
  const list = Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split(",") : [];
  return list.map((x) => String(x).trim()).filter(Boolean);
}

/**
 * The hooks one agent runs, in order: what the account turned on, then the
 * workspace, then the agent itself, each name once. A name resolves to the
 * workspace's own hooks/ first, then the library's. Names that resolve to
 * nothing come back in `missing` — `foldrun check` errors on them, and a run
 * refuses to start the step rather than run unguarded.
 */
export function resolveHooks(args: {
  workspaceRoot: string;
  libraryRoot: string;
  names: string[];
}): { hooks: HookDef[]; missing: string[]; errors: string[] } {
  const hooks: HookDef[] = [];
  const missing: string[] = [];
  const errors: string[] = [];
  const seen = new Set<string>();
  for (const name of args.names) {
    if (seen.has(name)) continue;
    seen.add(name);
    // Checked before the name is joined to anything (30 Oct 2026): readHookDef
    // tested only basename(dir), so `../../<tenant>/workspaces/<ws>/hooks/<h>`
    // passed, and the hook test route answered which folders exist anywhere
    // on the server — on a laptop it would have run that run.mjs. An error,
    // not missing: a step refuses either way, and the name is the problem.
    if (!isHookName(name)) {
      errors.push(`"${name}" is not a hook name — lowercase letters, digits and dashes (the hook's folder name)`);
      continue;
    }
    const own = path.join(args.workspaceRoot, "hooks", name);
    const shared = path.join(args.libraryRoot, "hooks", name);
    const dir = fs.existsSync(own) ? own : fs.existsSync(shared) ? shared : null;
    if (!dir) { missing.push(name); continue; }
    const def = readHookDef(dir, dir === own ? "workspace" : "account");
    if ("error" in def) errors.push(def.error);
    else hooks.push(def);
  }
  return { hooks, missing, errors };
}

/**
 * Does `pattern` name this tool? Alternatives split on `|`, `*` matches any
 * run of characters. A pattern without `__` also matches a tool's short
 * name, so `web` catches `mcp__foldrun_scripts__web` and `Bash` catches Bash.
 */
export function matchesTool(pattern: string | undefined, tool: string): boolean {
  if (!pattern) return true;
  const short = tool.includes("__") ? tool.slice(tool.lastIndexOf("__") + 2) : tool;
  return pattern.split("|").map((p) => p.trim()).filter(Boolean).some((p) => {
    const re = new RegExp(`^${p.replace(/[.+?^${}()[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`);
    return re.test(tool) || (!p.includes("__") && re.test(short));
  });
}

/** What one hook said, normalised. */
export interface HookAnswer {
  ok: boolean;
  /** tool.call */
  decision?: "allow" | "deny";
  reason?: string;
  input?: Record<string, unknown>;
  /** step.start */
  context?: string;
  /** step.end */
  reply?: string;
  /** tool.result / anything: a line for the trail */
  note?: string;
  /** Why it failed — threw, timed out, wrong shape. */
  failure?: string;
  ms: number;
}

/** Only these reach a hook's process: enough to run node, nothing to act with. */
const PASSED_ENV = ["PATH", "LANG", "LC_ALL", "TZ", "TMPDIR", "NODE_PATH"];

/** One empty home per hook name, made once: a hook reads no dotfile the
 *  step's own home holds (a CLI login, a cached token). */
function hookHome(hook: HookDef): string {
  const dir = path.join(os.tmpdir(), "foldrun-hook-home", hook.name);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

export function hookEnv(from: Record<string, string | undefined>, hook: HookDef): Record<string, string> {
  const env: Record<string, string> = {};
  for (const k of PASSED_ENV) if (from[k]) env[k] = from[k]!;
  env.HOME = hookHome(hook);
  env.FOLDRUN_HOOK = hook.name;
  env.FOLDRUN_HOOK_EVENT = hook.on;
  return env;
}

/** Run one hook on one event. Never throws: a failure is an answer. */
export async function runHook(
  hook: HookDef,
  event: Record<string, unknown>,
  opts: { cwd: string; env: Record<string, string | undefined>; node?: string },
): Promise<HookAnswer> {
  const started = Date.now();
  const done = (a: Omit<HookAnswer, "ms">): HookAnswer => ({ ...a, ms: Date.now() - started });
  return new Promise((resolve) => {
    let out = "";
    let err = "";
    let settled = false;
    const finish = (a: Omit<HookAnswer, "ms">) => { if (!settled) { settled = true; resolve(done(a)); } };
    // Typed: untyped, a stricter tsc (foldrun-web compiles this file) narrows
    // it to never after the catch that returns.
    let child: ChildProcessWithoutNullStreams;
    try {
      // From the copy taken at the start of the step, never the file: what
      // guards the step cannot be edited by the step. One self-contained
      // module — Node's built-ins only, no relative imports.
      child = spawn(opts.node ?? process.execPath, ["--input-type=module", "--eval", hook.code], {
        cwd: opts.cwd,
        // Cast: Next's typings (foldrun-web compiles this file) make NODE_ENV
        // required on ProcessEnv; a hook deliberately gets only hookEnv's keys.
        env: hookEnv(opts.env, hook) as NodeJS.ProcessEnv,
        stdio: ["pipe", "pipe", "pipe"],
        // Its own process group, so a timeout can kill what the hook started
        // too: SIGKILL to node alone left a `sleep` or a curl it spawned
        // running in the sandbox after the call had been refused.
        detached: process.platform !== "win32",
      });
    } catch (e) {
      return finish({ ok: false, failure: `could not start: ${(e as Error).message}` });
    }
    const killAll = () => {
      try { if (child.pid && process.platform !== "win32") process.kill(-child.pid, "SIGKILL"); else child.kill("SIGKILL"); }
      catch { try { child.kill("SIGKILL"); } catch { /* already gone */ } }
    };
    const timer = setTimeout(() => {
      killAll();
      finish({ ok: false, failure: `timed out after ${hook.timeoutSec}s` });
    }, hook.timeoutSec * 1000);
    // Keep the TAIL of each stream, not the head: the answer is the last
    // line of stdout and the reason the last lines of stderr, so a hook that
    // logged a megabyte first lost its answer under a head cap and failed.
    // Decoded by the stream, so a character split across two chunks is not
    // turned into replacement characters inside the JSON answer.
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (b: string) => { out += b; if (out.length > 1_000_000) out = out.slice(-1_000_000); });
    child.stderr.on("data", (b: string) => { err += b; if (err.length > 20_000) err = err.slice(-20_000); });
    child.on("error", (e: Error) => { clearTimeout(timer); finish({ ok: false, failure: `could not start: ${e.message}` }); });
    child.on("close", (code: number | null) => {
      clearTimeout(timer);
      // A hook is one shot: whatever it left running in the background goes
      // with it, rather than outlive the call it was asked about.
      if (!settled) killAll();
      const stderr = err.trim().split("\n").slice(-3).join(" ").slice(0, 500);
      if (code === 2) return finish({ ok: true, decision: "deny", reason: stderr || `${hook.name} refused it` });
      if (code !== 0) {
        // An uncaught throw ends stderr with stack frames and "Node.js vN":
        // the last three lines named neither the error nor its message.
        const lines = err.split("\n").map((l) => l.trim()).filter((l) => l && !/^Node\.js v\d/.test(l) && !/^at /.test(l));
        const thrown = [...lines].reverse().find((l) => /^[A-Za-z]*Error\b.*:/.test(l));
        const why = (thrown ?? lines.slice(-3).join(" ")).slice(0, 500);
        return finish({ ok: false, failure: `exited ${code ?? "on a signal"}${why ? `: ${why}` : ""}` });
      }
      finish(parseAnswer(hook.on, out));
    });
    child.stdin.on("error", () => {});
    child.stdin.end(JSON.stringify(event));
  });
}

/** The last JSON object a hook printed, checked against its event's shape. */
export function parseAnswer(on: HookEvent, stdout: string): Omit<HookAnswer, "ms"> {
  const lines = stdout.trim().split("\n").map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return { ok: true, decision: on === "tool.call" ? "allow" : undefined };
  let a: unknown;
  try { a = JSON.parse(lines[lines.length - 1]); } catch { return { ok: false, failure: "its last line of output is not JSON" }; }
  if (!a || typeof a !== "object" || Array.isArray(a)) return { ok: false, failure: "it answered with something other than a JSON object" };
  const o = a as Record<string, unknown>;
  const str = (k: string) => (o[k] === undefined ? undefined : typeof o[k] === "string" ? (o[k] as string) : null);
  const note = str("note");
  if (note === null) return { ok: false, failure: "note must be text" };
  if (on === "tool.call") {
    const decision = o.decision ?? "allow";
    if (decision !== "allow" && decision !== "deny") return { ok: false, failure: `decision must be allow or deny, not ${JSON.stringify(decision)}` };
    const reason = str("reason");
    if (reason === null) return { ok: false, failure: "reason must be text" };
    if (decision === "deny" && !reason) return { ok: false, failure: "a deny needs a reason — the model reads it" };
    if (o.input !== undefined && (!o.input || typeof o.input !== "object" || Array.isArray(o.input))) return { ok: false, failure: "input must be the tool's whole input, as an object" };
    return { ok: true, decision, ...(reason ? { reason } : {}), ...(o.input ? { input: o.input as Record<string, unknown> } : {}), ...(note ? { note } : {}) };
  }
  if (on === "step.start") {
    const context = str("context");
    if (context === null) return { ok: false, failure: "context must be text" };
    return { ok: true, ...(context ? { context } : {}), ...(note ? { note } : {}) };
  }
  if (on === "step.end") {
    const reply = str("reply");
    if (reply === null) return { ok: false, failure: "reply must be text" };
    return { ok: true, ...(reply !== undefined ? { reply } : {}), ...(note ? { note } : {}) };
  }
  return { ok: true, ...(note ? { note } : {}) };
}

/** What a run of tool.call hooks decided for one call. */
export interface ToolCallVerdict {
  decision: "allow" | "deny";
  reason?: string;
  /** The input after every rewrite, when any hook rewrote it. */
  input?: Record<string, unknown>;
  /** One line per hook that did something, for the trail. */
  records: HookRecord[];
}

/** One hook's effect, as the trail keeps it. */
export interface HookRecord {
  hook: string;
  event: HookEvent;
  /** deny | rewrite | context | reply | note | error */
  did: "deny" | "rewrite" | "context" | "reply" | "note" | "error";
  tool?: string;
  reason?: string;
  ms: number;
}

/** A hook record as it crosses from the sandbox: checked, never trusted. */
export function isHookRecord(x: unknown): x is HookRecord {
  if (!x || typeof x !== "object") return false;
  const r = x as Record<string, unknown>;
  return typeof r.hook === "string" && NAME.test(r.hook)
    && typeof r.event === "string" && (HOOK_EVENTS as readonly string[]).includes(r.event)
    && typeof r.did === "string" && ["deny", "rewrite", "context", "reply", "note", "error"].includes(r.did)
    && typeof r.ms === "number"
    && (r.tool === undefined || typeof r.tool === "string")
    && (r.reason === undefined || typeof r.reason === "string");
}

export function isGate(on: HookEvent) {
  return GATES.has(on);
}

/**
 * tool.call: every matching hook in order. The first deny ends it — the most
 * restrictive answer wins; a rewrite is handed on to the next hook, so they
 * chain in the order they were turned on. A hook that fails denies.
 */
export async function runToolCallHooks(
  hooks: HookDef[],
  call: { tool: string; input: Record<string, unknown>; base: Record<string, unknown> },
  run: (hook: HookDef, event: Record<string, unknown>) => Promise<HookAnswer>,
): Promise<ToolCallVerdict> {
  const records: HookRecord[] = [];
  let input = call.input;
  let rewritten = false;
  for (const hook of hooks) {
    if (hook.on !== "tool.call" || !matchesTool(hook.tool, call.tool)) continue;
    const a = await run(hook, { ...call.base, event: "tool.call", hook: hook.name, tool: { name: call.tool, input } });
    if (!a.ok) {
      const reason = `hook ${hook.name} failed (${a.failure}), so the call is refused`;
      records.push({ hook: hook.name, event: "tool.call", did: "error", tool: call.tool, reason, ms: a.ms });
      return { decision: "deny", reason, records };
    }
    if (a.decision === "deny") {
      records.push({ hook: hook.name, event: "tool.call", did: "deny", tool: call.tool, reason: a.reason, ms: a.ms });
      return { decision: "deny", reason: `hook ${hook.name}: ${a.reason}`, records };
    }
    if (a.input) {
      input = a.input;
      rewritten = true;
      records.push({ hook: hook.name, event: "tool.call", did: "rewrite", tool: call.tool, ...(a.reason ? { reason: a.reason } : {}), ms: a.ms });
    } else if (a.note) {
      records.push({ hook: hook.name, event: "tool.call", did: "note", tool: call.tool, reason: a.note, ms: a.ms });
    }
  }
  return { decision: "allow", ...(rewritten ? { input } : {}), records };
}

/** The trail's line for a record. */
export function hookLine(r: HookRecord): string {
  const what = r.tool ? ` ${r.tool}` : "";
  switch (r.did) {
    case "deny": return `hook ${r.hook} denied${what}: ${r.reason}`;
    case "rewrite": return `hook ${r.hook} rewrote${what}${r.reason ? `: ${r.reason}` : ""}`;
    case "context": return `hook ${r.hook} added context to the step`;
    case "reply": return `hook ${r.hook} rewrote the step's reply`;
    case "note": return `hook ${r.hook}${what}: ${r.reason}`;
    case "error": return `hook ${r.hook} failed on ${r.event}${what}: ${r.reason}`;
  }
}

/** For `foldrun check`: every problem with the hooks/ folder of one root. */
export function checkHooksDir(hooksDir: string, scope: HookDef["scope"]): string[] {
  const problems: string[] = [];
  for (const dir of listHookDirs(hooksDir)) {
    const def = readHookDef(dir, scope);
    if ("error" in def) problems.push(def.error);
  }
  return problems;
}
