// Scripts declared as tools. An agent that writes
//
//   scripts:
//     - name: ads_summary
//       run: scripts/summary.py
//       description: Pull campaign performance for the account.
//       args:
//         customer_id: The Google Ads customer id
//
// gets a real tool called `ads_summary(customer_id)` — no bash needed. The
// platform spawns the script with the declared args as CLI flags, injects the
// agent's secrets as environment variables, and returns stdout.
//
// This is safer than granting `bash`: the agent can only run the scripts you
// declared, with the arguments you declared, and never composes a shell line.

import path from "node:path";
import fs from "node:fs";
import { spawn } from "node:child_process";
import { z } from "zod";
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { runInContainer } from "./container.ts";

const TIMEOUT_MS = 120_000;
const timeoutFor = (spec: ScriptSpec) => (spec.timeout ? spec.timeout * 1000 : TIMEOUT_MS);
const MAX_OUTPUT = 20_000;

export interface ScriptSpec {
  name: string;
  /** Path relative to the agent dir — or empty when `code` carries the
   *  script inline. Exactly one of the two is the program. */
  run: string;
  description: string;
  args: Record<string, string>; // arg name → description
  interpreter?: string; // optional override, e.g. "python3", "bash"
  /** Seconds this script may run — for the crawl that legitimately takes
   *  five minutes. Defaults to 120, capped at 600: a limit an author can
   *  raise is a budget; one they can remove is a hang. */
  timeout?: number;
  /** The script itself, when the tool is a single markdown file with its
   *  code in a fenced block. Materialised to a file at call time — the
   *  execution path is the same either way, only where the bytes start
   *  differs. */
  code?: string;
  /** Extension for the materialised file, from the fence's language tag —
   *  it picks the interpreter the same way a run: path's extension does. */
  codeExt?: string;
}

export function parseScripts(raw: unknown): ScriptSpec[] {
  if (!Array.isArray(raw)) return [];
  const out: ScriptSpec[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    const name = typeof e.name === "string" ? e.name : null;
    const run = typeof e.run === "string" ? e.run : null;
    const code = typeof e.code === "string" ? e.code : null;
    if (!name || (!run && !code)) continue;
    const args: Record<string, string> = {};
    if (e.args && typeof e.args === "object" && !Array.isArray(e.args)) {
      for (const [k, v] of Object.entries(e.args as Record<string, unknown>)) {
        if (/^[a-z][a-z0-9_]*$/i.test(k)) args[k] = String(v);
      }
    }
    const timeout = Number(e.timeout);
    out.push({
      name: name.replace(/[^a-zA-Z0-9_]/g, "_"),
      run: run ?? "",
      ...(code ? { code, codeExt: typeof e.codeExt === "string" ? e.codeExt : ".mjs" } : {}),
      description: typeof e.description === "string" ? e.description : "",
      args,
      interpreter: typeof e.interpreter === "string" ? e.interpreter : undefined,
      timeout: Number.isFinite(timeout) && timeout > 0 ? Math.min(timeout, 600) : undefined,
    });
  }
  return out;
}

// Pick how to execute a file when no interpreter is declared.
function commandFor(
  spec: ScriptSpec,
  abs: string,
  overrides: Record<string, string> = {},
): { cmd: string; args: string[] } {
  if (spec.interpreter) return { cmd: spec.interpreter, args: [abs] };
  const ext = path.extname(abs).toLowerCase();
  // A prepared runtime (venv, npm prefix) wins over the host interpreter.
  if (overrides[ext]) return { cmd: overrides[ext], args: [abs] };
  const byExt: Record<string, string> = {
    ".py": "python3",
    ".sh": "bash",
    ".js": "node",
    ".mjs": "node",
    ".ts": "node",
    ".rb": "ruby",
  };
  const interp = byExt[ext];
  return interp ? { cmd: interp, args: [abs] } : { cmd: abs, args: [] };
}

// Inside the image the interpreter is the distro's, not a host venv path.
function containerInterpreter(abs: string): string {
  const byExt: Record<string, string> = {
    ".py": "python3",
    ".sh": "bash",
    ".js": "node",
    ".mjs": "node",
    ".ts": "node",
    ".rb": "ruby",
  };
  return byExt[path.extname(abs).toLowerCase()] ?? abs;
}

