// The checks that need the network (FOL-58), kept apart from `scanFiles`,
// which stays offline and free:
//
//   supply-chain/known-vulnerability — a runtime package pinned to an exact
//     version that OSV.dev lists advisories for. Only exact pins are asked:
//     an unpinned package is a different program tomorrow (and
//     supply-chain/unpinned-package says so). Transitive dependencies are
//     not resolved — a known limit, documented.
//   content/mcp-tool-text — what an MCP server reached by URL tells the model
//     about its tools, through the content rules as untrusted text. A server
//     started as a command is never run to check it, and no credential is
//     ever sent: a server that needs one is reported as not checked.
//
// Both answer findings in the scanner's shape and say, per source, what they
// could not check — an unreachable or malformed answer is never a pass.
// Shaped by a design debate and review with Codex (18 Oct 2026).

import matter from "./matter.ts";
import { filterIgnored, findingFingerprint, untrustedTextFindings, type ScanFile, type ScanFinding } from "./scan.ts";
import { platform } from "./platform.ts";
import { parseToolDef } from "./store.ts";

export const OSV_BATCH_URL = "https://api.osv.dev/v1/querybatch";
const TIMEOUT_MS = 10_000;
const MAX_PINS = 500;
/** One server: pages of tools/list, tools read, characters of text, bytes read. */
const MCP_LIMITS = { pages: 10, tools: 300, text: 200_000, bytes: 2_000_000 };
/** The MCP protocol version this client asks for (2025-06-18 spec). */
const MCP_VERSION = "2025-06-18";
/** What one online-check answer may be, read, through the platform's guard:
 *  an MCP server's own byte budget, so the guard's 1 MiB default never cuts
 *  an answer the budget allows. Pass it when wrapping platform.fetchUntrusted. */
export const ONLINE_MAX_BYTES = MCP_LIMITS.bytes;

export interface Pin {
  ecosystem: "PyPI" | "npm";
  name: string;
  version: string;
  /** As written, e.g. requests==2.19.0. */
  spec: string;
  file: string;
  line?: number;
}

/** One source's outcome: checked (its findings are complete), or not. */
export interface SourceResult {
  /** "osv", or "mcp:<declaring file>#<server>" — two files may name a server alike. */
  source: string;
  /** True only when its findings are complete. */
  checked: boolean;
  /** Not complete, but what it did read is real (a cap, a paged answer). */
  partial?: boolean;
  /** Not reached because the caller's deadline ran out first. */
  skipped?: boolean;
  /** Why not, or what was incomplete. */
  problem?: string;
}

/** An online finding, carrying the source it came from — the rescan's identity
 *  for it, never parsed back out of the message (Codex review). */
export type OnlineFinding = ScanFinding & { source: string };

export interface OnlineResult {
  findings: OnlineFinding[];
  /** What could not be checked, in words. */
  problems: string[];
  sources: SourceResult[];
}

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

const front = (content: string): Record<string, unknown> | null => {
  try {
    return matter(content).data as Record<string, unknown>;
  } catch {
    return null;
  }
};

const lineOf = (content: string, needle: string): number | undefined => {
  const i = content.split(/\r?\n/).findIndex((l) => l.includes(needle));
  return i >= 0 ? i + 1 : undefined;
};

/** Files whose frontmatter can carry a runtime: or mcpServers: block. */
const CONFIG_FILE = /^(?:library\/)?(?:AGENTS\.md|project\.md|agents\/[^/]+\/agent\.md|tools\/[^/]+(?:\/tool)?\.md|\.(?:claude|agents)\/agents\/[^/]+\.md)$/;

// ── known vulnerabilities ──────────────────────────────────────────────────

