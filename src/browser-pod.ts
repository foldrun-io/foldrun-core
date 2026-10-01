// Slim browsing: a step whose only reason for the full runner image is that
// it browses may run on the slim image and drive the account's browser pod
// over Playwright's protocol. The pod can go away mid-step — a node drained,
// the idle reaper, an OOM — and a slim step has no browser of its own to fall
// back on. So:
//
//   1. The web tool reconnects first: a few tries, short backoff (the tool's
//      run.mjs; each try is an event in FOLDRUN_BROWSER_POD_EVENTS).
//   2. Still gone: the step stops, and what it has done so far decides.
//      Only reads — re-run the whole step from the start on the full image,
//      and say so on the run ("browser pod lost; re-ran on full").
//   3. Anything written — fail the step: "browser pod died after the step had
//      written <what>". Doing it again could send, post or charge twice, so
//      retry:, on-fail: or a person decides.
//
// Read or write is decided from the calls the step made, as the model asked
// for them (step-exec.ts keeps the ledger). When a call could be either it
// counts as a write: the cost of being wrong that way is a failed step a
// retry can redo; the other way it is a duplicate email.
//
// Steps that act outward (a tool marked `outward: true`) never run slim; nor
// does anything the step start can already see needs a browser in the step
// (lightpanda, obscura, live sessions, extensions) — slimBrowseBlocker.

/** Set by the platform on a step it put on the slim image to browse
 *  through the pod. The web tool then never launches a browser of its own. */
export const POD_ONLY_ENV = "FOLDRUN_BROWSER_POD_ONLY";
/** Where the web tool appends one JSON line per reconnect, and the line
 *  that says the pod is lost or the call needs the full image. */
export const POD_EVENTS_ENV = "FOLDRUN_BROWSER_POD_EVENTS";
/** The file, inside the step's sandbox. */
export const POD_EVENTS_FILE = "/tmp/foldrun-browser-pod.jsonl";
/** The note the run carries when the fallback was taken. Worded once. */
export const RERAN_ON_FULL = "browser pod lost; re-ran on full";

/**
 * Browse actions that can change something beyond the page in front of the
 * model: anything that types, picks, submits, signs in, uploads, runs script
 * or pays. A click is here because a click can submit and nothing before
 * the click can tell. The web tool's run.mjs carries a copy (it decides
 * whether a dropped call may be repeated); the gallery test holds the two
 * equal.
 */
export const BROWSE_WRITE_ACTIONS = [
  "click", "dblclick", "rightclick", "tap", "swipe", "mouse", "drag",
  "fill", "type", "insert", "paste", "press", "keyboard", "keydown", "keyup", "clear",
  "select", "check", "uncheck", "upload", "dialog", "login", "eval", "webmcp", "solve",
] as const;

/** Call arguments of web action=browse that are writes whatever the actions:
 *  page script, a paid captcha solver, a confirmation of a credential step. */
const BROWSE_WRITE_ARGS = ["js", "captcha", "captcha_solver", "confirm"];

/** Web actions that only read — when foldrun's own answers them. A paid
 *  provider answering one (FOLDRUN_WEB_<ACTION>_VIA) makes it a write: doing
 *  it twice is paying twice. `monitor` keeps state, so it always writes. */
const WEB_READ_ACTIONS = new Set(["search", "fetch", "browse", "crawl", "map", "extract", "answer"]);

/** Built-ins that read and change nothing. */
const READ_BUILTINS = new Set(["Read", "Glob", "Grep", "WebSearch", "WebFetch", "TodoWrite", "LS", "NotebookRead"]);
/** The platform's own tool groups that only read. Consults are a toolless
 *  answer; a delegation's own calls come through on their own. */
const READ_SERVERS = new Set(["foldrun_search", "foldrun_history", "foldrun_desks", "foldrun_agents"]);
const DELEGATE = new Set(["Agent", "Task"]);

export type CallKind = { write: false } | { write: true; what: string };

