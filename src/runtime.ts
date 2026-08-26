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

// Build (or reuse) the environment for one runtime declaration.
export function prepareRuntime(tenant: string, spec: RuntimeSpec | null): PreparedRuntime {
  if (!spec) return EMPTY;

  const fp = fingerprint(spec);
  const root = path.join(dataRoot(), tenant, ".runtimes", fp);
  const ready = path.join(root, ".ready");
  const interpreters: Record<string, string> = {};
  const env: Record<string, string> = {};
  const log: string[] = [];

  const venvPython = path.join(root, "venv", "bin", "python");
  const nodeModules = path.join(root, "node_modules");
  const wantsPython = spec.python !== undefined || spec.packages.length > 0;
  const wantsNode = spec.node !== undefined || spec.npm.length > 0;

  // Already built: wire it up and skip the install.
  if (fs.existsSync(ready)) {
    if (wantsPython && fs.existsSync(venvPython)) {
      interpreters[".py"] = venvPython;
      env.VIRTUAL_ENV = path.join(root, "venv");
    }
    if (wantsNode && fs.existsSync(nodeModules)) env.NODE_PATH = nodeModules;
    return { interpreters, env, log: [`runtime ${fp}: cached`], error: null };
  }

  fs.mkdirSync(root, { recursive: true });

  if (wantsPython) {
    const base = typeof spec.python === "string" ? `python${spec.python}` : "python3";
    const exe = [base, "python3"].find((c) => run("command", ["-v", c], root).ok || run(c, ["--version"], root).ok);
    if (!exe) {
      return { ...EMPTY, error: `python interpreter "${base}" is not available on this host` };
    }
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

  if (wantsNode) {
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
}
