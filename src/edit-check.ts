/**
 * The syntax guard on Edit and Write (FOL-292): the text a change would leave is parsed before it is written, and a
 * change that would turn a file that parses into one that does not is refused, the file left as it was. The model sees
 * where and why, and fixes its edit — the guard SWE-agent measured (15% → 18% resolved), syntax only here: undefined
 * names and type errors come with the language-server layer (FOL-297).
 *
 * Checkers read the text on stdin and execute nothing of it:
 * - JSON in this process (files that allow comments — tsconfig, .vscode, *.jsonc — are left alone);
 * - JavaScript with this process's own node (`--check`), its environment cleared, in a neutral folder, in the grammar
 *   the file is loaded as: .cjs a script, .mjs a module, .js by the nearest package.json's "type";
 * - Python with a system python3 (`compile`, which is not running it), only where the step may already run programs
 *   unasked (inside the local walls, or in a container): a python3 found on a PATH could be the project's own.
 * A check that cannot finish in time, or a checker that is missing or fails, never blocks the change: it goes through,
 * said "not checked".
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

/** How long the checks of one change may take together, both texts. */
export const CHECK_MS = 3000;
/** Larger texts are not checked. */
export const CHECK_MAX_BYTES = 1_000_000;

export type Verdict =
  | { kind: "ok" }
  | { kind: "errors"; errors: string[] }
  | { kind: "unchecked"; why: string };

/** Files named like JSON that allow comments and trailing commas. */
const JSONC = /(^|\/)(tsconfig[^/]*\.json|jsconfig[^/]*\.json|\.eslintrc[^/]*|devcontainer\.json|[^/]*\.jsonc)$|(^|\/)\.(vscode|devcontainer)\//;

/** Which checker a file has, if any. */
export function checkerFor(file: string): "json" | "js" | "py" | null {
  const f = file.replace(/\\/g, "/");
  if (/\.json$/i.test(f)) return JSONC.test(f) ? null : "json";
  if (/\.(js|cjs|mjs)$/i.test(f)) return "js";
  if (/\.py$/i.test(f)) return "py";
  return null;
}

/**
 * The grammar node loads a file in: .mjs a module, .cjs a script, a .js file by the nearest package.json's "type" —
 * "module" or "commonjs" when it says so, else either (node detects it, Codex). A package.json is read only when it is
 * a plain file of a sane size the walls let this session read (`canRead`): a pipe or a denied path decides nothing.
 */
export function jsMode(file: string, walled = false): "commonjs" | "module" | "either" {
  if (/\.mjs$/i.test(file)) return "module";
  if (/\.cjs$/i.test(file)) return "commonjs";
  // Inside the walls this process reads nothing on the project's word: a path the walls deny could be swapped in
  // between their check and the open (Codex). Either grammar then — never a refusal node would not give.
  if (walled) return "either";
  for (let d = path.dirname(path.resolve(file)); ; d = path.dirname(d)) {
    // node's package scope stops at a node_modules folder (Codex): no type found, either grammar.
    if (path.basename(d) === "node_modules") return "either";
    const pj = path.join(d, "package.json");
    let st: fs.Stats | null = null;
    try {
      st = fs.statSync(pj);
    } catch {
      // none here: further up
    }
    if (st) {
      // Read by a descriptor opened without waiting and judged by itself: a pipe swapped in after the stat cannot
      // hold this process, nor a file grown past the cap (Codex).
      const text = readBounded(pj, 1_000_000);
      if (text === null) return "either";
      try {
        const j = JSON.parse(text);
        return j && j.type === "module" ? "module" : j && j.type === "commonjs" ? "commonjs" : "either";
      } catch {
        return "either";
      }
    }
    if (path.dirname(d) === d) return "either";
  }
}

/** A system python3 that runs nothing else first. On macOS /usr/bin/python3 without the command line tools opens an
 *  install dialog, so it counts only when they are there. */
export function systemPython(platform: NodeJS.Platform = process.platform, exists: (p: string) => boolean = fs.existsSync): string | null {
  const darwinTools = exists("/Library/Developer/CommandLineTools/usr/bin/python3") || exists("/Applications/Xcode.app/Contents/Developer/usr/bin/python3");
  const candidates = platform === "darwin" ? ["/opt/homebrew/bin/python3", "/usr/local/bin/python3", ...(darwinTools ? ["/usr/bin/python3"] : [])] : ["/usr/bin/python3", "/usr/local/bin/python3"];
  return candidates.find((p) => exists(p)) ?? null;
}

