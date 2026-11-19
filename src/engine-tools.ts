// The foldrun engine's own file and shell tools (engine-loop.ts).
//
// Six tools under the names every hook, `limits:` key, `disallowedTools:`
// entry and run record already matches on: Read, Write, Edit, Glob, Grep,
// Bash. The inputs keep the field names confine.ts checks (`file_path`,
// `path`, `pattern`, `glob`, `command`), so a call is confined by the same
// code whichever engine runs it.
//
// What these tools promise, because a model cannot see what it broke:
//
// - Edit and Write never touch a file the model has not read in this
//   session, nor one that changed on disk since it read it. The refusal says
//   which, and the model reads again.
// - Edit replaces exact text. No match, or more than one without
//   `replace_all`, is a refusal that names the count — never a guess.
// - A write lands whole or not at all: a temporary file beside the target,
//   then a rename.
// - Every result is bounded, and says so when it was cut.
//
// Nothing here decides whether a call is allowed. That is the loop's job,
// before the tool runs (the PreToolUse hook and canUseTool from step-exec).

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { Worker } from "node:worker_threads";

export interface ToolContext {
  /** Relative paths resolve here: the agent's directory. */
  cwd: string;
  /** The step's environment — what a shell command runs with. */
  env: Record<string, string | undefined>;
  /** Fires when the step is stopped: a running command is killed. */
  signal: AbortSignal;
  /** Files read in this session → their mtime when read. */
  reads: Map<string, number>;
  /** The process groups this session's commands started. A command that
   *  left something in the background has returned, but what it left is
   *  still the step's: the loop ends every group when the step ends. */
  groups: Set<number>;
}

/** End everything the session's commands started and left running. */
export function killGroups(ctx: ToolContext): void {
  for (const pgid of ctx.groups) {
    try {
      process.kill(-pgid, "SIGKILL");
    } catch {
      // the group is already gone
    }
  }
  ctx.groups.clear();
}

export interface ToolOutcome {
  text: string;
  isError?: boolean;
}

export interface EngineTool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
  /** Changes nothing: several in one turn may run side by side. */
  readOnly: boolean;
  run: (input: Record<string, unknown>, ctx: ToolContext) => Promise<ToolOutcome>;
}

/** The most one tool result puts into the conversation, in characters. */
export const RESULT_CAP = 30_000;
const READ_LINES = 2000;
const READ_LINE_CHARS = 2000;
const SEARCH_FILE_BYTES = 2 * 1024 * 1024;
const WALK_FILES = 20_000;
const GLOB_RESULTS = 200;
const GREP_RESULTS = 250;
/** How long one Grep may match for. A pattern the model wrote can take
 *  exponential time on the wrong text (`(a+)+$`); the matching runs in a
 *  worker thread that is ended at this limit or when the step is stopped,
 *  so it never freezes the process that runs the loop. */
export const GREP_MS = 30_000;
export const BASH_DEFAULT_MS = 120_000;
export const BASH_MAX_MS = 600_000;
const KILL_GRACE_MS = 2000;
/** Never searched: version control and installed dependencies. */
const SKIP_DIRS = new Set([".git", "node_modules"]);

const fail = (text: string): ToolOutcome => ({ text, isError: true });

/** Head and tail of a long text, with the cut said in the middle. */
export function capped(text: string, cap = RESULT_CAP): string {
  if (text.length <= cap) return text;
  const head = Math.floor(cap * 0.6);
  const tail = cap - head;
  return `${text.slice(0, head)}\n\n[… ${text.length - cap} characters cut …]\n\n${text.slice(text.length - tail)}`;
}

function str(input: Record<string, unknown>, key: string): string | null {
  const v = input[key];
  return typeof v === "string" ? v : null;
}

/** The file a path names, with links followed: what is read, checked for
 *  staleness and replaced is then one and the same file. A rename over the
 *  path as given would replace a link with a copy and leave its target as
 *  it was. For a file that does not exist yet, its folder is resolved. */
function abs(ctx: ToolContext, p: string): string {
  const given = path.resolve(ctx.cwd, p);
  try {
    return fs.realpathSync(given);
  } catch {
    try {
      return path.join(fs.realpathSync(path.dirname(given)), path.basename(given));
    } catch {
      return given;
    }
  }
}

