// Script runtimes and their dependencies.
//
// An agent (or its workspace) declares what its scripts need:
//
//   runtime:
//     python: "3.12"           # optional pin; uv fetches it when the image lacks it
//     packages: [pandas, requests]
//     node: true
//     npm: [lodash]
//
// The platform builds that environment once, keyed by a fingerprint of the
// declaration, and reuses it for every later run — after checking it still
// holds what it promises. Python gets a venv (built with uv when the image has
// it, pip otherwise); Node gets an npm prefix exposed through NODE_PATH, and
// both put their bin directory first on PATH so a shebang or a bare `python3`
// finds them too. Entries nobody has used for 30 days are pruned. Nothing is installed into
// the host's global site-packages, so two agents can want different versions
// of the same library without colliding.
//
// This is dependency *isolation*, not security isolation — scripts still run
// as the server user. Real isolation needs a container per run; see
// SPEC.md → Execution environments.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { dataRoot } from "./paths.ts";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";

export interface RuntimeSpec {
  python?: string | boolean;
  packages: string[]; // pip
  node?: string | boolean;
  npm: string[];
  /** Debian packages the step needs from the operating system — a library's
   *  headers for a pip package that compiles (`libcairo2-dev`), a C compiler
   *  (`build-essential`), a program (`ffmpeg`). Installed with apt by the run
   *  pod's root start-up, before anything model-directed runs, from a .deb
   *  cache on the runtime volume (SYSTEM_INSTALL_SH); verified here. */
  system?: string[];
  /** Declared entries that are not valid requirements. Kept so the run can
   *  SAY they were dropped: silently discarding `pandas>=2` and then failing
   *  the script with "no module named pandas" is the least debuggable outcome
   *  available. Never part of the fingerprint — it names nothing installed. */
  rejected?: string[];
  /** Installer options a requirements.txt carried (`--hash`, `-r`,
   *  `--index-url`), by name only. Not applied — the installer takes options
   *  from the same argv as its packages — and said so in the build log. */
  ignored?: string[];
}

/**
 * What may be handed to `pip install`, and what may be handed to `npm install`.
 *
 * These are argument-injection guards before they are validators. Both
 * installers take options in the same argv as their operands, and the previous
 * pattern (`[\w.@/-]+`) admitted a leading dash — so `packages: ["--index-url",
 * "http://elsewhere/simple", "pandas"]` in an agent's frontmatter was a valid
 * declaration that quietly moved the whole install to another index. Anchored,
 * and a requirement must begin with a letter or a digit.
 *
 * The version half is PEP 440 shaped: a comparator and a version, optionally
 * several comma-separated. The old pattern allowed one comparator CHARACTER,
 * which meant `pandas>2` passed while `pandas>=2` and `pandas==2.1.4` — the
 * two forms anyone actually writes — were dropped without a word.
 */
const PIP_NAME = String.raw`[A-Za-z0-9][A-Za-z0-9._-]*(\[[A-Za-z0-9._,-]+\])?`;
const PIP_SPECIFIER = String.raw`(==|!=|<=|>=|~=|<|>)[A-Za-z0-9._*+!-]+`;
export const PIP_REQUIREMENT = new RegExp(`^${PIP_NAME}(${PIP_SPECIFIER}(,${PIP_SPECIFIER})*)?$`);
/** npm's own shape: an optional @scope, then a name, then an optional @range. */
export const NPM_REQUIREMENT =
  /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*(@[A-Za-z0-9._^~*>=< |-]+)?$/;

/** A Debian package name as policy defines it: lowercase letters, digits,
 *  `+`, `-` and `.`, starting with a letter or digit, two or more characters.
 *  Like the two above, a guard first: it can never begin with a dash, so it
 *  can never become an apt option, and it holds no shell characters. */
export const DEB_PACKAGE = /^[a-z0-9][a-z0-9+.-]{1,62}$/;

export function parseRuntime(raw: unknown): RuntimeSpec | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const e = raw as Record<string, unknown>;
  const rejected: string[] = [];
  const list = (v: unknown, ok: RegExp) =>
    Array.isArray(v)
      ? v.map(String).filter((entry) => {
          const s = entry.trim();
          if (ok.test(s)) return true;
          if (s) rejected.push(s);
          return false;
        })
      : [];
  const spec: RuntimeSpec = {
    python: typeof e.python === "string" || typeof e.python === "boolean" ? e.python : undefined,
    packages: list(e.packages ?? e.pip, PIP_REQUIREMENT),
    node: typeof e.node === "string" || typeof e.node === "boolean" ? e.node : undefined,
    npm: list(e.npm, NPM_REQUIREMENT),
  };
  const system = list(e.system ?? e.apt, DEB_PACKAGE);
  if (system.length) spec.system = system;
  if (rejected.length) spec.rejected = rejected;
  if (Array.isArray(e.ignored) && e.ignored.length) spec.ignored = e.ignored.map(String);
  return wantsPython(spec) || wantsNode(spec) || wantsSystem(spec) ? spec : null;
}

/**
 * Several declarations, one environment.
 *
 * A tool declares what ITS program needs — `runtime: { packages: [requests] }`
 * in tool.md — because the tool is the unit of code and its dependencies
 * belong beside it, not in every agent that grants it. An agent that grants
 * three Python tools gets one venv holding the union. Version pins are kept
 * verbatim; if two tools pin the same package differently, pip is the one to
 * say so, loudly, at build time — better than one of them silently winning.
 */
export function mergeRuntimes(...specs: (RuntimeSpec | null | undefined)[]): RuntimeSpec | null {
  const present = specs.filter((s): s is RuntimeSpec => Boolean(s));
  if (present.length === 0) return null;
  if (present.length === 1) return present[0];
  const pick = (key: "python" | "node") => {
    // A version pin beats a bare `true`; the first pin wins.
    const pinned = present.map((s) => s[key]).find((v) => typeof v === "string");
    if (pinned !== undefined) return pinned;
    return present.some((s) => s[key] === true) ? true : undefined;
  };
  const uniq = (xs: string[]) => [...new Set(xs)];
  const merged: RuntimeSpec = {
    python: pick("python"),
    packages: uniq(present.flatMap((s) => s.packages)),
    node: pick("node"),
    npm: uniq(present.flatMap((s) => s.npm)),
  };
  const system = uniq(present.flatMap((s) => s.system ?? []));
  if (system.length) merged.system = system;
  const rejected = uniq(present.flatMap((s) => s.rejected ?? []));
  if (rejected.length) merged.rejected = rejected;
  const ignored = uniq(present.flatMap((s) => s.ignored ?? []));
  if (ignored.length) merged.ignored = ignored;
  return merged;
}

export function fingerprint(spec: RuntimeSpec): string {
  const canonical = JSON.stringify({
    python: spec.python ?? null,
    packages: [...spec.packages].sort(),
    node: spec.node ?? null,
    npm: [...spec.npm].sort(),
    // Only when declared: adding the key unconditionally would give every
    // environment already cached a new fingerprint and rebuild them all.
    // Part of it when declared, because a venv whose packages compiled
    // against these libraries is not the venv built without them.
    ...(spec.system?.length ? { system: [...spec.system].sort() } : {}),
  });
  return crypto.createHash("sha256").update(canonical).digest("hex").slice(0, 16);
}

/**
 * A tenant name that is safe as one path segment. Tenants come from account
 * ids rather than user input, but this directory is also handed to `docker -v`
 * and to a k8s `subPath`, where a `..` would escape into another tenant's
 * cache — so it is checked at the boundary rather than assumed upstream.
 */
export function safeTenantSegment(tenant: string): string | null {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(tenant) && tenant !== "." && tenant !== ".."
    ? tenant
    : null;
}

export interface PreparedRuntime {
  /** Interpreter overrides by file extension, e.g. { ".py": "/…/venv/bin/python" }. */
  interpreters: Record<string, string>;
  /** Extra environment for spawned scripts (NODE_PATH, VIRTUAL_ENV, PATH). */
  env: Record<string, string>;
  /** Human-readable lines describing what was built, for the run log. */
  log: string[];
  error: string | null;
  /** Removes what only this step may use — the private build a wedged or
   *  failed shared build left it with. Absent when there is nothing to
   *  remove; call it when the step is done with the environment. */
  dispose?: () => void;
}

const EMPTY: PreparedRuntime = { interpreters: {}, env: {}, log: [], error: null };

/**
 * Run an installer and always be able to say why it failed.
 *
 * `spawnSync` reports three different failures and only one of them writes to
 * stdout or stderr. A command that cannot be spawned at all — not installed,
 * not on PATH — sets `error` and leaves both streams null; one killed by the
 * timeout sets `signal`; only a command that ran and exited non-zero has
 * output to quote. Reporting the streams alone produced the least useful
 * message a build can give: "npm install failed: " with nothing after it.
 */
function run(
  cmd: string,
  args: string[],
  cwd: string,
  timeoutMs = 300_000,
  extraEnv: Record<string, string> = {},
) {
  const res = spawnSync(cmd, args, {
    cwd,
    timeout: timeoutMs,
    encoding: "utf8",
    env: { ...process.env, ...extraEnv },
  });
  const out = `${res.stdout ?? ""}${res.stderr ?? ""}`.trim();
  if (res.status === 0) return { ok: true, out };
  const why = res.error
    ? `could not run \`${cmd}\` — ${res.error.message}`
    : res.signal
      ? `\`${cmd}\` was killed by ${res.signal}${res.signal === "SIGTERM" ? ` (the ${Math.round(timeoutMs / 1000)}s limit)` : ""}`
      : `\`${cmd}\` exited ${res.status}`;
  // The reason first, then whatever it managed to say. Never just the output,
  // because the output is empty in exactly the cases that are hardest to
  // diagnose from a distance.
  return { ok: false, out: out ? `${why}\n${out}` : why };
}