/** An exact pin: pip `name==1.2.3` (extras allowed), npm `name@1.2.3` or `@scope/name@1.2.3`. */
export function parsePin(spec: string): Omit<Pin, "file" | "line" | "spec"> | null {
  const s = spec.trim();
  const pip = /^([A-Za-z0-9][A-Za-z0-9._-]*)(?:\[[^\]]*\])?\s*===?\s*([0-9][A-Za-z0-9.+!-]*)$/.exec(s);
  if (pip) return { ecosystem: "PyPI", name: pip[1]!, version: pip[2]! };
  // npm's exact spellings: 1.2.3, =1.2.3, v1.2.3, =v1.2.3 (Codex review).
  const npm = /^((?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*)@=?v?(\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?)$/.exec(s);
  if (npm) return { ecosystem: "npm", name: npm[1]!, version: npm[2]! };
  return null;
}

/** Every exact pin in the workspace's runtime: blocks (agents, AGENTS.md, tools). */
export function exactPins(files: ScanFile[]): Pin[] {
  const out: Pin[] = [];
  for (const f of files) {
    if (!CONFIG_FILE.test(f.path)) continue;
    const runtime = front(f.content)?.runtime;
    if (!runtime || typeof runtime !== "object") continue;
    const r = runtime as Record<string, unknown>;
    // The keys the runtime installs from (runtime.ts parseRuntime): packages,
    // else its pip alias; and npm.
    for (const list of [r.packages ?? r.pip, r.npm]) {
      if (!Array.isArray(list)) continue;
      for (const raw of list) {
        const p = typeof raw === "string" ? parsePin(raw) : null;
        if (p) out.push({ ...p, spec: raw as string, file: f.path, line: lineOf(f.content, raw as string) });
      }
    }
  }
  return out;
}

const pinKey = (p: { ecosystem: string; name: string; version: string }) => `${p.ecosystem}:${p.name}@${p.version}`;

/** Ask OSV about every exact pin, once each, in one batch; findings fan out to every file that declares it. */
export async function vulnerabilityFindings(files: ScanFile[], fetchImpl: Fetch = fetch, deadline = Infinity): Promise<OnlineResult> {
  const pins = exactPins(files);
  const unique = [...new Map(pins.map((p) => [pinKey(p), p])).values()];
  if (!unique.length) return { findings: [], problems: [], sources: [{ source: "osv", checked: true }] };
  const asked = unique.slice(0, MAX_PINS);
  const incomplete: string[] = unique.length > MAX_PINS ? [`${unique.length} pinned packages — the first ${MAX_PINS} were checked`] : [];
  const fail = (problem: string): OnlineResult => ({ findings: [], problems: [problem], sources: [{ source: "osv", checked: false, problem }] });
  // The caller's deadline holds here too (Codex review).
  if (Date.now() >= deadline) {
    const problem = "the check ran out of time before OSV — packages not checked";
    return { findings: [], problems: [problem], sources: [{ source: "osv", checked: false, skipped: true, problem }] };
  }
  let results: unknown[];
  try {
    const res = await fetchImpl(OSV_BATCH_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ queries: asked.map((p) => ({ package: { name: p.name, ecosystem: p.ecosystem }, version: p.version })) }),
      signal: AbortSignal.timeout(Math.max(1, Math.min(TIMEOUT_MS, deadline - Date.now()))),
    });
    if (!res.ok) return fail(`OSV answered HTTP ${res.status} — packages not checked`);
    const body = (await res.json()) as { results?: unknown };
    if (!Array.isArray(body.results) || body.results.length !== asked.length) return fail("OSV's answer did not match the question — packages not checked");
    results = body.results;
  } catch (err) {
    return fail(`OSV could not be reached (${err instanceof Error ? err.message : String(err)}) — packages not checked`);
  }
  const findings: OnlineFinding[] = [];
  for (let i = 0; i < asked.length; i++) {
    const r = results[i] as { vulns?: unknown; next_page_token?: unknown } | null;
    if (!r || typeof r !== "object") return fail("OSV's answer was malformed — packages not checked");
    const vulns = r.vulns === undefined ? [] : r.vulns;
    if (!Array.isArray(vulns)) return fail("OSV's answer was malformed — packages not checked");
    const raw = vulns.map((v) => (v && typeof v === "object" ? (v as { id?: unknown }).id : null));
    // An advisory with no id is not "no advisory" — unknown, never clean (Codex review).
    if (raw.some((x) => typeof x !== "string" || !x)) return fail("OSV's answer held an advisory with no id — packages not checked");
    const ids = [...new Set(raw as string[])].sort();
    const paged = typeof r.next_page_token === "string" && r.next_page_token.length > 0;
    const p = asked[i]!;
    if (paged && !ids.length) {
      incomplete.push(`${p.spec}: OSV paged its answer with no advisories on the first page — unknown, not clean`);
      continue;
    }
    if (!ids.length) continue;
    if (paged) incomplete.push(`${p.spec}: OSV has more advisories than one page — the rest not read`);
    const count = paged ? `${ids.length} advisories returned (results incomplete)` : `${ids.length} known ${ids.length === 1 ? "advisory" : "advisories"}`;
    const rule = "supply-chain/known-vulnerability";
    for (const decl of pins.filter((x) => pinKey(x) === pinKey(p))) {
      const message = `runtime package ${decl.spec} has ${count}: ${ids.slice(0, 5).join(", ")}${ids.length > 5 ? `, +${ids.length - 5} more` : ""} — upgrade it (https://osv.dev/vulnerability/${ids[0]})`;
      // The occurrence is the pin in this file; the advisories are its
      // evidence, so a new advisory on the same pin is not a new finding.
      findings.push({ rule, level: "warn", file: decl.file, ...(decl.line ? { line: decl.line } : {}), message, fingerprint: findingFingerprint(rule, decl.file, pinKey(decl)), source: "osv" });
    }
  }
  return {
    findings: filterIgnored(findings, files) as OnlineFinding[],
    problems: incomplete,
    // A cap or a paged-unknown answer is not a complete check (Codex review).
    sources: [incomplete.length ? { source: "osv", checked: false, partial: true, problem: incomplete.join("; ") } : { source: "osv", checked: true }],
  };
}