export interface ClassifyContext {
  /** SDK tool name → HTTP method, for an API's typed operations (api-tools
   *  builds the map; a generic call_<api> carries its method in the input). */
  methods?: Record<string, string>;
  /** Web actions a paid provider answers this step — from the env's
   *  FOLDRUN_WEB_<ACTION>_VIA. */
  paidWeb?: Record<string, string>;
}

/** The browse actions a call asked for, nested `if` branches included. */
export function browseActionNames(actions: unknown): string[] {
  let steps: unknown = actions;
  if (typeof steps === "string") {
    try { steps = JSON.parse(steps); } catch { return ["(unreadable actions)"]; }
  }
  const out: string[] = [];
  const walk = (v: unknown, depth: number) => {
    if (depth > 8 || v === null || typeof v !== "object") return;
    if (Array.isArray(v)) { for (const x of v) walk(x, depth + 1); return; }
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      out.push(k);
      walk(x, depth + 1);
    }
  };
  walk(steps, 0);
  return out;
}

/** What a browse call's arguments would write, or null when it only reads. */
export function browseWrites(input: Record<string, unknown>): string | null {
  const names = browseActionNames(input.actions);
  if (names.includes("(unreadable actions)")) return "browse actions it could not read";
  const writes = [...new Set(names.filter((n) => (BROWSE_WRITE_ACTIONS as readonly string[]).includes(n)))];
  if (writes.length) return `browse ${writes.join("/")}`;
  const arg = BROWSE_WRITE_ARGS.find((a) => input[a] !== undefined && input[a] !== null && input[a] !== "" && input[a] !== false);
  if (arg) return `browse ${arg}=`;
  return null;
}

/**
 * Whether one tool call can have changed anything outside the model's head,
 * and if so, a few words saying what. Pure.
 */
export function classifyCall(tool: string, input: Record<string, unknown> | undefined, ctx: ClassifyContext = {}): CallKind {
  const args = input ?? {};
  const write = (what: string): CallKind => ({ write: true, what });
  if (READ_BUILTINS.has(tool) || DELEGATE.has(tool)) return { write: false };
  if (tool === "Write" || tool === "Edit" || tool === "MultiEdit" || tool === "NotebookEdit") {
    const raw = String(args.file_path ?? args.notebook_path ?? args.path ?? "");
    const file = raw.startsWith("/workspace/") ? raw.slice("/workspace/".length) : raw.split("/").slice(-3).join("/");
    return write(file ? `${file} (${tool})` : `a file (${tool})`);
  }
  if (tool === "Bash") return write("a shell command");
  const mcp = /^mcp__(.+?)__(.+)$/.exec(tool);
  if (!mcp) return write(tool); // unknown: a write until shown otherwise
  const [, server, name] = mcp;
  if (READ_SERVERS.has(server)) return { write: false };
  if (server === "foldrun_ask") return write("a question to a person");
  if (server === "foldrun_scripts") {
    if (name !== "web") return write(`script ${name}`);
    const action = String(args.action ?? "").trim().toLowerCase();
    if (!WEB_READ_ACTIONS.has(action)) return write(action === "monitor" ? "web monitor state" : `web ${action || "call"}`);
    const paid = ctx.paidWeb?.[action];
    if (paid) return write(`a paid ${paid} ${action}`);
    if (action === "browse") {
      const w = browseWrites(args);
      if (w) return write(w);
    }
    return { write: false };
  }
  if (server === "foldrun_apis") {
    const method = String(
      name.startsWith("call_") ? (args.method ?? "GET") : (ctx.methods?.[tool] ?? ""),
    ).toUpperCase();
    const api = name.replace(/^call_/, "");
    if (method === "GET" || method === "HEAD") return { write: false };
    return write(`${api} ${method || "call"}`);
  }
  // Any other MCP server: its tools could do anything.
  return write(`${server} ${name}`);
}

/** Paid web actions, from a step's env (FOLDRUN_WEB_<ACTION>_VIA=provider). */
export function paidWebActions(env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    const m = /^FOLDRUN_WEB_([A-Z]+)_VIA$/.exec(k);
    if (m && v) out[m[1].toLowerCase()] = v;
  }
  if (env.FOLDRUN_BROWSER_VENDOR) out.browse = env.FOLDRUN_BROWSER_VENDOR;
  return out;
}