/** Wire an already-built root up, without installing anything. */
function wire(root: string, spec: RuntimeSpec, note: string): PreparedRuntime {
  const interpreters: Record<string, string> = {};
  const env: Record<string, string> = {};
  const venvPython = path.join(root, "venv", "bin", "python");
  const nodeModules = path.join(root, "node_modules");
  const bins: string[] = [];
  if (wantsPython(spec) && fs.existsSync(venvPython)) {
    interpreters[".py"] = venvPython;
    env.VIRTUAL_ENV = path.join(root, "venv");
    bins.push(path.join(root, "venv", "bin"));
  }
  if (wantsNode(spec) && fs.existsSync(nodeModules)) {
    env.NODE_PATH = nodeModules;
    if (fs.existsSync(path.join(nodeModules, ".bin"))) bins.push(path.join(nodeModules, ".bin"));
  }
  // First on PATH, so the environment is the one that answers however a
  // script is started: `interpreter: python3` in a tool file, a
  // `#!/usr/bin/env python3` shebang, or the agent typing `python3` in Bash.
  // Before this only a .py file with no declared interpreter got the venv,
  // and a tool that said `interpreter: python3` — the usual way to write one —
  // ran on the bare system python and died on its first import.
  if (bins.length) env.PATH = [...bins, process.env.PATH ?? ""].filter(Boolean).join(path.delimiter);

  // A `.ready` root that cannot actually satisfy the declaration is worse than
  // no cache: it reports "cached", wires nothing, and the failure surfaces
  // much later as "Cannot find package 'x'" inside someone's script — which
  // reads as a broken tool, not a broken runtime. Only packages that were
  // asked for by name are checked: `node: true` with no npm list installs
  // nothing and legitimately has no node_modules.
  const missing: string[] = [];
  if (spec.packages.length > 0 && !fs.existsSync(venvPython)) missing.push("the python venv");
  if (spec.npm.length > 0 && !fs.existsSync(nodeModules)) missing.push("node_modules");
  if (missing.length > 0) {
    return {
      interpreters,
      env,
      log: [note],
      error: `${note.replace(/: .*$/, "")}: marked ready but ${missing.join(" and ")} ${missing.length > 1 ? "are" : "is"} missing — the cache entry is incomplete. Delete ${root} to rebuild it.`,
    };
  }
  return { interpreters, env, log: [note], error: null };
}

// `python: false` says "not this one" — it used to read as a declaration
// because it was not undefined, and built a venv nobody asked for.
const wantsSystem = (s: RuntimeSpec) => (s.system?.length ?? 0) > 0;
const wantsPython = (s: RuntimeSpec) => (s.python !== undefined && s.python !== false) || s.packages.length > 0;
const wantsNode = (s: RuntimeSpec) => (s.node !== undefined && s.node !== false) || s.npm.length > 0;

/** How long a build may hold the claim, and therefore how long another step
 *  will wait on it, before it is treated as abandoned. Longer than the 300s
 *  install timeout, so a slow-but-live build is never stolen. Env-overridable
 *  because an operator who has seen numpy compile knows better than this
 *  default does — and because tests cannot spend six minutes proving it. */
