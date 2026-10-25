// Isolated sub-agents: a colleague that does a job in ITS OWN sandbox.
//
//   subagents: [reader]       # on the delegating agent, unchanged
//   sandbox: own              # on reader's own agent.md
//
// A sub-agent delegated to the ordinary way (subagents.ts) runs inside the
// parent's SDK session: the parent's pod, secrets, lease and network, its
// tools cut to the parent's. That protects the parent's context and nothing
// else — an injected page read by the sub-agent is read in a sandbox the
// parent's secrets are in.
//
// An agent marked `sandbox: own` is instead offered to the parent as a tool,
// `delegate_<name>(job)`. The call leaves the parent's sandbox through the
// one door it has (the egress proxy, at its lease — operator.ts), and the
// worker runs the job as a step of its own: its own pod, its own `tools:`,
// `secrets:` and `network:` from its own file, NOT cut to the parent's — the
// parent may hold less. The parent waits and gets the reply text. What the
// sub-agent wrote reaches the workspace when it finishes, and comes back with
// the reply into the parent's sandbox too (copyBackFiles), so the parent's
// model and its `verify:` see it there: a `verify: file:` on the delegating
// step used to fail on a file the job had written (owner, 23 Oct 2026). What
// is too large to send back still reaches the workspace for the next step.
//
// Depth one, as for every sub-agent: the job's own `subagents:` are not
// offered to it. Its record sits in the run after the parent's, marked
// `subagentOf` (store.ts), with its own cost and trace.
//
// With no channel (a container step on an install without a proxy) the tools
// are not granted at all; the runner says so on the step.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { DelegationResult, OperatorChannel } from "./operator.ts";
import type { EventExtra } from "./step-exec.ts";
import { delegateToolName, type DelegateSpec } from "./subagents.ts";

export const DELEGATE_SERVER = "foldrun_delegate";
/** A job handed over is at most this long — the sub-agent's prompt. */
export const JOB_MAX = 20_000;
/** What comes back is cut here: the reply is the parent's context. */
export const REPLY_MAX = 40_000;

/** What one job's files may add up to when copied back into the parent's
 *  sandbox, and the most files. They travel with the reply through the
 *  operator store, so the cap is on the raw bytes before base64. */
export const COPY_BACK_MAX_BYTES = 4 * 1024 * 1024;
export const COPY_BACK_MAX_FILES = 100;

/** A workspace-relative path that stays inside the workspace. */
function insideRel(rel: string): string | null {
  const norm = path.posix.normalize(String(rel).replaceAll("\\", "/"));
  if (!norm || norm === "." || norm.startsWith("../") || norm === ".." || path.posix.isAbsolute(norm)) return null;
  return norm;
}

/** Read what a job wrote, on the host, for the trip back to the parent's
 *  sandbox: files only (no links), confined to the workspace, until the cap.
 *  What does not fit is named, never cut. */
export function readCopyBack(workspaceDir: string, wrote: string[]): { files: { path: string; base64: string }[]; omitted: string[] } {
  const files: { path: string; base64: string }[] = [];
  const omitted: string[] = [];
  let total = 0;
  const root = path.resolve(workspaceDir);
  let realRoot: string;
  try {
    realRoot = fs.realpathSync(root);
  } catch {
    return { files, omitted };
  }
  for (const w of [...new Set(wrote)]) {
    const rel = insideRel(w);
    if (!rel) continue;
    const abs = path.join(root, rel);
    let st: fs.Stats;
    try {
      st = fs.lstatSync(abs);
      // A directory link on the way must not lead out of the workspace:
      // what is read here goes into another sandbox (Codex review).
      const real = fs.realpathSync(abs);
      if (real !== realRoot && !real.startsWith(realRoot + path.sep)) continue;
    } catch {
      continue; // written then removed by the job
    }
    if (!st.isFile()) continue;
    if (files.length >= COPY_BACK_MAX_FILES || total + st.size > COPY_BACK_MAX_BYTES) {
      omitted.push(rel);
      continue;
    }
    const buf = fs.readFileSync(abs);
    total += buf.length;
    files.push({ path: rel, base64: buf.toString("base64") });
  }
  return { files, omitted };
}

