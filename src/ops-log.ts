// What the platform says about itself, in a shape that cannot carry an
// account's content (FOL-121).
//
// A hosted pod's stdout and stderr leave the cluster: they are our
// operations log (Grafana Cloud, through Alloy), read by us, not by the
// account whose run it was. An account's prompts, replies, files, tool
// arguments and the words of its errors belong in that account's own run
// trace — never here.
//
// FOL-107 is why. An eval judge's model process died, and modelProcessError
// did the right thing for the person (one short line in the eval result) and
// the wrong thing for the log: "the details are in the server log" meant
// 2 KB of the CLI's stderr, prompt text included, shipped out with every
// other platform line. Nothing about a string says whether it is content,
// so the rule here is structural, in three parts:
//
//   1. One writer. `opsLog(level, event, fields)` and `opsError(event, err,
//      fields)` build a line from a CLOSED set of field names, each with a
//      shape (FIELDS below): numbers, short lowercase words, ids with no
//      whitespace, quotes, `/`, `:` or `@` — so no sentence, URL, path or
//      email address fits. A value that does not fit is dropped, never
//      truncated (a truncated prompt is still a prompt), and an unknown field
//      name is counted, not echoed. An error is its class, its name, its
//      code, its status and where in OUR code it was thrown — never its
//      message, which is whatever the thrower put there.
//   2. One boundary. `installOpsBoundary()`, the first import of every
//      hosted entry point (worker, egress, assistant, the web's
//      instrumentation), replaces console.* and process.stdout/stderr.write.
//      A raw console call becomes {"event":"console","at":"queue.ts:1511"}
//      plus the class of an Error it was handed; a raw stream write becomes
//      {"event":"stream.raw","bytes":n}. Its arguments are never formatted.
//      Only the writer above reaches the real streams.
//   3. A guard on the source: `scripts/log-guard.mjs` refuses a new raw
//      console call in server code that prints anything but a literal, and
//      an opsLog/opsError whose event is not a literal.
//
// Outside a hosted process — the CLI on a laptop, `next dev`, the tests —
// no boundary is installed and the writer prints a readable line with the
// error's message: there the reader is the person whose content it is.
// FOLDRUN_LOG_MODE=raw keeps a process out of the boundary on purpose;
// infra's tests refuse it in any manifest.

import fs from "node:fs";
import os from "node:os";

/** Why something failed, in one word an operator can count. Small on
 *  purpose: a class is a bucket on a dashboard, not a diagnosis. */
export const ERROR_CLASSES = [
  "policy_denied", //   a rule said no: network, limits, a hook, a scope
  "timeout", //         ran out of time
  "oom", //             out of memory (OOMKilled, heap)
  "disk_full", //       ENOSPC, EDQUOT
  "model_error", //     the model or its process failed
  "network_error", //   a peer could not be reached (DNS, refused, reset)
  "user_code_error", // the account's own code failed: a script, a tool, a hook
  "not_found", //       the thing named is not there
  "cancelled", //       stopped on purpose (a person, a shutdown, an abort)
  "platform_error", //  ours: everything else
] as const;
export type ErrorClass = (typeof ERROR_CLASSES)[number];

export function isErrorClass(v: unknown): v is ErrorClass {
  return typeof v === "string" && (ERROR_CLASSES as readonly string[]).includes(v);
}

/** The platform-wide failure causes an issue is grouped by (issues.ts
 *  PLATFORM_CAUSES keys), as a log field. */
export const CAUSES = ["sandbox", "model-auth", "model-cap", "model-busy", "worker"] as const;

/** A short lowercase word: an outcome, a role, a reason code. */
const WORD = /^[a-z][a-z0-9_-]{0,31}$/;
/** An id or a name: no whitespace, quotes, `/`, `:` or `@` — nothing a
 *  sentence, a URL, a path or an email address fits in. */
const ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
/** A code, as the field holds it: errno, SQLSTATE, an undici or Node code. */
const CODE = /^[A-Z0-9_]{2,40}$/;
/** A code an error may hand over. Not any upper-case word — an error's
 *  `code` is whatever its thrower set — but the system's errno names, a
 *  SQLSTATE (five characters, a digit first, or XX000), and Node's and
 *  undici's own `ERR_…` codes. */