const PY_CHECK =
  "import sys\n" +
  "src = sys.stdin.buffer.read()\n" +
  "try:\n" +
  "    compile(src, sys.argv[1], 'exec', dont_inherit=True)\n" +
  "except (SyntaxError, ValueError) as e:\n" +
  "    print('%s:%s: %s: %s' % (getattr(e, 'lineno', None) or '?', getattr(e, 'offset', None) or '?', type(e).__name__, getattr(e, 'msg', None) or e))\n" +
  "    sys.exit(1)\n";

/** Run one checker program with the text on stdin: exit 0 = parses, 1 = a syntax error (its words), else unchecked. */
type Runner = (program: string, args: string[], input: string, ms: number) => Promise<{ code: number | null; out: string; timedOut: boolean }>;

/** Directly, from a neutral folder, with nothing of this process's environment. */
export const runDirect: Runner = (program, args, input, ms) =>
  new Promise((resolve) => {
    const child = spawn(program, args, { cwd: os.tmpdir(), env: { PATH: "/usr/bin:/bin" }, stdio: ["pipe", "pipe", "pipe"], detached: true });
    let out = "";
    let timedOut = false;
    const take = (b: Buffer) => {
      if (out.length < 20_000) out += b.toString("utf8");
    };
    child.stdout!.on("data", take);
    child.stderr!.on("data", take);
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL");
      } catch {
        // gone
      }
    }, Math.max(1, ms));
    child.on("error", () => {
      clearTimeout(timer);
      resolve({ code: null, out, timedOut });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, out, timedOut });
    });
    child.stdin!.on("error", () => undefined);
    child.stdin!.end(input);
  });

/** The grammar a package.json's text gives a .js file: its "type", or either when it says none or is not one. */
export function typeOf(text: string | null | undefined): "commonjs" | "module" | "either" {
  if (text === null) return "either";
  if (text === undefined) return "either";
  try {
    const j = JSON.parse(text);
    return j && j.type === "module" ? "module" : j && j.type === "commonjs" ? "commonjs" : "either";
  } catch {
    return "either";
  }
}

/** A file's text, read by a descriptor opened without waiting, only if it is a plain file of at most `max` bytes:
 *  null otherwise (a pipe, a device, too large, gone). */
export function readBounded(file: string, max = CHECK_MAX_BYTES): string | null {
  let fd: number | null = null;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.size > max) return null;
    const buf = Buffer.alloc(max + 1);
    let got = 0;
    while (got <= max) {
      const n = fs.readSync(fd, buf, got, max + 1 - got, got);
      if (n <= 0) break;
      got += n;
    }
    return got > max ? null : buf.subarray(0, got).toString("utf8");
  } catch {
    return null;
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}

/** node's words for a syntax error on stdin: "line L: SyntaxError: …". */
export function nodeError(out: string): string {
  const line = /\[stdin\]:(\d+)/.exec(out)?.[1];
  const msg = /^(SyntaxError: .*)$/m.exec(out)?.[1] ?? out.trim().split("\n").filter(Boolean).pop() ?? "syntax error";
  return `${line ? `line ${line}: ` : ""}${msg}`;
}

export interface CheckOptions {
  /** The step may run programs unasked here (local walls up, or a container): Python is checked too. */
  programs: boolean;
  /** How Python is run: through the walls when they are up. */
  runPython?: Runner;
  /** How node is run (tests). */
  runNode?: Runner;
  /** The local walls are up: no project file is read by this process to decide a grammar. */
  walled?: boolean;
  /** Inside the walls: the nearest package.json above `file`, read there — its text, null when there is none, or
   *  undefined when it could not be read (either grammar then). */
  manifest?: (file: string, ms: number) => Promise<string | null | undefined>;
  /** Milliseconds left for this check. */
  ms: number;
  python?: string | null;
}

