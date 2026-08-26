// Whole-step isolation: the model loop itself inside a container.
//
// container.ts isolates *declared script tools* — real code the author chose
// to ship. This isolates the rest: the agent's built-in Read/Write/Bash,
// which otherwise run in the server process behind path checks. Path checks
// are argument inspection; a container is an operating system saying no. The
// hosted platform runs every step this way (FOLDRUN_RUN_ISOLATION=container);
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
// The runner image bundles @foldrun/core itself, so the driver runs the same
// executeStep the server would — one implementation, two homes.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import type { McpServerConfig } from "@anthropic-ai/claude-agent-sdk";
import { isPlatformPath, type ApiSpec, type Effort } from "./store.ts";
import { isFileValue, fileContent } from "./secrets.ts";
import type { ScriptSpec } from "./script-tools.ts";
import type { RuntimeSpec } from "./runtime.ts";
import type { ConsultSpec } from "./agent-tools.ts";

/** What crosses the boundary. Everything in here is values — pre-resolved
 *  secrets in headers, assembled prompt, serializable MCP configs. */
export interface ContainerStepInput {
  agentRel: string; // "agents/<name>" inside the workspace
  prompt: string;
  model: string;
  effort?: Effort | null;
  systemPrompt: string;
  allowed: string[];
  mcpNames: string[];
  /** http/stdio configs only — in-process servers are rebuilt inside. */
  mcpServers: Record<string, McpServerConfig>;
  apis: ApiSpec[]; // headers pre-substituted from the vault, host-side
  scripts: ScriptSpec[];
  /** The agent's `runtime:` declaration — the driver builds the venv/npm
   *  prefix inside the container, where the network is. Without this,
   *  dependency-using scripts worked locally and failed only in production
   *  isolation, which is the worst place for a difference. */
  runtime: RuntimeSpec | null;
  /** Colleagues this agent may consult — persona + model, gathered from
   *  their agent.md files host-side. The driver rebuilds the consult tools
   *  in here; the callees run toolless, so nothing else need cross. */
  consults: ConsultSpec[];
  timeoutSec?: number;
  verify?: string;
}

/**
 * How long the sandbox actually existed, measured host-side — the driver
 * cannot time its own cold start, because it isn't running yet.
 *
 * The split is where the two executors differ, so read it per executor:
 * `sandboxMs` is scheduling and admission (docker `create` returns almost
 * at once; a gVisor pod's Ready is the real cold-start number), and
 * `firstOutputMs` is guest boot to the driver's first line (for docker
 * that's where the cold start actually lands, since `start` is when the
 * container boots). `totalMs` is what the platform rented either way, and
 * is the only one billing should ever use.
 */
export interface StepTiming {
  sandboxMs: number;
  firstOutputMs: number | null;
  totalMs: number;
}

export interface StepActuals {
  busyCpuSecs: number | null;
  peakMemBytes: number | null;
  rxBytes: number | null;
  txBytes: number | null;
}

export interface ContainerStepOutcome {
  status: "completed" | "failed";
  result: string | null;
  costUsd: number | null;
  usage?: { inputTokens: number; outputTokens: number } | null;
  /** What the sandbox actually touched — see the driver's readActuals. */
  res?: StepActuals | null;
  /** Set by the isolated executors only — an in-process step rents no
   *  sandbox, so it has no compute seconds to bill. */
  timing?: StepTiming | null;
}

/**
 * The one place the timing line is worded, so the docker and k8s traces
 * read the same and a cold-start regression is greppable across both.
 */
export function timingLine(t: StepTiming): string {
  const s = (ms: number) => `${(ms / 1000).toFixed(2)}s`;
  const first = t.firstOutputMs === null ? "no output" : `first output +${s(t.firstOutputMs)}`;
  return `timing: sandbox ready in ${s(t.sandboxMs)}, ${first}, ${s(t.totalMs)} total`;
}

const cli = () => process.env.FOLDRUN_CONTAINER_CLI ?? "docker";

