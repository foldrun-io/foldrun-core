// The account's consumption, as a report: what ran, what it used, what it
// cost, and where the bytes live — rolled up from the run records and the
// file stores that already hold every fact, never from a second counter
// that could drift from them.
//
// Two honesties the numbers carry:
//
//   · CPU and RAM are *reservations*, not measurements. A step's pod is
//     scheduled with a CPU and memory limit, and what the platform pays for
//     is that reservation for the sandbox's lifetime — the same quantity
//     Fargate or Cloud Run bills. Actual peak RSS is not recorded, and
//     inventing it would be worse than saying "reserved".
//
//   · Token counts exist only on steps recorded since they were persisted;
//     older steps still carry their dollar cost. The report sums what is
//     there and never extrapolates.

import fs from "node:fs";
import path from "node:path";
import { listWorkspaces, listRuns, workspaceDir, type RunRecord } from "./store.ts";
import { STORAGE_DIR, accountDir } from "./store.ts";
import { ledgerSummary, creditBalance } from "./ledger.ts";

export interface UsageBucket {
  runs: number;
  steps: number;
  tokenCostUsd: number;
  inputTokens: number;
  outputTokens: number;
  computeSecs: number;
  /** Reserved CPU-seconds and GiB-seconds: computeSecs × the pod limits in
   *  force now. Reported as reservation, which is the billable quantity. */
  cpuSecs: number;
  gibSecs: number;
}

export interface WorkspaceUsage extends UsageBucket {
  workspace: string;
  byFlow: Record<string, UsageBucket>;
  byAgent: Record<string, UsageBucket>;
  storage: { sourceBytes: number; filesBytes: number; runsBytes: number };
}

export interface AccountUsage {
  tenant: string;
  generatedAt: string;
  podLimits: { cpus: number; memoryGiB: number };
  totals: UsageBucket & { storageBytes: number };
  workspaces: WorkspaceUsage[];
  ledger: { balanceUsd: number; chargedUsd: number; providerCostUsd: number; marginUsd: number };
}

const bucket = (): UsageBucket => ({
  runs: 0, steps: 0, tokenCostUsd: 0, inputTokens: 0, outputTokens: 0,
  computeSecs: 0, cpuSecs: 0, gibSecs: 0,
});

function podLimits(): { cpus: number; memoryGiB: number } {
  const cpus = Number(process.env.FOLDRUN_RUNNER_CPUS);
  const memRaw = process.env.FOLDRUN_RUNNER_MEMORY ?? "2Gi";
  const m = memRaw.match(/^(\d+(?:\.\d+)?)\s*(Gi?|Mi?|g|m)?/i);
  const n = m ? Number(m[1]) : 2;
  const unit = (m?.[2] ?? "Gi").toLowerCase();
  return {
    cpus: Number.isFinite(cpus) && cpus > 0 ? cpus : 2,
    memoryGiB: unit.startsWith("m") ? n / 1024 : n,
  };
}

// The reservation a step's seconds are priced at. A step records what it
// actually held (`reserved`), because a size is a price: bigger job, more
// GiB-seconds, higher bill — which is what keeps authors honest about asking
// for `heavy`. Steps from before sizes existed have no record, so they fall
// back to the install's flat limit.
function stepLimits(
  s: RunRecord["steps"][number],
  fallback: { cpus: number; memoryGiB: number },
): { cpus: number; memoryGiB: number } {
  return s.reserved ? { cpus: s.reserved.cpus, memoryGiB: s.reserved.memGiB } : fallback;
}

function addRun(b: UsageBucket, run: RunRecord, fallback: { cpus: number; memoryGiB: number }) {
  b.runs += 1;
  for (const s of run.steps) {
    if (s.status !== "completed" && s.status !== "failed") continue;
    if (s.carriedFrom) continue; // ran — and was counted — in another run
    b.steps += 1;
    b.tokenCostUsd += s.costUsd ?? 0;
    b.inputTokens += s.tokens?.input ?? 0;
    b.outputTokens += s.tokens?.output ?? 0;
    const secs = s.computeSecs ?? 0;
    const lim = stepLimits(s, fallback);
    b.computeSecs += secs;
    b.cpuSecs += secs * lim.cpus;
    b.gibSecs += secs * lim.memoryGiB;
  }
}

/** Bytes under a directory. Skips what it cannot stat rather than failing
 *  the report over one unreadable file. */
function du(dir: string): number {
  if (!fs.existsSync(dir)) return 0;
  let total = 0;
  const walk = (d: string) => {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(d, e.name);
      try {
        if (e.isDirectory()) walk(full);
        else if (e.isFile()) total += fs.statSync(full).size;
      } catch { /* unreadable entry — skip */ }
    }
  };
  walk(dir);
  return total;
}

