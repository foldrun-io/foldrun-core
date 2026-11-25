// The language-server layer and the Symbols tool (FOL-297): where a name is
// defined and where it is used, answered by a language server — TypeScript
// (typescript 7's own `tsc --lsp`), Python (pyright) and Go (gopls).
//
// Only foldrun's pinned servers run, never a copy the project ships (a
// server is a program: the project's would be the project's code). They are
// installed on first use into the place the client names (`toolsDir`: in
// foldrun code, the project's own package cache), and both the install and
// the server run only where programs run unasked — inside the local walls or
// in a container (`programs`). A sandboxed command can write that place, so
// what it finds there is never run outside the walls (Codex). Every location
// a server answers is checked as Read checks a path before its path or text
// is shown.

import { spawn, type ChildProcess } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { LAUNCHER } from "./local-sandbox.ts";
import type { EngineTool, ToolContext, ToolOutcome } from "./engine-tools.ts";

type Json = Record<string, unknown>;
export type Language = "typescript" | "python" | "go";

/** At most this many locations are listed; the rest are counted. */
export const SYMBOLS_MAX = 50;
const START_MS = 60_000;
const REQUEST_MS = 30_000;
const INSTALL_MS = 300_000;
/** The largest file sent to a server as it is opened. */
const OPEN_BYTES_MAX = 4 * 1024 * 1024;
/** The most a server may send in one message, or have pending unparsed. */
const FRAME_MAX = 32 * 1024 * 1024;

const EXTENSIONS: Record<string, Language> = {
  ts: "typescript", tsx: "typescript", mts: "typescript", cts: "typescript", js: "typescript", jsx: "typescript", mjs: "typescript", cjs: "typescript",
  py: "python", pyi: "python",
  go: "go",
};

export function languageOf(file: string): Language | null {
  return EXTENSIONS[path.extname(file).slice(1).toLowerCase()] ?? null;
}

/** The newest gopls each Go release builds (gopls follows Go: v0.24 needs 1.27). Older Go is refused. */
export const GOPLS_FOR_GO: ReadonlyArray<readonly [number, string]> = [[27, "v0.24.0"], [26, "v0.23.0"], [25, "v0.21.1"]];
export const PINNED = { typescript: "7.0.2", pyright: "1.1.414" } as const;

const LANGUAGE_ID: Record<Language, (file: string) => string> = {
  typescript: (f) => (/\.(jsx?|mjs|cjs)$/i.test(f) ? (/x$/i.test(f) ? "javascriptreact" : "javascript") : /x$/i.test(f) ? "typescriptreact" : "typescript"),
  python: () => "python",
  go: () => "go",
};

const shq = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;

/** A program by name in the person's PATH: absolute folders only, never one inside the project (it could be planted). */
function findProgram(name: string, ctx: ToolContext): string | null {
  const root = path.resolve(ctx.cwd);
  for (const dir of String(ctx.env.PATH ?? "").split(path.delimiter)) {
    if (!path.isAbsolute(dir)) continue;
    const rel = path.relative(root, dir);
    if (rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))) continue;
    const file = path.join(dir, name);
    try {
      if (fs.statSync(file).isFile()) return fs.realpathSync(file);
    } catch {
      /* not here */
    }
  }
  return null;
}

/** What a server and its install run with: a fixed PATH and nothing of the step's own environment (its keys), and
 *  Go held to the toolchain found and to no settings file or flags (Codex). */