const ERRNO = new Set(Object.keys(os.constants.errno));
function knownCode(code: string): boolean {
  return ERRNO.has(code) || /^[0-9][0-9A-Z]{4}$/.test(code) || /^XX00[0-2]$/.test(code) || /^(UND_)?ERR_[A-Z0-9_]{2,36}$/.test(code);
}
/** An Error subclass's name, as the field holds it. */
const ERROR_NAME = /^[A-Z][A-Za-z0-9]{0,40}$/;
/** Names an error's `name` may give as they are; any other comes from its
 *  class (`constructor.name`) — our code's, since an account's code does
 *  not run in a platform process — because `name` is a settable string. */
const BUILTIN_NAMES = new Set(["Error", "TypeError", "RangeError", "SyntaxError", "ReferenceError", "EvalError", "URIError", "AggregateError", "AbortError", "TimeoutError", "SystemError"]);
/** Where in our code: a source file's base name and a line. */
const FRAME = /^[A-Za-z0-9_.-]{1,60}\.(ts|tsx|mts|js|mjs|cjs):\d{1,6}$/;
const EVENT = /^[a-z][a-z0-9_]*(\.[a-z0-9_]+){0,3}$/;

type Kind = "id" | "num" | "word" | "code" | "class" | "cause" | "errorName" | "frame" | "frames" | "bool";

/** Every field a platform log line may carry, and its shape. Adding one is
 *  a decision that its values can never be an account's content. */
export const FIELDS: Record<string, Kind> = {
  // Who and what: ids, and the names an account gave its workspaces, flows,
  // agents and evals (identifiers, by policy — never their contents).
  tenant: "id", workspace: "id", flow: "id", agent: "id", eval: "id", tool: "id",
  runId: "id", jobId: "id", taskId: "id", proposal: "id", lease: "id", pod: "id",
  worker: "id", provider: "id", plan: "id", fingerprint: "id", invoice: "id", order: "id",
  stripeEvent: "id", subscription: "id", migration: "id", housekeeping: "id",
  // How many, how long, how much.
  count: "num", ms: "num", secs: "num", bytes: "num", usd: "num", attempt: "num",
  step: "num", port: "num", status: "num", exitCode: "num", percent: "num", tries: "num",
  // What kind.
  op: "word", role: "word", outcome: "word", reason: "word", stream: "word", kind: "word",
  verdict: "word", phase: "word", signal: "code", where: "word",
  // A failure.
  errorClass: "class", errorName: "errorName", code: "code", syscall: "word", cause: "cause",
  at: "frame", frames: "frames", retrying: "bool", ok: "bool",
};

export type OpsValue = string | number | boolean | null | undefined | readonly string[];
export type OpsFields = Record<string, OpsValue>;
export type OpsLevel = "info" | "warn" | "error";

/** Is this value one this kind of field may carry? */
function fits(kind: Kind, v: unknown): boolean {
  switch (kind) {
    case "num": return typeof v === "number" && Number.isFinite(v);
    case "bool": return typeof v === "boolean";
    case "id": return typeof v === "string" && ID.test(v);
    case "word": return typeof v === "string" && WORD.test(v);
    case "code": return typeof v === "string" && CODE.test(v);
    case "class": return isErrorClass(v);
    case "cause": return typeof v === "string" && (CAUSES as readonly string[]).includes(v);
    case "errorName": return typeof v === "string" && ERROR_NAME.test(v);
    case "frame": return typeof v === "string" && FRAME.test(v);
    case "frames": return Array.isArray(v) && v.length <= 5 && v.every((f) => typeof f === "string" && FRAME.test(f));
  }
}

/**
 * The line as an object: the event, the fields that fit, and how many did
 * not (by count — a refused field's name could itself be the content).
 */
