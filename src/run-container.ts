// Whole-step isolation: the model loop itself inside a container.
//
// container.ts isolates *declared script tools* — real code the author chose
// to ship. This isolates the rest: the agent's built-in Read/Write/Bash,
// which otherwise run in the server process behind path checks. Path checks
// are argument inspection; a container is an operating system saying no. The
// hosted platform runs every step this way (MDAGENT_RUN_ISOLATION=container);
// the CLI keeps the in-process path, because on a laptop the "server process"
// is the user's own shell and there is nothing to protect it from.
//
// Shape: copy the workspace in, run the driver, stream events out as JSONL,
// copy changes back through a filter. Copying, not mounting, for the same
// reasons as container.ts — and because the copy-out filter is where the
// spec's write rules become physics: whatever happened inside, knowledge/,
// secrets and run history cannot come back changed, because they are not
// copied back at all (secrets and runs/ were never copied in).
//
// The runner image bundles @mdagent/core itself, so the driver runs the same
// executeStep the server would — one implementation, two homes.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import type { McpServerConfig } from "@anthropic-ai/claude-agent-sdk";
import type { ApiSpec } from "./store.ts";
import type { ScriptSpec } from "./script-tools.ts";

/** What crosses the boundary. Everything in here is values — pre-resolved
 *  secrets in headers, assembled prompt, serializable MCP configs. */
export interface ContainerStepInput {
  agentRel: string; // "agents/<name>" inside the workspace
  prompt: string;
  model: string;
  systemPrompt: string;
  allowed: string[];
  mcpNames: string[];
  /** http/stdio configs only — in-process servers are rebuilt inside. */
  mcpServers: Record<string, McpServerConfig>;
  apis: ApiSpec[]; // headers pre-substituted from the vault, host-side
  scripts: ScriptSpec[];
  timeoutSec?: number;
  verify?: string;
}

export interface ContainerStepOutcome {
  status: "completed" | "failed";
  result: string | null;
  costUsd: number | null;
}

const cli = () => process.env.MDAGENT_CONTAINER_CLI ?? "docker";

// Paths that must never come back from a container, whatever happened in
// there. secrets.json and runs/ are also never copied in; knowledge/ goes in
// (agents read it) and is dropped on the way out.
const DENY_BACK = ["knowledge/", "secrets.json", "runs/", ".git/", ".mdagent/"];
// And per-agent knowledge, at any depth under agents/<name>/.
const DENY_BACK_RE = /^agents\/[^/]+\/knowledge\//;

/** Should this container-side path be applied back to the host workspace? */
export function allowedBack(rel: string): boolean {
  const norm = rel.replaceAll("\\", "/");
  if (norm.includes("..")) return false;
  if (DENY_BACK.some((d) => norm === d.replace(/\/$/, "") || norm.startsWith(d))) return false;
  if (DENY_BACK_RE.test(norm)) return false;
  return true;
}

/**
 * Apply what the container's workspace copy now holds onto the real one —
 * additive and overwriting, never deleting: an agent organising its own
 * files gains nothing from deleting on the host that it can't get by
 * writing, and a bug in a deletion sync destroys authored work.
 */
export function applyContainerChanges(hostWs: string, containerWs: string): string[] {
  const applied: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      const rel = path.relative(containerWs, abs);
      if (entry.isDirectory()) {
        if (allowedBack(rel + "/")) walk(abs);
        continue;
      }
      if (!allowedBack(rel)) continue;
      const target = path.join(hostWs, rel);
      const next = fs.readFileSync(abs);
      if (fs.existsSync(target) && fs.readFileSync(target).equals(next)) continue;
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, next);
      applied.push(rel);
    }
  };
  walk(containerWs);
  return applied;
}

// ---------- the runner image ----------