// ── remote MCP tool text ───────────────────────────────────────────────────

export interface RemoteMcp {
  name: string;
  url: string;
  /** Configured headers or a URL that may carry a credential: never probed. */
  needsCredential: boolean;
  file: string;
  line?: number;
}

/** MCP servers declared by URL — in an agent's mcpServers: or a tool with transport: mcp. */
export function remoteMcpServers(files: ScanFile[]): RemoteMcp[] {
  const out: RemoteMcp[] = [];
  const add = (name: string, spec: unknown, file: string, content: string) => {
    if (!spec || typeof spec !== "object") return;
    const s = spec as Record<string, unknown>;
    if (typeof s.url !== "string" || !/^https?:\/\//i.test(s.url)) return;
    let credentialUrl = /\$\{/.test(s.url);
    try {
      const u = new URL(s.url);
      if (u.username || u.password || u.search) credentialUrl = true;
    } catch {
      credentialUrl = true;
    }
    const hasHeaders = Boolean(s.headers && typeof s.headers === "object" && Object.keys(s.headers as object).length);
    out.push({ name, url: s.url, needsCredential: credentialUrl || hasHeaders, file, line: lineOf(content, s.url) });
  };
  for (const f of files) {
    if (!CONFIG_FILE.test(f.path)) continue;
    const data = front(f.content);
    if (!data) continue;
    if (data.mcpServers && typeof data.mcpServers === "object") {
      for (const [name, spec] of Object.entries(data.mcpServers as Record<string, unknown>)) add(name, spec, f.path, f.content);
    }
    // A tool file is an MCP server exactly when the runtime reads it as one:
    // transport: mcp, the legacy type: mcp, or a url:/command: with neither.
    const tool = /^(?:library\/)?tools\/([^/]+?)(?:\/tool)?\.md$/.exec(f.path);
    if (tool) {
      const def = parseToolDef(data, tool[1]!, f.content);
      if (def?.kind === "mcp" && def.spec.url) add(def.name ?? tool[1]!, { url: def.spec.url, headers: def.spec.headers }, f.path, f.content);
    }
  }
  return out;
}

/** Parse one candidate message: the answer to `id`, an error, or not it. */
function matchAnswer(raw: string, id: number): { msg: Record<string, unknown> } | { problem: string } | null {
  let msg: unknown;
  try {
    msg = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!msg || typeof msg !== "object" || (msg as { id?: unknown }).id !== id) return null;
  const m = msg as Record<string, unknown>;
  if (m.error) return { problem: `answered a JSON-RPC error (${String((m.error as { message?: unknown }).message ?? "unknown").slice(0, 120)})` };
  if (!m.result || typeof m.result !== "object") return { problem: "answered without a result" };
  return { msg: m };
}

/**
 * The JSON-RPC message answering `id`: one JSON body, or an SSE stream read
 * incrementally — events joined per the SSE standard, the reader cancelled
 * the moment the answer arrives (a server may keep the stream open). Never
 * more than the byte budget.
 */
async function rpcAnswer(res: Response, id: number, budget: { bytes: number }): Promise<{ msg: Record<string, unknown> } | { problem: string }> {
  if (!res.body) return { problem: "gave no answer to the request" };
  const sse = (res.headers.get("content-type") ?? "").includes("text/event-stream");
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let data: string[] = [];
  const done = async (r: { msg: Record<string, unknown> } | { problem: string }) => {
    await reader.cancel().catch(() => undefined);
    return r;
  };
  for (;;) {
    const { done: end, value } = await reader.read();
    if (value) {
      budget.bytes -= value.byteLength;
      if (budget.bytes < 0) return done({ problem: `answered more than ${MCP_LIMITS.bytes} bytes` });
      buffer += decoder.decode(value, { stream: true });
    }
    if (sse) {
      // Complete lines only; an event ends at a blank line. A trailing CR
      // may be the first half of a CRLF the next chunk completes, so it
      // waits for more (Codex review).
      let nl: number;
      while ((nl = buffer.search(end ? /\r\n|\r|\n/ : /\r\n|\r(?!$)|\n/)) >= 0) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + (buffer.startsWith("\r\n", nl) ? 2 : 1));
        if (line === "") {
          if (data.length) {
            const hit = matchAnswer(data.join("\n"), id);
            data = [];
            if (hit) return done(hit);
          }
        } else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
      }
    }
    if (end) break;
  }
  if (sse) {
    if (buffer.startsWith("data:")) data.push(buffer.slice(5).replace(/^ /, ""));
    if (data.length) return matchAnswer(data.join("\n"), id) ?? { problem: "gave no answer to the request" };
    return { problem: "gave no answer to the request" };
  }
  return matchAnswer(buffer, id) ?? { problem: "gave no answer to the request" };
}

