// The `install` tool: an agent installs what it finds it needs, mid-step,
// without anyone having declared it. Built in and granted to every agent
// (take it away with `disallowedTools: [install]`).
//
//   install(manager: "apt",  packages: ["ffmpeg"])      — Debian programs and libraries
//   install(manager: "pip",  packages: ["manim>=0.19"]) — Python packages
//   install(manager: "npm",  packages: ["sharp"])       — Node packages
//
// apt needs root, which the agent never has: it asks the root start-up's
// install helper over a unix socket (install-helper.ts), which installs only
// validated names through the same cache and snapshots as `runtime: system:`.
// pip and npm need no root and run here, as the agent, into a per-step
// directory already on PATH / PYTHONPATH / NODE_PATH (stepInstallEnv), so the
// next command finds what this one installed. Inside a run container all of
// it goes when the container does. Every install is logged with the line to
// add to the agent's `runtime:` to have it before the step starts next time.

import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { DEB_PACKAGE, PIP_REQUIREMENT, NPM_REQUIREMENT, summarizeInstallFailure } from "./runtime.ts";

type Emit = (type: "text" | "tool" | "info" | "error", text: string) => void;

export const INSTALL_TOOL = "mcp__foldrun_install__install";

const PATTERNS = { apt: DEB_PACKAGE, pip: PIP_REQUIREMENT, npm: NPM_REQUIREMENT } as const;
const RUNTIME_KEY = { apt: "system", pip: "packages", npm: "npm" } as const;

function findUv(): string | null {
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (dir && fs.existsSync(path.join(dir, "uv"))) return path.join(dir, "uv");
  }
  return null;
}

/** Ask the root helper; resolves with its reply or an error. */
export function askHelper(socket: string, packages: string[], timeoutMs = 600_000): Promise<{ ok: boolean; mode?: string; seconds?: number; error?: string }> {
  return new Promise((resolve) => {
    const conn = net.createConnection(socket);
    let buf = "";
    const timer = setTimeout(() => {
      conn.destroy();
      resolve({ ok: false, error: `the install helper did not answer in ${Math.round(timeoutMs / 1000)}s` });
    }, timeoutMs);
    conn.on("connect", () => conn.write(JSON.stringify({ manager: "apt", packages }) + "\n"));
    conn.on("data", (c) => (buf += c.toString("utf8")));
    conn.on("end", () => {
      clearTimeout(timer);
      try {
        resolve(JSON.parse(buf.trim()));
      } catch {
        resolve({ ok: false, error: "the install helper sent no answer" });
      }
    });
    conn.on("error", (err) => {
      clearTimeout(timer);
      resolve({ ok: false, error: `the install helper is not reachable (${err.message})` });
    });
  });
}