const DRIVER = `// The runner container's entrypoint. Reads one step, executes it with the
// same core the server uses, speaks JSONL on stdout, exits.
import fs from "node:fs";
const input = JSON.parse(fs.readFileSync("/opt/runner/job/input.json", "utf8"));
const emit = (type, text) => process.stdout.write(JSON.stringify({ e: "event", type, text }) + "\\n");
try {
  const { executeStep } = await import("@mdagent/core/step-exec");
  const { buildApiTools } = await import("@mdagent/core/api-tools");
  const { buildScriptTools } = await import("@mdagent/core/script-tools");

  const agentDir = "/workspace/" + input.agentRel;
  // HOME is where a bare relative path lands when anything resolves one
  // outside cwd — and root's /root is outside the workspace, so such a read
  // was refused by confinement with a path the agent never typed. Its own
  // directory is both the truthful answer and the safe one.
  const env = { ...process.env, HOME: agentDir };

  // API and script tools, rebuilt in here from their specs. Secrets were
  // substituted into API headers before the input crossed the boundary, so
  // buildApiTools gets an already-resolved environment.
  const api = buildApiTools("", input.apis, undefined, { env, missing: [] });
  const script = buildScriptTools(agentDir, input.scripts, env, "/library/scripts");

  const outcome = await executeStep({
    agentDir,
    workspaceRoot: "/workspace",
    libraryRoot: "/library",
    prompt: input.prompt,
    model: input.model,
    systemPrompt: input.systemPrompt,
    allowed: input.allowed,
    mcpNames: input.mcpNames,
    mcpServers: {
      ...(api.server ? { mdagent_apis: api.server } : {}),
      ...(script.server ? { mdagent_scripts: script.server } : {}),
      ...input.mcpServers,
    },
    env,
    timeoutSec: input.timeoutSec,
    verify: input.verify,
    verifyEnv: {},
    emit,
  });
  for (const line of api.drainLog()) emit("info", "api: " + line);
  for (const line of script.drainLog()) emit("info", "script: " + line);
  process.stdout.write(JSON.stringify({ e: "done", ...outcome }) + "\\n");
  process.exit(0);
} catch (err) {
  emit("error", err instanceof Error ? err.message : String(err));
  process.stdout.write(JSON.stringify({ e: "done", status: "failed", result: null, costUsd: null }) + "\\n");
  process.exit(0);
}
`;

// docker cp writes root-owned files, so the entrypoint starts as root for
// exactly two commands — chown the copied-in trees, drop to the agent user —
// and the run flags grant only the three capabilities those two commands
// need. By the time any model-directed code executes, the process is uid
// 10001 with no capabilities at all.
const DOCKERFILE = `FROM node:22-slim
RUN apt-get update \\
 && apt-get install -y --no-install-recommends python3 python3-venv ca-certificates bash util-linux tar \\
 && rm -rf /var/lib/apt/lists/* \\
 && useradd -m -u 10001 agent
WORKDIR /opt/runner
COPY mdagent-core.tgz driver.mjs entry.sh ./
RUN npm init -y >/dev/null && npm install ./mdagent-core.tgz --omit=dev \\
 && mkdir -p /workspace /library /opt/runner/job \\
 && chown -R agent:agent /workspace /library /opt/runner \\
 && chmod +x /opt/runner/entry.sh
ENTRYPOINT ["/opt/runner/entry.sh"]
`;

const ENTRY = `#!/bin/sh
set -e
chown -R agent:agent /workspace /library /opt/runner/job
exec runuser -u agent -- node /opt/runner/driver.mjs
`;

function corePackageDir(): string {
  // This file *is* part of @mdagent/core, so its own package.json is a walk
  // up — from src/ in the repo, from dist/src/ once built. require.resolve
  // can't do it: the exports map rewrites "./package.json" like any subpath.
  let dir = path.dirname(new URL(import.meta.url).pathname);
  for (let i = 0; i < 5; i++) {
    const candidate = path.join(dir, "package.json");
    if (fs.existsSync(candidate)) {
      try {
        if (JSON.parse(fs.readFileSync(candidate, "utf8")).name === "@mdagent/core") return dir;
      } catch {
        // keep walking
      }
    }
    dir = path.dirname(dir);
  }
  throw new Error("could not locate @mdagent/core's package root");
}

export function runnerImageTag(): string {
  // The fingerprint hashes the *built code*, not the version — a version
  // string that nobody bumped would pin every future run to the runner
  // image of whatever core happened to build first.
  const hash = crypto.createHash("sha256").update(DRIVER + "\n" + DOCKERFILE + "\n" + ENTRY);
  const dist = path.join(corePackageDir(), "dist");
  if (fs.existsSync(dist)) {
    for (const entry of fs.readdirSync(dist, { recursive: true }).sort()) {
      const abs = path.join(dist, String(entry));
      if (fs.statSync(abs).isFile()) hash.update(String(entry)).update(fs.readFileSync(abs));
    }
  }
  return `mdagent-runner:${hash.digest("hex").slice(0, 12)}`;
}

/**
 * Build the runner image if this exact (core version, driver, dockerfile)
 * has not been built before. `npm pack` of the installed core, so the image
 * runs the same bytes the server does.
 */
