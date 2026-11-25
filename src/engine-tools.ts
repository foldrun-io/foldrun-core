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
import { randomBytes } from "node:crypto";
import { LAUNCHER } from "./local-sandbox.ts";
import { CHECK_MAX_BYTES, CHECK_MS, checkerFor, guardChange, readBounded, type CheckOptions } from "./edit-check.ts";

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
  /** On a person's machine, the walls (local-sandbox.ts): commands run
   *  through `wrap`; the file tools refuse what canRead / canWrite refuse. */
  sandbox?: import("./engine-common.ts").SandboxWalls | null;
  /** The step may run programs unasked here — inside the local walls, or in a container — so Edit and Write may
   *  check Python with a system python3 (edit-check.ts). Absent: only the checks that run nothing of the project. */
  programs?: boolean;
  /** How the syntax checks run, over the defaults (tests: a slow or failing checker). */
  checkWith?: Partial<Omit<CheckOptions, "ms">>;
  /** Commands started with Bash `run_in_background`, by id (FOL-293). They are in `groups` too, so they end with
   *  the step like anything else a command started. Absent: made on first use. */
  jobs?: Map<string, BgJob>;
  /** The letter a job id starts with (default "b"): a second list of jobs — foldrun code's outside the sandbox —
   *  names its own so neither is mistaken for the other. */
  jobPrefix?: string;
}

/** A command running in the background (Bash `run_in_background`, FOL-293). */
export interface BgJob {
  id: string;
  command: string;
  pid: number | undefined;
  /** Its output, held to a bounded tail; `base` is how many characters came before `out`'s first. */
  out: string;
  base: number;
  /** How far the model has read, in characters since the job started. */
  read: number;
  exit: { code: number | null; signal: NodeJS.Signals | null } | null;
  stdin: import("node:stream").Writable | null;
  /** Wakes a `wait` when output arrives or it exits. */
  wake: Set<() => void>;
  startedAt: number;
}

/** How Edit and Write check a change's syntax here: Python through the walls when they are up. */
function checkOptions(ctx: ToolContext): Omit<CheckOptions, "ms"> {
  return {
    programs: ctx.programs === true,
    walled: !!ctx.sandbox,
    ...(ctx.sandbox
      ? {
          // The nearest package.json, found and read inside the walls (a plain file, capped): what node will read.
          manifest: async (file: string, ms: number) => {
            const script =
              `d=${shq(path.dirname(path.resolve(file)))}; while :; do ` +
              `case "$d" in */node_modules) exit 3;; esac; ` +
              `if [ -e "$d/package.json" ]; then [ -f "$d/package.json" ] || exit 4; exec /usr/bin/head -c ${CHECK_MAX_BYTES + 1} -- "$d/package.json"; fi; ` +
              `[ "$d" = / ] && exit 3; d=$(/usr/bin/dirname -- "$d"); done`;
            try {
              const r = await runInside(ctx, script, "", Math.max(1, ms));
              if (r.code === 3) return null;
              if (r.code !== 0 || r.out.length > CHECK_MAX_BYTES) return undefined;
              return r.out.toString("utf8");
            } catch {
              return undefined;
            }
          },
        }
      : {}),
    ...(ctx.sandbox
      ? {
          runPython: async (program: string, args: string[], input: string, ms: number) => {
            try {
              const r = await runInside(ctx, `exec ${[program, ...args].map(shq).join(" ")}`, input, Math.max(1, ms));
              return { code: r.code, out: r.out.toString("utf8"), timedOut: /^ran past /.test(r.err) };
            } catch {
              return { code: null, out: "", timedOut: false };
            }
          },
        }
      : {}),
    ...ctx.checkWith,
  };
}

const ALLOW_SYNTAX_ERRORS = {
  type: "boolean",
  description: "Write it even though it would not parse (a test fixture meant to be invalid). Default false: a change that would break a file's syntax is refused, the file left as it was.",
};

/** A file's contents, read through the descriptor that was checked: inside
 *  the walls, the open file must be the very file now at the path the rules
 *  allow (same device and inode), so a path swapped between the check and
 *  the open is refused, not read. A string is the refusal. */
async function readChecked(ctx: ToolContext, file: string): Promise<Buffer | string> {
  if (!ctx.sandbox) return fs.readFileSync(file);
  // Inside the walls the read itself runs there (cat), so the OS holds it
  // however the path changes between a check and the read.
  const r = await runInside(ctx, `exec /bin/cat -- ${shq(file)}`, "");
  if (r.code !== 0) return `${file} could not be read: ${r.err || "the sandbox refused it"}`;
  return r.out;
}

/** Run a short helper inside the walls with nothing of the step's
 *  environment: its stdout as bytes, the last line of its stderr. */
async function runInside(ctx: ToolContext, script: string, input: string, ms = 60_000): Promise<{ code: number | null; out: Buffer; err: string }> {
  // A plain PATH inside for the helper's own commands (mkdir, mv…): what
  // they reach is the walls' business, not the PATH's.
  const { line, env } = await ctx.sandbox!.launch(script, { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" });
  return new Promise((resolve) => {
    const child = spawn(LAUNCHER, ["-c", line], { cwd: ctx.cwd, env: env as NodeJS.ProcessEnv, stdio: ["pipe", "pipe", "pipe"], detached: true });
    const chunks: Buffer[] = [];
    let err = "";
    let done = false;
    const end = (code: number | null, why?: string) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      ctx.signal.removeEventListener("abort", stop);
      resolve({ code, out: Buffer.concat(chunks), err: why ?? (err.trim().split("\n").pop() || (code === 0 ? "" : `exit ${code}`)) });
    };
    const kill = () => {
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL");
      } catch {
        /* gone */
      }
    };
    const stop = () => {
      kill();
      end(null, "stopped");
    };
    const timer = setTimeout(() => {
      kill();
      end(null, `ran past ${ms / 1000} s`);
    }, ms);
    ctx.signal.addEventListener("abort", stop, { once: true });
    child.stdout!.on("data", (c: Buffer) => chunks.push(c));
    child.stderr!.on("data", (c: Buffer) => {
      if (err.length < 4000) err += c.toString("utf8");
    });
    child.on("error", (e) => end(null, e.message));
    child.on("close", (code) => end(code));
    child.stdin!.on("error", () => undefined);
    child.stdin!.end(input, "utf8");
  });
}