/** One line of the web tool's pod log. */
export interface PodEvent {
  kind: "reconnect" | "lost" | "needs-full";
  /** reconnect: which try, of how many, and whether it got through. */
  attempt?: number;
  of?: number;
  ok?: boolean;
  /** lost: whether the call ran on the pod at all before it was lost — a
   *  call that never connected changed nothing, whatever it asked for. */
  ran?: boolean;
  error?: string;
  why?: string;
  /** When the web tool wrote the line (ISO). */
  at?: string;
}

/** ", at 10:15:15Z" from a pod log line's `at`; empty when it has none. */
export function podAt(at: unknown): string {
  if (typeof at !== "string") return "";
  const t = Date.parse(at);
  return Number.isNaN(t) ? "" : `, at ${new Date(t).toISOString().slice(11, 19)}Z`;
}

/** Lines of the pod log from byte `offset` on, and where the next read
 *  starts. A torn last line waits for the next read. */
export function readPodEvents(text: string, offset: number): { events: PodEvent[]; next: number } {
  const chunk = text.slice(offset);
  const end = chunk.lastIndexOf("\n");
  if (end < 0) return { events: [], next: offset };
  const events: PodEvent[] = [];
  for (const line of chunk.slice(0, end).split("\n")) {
    try {
      const e = JSON.parse(line) as PodEvent;
      if (e && (e.kind === "reconnect" || e.kind === "lost" || e.kind === "needs-full")) events.push(e);
    } catch {
      // not ours
    }
  }
  return { events, next: offset + end + 1 };
}

/** What crosses back from a step that browsed through the pod. */
export interface BrowserPodOutcome {
  /** Reconnect tries the web tool made, and how many got through: the pod
   *  answered and the call went on, rather than dropping again at once. */
  reconnects: number;
  reconnected: number;
  /** Reconnects that reached the pod, after which the call dropped again at
   *  once — a pod still answering while it shut down. Never "got through". */
  closedAgain?: number;
  /** Set when the step stopped because the pod was gone (or a call needed
   *  a browser in the step, which slim does not have). */
  lost?: { cause: "lost" | "needs-full"; detail: string };
  /** What the step had written by then, worded — empty means reads only. */
  writes?: string[];
}

/** "a.md (Write), crm POST and 2 more". */
export function describeWrites(writes: string[]): string {
  const uniq = [...new Set(writes)];
  if (uniq.length > 3) return `${uniq.slice(0, 3).join(", ")} and ${uniq.length - 3} more`;
  if (uniq.length <= 1) return uniq[0] ?? "something";
  return `${uniq.slice(0, -1).join(", ")} and ${uniq.at(-1)}`;
}

/** The decision, once the pod is gone: re-run on full, or fail and say why. */
export function podLossDecision(pod: BrowserPodOutcome): { rerun: true; note: string } | { rerun: false; message: string } {
  const writes = pod.writes ?? [];
  const cause = pod.lost?.cause === "needs-full" ? `a call needed a browser in the step (${pod.lost.detail})` : `browser pod lost (${pod.lost?.detail ?? "connection closed"})`;
  if (!writes.length) return { rerun: true, note: `${RERAN_ON_FULL} — ${cause}; the step had only read, so it ran again from the start on the full image` };
  const head = pod.lost?.cause === "needs-full"
    ? `a call needed a browser in the step after the step had written ${describeWrites(writes)}`
    : `browser pod died after the step had written ${describeWrites(writes)}`;
  return { rerun: false, message: `${head} — not re-run, since doing it again could repeat that; retry:, on-fail: or a person decides (${pod.lost?.detail ?? "connection closed"})` };
}

/**
 * Why a browsing step must have a browser in its own sandbox, from what the
 * step start can see (the agent's `web.browse` block, as env), or null when
 * the account's pod can serve every call it could make by default. A call
 * that picks an in-step engine itself is caught at the call (needs-full).
 */