/** Where a sandbox notes what was copied back into it: path → sha256 of the
 *  bytes written. The step's copy-out reads it (run-container.ts
 *  applyContainerChanges) as what those files held before the step touched
 *  them, so a job's change already on the workspace is not applied twice.
 *  Under .foldrun/, which is never copied back as content. */
export const COPY_BACK_MANIFEST = ".foldrun/copied-back.json";

const sha256 = (b: Buffer) => crypto.createHash("sha256").update(b).digest("hex");

const exists = (p: string) => {
  try {
    fs.lstatSync(p);
    return true;
  } catch {
    return false;
  }
};

/** The manifest's folder and file, unless either is something other than a
 *  real directory and file — a link planted there is never followed. */
function manifestPath(root: string): string | null {
  const dir = path.join(root, path.dirname(COPY_BACK_MANIFEST));
  const file = path.join(root, COPY_BACK_MANIFEST);
  try {
    if (!fs.lstatSync(dir).isDirectory()) return null;
  } catch {
    return file; // neither exists yet
  }
  try {
    if (!fs.lstatSync(file).isFile()) return null;
  } catch {
    /* new file */
  }
  return file;
}

function writeManifest(root: string, manifest: Record<string, string>): void {
  const file = manifestPath(root);
  if (!file) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(manifest), { flag: "w" });
}

/** The manifest of a sandbox's workspace, or {}. */
export function readCopyBackManifest(workspaceRoot: string): Record<string, string> {
  const file = manifestPath(path.resolve(workspaceRoot));
  if (!file) return {};
  try {
    const m = JSON.parse(fs.readFileSync(file, "utf8"));
    return m && typeof m === "object" && !Array.isArray(m) ? (m as Record<string, string>) : {};
  } catch {
    return {};
  }
}

/** Write a job's files into this sandbox's workspace. A path that would leave
 *  it, or land through a link, is refused. A file the step itself changed
 *  since `since` (its own edit, not one copied back) is not overwritten: the
 *  job's version goes beside it as `<name>.from-<agent><ext>`. */
export function copyBackFiles(
  workspaceRoot: string,
  files: { path: string; base64: string }[],
  opts: { since?: number; from?: string } = {},
): { copied: string[]; conflicts: { path: string; copy: string }[] } {
  const root = path.resolve(workspaceRoot);
  const manifest = readCopyBackManifest(root);
  const copied: string[] = [];
  const conflicts: { path: string; copy: string }[] = [];
  // Every directory on the way must be a real one inside the workspace: a
  // link the step planted must not carry the write elsewhere.
  const safeDirs = (abs: string): boolean => {
    let dir = path.dirname(abs);
    const chain: string[] = [];
    while (dir.startsWith(root + path.sep)) {
      chain.unshift(dir);
      dir = path.dirname(dir);
    }
    for (const d of chain) {
      try {
        if (!fs.lstatSync(d).isDirectory()) return false;
      } catch {
        fs.mkdirSync(d);
      }
    }
    return true;
  };
  for (const f of files) {
    const rel = insideRel(f.path);
    if (!rel) continue;
    let target = rel;
    let abs = path.join(root, rel);
    if (!safeDirs(abs)) continue;
    let st: fs.Stats | null = null;
    try {
      st = fs.lstatSync(abs);
    } catch {
      /* new file */
    }
    if (st && !st.isFile()) continue;
    const bytes = Buffer.from(f.base64, "base64");
    if (st) {
      const now = fs.readFileSync(abs);
      if (now.equals(bytes)) {
        manifest[rel] = sha256(bytes);
        copied.push(rel);
        continue;
      }
      const ours = manifest[rel] === sha256(now);
      const editedHere = !ours && opts.since !== undefined && st.mtimeMs > opts.since;
      if (editedHere) {
        // A name nothing has yet: an earlier conflict copy may be the step's
        // own work by now (Codex review).
        const ext = path.posix.extname(rel);
        const stem = `${rel.slice(0, rel.length - ext.length)}.from-${(opts.from ?? "subagent").replace(/[^A-Za-z0-9_-]/g, "-")}`;
        for (let n = 1; ; n++) {
          target = `${stem}${n === 1 ? "" : `-${n}`}${ext}`;
          abs = path.join(root, target);
          if (!exists(abs)) break;
        }
        // Not in the manifest: this copy is not on the workspace yet, and
        // the copy-out must carry it there.
        fs.writeFileSync(abs, bytes);
        conflicts.push({ path: rel, copy: target });
        continue;
      }
    }
    fs.writeFileSync(abs, bytes);
    manifest[rel] = sha256(bytes);
    copied.push(rel);
  }
  if (copied.length || conflicts.length) writeManifest(root, manifest);
  return { copied, conflicts };
}