function looksBinary(buf: Buffer): boolean {
  return buf.subarray(0, 8192).includes(0);
}

function writeWhole(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let mode: number | undefined;
  try {
    mode = fs.statSync(file).mode;
  } catch {
    // a new file takes the default mode
  }
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
  try {
    fs.writeFileSync(tmp, content, mode !== undefined ? { mode } : undefined);
    fs.renameSync(tmp, file);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}

/** Why an existing file may not be written yet, or null when it may. */
function staleReason(ctx: ToolContext, file: string): string | null {
  let mtime: number;
  try {
    mtime = fs.statSync(file).mtimeMs;
  } catch {
    return null; // no such file: nothing to be stale against
  }
  const seen = ctx.reads.get(file);
  if (seen === undefined) return `${file} exists and has not been read in this session — Read it first, then change it`;
  if (seen !== mtime) return `${file} changed on disk since it was read — Read it again, then change it`;
  return null;
}

const read: EngineTool = {
  name: "Read",
  description:
    "Read a text file. Returns its lines numbered as `<line>\\t<text>`. " +
    `At most ${READ_LINES} lines per call: pass offset (first line, from 1) and limit for the rest of a long file. ` +
    "A file must be read before Edit or Write may change it.",
  input_schema: {
    type: "object",
    properties: {
      file_path: { type: "string", description: "The file, absolute or relative to the working directory" },
      offset: { type: "integer", description: "The first line to return, from 1" },
      limit: { type: "integer", description: "How many lines to return" },
    },
    required: ["file_path"],
  },
  readOnly: true,
  async run(input, ctx) {
    const given = str(input, "file_path");
    if (!given) return fail("Read needs file_path");
    const file = abs(ctx, given);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(file);
    } catch {
      return fail(`${file} does not exist`);
    }
    if (stat.isDirectory()) return fail(`${file} is a directory — use Glob to list files`);
    const buf = fs.readFileSync(file);
    if (looksBinary(buf)) return fail(`${file} is not a text file`);
    ctx.reads.set(file, stat.mtimeMs);
    const text = buf.toString("utf8");
    if (!text.length) return { text: "(the file is empty)" };
    const lines = text.split("\n");
    if (lines[lines.length - 1] === "") lines.pop();
    const offset = Math.max(1, Number.isInteger(input.offset) ? (input.offset as number) : 1);
    const limit = Math.max(1, Math.min(READ_LINES, Number.isInteger(input.limit) ? (input.limit as number) : READ_LINES));
    if (offset > lines.length) return fail(`${file} has ${lines.length} lines; offset ${offset} is past the end`);
    const slice = lines.slice(offset - 1, offset - 1 + limit);
    const body = slice
      .map((l, i) => `${offset + i}\t${l.length > READ_LINE_CHARS ? `${l.slice(0, READ_LINE_CHARS)} [… line cut]` : l}`)
      .join("\n");
    const last = offset - 1 + slice.length;
    const more = last < lines.length ? `\n\n[lines ${offset}–${last} of ${lines.length}; pass offset: ${last + 1} for more]` : "";
    return { text: capped(body) + more };
  },
};

const write: EngineTool = {
  name: "Write",
  description:
    "Write a whole file, creating it and its folders if needed. Replaces what is there: an existing file must have been Read first. " +
    "To change part of a file, use Edit.",
  input_schema: {
    type: "object",
    properties: {
      file_path: { type: "string", description: "The file, absolute or relative to the working directory" },
      content: { type: "string", description: "The file's whole new content" },
    },
    required: ["file_path", "content"],
  },
  readOnly: false,
  async run(input, ctx) {
    const given = str(input, "file_path");
    const content = str(input, "content");
    if (!given || content === null) return fail("Write needs file_path and content");
    const file = abs(ctx, given);
    try {
      if (fs.statSync(file).isDirectory()) return fail(`${file} is a directory`);
    } catch {
      // new file
    }
    const stale = staleReason(ctx, file);
    if (stale) return fail(stale);
    const existed = fs.existsSync(file);
    writeWhole(file, content);
    ctx.reads.set(file, fs.statSync(file).mtimeMs);
    return { text: `${existed ? "Wrote" : "Created"} ${file} (${content.length} characters)` };
  },
};