function buildTimeoutMs(): number {
  const raw = Number(process.env.FOLDRUN_RUNTIME_BUILD_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 6 * 60_000;
}

/** Block without spinning. prepareRuntime is synchronous by contract — every
 *  caller is mid-spawn — so waiting cannot be done with a promise. */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Claim the right to build `root`, or discover someone else holds it.
 *
 * The cache became shared the moment it started surviving the container, and
 * two steps of the same account with the same dependencies now start at the
 * same instant routinely — the platform runs four at a time. Both would run
 * `python -m venv` into one directory and pip into it concurrently, and the
 * loser's half-written venv is not a slow run, it is a corrupt cache that
 * every later step inherits. `mkdir` is the lock because it is atomic on
 * every filesystem this runs on; O_EXCL on a file would do as well.
 */
// The claim carries a token naming its holder, so a build releases only a
// claim that is still its own: one whose claim was taken over as abandoned
// used to remove the new holder's lock on its way out, and a third step then
// built into the same directory beside the second.
export function claimBuild(
  root: string,
  /** Test seam: runs once the claim is judged abandoned, before the
   *  takeover — where a second claimer used to slip in. */
  seam?: { beforeTakeover?: () => void },
): string | null {
  const lock = path.join(root, ".building");
  const token = crypto.randomUUID();
  const take = () => {
    fs.mkdirSync(lock);
    fs.writeFileSync(path.join(lock, "owner"), token);
    return token;
  };
  try {
    return take();
  } catch {
    // Held — unless whoever held it died. A crashed build leaves the marker
    // behind forever, and without this every later step would wait the full
    // timeout and then build privately, permanently. A live build is never
    // taken this way: it beats on the claim between installer runs (see
    // heartbeat), and no single run may outlast the timeout.
    try {
      if (!isAbandoned(lock)) return null;
      seam?.beforeTakeover?.();
      return takeOver(lock, token, take);
    } catch {
      // Someone else won the takeover. Wait for them like any other holder.
      return null;
    }
  }
}

/** Quiet past the build timeout. */
function isAbandoned(dir: string): boolean {
  return Date.now() - fs.statSync(dir).mtimeMs > buildTimeoutMs();
}

/**
 * Take over an abandoned claim — atomically. Remove-then-take was not: two
 * waiters that both saw the stale lock both removed it, and the second
 * removal deleted the lock the first had just taken, so both built. Now a
 * takeover happens only under a second `mkdir` lock (one at a time), the
 * staleness is re-read under it (a lock another takeover just made is fresh
 * and is left alone), and the stale lock is renamed aside — then checked to
 * be the same claim that was judged stale — before it is removed.
 */
function takeOver(lock: string, token: string, take: () => string): string | null {
  const steal = `${lock}.steal`;
  try {
    fs.mkdirSync(steal);
  } catch {
    // Another takeover is in flight — or died in its few microseconds. A
    // takeover lock that old is cleared (renamed first: one clearer wins)
    // and the next poll tries again.
    try {
      if (isAbandoned(steal)) {
        const aside = `${steal}.${token}`;
        fs.renameSync(steal, aside);
        fs.rmSync(aside, { recursive: true, force: true });
      }
    } catch {
      // someone else cleared it
    }
    return null;
  }
  try {
    if (!isAbandoned(lock)) return null;
    const judged = readOwner(lock);
    const aside = `${lock}.stale-${token}`;
    fs.renameSync(lock, aside);
    if (readOwner(aside) !== judged) {
      // Not the claim judged stale: its build released it and a new one took
      // it in between. Hand it back and wait on it.
      try {
        fs.renameSync(aside, lock);
      } catch {
        fs.rmSync(aside, { recursive: true, force: true });
      }
      return null;
    }
    fs.rmSync(aside, { recursive: true, force: true });
    return take();
  } finally {
    fs.rmSync(steal, { recursive: true, force: true });
  }
}

function readOwner(dir: string): string | null {
  try {
    return fs.readFileSync(path.join(dir, "owner"), "utf8");
  } catch {
    return null;
  }
}

/** Is the claim on `root` still the one `token` took? */
function ownsBuild(root: string, token: string): boolean {
  try {
    return fs.readFileSync(path.join(root, ".building", "owner"), "utf8") === token;
  } catch {
    return false;
  }
}

/** Say the build is alive: the claim's mtime is the clock claimBuild reads.
 *  Synchronous installers block the event loop, so this cannot be a timer —
 *  it is called before and after every installer run instead. */
function heartbeat(root: string, token: string): void {
  if (ownsBuild(root, token)) touch(path.join(root, ".building"));
}

/** Release the claim — only if it is still ours. */
export function releaseBuild(root: string, token: string): void {
  if (ownsBuild(root, token)) fs.rmSync(path.join(root, ".building"), { recursive: true, force: true });
}

/** How long a failed shared build is news to the steps that waited on it.
 *  Older than this it describes an earlier attempt, and a new one is due. */
const FAILED_TTL_MS = 60_000;

/** Wait for another process's build, up to the point where it is abandoned.
 *  Waits for the claim to be released, not merely for `.ready` to exist: a
 *  stale entry being rebuilt still has its old marker for a moment, and
 *  reading that as "done" would wire the half-rebuilt directory up. A build
 *  that failed says so in `.failed`, and the wait ends there — it used to
 *  spin the full six minutes on a lock that was already gone. */
function awaitReady(root: string): { ready: true } | { ready: false; failed: string | null } {
  const until = Date.now() + buildTimeoutMs();
  while (Date.now() < until) {
    if (!fs.existsSync(path.join(root, ".building"))) {
      if (fs.existsSync(path.join(root, ".ready"))) return { ready: true };
      const failed = readFailed(root);
      if (failed !== null) return { ready: false, failed };
    }
    sleepSync(250);
  }
  return { ready: false, failed: null };
}

/** The error a recent failed build of `root` left, or null. */
function readFailed(root: string): string | null {
  const file = path.join(root, ".failed");
  try {
    if (Date.now() - fs.statSync(file).mtimeMs > FAILED_TTL_MS) return null;
    return (JSON.parse(fs.readFileSync(file, "utf8")) as { error?: string }).error ?? "the build failed";
  } catch {
    return null;
  }
}

/** A requirement's distribution name: `requests[socks]>=2` → `requests`. */
export function distName(req: string): string {
  return req.split(/[[<>=!~]/)[0].trim();
}

/** An npm requirement's package name: `@scope/pkg@^1` → `@scope/pkg`. */
export function npmName(req: string): string {
  const m = /^(@[^/]+\/)?[^@]+/.exec(req);
  return m ? m[0] : req;
}

// Asks the venv's own interpreter which declared distributions it can find.
// importlib.metadata, not `import x`: the distribution and the module are
// often named differently (beautifulsoup4 is bs4, pillow is PIL), and the
// declaration names distributions.
const PY_CHECK = [
  "import sys, importlib.metadata as m",
  "miss = []",
  "for n in sys.argv[1:]:",
  "    try: m.version(n)",
  "    except m.PackageNotFoundError: miss.append(n)",
  "print(','.join(miss))",
  "sys.exit(3 if miss else 0)",
].join("\n");

/**
 * Does a `.ready` entry still hold what the declaration asks for? Null when it
 * does, else why not.
 *
 * `.ready` is written once and trusted for ever, and that trust was misplaced
 * more than once: a build interrupted between install and marker, a cache
 * volume restored without its contents, and — the quiet one — an image whose
 * python moved (bookworm's 3.11 to trixie's 3.13), which leaves every venv
 * with a valid-looking bin/python pointing at an interpreter that is gone.
 * Each reported "cached" and failed later inside somebody's tool. One spawn
 * of the venv's python per step is the price of never doing that again.
 */
export function checkEntry(root: string, spec: RuntimeSpec): string | null {
  const venvPython = path.join(root, "venv", "bin", "python");
  if (wantsPython(spec)) {
    // existsSync follows the link, so a bin/python pointing at an interpreter
    // an image upgrade removed reads as missing here, which is the truth.
    if (!fs.existsSync(venvPython)) {
      return fs.lstatSync(venvPython, { throwIfNoEntry: false })
        ? "the venv's python no longer runs (the image's python has changed)"
        : "the python venv is missing";
    }
    const probe = () =>
      spawnSync(venvPython, ["-c", PY_CHECK, ...spec.packages.map(distName)], {
        encoding: "utf8",
        timeout: checkTimeoutMs(),
      });
    // A check that ran out of time says nothing about the venv — only that
    // the host is busy (a cold disk, twenty steps importing at once). Read as
    // broken, it deleted a venv other steps were running in and rebuilt it.
    // Asked once more; still no answer, and the entry is used as it stands.
    const timedOut = (r: ReturnType<typeof probe>) => (r.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT";
    let res = probe();
    if (timedOut(res)) res = probe();
    if (timedOut(res)) return null;
    if (res.status === 3) return `the venv is missing ${String(res.stdout).trim().split(",").join(", ")}`;
    if (res.status !== 0) return "the venv's python no longer runs (the image's python has changed)";
  }
  for (const req of spec.npm) {
    if (!fs.existsSync(path.join(root, "node_modules", npmName(req), "package.json"))) {
      return `node_modules is missing ${npmName(req)}`;
    }
  }
  return null;
}

/** How long the venv's python gets to answer checkEntry. Env-overridable
 *  for the same reason as the build timeout: tests cannot wait a minute. */
function checkTimeoutMs(): number {
  const raw = Number(process.env.FOLDRUN_RUNTIME_CHECK_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 60_000;
}

/** Days an entry may go unused before a later build prunes it. */
function maxAgeDays(): number {
  const raw = Number(process.env.FOLDRUN_RUNTIME_MAX_AGE_DAYS);
  return Number.isFinite(raw) && raw > 0 ? raw : 30;
}

/**
 * Remove entries nobody has used for maxAgeDays. `.ready`'s mtime is the
 * last-used clock (every hit touches it); an entry with no `.ready` is a
 * failed build and ages from its directory's own mtime. Never an entry that
 * is being built, and never `keep`. Runs after a successful build — the only
 * moment a cache grows — so it costs nothing on the hot path.
 */
export function pruneRuntimes(cacheRoot: string, keep: string): string[] {
  const cutoff = Date.now() - maxAgeDays() * 86_400_000;
  const removed: string[] = [];
  let names: string[] = [];
  try {
    names = fs.readdirSync(cacheRoot);
  } catch {
    return removed;
  }
  for (const name of names) {
    // .uv-cache and .python are shared by every entry; never an entry.
    if (name.startsWith(".") || name === keep) continue;
    const dir = path.join(cacheRoot, name);
    try {
      if (fs.existsSync(path.join(dir, ".building"))) continue;
      const ready = path.join(dir, ".ready");
      const clock = fs.existsSync(ready) ? fs.statSync(ready).mtimeMs : fs.statSync(dir).mtimeMs;
      if (clock < cutoff) {
        fs.rmSync(dir, { recursive: true, force: true });
        removed.push(name);
      }
    } catch {
      // Another process removed or claimed it meanwhile; its business.
    }
  }
  return removed;
}

/** Is `uv` on this host? Asked once per process. FOLDRUN_UV=0 forces pip. */
let uvKnown: string | null | undefined;
function findUv(): string | null {
  if (process.env.FOLDRUN_UV === "0") return null;
  if (uvKnown === undefined) uvKnown = run("uv", ["--version"], os.tmpdir(), 30_000).ok ? "uv" : null;
  return uvKnown;
}

// Build (or reuse) the environment for one runtime declaration.
/**
 * An installer's failure, said so that the first line is the cause.
 *
 * Until 11 Oct 2026 a failure was the installer's last 500 characters, and
 * the run log shows a message's first line: a pycairo build that died for
 * want of a C compiler read, in full, `uv pip install failed: files.` — the
 * tail end of a setuptools deprecation notice. The cause was on the last
 * line of 4 KB nobody saw. So: find the cause and the package it hit, say
 * the fix when it is one we know, then the last lines of the log for the rest.
 */
export function summarizeInstallFailure(what: string, out: string): string {
  const text = out ?? "";
  const lines = text.split(/\r?\n/).map((l) => l.replace(/\s+$/, "")).filter(Boolean);
  const pkg =
    /Failed to build `([^`]+)`/.exec(text)?.[1] ??
    /Failed building wheel for ([\w.-]+)/.exec(text)?.[1] ??
    /Building wheel for ([\w.-]+) \(.*\) did not run successfully/.exec(text)?.[1] ??
    /Failed to (?:download|prepare|fetch) `([^`]+)`/.exec(text)?.[1] ??
    null;
  const subject = pkg ? `\`${pkg}\`` : "a package";
  let cause: string | null = null;
  let hint = "";
  const header = /fatal error: ([\w./+-]+\.h): No such file/.exec(text);
  const pc = /Package '?([\w.+-]+)'?,? (?:required by [^,]+, )?(?:was )?not found|Dependency "([\w.+-]+)" not found/.exec(text);
  if (/No such file or directory: '[^']*gcc'|unable to execute '[^']*gcc'|\bgcc: (?:command )?not found|command '[^']*gcc' failed|error: command '[^']*\b(?:cc|gcc|c\+\+|g\+\+)' failed|C compiler cannot create executables|no acceptable C compiler/i.test(text)) {
    cause = `${subject} has to be compiled and this runner has no C compiler`;
    hint = " — add `system: [build-essential]` (and the -dev package of any library it builds against) to the runtime, or pin a version that ships a prebuilt wheel";
  } else if (/pkg-config(?:: command)? not found|Did not find pkg-config|pkg-config.*No such file/i.test(text)) {
    cause = `${subject} looks for its libraries with pkg-config, which this runner lacks`;
    hint = " — add `system: [pkg-config]` and the library's -dev package to the runtime";
  } else if (header && /^Python\.h$/.test(header[1])) {
    cause = `${subject} builds against Python's own C headers, which this runner lacks`;
    hint = " — add `system: [python3-dev, build-essential]` to the runtime";
  } else if (pc || header) {
    const lib = pc?.[1] ?? pc?.[2] ?? header![1];
    cause = `${subject} needs the system library ${lib} (its headers) to build`;
    hint = ` — add its Debian -dev package to \`runtime: system:\`${pc ? ` (for ${lib}, usually \`lib${lib.replace(/^lib/, "")}-dev\`)` : ""}, plus build-essential and pkg-config`;
  } else if (/E: Unable to locate package (\S+)/.test(text)) {
    cause = `apt has no package \`${/E: Unable to locate package (\S+)/.exec(text)![1]}\``;
    hint = " — check the name on packages.debian.org for trixie";
  } else if (/No solution found when resolving dependencies/.test(text)) {
    const i = lines.findIndex((l) => /No solution found/.test(l));
    cause = `the requirements cannot all be satisfied: ${lines.slice(i + 1, i + 3).map((l) => l.replace(/^[\s╰─▶×]+/, "")).join(" ")}`.trim();
  } else if (/No matching distribution found for (\S+)|Could not find a version that satisfies the requirement (\S+)|Because (\S+) was not found in the package registry/.test(text)) {
    const m = /No matching distribution found for (\S+)|Could not find a version that satisfies the requirement (\S+)|Because (\S+) was not found in the package registry/.exec(text)!;
    cause = `no published version of \`${m[1] ?? m[2] ?? m[3]}\` matches`;
  } else if (/npm (?:ERR!|error) code (\S+)/.test(text)) {
    const code = /npm (?:ERR!|error) code (\S+)/.exec(text)![1];
    const detail = lines.find((l) => /npm (?:ERR!|error) (?:404|notarget|E\w+)\b/.test(l) && !/ code /.test(l));
    cause = `npm ${code}${detail ? `: ${detail.replace(/^npm (?:ERR!|error)\s*/, "")}` : ""}`;
  }
  if (!cause) {
    const last = [...lines].reverse().find((l) => /error/i.test(l)) ?? lines[lines.length - 1] ?? "no output";
    cause = (pkg ? `${subject}: ` : "") + last.replace(/^\s*(?:error:|ERROR:|×)\s*/, "");
  }
  const excerpt = lines.slice(-25).join("\n");
  return `${what} failed — ${cause}${hint}\n${excerpt.length > 2000 ? excerpt.slice(-2000) : excerpt}`;
}

/** Sets $FOLDRUN_SYSTEM_PACKAGES from the step's input.json (its merged
 *  runtime spec) — the run pod's and the docker entry's first line. */
export const SYSTEM_FROM_INPUT_SH = `FOLDRUN_SYSTEM_PACKAGES="$(node -e 'try{const r=JSON.parse(require("fs").readFileSync("/opt/runner/job/input.json","utf8")).runtime;process.stdout.write(((r&&r.system)||[]).join(" "))}catch(e){}')"`;

/** Where a run container's root start-up records the system install. */
export const SYSTEM_STATUS_FILE = "/opt/runner/job/system-install.json";
export const SYSTEM_LOG_FILE = "/opt/runner/job/system-install.log";

/** Where the worker leaves the account's snapshot key for the root start-up
 *  (run-container.ts rootStartSh), which moves it somewhere only root can
 *  read and deletes this copy before any agent code runs. */
export const SNAPSHOT_KEY_FILE = "/opt/runner/job/snapshot.key";

/** The paths, relative to the root, a snapshot may write under: where Debian
 *  packages install. `var` reaches /var/run only through a link to /run, and
 *  /var/tmp is everyone's — the verifier refuses both on what is on disk. */
export const SNAPSHOT_ALLOWED = "etc usr var bin sbin lib lib32 lib64 libx32 opt";

/** The environment variables root's start-up keeps from the step's (the
 *  proxy apt downloads through); every other exported name is unset. */
const ROOT_ENV_KEEP = "HTTP_PROXY|HTTPS_PROXY|http_proxy|https_proxy|NO_PROXY|no_proxy|FOLDRUN_INSTALL_SOCKET";

/**
 * The first lines of root's start-up section (rootStartSh), run in a
 * subshell: the step's environment is the account's — its secrets by
 * whatever name the account chose, LD_PRELOAD and NODE_OPTIONS among the
 * names it could choose — and none of it may steer what root runs. PATH and
 * IFS are assigned before anything is executed, then `export -p` is read
 * with builtins only and every exported name but the proxy's is unset. The
 * test-only FOLDRUN_SYS_* / FOLDRUN_DPKG_DIR overrides go with the rest.
 */
export const ROOT_ENV_RESET_SH = String.raw`PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
IFS=$(printf ' \t\nx'); IFS=${"$"}{IFS%x}
_fx=$(export -p)
while read -r _fl; do
  case "$_fl" in "export "*|"declare -x "*) ;; *) continue;; esac
  _fn=${"$"}{_fl#export }; _fn=${"$"}{_fn#declare -x }; _fn=${"$"}{_fn%%=*}
  case "$_fn" in ${ROOT_ENV_KEEP}|PATH) ;; ""|*[!A-Za-z0-9_]*) ;; *) unset "$_fn" 2>/dev/null;; esac
done <<FOLDRUN_ENV
$_fx
FOLDRUN_ENV
unset _fx _fl _fn
HOME=/root; export PATH HOME`;

/**
 * The snapshot verifier and sealer, a CommonJS script the snippet writes to
 * its root-private directory and runs with node (FOL-129).
 *
 *   node v.cjs verify <keyfile> <key> <base> <root> <allowed> <agent uid> <out> <seal>  < tar
 *   node v.cjs seal   <keyfile> <key> <base> <root> <allowed> <agent uid> <tar>
 *
 * verify reads the tar once from stdin — hashing it, copying it to <out> and
 * reading its headers — and says `ok` only when the seal is this account's
 * (HMAC over the key, the base, the time it was built and the tar's sha256),
 * it was built in the last 14 days, and every member passes the audit below.
 * seal audits a tar root has just built and prints its seal line. Exit 3 is a
 * refusal, its reason on stdout; exit 4 is a snapshot past its 14 days.
 *
 * The audit is defence in depth under the seal, so that even sealed bytes can
 * only put package files where packages go: names relative, no `..`, under
 * an allowed root; regular files, directories, symlinks, and hard links to an
 * earlier file of the same archive, nothing else; no setuid or setgid; nothing
 * owned by the agent user; no name twice; nothing under one of the archive's
 * own symlinks unless the disk already has that very link; and on disk, every
 * existing directory a member lands under resolves inside an allowed root and
 * is root's alone (owned by root, not group- or world-writable — a sticky
 * root directory only above an existing entry), so no entry the agent made
 * can sit on a member's path, now or while the extraction runs.
 *
 * Written for a quoted heredoc inside a JS template: no backticks, no dollar
 * brace.
 */
const SNAPSHOT_JS = String.raw`"use strict";
const fs = require("node:fs"), crypto = require("node:crypto"), path = require("node:path");
const [mode, keyFile, KEY, BASE, root, allowArg, agentArg, a8, a9] = process.argv.slice(2);
const MAX = 6 * 1024 * 1024 * 1024, DAY = 86400;
const short = (n) => (String(n).length > 90 ? String(n).slice(0, 30) + "[..]" + String(n).slice(-50) : String(n));
const say = (s) => String(s).replace(/[^A-Za-z0-9 ._:\/+=,-]/g, "?").slice(0, 240);
const refuse = (why, code) => { process.stdout.write((code === 4 ? "expired: " : "refused: ") + say(why) + "\n"); process.exit(code || 3); };
let key = "";
try { key = fs.readFileSync(keyFile, "utf8").trim(); } catch (e) { key = ""; }
if (!/^[0-9a-f]{64}$/.test(key)) refuse("no snapshot key");
const macOf = (built, sha) => crypto.createHmac("sha256", Buffer.from(key, "hex")).update(["v5", KEY, BASE, built, sha].join("\n")).digest("hex");
const agent = /^[0-9]+$/.test(agentArg || "") ? Number(agentArg) : -1;
const euid = process.geteuid ? process.geteuid() : 0;
const rootReal = fs.realpathSync(root);
const allow = (allowArg || "").split(/\s+/).map((a) => a.replace(/^\/+|\/+$/g, "")).filter(Boolean);
const under = (p, base) => p === base || p.startsWith(base === "/" ? "/" : base + "/");
const allowReal = allow.map((a) => { const p = path.join(rootReal, a); try { return fs.realpathSync(p); } catch (e) { return p; } });
const allowedName = (n) => allow.some((a) => n === a || n.startsWith(a + "/"));

function norm(n, what) {
  if (n.indexOf("\0") >= 0) return { bad: what + " has a NUL in its name" };
  if (n.startsWith("/")) return { bad: what + " " + short(n) + " is an absolute path" };
  const parts = n.split("/").filter((p) => p !== "" && p !== ".");
  if (!parts.length) return { bad: what + " has an empty name" };
  if (parts.indexOf("..") >= 0) return { bad: what + " " + short(n) + " climbs out with .." };
  return { name: parts.join("/") };
}

// A tar read as a stream: ustar (its prefix only under the POSIX magic), GNU
// long names and links (L, K), pax per-file headers (x). A problem stops the
// reading but not the hashing: the seal is judged first, then the members.
const members = [];
let problem = null, ended = false, pend = Buffer.alloc(0), skip = 0, ext = null, longName = null, longLink = null, pax = null;
function num(h, a, b) {
  if (h[a] & 0x80) { if (h[a] & 0x40) return NaN; let v = h[a] & 0x3f; for (let i = a + 1; i < b; i++) v = v * 256 + h[i]; return v; }
  const s = str(h, a, b).trim();
  return /^[0-7]*$/.test(s) ? (s ? parseInt(s, 8) : 0) : NaN;
}
function str(h, a, b) { const s = h.subarray(a, b); const z = s.indexOf(0); return (z < 0 ? s : s.subarray(0, z)).toString("utf8"); }
function header(h) {
  if (h.every((b) => b === 0)) { ended = true; return; }
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : h[i];
  if (num(h, 148, 156) !== sum) { problem = "a header checksum is wrong"; return; }
  const magic = h.subarray(257, 263).toString("latin1");
  let name = str(h, 0, 100);
  if (magic === "ustar\0" && str(h, 345, 500)) name = str(h, 345, 500) + "/" + name;
  const type = h[156] === 0 ? "0" : String.fromCharCode(h[156]);
  let size = num(h, 124, 136), uid = num(h, 108, 116), link = str(h, 157, 257), uname = str(h, 265, 297);
  const m = num(h, 100, 108);
  if ([size, uid, m].some((v) => !Number.isFinite(v))) { problem = "a header holds a number tar cannot read"; return; }
  if (type === "L" || type === "K" || type === "x") {
    if (size > 1048576) { problem = "an extended header is too large"; return; }
    ext = { type, size, parts: [] }; skip = Math.ceil(size / 512) * 512;
    if (!skip) finishExt();
    return;
  }
  if (pax) { if (pax.path !== undefined) name = pax.path; if (pax.linkpath !== undefined) link = pax.linkpath; if (pax.size !== undefined) size = pax.size; if (pax.uid !== undefined) uid = pax.uid; if (pax.uname !== undefined) uname = pax.uname; }
  if (longName !== null) name = longName;
  if (longLink !== null) link = longLink;
  longName = longLink = pax = null;
  if (!"0125".includes(type)) { problem = "member " + short(name) + " is of a kind a snapshot never holds (type " + type + ")"; return; }
  const n = norm(name, "member");
  if (n.bad) { problem = n.bad; return; }
  members.push({ name: n.name, type, mode: m, uid, uname, link });
  skip = Math.ceil(size / 512) * 512;
}
function finishExt() {
  const data = Buffer.concat(ext.parts).subarray(0, ext.size);
  const t = ext.type; ext = null;
  if (t === "L") longName = str(data, 0, data.length);
  else if (t === "K") longLink = str(data, 0, data.length);
  else {
    pax = {};
    let i = 0;
    while (i < data.length) {
      const sp = data.indexOf(32, i);
      const len = sp < 0 ? NaN : parseInt(data.subarray(i, sp).toString("latin1"), 10);
      if (!(len > 0) || i + len > data.length) { problem = "a pax header cannot be read"; return; }
      const rec = data.subarray(sp + 1, i + len - 1).toString("utf8");
      const eq = rec.indexOf("=");
      const k = rec.slice(0, eq), v = rec.slice(eq + 1);
      if (k.startsWith("GNU.sparse")) { problem = "a sparse member"; return; }
      if (k === "path") pax.path = v;
      else if (k === "linkpath") pax.linkpath = v;
      else if (k === "uname") pax.uname = v;
      else if (k === "size" || k === "uid") { if (!/^[0-9]+$/.test(v)) { problem = "a pax " + k + " is not a number"; return; } pax[k] = Number(v); }
      i += len;
    }
  }
}
function feed(chunk) {
  let off = 0;
  while (off < chunk.length && !ended && !problem) {
    if (skip > 0) {
      const n = Math.min(skip, chunk.length - off);
      if (ext) ext.parts.push(chunk.subarray(off, off + n));
      skip -= n; off += n;
      if (!skip && ext) finishExt();
      continue;
    }
    const take = chunk.subarray(off, off + 512 - pend.length);
    pend = pend.length ? Buffer.concat([pend, take]) : take;
    off += take.length;
    if (pend.length === 512) { const h = Buffer.from(pend); pend = Buffer.alloc(0); header(h); }
  }
}

// The disk a member lands on, walked one component at a time from / the way
// the kernel will walk it when tar writes: every directory passed through,
// and every link followed (from the directory that holds it), must be root's
// alone, so nothing on the way can be swapped after this check, even while
// the agent runs (the install helper restores beside it). A directory anyone
// may write is passed only when it is root's and sticky and the entry taken
// from it is root's; nothing is created in one. The directory the member
// lands in must be under the root and under an allowed path.
const walked = new Map();
function onDisk(name) {
  const parent = path.posix.dirname(name);
  if (walked.has(parent)) { const w = walked.get(parent); return w && w.replace("@", short(name)); }
  const why = walk(parent === "." ? [] : parent.split("/"));
  walked.set(parent, why);
  return why && why.replace("@", short(name));
}
function walk(parts) {
  const okDir = (st) => (st.uid === 0 || st.uid === euid) && ((st.mode & 0o022) === 0 || ((st.mode & 0o1000) !== 0 && st.uid === 0));
  const open = (st) => (st.mode & 0o022) !== 0;
  let cur = "/", st;
  try { st = fs.lstatSync("/"); } catch (e) { return "member @ has no / to land on"; }
  if (!okDir(st)) return "member @ lies under /, which others can write";
  let queue = (rootReal === "/" ? [] : rootReal.slice(1).split("/")).concat(parts);
  for (let hops = 0; queue.length; ) {
    const c = queue.shift();
    if (c === "" || c === ".") continue;
    if (c === "..") {
      cur = path.dirname(cur);
      try { st = fs.lstatSync(cur); } catch (e) { return "member @ lies under " + short(cur) + ", which cannot be read"; }
      continue;
    }
    const next = cur === "/" ? "/" + c : cur + "/" + c;
    let lst;
    try { lst = fs.lstatSync(next); } catch (e) {
      // Missing from here down: tar makes it, inside cur.
      if (open(st)) return "member @ would be made in " + short(cur) + ", which others can write";
      queue = [];
      break;
    }
    if (open(st) && !(lst.uid === 0 || lst.uid === euid)) return "member @ lies under " + short(next) + ", which others could replace";
    if (lst.isSymbolicLink()) {
      if (++hops > 40) return "member @ lies under too many links";
      try { fs.statSync(next); } catch (e) { return "member @ lies under the broken link " + short(next); }
      const t = fs.readlinkSync(next);
      if (t.startsWith("/")) { cur = "/"; st = fs.lstatSync("/"); }
      queue = t.split("/").concat(queue);
      continue;
    }
    if (!lst.isDirectory()) return "member @ lies under " + short(next) + ", which is not a directory";
    if (!okDir(lst)) return "member @ lies under " + short(next) + ", which others can write";
    cur = next; st = lst;
  }
  if (!queue.length && open(st)) return "member @ would be made in " + short(cur) + ", which others can write";
  if (!under(cur, rootReal)) return "member @ leads out of the root, to " + short(cur);
  if (parts.length && !allowReal.some((a) => under(cur, a))) return "member @ leads through a link to " + short(cur) + ", where packages do not install";
  return null;
}

function audit() {
  const seen = new Map(), links = new Map();
  for (const m of members) {
    if (seen.has(m.name)) return "member " + short(m.name) + " appears twice";
    if (!allowedName(m.name)) return "member " + short(m.name) + " is outside the paths packages install to";
    if (allow.indexOf(m.name) >= 0 && m.type !== "5") {
      let same = false;
      try { same = m.type === "2" && fs.readlinkSync(path.join(rootReal, m.name)) === m.link; } catch (e) { same = false; }
      if (!same) return "member " + short(m.name) + " would replace a top-level system directory";
    }
    if (m.mode & 0o6000) return "member " + short(m.name) + " is setuid or setgid";
    if ((agent >= 0 && m.uid === agent) || m.uname === "agent") return "member " + short(m.name) + " belongs to the agent user";
    if (m.type === "1") {
      const t = norm(m.link, "hard link " + m.name);
      if (t.bad) return t.bad;
      const target = seen.get(t.name);
      if (!target || target.type !== "0") return "hard link " + short(m.name) + " points at " + short(t.name) + ", not at a file earlier in the snapshot";
    }
    if (m.type === "2") links.set(m.name, m.link);
    seen.set(m.name, m);
  }
  for (const m of members) {
    const parts = m.name.split("/");
    for (let i = 1; i < parts.length; i++) {
      const p = parts.slice(0, i).join("/");
      const up = seen.get(p);
      if (!up) continue;
      if (up.type === "2") {
        let same = false;
        try { same = fs.readlinkSync(path.join(rootReal, p)) === up.link; } catch (e) { same = false; }
        if (!same) return "member " + short(m.name) + " lies under a link in the snapshot itself, " + short(p);
      } else if (up.type !== "5") return "member " + short(m.name) + " lies under the file " + short(p);
    }
    const why = onDisk(m.name);
    if (why) return why;
  }
  return null;
}
function finish(sha) {
  if (!problem && !ended) problem = "the archive ends before its end marker";
  return problem || audit();
}

if (mode === "verify") {
  const seal = /^v5 ([0-9]{1,12}) ([0-9a-f]{64}) ([0-9a-f]{64})$/.exec((a9 || "").trim());
  if (!seal) refuse("it carries no seal");
  const built = Number(seal[1]), now = Math.floor(Date.now() / 1000);
  if (built > now + 300) refuse("its seal is dated in the future");
  if (now - built > 14 * DAY) refuse("built " + Math.floor((now - built) / DAY) + " days ago", 4);
  const out = fs.openSync(a8, "wx", 0o600);
  const hash = crypto.createHash("sha256");
  let total = 0;
  process.stdin.on("data", (chunk) => {
    total += chunk.length;
    if (total > MAX) refuse("it is larger than 6 GiB");
    hash.update(chunk); fs.writeSync(out, chunk); feed(chunk);
  });
  process.stdin.on("end", () => {
    fs.closeSync(out);
    const sha = hash.digest("hex");
    if (sha !== seal[2]) refuse("its contents do not match its seal");
    const want = Buffer.from(macOf(seal[1], sha), "hex"), got = Buffer.from(seal[3], "hex");
    if (!crypto.timingSafeEqual(want, got)) refuse("its seal was not made with the account key");
    const why = finish(sha);
    if (why) refuse(why);
    process.stdout.write("ok\n");
  });
} else if (mode === "seal") {
  const fd = fs.openSync(a8, "r");
  const hash = crypto.createHash("sha256");
  const buf = Buffer.alloc(1 << 20);
  for (let n; (n = fs.readSync(fd, buf, 0, buf.length, null)) > 0; ) { const c = buf.subarray(0, n); hash.update(c); feed(c); }
  fs.closeSync(fd);
  const sha = hash.digest("hex");
  const why = finish(sha);
  if (why) refuse(why);
  const built = String(Math.floor(Date.now() / 1000));
  process.stdout.write("v5 " + built + " " + sha + " " + macOf(built, sha) + "\n");
} else refuse("unknown mode");
`;

/** What the agent user runs to publish a snapshot root built and sealed:
 *  sh -c PUBLISH sh <key dir> <generation> <seal> <base>, the tar on stdin.
 *  As the agent, so a link it planted in the cache leads only where it could
 *  write itself (FOL-129); the -L checks are for the same-user tests. */
const PUBLISH_SH = String.raw`cd / || exit 0; K=$1; G=$K/$2
[ -L "$(dirname "$K")" ] && exit 0
mkdir -p "$K" 2>/dev/null || exit 0
[ -L "$K" ] && exit 0
T=$(mktemp -d "$K/.stage.XXXXXX" 2>/dev/null) || exit 0
if cat > "$T/snap.tar" && printf "%s\n" "$3" > "$T/seal" && printf "%s\n" "$4" > "$T/base"; then
  [ -e "$G" ] && mv "$G" "$K/.gone.$(basename "$T")" 2>/dev/null
  [ -e "$G" ] || mv "$T" "$G" 2>/dev/null
fi
rm -rf "$T" "$K/.gone.$(basename "$T")" 2>/dev/null
ls -t "$K" 2>/dev/null | tail -n +5 | while read -r o; do rm -rf "$K/$o"; done`;

/** What the agent user runs to keep the snapshot folder tidy:
 *  sh -c PRUNE sh <snapshots> <cache>. Generations past their 14 days,
 *  stages a killed pod left, keys left empty, and the v3/v4 layout under
 *  `.apt` (its .deb cache too), which nothing reads any more. Where `.apt`
 *  was made by root (a docker volume) the agent cannot remove it and it
 *  stays; root does not delete in the agent's folder. */
const PRUNE_SH = String.raw`cd / || exit 0; S=$1
rm -rf "$2/.apt" 2>/dev/null
[ -d "$S" ] && [ ! -L "$S" ] || exit 0
find "$S" -mindepth 2 -maxdepth 2 -type d ! -name ".*" -mtime +14 -exec rm -rf {} + 2>/dev/null
find "$S" -mindepth 2 -maxdepth 2 -type d -name ".*" -mmin +120 -exec rm -rf {} + 2>/dev/null
find "$S" -mindepth 1 -maxdepth 1 -type d -empty -mmin +120 -delete 2>/dev/null
exit 0`;

/**
 * The root start-up's half of `runtime: system:` — one shell snippet, used by
 * the k8s run pod, the docker entry, the deploy-time warm pod and the install
 * helper alike. Reads the package names from $FOLDRUN_SYSTEM_PACKAGES
 * (space-separated, each re-checked against DEB_PACKAGE's shape here too, so
 * nothing else can ride in), installs them with apt as root BEFORE the drop to
 * the agent user, and writes SYSTEM_STATUS_FILE for prepareRuntime to read.
 *
 * The first step to need a package set installs it with apt and then saves
 * the files those packages added, with their dpkg records, as a snapshot.
 * Every later step restores the snapshot instead — measured 11 Oct 2026 in a
 * gVisor run pod on the NFS cache: build-essential, pkg-config, python3-dev,
 * libcairo2-dev and libpango1.0-dev (154 packages, 432 MB) took 23-30 s
 * through apt and 0.76 s from the snapshot, gcc and pkg-config working after.
 * Package lists stay per pod: two pods updating one lists directory on a
 * shared volume would corrupt it.
 *
 * Who can write the snapshots (FOL-129, 5 Nov 2026). They live in the
 * account's runtime cache, which the agent user owns and writes — and on EFS
 * the access point makes every write uid 501 whoever asks, so no ownership
 * can keep the agent out. Root extracts a snapshot onto `/`. Until v5 that
 * meant an agent that rewrote snap.tar had its own files written as root
 * anywhere at the next step's start (an /etc/ld.so.preload, say), in any
 * later step of the account; and root's mkdir, mv and rm -rf in the agent's
 * folder followed whatever links the agent left there. Now:
 *
 *  - a snapshot is restored only under a SEAL: an HMAC, with a key the
 *    worker derives per account from the install key and hands to root in a
 *    file the agent never sees (SNAPSHOT_KEY_FILE), over the package set,
 *    the base, the time it was built and the tar's sha256. The tar is copied
 *    into a directory only root can read while it is hashed, and extracted
 *    from that copy, so a step running beside this one cannot swap it after
 *    the check. No key (a warm pod, an embedder): no snapshots, apt only;
 *  - under the seal, the verifier (SNAPSHOT_JS) audits every member, and
 *    extraction is --numeric-owner --no-overwrite-dir;
 *  - root reads, writes and deletes in the cache only as the agent user
 *    (runuser), so a link the agent planted there leads only where the agent
 *    could write itself;
 *  - only the start-up saves, before any agent code exists in the pod; the
 *    install helper (`save: false`), which runs beside the agent, restores
 *    but never seals what it found on disk;
 *  - the shared .deb cache is gone: apt downloads into the pod's own
 *    /var/cache/apt, so no root download is written through the agent's
 *    folder. Only a snapshot miss pays the download.
 *
 * Layout, format v5:
 *
 *   <cache>/.system-snapshots/v5-<key>/<base>/snap.tar, seal, base
 *
 * The KEY is what the snapshot is of: the package set, the Debian release
 * (os-release ID and VERSION_ID) and the machine (uname -m). Under it, one
 * GENERATION per base, named by and holding the sha256 of the dpkg status
 * file it was built on, and restored only onto a base whose status is
 * byte-identical (FOL-50): the tar carries that status whole and files built
 * against those exact packages, and a maintainer script reads the base as
 * well as writing to it. What keeps a snapshot valid across releases is the
 * image keeping its OS layers (run-container.ts, FOLDRUN_OS_REFRESH):
 *
 *  - a base change is a new generation beside the old ones, counted in the
 *    status file as `stale` (the run log says "N snapshots did not fit this
 *    image"), and the four newest generations per key are kept;
 *  - a generation is restored for 14 days from the time sealed into it, then
 *    rebuilt — so the packages it added pick up Debian's fixes — and removed;
 *  - it is built in a staging directory and published with one rename, so
 *    a reader never sees half of one.
 *
 * A restore that is refused or fails falls back to apt, the status file says
 * why (`refused`), and prepareRuntime verifies the result either way.
 */
export function systemInstallSh(cacheDir: string, logDir = "/opt/runner/job", opts: { save?: boolean } = {}): string {
  const save = opts.save !== false;
  // String.raw so the shell's backslashes are its own. No shell `${…}` may
  // appear below (it would be a JS interpolation): defaults are spelled out.
  return String.raw`if [ -n "$FOLDRUN_SYSTEM_PACKAGES" ]; then
  SYS=""; for p in $FOLDRUN_SYSTEM_PACKAGES; do case "$p" in -*|*[!a-z0-9+.-]*) ;; *) SYS="$SYS $p";; esac; done
  D=$FOLDRUN_DPKG_DIR; [ -n "$D" ] || D=/var/lib/dpkg
  R=$FOLDRUN_SYS_ROOT; [ -n "$R" ] || R=/
  SCAN=$FOLDRUN_SYS_SCAN; [ -n "$SCAN" ] || SCAN="/etc /usr /var/lib"
  OSR=$FOLDRUN_OS_RELEASE; [ -n "$OSR" ] || OSR=/etc/os-release
  ALLOW=$FOLDRUN_SYS_ALLOW; [ -n "$ALLOW" ] || ALLOW="${SNAPSHOT_ALLOWED}"
  KF=$FOLDRUN_SNAP_KEY_FILE; S=${cacheDir}/.system-snapshots
  # The cache is the agent's: as root, touch it only as the agent user.
  AS=""; AU=""
  if [ "$(id -u)" = 0 ]; then AU=$(id -u agent 2>/dev/null) && AS="runuser -u agent --" || S=""; fi
  # Bounded: a FIFO or an endless file in place of a snapshot must not hold
  # every later start-up of the account.
  command -v timeout > /dev/null 2>&1 && AS="timeout 300 $AS"
  W=$(mktemp -d /tmp/.foldrun-sys.XXXXXX 2>/dev/null) || { W=""; S=""; }
  { [ -n "$KF" ] && [ -f "$KF" ] && command -v node > /dev/null 2>&1; } || S=""
  _fh() { if command -v sha256sum > /dev/null 2>&1; then sha256sum | cut -c1-64; else shasum -a 256 | cut -c1-64; fi; }
  KEY=v5-$( { printf '%s\n' $SYS | LC_ALL=C sort -u; grep -E '^(ID|VERSION_ID)=' "$OSR" 2>/dev/null; uname -m; } | _fh | cut -c1-16)
  BASE=$(_fh < "$D/status"); GN=$(echo "$BASE" | cut -c1-16); K=$S/$KEY; G=$K/$GN
  [ -n "$BASE" ] && [ "$KEY" != v5- ] || S=""
  XF="--numeric-owner"; tar --version 2>/dev/null | grep -q GNU && XF="--numeric-owner --no-overwrite-dir --keep-directory-symlink"
  T0=$(date +%s); MODE=apt; RC=1; STALE=0; WHY=""; UNSAVED=""
  if [ -n "$S" ]; then
    cat > "$W/v.cjs" <<'FOLDRUN_SNAPSHOT_JS'
${SNAPSHOT_JS}
FOLDRUN_SNAPSHOT_JS
  fi
  if [ -n "$S" ] && $AS test -f "$G/snap.tar" 2>/dev/null; then
    # Read bounded: the seal is one line of ~150 bytes, the base 65 — a file
    # the agent made endless must not fill root's memory.
    if [ "$($AS head -c 128 "$G/base" 2>/dev/null)" = "$BASE" ]; then
      SEAL=$($AS head -c 512 "$G/seal" 2>/dev/null)
      V=$($AS cat "$G/snap.tar" 2>/dev/null | node "$W/v.cjs" verify "$KF" "$KEY" "$BASE" "$R" "$ALLOW" "$AU" "$W/snap.tar" "$SEAL" 2>/dev/null); VR=$?
      if [ $VR -eq 0 ] && [ "$V" = ok ] && tar -xf "$W/snap.tar" -C "$R" $XF > ${logDir}/system-install.log 2>&1; then
        MODE=snapshot; RC=0
        # apt runs ldconfig through dpkg's trigger; a restore must too, or a
        # library the snapshot brought is missing from /etc/ld.so.cache.
        [ "$R" = / ] && ldconfig 2>/dev/null
      elif [ $VR -eq 3 ]; then WHY=$(printf '%s' "$V" | sed 's/^refused: //')
      fi
      rm -f "$W/snap.tar"
    fi
  fi
  if [ -n "$S" ] && [ "$MODE" != snapshot ]; then
    # Generations of this package set built on other bases: why apt runs.
    STALE=$($AS ls "$K" 2>/dev/null | grep -cvx "$GN")
  fi
  if [ "$MODE" != snapshot ]; then
    [ -n "$S" ] && [ ${save ? "1" : "0"} = 1 ] && { ls "$D"/info/*.list 2>/dev/null | sort > "$W/before"; touch "$W/mark"; sleep 1; }
    { apt-get -o Acquire::Retries=3 -qq update && DEBIAN_FRONTEND=noninteractive apt-get -o Acquire::Retries=3 -o Dpkg::Use-Pty=0 install -y -qq --no-install-recommends $SYS; } > ${logDir}/system-install.log 2>&1
    RC=$?
    apt-get -qq clean > /dev/null 2>&1
    if [ $RC -eq 0 ] && [ -n "$S" ] && [ ${save ? "1" : "0"} = 1 ]; then
      ls "$D"/info/*.list 2>/dev/null | sort > "$W/after"
      comm -13 "$W/before" "$W/after" > "$W/new"
      if [ -s "$W/new" ]; then
        { cat $(cat "$W/new") | sort -u | while read -r f; do if [ -f "$f" ] || [ -L "$f" ]; then echo "$f"; fi; done
          for l in $(cat "$W/new"); do ls "$(dirname "$l")/$(basename "$l" .list)".* 2>/dev/null; done
          echo "$D/status"
          # What the packages' install scripts made, which dpkg's lists do not
          # name: update-alternatives links (libblas.so.3 → /etc/alternatives),
          # generated caches and configs. By ctime, not mtime: those links carry
          # the package's own (2025) mtime, and only ctime cannot be backdated.
          find $SCAN -xdev \( -path /var/lib/apt -o -path "$D/info" -o -path "${cacheDir}" \) -prune -o \( -type f -o -type l \) -cnewer "$W/mark" -print 2>/dev/null
        } | grep '^/' | sort -u > "$W/files"
        # Built where only root can read, audited and sealed, then handed to
        # the agent user to publish.
        if tar -cf "$W/snap.tar" --numeric-owner -T "$W/files" 2>/dev/null && SEAL=$(node "$W/v.cjs" seal "$KF" "$KEY" "$BASE" "$R" "$ALLOW" "$AU" "$W/snap.tar" 2>/dev/null); then
          $AS sh -c '${PUBLISH_SH}' sh "$K" "$GN" "$SEAL" "$BASE" < "$W/snap.tar" 2>/dev/null
        else
          UNSAVED=$(printf '%s' "$SEAL" | sed 's/^refused: //')
        fi
        rm -f "$W/snap.tar"
      fi
      $AS sh -c '${PRUNE_SH}' sh "$S" "${cacheDir}" 2>/dev/null
    fi
  fi
  printf '{"ok": %s, "exit": %s, "seconds": %s, "mode": "%s", "stale": %s, "packages": "%s", "refused": "%s", "unsaved": "%s"}\n' "$([ $RC -eq 0 ] && echo true || echo false)" "$RC" "$(( $(date +%s) - T0 ))" "$MODE" "$STALE" "$SYS" "$WHY" "$UNSAVED" > ${logDir}/system-install.json
  [ -n "$W" ] && rm -rf "$W"
  rm -rf /var/lib/apt/lists/* 2>/dev/null || true
fi`;
}

/**
 * Are the declared system packages on this machine? The install happened in
 * the container's root start-up (systemInstallSh); this only reads the
 * result. Without dpkg (a laptop, macOS) there is nothing to check against
 * and nothing this process could install: say so and carry on.
 */
export function checkSystemPackages(pkgs: string[]): { log: string[]; error: string | null } {
  if (!pkgs.length) return { log: [], error: null };
  const statusFile = process.env.FOLDRUN_SYSTEM_STATUS ?? SYSTEM_STATUS_FILE;
  const logFile = process.env.FOLDRUN_SYSTEM_LOG ?? SYSTEM_LOG_FILE;
  let status: { ok?: boolean; seconds?: number; mode?: string; stale?: number; refused?: string; unsaved?: string } | null = null;
  try {
    status = JSON.parse(fs.readFileSync(statusFile, "utf8"));
  } catch {
    status = null;
  }
  const q = spawnSync("dpkg-query", ["-W", "-f=${Package} ${db:Status-Status}\n", ...pkgs], { encoding: "utf8" });
  if (q.error) {
    return { log: [`system packages ${pkgs.join(", ")} install only in a run container; on this machine they are assumed present`], error: null };
  }
  const installed = new Set(
    (q.stdout ?? "")
      .split("\n")
      .map((l) => l.trim().split(/\s+/))
      .filter((f) => f[1] === "installed")
      .map((f) => f[0].replace(/:.*$/, "")),
  );
  const missing = pkgs.filter((p) => !installed.has(p));
  if (!missing.length) {
    // `stale`: snapshots of this package set that were there but did not fit
    // this image (systemInstallSh) — what says why a step paid apt again.
    const stale = status?.mode !== "snapshot" && status?.stale ? `, ${status.stale} snapshot${status.stale === 1 ? "" : "s"} did not fit this image` : "";
    // FOL-129: a snapshot whose seal or contents did not pass, and one the
    // start-up would not seal — said, so a step that paid apt says why.
    const notes = [
      ...(status?.mode !== "snapshot" && status?.refused ? [`snapshot refused: ${status.refused}`] : []),
      ...(status?.unsaved ? [`no snapshot kept: ${status.unsaved}`] : []),
    ];
    return {
      log: [
        `system packages ready: ${pkgs.join(", ")}${status?.seconds !== undefined ? ` (${status.mode === "snapshot" ? "snapshot" : "apt"}, ${status.seconds}s${stale})` : ""}`,
        ...notes,
      ],
      error: null,
    };
  }
  let aptOut = "";
  try {
    aptOut = fs.readFileSync(logFile, "utf8");
  } catch {
    aptOut = "";
  }
  const reason = !status
    ? "this runner did not install them — system packages are installed by a run container's start-up (k8s or docker isolation), not on a bare host"
    : status.ok
      ? "apt reported success, yet they are not installed"
      : summarizeInstallFailure("apt-get install", aptOut).replace(/^apt-get install failed — /, "apt: ");
  return { log: [], error: `system packages not installed: ${missing.join(", ")} — ${reason}` };
}

export function prepareRuntime(tenant: string, spec: RuntimeSpec | null): PreparedRuntime {
  if (!spec) return EMPTY;
  const system = checkSystemPackages(spec.system ?? []);
  if (system.error) return { ...EMPTY, log: system.log, error: system.error };
  if (!wantsPython(spec) && !wantsNode(spec)) return { ...EMPTY, log: system.log };
  const built = prepareLanguageRuntime(tenant, spec);
  return system.log.length ? { ...built, log: [...system.log, ...built.log] } : built;
}

function prepareLanguageRuntime(tenant: string, spec: RuntimeSpec): PreparedRuntime {

  const fp = fingerprint(spec);
  const cacheRoot = path.join(dataRoot(), tenant, ".runtimes");
  const shared = path.join(cacheRoot, fp);
  // Loud, and before anything else: a dropped requirement surfaces later as
  // an import error inside a script, which points at the wrong thing entirely.
  const dropped = [
    ...(spec.rejected?.length ? [`runtime ${fp}: ignored invalid requirement(s): ${spec.rejected.join(", ")}`] : []),
    ...(spec.ignored?.length
      ? [
          `runtime ${fp}: requirements.txt option(s) not applied: ${spec.ignored.join(", ")} — the requirements are installed${spec.ignored.includes("--hash") ? " without hash checking" : ""}`,
        ]
      : []),
  ];

  // The platform's shared layer first: environments built once, by the
  // platform, for every account that declares exactly this — mounted
  // read-only into the run (FOLDRUN_RUNTIME_SHARED, run-k8s.ts). Only a
  // healthy entry is used; anything else falls through to the account's own
  // cache, which is writable and builds what the shared layer lacks.
  const sharedLayer = process.env.FOLDRUN_RUNTIME_SHARED;
  if (sharedLayer) {
    const entry = path.join(sharedLayer, fp);
    if (fs.existsSync(path.join(entry, ".ready")) && !checkEntry(entry, spec)) {
      const hit = wire(entry, spec, `runtime ${fp}: shared`);
      return { ...hit, log: [...dropped, ...hit.log] };
    }
  }

  // Already built, and still holding what it promises: wire it up and skip
  // the install. On the hosted path this directory is a mounted volume, so
  // the hit rate across a run is close to one. An entry that fails the check
  // is rebuilt, not trusted and not merely reported.
  let stale: string | null = null;
  if (fs.existsSync(path.join(shared, ".ready"))) {
    stale = checkEntry(shared, spec);
    if (!stale) {
      touch(path.join(shared, ".ready"));
      const hit = wire(shared, spec, `runtime ${fp}: cached`);
      return { ...hit, log: [...dropped, ...hit.log] };
    }
  }

  fs.mkdirSync(shared, { recursive: true });

  let root = shared;
  const held = claimBuild(shared);
  if (!held) {
    // A concurrent step is building exactly this. Waiting for it beats
    // duplicating it — the work is identical and it is already underway.
    const waited = awaitReady(shared);
    if (waited.ready && !checkEntry(shared, spec)) {
      const hit = wire(shared, spec, `runtime ${fp}: cached (built by a concurrent step)`);
      return { ...hit, log: [...dropped, ...hit.log] };
    }
    // It failed, and just now: the same declaration would fail the same way
    // here, so say what it said rather than spend another five minutes on it.
    if (!waited.ready && waited.failed !== null) {
      return { ...EMPTY, log: dropped, error: `runtime ${fp}: a concurrent step's build of this runtime failed — ${waited.failed}` };
    }
    // It never finished. Build privately instead: slower and uncached, but a
    // step that runs is worth more than a cache entry, and a wedged lock must
    // never be able to stop work. In the tmpdir, not the cache — a private
    // build is by definition not worth keeping, and leaving these beside the
    // real entries would grow a directory nothing ever prunes. Removed by
    // dispose() when the step is done with it.
    root = fs.mkdtempSync(path.join(os.tmpdir(), `foldrun-runtime-${fp}-`));
  } else {
    fs.rmSync(path.join(shared, ".failed"), { force: true });
    if (stale || !fs.existsSync(path.join(shared, ".ready"))) {
      // A clean slate: whatever a stale or half-finished build left behind is
      // exactly what must not be built on top of.
      for (const leftover of [".ready", "venv", "node_modules", "package.json", "package-lock.json"]) {
        fs.rmSync(path.join(shared, leftover), { recursive: true, force: true });
      }
    }
  }
  const privateRoot = root === shared ? null : root;
  const disposePrivate = () => {
    if (privateRoot) fs.rmSync(privateRoot, { recursive: true, force: true });
  };
  // Every installer run goes through here, so the claim is beaten on before
  // and after each one — no run can go quieter than its own timeout.
  const install = (...args: Parameters<typeof run>) => {
    if (held) heartbeat(shared, held);
    try {
      return run(...args);
    } finally {
      if (held) heartbeat(shared, held);
    }
  };

  const ready = path.join(root, ".ready");
  const interpreters: Record<string, string> = {};
  const env: Record<string, string> = {};
  const log: string[] = [...dropped];
  if (stale) log.push(`runtime ${fp}: cached entry unusable (${stale}); rebuilding`);

  const venvPython = path.join(root, "venv", "bin", "python");
  const wantsPy = wantsPython(spec);
  const wantsNd = wantsNode(spec);
  const built: Record<string, unknown> = { built: new Date().toISOString() };
  let succeeded = false;
  let failure = "the build failed";
  const fail = (error: string): PreparedRuntime => {
    failure = error;
    return { ...EMPTY, log, error };
  };

  try {

  if (wantsPy) {
    const uv = findUv();
    const pin = typeof spec.python === "string" ? spec.python : null;
    // uv's own caches sit beside the entries they fill, so they live as long
    // as the cache volume does: a second environment asking for pandas links
    // it out of .uv-cache instead of downloading it again, and a pinned
    // python fetched once into .python serves every later venv. Copy, not
    // hardlink — the volume may be NFS or EFS, where links across the cache
    // and the entry are not guaranteed.
    const uvEnv = {
      UV_CACHE_DIR: path.join(cacheRoot, ".uv-cache"),
      // Inside the entry when the platform builds for the shared layer: that
      // build may write only its own entry, and a venv whose interpreter
      // lived beside it would point at nothing once mounted elsewhere.
      UV_PYTHON_INSTALL_DIR:
        process.env.FOLDRUN_RUNTIME_PYTHON_IN_ENTRY === "1" ? path.join(root, ".python") : path.join(cacheRoot, ".python"),
      UV_LINK_MODE: "copy",
      UV_NO_PROGRESS: "1",
    };
    // A sealed venv, never --system-site-packages. Inheriting the image's
    // packages would make a warm start cheaper, and it was measured on the
    // production box on 2026-08-29: a venv that shadows a baked `pandas` with
    // a pinned one keeps the *system* numpy underneath it, and the two are not
    // ABI-compatible — `pandas<2` on top of numpy 2 dies at import with
    // "numpy.dtype size changed". A pin that silently produces a broken
    // interpreter is worse than any install it saves.
    if (uv) {
      const want = pin ?? (hasCommand("python3", root) ? "python3" : "3");
      // --seed puts pip in the venv as well, for the agent that types
      // `pip install` in Bash; uv itself does not need it.
      const made = install(uv, ["venv", "--seed", "-q", "--python", want, path.join(root, "venv")], root, 300_000, uvEnv);
      if (!made.ok) {
        return fail(
          pin
            ? `python ${pin} could not be provided (uv tried the image and a download): ${made.out.slice(-400)}`
            : `failed to create venv: ${made.out.slice(-400)}`,
        );
      }
    } else {
      // No uv: the image's own interpreter or nothing. A pin the image cannot
      // meet is an error, said as one — it used to fall back to python3 in
      // silence, and "I asked for 3.12" then ran on 3.11.
      const exe = pin ? (hasCommand(`python${pin}`, root) ? `python${pin}` : null) : hasCommand("python3", root) ? "python3" : null;
      if (!exe) {
        return fail(
          pin
            ? `python ${pin} is not installed here, and uv (which could fetch it) is not available`
            : `no python3 on this host, and uv (which could fetch one) is not available`,
        );
      }
      const made = install(exe, ["-m", "venv", path.join(root, "venv")], root);
      if (!made.ok) return fail(`failed to create venv: ${made.out.slice(0, 300)}`);
    }
    const version = install(venvPython, ["-c", "import platform; print(platform.python_version())"], root, 30_000);
    built.python = version.ok ? version.out : "unknown";
    built.installer = uv ? "uv" : "pip";
    log.push(`runtime ${fp}: created venv (python ${built.python}${uv ? " via uv" : ""})`);

    if (spec.packages.length) {
      const installed = uv
        ? install(uv, ["pip", "install", "-q", "--python", venvPython, ...spec.packages], root, 300_000, uvEnv)
        : install(path.join(root, "venv", "bin", "pip"), ["install", "--disable-pip-version-check", "-q", ...spec.packages], root);
      if (!installed.ok) {
        return fail(summarizeInstallFailure(`${uv ? "uv pip" : "pip"} install`, installed.out));
      }
      built.packages = spec.packages;
      log.push(`runtime ${fp}: installed ${spec.packages.join(", ")}`);
    }
  }

  if (wantsNd) {
    if (spec.npm.length) {
      fs.writeFileSync(
        path.join(root, "package.json"),
        JSON.stringify({ name: `foldrun-runtime-${fp}`, private: true }, null, 2),
      );
      // Not --silent: it sets npm's loglevel to silent, which suppresses the
      // explanation along with the noise. A build log nobody reads is cheaper
      // than a failure nobody can explain.
      const installed = install(
        "npm",
        ["install", "--no-fund", "--no-audit", "--no-progress", ...spec.npm],
        root,
        300_000,
        {
          // npm keeps its cache under $HOME/.npm. A sandbox runs as a user
          // with no home directory, so that resolves to /.npm, which it may
          // not create — and npm fails with ENOENT before it fetches
          // anything. Every tool declaring `npm:` failed this way, on every
          // executor, which is a long time for a feature to be broken
          // quietly. The cache belongs beside the runtime it is building.
          HOME: root,
          npm_config_cache: path.join(root, ".npm-cache"),
        },
      );
      if (!installed.ok) {
        return fail(summarizeInstallFailure("npm install", installed.out));
      }
      built.npm = spec.npm;
      log.push(`runtime ${fp}: installed ${spec.npm.join(", ")}`);
    }
  }

  // Checked before it is marked ready, by the same test every later hit will
  // apply: an installer that exits 0 without installing what was asked (it
  // has happened, with npm and a cache it could not write) is caught here,
  // where the log still has the build beside it.
  if (held) heartbeat(shared, held);
  const problem = checkEntry(root, spec);
  if (problem) return fail(`runtime ${fp}: built but ${problem}`);

  // A build that lost its claim — it went quiet past the timeout and another
  // step took the entry over — must not mark ready what the new holder may
  // be clearing out beneath it — nor use it, for the same reason.
  if (held && !ownsBuild(shared, held)) {
    return fail(`runtime ${fp}: the build was taken over by another step as abandoned (over ${Math.round(buildTimeoutMs() / 1000)}s without a sign of life); run the step again`);
  }
  fs.writeFileSync(ready, JSON.stringify(built));
  const wired = wire(root, spec, "");
  Object.assign(interpreters, wired.interpreters);
  Object.assign(env, wired.env);
  if (held) {
    const pruned = pruneRuntimes(cacheRoot, fp);
    if (pruned.length) log.push(`runtime: pruned ${pruned.length} entr${pruned.length === 1 ? "y" : "ies"} unused for ${maxAgeDays()} days`);
  }
  succeeded = true;
  return { interpreters, env, log, error: null, ...(privateRoot ? { dispose: disposePrivate } : {}) };
  } catch (err) {
    failure = err instanceof Error ? err.message : String(err);
    throw err;
  } finally {
    // Whatever happened — built, failed, threw — the claim is released, and
    // only if it is still ours. A failed build leaves no `.ready`, so the
    // next step retries it rather than inheriting a half-built environment;
    // it leaves `.failed`, so the steps waiting on it stop waiting now. A
    // failed private build is removed here: nothing will ever use it.
    if (held) {
      if (!succeeded && ownsBuild(shared, held)) {
        try {
          fs.writeFileSync(path.join(shared, ".failed"), JSON.stringify({ error: failure, at: new Date().toISOString() }));
        } catch {
          // best effort — a waiter without it waits the timeout, as before
        }
      }
      releaseBuild(shared, held);
    }
    if (!succeeded) disposePrivate();
  }
}

function hasCommand(cmd: string, cwd: string): boolean {
  return run(cmd, ["--version"], cwd, 30_000).ok;
}

/** Mark an entry used now; the clock pruneRuntimes reads. Best effort — a
 *  read-only cache mount is still a perfectly good cache. */
function touch(file: string): void {
  try {
    const now = new Date();
    fs.utimesSync(file, now, now);
  } catch {
    // read-only or gone; neither is a reason to fail the step
  }
}

// ---------- installing mid-step ----------

/** Where the root start-up's install helper listens, inside a run container. */
export const INSTALL_SOCKET = "/opt/runner/job/install.sock";

/**
 * What a step installs for itself mid-run (the `install` tool) lands under
 * one per-step directory: pip packages in `<dir>/py` (`uv pip install
 * --target`), npm packages in `<dir>/npm` (`npm install --prefix`). Both are
 * on the step's paths from its first turn, so a tool installed by one call is
 * found by the next — `ffmpeg`, `import manim`, `require("sharp")`. Inside a
 * run container the directory is the container's own filesystem and goes
 * when the container does.
 */
export function stepInstallEnv(dir: string, base: Record<string, string | undefined>): Record<string, string> {
  return {
    // After whatever is already there: a declared environment keeps winning.
    PATH: [base.PATH ?? "", path.join(dir, "py", "bin"), path.join(dir, "npm", "node_modules", ".bin")].filter(Boolean).join(path.delimiter),
    PYTHONPATH: [base.PYTHONPATH ?? "", path.join(dir, "py")].filter(Boolean).join(path.delimiter),
    NODE_PATH: [base.NODE_PATH ?? "", path.join(dir, "npm", "node_modules")].filter(Boolean).join(path.delimiter),
  };
}