/** The sandbox's answer for a path, as a tool's refusal — null when allowed. */
function walled(ctx: ToolContext, file: string, write: boolean): ToolOutcome | null {
  if (!ctx.sandbox) return null;
  if (write ? ctx.sandbox.canWrite(file) : ctx.sandbox.canRead(file)) return null;
  return fail(
    write
      ? `${file} is outside what this session may write (the project folder and its temp folder; never git hooks or config, never credentials)`
      : `${file} holds credentials this session may not read`,
  );
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
  /** When the tool returned images (an MCP server's screenshot): its text and
   *  images in their order, sent to the model so. `text` is still the whole
   *  text, for the record and the hooks. */
  parts?: ({ type: "text"; text: string } | { type: "image"; data: string; mediaType: string })[];
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

/** Write a file inside the walls: a small shell helper run there makes the
 *  folders, writes a temp file and renames it into place, so the OS holds
 *  the write wherever a path has been swapped meanwhile. */
async function writeInside(file: string, content: string, ctx: ToolContext): Promise<void> {
  // Folders, a temp file and the rename all happen inside the walls.
  let mode = "";
  try {
    mode = (fs.statSync(file).mode & 0o7777).toString(8);
  } catch {
    // a new file takes the default mode
  }
  const d = shq(path.dirname(file));
  const script =
    `mkdir -p -- ${d} && t=$(mktemp ${shq(path.join(path.dirname(file), `.${path.basename(file)}.XXXXXXXX`))}) || exit 1\n` +
    `if cat > "$t"${mode ? ` && chmod ${mode} "$t"` : ""} && mv -f -- "$t" ${shq(file)}; then exit 0; fi\n` +
    `rm -f -- "$t"; exit 1`;
  const r = await runInside(ctx, script, content);
  if (r.code !== 0) throw new Error(r.err || `the sandbox refused the write`);
}

const shq = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;

function writeWhole(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let mode: number | undefined;
  try {
    mode = fs.statSync(file).mode;
  } catch {
    // a new file takes the default mode
  }
  // A name nobody can have planted (random), created only if it is not
  // there (wx): a link left at a guessable name cannot redirect the write.
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${randomBytes(8).toString("hex")}.tmp`);
  try {
    fs.writeFileSync(tmp, content, { flag: "wx", ...(mode !== undefined ? { mode } : {}) });
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

/** The largest image Read shows a model: the providers take about 5 MB of base64 (FOL-295). */
export const READ_IMAGE_BYTES = Math.floor(3.75 * 1024 * 1024);

/** An image a model can be shown, by its first bytes — never by its name. */
export function imageMediaType(buf: Buffer): "image/png" | "image/jpeg" | "image/gif" | "image/webp" | null {
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf.length >= 6 && /^GIF8[79]a$/.test(buf.subarray(0, 6).toString("latin1"))) return "image/gif";
  if (buf.length >= 12 && buf.subarray(0, 4).toString("latin1") === "RIFF" && buf.subarray(8, 12).toString("latin1") === "WEBP") return "image/webp";
  return null;
}

/** An image's width and height from its header, or null when it cannot be read (FOL-295). */
export function imageDimensions(b: Buffer): { w: number; h: number } | null {
  const t = imageMediaType(b);
  if (t === "image/png" && b.length >= 24 && b.subarray(12, 16).toString("latin1") === "IHDR") return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
  if (t === "image/gif" && b.length >= 10) return { w: b.readUInt16LE(6), h: b.readUInt16LE(8) };
  if (t === "image/webp" && b.length >= 30) {
    const kind = b.subarray(12, 16).toString("latin1");
    if (kind === "VP8X") return { w: 1 + b.readUIntLE(24, 3), h: 1 + b.readUIntLE(27, 3) };
    if (kind === "VP8 ") return { w: b.readUInt16LE(26) & 0x3fff, h: b.readUInt16LE(28) & 0x3fff };
    if (kind === "VP8L") {
      const v = b.readUInt32LE(21);
      return { w: 1 + (v & 0x3fff), h: 1 + ((v >> 14) & 0x3fff) };
    }
    return null;
  }
  if (t === "image/jpeg") {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) return null;
      const marker = b[i + 1];
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return { w: b.readUInt16BE(i + 7), h: b.readUInt16BE(i + 5) };
      i += 2 + b.readUInt16BE(i + 2);
    }
  }
  return null;
}

/** The first bytes of a file, without reading all of it: inside the walls, there. */
async function headOf(ctx: ToolContext, file: string, n: number): Promise<Buffer | null> {
  if (ctx.sandbox) {
    const r = await runInside(ctx, `exec /usr/bin/head -c ${n} -- ${shq(file)}`, "");
    return r.code === 0 ? r.out : null;
  }
  try {
    const fd = fs.openSync(file, "r");
    try {
      const buf = Buffer.alloc(n);
      return buf.subarray(0, fs.readSync(fd, buf, 0, n, 0));
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
}

const read: EngineTool = {
  name: "Read",
  description:
    "Read a text file. Returns its lines numbered as `<line>\\t<text>`. " +
    "An image (PNG, JPEG, GIF, WebP — a screenshot, a design, a chart) is shown to you as the image, where the model takes images. " +
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
    const no = walled(ctx, file, false);
    if (no) return no;
    let stat: fs.Stats;
    try {
      stat = fs.statSync(file);
    } catch {
      return fail(`${file} does not exist`);
    }
    if (stat.isDirectory()) return fail(`${file} is a directory — use Glob to list files`);
    // A large image is told from its first bytes, before the whole file is read (Codex).
    if (stat.size > READ_IMAGE_BYTES) {
      const head = await headOf(ctx, file, 16);
      if (head && imageMediaType(head)) return fail(`${file} is a ${Math.round(stat.size / 1024)} KB image — larger than a model is shown (3.75 MB); make a smaller copy (sips -Z 1600 on a Mac, convert -resize 1600x1600 elsewhere) and Read that`);
    }
    const buf = await readChecked(ctx, file);
    if (typeof buf === "string") return fail(buf);
    // An image, shown as one (FOL-295): screenshots and designs for models that take images.
    const image = imageMediaType(buf);
    if (image) {
      const size = `${Math.max(1, Math.round(buf.length / 1024))} KB`;
      if (buf.length > READ_IMAGE_BYTES) return fail(`${file} is a ${size} image — larger than a model is shown (3.75 MB); make a smaller copy (sips -Z 1600 on a Mac, convert -resize 1600x1600 elsewhere) and Read that`);
      // An image whose size cannot be read, or too large a side, would fail the next model call (Codex).
      const dim = imageDimensions(buf);
      if (!dim || !dim.w || !dim.h) return fail(`${file} looks like an image but its header cannot be read — it may be damaged; not shown`);
      if (Math.max(dim.w, dim.h) > 8000) return fail(`${file} is ${dim.w}×${dim.h} px — larger than a model is shown (8000 px a side); make a smaller copy and Read that`);
      ctx.reads.set(file, stat.mtimeMs);
      const said = `${file}: ${image.slice(6).toUpperCase()} image, ${dim.w}×${dim.h} px, ${size}`;
      return { text: said, parts: [{ type: "text", text: said }, { type: "image", data: buf.toString("base64"), mediaType: image }] };
    }
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
      allow_syntax_errors: ALLOW_SYNTAX_ERRORS,
    },
    required: ["file_path", "content"],
  },
  readOnly: false,
  async run(input, ctx) {
    const given = str(input, "file_path");
    const content = str(input, "content");
    if (!given || content === null) return fail("Write needs file_path and content");
    const file = abs(ctx, given);
    const no = walled(ctx, file, true);
    if (no) return no;
    try {
      if (fs.statSync(file).isDirectory()) return fail(`${file} is a directory`);
    } catch {
      // new file
    }
    const stale = staleReason(ctx, file);
    if (stale) return fail(stale);
    const existed = fs.existsSync(file);
    // The syntax guard (FOL-292): a file that parses is not replaced by one that does not.
    let note: string | null = null;
    if (input.allow_syntax_errors !== true && checkerFor(file)) {
      // What is there, read only if the new content does not parse, and only up to the size checked (Codex).
      const beforeOf = async (): Promise<string | null | { unreadable: true }> => {
        if (!existed) return null;
        const no = { unreadable: true as const };
        if (!ctx.sandbox) return readBounded(file) ?? no;
        // Inside the walls the read runs there, and stops past the cap whatever the file has become.
        const r = await runInside(ctx, `exec /usr/bin/head -c ${CHECK_MAX_BYTES + 1} -- ${shq(file)}`, "", CHECK_MS);
        return r.code !== 0 || r.out.length > CHECK_MAX_BYTES ? no : r.out.toString("utf8");
      };
      const g = await guardChange(file, beforeOf, content, checkOptions(ctx));
      if ("refuse" in g) return fail(g.refuse);
      note = g.note;
      // While it was checked: stopped, or the file came, went or changed — nothing is written (Codex).
      if (ctx.signal.aborted) return fail(`${file} was not written: the step was stopped`);
      if (fs.existsSync(file) !== existed) return fail(`${file} was not written: it ${existed ? "was removed" : "appeared"} while the change was checked — Read it, then write again`);
      const again = staleReason(ctx, file);
      if (again) return fail(again);
    }
    try {
      if (ctx.sandbox) await writeInside(file, content, ctx);
      else writeWhole(file, content);
    } catch (err) {
      return fail(`${file} was not written: ${err instanceof Error ? err.message : String(err)}`);
    }
    ctx.reads.set(file, fs.statSync(file).mtimeMs);
    return { text: `${existed ? "Wrote" : "Created"} ${file} (${content.length} characters)${note ? `\n${note}` : ""}` };
  },
};

/** How many times `needle` occurs in `hay`, without overlap. */
export function occurrences(hay: string, needle: string): number {
  if (!needle) return 0;
  let n = 0;
  for (let at = hay.indexOf(needle); at >= 0; at = hay.indexOf(needle, at + needle.length)) n++;
  return n;
}

/** At most this many replacements in one Edit `edits` list (FOL-294). */
export const EDITS_MAX = 50;
/** The most text one file may become through an `edits` list: chained replace_all must not grow without bound (Codex). */
export const EDIT_TEXT_MAX = 16 * 1024 * 1024;

/** One file's replacements, worked out before anything is written: the new text, or why not. */
function applyEdits(file: string, before: string, list: { old_string: string; new_string: string; replace_all?: boolean }[]): { after: string; count: number } | { problem: string } {
  let text = before;
  let count = 0;
  for (const [i, e] of list.entries()) {
    const at = `${file}, change ${i + 1}`;
    if (!e.old_string) return { problem: `${at}: old_string is empty` };
    if (e.old_string === e.new_string) return { problem: `${at}: old_string and new_string are the same` };
    const n = occurrences(text, e.old_string);
    if (n === 0) return { problem: `${at}: old_string was not found${i ? " (after the changes before it in this file)" : ""} — Read the file and copy the text exactly` };
    if (n > 1 && e.replace_all !== true) return { problem: `${at}: old_string occurs ${n} times — add surrounding lines so it matches once, or pass replace_all: true` };
    const pos = text.indexOf(e.old_string);
    // Measured before it is built: n copies of new_string in place of old_string.
    const grows = (e.replace_all === true ? n : 1) * (e.new_string.length - e.old_string.length);
    if (text.length + grows > EDIT_TEXT_MAX) return { problem: `${at}: the file would grow past ${EDIT_TEXT_MAX / 1024 / 1024} MB` };
    text = e.replace_all === true ? text.split(e.old_string).join(e.new_string) : text.slice(0, pos) + e.new_string + text.slice(pos + e.old_string.length);
    count += e.replace_all === true ? n : 1;
  }
  return { after: text, count };
}

/**
 * Edit's `edits` (FOL-294): replacements across files, all or nothing. Every file is read, checked as Read and
 * unchanged since, and every replacement matched, before anything is written; the syntax guard sees each file's
 * final text; a write that fails puts back the files already written.
 */
async function editMany(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutcome> {
  const raw = input.edits;
  if (!Array.isArray(raw) || !raw.length) return fail("edits is a list of {file_path, old_string, new_string, replace_all?}");
  if (raw.length > EDITS_MAX) return fail(`edits holds at most ${EDITS_MAX} changes — split it`);
  for (const k of ["file_path", "old_string", "new_string", "replace_all"]) if (input[k] !== undefined) return fail(`give either edits or ${k} (one change), not both`);
  /** Per file, in the order first named, its changes in order. */
  const byFile = new Map<string, { old_string: string; new_string: string; replace_all?: boolean }[]>();
  for (const [i, e] of raw.entries()) {
    const o = (e && typeof e === "object" ? e : {}) as Record<string, unknown>;
    const given = str(o, "file_path");
    const from = str(o, "old_string");
    const to = str(o, "new_string");
    if (!given || from === null || to === null) return fail(`edits[${i}] needs file_path, old_string and new_string`);
    const file = abs(ctx, given);
    const list = byFile.get(file) ?? [];
    list.push({ old_string: from, new_string: to, ...(o.replace_all === true ? { replace_all: true } : {}) });
    byFile.set(file, list);
  }
  // One file named by two paths (a link) would be written twice from the same old text: refused (FOL-294).
  const reals = new Map<string, string>();
  for (const file of byFile.keys()) {
    let r = file;
    try {
      r = fs.realpathSync(file);
    } catch {
      /* missing: said below */
    }
    const other = reals.get(r);
    if (other) return fail(`nothing was changed: ${other} and ${file} are the same file — name it one way`);
    reals.set(r, file);
  }
  const plan: { file: string; before: string; after: string; count: number }[] = [];
  for (const [file, list] of byFile) {
    const no = walled(ctx, file, true);
    if (no) return fail(`nothing was changed: ${no.text}`);
    if (!fs.existsSync(file)) return fail(`nothing was changed: ${file} does not exist — use Write to create it`);
    if (fs.statSync(file).isDirectory()) return fail(`nothing was changed: ${file} is a directory`);
    const stale = staleReason(ctx, file);
    if (stale) return fail(`nothing was changed: ${stale}`);
    const buf = await readChecked(ctx, file);
    if (typeof buf === "string") return fail(`nothing was changed: ${buf}`);
    if (looksBinary(buf)) return fail(`nothing was changed: ${file} is not a text file`);
    const before = buf.toString("utf8");
    const r = applyEdits(file, before, list);
    if ("problem" in r) return fail(`nothing was changed: ${r.problem}`);
    plan.push({ file, before, after: r.after, count: r.count });
  }
  const notes: string[] = [];
  if (input.allow_syntax_errors !== true) {
    for (const p of plan) {
      if (!checkerFor(p.file)) continue;
      const g = await guardChange(p.file, p.before, p.after, checkOptions(ctx));
      if ("refuse" in g) return fail(`nothing was changed: ${g.refuse}`);
      if (g.note) notes.push(g.note);
      if (ctx.signal.aborted) return fail("nothing was changed: the step was stopped");
    }
    // The checks took time: each file is still as it was read.
    for (const p of plan) {
      const again = fs.existsSync(p.file) ? staleReason(ctx, p.file) : `${p.file} was removed while the change was checked`;
      if (again) return fail(`nothing was changed: ${again}`);
    }
  }
  const done: typeof plan = [];
  /** Put back what this call wrote — a file only while it holds this call's text, never over a change since (Codex).
   *  A change landing between that read and the write back is the window every Edit has between its stale check
   *  and its write; nothing here locks a file against other programs. */
  const undo = async (list: typeof plan): Promise<string[]> => {
    const left: string[] = [];
    for (const d of list) {
      let now: string | null = null;
      try {
        now = fs.readFileSync(d.file, "utf8");
      } catch {
        /* gone: nothing of ours to take back */
      }
      if (now === null || now === d.before) continue;
      if (now !== d.after) {
        left.push(`${d.file} (changed by something else since — left as it is)`);
        continue;
      }
      try {
        if (ctx.sandbox) await writeInside(d.file, d.before, ctx);
        else writeWhole(d.file, d.before);
        ctx.reads.set(d.file, fs.statSync(d.file).mtimeMs);
      } catch {
        left.push(`${d.file} (could not be put back — it holds the new text)`);
      }
    }
    return left;
  };
  for (const p of plan) {
    // Each file just before its write: one changed meanwhile is not written over (Codex).
    const moved = fs.existsSync(p.file) ? staleReason(ctx, p.file) : `${p.file} was removed`;
    if (moved) {
      const left = await undo(done);
      return fail(`nothing was changed: ${moved}${left.length ? `; and ${left.join(", ")}` : done.length ? "; the files written before it were put back" : ""}`);
    }
    try {
      if (ctx.sandbox) await writeInside(p.file, p.after, ctx);
      else writeWhole(p.file, p.after);
      done.push(p);
      ctx.reads.set(p.file, fs.statSync(p.file).mtimeMs);
    } catch (err) {
      // All or nothing: what was written goes back — this file too, if its write landed before the error.
      const left = await undo([...done, p]);
      return fail(`nothing was changed: ${p.file} could not be written (${err instanceof Error ? err.message : String(err)})${left.length ? `; and ${left.join(", ")}` : done.length ? "; the files written before it were put back" : ""}`);
    }
  }
  const total = plan.reduce((n, p) => n + p.count, 0);
  return { text: `Edited ${plan.length} file${plan.length === 1 ? "" : "s"} (${total} replacement${total === 1 ? "" : "s"}): ${plan.map((p) => p.file).join(", ")}${notes.length ? `\n${notes.join("\n")}` : ""}` };
}

const edit: EngineTool = {
  name: "Edit",
  description:
    "Replace exact text in a file that has been Read. old_string must match the file character for character, " +
    "whitespace and line breaks included, and must occur exactly once — add surrounding lines to make it unique, " +
    "or pass replace_all to change every occurrence. Nothing is changed when it does not match. " +
    "For one change made across several files (a rename, a signature and its callers), pass edits: a list of " +
    "{file_path, old_string, new_string, replace_all?} applied in order, all or nothing — every file Read first.",
  input_schema: {
    type: "object",
    properties: {
      file_path: { type: "string", description: "The file, absolute or relative to the working directory" },
      old_string: { type: "string", description: "The exact text to replace" },
      new_string: { type: "string", description: "What replaces it" },
      replace_all: { type: "boolean", description: "Replace every occurrence (default false)" },
      edits: {
        type: "array",
        description: `Instead of the four above: up to ${EDITS_MAX} changes across files, all applied or none`,
        items: {
          type: "object",
          properties: {
            file_path: { type: "string" },
            old_string: { type: "string" },
            new_string: { type: "string" },
            replace_all: { type: "boolean" },
          },
          required: ["file_path", "old_string", "new_string"],
        },
      },
      allow_syntax_errors: ALLOW_SYNTAX_ERRORS,
    },
  },
  readOnly: false,
  async run(input, ctx) {
    if (input.edits !== undefined) return editMany(input, ctx);
    const given = str(input, "file_path");
    const from = str(input, "old_string");
    const to = str(input, "new_string");
    if (!given || from === null || to === null) return fail("Edit needs file_path, old_string and new_string");
    const file = abs(ctx, given);
    const no = walled(ctx, file, true);
    if (no) return no;
    if (!fs.existsSync(file)) return fail(`${file} does not exist — use Write to create it`);
    if (fs.statSync(file).isDirectory()) return fail(`${file} is a directory`);
    const stale = staleReason(ctx, file);
    if (stale) return fail(stale);
    if (!from) return fail("old_string is empty — give the exact text to replace, or use Write for a whole file");
    if (from === to) return fail("old_string and new_string are the same — nothing to change");
    const buf = await readChecked(ctx, file);
    if (typeof buf === "string") return fail(buf);
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
    // The syntax guard (FOL-292): an edit that would make a file that parses stop parsing is refused.
    let note: string | null = null;
    if (input.allow_syntax_errors !== true && checkerFor(file)) {
      const g = await guardChange(file, before, after, checkOptions(ctx));
      if ("refuse" in g) return fail(g.refuse);
      note = g.note;
      if (ctx.signal.aborted) return fail(`${file} was not changed: the step was stopped`);
      if (!fs.existsSync(file)) return fail(`${file} was not changed: it was removed while the change was checked`);
      const again = staleReason(ctx, file);
      if (again) return fail(again);
    }
    try {
      if (ctx.sandbox) await writeInside(file, after, ctx);
      else writeWhole(file, after);
    } catch (err) {
      return fail(`${file} was not changed: ${err instanceof Error ? err.message : String(err)}`);
    }
    ctx.reads.set(file, fs.statSync(file).mtimeMs);
    return { text: `Edited ${file} (${all ? count : 1} replacement${(all ? count : 1) === 1 ? "" : "s"})${note ? `\n${note}` : ""}` };
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

/** The most folders one walk opens: a tree of empty folders is bounded too. */
const WALK_DIRS = 20_000;
/** The most alternatives a glob's braces may expand to. */
export const GLOB_ALTERNATIVES = 64;

type GlobToken = { t: "lit"; c: string } | { t: "one" } | { t: "star" } | { t: "any" } | { t: "dirs" };

/** `{a,b}` expanded, as globToRegExp reads braces: no nesting, the inside literal. */
function expandBraces(glob: string): string[] | null {
  const i = glob.indexOf("{");
  if (i < 0) return [glob];
  const end = glob.indexOf("}", i);
  if (end < 0) return [glob];
  const rest = expandBraces(glob.slice(end + 1));
  if (!rest) return null;
  const out: string[] = [];
  for (const alt of glob.slice(i + 1, end).split(",")) {
    for (const r of rest) {
      out.push(`${glob.slice(0, i)}\u0000${alt}\u0000${r}`);
      if (out.length > GLOB_ALTERNATIVES) return null;
    }
  }
  return out;
}

function globTokens(glob: string): GlobToken[] {
  const out: GlobToken[] = [];
  let literal = false;
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    // \u0000 brackets a brace's alternative: its characters are literal.
    if (c === "\u0000") {
      literal = !literal;
      continue;
    }
    if (literal) out.push({ t: "lit", c });
    else if (c === "*") {
      if (glob[i + 1] === "*") {
        i++;
        if (glob[i + 1] === "/") {
          i++;
          out.push({ t: "dirs" });
        } else out.push({ t: "any" });
      } else out.push({ t: "star" });
    } else if (c === "?") out.push({ t: "one" });
    else out.push({ t: "lit", c });
  }
  return out;
}

/** Whether `text` matches the tokens: a table over tokens × positions, so
 *  the time is bounded by their product whatever the pattern (Codex: a
 *  backtracking regular expression is not). */
function tokensMatch(tokens: GlobToken[], text: string): boolean {
  const n = text.length;
  let cur = new Uint8Array(n + 1);
  cur[0] = 1;
  for (const tok of tokens) {
    const next = new Uint8Array(n + 1);
    if (tok.t === "lit") {
      for (let j = 0; j < n; j++) if (cur[j] && text[j] === tok.c) next[j + 1] = 1;
    } else if (tok.t === "one") {
      for (let j = 0; j < n; j++) if (cur[j] && text[j] !== "/") next[j + 1] = 1;
    } else if (tok.t === "star" || tok.t === "any") {
      for (let j = 0; j <= n; j++) {
        // `**` stops at a line break as the `.*` it was always read as does.
        if (cur[j] || (j > 0 && next[j - 1] && (tok.t === "any" ? !/[\n\r\u2028\u2029]/.test(text[j - 1]!) : text[j - 1] !== "/"))) next[j] = 1;
      }
    } else {
      // Zero or more whole folders: `name/` repeated, each name non-empty.
      for (let j = 0; j <= n; j++) {
        if (cur[j]) next[j] = 1;
        if (!next[j]) continue;
        const slash = text.indexOf("/", j);
        if (slash > j) next[slash + 1] = 1;
      }
    }
    cur = next;
  }
  return cur[n] === 1;
}

/** A glob as a test over a `/`-separated relative path — the same language
 *  as globToRegExp, matched in bounded time. Throws when its braces expand
 *  past GLOB_ALTERNATIVES. */
export function globMatcher(glob: string): (text: string) => boolean {
  const alts = expandBraces(glob);
  if (!alts) throw new Error(`the glob's braces make more than ${GLOB_ALTERNATIVES} patterns — name fewer`);
  const compiled = alts.map(globTokens);
  return (text) => compiled.some((t) => tokensMatch(t, text));
}

/** Why a glob is refused, or null. */
export function globProblem(glob: string): string | null {
  return expandBraces(glob) ? null : `the glob's braces make more than ${GLOB_ALTERNATIVES} patterns — name fewer`;
}

/** Every file under `root`, as paths relative to it. Bounded. */
// The listing half of Glob and Grep, as a node program inside the walls:
// there the OS, not a check made before, decides which folders it may list.
const WALK_CHILD = `
const fs = process.getBuiltinModule("node:fs");
const path = process.getBuiltinModule("node:path");
const w = JSON.parse(fs.readFileSync(0, "utf8"));
const skip = new Set(w.skip);
const files = [];
const stack = [""];
let dirs = 0;
let cut = false;
outer: while (stack.length) {
  if (++dirs > w.maxDirs) { cut = true; break; }
  const rel = stack.pop();
  let entries;
  try { entries = fs.readdirSync(path.join(w.root, rel), { withFileTypes: true }); } catch { continue; }
  for (const e of entries) {
    const child = rel ? rel + "/" + e.name : e.name;
    if (e.isDirectory()) { if (!skip.has(e.name)) stack.push(child); }
    else if (e.isFile()) { files.push(child); if (files.length >= w.maxFiles) { cut = true; break outer; } }
  }
}
process.stdout.write(JSON.stringify({ files, cut }));
`;

/** walk(), inside the walls when there are walls; what the rules deny is
 *  left out again here, as a second net. */
async function walkAny(root: string, ctx: ToolContext): Promise<{ files: string[]; cut: boolean } | ToolOutcome> {
  if (!ctx.sandbox) return walk(root);
  const r = await runInside(ctx, `exec ${shq(process.execPath)} -e ${shq(WALK_CHILD)}`, JSON.stringify({ root, skip: [...SKIP_DIRS], maxDirs: WALK_DIRS, maxFiles: WALK_FILES }));
  if (r.code !== 0) return fail(`the folder could not be listed: ${r.err}`);
  let got: { files: string[]; cut: boolean };
  try {
    got = JSON.parse(r.out.toString("utf8")) as { files: string[]; cut: boolean };
  } catch {
    return fail("the folder listing gave no readable answer");
  }
  return { files: got.files.filter((rel) => ctx.sandbox!.canRead(path.join(root, rel))), cut: got.cut };
}

function walk(root: string, ctx?: ToolContext): { files: string[]; cut: boolean } {
  // Inside the walls, a folder or file the session may not read is neither
  // entered nor listed: a search from the home folder skips ~/.ssh.
  const hidden = ctx?.sandbox ? (rel: string) => !ctx.sandbox!.canRead(path.join(root, rel)) : () => false;
  const files: string[] = [];
  const stack = [""];
  let dirs = 0;
  while (stack.length) {
    if (++dirs > WALK_DIRS) return { files, cut: true };
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
        if (!SKIP_DIRS.has(e.name) && !hidden(child)) stack.push(child);
      } else if (e.isFile()) {
        if (hidden(child)) continue;
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
  const no = walled(ctx, root, false);
  if (no) return no;
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
    const tooWild = globProblem(pattern);
    if (tooWild) return fail(tooWild);
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
      // The deny first, the same answer whether or not the path is there.
      const denied = walled(ctx, deeper, false);
      if (denied) return denied;
      if (!fs.existsSync(deeper)) return { text: `No files match ${pattern}` };
      where.root = fs.realpathSync(deeper);
      const no = walled(ctx, where.root, false);
      if (no) return no;
    }
    const re = { test: globMatcher(rest) };
    // A pattern with no folder in it matches at any depth, as people expect of `*.md`.
    const anyDepth = !pattern.includes("/");
    const listed = await walkAny(where.root, ctx);
    if ("text" in listed) return listed;
    const { files, cut } = listed;
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
const { parentPort, workerData: w } = process.getBuiltinModule("node:worker_threads");
const fs = process.getBuiltinModule("node:fs");
const re = new RegExp(w.pattern, w.flags);
const out = [];
let total = 0;
const seen = {};
for (const full of w.files) {
  let buf;
  try {
    const fd = fs.openSync(full, "r");
    try {
      const st = fs.fstatSync(fd, { bigint: true });
      if (Number(st.size) > w.maxBytes) continue;
      seen[full] = { id: st.dev + ":" + st.ino, n: 0 };
      buf = fs.readFileSync(fd);
    } finally {
      fs.closeSync(fd);
    }
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
  seen[full].n = w.mode === "content" ? inFile : 1;
  total += w.mode === "content" ? inFile : 1;
  if (w.mode === "files_with_matches" && out.length < w.limit) out.push(full);
  if (w.mode === "count" && out.length < w.limit) out.push(full + ":" + inFile);
}
parentPort.postMessage({ out, total, seen });
`;

type MatchJob = { pattern: string; flags: string; files: string[]; mode: string; limit: number; maxBytes: number };
type MatchResult = { out: string[]; total: number; seen?: Record<string, { id: string; n: number }> } | { timedOut: true } | { stopped: true } | { error: string };

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
    worker.once("message", (m: { out: string[]; total: number; seen?: Record<string, { id: string; n: number }> }) => finish(m));
    worker.once("error", (err: unknown) => finish({ error: err instanceof Error ? err.message : String(err) }));
    worker.once("exit", () => finish({ error: "the search ended without an answer" }));
  });
}

/** MATCH_WORKER as a node program inside the walls: the job on stdin, the
 *  answer on stdout. The OS, not this process, decides what it may read. */
const MATCH_CHILD = MATCH_WORKER.replace(
  `const { parentPort, workerData: w } = process.getBuiltinModule("node:worker_threads");`,
  `const w = JSON.parse(process.getBuiltinModule("node:fs").readFileSync(0, "utf8"));\nconst parentPort = { postMessage: (m) => process.stdout.write(JSON.stringify(m)) };`,
);

async function matchInside(job: MatchJob, ctx: ToolContext, ms: number): Promise<MatchResult> {
  if (ctx.signal.aborted) return { stopped: true };
  const r = await runInside(ctx, `exec ${shq(process.execPath)} -e ${shq(MATCH_CHILD)}`, JSON.stringify(job), ms);
  if (r.err === "stopped") return { stopped: true };
  if (r.code === null && /ran past/.test(r.err)) return { timedOut: true };
  if (r.code !== 0) return { error: r.err || "the search ended without an answer" };
  try {
    return JSON.parse(r.out.toString("utf8")) as MatchResult;
  } catch {
    return { error: "the search gave no readable answer" };
  }
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
    const tooWild = filter ? globProblem(filter) : null;
    if (tooWild) return fail(tooWild);
    const filterRe = filter ? { test: globMatcher(filter.replace(/^\.\//, "")) } : null;
    const filterAnyDepth = filter ? !filter.includes("/") : false;
    const single = fs.statSync(where.root).isFile();
    const listed = single ? { files: [""], cut: false } : await walkAny(where.root, ctx);
    if ("text" in listed) return listed;
    const { files, cut } = listed;
    const chosen: string[] = [];
    for (const rel of files.sort()) {
      const full = single ? where.root : path.join(where.root, rel);
      // A file named outright is tested by its own name: it has no path
      // under a search root to match against.
      if (filterRe && !filterRe.test(single || filterAnyDepth ? path.basename(full) : rel)) continue;
      chosen.push(full);
    }
    const job = { pattern, flags: re.flags, files: chosen, mode, limit, maxBytes: SEARCH_FILE_BYTES };
    const found = ctx.sandbox ? await matchInside(job, ctx, GREP_MS) : await matchInWorker(job, ctx.signal, GREP_MS);
    if ("stopped" in found) return fail("the search was stopped");
    if ("timedOut" in found)
      return fail(`the search ran past ${GREP_MS / 1000} s and was ended: the pattern is too costly for this text. Use a simpler pattern or a narrower path or glob.`);
    if ("error" in found) return fail(`the search failed: ${found.error}`);
    let { out, total } = found;
    // Inside the walls the search ran there, so the OS held its reads; as a
    // second net, a file now at a path the rules deny (or swapped since it
    // was read) is left out of the answer, its count too.
    if (ctx.sandbox && found.seen) {
      const bad = new Set<string>();
      for (const [full, { id }] of Object.entries(found.seen)) {
        try {
          const real = fs.realpathSync.native(full);
          const st = fs.statSync(real, { bigint: true });
          if (`${st.dev}:${st.ino}` !== id || !ctx.sandbox.canRead(real)) bad.add(full);
        } catch {
          bad.add(full);
        }
      }
      if (bad.size) {
        // Neither its lines nor its count: the total is over accepted files.
        out = out.filter((line) => ![...bad].some((b) => line === b || line.startsWith(`${b}:`)));
        total = Object.entries(found.seen).reduce((sum, [full, f]) => sum + (bad.has(full) ? 0 : f.n), 0);
      }
    }
    if (!out.length) return { text: `No matches for ${pattern}${cut ? ` (search stopped at ${WALK_FILES} files)` : ""}` };
    const more = total > out.length ? `\n\n[${total - out.length} more not shown — narrow the search or raise head_limit]` : "";
    return { text: capped(out.join("\n")) + more };
  },
};

/** At most this many background jobs a step keeps at once; a finished one can be dropped by reading it after it ended. */
export const BG_JOBS_MAX = 8;
/** How long a background start waits for its first output before answering. */
const BG_FIRST_MS = 1000;
/** How long text written to a job's input may wait for the job to take it. */
const BG_WRITE_MS = 5000;
/** Text still waiting in a job's input past which no more is taken (Codex: a stalled reader must not grow memory). */
const BG_STDIN_PENDING_MAX = 1024 * 1024;
/** The last job number given in a list of jobs: an id is never given twice, so a stale one names nothing (Codex). */
const jobSeq = new WeakMap<Map<string, BgJob>, number>();

/** The output a job printed since the model last read it, with what was dropped said plainly. */
function jobNews(job: BgJob): string {
  const from = Math.max(job.read, job.base);
  const lost = from - job.read;
  const text = job.out.slice(from - job.base);
  job.read = job.base + job.out.length;
  const body = capped(text.trimEnd());
  return (lost ? `[${lost} characters it printed before this were dropped — the job keeps only its latest output]\n` : "") + body;
}

function jobState(job: BgJob): string {
  if (!job.exit) return `job ${job.id} is running (${Math.round((Date.now() - job.startedAt) / 1000)} s)`;
  return `job ${job.id} has ended — ${job.exit.code === 0 ? "exit code 0" : `exit code ${job.exit.code ?? `none, signal ${job.exit.signal}`}`}`;
}

/** Ends the job's whole group — also after its shell exited, for what the shell left running (Codex). The id
 *  is not given to a new group while any process of this one lives; once none does, the signal finds nothing —
 *  the same bound killGroups works within. */
function endJob(job: BgJob, ctx: ToolContext): void {
  const kill = (sig: NodeJS.Signals) => {
    try {
      if (job.pid) process.kill(-job.pid, sig);
    } catch {
      // already gone
    }
  };
  kill("SIGTERM");
  setTimeout(() => {
    kill("SIGKILL");
    if (job.pid) ctx.groups.delete(job.pid);
  }, KILL_GRACE_MS).unref();
}

/** Start `line` in the background: its own process group, stdin open for later writes, output kept in a tail. */
async function startJob(command: string, line: string, env: Record<string, string | undefined>, ctx: ToolContext): Promise<ToolOutcome> {
  const jobs = (ctx.jobs ??= new Map());
  // A finished job the model has read to the end makes room for a new one.
  for (const [id, j] of jobs) if (j.exit && j.read >= j.base + j.out.length && jobs.size >= BG_JOBS_MAX) jobs.delete(id);
  if (jobs.size >= BG_JOBS_MAX) return fail(`${BG_JOBS_MAX} background jobs are already kept in this step — stop one (Bash with job and stop: true) first`);
  if (ctx.signal.aborted) return fail("the step was stopped before the command ran");
  const n = (jobSeq.get(jobs) ?? 0) + 1;
  jobSeq.set(jobs, n);
  const id = `${ctx.jobPrefix ?? "b"}${n}`;
  const child = spawn(ctx.sandbox ? LAUNCHER : "bash", ["-c", line], { cwd: ctx.cwd, env: env as NodeJS.ProcessEnv, detached: true, stdio: ["pipe", "pipe", "pipe"] });
  if (child.pid) ctx.groups.add(child.pid);
  const job: BgJob = { id, command, pid: child.pid, out: "", base: 0, read: 0, exit: null, stdin: child.stdin, wake: new Set(), startedAt: Date.now() };
  const wake = () => {
    for (const w of [...job.wake]) w();
  };
  const take = (chunk: Buffer) => {
    job.out += chunk.toString("utf8");
    // A server that logs forever keeps only its latest output.
    if (job.out.length > RESULT_CAP * 4) {
      const cut = job.out.length - RESULT_CAP * 2;
      job.out = job.out.slice(cut);
      job.base += cut;
    }
    wake();
  };
  child.stdout!.on("data", take);
  child.stderr!.on("data", take);
  child.stdin!.on("error", () => {
    /* the job closed its input; a later write says so */
  });
  const started = await new Promise<string | null>((resolve) => {
    child.once("error", (err) => resolve(err.message));
    child.once("spawn", () => resolve(null));
  });
  if (started !== null) return fail(`the command could not start: ${started}`);
  child.on("exit", (code, signal) => {
    job.exit = { code, signal };
    job.stdin = null;
    wake();
  });
  jobs.set(id, job);
  // A moment for its first lines (a server's "listening on…"), or its end if it was quick.
  await waitJob(job, BG_FIRST_MS, ctx.signal);
  const news = jobNews(job);
  return {
    text: `${jobState(job)} — started in the background. Read its new output, write to its input, wait or stop it with Bash {job: "${id}", stdin?, wait?, stop?}; it ends with the step.${news ? `\n${news}` : ""}`,
    ...(job.exit && job.exit.code !== 0 ? { isError: true } : {}),
  };
}

/** Until the job prints, ends, `ms` pass or the step stops. */
function waitJob(job: BgJob, ms: number, signal: AbortSignal, untilExit = false): Promise<void> {
  return new Promise((resolve) => {
    if (job.exit || signal.aborted || ms <= 0) return resolve();
    let timer: NodeJS.Timeout;
    const done = () => {
      clearTimeout(timer);
      job.wake.delete(check);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const check = () => {
      if (job.exit || !untilExit) done();
    };
    timer = setTimeout(done, ms);
    job.wake.add(check);
    signal.addEventListener("abort", done, { once: true });
  });
}

/** A call naming a background job: write its input, wait, stop it, and give what it printed since the last read. */
async function onJob(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutcome> {
  const id = str(input, "job")!;
  const job = ctx.jobs?.get(id);
  if (!job) return fail(`no background job ${id} in this step${ctx.jobs?.size ? ` (there are: ${[...ctx.jobs.keys()].join(", ")})` : ""}`);
  if (input.command !== undefined) return fail("give either command (a new command) or job (one already running), not both");
  const stdin = typeof input.stdin === "string" ? input.stdin : null;
  if (input.stdin !== undefined && stdin === null) return fail("stdin is text to write to the job's input");
  if (stdin !== null) {
    if (!job.stdin || job.exit) return fail(`${jobState(job)} — its input is closed`);
    if (job.stdin.writableLength > BG_STDIN_PENDING_MAX) return fail(`${jobState(job)} — over 1 MB written to it is still unread; wait for it to read, or stop it`);
    // A job that never reads its input must not hold the call, or the step's stop (Codex).
    const took = await new Promise<"ok" | "error" | "slow">((resolve) => {
      const timer = setTimeout(() => finish("slow"), BG_WRITE_MS);
      const onAbort = () => finish("slow");
      function finish(r: "ok" | "error" | "slow") {
        clearTimeout(timer);
        ctx.signal.removeEventListener("abort", onAbort);
        resolve(r);
      }
      ctx.signal.addEventListener("abort", onAbort, { once: true });
      job.stdin!.write(stdin, (err) => finish(err ? "error" : "ok"));
    });
    if (took === "error") return fail(`${jobState(job)} — it did not take the input`);
    if (took === "slow") return fail(`${jobState(job)} — it has not read its input for ${BG_WRITE_MS / 1000} s (the text waits in its input until it does)`);
  }
  if (input.stop === true) {
    endJob(job, ctx);
    if (!job.exit) await waitJob(job, KILL_GRACE_MS + 500, ctx.signal, true);
    const news = jobNews(job);
    ctx.jobs!.delete(id);
    return { text: `${job.exit ? `${jobState(job)}; stopped` : `job ${id} was sent SIGTERM then SIGKILL`}${news ? `\n${news}` : ""}` };
  }
  const ms = input.wait === undefined ? 0 : Number.isInteger(input.wait) ? Math.max(0, Math.min(BASH_MAX_MS, input.wait as number)) : -1;
  if (ms < 0) return fail("wait is milliseconds, a whole number");
  // Waits for the end, not the next line: "wait 30 s for the tests" means until they finish or 30 s pass.
  if (ms) await waitJob(job, ms, ctx.signal, true);
  const news = jobNews(job);
  return { text: `${jobState(job)}${news ? `\n${news}` : "\n(no new output)"}`, ...(job.exit && job.exit.code !== 0 ? { isError: true } : {}) };
}

/** After the shell exits, how long its output may still arrive before the command counts as returned. */
const EXIT_GRACE_MS = 300;
/** …and the longest it may keep arriving: what is printed after that, by a job left in the background, is not waited for. */
const EXIT_DRAIN_MAX_MS = 2000;

const bash: EngineTool = {
  name: "Bash",
  description:
    "Run a shell command in the working directory and return its output (stdout and stderr together) and exit code. " +
    `Stops after timeout milliseconds (default ${BASH_DEFAULT_MS}, at most ${BASH_MAX_MS}). ` +
    "Each call is a new shell: a `cd` or a variable does not carry to the next. Use Read, Edit, Glob and Grep for files rather than cat, sed, find and grep. " +
    "For a server, a watcher or a long build, set run_in_background: it answers with a job id and its first output; then call Bash with that job alone to read what it printed since, write to its input (stdin), wait for it to finish (wait, ms) or stop it and everything it started (stop: true). Background jobs end with the step.",
  input_schema: {
    type: "object",
    properties: {
      command: { type: "string", description: "The command line" },
      timeout: { type: "integer", description: "Milliseconds before the command is stopped (not for a background job)" },
      description: { type: "string", description: "What the command does, in a few words" },
      run_in_background: { type: "boolean", description: "Start it and answer at once with a job id, leaving it running" },
      job: { type: "string", description: "A background job's id, instead of command: read its new output, and with stdin, wait or stop act on it" },
      stdin: { type: "string", description: "With job: text written to its input (add \\n for Enter)" },
      wait: { type: "integer", description: "With job: wait up to this many milliseconds for it to finish" },
      stop: { type: "boolean", description: "With job: stop it and everything it started" },
    },
  },
  readOnly: false,
  async run(input, ctx) {
    if (input.job !== undefined) {
      if (!str(input, "job")) return fail("job is a background job's id, like b1");
      return onJob(input, ctx);
    }
    for (const k of ["stdin", "wait", "stop"]) if (input[k] !== undefined) return fail(`${k} goes with job (a background job's id)`);
    const command = str(input, "command");
    if (!command) return fail("Bash needs command (or job, for one running in the background)");
    const ms = Math.max(1000, Math.min(BASH_MAX_MS, Number.isInteger(input.timeout) ? (input.timeout as number) : BASH_DEFAULT_MS));
    // Inside the walls on a person's machine: the line that runs is the
    // sandbox's wrapping of it. One that cannot be wrapped does not run.
    let line = command;
    let env: Record<string, string | undefined> = ctx.env;
    if (ctx.sandbox) {
      try {
        // The launcher starts with the walls' own few variables; the
        // command's environment is set again inside.
        ({ line, env } = await ctx.sandbox.launch(command, ctx.env));
      } catch (err) {
        return fail(`the command was not run: the sandbox could not wrap it (${err instanceof Error ? err.message : String(err)})`);
      }
    }
    if (input.run_in_background === true) return startJob(command, line, env, ctx);
    return new Promise<ToolOutcome>((resolve) => {
      if (ctx.signal.aborted) return resolve(fail("the step was stopped before the command ran"));
      // Its own process group, so a stop or a timeout ends what it started
      // too — a test runner's children, a server it left in the background.
      // Inside the walls the walls are put up by a fixed program, from an
      // environment no command could have shaped.
      const child = spawn(ctx.sandbox ? LAUNCHER : "bash", ["-c", line], {
        cwd: ctx.cwd,
        env: env as NodeJS.ProcessEnv,
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
      // The shell has ended, but something it started in the background
      // (`server &`) still holds its output open: "close" would wait for
      // that, up to the timeout (FOL-273). Once the output has been quiet
      // for a moment after the exit, the command has returned. The pipes
      // stay open and are read to the end, unshown — closing them would kill
      // the job on its next write (Codex) — and the job ends with the step
      // (killGroups).
      let left = false;
      let exited: { code: number | null; signal: NodeJS.Signals | null } | null = null;
      let quiet: NodeJS.Timeout | null = null;
      let exitedAt = 0;
      const settle = () => {
        if (quiet) clearTimeout(quiet);
        quiet = setTimeout(() => {
          if (!finish || !exited) return;
          left = true;
          const f = finish;
          f(exited.code, exited.signal);
          child.stdout!.off("data", take);
          child.stderr!.off("data", take);
          child.stdout!.resume();
          child.stderr!.resume();
        // A job that prints without pause cannot hold the call past a bound either.
        }, Math.max(0, Math.min(EXIT_GRACE_MS, exitedAt + EXIT_DRAIN_MAX_MS - Date.now())));
        quiet.unref();
      };
      const after = () => {
        if (exited) settle();
      };
      child.stdout!.on("data", after);
      child.stderr!.on("data", after);
      child.on("exit", (code, signal) => {
        exited = { code, signal };
        exitedAt = Date.now();
        // The shell succeeded or failed on its own: a job it left cannot turn that into a timeout (Codex).
        clearTimeout(timer);
        settle();
      });
      let finish: ((code: number | null, signal: NodeJS.Signals | null) => void) | null = (code, signal) => {
        finish = null;
        if (quiet) clearTimeout(quiet);
        const body = capped(out.trimEnd()) + (dropped ? `\n[${dropped} characters of output dropped while it ran]` : "") + (left ? "\n[it left something running in the background, which goes on until the turn ends; its output after this is not shown]" : "");
        if (why === "timeout") return done(`${body}\n[stopped after ${ms} ms — the command did not finish]`.trim(), true);
        if (why === "stopped") return done(`${body}\n[stopped with the step]`.trim(), true);
        if (code === 0) return done(body || "(no output)", false);
        done(`${body}\n[exit code ${code ?? `none, signal ${signal}`}]`.trim(), true);
      };
      child.on("close", (code, signal) => finish?.(code, signal));
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