/** How many times `needle` occurs in `hay`, without overlap. */
export function occurrences(hay: string, needle: string): number {
  if (!needle) return 0;
  let n = 0;
  for (let at = hay.indexOf(needle); at >= 0; at = hay.indexOf(needle, at + needle.length)) n++;
  return n;
}

const edit: EngineTool = {
  name: "Edit",
  description:
    "Replace exact text in a file that has been Read. old_string must match the file character for character, " +
    "whitespace and line breaks included, and must occur exactly once — add surrounding lines to make it unique, " +
    "or pass replace_all to change every occurrence. Nothing is changed when it does not match.",
  input_schema: {
    type: "object",
    properties: {
      file_path: { type: "string", description: "The file, absolute or relative to the working directory" },
      old_string: { type: "string", description: "The exact text to replace" },
      new_string: { type: "string", description: "What replaces it" },
      replace_all: { type: "boolean", description: "Replace every occurrence (default false)" },
    },
    required: ["file_path", "old_string", "new_string"],
  },
  readOnly: false,
  async run(input, ctx) {
    const given = str(input, "file_path");
    const from = str(input, "old_string");
    const to = str(input, "new_string");
    if (!given || from === null || to === null) return fail("Edit needs file_path, old_string and new_string");
    const file = abs(ctx, given);
    if (!fs.existsSync(file)) return fail(`${file} does not exist — use Write to create it`);
    if (fs.statSync(file).isDirectory()) return fail(`${file} is a directory`);
    const stale = staleReason(ctx, file);
    if (stale) return fail(stale);
    if (!from) return fail("old_string is empty — give the exact text to replace, or use Write for a whole file");
    if (from === to) return fail("old_string and new_string are the same — nothing to change");
    const buf = fs.readFileSync(file);
    if (looksBinary(buf)) return fail(`${file} is not a text file`);
    const before = buf.toString("utf8");
    const count = occurrences(before, from);
    if (count === 0) {
      const hint = before.includes("\r\n") && !from.includes("\r\n") && occurrences(before.replace(/\r\n/g, "\n"), from) > 0
        ? " The file uses CRLF line endings and old_string uses LF."
        : "";
      return fail(`old_string was not found in ${file} — nothing was changed.${hint} Read the file and copy the text exactly.`);
    }
    const all = input.replace_all === true;
    if (count > 1 && !all) {
      return fail(`old_string occurs ${count} times in ${file} — nothing was changed. Add surrounding lines so it matches once, or pass replace_all: true.`);
    }
    // split/join and slice, never String.replace: `$&` in new_string is text.
    const at = before.indexOf(from);
    const after = all ? before.split(from).join(to) : before.slice(0, at) + to + before.slice(at + from.length);
    writeWhole(file, after);
    ctx.reads.set(file, fs.statSync(file).mtimeMs);
    return { text: `Edited ${file} (${all ? count : 1} replacement${(all ? count : 1) === 1 ? "" : "s"})` };
  },
};

/** A glob as a regular expression over a `/`-separated relative path:
 *  `**` any folders, `*` within one name, `?` one character, `{a,b}`. */
export function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        i++;
        if (glob[i + 1] === "/") {
          i++;
          re += "(?:[^/]+/)*";
        } else re += ".*";
      } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else if (c === "{") {
      const end = glob.indexOf("}", i);
      if (end < 0) re += "\\{";
      else {
        re += `(?:${glob.slice(i + 1, end).split(",").map((s) => s.replace(/[.+^$()|[\]\\*?]/g, "\\$&")).join("|")})`;
        i = end;
      }
    } else re += /[.+^$()|[\]\\}]/.test(c) ? `\\${c}` : c;
  }
  return new RegExp(`^${re}$`);
}