/** Does `text`, as the content of `file`, parse? */
export async function checkText(file: string, text: string, o: CheckOptions): Promise<Verdict> {
  const kind = checkerFor(file);
  if (!kind) return { kind: "ok" };
  if (Buffer.byteLength(text) > CHECK_MAX_BYTES) return { kind: "unchecked", why: "the file is over 1 MB" };
  if (o.ms <= 0) return { kind: "unchecked", why: "no time was left to check it" };
  if (kind === "json") {
    try {
      JSON.parse(text);
      return { kind: "ok" };
    } catch (err) {
      return { kind: "errors", errors: [String(err instanceof Error ? err.message : err)] };
    }
  }
  if (kind === "js") {
    const until = Date.now() + o.ms;
    let mode = jsMode(file, o.walled === true);
    if (o.walled && mode === "either" && !/\.(mjs|cjs)$/i.test(file) && o.manifest) mode = typeOf(await o.manifest(file, o.ms));
    const once = async (asModule: boolean): Promise<Verdict> => {
      const args = asModule ? ["--input-type=module", "--check", "-"] : ["--check", "-"];
      const r = await (o.runNode ?? runDirect)(process.execPath, args, text, until - Date.now());
      if (r.timedOut) return { kind: "unchecked", why: "the check took too long" };
      if (r.code === 0) return { kind: "ok" };
      if (r.code === 1 && /SyntaxError/.test(r.out)) return { kind: "errors", errors: [nodeError(r.out)] };
      return { kind: "unchecked", why: "the checker failed" };
    };
    if (mode !== "either") return once(mode === "module");
    // Either grammar: errors only when both say so; the module's words when it reads like one.
    const script = await once(false);
    if (script.kind !== "errors") return script;
    if (until - Date.now() <= 0) return { kind: "unchecked", why: "the check took too long" };
    const mod = await once(true);
    if (mod.kind !== "errors") return mod;
    return /^\s*(import|export)\b/m.test(text) ? mod : script;
  }
  // Python
  if (!o.programs) return { kind: "unchecked", why: "Python is checked only where commands run in a sandbox" };
  const py = o.python === undefined ? systemPython() : o.python;
  if (!py) return { kind: "unchecked", why: "no system python3 to check it with" };
  const r = await (o.runPython ?? runDirect)(py, ["-I", "-S", "-c", PY_CHECK, path.basename(file)], text, o.ms);
  if (r.timedOut) return { kind: "unchecked", why: "the check took too long" };
  if (r.code === 0) return { kind: "ok" };
  if (r.code === 1) {
    const m = /^(\?|\d+):(\?|\d+): (.*)$/m.exec(r.out);
    if (m) return { kind: "errors", errors: [`line ${m[1]}${m[2] !== "?" ? `:${m[2]}` : ""}: ${m[3]}`] };
  }
  return { kind: "unchecked", why: "the checker failed" };
}

export type Guard = { refuse: string } | { note: string | null };

/**
 * Whether a change may be written: refused only when it turns a file that parses (or a new file) into one that does
 * not — a file already broken may be repaired step by step, though a parser names only its first error (Codex).
 * Both checks share one deadline.
 */
export async function guardChange(
  file: string,
  /** What is there now (null: a new file), or how to read it — asked only when the change does not parse (Codex);
   *  { unreadable: true } when it cannot be read, which is never refused for. */
  beforeOf: string | null | (() => Promise<string | null | { unreadable: true }>),
  after: string,
  o: Omit<CheckOptions, "ms">,
  ms = CHECK_MS,
): Promise<Guard> {
  const until = Date.now() + ms;
  const now = await checkText(file, after, { ...o, ms });
  if (now.kind === "ok") return { note: null };
  if (now.kind === "unchecked") return { note: checkerFor(file) === "py" && !o.programs ? null : `syntax not checked: ${now.why}` };
  const got = typeof beforeOf === "function" ? await beforeOf() : beforeOf;
  if (got !== null && typeof got === "object") return { note: `syntax not checked against the file as it was: it could not be read` };
  const before = got;
  if (before !== null) {
    const was = await checkText(file, before, { ...o, ms: until - Date.now() });
    if (was.kind !== "ok") return { note: `it still does not parse: ${now.errors[0]}` };
  }
  return {
    refuse:
      `${before === null ? "not written" : "not applied"} — ${file} would ${before === null ? "not parse" : "stop parsing"}: ${now.errors.slice(0, 3).join("; ")}. ` +
      `The file is ${before === null ? "not created" : "unchanged"}. Fix the change; if the file is meant not to parse (a test fixture), send it again with allow_syntax_errors: true.`,
  };
}