/** Everything a tool shows the model: name, title, description, annotation title, schema descriptions. */
function toolText(tool: Record<string, unknown>): string {
  const parts = [tool.name, tool.title, tool.description, (tool.annotations as { title?: unknown } | undefined)?.title].filter((x): x is string => typeof x === "string");
  // Every string the schema shows the model — property names, defaults,
  // enum values, examples — not only descriptions (Codex review).
  const walk = (v: unknown) => {
    if (typeof v === "string") {
      parts.push(v);
      return;
    }
    if (!v || typeof v !== "object") return;
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      parts.push(k);
      walk(x);
    }
  };
  walk(tool.inputSchema);
  walk(tool.outputSchema);
  return parts.join("\n");
}

/** initialize → notifications/initialized → tools/list (every page, within limits), anonymously. */
export async function mcpTools(url: string, fetchImpl: Fetch, deadline = Infinity): Promise<{ tools: { name: string; text: string }[]; incomplete?: string } | { problem: string }> {
  const budget = { bytes: MCP_LIMITS.bytes };
  const tools: { name: string; text: string }[] = [];
  let session: string | null = null;
  let version = MCP_VERSION;
  const post = (body: unknown) =>
    fetchImpl(url, {
      method: "POST",
      // Protocol headers only: nothing configured is forwarded, so no
      // credential can leave on a probe (Codex review).
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(session ? { "mcp-session-id": session } : {}),
        ...((body as { method?: string }).method !== "initialize" ? { "mcp-protocol-version": version } : {}),
      },
      body: JSON.stringify(body),
      // The request's own limit, or what is left of the caller's — whichever is sooner.
      signal: AbortSignal.timeout(Math.max(1, Math.min(TIMEOUT_MS, deadline - Date.now()))),
      redirect: "manual",
    });
  try {
    const init = await post({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: MCP_VERSION, capabilities: {}, clientInfo: { name: "foldrun-check", version: "1" } } });
    if (!init.ok) return { problem: `answered HTTP ${init.status} to initialize` };
    session = init.headers.get("mcp-session-id");
    const initAnswer = await rpcAnswer(init, 1, budget);
    if ("problem" in initAnswer) return { problem: `initialize: ${initAnswer.problem}` };
    const negotiated = (initAnswer.msg.result as { protocolVersion?: unknown }).protocolVersion;
    if (typeof negotiated !== "string" || !negotiated) return { problem: "initialize: no protocolVersion in the answer" };
    version = negotiated;
    const ack = await post({ jsonrpc: "2.0", method: "notifications/initialized" });
    await ack.body?.cancel().catch(() => undefined);
    if (!ack.ok) return { problem: `answered HTTP ${ack.status} to notifications/initialized` };

    let text = 0;
    let malformed = 0;
    let cursor: string | undefined;
    for (let page = 0; page < MCP_LIMITS.pages; page++) {
      const id = 2 + page;
      // A failure after the first page keeps what was already read: a
      // server cannot hide text it sent by failing the next page (Codex review).
      const stop = (why: string) => (page === 0 ? { problem: why } : { tools, incomplete: `page ${page + 1} of tools/list: ${why}` });
      const list = await post({ jsonrpc: "2.0", id, method: "tools/list", ...(cursor ? { params: { cursor } } : {}) });
      if (!list.ok) return stop(`answered HTTP ${list.status} to tools/list`);
      const answer = await rpcAnswer(list, id, budget);
      if ("problem" in answer) return stop(`tools/list: ${answer.problem}`);
      const result = answer.msg.result as { tools?: unknown; nextCursor?: unknown };
      if (!Array.isArray(result.tools)) return stop("tools/list: no tools array in the answer");
      for (const t of result.tools) {
        // A tool with no name is not a tool the model can call — but it is
        // not a clean answer either (Codex review).
        if (!t || typeof t !== "object" || typeof (t as { name?: unknown }).name !== "string" || !(t as { name: string }).name) {
          malformed++;
          if (t && typeof t === "object") tools.push({ name: "(no name)", text: toolText(t as Record<string, unknown>) });
          continue;
        }
        const body = toolText(t as Record<string, unknown>);
        tools.push({ name: (t as { name: string }).name.slice(0, 120), text: body });
        text += body.length;
        if (tools.length >= MCP_LIMITS.tools || text >= MCP_LIMITS.text) return { tools, incomplete: `more than ${tools.length} tools or ${MCP_LIMITS.text} characters — the rest not read` };
      }
      cursor = typeof result.nextCursor === "string" && result.nextCursor ? result.nextCursor : undefined;
      if (!cursor) return malformed ? { tools, incomplete: `${malformed} malformed ${malformed === 1 ? "entry" : "entries"} in tools/list` } : { tools };
    }
    return { tools, incomplete: `more than ${MCP_LIMITS.pages} pages of tools — the rest not read` };
  } catch (err) {
    const why = `could not be reached (${err instanceof Error ? err.message : String(err)})`;
    // Thrown mid-way (a dropped connection on page 2): what was read stays (Codex review).
    return tools.length ? { tools, incomplete: why } : { problem: why };
  }
}