function serverEnv(ctx: ToolContext, dir: string, extraPath: string[]): Record<string, string> {
  const env: Record<string, string> = {
    PATH: [...new Set([path.dirname(process.execPath), ...extraPath, "/usr/bin", "/bin"])].join(":"),
    HOME: String(ctx.env.HOME ?? ""),
    TMPDIR: String(ctx.env.TMPDIR ?? "/tmp"),
    LANG: "C.UTF-8",
    npm_config_cache: path.join(dir, "npm-cache"),
    npm_config_update_notifier: "false",
    GOENV: "off",
    GOTOOLCHAIN: "local",
    GOFLAGS: "",
    GOPATH: path.join(dir, "gopath"),
    GOCACHE: path.join(dir, "gocache"),
    GOTELEMETRY: "off",
  };
  for (const k of ["HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "https_proxy", "http_proxy", "no_proxy", "SSL_CERT_FILE", "NODE_EXTRA_CA_CERTS"]) {
    const v = ctx.env[k];
    if (typeof v === "string") env[k] = v;
  }
  return env;
}

/** A command line as this session runs programs: through the walls, or (a container) as it is. */
async function launch(ctx: ToolContext, line: string, env: Record<string, string>): Promise<{ child: ChildProcess; token?: string }> {
  if (ctx.sandbox) {
    const l = await ctx.sandbox.launch(line, env);
    const child = spawn(LAUNCHER, ["-c", l.line], { cwd: ctx.cwd, env: l.env as NodeJS.ProcessEnv, stdio: ["pipe", "pipe", "pipe"], detached: true });
    if (child.pid) ctx.groups.add(child.pid);
    return { child, ...(l.token ? { token: l.token } : {}) };
  }
  const child = spawn("/bin/sh", ["-c", line], { cwd: ctx.cwd, env: env as NodeJS.ProcessEnv, stdio: ["pipe", "pipe", "pipe"], detached: true });
  if (child.pid) ctx.groups.add(child.pid);
  return { child };
}

/** Run a command to its end: its exit code and the end of what it said. */
async function runToEnd(ctx: ToolContext, line: string, env: Record<string, string>, ms: number): Promise<{ code: number | null; said: string }> {
  const { child } = await launch(ctx, line, env);
  child.stdin?.end();
  return new Promise((resolve) => {
    let said = "";
    const take = (d: Buffer) => {
      said = (said + d.toString("utf8")).slice(-4000);
    };
    child.stdout?.on("data", take);
    child.stderr?.on("data", take);
    const kill = () => {
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL");
      } catch {
        /* gone */
      }
    };
    const timer = setTimeout(() => {
      kill();
      said += `\n(stopped after ${Math.round(ms / 1000)} s)`;
    }, ms);
    ctx.signal.addEventListener("abort", kill, { once: true });
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ code: null, said: e.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      ctx.signal.removeEventListener("abort", kill);
      resolve({ code, said: said.trim() });
    });
  });
}

/** How one language's server is found, installed and started. */
interface ServerPlan {
  name: string;
  /** Folder under toolsDir, versioned: a new pin installs beside the old. */
  folder: string;
  /** The program, inside `folder`. */
  bin: string;
  args: string[];
  install: (tmp: string) => string;
  extraPath: string[];
}

async function planFor(lang: Language, ctx: ToolContext): Promise<ServerPlan | string> {
  if (lang === "go") {
    const go = findProgram("go", ctx);
    if (!go) return "Go is not installed here, so there is no Go language server — install Go 1.25 or newer";
    const v = await runToEnd(ctx, `exec ${shq(go)} env GOVERSION`, serverEnv(ctx, String(ctx.toolsDir), [path.dirname(go)]), 30_000);
    const minor = /^go1\.(\d+)/.exec(v.said)?.[1];
    const gopls = GOPLS_FOR_GO.find(([m]) => minor !== undefined && Number(minor) >= m)?.[1];
    if (!gopls) return `Go ${v.said || "(unknown version)"} is older than the Go language server builds with — Go 1.25 or newer is needed`;
    return {
      name: `gopls ${gopls}`,
      folder: `gopls-${gopls}`,
      bin: "bin/gopls",
      args: [],
      install: (tmp) => `GOBIN=${shq(path.join(tmp, "bin"))} ${shq(go)} install golang.org/x/tools/gopls@${gopls}`,
      extraPath: [path.dirname(go)],
    };
  }
  const npm = fs.existsSync(path.join(path.dirname(process.execPath), "npm")) ? path.join(path.dirname(process.execPath), "npm") : findProgram("npm", ctx);
  if (!npm) return "npm is not found next to node, so the language server cannot be installed";
  const [pkg, version, bin, args] = lang === "typescript"
    ? (["typescript", PINNED.typescript, "node_modules/.bin/tsc", ["--lsp", "--stdio"]] as const)
    : (["pyright", PINNED.pyright, "node_modules/.bin/pyright-langserver", ["--stdio"]] as const);
  return {
    name: `${pkg} ${version}`,
    folder: `${pkg}-${version}`,
    bin,
    args: [...args],
    install: (tmp) => `${shq(npm)} install --prefix ${shq(tmp)} --no-save --no-audit --no-fund --no-package-lock --loglevel=error ${pkg}@${version}`,
    extraPath: [path.dirname(npm)],
  };
}

