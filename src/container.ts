// Container execution for scripts.
//
// The isolation boundary is the run: one container image per runtime
// declaration (keyed by the same fingerprint the host path uses), and every
// script call in a run executes inside a container from that image with the
// agent's directory mounted. Scripts therefore cannot read other tenants'
// data, the key file, or anything else on the host.
//
// Falls back to host execution when Docker isn't available, so local
// development keeps working with zero configuration.

import fs from "node:fs";
import path from "node:path";
import { dataRoot } from "./paths.ts";
import { spawnSync, spawn } from "node:child_process";
import type { RuntimeSpec } from "./runtime.ts";
import { fingerprint } from "./runtime.ts";

const BUILD_TIMEOUT_MS = 600_000;
const IMAGE_PREFIX = "foldrun-runtime";

// Any Docker-compatible CLI works — Docker Engine, colima, Podman, nerdctl,
// OrbStack. Copying files in and out (rather than bind-mounting) is what
// makes that portability real: no host path has to be shared with a VM.
const CLI = process.env.FOLDRUN_CONTAINER_CLI ?? "docker";

export type Executor = "docker" | "host";

let cachedAvailability: boolean | null = null;

export function dockerAvailable(): boolean {
  if (process.env.FOLDRUN_EXECUTOR === "host") return false;
  if (cachedAvailability !== null) return cachedAvailability;
  const res = spawnSync(CLI, ["info", "--format", "{{.ServerVersion}}"], {
    encoding: "utf8",
    timeout: 15_000,
  });
  cachedAvailability = res.status === 0;
  return cachedAvailability;
}

export function chooseExecutor(): Executor {
  return dockerAvailable() ? "docker" : "host";
}

export function imageTag(spec: RuntimeSpec | null): string {
  return `${IMAGE_PREFIX}:${spec ? fingerprint(spec) : "base"}`;
}

function imageExists(tag: string): boolean {
  return spawnSync(CLI, ["image", "inspect", tag], { timeout: 20_000 }).status === 0;
}

// A minimal image carrying just the declared runtimes and packages.
function dockerfileFor(spec: RuntimeSpec | null): string {
  const wantsNode = spec ? spec.node !== undefined || spec.npm.length > 0 : false;
  const pyVersion = typeof spec?.python === "string" ? spec.python : "3.12";

  const lines: string[] = [];
  if (wantsNode && !spec?.packages.length && spec?.python === undefined) {
    lines.push("FROM node:22-slim");
  } else {
    lines.push(`FROM python:${pyVersion}-slim`);
    if (wantsNode) {
      lines.push(
        "RUN apt-get update && apt-get install -y --no-install-recommends nodejs npm && rm -rf /var/lib/apt/lists/*",
      );
    }
  }

  if (spec?.packages.length) {
    lines.push(`RUN pip install --no-cache-dir ${spec.packages.map((p) => `'${p}'`).join(" ")}`);
  }
  if (spec?.npm.length) {
    lines.push("WORKDIR /opt/npm");
    lines.push(`RUN npm install --no-fund --no-audit ${spec.npm.map((p) => `'${p}'`).join(" ")}`);
    lines.push("ENV NODE_PATH=/opt/npm/node_modules");
  }

  // Scripts run as a non-root user with no write access outside the mount.
  lines.push("RUN useradd -m -u 10001 agent");
  lines.push("USER agent");
  lines.push("WORKDIR /workspace");
  return lines.join("\n") + "\n";
}

export interface ImageResult {
  tag: string;
  built: boolean;
  error: string | null;
  log: string[];
}