export function opsLine(level: OpsLevel, event: string, fields: OpsFields = {}): Record<string, unknown> {
  const line: Record<string, unknown> = { ops: 1, level, event: typeof event === "string" && event.length <= 64 && EVENT.test(event) ? event : "invalid_event" };
  let dropped = 0;
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined || v === null) continue;
    const kind = Object.prototype.hasOwnProperty.call(FIELDS, k) ? FIELDS[k] : undefined;
    if (!kind || !fits(kind, v)) {
      dropped += 1;
      continue;
    }
    line[k] = v;
  }
  if (dropped) line.dropped = dropped;
  return line;
}

// ------------------------------------------------------------------ writing

type Write = (text: string) => void;
/** The real streams, once the boundary holds them; null outside it. */
let real: { out: Write; err: Write } | null = null;

/** Is this process inside the boundary — a hosted pod? */
export function opsBoundaryInstalled(): boolean {
  return real !== null;
}

function readable(level: OpsLevel, line: Record<string, unknown>, detail?: string): string {
  const parts = Object.entries(line)
    .filter(([k]) => k !== "ops" && k !== "level" && k !== "event")
    .map(([k, v]) => `${k}=${Array.isArray(v) ? v.join(",") : String(v)}`);
  return `[ops] ${line.event}${parts.length ? ` ${parts.join(" ")}` : ""}${detail ? ` — ${detail}` : ""}`;
}

function emit(level: OpsLevel, line: Record<string, unknown>, detail?: string): void {
  if (real) {
    (level === "info" ? real.out : real.err)(JSON.stringify(line) + "\n");
    return;
  }
  // No boundary: a laptop, a test, `next dev` — the reader is the person
  // whose content it is, so the error's own words come along.
  const text = readable(level, line, detail);
  if (level === "info") console.log(text);
  else if (level === "warn") console.warn(text);
  else console.error(text);
}

/** Say something about the platform: an event and its fields. */
export function opsLog(level: OpsLevel, event: string, fields: OpsFields = {}): void {
  emit(level, opsLine(level, event, fields));
}

// ------------------------------------------------------------------- errors

/** Which class an error belongs to — from its code, its name and its status;
 *  a few fixed markers our own code and the cluster write are matched in its
 *  message, which never leaves this function. */
export function errorClass(err: unknown): ErrorClass {
  try {
    if (!err || typeof err !== "object") return "platform_error";
    const e = err as { name?: unknown; code?: unknown; status?: unknown; statusCode?: unknown; errorClass?: unknown; message?: unknown };
    if (isErrorClass(e.errorClass)) return e.errorClass;
    const code = typeof e.code === "string" ? e.code : typeof e.code === "number" ? String(e.code) : "";
    const name = typeof e.name === "string" ? e.name : "";
    const status = typeof e.status === "number" ? e.status : typeof e.statusCode === "number" ? e.statusCode : 0;
    if (name === "TimeoutError" || ["ETIMEDOUT", "ESOCKETTIMEDOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT", "UND_ERR_CONNECT_TIMEOUT", "57014"].includes(code)) return "timeout";
    if (name === "AbortError" || code === "ABORT_ERR") return "cancelled";
    if (code === "ENOSPC" || code === "EDQUOT" || code === "53100") return "disk_full";
    if (code === "ENOMEM" || code === "ERR_WORKER_OUT_OF_MEMORY" || code === "53200") return "oom";
    if (["ECONNREFUSED", "ECONNRESET", "ENOTFOUND", "EAI_AGAIN", "EHOSTUNREACH", "ENETUNREACH", "EPIPE", "UND_ERR_SOCKET", "UND_ERR_CONNECT", "08000", "08001", "08003", "08006"].includes(code)) return "network_error";
    if (code === "ENOENT" || code === "ENOTDIR" || status === 404) return "not_found";
    if (code === "EACCES" || code === "EPERM" || status === 401 || status === 403 || status === 423) return "policy_denied";
    if (status === 408 || status === 504) return "timeout";
    const message = typeof e.message === "string" ? e.message.slice(0, 4000) : "";
    if (/\bOOMKilled\b|JavaScript heap out of memory/.test(message)) return "oom";
    if (/no space left on device/i.test(message)) return "disk_full";
    if (/\b(Claude Code process|model process|api\.anthropic\.com)\b/.test(message)) return "model_error";
    return "platform_error";
  } catch {
    return "platform_error";
  }
}