/** One running server. Calls are taken one at a time, in order. */
export class LspClient {
  private buf = Buffer.alloc(0);
  private id = 0;
  private waiting = new Map<number, { resolve: (m: Json) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private queue: Promise<unknown> = Promise.resolve();
  private version = 0;
  exited: string | null = null;

  readonly child: ChildProcess;
  readonly name: string;
  readonly token?: string;
  /** Said once, with the first answer: the server was installed for this call. */
  installed = "";

  constructor(child: ChildProcess, name: string, token?: string) {
    this.child = child;
    this.name = name;
    if (token !== undefined) this.token = token;
    child.stdout?.on("data", (d: Buffer) => this.take(d));
    child.stderr?.on("data", () => {});
    const gone = (why: string) => {
      this.exited ??= why;
      for (const w of this.waiting.values()) {
        clearTimeout(w.timer);
        w.reject(new Error(`${name} stopped: ${why}`));
      }
      this.waiting.clear();
    };
    child.on("error", (e) => gone(e.message));
    child.on("close", (code) => gone(`exit ${code}`));
    child.stdin?.on("error", () => {});
  }

  private take(d: Buffer) {
    this.buf = Buffer.concat([this.buf, d]);
    // A server that sends more than any answer needs, or a frame that never ends, is stopped (Codex).
    if (this.buf.length > FRAME_MAX) {
      this.buf = Buffer.alloc(0);
      this.exited ??= `sent more than ${FRAME_MAX / 1024 / 1024} MB in one message`;
      this.stop();
      return;
    }
    for (;;) {
      const head = this.buf.indexOf("\r\n\r\n");
      if (head < 0) return;
      const n = Number(/content-length:\s*(\d+)/i.exec(this.buf.subarray(0, head).toString("latin1"))?.[1]);
      if (!Number.isFinite(n)) {
        this.buf = this.buf.subarray(head + 4);
        continue;
      }
      if (this.buf.length < head + 4 + n) return;
      let m: Json;
      try {
        m = JSON.parse(this.buf.subarray(head + 4, head + 4 + n).toString("utf8")) as Json;
      } catch {
        m = {};
      }
      this.buf = this.buf.subarray(head + 4 + n);
      if (typeof m.method === "string" && m.id !== undefined) {
        // A server's own request: settings are none, everything else is acknowledged.
        const items = ((m.params as Json | undefined)?.items as unknown[] | undefined) ?? [];
        this.send({ jsonrpc: "2.0", id: m.id, result: m.method === "workspace/configuration" ? items.map(() => null) : null });
      } else if (typeof m.id === "number" && this.waiting.has(m.id)) {
        const w = this.waiting.get(m.id)!;
        this.waiting.delete(m.id);
        clearTimeout(w.timer);
        w.resolve(m);
      }
    }
  }

  private send(m: Json) {
    if (this.exited) return;
    const s = JSON.stringify(m);
    this.child.stdin?.write(`Content-Length: ${Buffer.byteLength(s)}\r\n\r\n${s}`);
  }

  notify(method: string, params: unknown) {
    this.send({ jsonrpc: "2.0", method, params });
  }

  request(method: string, params: unknown, ms = REQUEST_MS): Promise<Json> {
    if (this.exited) return Promise.reject(new Error(`${this.name} stopped: ${this.exited}`));
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        reject(new Error(`${this.name} did not answer ${method} within ${Math.round(ms / 1000)} s`));
      }, ms);
      this.waiting.set(id, { resolve, reject, timer });
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }

  /** One call with `file` open at its current text, closed after. */
  withFile<T>(file: string, languageId: string, text: string, fn: (uri: string) => Promise<T>): Promise<T> {
    const run = async () => {
      const uri = pathToFileURL(file).href;
      this.notify("textDocument/didOpen", { textDocument: { uri, languageId, version: ++this.version, text } });
      try {
        return await fn(uri);
      } finally {
        this.notify("textDocument/didClose", { textDocument: { uri } });
      }
    };
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => undefined);
    return next;
  }

  stop() {
    try {
      if (this.child.pid) process.kill(-this.child.pid, "SIGKILL");
    } catch {
      /* gone */
    }
  }
}

