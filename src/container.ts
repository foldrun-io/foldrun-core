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
import os from "node:os";
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

// "sandbox" means "run the script directly in whatever environment this step
// is already isolated by" — the run pod under FOLDRUN_RUN_ISOLATION=k8s, or
// the local process on a laptop. It was called "host", which read as "on the
// platform's own machine" and made a correct, isolated setup look like a
// tenant escape to anyone reading a run trace.
export type Executor = "docker" | "sandbox";

let cachedAvailability: boolean | null = null;

export function dockerAvailable(): boolean {
  if (process.env.FOLDRUN_EXECUTOR === "host" || process.env.FOLDRUN_EXECUTOR === "sandbox") return false;
  if (cachedAvailability !== null) return cachedAvailability;
  const res = spawnSync(CLI, ["info", "--format", "{{.ServerVersion}}"], {
    encoding: "utf8",
    timeout: 15_000,
  });
  cachedAvailability = res.status === 0;
  return cachedAvailability;
}

export function chooseExecutor(): Executor {
  return dockerAvailable() ? "docker" : "sandbox";
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
  /** Workspace paths a script was handed as `workspace/…`: copied in at
   *  `container` before it runs, and what it created or changed under them
   *  copied back to `host` after — the host's workspace link, as a copy. */
  staged?: { host: string; container: string }[];
  image: string;
  argv: string[]; // command inside the container
  env: Record<string, string>;
  /** Only when the tool.md set one — the platform has no clock of its own. */
  timeoutMs?: number;
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
    // The agent's own directory becomes /workspace… — its entries staged
    // like the workspace paths below (a scratch copy, opened up for the
    // script's user, one tar), minus the step's `workspace` link. A step
    // holds that link (→ ../..) so the shell can say workspace/…, and
    // `docker cp` refuses a link that climbs out of what it copies
    // ("invalid symlink"), so every Docker-run script failed before it
    // started. And `docker cp` lands files as root while scripts run as
    // `agent`, so a script could never write its own outputs/.
    const own = fs
      .readdirSync(opts.agentDir)
      .filter((name) => {
        if (name !== "workspace") return true;
        try {
          return !fs.lstatSync(path.join(opts.agentDir, name)).isSymbolicLink();
        } catch {
          return false;
        }
      })
      .map((name) => ({ host: path.join(opts.agentDir, name), container: `/workspace/${name}` }));
    const copiedIn = stageIn(CLI, cid, own, ["/workspace"]);
    if (copiedIn) return { code: null, out: `copy in failed: ${copiedIn}` };
    // …and any shared directories land at their declared paths.
    for (const [host, mount] of Object.entries(opts.readOnly ?? {})) {
      if (fs.existsSync(host)) docker(["cp", `${host}/.`, `${cid}:${mount}`], 120_000);
    }
    const staged = opts.staged ?? [];
    if (staged.length) {
      const failed = stageIn(CLI, cid, staged);
      if (failed) return { code: null, out: `copy in failed: ${failed}` };
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
    for (const s of staged) stageBack(CLI, cid, s);
    return result;
  } finally {
    docker(["rm", "-f", cid], 30_000);
  }
}

/**
 * Copy the staged workspace paths into a created container: one tar, built
 * in a scratch directory that mirrors the container paths, extracted at /.
 * A path that does not exist yet (an output the script is told to write)
 * gets its parent directory, so the write has somewhere to land.
 */
function stageIn(cli: string, cid: string, staged: { host: string; container: string }[], dirs: string[] = []): string | null {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-stage-"));
  try {
    for (const d of dirs) fs.mkdirSync(path.join(scratch, d), { recursive: true });
    for (const { host, container } of staged) {
      const dest = path.join(scratch, container);
      if (fs.existsSync(host)) {
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.cpSync(host, dest, { recursive: true, dereference: false });
      } else {
        fs.mkdirSync(path.dirname(dest), { recursive: true });
      }
    }
    // `docker cp` lands files as root and scripts run as `agent`: these are
    // scratch copies, so open them up for the script to write into.
    openUp(scratch);
    const top = fs.readdirSync(scratch);
    const r = spawnSync(
      "sh",
      ["-c", 'dir="$1"; cli="$2"; dest="$3"; shift 3; tar --no-xattrs -C "$dir" -cf - -- "$@" | "$cli" cp - "$dest"', "sh", scratch, cli, `${cid}:/`, ...top],
      { encoding: "utf8", timeout: 120_000, env: { ...process.env, COPYFILE_DISABLE: "1" } },
    );
    return r.status === 0 ? null : (r.stderr ?? "").slice(-300);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

/**
 * Copy back what the script created or changed under one staged path. Files
 * whose bytes did not change are left alone, so an input keeps its mtime —
 * freshness checks read it.
 */
function stageBack(cli: string, cid: string, s: { host: string; container: string }): void {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-stage-"));
  try {
    const out = path.join(scratch, "x");
    const got = spawnSync(cli, ["cp", `${cid}:${s.container}`, out], { encoding: "utf8", timeout: 120_000 });
    if (got.status !== 0 || !fs.existsSync(out)) return;
    syncChanged(out, s.host);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

/** Write `from` over `to` where the bytes differ; recurse into folders. */
export function syncChanged(from: string, to: string): void {
  const st = fs.lstatSync(from);
  if (st.isSymbolicLink()) return;
  if (st.isDirectory()) {
    fs.mkdirSync(to, { recursive: true });
    for (const name of fs.readdirSync(from)) syncChanged(path.join(from, name), path.join(to, name));
    return;
  }
  const next = fs.readFileSync(from);
  if (fs.existsSync(to) && fs.statSync(to).isFile() && fs.readFileSync(to).equals(next)) return;
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.writeFileSync(to, next);
}

/** Directories 0777, files writable by all (exec bits kept): a scratch tree only. */
function openUp(dir: string): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      fs.chmodSync(p, 0o777);
      openUp(p);
    } else {
      fs.chmodSync(p, fs.statSync(p).mode | 0o666);
    }
  }
}