export function ensureRunnerImage(): { tag: string; log: string[] } {
  const tag = process.env.MDAGENT_RUNNER_IMAGE ?? runnerImageTag();
  const log: string[] = [];
  if (process.env.MDAGENT_RUNNER_IMAGE) return { tag, log };

  const have = spawnSync(cli(), ["image", "inspect", tag], { stdio: "ignore" });
  if (have.status === 0) return { tag, log };

  const build = fs.mkdtempSync(path.join(os.tmpdir(), "mdagent-runner-build-"));
  try {
    const pack = spawnSync("npm", ["pack", corePackageDir(), "--pack-destination", build], {
      encoding: "utf8",
    });
    if (pack.status !== 0) throw new Error(`npm pack failed:\n${pack.stderr}`);
    const tarball = pack.stdout.trim().split("\n").at(-1)!;
    fs.renameSync(path.join(build, tarball), path.join(build, "mdagent-core.tgz"));
    fs.writeFileSync(path.join(build, "driver.mjs"), DRIVER);
    fs.writeFileSync(path.join(build, "entry.sh"), ENTRY);
    fs.writeFileSync(path.join(build, "Dockerfile"), DOCKERFILE);
    log.push(`building runner image ${tag} (first run only)`);
    const out = spawnSync(cli(), ["build", "-t", tag, build], { encoding: "utf8" });
    if (out.status !== 0) {
      throw new Error(`runner image build failed:\n${(out.stderr || out.stdout).slice(-2000)}`);
    }
    return { tag, log };
  } finally {
    fs.rmSync(build, { recursive: true, force: true });
  }
}

// ---------- running one step ----------

export function parseDriverLine(
  line: string,
): { e: "event"; type: "text" | "tool" | "info" | "error"; text: string } | { e: "done" } & ContainerStepOutcome | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed.e === "event" && typeof parsed.text === "string") return parsed;
    if (parsed.e === "done") {
      return {
        e: "done",
        status: parsed.status === "completed" ? "completed" : "failed",
        result: typeof parsed.result === "string" ? parsed.result : null,
        costUsd: typeof parsed.costUsd === "number" ? parsed.costUsd : null,
      };
    }
    return null;
  } catch {
    return null; // interleaved non-protocol output (npm, python) is noise
  }
}

// The network runner containers join when none is configured: a bridge with
// inter-container traffic disabled, so two tenants' runs sharing a host
// cannot see each other's ports — each gets the internet (the model API
// lives there) and nothing beside it. Created once, reused forever.
const RUN_NETWORK = "mdagent-runs";

function ensureRunNetwork(): string {
  const configured = process.env.MDAGENT_RUNNER_NETWORK;
  if (configured) return configured;
  const have = spawnSync(cli(), ["network", "inspect", RUN_NETWORK], { stdio: "ignore" });
  if (have.status !== 0) {
    spawnSync(
      cli(),
      [
        "network", "create",
        "--opt", "com.docker.network.bridge.enable_icc=false",
        RUN_NETWORK,
      ],
      { stdio: "ignore" }, // a racing worker already created it — fine
    );
  }
  return RUN_NETWORK;
}

export interface RunInContainerArgs {
  workspaceRoot: string;
  libraryRoot: string;
  input: ContainerStepInput;
  /** Secret + provider env — crosses as an env file, never argv. */
  env: Record<string, string>;
  emit: (type: "text" | "tool" | "info" | "error", text: string) => void;
}