type Emit = (type: "text" | "tool" | "info" | "error", text: string, extra?: EventExtra) => void;

/** The granted names, the same on every path. */
export function delegateToolNames(specs: DelegateSpec[]): string[] {
  return specs.map((s) => `mcp__${DELEGATE_SERVER}__${delegateToolName(s.name)}`);
}

/** The reply as the parent reads it: the sub-agent's words, then what it
 *  changed — `copied` are the paths now in this sandbox too. */
export function replyText(name: string, r: DelegationResult, copied: string[] = [], conflicts: { path: string; copy: string }[] = []): string {
  const body = r.result.trim() || "(no reply)";
  const cut = body.length > REPLY_MAX ? `${body.slice(0, REPLY_MAX)}\n…(cut at ${REPLY_MAX} characters)` : body;
  const here = new Set([...copied, ...conflicts.map((c) => c.path)]);
  const elsewhere = (r.wrote ?? []).filter((w) => !here.has(w));
  const wrote =
    (copied.length
      ? `\n\nFiles ${name} changed, copied into your sandbox at the same paths:\n${copied.slice(0, 200).map((w) => `- ${w}`).join("\n")}`
      : "") +
    (conflicts.length
      ? `\n\nFiles you had changed yourself, which ${name} changed too — yours are kept; its version is beside each:\n${conflicts.slice(0, 200).map((c) => `- ${c.path} → ${c.copy}`).join("\n")}`
      : "") +
    (elsewhere.length
      ? `\n\nFiles ${name} changed that are not in your sandbox (too large to copy back — in the workspace from the next step on):\n${elsewhere.slice(0, 200).map((w) => `- ${w}`).join("\n")}`
      : "");
  const head = r.status === "completed" ? "" : `${name} did not finish (${r.status}). What it said:\n`;
  return head + cut + wrote;
}

