// Call a tool once, now, and say what happened.
//
// Without this, the first time anyone finds out a tool is misconfigured is
// mid-flow, inside an agent's turn, as a tool error the model paraphrases into
// something vague. A wrong `base:`, a secret that was never set, a script path
// with a typo — all of them look identical from the outside: the agent just
// doesn't use the tool and says something plausible instead.
//
// So each transport gets a real exercise, not a syntax check:
//
//   http    an actual request to the declared base URL
//   script  actually runs it, with the workspace's secrets in the environment
//   mcp     actually starts the server and completes an MCP handshake
//
// Nothing here returns a secret value. Missing secrets are reported by *name*,
// because "which one didn't you set" is the useful half and the value is not.

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { resolveSecrets } from "./secrets.ts";
import { workspaceDir, type ToolDef } from "./store.ts";
import { libraryDir } from "./library.ts";
import { secretsUsedByApi } from "./api-tools.ts";
import { resolveRunPath } from "./script-tools.ts";

export interface ToolTestResult {
  ok: boolean;
  transport: "http" | "script" | "mcp";
  /** One line, safe to show next to the button. */
  summary: string;
  /** The response body, stdout, or the server's tool list. Truncated. */
  detail: string;
  ms: number;
  /** Names only — never values. */
  missingSecrets: string[];
}

const MAX_DETAIL = 4000;
const TIMEOUT_MS = 15_000;

const clip = (s: string) =>
  s.length > MAX_DETAIL ? `${s.slice(0, MAX_DETAIL)}\n… truncated` : s;

/** `${NAME}` → value, for headers and query. Same rule the runtime uses. */
const substitute = (v: string, env: Record<string, string>) =>
  v.replace(/\$\{([A-Z0-9_]+)\}/g, (_, k) => env[k] ?? "");

export interface ToolTestInput {
  /** http: the path to try, appended to `base:`. */
  path?: string;
  /** script: values for the tool's declared `args:`. */
  args?: Record<string, string>;
}

export async function testTool(
  tenant: string,
  workspace: string,
  def: ToolDef,
  input: ToolTestInput = {},
): Promise<ToolTestResult> {
  const probePath = input.path ?? "";
  const started = Date.now();
  const done = (r: Omit<ToolTestResult, "ms">): ToolTestResult => ({ ...r, ms: Date.now() - started });

  if (def.kind === "http") {
    const api = def.spec;
    const needed = secretsUsedByApi(api);
    const { env, missing } = resolveSecrets(tenant, needed, workspace);

    try {
      const rel = probePath.startsWith("/") || probePath === "" ? probePath : `/${probePath}`;
      const url = new URL(api.base + rel);
      // Same confinement the agent gets: a probe can't reach another host.
      if (!url.href.startsWith(api.base)) {
        return done({
          ok: false, transport: "http", missingSecrets: missing,
          summary: "that path escapes the declared base URL",
          detail: `base: ${api.base}\npath: ${probePath}`,
        });
      }
      for (const [k, v] of Object.entries(api.query)) url.searchParams.set(k, substitute(v, env));

      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(api.headers)) headers[k] = substitute(v, env);

      const method = api.methods.includes("GET") ? "GET" : api.methods[0];
      const res = await fetch(url, {
        method,
        headers,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      const body = await res.text();

      // An unset secret means the tool cannot authenticate, so it is not
      // working — whatever a permissive endpoint chose to return. Reporting
      // ok on a request that went out with no credentials is how you ship a
      // tool that 401s the first time it meets the real API.
      return done({
        ok: res.ok && missing.length === 0,
        transport: "http",
        missingSecrets: missing,
        summary:
          missing.length > 0
            ? `${method} ${url.pathname} → ${res.status}, but sent without ${missing.join(", ")}`
            : `${method} ${url.pathname} → ${res.status} ${res.statusText}`,
        detail: clip(body),
      });
    } catch (err) {
      return done({
        ok: false, transport: "http", missingSecrets: missing,
        summary: err instanceof Error ? err.message : String(err),
        // A missing secret usually surfaces as a 401 rather than an error, so
        // say it here too — it is the likeliest cause of both.
        detail: missing.length ? `unset secrets: ${missing.join(", ")}` : "",
      });
    }
  }

  if (def.kind === "script") {
    const run = String(def.spec.run ?? "");
    // Tools are workspace- or account-scoped, so resolve as if from an agent
    // directory one level down — the same base the runtime uses.
    const dir = workspaceDir(tenant, workspace);
    const file = resolveRunPath(path.join(dir, "agents", "_probe"), run, libraryDir(tenant, "scripts"));

    if (!fs.existsSync(file)) {
      return done({
        ok: false, transport: "script", missingSecrets: [],
        summary: `no such script: ${run}`,
        detail: `looked for ${file}\n\nThis is the commonest way to get a tool that silently never loads.`,
      });
    }

    const names = Array.isArray(def.spec.secrets) ? def.spec.secrets.map(String) : [];
    const { env, missing } = resolveSecrets(tenant, names, workspace);
    const interpreter =
      typeof def.spec.interpreter === "string"
        ? def.spec.interpreter
        : file.endsWith(".py") ? "python3"
        : file.endsWith(".sh") ? "bash"
        : file.endsWith(".js") ? "node"
        : null;

    // Declared args become long flags, exactly as the runtime passes them.
    const declared = def.spec.args && typeof def.spec.args === "object"
      ? Object.keys(def.spec.args as Record<string, unknown>)
      : [];
    const flags: string[] = [];
    for (const [k, v] of Object.entries(input.args ?? {})) {
      if (v !== "" && /^[a-z][a-z0-9_]*$/i.test(k)) flags.push(`--${k}`, v);
    }

    const { code, out } = await runOnce(
      interpreter ?? file,
      interpreter ? [file, ...flags] : flags,
      dir,
      { ...process.env, ...env },
    );

    // A script that needs arguments and got none has not failed — it has not
    // been tested. Saying "exited 2" would send someone looking for a bug.
    const untested = code !== 0 && declared.length > 0 && flags.length === 0;

    return done({
      ok: code === 0,
      transport: "script",
      missingSecrets: missing,
      summary: untested
        ? `needs ${declared.map((a) => `--${a}`).join(", ")} — fill them in and test again`
        : code === 0 ? "exited 0" : `exited ${code ?? "with an error"}`,
      detail: clip(out || "(no output)"),
    });
  }

  // ---- mcp: start the server and complete a handshake ----
  const spec = def.spec;
  if (spec.url) {
    // A remote server: the honest check we can make without a full client is
    // that the endpoint answers.
    try {
      const res = await fetch(spec.url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
      return done({
        ok: res.ok,
        transport: "mcp",
        missingSecrets: [],
        summary: `${spec.url} → ${res.status} ${res.statusText}`,
        detail: "Endpoint reachable. This does not verify the MCP handshake — only a local (command) server is started and spoken to.",
      });
    } catch (err) {
      return done({
        ok: false, transport: "mcp", missingSecrets: [],
        summary: err instanceof Error ? err.message : String(err),
        detail: "",
      });
    }
  }

  if (!spec.command) {
    return done({
      ok: false, transport: "mcp", missingSecrets: [],
      summary: "no command: or url: — this tool cannot load",
      detail: "",
    });
  }

  const named = Object.entries(spec.env ?? {})
    .map(([, v]) => String(v).match(/^\$\{([A-Z0-9_]+)\}$/)?.[1])
    .filter((n): n is string => Boolean(n));
  const { env, missing } = resolveSecrets(tenant, named, workspace);
  const childEnv: NodeJS.ProcessEnv = { ...process.env };
  for (const [k, v] of Object.entries(spec.env ?? {})) childEnv[k] = substitute(String(v), env);

  const handshake = await mcpHandshake(spec.command, spec.args ?? [], childEnv);
  return done({
    ok: handshake.ok,
    transport: "mcp",
    missingSecrets: missing,
    summary: handshake.summary,
    detail: clip(handshake.detail),
  });
}

/** Run a command to completion, capturing both streams together. */
function runOnce(
  cmd: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    let out = "";
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(cmd, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    } catch (err) {
      resolve({ code: null, out: err instanceof Error ? err.message : String(err) });
      return;
    }
    const timer = setTimeout(() => child.kill("SIGKILL"), TIMEOUT_MS);
    child.stdout?.on("data", (d) => (out += d));
    child.stderr?.on("data", (d) => (out += d));
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ code: null, out: `${out}${err.message}` });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, out });
    });
  });
}