/** Is this source path the platform's own code (core, platform, web, their
 *  dependencies), not something an account brought — and a file that is
 *  really there? A stack is a settable string; a frame naming a file that
 *  does not exist was written by someone, not by V8. */
const seenPaths = new Map<string, boolean>();
function ourPath(p: string): boolean {
  if (/^node:[a-z_/]+$/.test(p)) return true;
  // A checkout (the image runs core and platform from source), the web's
  // build, or the published package (`node_modules/@foldrun/core/dist`).
  if (!/\/foldrun-(core|platform|web)\/(src|server|app|lib|dist|\.next|node_modules|tests|scripts|instrumentation)|\/node_modules\/@foldrun\//.test(p)) return false;
  let known = seenPaths.get(p);
  if (known === undefined) {
    try {
      known = fs.statSync(p).isFile();
    } catch {
      known = false;
    }
    if (seenPaths.size > 2000) seenPaths.clear();
    seenPaths.set(p, known);
  }
  return known;
}

/** `file.ts:12` frames of our code from a stack, first `max` of them. The
 *  first line (the message) is never read, and function names are left
 *  out: only a base name and a line, which a sentence cannot be. */
export function stackFrames(stack: unknown, max = 5, skip = 0): string[] {
  if (typeof stack !== "string") return [];
  const out: string[] = [];
  let seen = 0;
  for (const raw of stack.slice(0, 20_000).split("\n")) {
    const m = /^\s+at (?:.*? \()?(.+?):(\d+):\d+\)?$/.exec(raw);
    if (!m) continue;
    const where = m[1].replace(/^file:\/\//, "");
    if (!ourPath(where)) continue;
    if (seen++ < skip) continue;
    const frame = `${where.split("/").pop()}:${m[2]}`;
    if (FRAME.test(frame)) out.push(frame);
    if (out.length >= max) break;
  }
  return out;
}

/** The fields of an error a log line may carry. Never throws: a getter on a
 *  strange object is not allowed to take the log down with it. */
export function errorFields(err: unknown): OpsFields {
  try {
    const e = (err && typeof err === "object" ? err : {}) as { name?: unknown; code?: unknown; syscall?: unknown; status?: unknown; statusCode?: unknown; stack?: unknown; opsReason?: unknown };
    const code = typeof e.code === "string" ? e.code : typeof e.code === "number" ? String(e.code) : undefined;
    const status = typeof e.status === "number" ? e.status : typeof e.statusCode === "number" ? e.statusCode : undefined;
    let errorName = "NotAnError";
    if (err instanceof Error) {
      const cls = (err as { constructor?: { name?: unknown } }).constructor?.name;
      errorName = BUILTIN_NAMES.has(err.name) ? err.name : typeof cls === "string" && ERROR_NAME.test(cls) ? cls : "Error";
    }
    return {
      errorClass: errorClass(err),
      errorName,
      code: code && CODE.test(code) && knownCode(code) ? code : undefined,
      syscall: typeof e.syscall === "string" && WORD.test(e.syscall) ? e.syscall : undefined,
      status,
      // A reason our own code attached (`opsReason`: a word, by FIELDS).
      reason: typeof e.opsReason === "string" && WORD.test(e.opsReason) ? e.opsReason : undefined,
      frames: err instanceof Error ? stackFrames(e.stack) : [],
    };
  } catch {
    return { errorClass: "platform_error", errorName: "Error" };
  }
}

/** An Error whose message is for a person and whose `reason` — a word —
 *  is what a hosted log says instead: `throw withOpsReason(new Error("egress.ts
 *  needs FOLDRUN_EGRESS_URL…"), "no_egress_url")`. */
export function withOpsReason<E extends Error>(err: E, reason: string): E {
  return Object.assign(err, { opsReason: reason });
}

/** The message an error would show, for the readable line outside the
 *  boundary only. */
function messageOf(err: unknown): string {
  try {
    return err instanceof Error ? err.message : String(err);
  } catch {
    return "";
  }
}

/** A failure: its class and where it happened — never its words inside the
 *  boundary. A field the caller names (an `errorClass` it knows) wins. */
export function opsError(event: string, err: unknown, fields: OpsFields = {}, level: OpsLevel = "error"): void {
  emit(level, opsLine(level, event, { ...errorFields(err), ...fields }), real ? undefined : messageOf(err));
}

// ----------------------------------------------------------------- boundary

/** Where in our code a raw console call was made: the first frame outside
 *  this file. From a stack we made, so it is a real code location. */
function callsite(): string | undefined {
  const stack = new Error().stack ?? "";
  for (const raw of stack.split("\n").slice(1)) {
    const m = /^\s+at (?:.*? \()?(.+?):(\d+):\d+\)?$/.exec(raw);
    if (!m || /\/ops-log\.(ts|js)$/.test(m[1])) continue;
    const where = m[1].replace(/^file:\/\//, "");
    if (!ourPath(where)) return undefined;
    const frame = `${where.split("/").pop()}:${m[2]}`;
    return FRAME.test(frame) ? frame : undefined;
  }
  return undefined;
}

export interface BoundaryOptions {
  /** On an uncaught exception or unhandled rejection: log its class and
   *  exit 1, as Node would — for processes with no handler of their own
   *  (the worker, egress, the assistant; Next.js has its own). */
  exitOnUncaught?: boolean;
  env?: NodeJS.ProcessEnv;
}

/**
 * Put this process inside the boundary. Idempotent. Off only where
 * FOLDRUN_LOG_MODE=raw or NODE_ENV=development (`next dev`).
 */
export function installOpsBoundary(opts: BoundaryOptions = {}): boolean {
  const env = opts.env ?? process.env;
  if (real) return true;
  if (env.FOLDRUN_LOG_MODE === "raw" || (env.FOLDRUN_LOG_MODE !== "ops" && env.NODE_ENV === "development")) return false;
  const outWrite = process.stdout.write.bind(process.stdout) as (s: string) => boolean;
  const errWrite = process.stderr.write.bind(process.stderr) as (s: string) => boolean;
  real = { out: (s) => void outWrite(s), err: (s) => void errWrite(s) };

  const fromConsole = (level: OpsLevel) => (...args: unknown[]) => {
    // Never formatted: an argument's text, its inspect() and its toJSON()
    // are not read. An Error handed over gives its class, name and code.
    let firstError: unknown;
    for (const a of args) {
      if (a instanceof Error) {
        firstError = a;
        break;
      }
    }
    const fields: OpsFields = { at: callsite(), ...(firstError ? errorFields(firstError) : {}) };
    emit(level, opsLine(level, "console", fields));
  };
  console.log = fromConsole("info");
  console.info = fromConsole("info");
  console.debug = fromConsole("info");
  console.trace = fromConsole("info");
  console.warn = fromConsole("warn");
  console.error = fromConsole("error");

  // Anything else that writes to the streams — a dependency, Next.js, a
  // warning — is counted, not passed on. The write contract is kept: the
  // callback runs, and the answer is "keep writing".
  const fromStream = (stream: "stdout" | "stderr") =>
    function write(chunk: unknown, encoding?: unknown, cb?: unknown): boolean {
      const done = typeof encoding === "function" ? encoding : cb;
      const bytes = typeof chunk === "string" ? Buffer.byteLength(chunk) : chunk instanceof Uint8Array ? chunk.byteLength : 0;
      emit(stream === "stdout" ? "info" : "error", opsLine(stream === "stdout" ? "info" : "error", "stream.raw", { stream, bytes, at: callsite() }));
      if (typeof done === "function") queueMicrotask(() => (done as (e?: Error | null) => void)(null));
      return true;
    };
  process.stdout.write = fromStream("stdout") as typeof process.stdout.write;
  process.stderr.write = fromStream("stderr") as typeof process.stderr.write;

  if (opts.exitOnUncaught) {
    process.on("uncaughtException", (err) => {
      opsError("process.uncaught_exception", err);
      process.exit(1);
    });
    process.on("unhandledRejection", (err) => {
      opsError("process.unhandled_rejection", err);
      process.exit(1);
    });
  }
  return true;
}