/** Every file under `root`, as paths relative to it. Bounded. */
function walk(root: string): { files: string[]; cut: boolean } {
  const files: string[] = [];
  const stack = [""];
  while (stack.length) {
    const rel = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const child = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) stack.push(child);
      } else if (e.isFile()) {
        files.push(child);
        if (files.length >= WALK_FILES) return { files, cut: true };
      }
    }
  }
  return { files, cut: false };
}

function searchRoot(input: Record<string, unknown>, ctx: ToolContext): { root: string } | ToolOutcome {
  const given = str(input, "path");
  const root = given ? abs(ctx, given) : ctx.cwd;
  if (!fs.existsSync(root)) return fail(`${root} does not exist`);
  return { root: fs.realpathSync(root) };
}

const glob: EngineTool = {
  name: "Glob",
  description:
    "Find files by name pattern, such as `**/*.ts` or `src/**/*.test.js`. Returns matching paths, newest first. " +
    "Skips .git and node_modules.",
  input_schema: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "The glob, relative to path" },
      path: { type: "string", description: "The folder to search; the working directory when absent" },
    },
    required: ["pattern"],
  },
  readOnly: true,
  async run(input, ctx) {
    const pattern = str(input, "pattern");
    if (!pattern) return fail("Glob needs pattern");
    const where = searchRoot(input, ctx);
    if ("text" in where) return where;
    // The folders a pattern names before its first wildcard are where to
    // look, not something to match: `workspace/storage/*.md` searches
    // workspace/storage. The walk follows no links, and `workspace` is one
    // (confine.ts#linkWorkspace), so the root is resolved through it here.
    const segs = pattern.replace(/^\.\//, "").split("/");
    const wild = segs.findIndex((seg) => /[*?{]/.test(seg));
    const fixed = wild < 0 ? segs.slice(0, -1) : segs.slice(0, wild);
    const rest = segs.slice(fixed.length).join("/");
    if (fixed.length) {
      const deeper = path.join(where.root, ...fixed);
      if (!fs.existsSync(deeper)) return { text: `No files match ${pattern}` };
      where.root = fs.realpathSync(deeper);
    }
    const re = globToRegExp(rest);
    // A pattern with no folder in it matches at any depth, as people expect of `*.md`.
    const anyDepth = !pattern.includes("/");
    const { files, cut } = walk(where.root);
    const hits = files
      .filter((f) => re.test(anyDepth ? path.posix.basename(f) : f))
      .map((f) => {
        const full = path.join(where.root, f);
        let m = 0;
        try {
          m = fs.statSync(full).mtimeMs;
        } catch {
          // gone since the walk
        }
        return { full, m };
      })
      .sort((a, b) => b.m - a.m);
    if (!hits.length) return { text: `No files match ${pattern}${cut ? ` (search stopped at ${WALK_FILES} files)` : ""}` };
    const shown = hits.slice(0, GLOB_RESULTS).map((h) => h.full).join("\n");
    const more = hits.length > GLOB_RESULTS ? `\n\n[${hits.length - GLOB_RESULTS} more not shown — narrow the pattern]` : "";
    return { text: shown + more };
  },
};

// The matching half of Grep, run in a worker thread (see GREP_MS). It reads
// each file itself and skips the large and the binary, as the tool always did.
const MATCH_WORKER = `
const { parentPort, workerData: w } = require("node:worker_threads");
const fs = require("node:fs");
const re = new RegExp(w.pattern, w.flags);
const out = [];
let total = 0;
for (const full of w.files) {
  let buf;
  try {
    if (fs.statSync(full).size > w.maxBytes) continue;
    buf = fs.readFileSync(full);
  } catch {
    continue;
  }
  if (buf.subarray(0, 8192).includes(0)) continue;
  const lines = buf.toString("utf8").split("\\n");
  let inFile = 0;
  for (let i = 0; i < lines.length; i++) {
    if (!re.test(lines[i])) continue;
    inFile++;
    if (w.mode === "content" && out.length < w.limit) {
      out.push(full + ":" + (i + 1) + ":" + (lines[i].length > 500 ? lines[i].slice(0, 500) + " [… line cut]" : lines[i]));
    }
  }
  if (!inFile) continue;
  total += w.mode === "content" ? inFile : 1;
  if (w.mode === "files_with_matches" && out.length < w.limit) out.push(full);
  if (w.mode === "count" && out.length < w.limit) out.push(full + ":" + inFile);
}
parentPort.postMessage({ out, total });
`;

type MatchJob = { pattern: string; flags: string; files: string[]; mode: string; limit: number; maxBytes: number };
type MatchResult = { out: string[]; total: number } | { timedOut: true } | { stopped: true } | { error: string };

/** Run MATCH_WORKER over `job.files`; end it at `ms` or when `signal` fires. */
export function matchInWorker(job: MatchJob, signal: AbortSignal, ms: number): Promise<MatchResult> {
  if (signal.aborted) return Promise.resolve({ stopped: true });
  return new Promise((resolve) => {
    let settled = false;
    const worker = new Worker(MATCH_WORKER, { eval: true, workerData: job });
    const finish = (r: MatchResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      void worker.terminate();
      resolve(r);
    };
    const onAbort = () => finish({ stopped: true });
    const timer = setTimeout(() => finish({ timedOut: true }), ms);
    signal.addEventListener("abort", onAbort, { once: true });
    worker.once("message", (m: { out: string[]; total: number }) => finish(m));
    worker.once("error", (err: unknown) => finish({ error: err instanceof Error ? err.message : String(err) }));
    worker.once("exit", () => finish({ error: "the search ended without an answer" }));
  });
}

const grep: EngineTool = {
  name: "Grep",
  description:
    "Search file contents with a regular expression. output_mode: `files_with_matches` (default) lists files, " +
    "`content` shows matching lines as `path:line:text`, `count` gives matches per file. " +
    "`glob` limits which files are searched. Skips .git, node_modules and binary files.",
  input_schema: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "The regular expression (JavaScript syntax)" },
      path: { type: "string", description: "The file or folder to search; the working directory when absent" },
      glob: { type: "string", description: "Only files matching this glob, such as `*.ts`" },
      output_mode: { type: "string", enum: ["files_with_matches", "content", "count"] },
      "-i": { type: "boolean", description: "Ignore case" },
      head_limit: { type: "integer", description: "The most results to return" },
    },
    required: ["pattern"],
  },
  readOnly: true,
  async run(input, ctx) {
    const pattern = str(input, "pattern");
    if (!pattern) return fail("Grep needs pattern");
    let re: RegExp;
    try {
      re = new RegExp(pattern, input["-i"] === true ? "i" : "");
    } catch (err) {
      return fail(`pattern is not a valid regular expression: ${(err as Error).message}`);
    }
    const where = searchRoot(input, ctx);
    if ("text" in where) return where;
    const mode = str(input, "output_mode") ?? "files_with_matches";
    const limit = Math.max(1, Math.min(GREP_RESULTS, Number.isInteger(input.head_limit) ? (input.head_limit as number) : GREP_RESULTS));
    const filter = str(input, "glob");
    const filterRe = filter ? globToRegExp(filter.replace(/^\.\//, "")) : null;
    const filterAnyDepth = filter ? !filter.includes("/") : false;
    const single = fs.statSync(where.root).isFile();
    const { files, cut } = single ? { files: [""], cut: false } : walk(where.root);
    const chosen: string[] = [];
    for (const rel of files.sort()) {
      const full = single ? where.root : path.join(where.root, rel);
      // A file named outright is tested by its own name: it has no path
      // under a search root to match against.
      if (filterRe && !filterRe.test(single || filterAnyDepth ? path.basename(full) : rel)) continue;
      chosen.push(full);
    }
    const found = await matchInWorker(
      { pattern, flags: re.flags, files: chosen, mode, limit, maxBytes: SEARCH_FILE_BYTES },
      ctx.signal,
      GREP_MS,
    );
    if ("stopped" in found) return fail("the search was stopped");
    if ("timedOut" in found)
      return fail(`the search ran past ${GREP_MS / 1000} s and was ended: the pattern is too costly for this text. Use a simpler pattern or a narrower path or glob.`);
    if ("error" in found) return fail(`the search failed: ${found.error}`);
    const { out, total } = found;
    if (!out.length) return { text: `No matches for ${pattern}${cut ? ` (search stopped at ${WALK_FILES} files)` : ""}` };
    const more = total > out.length ? `\n\n[${total - out.length} more not shown — narrow the search or raise head_limit]` : "";
    return { text: capped(out.join("\n")) + more };
  },
};

const bash: EngineTool = {
  name: "Bash",
  description:
    "Run a shell command in the working directory and return its output (stdout and stderr together) and exit code. " +
    `Stops after timeout milliseconds (default ${BASH_DEFAULT_MS}, at most ${BASH_MAX_MS}). ` +
    "Each call is a new shell: a `cd` or a variable does not carry to the next. Use Read, Edit, Glob and Grep for files rather than cat, sed, find and grep.",
  input_schema: {
    type: "object",
    properties: {
      command: { type: "string", description: "The command line" },
      timeout: { type: "integer", description: "Milliseconds before the command is stopped" },
      description: { type: "string", description: "What the command does, in a few words" },
    },
    required: ["command"],
  },
  readOnly: false,
  run(input, ctx) {
    const command = str(input, "command");
    if (!command) return Promise.resolve(fail("Bash needs command"));
    const ms = Math.max(1000, Math.min(BASH_MAX_MS, Number.isInteger(input.timeout) ? (input.timeout as number) : BASH_DEFAULT_MS));
    return new Promise<ToolOutcome>((resolve) => {
      if (ctx.signal.aborted) return resolve(fail("the step was stopped before the command ran"));
      // Its own process group, so a stop or a timeout ends what it started
      // too — a test runner's children, a server it left in the background.
      const child = spawn("bash", ["-c", command], {
        cwd: ctx.cwd,
        env: ctx.env as NodeJS.ProcessEnv,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      if (child.pid) ctx.groups.add(child.pid);
      let out = "";
      let dropped = 0;
      const take = (chunk: Buffer) => {
        const s = chunk.toString("utf8");
        // Keep a bounded window while it runs: a command that prints forever
        // must not grow the step's memory.
        out += s;
        if (out.length > RESULT_CAP * 4) {
          const keepHead = RESULT_CAP;
          const keepTail = RESULT_CAP * 2;
          dropped += out.length - keepHead - keepTail;
          out = out.slice(0, keepHead) + out.slice(out.length - keepTail);
        }
      };
      child.stdout!.on("data", take);
      child.stderr!.on("data", take);
      let why: "timeout" | "stopped" | null = null;
      const killGroup = (signal: NodeJS.Signals) => {
        try {
          if (child.pid) process.kill(-child.pid, signal);
        } catch {
          // already gone
        }
      };
      const end = (reason: "timeout" | "stopped") => {
        if (why) return;
        why = reason;
        killGroup("SIGTERM");
        setTimeout(() => killGroup("SIGKILL"), KILL_GRACE_MS).unref();
      };
      const timer = setTimeout(() => end("timeout"), ms);
      const onAbort = () => end("stopped");
      ctx.signal.addEventListener("abort", onAbort, { once: true });
      const done = (text: string, isError: boolean) => {
        clearTimeout(timer);
        ctx.signal.removeEventListener("abort", onAbort);
        resolve({ text, ...(isError ? { isError: true } : {}) });
      };
      child.on("error", (err) => done(`the command could not start: ${err.message}`, true));
      child.on("close", (code, signal) => {
        const body = capped(out.trimEnd()) + (dropped ? `\n[${dropped} characters of output dropped while it ran]` : "");
        if (why === "timeout") return done(`${body}\n[stopped after ${ms} ms — the command did not finish]`.trim(), true);
        if (why === "stopped") return done(`${body}\n[stopped with the step]`.trim(), true);
        if (code === 0) return done(body || "(no output)", false);
        done(`${body}\n[exit code ${code ?? `none, signal ${signal}`}]`.trim(), true);
      });
    });
  },
};

/** The engine's built-in tools, by the name the model and core both use. */
export const ENGINE_TOOLS: Readonly<Record<string, EngineTool>> = {
  Read: read,
  Write: write,
  Edit: edit,
  Glob: glob,
  Grep: grep,
  Bash: bash,
};