function runScript(
  cwd: string,
  spec: ScriptSpec,
  values: Record<string, string>,
  env: Record<string, string>,
  libraryScripts: string,
  interpreters: Record<string, string>,
  exec: ExecutionContext | null,
): Promise<{ code: number | null; out: string }> {
  // An inline-code tool has no file yet: write it inside the agent's own
  // directory — already an allowed root — and run it like any other script.
  // Materialised per call rather than per build, so an edit to the tool's
  // markdown is live on the next call with nothing to clean up but one file.
  if (!spec.run && spec.code) {
    const dir = path.join(cwd, ".tool-code");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${spec.name}${spec.codeExt ?? ".mjs"}`);
    fs.writeFileSync(file, spec.code, { mode: 0o755 });
    spec = { ...spec, run: `.tool-code/${spec.name}${spec.codeExt ?? ".mjs"}` };
  }

  return new Promise((resolve) => {
    // Confine to the agent's own directory plus the workspace it belongs to.
    // The workspace root is allowed because `shared/` resolves to
    // <workspace>/scripts — a virtual prefix expanded at resolve time, not a
    // symlink on disk. (Symlinking it was tried and reverted: the link
    // recursed into the workspace's own file listing.)
    const abs = resolveRunPath(cwd, spec.run, libraryScripts);
    const workspaceRoot = path.resolve(cwd, "..", "..");
    // The library's tools/ as well as its scripts/: a folder tool installed at
    // the account keeps its code beside its definition, which is one directory
    // over from where shared scripts live. Without it the containment check
    // refuses an account tool the resolver just found.
    const libraryTools = libraryScripts ? path.resolve(libraryScripts, "..", "tools") : "";
    const allowedRoots = [path.resolve(cwd), workspaceRoot, libraryScripts, libraryTools]
      .filter(Boolean)
      .map((p) => {
      try {
        return fs.realpathSync(p);
      } catch {
        return p;
      }
    });
    let real: string;
    try {
      real = fs.realpathSync(abs);
    } catch {
      return resolve({ code: null, out: `script not found: ${spec.run}` });
    }
    // Containment, not a string prefix. `startsWith` called
    // `<workspace>-attacker/steal.py` a path inside `<workspace>`, because it
    // is — as text. The question is whether one path is under another, and
    // only path.relative answers that.
    const within = (root: string) => {
      const rel = path.relative(root, real);
      return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
    };
    if (!allowedRoots.some(within)) {
      return resolve({ code: null, out: `script path escapes the workspace: ${spec.run}` });
    }

    const { cmd, args } = commandFor(spec, abs, interpreters);
    // Declared args become long flags: --customer_id 123
    for (const key of Object.keys(spec.args)) {
      if (values[key] !== undefined && values[key] !== "") {
        args.push(`--${key}`, values[key]);
      }
    }

    // Container path: same command, executed inside an isolated container
    // with only the agent's directory (plus declared shared dirs) mounted.
    if (exec && exec.executor === "docker") {
      const inContainer = (p: string) => {
        if (p.startsWith(path.resolve(cwd))) return p.replace(path.resolve(cwd), "/workspace");
        for (const [host, mount] of Object.entries(exec.mounts)) {
          if (p.startsWith(host)) return p.replace(host, mount);
        }
        return p;
      };
      const argv = [
        // The interpreter inside the image, not the host's venv path.
        spec.interpreter ?? containerInterpreter(abs),
        ...args.map(inContainer),
      ].filter(Boolean) as string[];
      // Drop the host interpreter that commandFor prepended, if any.
      if (argv[1] === argv[0]) argv.splice(1, 1);
      runInContainer({
        agentDir: path.resolve(cwd),
        readOnly: exec.mounts,
        image: exec.image,
        argv,
        env,
        timeoutMs: timeoutFor(spec),
        network: exec.network,
        maxOutput: MAX_OUTPUT,
      }).then(resolve, (err) =>
        resolve({ code: null, out: `container error: ${err instanceof Error ? err.message : String(err)}` }),
      );
      return;
    }

    const child = spawn(cmd, args, {
      cwd,
      env: { ...process.env, ...env },
      timeout: timeoutFor(spec),
    });
    let out = "";
    const append = (chunk: Buffer) => {
      if (out.length < MAX_OUTPUT) out += chunk.toString();
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    child.on("error", (err) => resolve({ code: null, out: `failed to start: ${err.message}` }));
    child.on("close", (code) =>
      resolve({
        code,
        out:
          out.length > MAX_OUTPUT
            ? `${out.slice(0, MAX_OUTPUT)}\n…[truncated]`
            : out || "(no output)",
      }),
    );
  });
}

export interface ExecutionContext {
  /** "docker" runs each script in a container; "host" spawns it directly. */
  executor: "docker" | "host";
  image: string;
  /** Extra read-only mounts for shared/library scripts. */
  mounts: Record<string, string>;
  /** Whether scripts may reach the network. */
  network: boolean;
}

export interface ScriptToolResult {
  server: ReturnType<typeof createSdkMcpServer> | null;
  toolNames: string[];
  promptLines: string[];
  drainLog: () => string[];
}

// `run:` accepts:
//   scripts/x.py              this agent's own script
//   workspace/tools/<t>/x.py  a folder tool's own code, in this workspace
//   account/tools/<t>/x.py    a folder tool's own code, in the library
//   shared/x.py               the workspace's scripts/
//   library/x.py              the workspace library's scripts/
//
// The tools/ forms are written by readToolDir rather than by hand: a folder
// tool's definition says `run: run.mjs` and never names its own scope, which
// is what lets the same folder be copied into a workspace or installed at the
// account without an edit.
export function resolveRunPath(agentDir: string, run: string, libraryScripts: string): string {
  const workspaceRoot = path.resolve(agentDir, "..", "..");
  // The library's tools/ sits beside its scripts/ — one mount, two shelves.
  const libraryRoot = path.resolve(libraryScripts, "..");

  if (run.startsWith("workspace/tools/")) {
    return path.resolve(workspaceRoot, "tools", run.slice("workspace/tools/".length));
  }
  if (run.startsWith("account/tools/")) {
    return path.resolve(libraryRoot, "tools", run.slice("account/tools/".length));
  }
  // Canonical prefixes, then the legacy spellings they replaced.
  for (const p of ["workspace/scripts/", "shared/"]) {
    if (run.startsWith(p)) {
      return path.resolve(workspaceRoot, "scripts", run.slice(p.length));
    }
  }
  for (const p of ["account/scripts/", "library/"]) {
    if (run.startsWith(p)) return path.resolve(libraryScripts, run.slice(p.length));
  }
  return path.resolve(agentDir, run);
}

export function buildScriptTools(
  agentDir: string,
  scripts: ScriptSpec[],
  env: Record<string, string>,
  libraryScripts = "",
  interpreters: Record<string, string> = {},
  exec: ExecutionContext | null = null,
): ScriptToolResult {
  if (scripts.length === 0) {
    return { server: null, toolNames: [], promptLines: [], drainLog: () => [] };
  }
  const log: string[] = [];

  const tools = scripts.map((spec) => {
    const shape: Record<string, z.ZodTypeAny> = {};
    for (const [arg, desc] of Object.entries(spec.args)) {
      shape[arg] = z.string().optional().describe(desc);
    }
    return tool(
      spec.name,
      `${spec.description || `Run ${spec.run}.`} Runs the workspace script ${spec.run}; returns its output. ` +
        `Credentials it needs are already in its environment.`,
      shape,
      async (args) => {
        const started = Date.now();
        const values = Object.fromEntries(
          Object.entries(args ?? {}).map(([k, v]) => [k, v === undefined ? "" : String(v)]),
        );
        const { code, out } = await runScript(agentDir, spec, values, env, libraryScripts, interpreters, exec);
        log.push(
          `${spec.name} (${spec.run}) → exit ${code ?? "error"} ` +
            `(${Date.now() - started}ms, ${exec?.executor ?? "host"})`,
        );
        return {
          content: [{ type: "text" as const, text: `exit ${code ?? "error"}\n\n${out}` }],
          isError: code !== 0,
        };
      },
    );
  });

  return {
    server: createSdkMcpServer({ name: "foldrun_scripts", version: "1.0.0", tools }),
    toolNames: scripts.map((s) => `mcp__foldrun_scripts__${s.name}`),
    promptLines: scripts.map(
      (s) =>
        `- **${s.name}** — ${s.description || `runs ${s.run}`}${
          Object.keys(s.args).length ? ` Arguments: ${Object.keys(s.args).join(", ")}.` : ""
        }`,
    ),
    drainLog: () => log.splice(0, log.length),
  };
}
