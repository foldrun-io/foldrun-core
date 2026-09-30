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
const PIP_REQUIREMENT = new RegExp(`^${PIP_NAME}(${PIP_SPECIFIER}(,${PIP_SPECIFIER})*)?$`);
/** npm's own shape: an optional @scope, then a name, then an optional @range. */
const NPM_REQUIREMENT =
  /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*(@[A-Za-z0-9._^~*>=< |-]+)?$/;

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
  if (rejected.length) spec.rejected = rejected;
  if (Array.isArray(e.ignored) && e.ignored.length) spec.ignored = e.ignored.map(String);
  return wantsPython(spec) || wantsNode(spec) ? spec : null;
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
export function prepareRuntime(tenant: string, spec: RuntimeSpec | null): PreparedRuntime {
  if (!spec) return EMPTY;

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
  const nodeModules = path.join(root, "node_modules");
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
        return fail(`${uv ? "uv pip" : "pip"} install failed: ${installed.out.slice(-500)}`);
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
        return fail(`npm install failed: ${installed.out.slice(-500)}`);
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
