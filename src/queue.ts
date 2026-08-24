// The run queue. A job is a file; claiming it is renaming it. That is the
// whole mechanism, and it is chosen to match how everything else here works:
// the run record on disk is already the source of truth for a run's state,
// so the queue only has to remember one thing the record cannot — that
// nobody is driving this run yet.
//
// Layout, under dataRoot():
//
//   queue/
//   ├── pending/<startedMs>-<tenant>.json     waiting for a worker
//   └── claimed/<startedMs>-<tenant>.json     a worker is driving it
//
// rename() within one filesystem is atomic, so two workers racing for the
// same job cannot both win: one rename succeeds, the other throws ENOENT and
// moves on. There are no locks, no leases and no heartbeats — this queue
// serves one host, and on that host a claimed job whose worker died is
// recovered by the only sweep that can be wrong about it: the one at boot,
// before any worker has started. (Multi-host is a different product tier and
// a different queue.)
//
// The timestamp prefix makes a plain directory listing FIFO. The tenant in
// the name is cosmetic — the job body is authoritative.

import fs from "node:fs";
import path from "node:path";
import { dataRoot } from "./paths.ts";
import {
  listTenants,
  listWorkspaces,
  listRuns,
  readRun,
  type FlowStep,
  type RunRecord,
} from "./store.ts";
import { createFlowRun, driveRun } from "./runner.ts";
import { assertFunds, recordRunCost } from "./ledger.ts";
import { runCost } from "./store.ts";

export interface QueueJob {
  tenant: string;
  workspace: string;
  runId: string;
  modelOverride?: string | null;
  tags?: string[];
}

function queueDir(state: "pending" | "claimed") {
  return path.join(dataRoot(), "queue", state);
}

function jobFileName(job: QueueJob) {
  // Millisecond prefix for FIFO ordering; runId for uniqueness (it already
  // carries its own randomness). Re-enqueueing the same run overwrites any
  // pending file for it — see enqueue().
  return `${Date.now().toString().padStart(14, "0")}-${job.runId}.json`;
}

/** A pending job for this run, if one exists. Claimed jobs don't count — the
 *  run is being driven, which is not a state enqueueing should duplicate. */
function pendingFileFor(runId: string): string | null {
  const dir = queueDir("pending");
  if (!fs.existsSync(dir)) return null;
  const hit = fs.readdirSync(dir).find((f) => f.endsWith(`-${runId}.json`));
  return hit ? path.join(dir, hit) : null;
}

function enqueue(job: QueueJob) {
  const dir = queueDir("pending");
  fs.mkdirSync(dir, { recursive: true });

  // One pending job per run, ever. Approving two steps in quick succession,
  // or reconcile racing the approval API, must not line the same run up
  // twice — driveRun on an already-finished record would find no pending
  // steps and mark everything skipped.
  const existing = pendingFileFor(job.runId);
  if (existing) return;

  const file = path.join(dir, jobFileName(job));
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(job, null, 2));
  fs.renameSync(tmp, file);
}

/**
 * Create a `queued` run and line it up for a worker. The record exists on
 * disk before the job does, so a claimed job always finds its run.
 */
export function enqueueFlowRun(
  tenant: string,
  workspace: string,
  steps: FlowStep[],
  flowName: string,
  modelOverride?: string | null,
  tags: string[] = [],
): RunRecord {
  // Money is checked where work is added, and only where work is added —
  // resuming a parked run skips this on purpose. No-op unless the install
  // enforces billing (MDAGENT_BILLING=1).
  assertFunds(tenant);
  const run = createFlowRun(tenant, workspace, steps, flowName, "queued", tags);
  enqueue({ tenant, workspace, runId: run.id, modelOverride, tags });
  return run;
}

/**
 * Line an existing run back up — the approval API calls this for a parked
 * run once a decision lands. driveRun re-enters on the record as saved, so
 * the job carries no model override: a resumed step's model was already
 * resolved onto the record's events the first time through, and the
 * override, if any, came from the flow file which is re-read regardless.
 */
export function enqueueResume(tenant: string, workspace: string, runId: string) {
  enqueue({ tenant, workspace, runId });
}

/** Claim the oldest pending job, or null. Loses every race gracefully. */
export function claimNext(): { job: QueueJob; claimedFile: string } | null {
  const pending = queueDir("pending");
  if (!fs.existsSync(pending)) return null;
  for (const name of fs.readdirSync(pending).sort()) {
    if (!name.endsWith(".json")) continue;
    const from = path.join(pending, name);
    const to = path.join(queueDir("claimed"), name);
    fs.mkdirSync(queueDir("claimed"), { recursive: true });
    try {
      fs.renameSync(from, to);
    } catch {
      continue; // someone else claimed it between readdir and rename
    }
    try {
      const job = JSON.parse(fs.readFileSync(to, "utf8")) as QueueJob;
      return { job, claimedFile: to };
    } catch {
      fs.rmSync(to, { force: true }); // unreadable job — drop it, the run
      continue; //                       record survives for reconcile to see
    }
  }
  return null;
}