type Servers = Map<Language, Promise<LspClient | string>>;
const serversOf = new WeakMap<ToolContext, Servers>();

/** This session's server for a language, installed and started on first use; a string says why there is none. */
export async function serverFor(lang: Language, ctx: ToolContext): Promise<LspClient | string> {
  let servers = serversOf.get(ctx);
  if (!servers) serversOf.set(ctx, (servers = new Map()));
  const have = servers.get(lang);
  if (have) {
    const c = await have;
    // Gone, or started under walls that have changed since: started again.
    if (typeof c === "string" || (!c.exited && !(c.token && ctx.sandbox?.fresh && !ctx.sandbox.fresh(c.token)))) return c;
    c.stop();
  }
  const p = start(lang, ctx);
  servers.set(lang, p);
  const c = await p;
  // A failure is not kept: the next call tries again (a network that was down).
  if (typeof c === "string") servers.delete(lang);
  return c;
}

async function start(lang: Language, ctx: ToolContext): Promise<LspClient | string> {
  if (!ctx.toolsDir) return "there is no place to install a language server in this session";
  const plan = await planFor(lang, ctx);
  if (typeof plan === "string") return plan;
  const dir = path.resolve(ctx.toolsDir);
  const home = path.join(dir, plan.folder);
  const env = serverEnv(ctx, dir, plan.extraPath);
  let installed = "";
  if (!fs.existsSync(path.join(home, plan.bin))) {
    // Installed beside, then moved into place in the same command, inside the walls: a half-done install is never
    // taken for a finished one, and two sessions installing at once leave one whole copy.
    const tmp = `${home}.part-${crypto.randomBytes(4).toString("hex")}`;
    const t0 = Date.now();
    const r = await runToEnd(
      ctx,
      `set -e; mkdir -p ${shq(dir)} ${shq(path.join(dir, "npm-cache"))}; ${plan.install(tmp)}; if [ -e ${shq(home)} ]; then rm -rf ${shq(tmp)}; else mv ${shq(tmp)} ${shq(home)}; fi`,
      env,
      INSTALL_MS,
    );
    if (r.code !== 0 || !fs.existsSync(path.join(home, plan.bin))) {
      await runToEnd(ctx, `rm -rf ${shq(tmp)}`, env, 30_000);
      return `${plan.name} could not be installed: ${r.said.split("\n").slice(-3).join(" ").slice(0, 400) || `exit ${r.code}`}`;
    }
    installed = `${plan.name} installed (once for this project, ${Math.round((Date.now() - t0) / 1000)} s)`;
  }
  const { child, token } = await launch(ctx, `exec ${[path.join(home, plan.bin), ...plan.args].map(shq).join(" ")}`, env);
  const c = new LspClient(child, plan.name, token);
  const root = pathToFileURL(path.resolve(ctx.cwd)).href;
  try {
    await c.request("initialize", {
      processId: process.pid,
      rootUri: root,
      workspaceFolders: [{ uri: root, name: path.basename(ctx.cwd) || "project" }],
      capabilities: { textDocument: { definition: { linkSupport: false }, references: {} }, workspace: { configuration: true, workspaceFolders: true } },
    }, START_MS);
  } catch (e) {
    c.stop();
    return `${plan.name} did not start: ${(e as Error).message}`;
  }
  c.notify("initialized", {});
  c.installed = installed;
  return c;
}

/** End this session's servers (the loop's end ends their groups too). */
export function stopServers(ctx: ToolContext): void {
  const servers = serversOf.get(ctx);
  if (!servers) return;
  for (const p of servers.values()) void p.then((c) => typeof c !== "string" && c.stop(), () => undefined);
  servers.clear();
}

/** The column (0-based, UTF-16 as LSP counts) of `symbol` on a line: the occurrence nearest `near`, whole words first. */
export function columnOf(text: string, symbol: string, near?: number): number | null {
  const esc = symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const find = (re: RegExp) => [...text.matchAll(re)].map((m) => m.index!);
  let at = find(new RegExp(`(?<![\\w$])${esc}(?![\\w$])`, "g"));
  if (!at.length) at = find(new RegExp(esc, "g"));
  if (!at.length) return null;
  if (near === undefined) return at[0]!;
  return at.reduce((a, b) => (Math.abs(b - near) < Math.abs(a - near) ? b : a));
}

