// Script runtimes and their dependencies.
//
// An agent (or its workspace) declares what its scripts need:
//
//   runtime:
//     python: "3.12"           # optional pin; the host interpreter is used
//     packages: [pandas, requests]
//     node: true
//     npm: [lodash]
//
// The platform builds that environment once, keyed by a fingerprint of the
// declaration, and reuses it for every later run. Python gets a venv; Node
// gets an npm prefix exposed through NODE_PATH. Nothing is installed into
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
  const wantsSomething =
    spec.python !== undefined || spec.node !== undefined || spec.packages.length || spec.npm.length;
  return wantsSomething ? spec : null;
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
function run(cmd: string, args: string[], cwd: string, timeoutMs = 300_000) {
  const res = spawnSync(cmd, args, { cwd, timeout: timeoutMs, encoding: "utf8" });
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
  if (wantsPython(spec) && fs.existsSync(venvPython)) {
    interpreters[".py"] = venvPython;
    env.VIRTUAL_ENV = path.join(root, "venv");
  }
  if (wantsNode(spec) && fs.existsSync(nodeModules)) env.NODE_PATH = nodeModules;
  return { interpreters, env, log: [note], error: null };
}

const wantsPython = (s: RuntimeSpec) => s.python !== undefined || s.packages.length > 0;
const wantsNode = (s: RuntimeSpec) => s.node !== undefined || s.npm.length > 0;

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
function claimBuild(root: string): boolean {
  const lock = path.join(root, ".building");
  try {
    fs.mkdirSync(lock);
    return true;
  } catch {
    // Held — unless whoever held it died. A crashed build leaves the marker
    // behind forever, and without this every later step would wait the full
    // timeout and then build privately, permanently.
    try {
      if (Date.now() - fs.statSync(lock).mtimeMs > buildTimeoutMs()) {
        fs.rmSync(lock, { recursive: true, force: true });
        fs.mkdirSync(lock);
        return true;
      }
    } catch {
      // Someone else won the steal. Wait for them like any other holder.
    }
    return false;
  }
}

/** Wait for another process's build, up to the point where it is abandoned. */
function awaitReady(ready: string): boolean {
  const until = Date.now() + buildTimeoutMs();
  while (Date.now() < until) {
    if (fs.existsSync(ready)) return true;
    sleepSync(250);
  }
  return false;
}

// Build (or reuse) the environment for one runtime declaration.
export function prepareRuntime(tenant: string, spec: RuntimeSpec | null): PreparedRuntime {
  if (!spec) return EMPTY;

  const fp = fingerprint(spec);
  const shared = path.join(dataRoot(), tenant, ".runtimes", fp);
  // Loud, and before anything else: a dropped requirement surfaces later as
  // an import error inside a script, which points at the wrong thing entirely.
  const dropped = spec.rejected?.length
    ? [`runtime ${fp}: ignored invalid requirement(s): ${spec.rejected.join(", ")}`]
    : [];

  // Already built: wire it up and skip the install. The whole point of the
  // cache — on the hosted path this directory is a mounted volume, so the
  // hit rate across a run is close to one.
  if (fs.existsSync(path.join(shared, ".ready"))) {
    const hit = wire(shared, spec, `runtime ${fp}: cached`);
    return { ...hit, log: [...dropped, ...hit.log] };
  }

  fs.mkdirSync(shared, { recursive: true });

  let root = shared;
  const held = claimBuild(shared);
  if (!held) {
    // A concurrent step is building exactly this. Waiting for it beats
    // duplicating it — the work is identical and it is already underway.
    if (awaitReady(path.join(shared, ".ready"))) {
      const hit = wire(shared, spec, `runtime ${fp}: cached (built by a concurrent step)`);
      return { ...hit, log: [...dropped, ...hit.log] };
    }
    // It never finished. Build privately instead: slower and uncached, but a
    // step that runs is worth more than a cache entry, and a wedged lock must
    // never be able to stop work. In the tmpdir, not the cache — a private
    // build is by definition not worth keeping, and leaving these beside the
    // real entries would grow a directory nothing ever prunes.
    root = fs.mkdtempSync(path.join(os.tmpdir(), `foldrun-runtime-${fp}-`));
  }

  const ready = path.join(root, ".ready");
  const interpreters: Record<string, string> = {};
  const env: Record<string, string> = {};
  const log: string[] = [...dropped];

  const venvPython = path.join(root, "venv", "bin", "python");
  const nodeModules = path.join(root, "node_modules");
  const wantsPy = wantsPython(spec);
  const wantsNd = wantsNode(spec);

  try {

  if (wantsPy) {
    const base = typeof spec.python === "string" ? `python${spec.python}` : "python3";
    const exe = [base, "python3"].find((c) => run("command", ["-v", c], root).ok || run(c, ["--version"], root).ok);
    if (!exe) {
      return { ...EMPTY, error: `python interpreter "${base}" is not available on this host` };
    }
    // A sealed venv, never --system-site-packages. Inheriting the image's
    // packages would make a warm start cheaper, and it was measured on the
    // production box on 2026-08-29: a venv that shadows a baked `pandas` with
    // a pinned one keeps the *system* numpy underneath it, and the two are not
    // ABI-compatible — `pandas<2` on top of numpy 2 dies at import with
    // "numpy.dtype size changed". A pin that silently produces a broken
    // interpreter is worse than any install it saves.
    const made = run(exe, ["-m", "venv", path.join(root, "venv")], root);
    if (!made.ok) return { ...EMPTY, error: `failed to create venv: ${made.out.slice(0, 300)}` };
    log.push(`runtime ${fp}: created venv (${exe})`);

    if (spec.packages.length) {
      const pip = path.join(root, "venv", "bin", "pip");
      const installed = run(pip, ["install", "--disable-pip-version-check", "-q", ...spec.packages], root);
      if (!installed.ok) {
        return { ...EMPTY, error: `pip install failed: ${installed.out.slice(-500)}` };
      }
      log.push(`runtime ${fp}: installed ${spec.packages.join(", ")}`);
    }
    interpreters[".py"] = venvPython;
    env.VIRTUAL_ENV = path.join(root, "venv");
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
      const installed = run("npm", ["install", "--no-fund", "--no-audit", "--no-progress", ...spec.npm], root);
      if (!installed.ok) {
        return { ...EMPTY, error: `npm install failed: ${installed.out.slice(-500)}` };
      }
      log.push(`runtime ${fp}: installed ${spec.npm.join(", ")}`);
    }
    if (fs.existsSync(nodeModules)) env.NODE_PATH = nodeModules;
  }

  fs.writeFileSync(ready, new Date().toISOString());
  return { interpreters, env, log, error: null };
  } finally {
    // Whatever happened — built, failed, threw — the claim is released. A
    // failed build leaves no `.ready`, so the next step retries it rather
    // than inheriting a half-built environment.
    if (held) fs.rmSync(path.join(shared, ".building"), { recursive: true, force: true });
  }
}
