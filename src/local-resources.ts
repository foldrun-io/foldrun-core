// CPU and memory on a person's own computer (FOL-240, slice 1): the same fields as the cloud — an agent's `size:` and
// `resources:` — read with the cloud's own functions (resolveResources, readResources), set against what this computer
// allows. The computer's budget is the person's answer, kept on the computer and never in a project's files; the limit
// in force is the lower of the two. Every open session draws on the one budget, so each records what it holds.
//
// This slice detects, resolves and reports. Holding a limit is the backends' (slice 2: the macOS watchdog, sampled;
// slice 3: a Linux cgroup): until one is on, a report says the limit is not yet held, never that it is.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { anyMemoryMi, quantityMi, readResources } from "./resources.ts";
import { resolveResources } from "./run-container.ts";

export type BudgetChoice = "light" | "balanced" | "most" | "none";
export const BUDGET_CHOICES: readonly BudgetChoice[] = ["light", "balanced", "most", "none"];
const SHARE: Record<Exclude<BudgetChoice, "none">, number> = { light: 0.25, balanced: 0.5, most: 0.75 };

/** What this computer has. */
export interface Computer {
  os: NodeJS.Platform;
  cores: number;
  memoryMi: number;
}

/** A budget: cores and memory, or none (no limit). */
export interface Budget {
  cpu: number | null;
  memoryMi: number | null;
}

export function detectComputer(): Computer {
  const cores = typeof os.availableParallelism === "function" ? os.availableParallelism() : os.cpus().length;
  return { os: process.platform, cores: Math.max(1, cores), memoryMi: Math.floor(os.totalmem() / 2 ** 20) };
}

/** What each answer to the start question means on this computer: a share of what is left after room for the system
 *  (one core, and 2 GiB or a quarter of the memory, whichever is less), rounded to half cores and 256 MiB. */
export function budgetFor(choice: BudgetChoice, c: Computer): Budget {
  if (choice === "none") return { cpu: null, memoryMi: null };
  const roomCores = Math.max(1, c.cores - 1);
  const roomMi = Math.max(1024, c.memoryMi - Math.min(2048, Math.floor(c.memoryMi / 4)));
  const share = SHARE[choice];
  return {
    cpu: Math.max(0.5, Math.round(roomCores * share * 2) / 2),
    memoryMi: Math.max(512, Math.floor((roomMi * share) / 256) * 256),
  };
}

/** A budget written as `cpu=2,memory=4Gi` (FOLDRUN_CODE_RESOURCES, a saved answer), `off`, or a choice's name. */
export function parseBudget(raw: string, c: Computer): { budget: Budget } | { problem: string } {
  const t = raw.trim().toLowerCase();
  if (t === "off" || t === "none") return { budget: { cpu: null, memoryMi: null } };
  if ((BUDGET_CHOICES as readonly string[]).includes(t)) return { budget: budgetFor(t as BudgetChoice, c) };
  const out: Budget = { cpu: null, memoryMi: null };
  for (const part of raw.split(",").map((x) => x.trim()).filter(Boolean)) {
    const m = /^(cpu|memory)\s*=\s*(.+)$/i.exec(part);
    if (!m) return { problem: `"${part}" — write cpu=2,memory=4Gi, or off` };
    if (m[1].toLowerCase() === "cpu") {
      const n = Number(m[2]);
      if (!(n >= 0.5) || n > c.cores) return { problem: `cpu=${m[2]} — between 0.5 and this computer's ${c.cores} cores` };
      out.cpu = n;
    } else {
      const mi = quantityMi(m[2].trim());
      if (!Number.isFinite(mi) || mi < 256 || mi > c.memoryMi) return { problem: `memory=${m[2]} — between 256Mi and this computer's ${formatMi(c.memoryMi)} (written like 4Gi or 512Mi)` };
      out.memoryMi = mi;
    }
  }
  return { budget: out };
}