interface Loc {
  file: string;
  line: number;
  character: number;
}

function locationsOf(result: unknown): Loc[] {
  const list = Array.isArray(result) ? result : result ? [result] : [];
  const out: Loc[] = [];
  for (const l of list as Json[]) {
    const uri = (l?.uri ?? l?.targetUri) as string | undefined;
    const range = (l?.range ?? l?.targetSelectionRange ?? l?.targetRange) as { start?: { line?: number; character?: number } } | undefined;
    if (typeof uri !== "string" || !uri.startsWith("file:")) continue;
    let file: string;
    try {
      file = fileURLToPath(uri);
    } catch {
      continue;
    }
    out.push({ file, line: Number(range?.start?.line ?? 0), character: Number(range?.start?.character ?? 0) });
  }
  return out;
}

/** Whether a path may be shown: the walls read it and the client's own rule allows it (Codex). */
function mayShow(ctx: ToolContext, file: string): boolean {
  let real = file;
  try {
    real = fs.realpathSync(file);
  } catch {
    return false;
  }
  if (ctx.sandbox && !(ctx.sandbox.canRead(file) && ctx.sandbox.canRead(real))) return false;
  if (ctx.readable && !(ctx.readable(file) && ctx.readable(real))) return false;
  return true;
}

const fail = (text: string): ToolOutcome => ({ text, isError: true });

export const SYMBOLS_DESCRIPTION =
  "Where a name in the code is defined, or everywhere it is used, answered by a language server (TypeScript and JavaScript, Python, Go) — follows imports, re-exports and types the way the compiler does, which Grep cannot. Give the file, the line, and the name as it is written on that line. The first call for a language may install its server once (some seconds).";