export function buildInstallTool(opts: {
  /** The per-step directory pip and npm install into (stepInstallEnv's). */
  dir: string;
  /** The root helper's socket; null where there is none (a laptop). */
  socket: string | null;
  /** The account's runtime cache, for uv's and npm's download caches. */
  cacheRoot: string;
  /** The interpreter pip installs for: the declared venv's, else python3. */
  python: string;
  env: Record<string, string | undefined>;
  emit: Emit;
}) {
  const installed: string[] = [];
  const text = (t: string, isError = false) => ({ content: [{ type: "text" as const, text: t }], ...(isError ? { isError: true } : {}) });

  const install = tool(
    "install",
    "Install a program or library this step needs and does not have: Debian packages with manager \"apt\" (ffmpeg, imagemagick, tesseract-ocr, libcairo2-dev, build-essential), Python packages with \"pip\", Node packages with \"npm\". Use this instead of apt-get, pip or npm in Bash — you are not root and those would fail. What you install is usable by your next command (on PATH, importable) and lasts for this step. Name real packages only; versions as the manager writes them (\"pandas>=2\", \"sharp@^0.34\").",
    {
      manager: z.enum(["apt", "pip", "npm"]).describe("apt for Debian programs and system libraries, pip for Python, npm for Node"),
      packages: z.array(z.string()).min(1).max(30).describe("Package names, e.g. [\"ffmpeg\"] or [\"manim\", \"numpy<2\"]"),
    },
    async ({ manager, packages }) => {
      const names = packages.map((p) => String(p).trim()).filter(Boolean);
      const bad = names.filter((p) => !PATTERNS[manager].test(p));
      if (bad.length) return text(`Not ${manager} package names: ${bad.join(", ")}. Nothing was installed.`, true);
      const t0 = Date.now();
      let how = "";
      if (manager === "apt") {
        if (!opts.socket || !fs.existsSync(opts.socket)) {
          return text("Debian packages can only be installed inside a run container, and this step is not running in one. Nothing was installed.", true);
        }
        const r = await askHelper(opts.socket, names);
        if (!r.ok) {
          opts.emit("error", `install: apt ${names.join(" ")} — ${String(r.error).split("\n")[0]}`);
          return text(r.error ?? "apt failed", true);
        }
        how = `${r.mode ?? "apt"}, ${r.seconds ?? Math.round((Date.now() - t0) / 1000)}s`;
      } else if (manager === "pip") {
        const target = path.join(opts.dir, "py");
        fs.mkdirSync(target, { recursive: true });
        const uv = findUv();
        const res = uv
          ? spawnSync(uv, ["pip", "install", "-q", "--python", opts.python, "--target", target, ...names], {
              env: { ...opts.env, UV_CACHE_DIR: path.join(opts.cacheRoot, ".uv-cache"), UV_LINK_MODE: "copy", UV_NO_PROGRESS: "1" } as unknown as NodeJS.ProcessEnv,
              encoding: "utf8",
              timeout: 600_000,
            })
          : spawnSync(opts.python, ["-m", "pip", "install", "-q", "--disable-pip-version-check", "--target", target, ...names], {
              env: opts.env as unknown as NodeJS.ProcessEnv,
              encoding: "utf8",
              timeout: 600_000,
            });
        if (res.status !== 0) {
          const msg = summarizeInstallFailure(uv ? "uv pip install" : "pip install", `${res.stdout ?? ""}${res.stderr ?? ""}${res.error ? res.error.message : ""}`);
          opts.emit("error", `install: pip ${names.join(" ")} — ${msg.split("\n")[0]}`);
          return text(msg, true);
        }
        how = `pip, ${Math.round((Date.now() - t0) / 1000)}s`;
      } else {
        const prefix = path.join(opts.dir, "npm");
        fs.mkdirSync(prefix, { recursive: true });
        const res = spawnSync("npm", ["install", "--no-fund", "--no-audit", "--no-progress", "--prefix", prefix, ...names], {
          env: { ...opts.env, npm_config_cache: path.join(opts.cacheRoot, ".npm-cache") } as unknown as NodeJS.ProcessEnv,
          encoding: "utf8",
          timeout: 600_000,
        });
        if (res.status !== 0) {
          const msg = summarizeInstallFailure("npm install", `${res.stdout ?? ""}${res.stderr ?? ""}${res.error ? res.error.message : ""}`);
          opts.emit("error", `install: npm ${names.join(" ")} — ${msg.split("\n")[0]}`);
          return text(msg, true);
        }
        how = `npm, ${Math.round((Date.now() - t0) / 1000)}s`;
      }
      installed.push(...names.map((n) => `${manager}:${n}`));
      opts.emit("info", `install: ${manager} ${names.join(" ")} — ready (${how}). To have it before the step starts: runtime: ${RUNTIME_KEY[manager]}: [${names.join(", ")}]`);
      return text(`Installed ${names.join(", ")} (${manager}). Usable now in this step — run it or import it directly.`);
    },
  );

  return {
    server: createSdkMcpServer({ name: "foldrun_install", version: "1.0.0", tools: [install] }),
    toolName: INSTALL_TOOL,
    /** What this step installed, `manager:name`, for the run record. */
    installed: () => [...installed],
    /** The handler, for tests. */
    call: (args: { manager: "apt" | "pip" | "npm"; packages: string[] }) => install.handler(args, {}),
  };
}