export function slimBrowseBlocker(env: Record<string, string | undefined>): string | null {
  if (env.FOLDRUN_BROWSER_VENDOR) return `web.browse names ${env.FOLDRUN_BROWSER_VENDOR}`;
  if (env.FOLDRUN_BROWSER_LIVE === "1") return "web.browse live: sessions run in the step";
  const engine = (env.FOLDRUN_BROWSER_ENGINE ?? "").trim().toLowerCase();
  if (engine === "lightpanda" || engine === "obscura") return `engine ${engine} runs in the step`;
  if (env.FOLDRUN_BROWSER_EXTENSIONS) return "extensions load into a browser in the step";
  return null;
}

/** The outcome as it crosses back from the sandbox, checked field by field
 *  (the done line is the pod's word); null when absent or not this shape. */
export function parseBrowserPod(v: unknown): BrowserPodOutcome | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const n = (x: unknown) => (typeof x === "number" && Number.isFinite(x) && x >= 0 ? Math.floor(x) : 0);
  const out: BrowserPodOutcome = { reconnects: n(o.reconnects), reconnected: n(o.reconnected) };
  if (n(o.closedAgain)) out.closedAgain = n(o.closedAgain);
  const lost = o.lost as Record<string, unknown> | undefined;
  if (lost && typeof lost === "object" && (lost.cause === "lost" || lost.cause === "needs-full")) {
    out.lost = { cause: lost.cause, detail: String(lost.detail ?? "").slice(0, 300) };
    out.writes = Array.isArray(o.writes) ? o.writes.slice(0, 50).map((w) => String(w).slice(0, 120)) : [];
  }
  return out;
}

/** One line for a person: "2 reconnects (2 got through)", "browser pod
 *  lost; re-ran on full", or the failure. What the run page, `foldrun
 *  report` and an attempt row say. A pod that was lost in the end is never
 *  said to have let a reconnect through — "1 reconnect (1 got through); pod
 *  lost" read live as a contradiction — and a reconnect that reached the pod
 *  only for the call to drop again says that. */
export function browserPodLine(p: BrowserPodOutcome & { fallback?: string; failure?: string }): string {
  const count = `${p.reconnects} reconnect${p.reconnects === 1 ? "" : "s"}`;
  const tries = !p.reconnects
    ? "no reconnects"
    : !p.lost
      ? `${count} (${p.reconnected} got through)`
      : p.closedAgain
        ? `${count}, ${p.reconnects === 1 ? "which" : "the last"} reached the pod but it closed again`
        : count;
  if (p.failure) return `${tries}; ${p.failure}`;
  if (p.fallback) return `${tries}; ${p.fallback}${p.lost ? ` (${p.lost.detail})` : ""}`;
  if (p.lost) return `${tries}; ${p.lost.cause === "needs-full" ? "needed a browser in the step" : "pod lost"}: ${p.lost.detail}`;
  return tries;
}

/** What podTriesLine reads of a StepAttempt (store.ts) — structural, so
 *  this module stays free of the store's imports for the CLI and the web. */
export interface TryRow {
  n: number;
  status: string;
  image?: string;
  costUsd: number | null;
}

/** A step's tries in one line when the browser pod was lost under one of
 *  them — "slim · lost · $0.0040 → full · completed · $0.0060" — so the run
 *  page and `foldrun report` show the slim go and the full re-run apart.
 *  `#n` leads each try when the step had more than one attempt. Null when
 *  no try was lost. */
export function podTriesLine(tries: readonly TryRow[] | null | undefined): string | null {
  if (!tries?.some((t) => t.status === "lost")) return null;
  const many = new Set(tries.map((t) => t.n)).size > 1;
  return tries
    .map((t) => [
      `${many ? `#${t.n} ` : ""}${t.image ?? "?"}`,
      t.status,
      typeof t.costUsd === "number" ? `$${t.costUsd.toFixed(4)}` : null,
    ].filter(Boolean).join(" · "))
    .join(" → ");
}
