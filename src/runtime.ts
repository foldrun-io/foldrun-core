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
}

export function parseRuntime(raw: unknown): RuntimeSpec | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const e = raw as Record<string, unknown>;
  const list = (v: unknown) =>
    Array.isArray(v) ? v.map(String).filter((s) => /^[\w.@/-]+([<>=!~][\w.*]+)?$/.test(s)) : [];
  const spec: RuntimeSpec = {
    python: typeof e.python === "string" || typeof e.python === "boolean" ? e.python : undefined,
    packages: list(e.packages ?? e.pip),
    node: typeof e.node === "string" || typeof e.node === "boolean" ? e.node : undefined,
    npm: list(e.npm),
  };
  const wantsSomething =
    spec.python !== undefined || spec.node !== undefined || spec.packages.length || spec.npm.length;
  return wantsSomething ? spec : null;
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

function run(cmd: string, args: string[], cwd: string, timeoutMs = 300_000) {
  const res = spawnSync(cmd, args, { cwd, timeout: timeoutMs, encoding: "utf8" });
  const out = `${res.stdout ?? ""}${res.stderr ?? ""}`.trim();
  return { ok: res.status === 0, out };
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

  // Already built: wire it up and skip the install. The whole point of the
  // cache — on the hosted path this directory is a mounted volume, so the
  // hit rate across a run is close to one.
  if (fs.existsSync(path.join(shared, ".ready"))) return wire(shared, spec, `runtime ${fp}: cached`);

  fs.mkdirSync(shared, { recursive: true });

  let root = shared;
  const held = claimBuild(shared);
  if (!held) {
    // A concurrent step is building exactly this. Waiting for it beats
    // duplicating it — the work is identical and it is already underway.
    if (awaitReady(path.join(shared, ".ready"))) {
      return wire(shared, spec, `runtime ${fp}: cached (built by a concurrent step)`);
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
  const log: string[] = [];

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
      const installed = run("npm", ["install", "--no-fund", "--no-audit", "--silent", ...spec.npm], root);
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