export async function runStepInContainer(args: RunInContainerArgs): Promise<ContainerStepOutcome> {
  const { tag, log } = ensureRunnerImage();
  for (const line of log) args.emit("info", line);

  const staging = fs.mkdtempSync(path.join(os.tmpdir(), "mdagent-run-"));
  let containerId = "";
  try {
    // Stage the workspace copy minus what must not enter: the vault and the
    // run archive. The container gets the trust boundary, not the history.
    const wsIn = path.join(staging, "workspace");
    fs.cpSync(args.workspaceRoot, wsIn, {
      recursive: true,
      filter: (src) => {
        const rel = path.relative(args.workspaceRoot, src).replaceAll("\\", "/");
        return !(rel === "secrets.json" || rel === "runs" || rel.startsWith("runs/") || rel === ".mdagent" || rel.startsWith(".mdagent/"));
      },
    });
    const libIn = path.join(staging, "library");
    if (fs.existsSync(args.libraryRoot)) fs.cpSync(args.libraryRoot, libIn, { recursive: true });
    else fs.mkdirSync(libIn, { recursive: true });

    const jobIn = path.join(staging, "job");
    fs.mkdirSync(jobIn);
    fs.writeFileSync(path.join(jobIn, "input.json"), JSON.stringify(args.input, null, 2));

    const envFile = path.join(staging, "env");
    fs.writeFileSync(
      envFile,
      Object.entries(args.env)
        .filter(([, v]) => typeof v === "string" && !v.includes("\n"))
        .map(([k, v]) => `${k}=${v}`)
        .join("\n"),
      { mode: 0o600 },
    );

    const flags = [
      "--security-opt", "no-new-privileges",
      // Everything dropped except what the entrypoint's chown-and-drop
      // needs; the exec to the agent user sheds these three too.
      "--cap-drop", "ALL",
      "--cap-add", "CHOWN", "--cap-add", "SETUID", "--cap-add", "SETGID",
      "--pids-limit", "512",
      "--memory", process.env.MDAGENT_RUNNER_MEMORY ?? "2g",
      "--cpus", process.env.MDAGENT_RUNNER_CPUS ?? "2",
      "--env-file", envFile,
    ];
    // gVisor (or kata) where the host has it: one env var, because the flag
    // is the same docker invocation everywhere else.
    if (process.env.MDAGENT_RUNNER_RUNTIME) {
      flags.push("--runtime", process.env.MDAGENT_RUNNER_RUNTIME);
    }
    flags.push("--network", ensureRunNetwork());

    const create = spawnSync(cli(), ["create", ...flags, tag], { encoding: "utf8" });
    if (create.status !== 0) throw new Error(`container create failed:\n${create.stderr}`);
    containerId = create.stdout.trim();

    const cp = (from: string, to: string) => {
      const out = spawnSync(cli(), ["cp", from, to], { encoding: "utf8" });
      if (out.status !== 0) throw new Error(`docker cp failed:\n${out.stderr}`);
    };
    cp(`${wsIn}/.`, `${containerId}:/workspace`);
    cp(`${libIn}/.`, `${containerId}:/library`);
    cp(`${jobIn}/input.json`, `${containerId}:/opt/runner/job/input.json`);

    // Start attached and read the driver's JSONL. The step timeout gets a
    // backstop out here — a wedged container is killed, not waited on.
    const outcome = await new Promise<ContainerStepOutcome>((resolve) => {
      const child = spawn(cli(), ["start", "-a", containerId], { stdio: ["ignore", "pipe", "pipe"] });
      let done: ContainerStepOutcome | null = null;
      let buffer = "";
      const backstopMs = ((args.input.timeoutSec ?? 15 * 60) + 60) * 1000;
      const backstop = setTimeout(() => {
        args.emit("error", `container exceeded its ${Math.round(backstopMs / 1000)}s backstop — killed`);
        spawnSync(cli(), ["kill", containerId], { stdio: "ignore" });
      }, backstopMs);

      child.stdout.on("data", (chunk: Buffer) => {
        buffer += chunk.toString();
        for (;;) {
          const nl = buffer.indexOf("\n");
          if (nl < 0) break;
          const line = buffer.slice(0, nl);
          buffer = buffer.slice(nl + 1);
          const parsed = parseDriverLine(line);
          if (!parsed) continue;
          if (parsed.e === "event") args.emit(parsed.type, parsed.text);
          else done = parsed;
        }
      });
      let stderrTail = "";
      child.stderr.on("data", (c: Buffer) => {
        stderrTail = (stderrTail + c.toString()).slice(-2000);
      });
      child.on("close", () => {
        clearTimeout(backstop);
        if (!done && stderrTail.trim()) args.emit("error", stderrTail.trim().slice(0, 1000));
        resolve(done ?? { status: "failed", result: null, costUsd: null });
      });
      child.on("error", (err) => {
        clearTimeout(backstop);
        args.emit("error", err.message);
        resolve({ status: "failed", result: null, costUsd: null });
      });
    });

    // What came out, through the filter. On failure too: a failed step's
    // partial outputs are usually the interesting ones.
    const wsOut = path.join(staging, "out");
    fs.mkdirSync(wsOut);
    const back = spawnSync(cli(), ["cp", `${containerId}:/workspace/.`, wsOut], { encoding: "utf8" });
    if (back.status === 0) {
      applyContainerChanges(args.workspaceRoot, wsOut);
    } else {
      args.emit("error", `copy-out failed — the step's file changes were lost:\n${back.stderr.slice(0, 500)}`);
    }

    return outcome;
  } finally {
    if (containerId) spawnSync(cli(), ["rm", "-f", containerId], { stdio: "ignore" });
    fs.rmSync(staging, { recursive: true, force: true });
  }
}