export interface QueueRecovery {
  requeued: string[];
  dropped: string[];
}

/**
 * Boot-time sweep, before any worker starts. Two repairs:
 *
 * - claimed/ is emptied back into pending/. On a single host, a claimed job
 *   with no live worker process is an interrupted one; re-driving is safe
 *   because driveRun continues a partly-finished record rather than
 *   restarting it. (reconcileRuns will separately have failed the steps that
 *   were mid-flight, which is correct — their processes are gone.)
 *
 * - every `queued` run with no job file gets one. The record is authority;
 *   a lost queue directory must not strand runs in `queued` forever.
 *
 * Also drops pending jobs whose run is already terminal — the inverse
 * orphan, from an approval decided while its resume job still sat pending.
 */
export function recoverQueue(): QueueRecovery {
  const requeued: string[] = [];
  const dropped: string[] = [];

  const claimed = queueDir("claimed");
  if (fs.existsSync(claimed)) {
    for (const name of fs.readdirSync(claimed)) {
      if (!name.endsWith(".json")) continue;
      fs.mkdirSync(queueDir("pending"), { recursive: true });
      try {
        fs.renameSync(path.join(claimed, name), path.join(queueDir("pending"), name));
        requeued.push(name);
      } catch {
        // a racing recovery already moved it
      }
    }
  }

  const pending = queueDir("pending");
  if (fs.existsSync(pending)) {
    for (const name of fs.readdirSync(pending)) {
      if (!name.endsWith(".json")) continue;
      const file = path.join(pending, name);
      try {
        const job = JSON.parse(fs.readFileSync(file, "utf8")) as QueueJob;
        const run = readRun(job.tenant, job.workspace, job.runId);
        if (!run || run.status === "completed" || run.status === "failed") {
          fs.rmSync(file, { force: true });
          dropped.push(name);
        }
      } catch {
        fs.rmSync(file, { force: true });
        dropped.push(name);
      }
    }
  }

  for (const tenant of listTenants()) {
    for (const workspace of listWorkspaces(tenant)) {
      for (const summary of listRuns(tenant, workspace.name)) {
        if (summary.status !== "queued") continue;
        if (pendingFileFor(summary.id)) continue;
        enqueue({ tenant, workspace: workspace.name, runId: summary.id, tags: summary.tags });
        requeued.push(summary.id);
      }
    }
  }

  return { requeued, dropped };
}

// How many runs drive at once. A run is mostly waiting on a model, so this
// is about memory and fairness, not CPU. Overridable per install.
function concurrency() {
  const n = Number(process.env.MDAGENT_CONCURRENCY);
  return Number.isInteger(n) && n > 0 ? n : 2;
}

const POLL_MS = 1000;

let started = false;

/**
 * The worker loop: claim → drive → delete the job. One per process, started
 * beside the scheduler. Parked and finished runs both end with the job file
 * deleted — for a parked run the *approval* mints the next job, so a job in
 * claimed/ always means "a driver is (or died) on it", never "waiting".
 */
export function startWorker() {
  if (started || process.env.MDAGENT_DISABLE_WORKER === "1") return;
  started = true;

  let inFlight = 0;

  const tick = () => {
    while (inFlight < concurrency()) {
      const claim = claimNext();
      if (!claim) return;
      inFlight += 1;

      void (async () => {
        try {
          const { tenant, workspace, runId, modelOverride, tags } = claim.job;
          const run = readRun(tenant, workspace, runId);
          // Drive anything not finished and not still waiting on a person.
          // `queued` and (via boot recovery) `running` trivially qualify; a
          // parked run qualifies once no step is still asking — and if one
          // still is, dropping the job is right, because the decision that
          // resolves it will enqueue a fresh one.
          const stillAsking = run?.steps.some((s) => s.status === "awaiting-approval");
          if (run && run.status !== "completed" && run.status !== "failed" && !stillAsking) {
            await driveRun(tenant, workspace, run, modelOverride, tags ?? run.tags ?? [], {
              parkOnApproval: true,
            });
            // Settle the bill once the run is genuinely over. Idempotent by
            // run id, so a parked run settling on its *final* drive is safe
            // even if an earlier drive raced it.
            const settled = readRun(tenant, workspace, runId);
            if (settled && (settled.status === "completed" || settled.status === "failed")) {
              recordRunCost(tenant, workspace, runId, runCost(settled));
            }
          }
        } catch (err) {
          console.error(`[mdagent] worker: run ${claim.job.runId} threw`, err);
        } finally {
          fs.rmSync(claim.claimedFile, { force: true });
          inFlight -= 1;
        }
      })();
    }
  };

  setInterval(tick, POLL_MS).unref();
  tick();
}