/** What an agent asks for, from its own fields: null when it writes neither `size:` nor `resources:`. */
export function agentAsks(front: Record<string, unknown>): { ask: Budget | null; problems: string[] } {
  const size = front.size;
  const raw = front.resources;
  if (size === undefined && raw === undefined) return { ask: null, problems: [] };
  const problems: string[] = [];
  const cls = size === "small" || size === "large" || size === "heavy" ? size : undefined;
  if (size !== undefined && !cls) problems.push(`size: ${String(size)} — small, large or heavy`);
  const read = raw === undefined ? { value: {}, problems: [] } : readResources(raw);
  problems.push(...read.problems);
  const r = resolveResources(cls, read.value);
  const cpu = Number(r.cpus);
  const mi = anyMemoryMi(r.memory);
  return { ask: { cpu: Number.isFinite(cpu) ? cpu : null, memoryMi: Number.isFinite(mi) ? mi : null }, problems };
}

const lower = (a: number | null, b: number | null) => (a === null ? b : b === null ? a : Math.min(a, b));

/** One resource's row: what is asked, what this computer and session allow, what is in force, how it is held. */
export interface ResourceRow {
  resource: "cpu" | "memory";
  asked: number | null;
  allowed: number | null;
  inForce: number | null;
  /** The agent asked for more than is allowed here: it runs at `inForce` only after the person agrees. */
  over: boolean;
  held: "not yet held" | "sampled" | "enforced" | "no limit";
}

/** The limit in force: the lowest of the computer's budget, the session's own ceiling and what the agent asks. */
export function resolveLocal(o: { budget: Budget; session?: Budget | null; ask: Budget | null; held?: { cpu: ResourceRow["held"]; memory: ResourceRow["held"] } }): ResourceRow[] {
  const allowed = { cpu: lower(o.budget.cpu, o.session?.cpu ?? null), memoryMi: lower(o.budget.memoryMi, o.session?.memoryMi ?? null) };
  const row = (resource: "cpu" | "memory", asked: number | null, allow: number | null): ResourceRow => {
    const inForce = asked === null ? allow : lower(asked, allow);
    const held = inForce === null ? "no limit" : (o.held?.[resource] ?? "not yet held");
    return { resource, asked, allowed: allow, inForce, over: asked !== null && allow !== null && asked > allow, held };
  };
  return [row("cpu", o.ask?.cpu ?? null, allowed.cpu), row("memory", o.ask?.memoryMi ?? null, allowed.memoryMi)];
}

export function formatMi(mi: number): string {
  return mi >= 1024 ? `${Number((mi / 1024).toFixed(1))} GiB` : `${Math.round(mi)} MiB`;
}

export function formatCpu(n: number): string {
  return `${n} core${n === 1 ? "" : "s"}`;
}

// ---- What every open session holds, so all of them draw on one budget (a crashed session's record is dropped). ----

export interface SessionHold {
  pid: number;
  folder: string;
  cpu: number | null;
  memoryMi: number | null;
  since: string;
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
};

/** Record this process's hold in `dir` (one file per session, 0600); returns how to take it back. */
export function recordHold(dir: string, hold: Omit<SessionHold, "pid" | "since">): () => void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, `${process.pid}.json`);
  fs.writeFileSync(file, JSON.stringify({ ...hold, pid: process.pid, since: new Date().toISOString() }), { mode: 0o600 });
  return () => {
    try {
      fs.rmSync(file, { force: true });
    } catch {
      /* gone */
    }
  };
}

/** Every live session's hold; the records of sessions that are gone are removed. */
export function readHolds(dir: string): SessionHold[] {
  let names: string[] = [];
  try {
    names = fs.readdirSync(dir).filter((n) => /^\d+\.json$/.test(n));
  } catch {
    return [];
  }
  const out: SessionHold[] = [];
  for (const n of names) {
    const file = path.join(dir, n);
    try {
      const h = JSON.parse(fs.readFileSync(file, "utf8")) as SessionHold;
      if (typeof h.pid === "number" && String(h.pid) === n.slice(0, -5) && alive(h.pid)) out.push(h);
      else fs.rmSync(file, { force: true });
    } catch {
      try {
        fs.rmSync(file, { force: true });
      } catch {
        /* another session took it */
      }
    }
  }
  return out;
}