export const symbols: EngineTool = {
  name: "Symbols",
  description: SYMBOLS_DESCRIPTION,
  input_schema: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["definition", "references"], description: "definition: where it is defined; references: every place it is used" },
      file_path: { type: "string", description: "The file the name is written in" },
      line: { type: "integer", description: "The line it is on, counting from 1" },
      symbol: { type: "string", description: "The name as written on that line (e.g. add, User.save → save)" },
      column: { type: "integer", description: "Instead of symbol, or to choose between two on one line: the column, counting from 1" },
    },
    required: ["action", "file_path", "line"],
    additionalProperties: false,
  },
  readOnly: true,
  async run(input, ctx) {
    const action = input.action;
    if (action !== "definition" && action !== "references") return fail("action is definition or references");
    if (typeof input.file_path !== "string" || !input.file_path) return fail("file_path is the file the name is written in");
    const line = Number(input.line);
    if (!Number.isInteger(line) || line < 1) return fail("line counts from 1");
    const symbol = typeof input.symbol === "string" ? input.symbol.trim() : "";
    const column = input.column === undefined ? undefined : Number(input.column);
    if (column !== undefined && (!Number.isInteger(column) || column < 1)) return fail("column counts from 1");
    if (!symbol && column === undefined) return fail("give symbol (the name as written on that line) or column");
    // A server is a program: it runs only where programs run unasked — inside the walls or in a container (Codex).
    if (!ctx.programs) return fail("Symbols runs a language server, which runs only inside the sandbox (or in the cloud) — here, find it with Grep");
    // Nothing is read without a rule for what may be (the walls, or the client's own), nor where no server can run (Codex).
    if (!ctx.sandbox && !ctx.readable) return fail("Symbols is not available in this session (no rule for what it may read) — find it with Grep");
    if (!ctx.toolsDir) return fail("Symbols is not available in this session (no place for its language servers) — find it with Grep");
    const file = path.resolve(ctx.cwd, input.file_path);
    const lang = languageOf(file);
    if (!lang) return fail(`no language server for ${path.extname(file) || "files without an extension"} — Symbols reads TypeScript, JavaScript, Python and Go`);
    if (!mayShow(ctx, file)) return fail(`${input.file_path} is not a file this session may read`);
    let text: string;
    try {
      const st = fs.statSync(file);
      if (!st.isFile()) return fail(`${input.file_path} is not a file`);
      if (st.size > OPEN_BYTES_MAX) return fail(`${input.file_path} is larger than a language server is given (4 MB)`);
    } catch (e) {
      return fail(`${input.file_path} could not be read: ${(e as Error).message}`);
    }
    // Read as Read reads it: inside the walls, through the descriptor that was checked.
    const { readChecked } = await import("./engine-tools.ts");
    const got = await readChecked(ctx, file);
    if (typeof got === "string") return fail(got);
    text = got.subarray(0, OPEN_BYTES_MAX).toString("utf8");
    const lines = text.split("\n");
    const here = lines[line - 1];
    if (here === undefined) return fail(`${input.file_path} has ${lines.length} lines`);
    const character = symbol ? columnOf(here, symbol, column === undefined ? undefined : column - 1) : (column as number) - 1;
    if (character === null) return fail(`${JSON.stringify(symbol)} is not on line ${line} of ${input.file_path}: ${here.trim().slice(0, 200)}`);
    const server = await serverFor(lang, ctx);
    if (typeof server === "string") return fail(server);
    const position = { line: line - 1, character };
    let found: Loc[];
    try {
      const r = await server.withFile(file, LANGUAGE_ID[lang](file), text, (uri) =>
        action === "definition"
          ? server.request("textDocument/definition", { textDocument: { uri }, position })
          : server.request("textDocument/references", { textDocument: { uri }, position, context: { includeDeclaration: true } }),
      );
      if (r.error) return fail(`${server.name}: ${String((r.error as Json).message ?? "an error").slice(0, 300)}`);
      found = locationsOf(r.result);
    } catch (e) {
      return fail((e as Error).message);
    }
    const name = symbol || here.slice(character).match(/^[\w$]+/)?.[0] || `line ${line}:${character + 1}`;
    const note = server.installed;
    server.installed = "";
    const seen = new Set<string>();
    const shown: Loc[] = [];
    let hidden = 0;
    for (const l of found) {
      const key = `${l.file}:${l.line}:${l.character}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (!mayShow(ctx, l.file)) hidden += 1;
      else shown.push(l);
    }
    const head = `${note ? `(${note})\n` : ""}${action === "definition" ? "definition" : `${shown.length} reference${shown.length === 1 ? "" : "s"}`} of ${name} at ${input.file_path}:${line}:${character + 1}`;
    if (!shown.length) return { text: `${head}: none found${hidden ? ` (${hidden} in files this session may not read)` : ""}` };
    // In a fixed order — by file, then line — whatever order the server answered in.
    shown.sort((a, b) => (a.file === b.file ? a.line - b.line || a.character - b.character : a.file < b.file ? -1 : 1));
    let realCwd = ctx.cwd;
    try {
      realCwd = fs.realpathSync(ctx.cwd);
    } catch {
      /* as given */
    }
    const texts = new Map<string, string[]>();
    const listed = shown.slice(0, SYMBOLS_MAX);
    for (const f of new Set(listed.map((l) => l.file))) {
      let lines: string[] = [];
      try {
        if (fs.statSync(f).size <= OPEN_BYTES_MAX) {
          const b = f === file ? text : await readChecked(ctx, f);
          lines = typeof b === "string" && f !== file ? [] : String(typeof b === "string" ? b : b.toString("utf8")).split("\n");
        }
      } catch {
        /* the path alone */
      }
      texts.set(f, lines);
    }
    const rows = listed.map((l) => {
      // Said from the folder, whichever spelling of it the server used (a link such as macOS /var → /private/var).
      const inside = (base: string) => {
        const rel = path.relative(base, l.file);
        return rel && !rel.startsWith("..") && !path.isAbsolute(rel) ? rel : null;
      };
      const where = inside(ctx.cwd) ?? inside(realCwd) ?? l.file;
      const src = (texts.get(l.file)![l.line] ?? "").trim().slice(0, 200);
      return `${where}:${l.line + 1}:${l.character + 1}  ${src}`;
    });
    const more = shown.length > SYMBOLS_MAX ? `\n… and ${shown.length - SYMBOLS_MAX} more` : "";
    const cut = hidden ? `\n(${hidden} more in files this session may not read)` : "";
    return { text: `${head}:\n${rows.join("\n")}${more}${cut}` };
  },
};