const r2 = (n: number) => Math.round(n * 100) / 100;
const r6 = (n: number) => Math.round(n * 1e6) / 1e6;

function rounded(b: UsageBucket): UsageBucket {
  return {
    ...b,
    tokenCostUsd: r6(b.tokenCostUsd),
    computeSecs: r2(b.computeSecs),
    cpuSecs: r2(b.cpuSecs),
    gibSecs: r2(b.gibSecs),
  };
}

/**
 * What the file store holds, from its index — not from disk. The bytes live
 * wherever the driver put them (R2 on the hosted platform), so a du of the
 * local directory sees only the index and reports a store full of CSVs as
 * one kilobyte. The index records every file's true size and is the same
 * record the Files page lists; a du of the local blobs/ is the fallback for
 * the fs driver's pre-index files.
 */
function fileStoreBytes(tenant: string, workspace: string): number {
  const root = path.join(accountDir(tenant), STORAGE_DIR, workspace);
  const index = path.join(root, "index.json");
  try {
    const parsed = JSON.parse(fs.readFileSync(index, "utf8")) as { files?: { size?: number }[] };
    const list = Array.isArray(parsed) ? parsed : (parsed.files ?? []);
    return list.reduce((sum, f) => sum + (typeof f.size === "number" ? f.size : 0), 0);
  } catch {
    return du(root);
  }
}

export async function accountUsage(tenant: string): Promise<AccountUsage> {
  const limits = podLimits();
  const totals = bucket();
  let storageBytes = 0;
  const workspaces: WorkspaceUsage[] = [];

  for (const ws of listWorkspaces(tenant)) {
    const wsBucket = bucket();
    const byFlow: Record<string, UsageBucket> = {};
    const byAgent: Record<string, UsageBucket> = {};

    for (const run of listRuns(tenant, ws.name)) {
      addRun(wsBucket, run, limits);
      addRun((byFlow[run.flow] ??= bucket()), run, limits);
      // Steps attribute to their agent; the run count on an agent bucket
      // means "runs this agent took part in".
      const seen = new Set<string>();
      for (const s of run.steps) {
        if (s.status !== "completed" && s.status !== "failed") continue;
        if (s.carriedFrom) continue;
        const a = (byAgent[s.agent] ??= bucket());
        if (!seen.has(s.agent)) { a.runs += 1; seen.add(s.agent); }
        a.steps += 1;
        a.tokenCostUsd += s.costUsd ?? 0;
        a.inputTokens += s.tokens?.input ?? 0;
        a.outputTokens += s.tokens?.output ?? 0;
        const secs = s.computeSecs ?? 0;
        const lim = stepLimits(s, limits);
        a.computeSecs += secs;
        a.cpuSecs += secs * lim.cpus;
        a.gibSecs += secs * lim.memoryGiB;
      }
    }

    const dir = workspaceDir(tenant, ws.name);
    const storage = {
      // Source is everything but the run history; runs are their own line
      // because they grow forever and source does not.
      sourceBytes: du(dir) - du(path.join(dir, "runs")),
      filesBytes: fileStoreBytes(tenant, ws.name),
      runsBytes: du(path.join(dir, "runs")),
    };
    storageBytes += storage.sourceBytes + storage.filesBytes + storage.runsBytes;

    totals.runs += wsBucket.runs;
    totals.steps += wsBucket.steps;
    totals.tokenCostUsd += wsBucket.tokenCostUsd;
    totals.inputTokens += wsBucket.inputTokens;
    totals.outputTokens += wsBucket.outputTokens;
    totals.computeSecs += wsBucket.computeSecs;
    totals.cpuSecs += wsBucket.cpuSecs;
    totals.gibSecs += wsBucket.gibSecs;

    workspaces.push({
      workspace: ws.name,
      ...rounded(wsBucket),
      byFlow: Object.fromEntries(Object.entries(byFlow).map(([k, v]) => [k, rounded(v)])),
      byAgent: Object.fromEntries(Object.entries(byAgent).map(([k, v]) => [k, rounded(v)])),
      storage,
    });
  }

  const ledger = await ledgerSummary(tenant);
  return {
    tenant,
    generatedAt: new Date().toISOString(),
    podLimits: limits,
    totals: { ...rounded(totals), storageBytes },
    workspaces: workspaces.sort((a, b) => b.tokenCostUsd - a.tokenCostUsd),
    ledger: { ...ledger, balanceUsd: await creditBalance(tenant) },
  };
}