// Paths that must never come back from a container, whatever happened in
// there: everything platform-owned (store.ts#isPlatformPath — also never
// copied in), plus knowledge/, which goes in for reading and is dropped on
// the way out, and .git/.
const DENY_BACK = ["knowledge/", ".git/"];
// Materialised @file secrets (SSH keys, certs) live under .secret-files/ in
// an agent's dir while a step runs; they are live credentials and must never
// come back to the host, whatever the step wrote there.
const DENY_BACK_SECRET_FILES = /(^|\/)\.secret-files\//;
// And per-agent knowledge, at any depth under agents/<name>/.
const DENY_BACK_RE = /^agents\/[^/]+\/knowledge\//;

/** Should this container-side path be applied back to the host workspace? */
export function allowedBack(rel: string): boolean {
  const norm = rel.replaceAll("\\", "/");
  if (norm.includes("..")) return false;
  if (isPlatformPath(norm)) return false;
  if (DENY_BACK.some((d) => norm === d.replace(/\/$/, "") || norm.startsWith(d))) return false;
  if (DENY_BACK_RE.test(norm)) return false;
  if (DENY_BACK_SECRET_FILES.test(norm)) return false;
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
  // Runtime state (venvs, npm prefixes) lands in the agent user's real home
  // — writable, inside the container, gone with it.
  process.env.FOLDRUN_DATA = "/home/agent/.foldrun";
  const { executeStep } = await import("@foldrun/core/step-exec");
  const { buildApiTools } = await import("@foldrun/core/api-tools");
  const { buildScriptTools } = await import("@foldrun/core/script-tools");
  const { buildConsultTools } = await import("@foldrun/core/agent-tools");
  const { prepareRuntime } = await import("@foldrun/core/runtime");
  const { materializeFileSecrets } = await import("@foldrun/core/secret-files");

  const agentDir = "/workspace/" + input.agentRel;
  // HOME is where a bare relative path lands when anything resolves one
  // outside cwd — and root's /root is outside the workspace, so such a read
  // was refused by confinement with a path the agent never typed. Its own
  // directory is both the truthful answer and the safe one.
  // @file secrets crossed as content; materialise them to 0600 paths inside
  // the container (a host path from the other side would not exist here).
  const env = materializeFileSecrets(agentDir, { ...process.env, HOME: agentDir }).env;

  // The declared runtime, built in here — pip and npm have the network, and
  // the cache dies with the container (a fresh install per run is the cost
  // of the isolation; the log says what was built and how long it took).
  const runtime = input.runtime
    ? prepareRuntime("runner", input.runtime)
    : { interpreters: {}, env: {}, log: [], error: null };
  for (const line of runtime.log) emit("info", "runtime: " + line);
  if (runtime.error) emit("error", "runtime: " + runtime.error);

  // API and script tools, rebuilt in here from their specs. Secrets were
  // substituted into API headers before the input crossed the boundary, so
  // buildApiTools gets an already-resolved environment. (verify: needs no
  // separate env either — the container's own environment already carries
  // the declared secrets, which is why executeStep gets verifyEnv: {}.)
  const api = buildApiTools("", input.apis, undefined, { env, missing: [] });
  const script = buildScriptTools(
    agentDir,
    input.scripts,
    { ...env, ...runtime.env },
    "/library/scripts",
    runtime.interpreters,
  );
  const consult = buildConsultTools(input.consults ?? [], env, emit);

  // What this sandbox actually touched, read at the last moment from the
  // kernel's own books: cgroup v2 for CPU busy-time and peak memory,
  // /proc/net/dev for bytes on the wire. Every read is best-effort — gVisor
  // exposes some of these files and not others depending on version, and a
  // metric we cannot read is null, never guessed. Reservation is what is
  // billed; these exist so the reservation can be right-sized.
  function readActuals() {
    const read = (p) => { try { return require("node:fs").readFileSync(p, "utf8"); } catch { return null; } };
    const cpuStat = read("/sys/fs/cgroup/cpu.stat");
    const usage = cpuStat?.match(/^usage_usec (\\d+)/m);
    const peak = read("/sys/fs/cgroup/memory.peak") ?? read("/sys/fs/cgroup/memory/memory.max_usage_in_bytes");
    let rx = 0, tx = 0, sawNet = false;
    const net = read("/proc/net/dev");
    if (net) {
      for (const line of net.split("\\n").slice(2)) {
        const m = line.trim().match(/^(\\S+):\\s+(\\d+)(?:\\s+\\d+){7}\\s+(\\d+)/);
        if (m && m[1] !== "lo") { rx += Number(m[2]); tx += Number(m[3]); sawNet = true; }
      }
    }
    return {
      busyCpuSecs: usage ? Number(usage[1]) / 1e6 : null,
      peakMemBytes: peak ? Number(peak.trim()) || null : null,
      rxBytes: sawNet ? rx : null,
      txBytes: sawNet ? tx : null,
    };
  }

  const outcome = await executeStep({
    agentDir,
    workspaceRoot: "/workspace",
    libraryRoot: "/library",
    prompt: input.prompt,
    model: input.model,
    effort: input.effort ?? null,
    systemPrompt: input.systemPrompt,
    allowed: input.allowed,
    mcpNames: input.mcpNames,
    mcpServers: {
      ...(api.server ? { foldrun_apis: api.server } : {}),
      ...(script.server ? { foldrun_scripts: script.server } : {}),
      ...(consult.server ? { foldrun_agents: consult.server } : {}),
      ...input.mcpServers,
    },
    env,
    timeoutSec: input.timeoutSec,
    verify: input.verify,
    verifyEnv: {},
    // The container is the boundary; the SDK's own bash sandbox here would
    // only block declared network use (SSH, curl) for no added safety.
    sandboxBash: false,
    emit,
  });
  for (const line of api.drainLog()) emit("info", "api: " + line);
  for (const line of script.drainLog()) emit("info", "script: " + line);
  // A consult's spend belongs to the step that asked.
  const consultCost = consult.drainCost();
  if (consultCost > 0) outcome.costUsd = (outcome.costUsd ?? 0) + consultCost;
  process.stdout.write(JSON.stringify({ e: "done", ...outcome, res: readActuals() }) + "\\n");
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
 && apt-get install -y --no-install-recommends python3 python3-venv ca-certificates bash util-linux tar openssh-client sshpass git curl \\
 && rm -rf /var/lib/apt/lists/* \\
 && useradd -m -u 10001 agent
# A real browser, because directories and portals increasingly render with
# JavaScript and WebFetch sees only the empty shell. Installed to a fixed
# path the agent user can read (the default cache would be root's HOME).
# Chromium's own sandbox is disabled at launch time — in this platform the
# container/gVisor IS the sandbox, and the two fight.
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/browser NODE_PATH=/usr/local/lib/node_modules
RUN npm install -g playwright@1 >/dev/null \\
 && playwright install --with-deps chromium >/dev/null \\
 && chmod -R a+rX /opt/browser
WORKDIR /opt/runner
COPY foldrun-core.tgz driver.mjs entry.sh ./
RUN npm init -y >/dev/null && npm install ./foldrun-core.tgz --omit=dev \\
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
  // This file *is* part of @foldrun/core, so its own package.json is a walk
  // up — from src/ in the repo, from dist/src/ once built. require.resolve
  // can't do it: the exports map rewrites "./package.json" like any subpath.
  let dir = path.dirname(new URL(import.meta.url).pathname);
  for (let i = 0; i < 5; i++) {
    const candidate = path.join(dir, "package.json");
    if (fs.existsSync(candidate)) {
      try {
        if (JSON.parse(fs.readFileSync(candidate, "utf8")).name === "@foldrun/core") return dir;
      } catch {
        // keep walking
      }
    }
    dir = path.dirname(dir);
  }
  throw new Error("could not locate @foldrun/core's package root");
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
  return `foldrun-runner:${hash.digest("hex").slice(0, 12)}`;
}

/**
 * Build the runner image if this exact (core version, driver, dockerfile)
 * has not been built before. `npm pack` of the installed core, so the image
 * runs the same bytes the server does.
 */
export function ensureRunnerImage(): { tag: string; log: string[] } {
  const tag = process.env.FOLDRUN_RUNNER_IMAGE ?? runnerImageTag();
  const log: string[] = [];
  if (process.env.FOLDRUN_RUNNER_IMAGE) return { tag, log };

  const have = spawnSync(cli(), ["image", "inspect", tag], { stdio: "ignore" });
  if (have.status === 0) return { tag, log };

  const build = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-runner-build-"));
  try {
    const pack = spawnSync("npm", ["pack", corePackageDir(), "--pack-destination", build], {
      encoding: "utf8",
    });
    if (pack.status !== 0) throw new Error(`npm pack failed:\n${pack.stderr}`);
    const tarball = pack.stdout.trim().split("\n").at(-1)!;
    fs.renameSync(path.join(build, tarball), path.join(build, "foldrun-core.tgz"));
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
        usage:
          parsed.usage &&
          typeof parsed.usage.inputTokens === "number" &&
          typeof parsed.usage.outputTokens === "number"
            ? { inputTokens: parsed.usage.inputTokens, outputTokens: parsed.usage.outputTokens }
            : null,
        res:
          parsed.res && typeof parsed.res === "object"
            ? {
                busyCpuSecs: typeof parsed.res.busyCpuSecs === "number" ? parsed.res.busyCpuSecs : null,
                peakMemBytes: typeof parsed.res.peakMemBytes === "number" ? parsed.res.peakMemBytes : null,
                rxBytes: typeof parsed.res.rxBytes === "number" ? parsed.res.rxBytes : null,
                txBytes: typeof parsed.res.txBytes === "number" ? parsed.res.txBytes : null,
              }
            : null,
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
const RUN_NETWORK = "foldrun-runs";

function ensureRunNetwork(): string {
  const configured = process.env.FOLDRUN_RUNNER_NETWORK;
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
  /** The run this step belongs to. Stamped on the sandbox as a label so a
   *  person stopping the run can reach the thing actually burning money —
   *  without it, "stop" could only mean "stop after this step", and a
   *  browser step has fifteen minutes left to spend. */
  runId?: string;
  /** The reservation class — which limits this step's sandbox holds. */
  size?: "small" | "large";
}

/** The limits a size class reserves. Large is the install's configured
 *  limits unchanged, so existing installs bill and behave identically;
 *  small defaults to a quarter-ish slice and is env-tunable. */
export function sizeLimits(size?: "small" | "large"): { cpus: string; memory: string } {
  if (size === "small") {
    return {
      cpus: process.env.FOLDRUN_RUNNER_CPUS_SMALL ?? "1",
      memory: process.env.FOLDRUN_RUNNER_MEMORY_SMALL ?? "1Gi",
    };
  }
  return {
    cpus: process.env.FOLDRUN_RUNNER_CPUS ?? "2",
    memory: process.env.FOLDRUN_RUNNER_MEMORY ?? "2g",
  };
}

/** The label both executors stamp, so one name means one thing. */
export const RUN_LABEL = "foldrun-run-id";

/**
 * Destroy any sandbox still running for this run. Best effort by design:
 * the step may have finished a moment ago, the daemon may be unreachable,
 * and neither is a reason to refuse to stop a run. Returns how many it
 * removed, which is what the trace reports.
 */
export function killRunSandboxes(runId: string): number {
  const ids = spawnSync(cli(), ["ps", "-aq", "--filter", `label=${RUN_LABEL}=${runId}`], {
    encoding: "utf8",
  });
  const list = (ids.stdout ?? "").split("\n").map((l) => l.trim()).filter(Boolean);
  for (const id of list) spawnSync(cli(), ["rm", "-f", id], { stdio: "ignore" });
  return list.length;
}

export async function runStepInContainer(args: RunInContainerArgs): Promise<ContainerStepOutcome> {
  const { tag, log } = ensureRunnerImage();
  for (const line of log) args.emit("info", line);

  const staging = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-run-"));
  let containerId = "";
  try {
    // Stage the workspace copy minus what the platform owns — the vault,
    // hook state, run history. The container gets the trust boundary, not
    // the bookkeeping. One definition of "platform-owned" for this filter,
    // the k8s executor's, and deploys: store.ts#isPlatformPath.
    const wsIn = path.join(staging, "workspace");
    fs.cpSync(args.workspaceRoot, wsIn, {
      recursive: true,
      filter: (src) => !isPlatformPath(path.relative(args.workspaceRoot, src)),
    });
    const libIn = path.join(staging, "library");
    if (fs.existsSync(args.libraryRoot)) fs.cpSync(args.libraryRoot, libIn, { recursive: true });
    else fs.mkdirSync(libIn, { recursive: true });

    const jobIn = path.join(staging, "job");
    fs.mkdirSync(jobIn);
    fs.writeFileSync(path.join(jobIn, "input.json"), JSON.stringify(args.input, null, 2));

    // @file secrets are multi-line (a PEM key, a cert), and a docker
    // --env-file cannot carry a newline. So they are staged as files *now*,
    // into the copied-in workspace, and the env carries the container path —
    // the one place a path is stable across the boundary. Everything else
    // goes through the env file. (Without this the key silently vanished:
    // the old filter dropped any value with a newline, and ssh got an empty
    // -i path.)
    const containerEnv: Record<string, string> = {};
    for (const [k, v] of Object.entries(args.env)) {
      if (typeof v !== "string") continue;
      if (isFileValue(v)) {
        const rel = path.join(args.input.agentRel, ".secret-files", k.toLowerCase());
        const abs = path.join(wsIn, rel);
        fs.mkdirSync(path.dirname(abs), { recursive: true, mode: 0o700 });
        fs.writeFileSync(abs, fileContent(v), { mode: 0o600 });
        containerEnv[k] = `/workspace/${rel.replaceAll("\\", "/")}`;
      } else if (!v.includes("\n")) {
        containerEnv[k] = v;
      }
    }

    const envFile = path.join(staging, "env");
    fs.writeFileSync(
      envFile,
      Object.entries(containerEnv).map(([k, v]) => `${k}=${v}`).join("\n"),
      { mode: 0o600 },
    );

    const flags = [
      "--security-opt", "no-new-privileges",
      ...(args.runId ? ["--label", `${RUN_LABEL}=${args.runId}`] : []),
      // Everything dropped except what the entrypoint's chown-and-drop
      // needs; the exec to the agent user sheds these three too.
      "--cap-drop", "ALL",
      "--cap-add", "CHOWN", "--cap-add", "SETUID", "--cap-add", "SETGID",
      "--pids-limit", "512",
      "--memory", sizeLimits(args.size).memory,
      "--cpus", sizeLimits(args.size).cpus,
      "--env-file", envFile,
    ];
    // gVisor (or kata) where the host has it: one env var, because the flag
    // is the same docker invocation everywhere else.
    if (process.env.FOLDRUN_RUNNER_RUNTIME) {
      flags.push("--runtime", process.env.FOLDRUN_RUNNER_RUNTIME);
    }
    flags.push("--network", ensureRunNetwork());

    // The rent clock starts here: staging the workspace is host work, but
    // from `create` to `rm` the sandbox is a resource the platform pays for.
    const t0 = Date.now();
    const create = spawnSync(cli(), ["create", ...flags, tag], { encoding: "utf8" });
    if (create.status !== 0) throw new Error(`container create failed:\n${create.stderr}`);
    containerId = create.stdout.trim();
    const sandboxMs = Date.now() - t0;

    const cp = (from: string, to: string) => {
      const out = spawnSync(cli(), ["cp", from, to], { encoding: "utf8" });
      if (out.status !== 0) throw new Error(`docker cp failed:\n${out.stderr}`);
    };
    cp(`${wsIn}/.`, `${containerId}:/workspace`);
    cp(`${libIn}/.`, `${containerId}:/library`);
    cp(`${jobIn}/input.json`, `${containerId}:/opt/runner/job/input.json`);

    // Start attached and read the driver's JSONL. The step timeout gets a
    // backstop out here — a wedged container is killed, not waited on.
    let firstOutputAt: number | null = null;
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
          firstOutputAt ??= Date.now();
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

    // Timed after the copy-out, because the container is still alive for it:
    // what gets billed is the sandbox's whole life, not the model's turn.
    const timing: StepTiming = {
      sandboxMs,
      firstOutputMs: firstOutputAt === null ? null : firstOutputAt - t0 - sandboxMs,
      totalMs: Date.now() - t0,
    };
    args.emit("info", timingLine(timing));
    return { ...outcome, timing };
  } finally {
    if (containerId) spawnSync(cli(), ["rm", "-f", containerId], { stdio: "ignore" });
    fs.rmSync(staging, { recursive: true, force: true });
  }
}