/**
 * Start a stdio MCP server and complete `initialize` + `tools/list`.
 *
 * This is the whole point of testing an MCP tool: "the binary exists" tells you
 * nothing, and the failure people actually hit is a server that starts and then
 * exposes nothing useful.
 */
function mcpHandshake(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<{ ok: boolean; summary: string; detail: string }> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, args, { env, stdio: ["pipe", "pipe", "pipe"] });
    } catch (err) {
      resolve({ ok: false, summary: `could not start ${command}`, detail: String(err), });
      return;
    }

    let buf = "";
    let stderr = "";
    let settled = false;
    const finish = (r: { ok: boolean; summary: string; detail: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill("SIGKILL");
      resolve(r);
    };

    const timer = setTimeout(
      () => finish({
        ok: false,
        summary: "the server did not answer in time",
        detail: stderr || "No response to initialize within 15s.",
      }),
      TIMEOUT_MS,
    );

    const send = (msg: unknown) => child.stdin?.write(`${JSON.stringify(msg)}\n`);

    child.on("error", (err) =>
      finish({ ok: false, summary: `could not start ${command}`, detail: err.message }));
    child.stderr?.on("data", (d) => (stderr += d));

    child.stdout?.on("data", (d) => {
      buf += d;
      // One JSON-RPC message per line.
      for (const line of buf.split("\n").slice(0, -1)) {
        if (!line.trim()) continue;
        let msg: { id?: number; result?: { tools?: { name: string }[] }; error?: { message?: string } };
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg.error) {
          finish({ ok: false, summary: msg.error.message ?? "the server returned an error", detail: line });
          return;
        }
        if (msg.id === 1) {
          send({ jsonrpc: "2.0", method: "notifications/initialized" });
          send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
        } else if (msg.id === 2) {
          const tools = msg.result?.tools ?? [];
          finish({
            ok: true,
            summary: `connected — ${tools.length} tool${tools.length === 1 ? "" : "s"}`,
            detail: tools.map((t) => `• ${t.name}`).join("\n") || "The server exposes no tools.",
          });
          return;
        }
      }
      buf = buf.slice(buf.lastIndexOf("\n") + 1);
    });

    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "mdagent-tool-test", version: "0.1.0" },
      },
    });
  });
}