export function ensureImage(spec: RuntimeSpec | null): ImageResult {
  const tag = imageTag(spec);
  if (imageExists(tag)) return { tag, built: false, error: null, log: [`image ${tag}: cached`] };

  // dataRoot() may not exist yet on a brand-new install or a fresh workspace
  // whose first-ever step is a script tool — mkdtemp does not create parents,
  // so without this the first script build dies with ENOENT and the whole run
  // fails on nothing the author did wrong.
  fs.mkdirSync(dataRoot(), { recursive: true });
  const dir = fs.mkdtempSync(path.join(dataRoot(), ".build-"));
  try {
    fs.writeFileSync(path.join(dir, "Dockerfile"), dockerfileFor(spec));
    const res = spawnSync(CLI, ["build", "-q", "-t", tag, dir], {
      encoding: "utf8",
      timeout: BUILD_TIMEOUT_MS,
    });
    if (res.status !== 0) {
      return {
        tag,
        built: false,
        error: `image build failed: ${`${res.stderr ?? ""}`.slice(-400)}`,
        log: [],
      };
    }
    return { tag, built: true, error: null, log: [`image ${tag}: built`] };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

export interface ContainerRunOptions {
  /** Host directory mounted at /workspace — the agent's own folder. */
  agentDir: string;
  /** Extra read-only mounts: host path → container path. */
  readOnly?: Record<string, string>;
  image: string;
  argv: string[]; // command inside the container
  env: Record<string, string>;
  timeoutMs: number;
  /** Allow outbound network (agents that declared APIs need it). */
  network: boolean;
  maxOutput: number;
}

// Files are copied in and out rather than bind-mounted. Bind mounts need the
// host path to be inside Docker's shared-paths configuration, which fails
// silently (the mount appears empty) on Docker Desktop for directories it
// isn't allowed to share. Copying is what CI systems do, needs no host
// configuration, and has the side benefit that a script cannot corrupt the
// source tree — only the copy it was given.
export async function runInContainer(
  opts: ContainerRunOptions,
): Promise<{ code: number | null; out: string }> {
  const docker = (args: string[], timeout = 60_000) =>
    spawnSync(CLI, args, { encoding: "utf8", timeout });

  const createArgs = [
    "create",
    "-i",
    "--workdir",
    "/workspace",
    // Guard rails: no privilege escalation, bounded CPU/memory/processes.
    "--security-opt",
    "no-new-privileges",
    "--cap-drop",
    "ALL",
    "--pids-limit",
    "256",
    "--memory",
    "1g",
    "--cpus",
    "1",
  ];
  if (!opts.network) createArgs.push("--network", "none");
  for (const [k, v] of Object.entries(opts.env)) createArgs.push("-e", `${k}=${v}`);
  createArgs.push(opts.image, ...opts.argv);

  const created = docker(createArgs);
  if (created.status !== 0) {
    return { code: null, out: `container create failed: ${(created.stderr ?? "").slice(-300)}` };
  }
  const cid = (created.stdout ?? "").trim();

  try {
    // The agent's own directory becomes /workspace…
    const copied = docker(["cp", `${opts.agentDir}/.`, `${cid}:/workspace`], 120_000);
    if (copied.status !== 0) {
      return { code: null, out: `copy in failed: ${(copied.stderr ?? "").slice(-300)}` };
    }
    // …and any shared directories land at their declared paths.
    for (const [host, mount] of Object.entries(opts.readOnly ?? {})) {
      if (fs.existsSync(host)) docker(["cp", `${host}/.`, `${cid}:${mount}`], 120_000);
    }

    const result = await new Promise<{ code: number | null; out: string }>((resolve) => {
      const child = spawn(CLI, ["start", "-a", cid], { timeout: opts.timeoutMs });
      let out = "";
      const append = (chunk: Buffer) => {
        if (out.length < opts.maxOutput) out += chunk.toString();
      };
      child.stdout.on("data", append);
      child.stderr.on("data", append);
      child.on("error", (err) => resolve({ code: null, out: `container failed: ${err.message}` }));
      child.on("close", (code) =>
        resolve({
          code,
          out:
            out.length > opts.maxOutput
              ? `${out.slice(0, opts.maxOutput)}\n…[truncated]`
              : out || "(no output)",
        }),
      );
    });

    // Bring deliverables back so outputs/ behaves the same either way.
    docker(["cp", `${cid}:/workspace/outputs/.`, path.join(opts.agentDir, "outputs")], 120_000);
    return result;
  } finally {
    docker(["rm", "-f", cid], 30_000);
  }
}