export function buildDelegateTools(opts: {
  specs: DelegateSpec[];
  channel: OperatorChannel | null;
  emit: Emit;
  /** The most one job may run; the step's own timeout bounds it anyway. */
  timeoutSec?: number;
  /** This sandbox's workspace: where a job's files are copied back. Absent
   *  in-process, where the job wrote the same workspace already. */
  workspaceRoot?: string;
  now?: () => number;
}) {
  const now = opts.now ?? Date.now;
  // Anything in this sandbox newer than this, the step changed itself.
  const startedAt = Date.now();
  const channel = opts.channel;
  if (!opts.specs.length || !channel?.delegate || !channel.delegation) {
    return { server: null, toolNames: [] as string[], calls: {} as Record<string, (job: string) => Promise<unknown>> };
  }
  const text = (t: string, isError = false) => ({ content: [{ type: "text" as const, text: t }], ...(isError ? { isError: true } : {}) });
  const run = async (s: DelegateSpec, rawJob: string) => {
    const job = String(rawJob ?? "").trim().slice(0, JOB_MAX);
    if (!job) return text(`${delegateToolName(s.name)} needs the job, written out in full.`, true);
    let id: string;
    try {
      ({ id } = await channel.delegate!(s.name, job));
    } catch (err) {
      return text(`Could not hand ${s.name} the job: ${err instanceof Error ? err.message : String(err)}`, true);
    }
    opts.emit("info", `delegating to ${s.name} (own sandbox): ${job.split("\n")[0].slice(0, 160)}`, { subagent: s.name });
    const deadline = opts.timeoutSec ? now() + opts.timeoutSec * 1000 : Infinity;
    while (now() < deadline) {
      let got: DelegationResult | null = null;
      try {
        got = await channel.delegation!(id, Math.min(deadline - now(), 25_000));
      } catch {
        // A dropped long-poll is retried; the job goes on meanwhile.
        await new Promise((r) => setTimeout(r, 2_000));
        continue;
      }
      if (got) {
        let copied: string[] = [];
        let conflicts: { path: string; copy: string }[] = [];
        if (opts.workspaceRoot && got.files?.length) {
          try {
            ({ copied, conflicts } = copyBackFiles(opts.workspaceRoot, got.files, { since: startedAt, from: s.name }));
          } catch (err) {
            opts.emit("error", `could not copy ${s.name}'s files into this sandbox: ${err instanceof Error ? err.message : String(err)}`, { subagent: s.name });
          }
        }
        const back = copied.length || conflicts.length
          ? `; ${copied.length} copied into this sandbox${conflicts.length ? `, ${conflicts.length} kept beside the step's own edit` : ""}`
          : "";
        opts.emit(got.status === "completed" ? "info" : "error", `${s.name} ${got.status}${got.wrote?.length ? ` — changed ${got.wrote.length} file(s)${back}` : ""}`, { subagent: s.name });
        return text(replyText(s.name, got, opts.workspaceRoot ? copied : (got.wrote ?? []), conflicts), got.status !== "completed");
      }
    }
    try {
      await channel.cancelDelegation?.(id);
    } catch {
      /* the worker ends it with the step */
    }
    return text(`${s.name} did not finish in time; its job was stopped.`, true);
  };
  const tools = opts.specs.map((s) =>
    tool(
      delegateToolName(s.name),
      `Hand ${s.name} a whole job: ${s.description} It works in its own sandbox with its own tools and returns its reply — ` +
        `it has not read your conversation, so write the job out in full: what to do, what to return, where to put files.`,
      { job: z.string().describe("The complete, self-contained job") },
      async ({ job }) => run(s, job),
    ),
  );
  return {
    server: createSdkMcpServer({ name: DELEGATE_SERVER, version: "1.0.0", tools }),
    toolNames: delegateToolNames(opts.specs),
    /** Each tool's own function, by agent name, for tests. */
    calls: Object.fromEntries(opts.specs.map((s) => [s.name, (job: string) => run(s, job)])),
  };
}

/** The channel for a step that runs in this process (`foldrun run`): no
 *  proxy between it and the drive loop, so a job is handed over directly. */
export function localDelegateChannel(
  run: (agent: string, job: string, cancelled: () => boolean) => Promise<DelegationResult>,
): OperatorChannel {
  const jobs = new Map<string, { done: Promise<DelegationResult>; result?: DelegationResult; cancelled: boolean }>();
  let n = 0;
  const none = async () => {
    throw new Error("nobody can answer here");
  };
  return {
    ask: none,
    poll: async () => null,
    inbox: async () => [],
    async delegate(agent, job) {
      const id = `local-${++n}`;
      const entry: { done: Promise<DelegationResult>; result?: DelegationResult; cancelled: boolean } = {
        cancelled: false,
        done: Promise.resolve(),
      } as never;
      entry.done = run(agent, job, () => entry.cancelled)
        .catch((err): DelegationResult => ({ status: "failed", result: err instanceof Error ? err.message : String(err) }))
        .then((r) => (entry.result = r));
      jobs.set(id, entry);
      return { id };
    },
    async delegation(id, maxMs) {
      const entry = jobs.get(id);
      if (!entry) return { status: "skipped", result: "no such job" };
      if (entry.result) return entry.result;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const r = await Promise.race([
        entry.done,
        new Promise<null>((res) => (timer = setTimeout(() => res(null), Math.max(0, maxMs)))),
      ]);
      clearTimeout(timer);
      return r;
    },
    async cancelDelegation(id) {
      const entry = jobs.get(id);
      if (entry) entry.cancelled = true;
    },
  };
}

/** The line the delegating step's prompt carries, so the model knows who
 *  works where. */
export function delegatePromptLine(specs: DelegateSpec[]): string {
  return (
    `<isolated-subagents>\nThese colleagues work in their own sandbox, with their own tools; call the tool to hand one a job ` +
    `and you get back its reply, with the files it changed copied into your sandbox at the same paths:\n` +
    specs.map((s) => `- ${delegateToolName(s.name)}: ${s.description}`).join("\n") +
    `\n</isolated-subagents>`
  );
}