/** Every URL-reached MCP server's tool text, through the content rules as untrusted text. */
export async function mcpDescriptionFindings(files: ScanFile[], opts: { fetch?: Fetch; deadline?: number; order?: string[] } = {}): Promise<OnlineResult> {
  const deadline = opts.deadline ?? Infinity;
  // `order`: source ids to try first (the rescan's least recently checked),
  // so a slow server early in the list cannot starve the rest for ever.
  const rank = (s: RemoteMcp) => {
    const i = opts.order?.indexOf(`mcp:${s.file}#${s.name}`) ?? -1;
    return i < 0 ? -1 : i;
  };
  const fetchImpl = opts.fetch ?? ((url: string, init?: RequestInit) => platform.fetchUntrusted(url, init, { maxBytes: ONLINE_MAX_BYTES }));
  const findings: OnlineFinding[] = [];
  const problems: string[] = [];
  const sources: SourceResult[] = [];
  for (const server of remoteMcpServers(files).map((s, i) => ({ s, i })).sort((a, b) => rank(a.s) - rank(b.s) || a.i - b.i).map(({ s }) => s)) {
    const source = `mcp:${server.file}#${server.name}`;
    if (server.needsCredential) {
      const problem = `mcpServers.${server.name}: needs a credential (headers, or a URL carrying one) — no credential is sent on a check, so its tools were not checked`;
      problems.push(problem);
      sources.push({ source, checked: false, problem });
      continue;
    }
    if (Date.now() >= deadline) {
      const problem = `mcpServers.${server.name}: the check ran out of time before it — its tools were not checked`;
      problems.push(problem);
      sources.push({ source, checked: false, skipped: true, problem });
      continue;
    }
    const got = await mcpTools(server.url, fetchImpl, deadline);
    if ("problem" in got) {
      const problem = `mcpServers.${server.name} (${server.url}) ${got.problem} — its tools were not checked`;
      problems.push(problem);
      sources.push({ source, checked: false, problem });
      continue;
    }
    if (got.incomplete) problems.push(`mcpServers.${server.name}: ${got.incomplete}`);
    sources.push(got.incomplete ? { source, checked: false, partial: true, problem: got.incomplete } : { source, checked: true });
    for (const tool of got.tools) {
      for (const f of untrustedTextFindings(tool.text)) {
        const rule = "content/mcp-tool-text";
        const message = `mcpServers.${server.name} tool "${tool.name}": ${f.message} [${f.rule}]`;
        findings.push({
          rule,
          level: "warn",
          file: server.file,
          ...(server.line ? { line: server.line } : {}),
          message,
          fingerprint: findingFingerprint(rule, server.file, `${server.name} ${tool.name} ${f.rule}`),
          source,
        });
      }
    }
  }
  // The workspace's own foldrun-ignore can accept a finding — the server's
  // text never can.
  return { findings: filterIgnored(findings, files) as OnlineFinding[], problems, sources };
}

/** Both, as one answer. */
export async function onlineFindings(files: ScanFile[], opts: { fetch?: Fetch; osvFetch?: Fetch; deadline?: number; order?: string[] } = {}): Promise<OnlineResult> {
  const [v, m] = await Promise.all([vulnerabilityFindings(files, opts.osvFetch ?? fetch, opts.deadline), mcpDescriptionFindings(files, { fetch: opts.fetch, deadline: opts.deadline, order: opts.order })]);
  return { findings: [...v.findings, ...m.findings], problems: [...v.problems, ...m.problems], sources: [...v.sources, ...m.sources] };
}
