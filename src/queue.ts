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
  workspaceDir,
  listFlows as listWorkspaceFlows,
  readRun,
  writeRun,
  type FlowStep,
  type RunRecord,
} from "./store.ts";
import { createFlowRun, driveRun } from "./runner.ts";
import { killRunSandboxes } from "./run-container.ts";
import { killRunPods } from "./run-k8s.ts";
import { accrueDaily, assertFunds, billingEnabled, recordRunCost } from "./ledger.ts";
import { sendRunNotification } from "./notify.ts";
import { runMeter } from "./store.ts";
import { accountUsage } from "./usage.ts";

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

/**
 * Admitted-but-unsettled runs for a tenant: every job still sitting in
 * pending/ or claimed/ is money the platform has agreed to spend and not
 * yet counted. assertFunds takes this so a burst of enqueues cannot each
 * be judged against the same untouched balance — the job files themselves
 * are the record of what's already been admitted, which is the queue's one
 * fact the ledger cannot know.
 */
/** Runs of this tenant actually executing right now — status running, on
 *  disk, which is the record every process agrees on. */
function countRunning(tenant: string): number {
  let n = 0;
  for (const ws of listWorkspaces(tenant)) {
    for (const r of listRuns(tenant, ws.name)) if (r.status === "running") n += 1;
  }
  return n;
}

function countInFlight(tenant: string): number {
  let n = 0;
  for (const state of ["pending", "claimed"] as const) {
    const dir = queueDir(state);
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir)) {
      try {
        const job = JSON.parse(fs.readFileSync(path.join(dir, name), "utf8")) as QueueJob;
        if (job.tenant === tenant) n += 1;
      } catch {
        // a torn job file is boot-recovery's problem, not billing's
      }
    }
  }
  return n;
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
  // enforces billing (FOLDRUN_BILLING=1).
  assertFunds(tenant, countInFlight(tenant));
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

/**
 * Stop a run a person no longer wants.
 *
 * Three things, in the order that makes them true: drop any queued job so
 * nothing picks it up next, destroy the sandbox any in-flight step is
 * burning money in, and mark the record. A stop that only set a flag would
 * be a promise to stop *eventually* — a browser step can have fifteen
 * minutes left, and the pod is the thing actually spending.
 *
 * `stopRequested` stays on the record beside the failed status, because
 * "failed" and "someone stopped it" are different facts. The driver reads
 * it at the next group boundary and skips the rest, which is what stops a
 * multi-step flow rather than just its current step.
 *
 * The steps already finished keep their results and their costs: they ran,
 * and the ledger already knows.
 */
export function stopRun(tenant: string, workspace: string, runId: string): RunRecord {
  const run = readRun(tenant, workspace, runId);
  if (!run) throw new Error(`run ${runId} not found`);
  if (run.status === "completed" || run.status === "failed") {
    throw new Error(`run ${runId} already ${run.status} — nothing to stop`);
  }

  const pending = pendingFileFor(runId);
  if (pending) fs.rmSync(pending, { force: true });
  for (const state of ["pending", "claimed"] as const) {
    const dir = queueDir(state);
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir)) {
      if (name.endsWith(`-${runId}.json`)) fs.rmSync(path.join(dir, name), { force: true });
    }
  }

  let killed = 0;
  try {
    killed =
      process.env.FOLDRUN_RUN_ISOLATION === "k8s"
        ? killRunPods(runId)
        : killRunSandboxes(runId);
  } catch {
    // A sandbox we cannot reach must not stop us from stopping the run.
  }

  const now = new Date().toISOString();
  for (const step of run.steps) {
    if (step.status === "pending" || step.status === "running" || step.status === "awaiting-approval") {
      if (step.status === "running") {
        step.events.push({ t: now, type: "error", text: "stopped by a person — sandbox destroyed" });
      }
      step.status = "skipped";
      step.skipReason = "run stopped";
    }
  }
  run.status = "failed";
  run.stopRequested = true;
  run.parkedAt = null;
  run.finishedAt = now;
  run.steps[0]?.events.push({
    t: now,
    type: "info",
    text: killed ? `run stopped — ${killed} sandbox(es) destroyed` : "run stopped",
  });
  writeRun(tenant, workspace, run);
  return run;
}

/**
 * Re-run a finished flow from one of its steps, as a new run.
 *
 * The old record is never mutated — it is history, its outputs are archived
 * under its id, and its ledger line already paid for it. Instead the steps
 * before the chosen one are *carried*: copied with their results so later
 * steps read the same context they would have, marked `carriedFrom` so the
 * meter never bills them twice, their per-step costs zeroed because those
 * dollars are on the original run's line. Everything from the chosen step
 * on is reset to pending and simply runs.
 *
 * Everything after, not just the step itself, because a later step consumed
 * the earlier one's result — an emailer re-sent against a stale extraction
 * is the bug this exists to fix, not a feature.
 *
 * Fan-out instances in the reset range are dropped and their template step
 * restored, so the fan-out re-expands against the fresh result.
 */
export function rerunFrom(
  tenant: string,
  workspace: string,
  runId: string,
  from: { agent?: string; step?: number },
): RunRecord {
  const source = readRun(tenant, workspace, runId);
  if (!source) throw new Error(`run ${runId} not found`);
  if (source.status !== "completed" && source.status !== "failed") {
    throw new Error(`run ${runId} is ${source.status} — only a finished run can be re-run`);
  }

  const idx =
    typeof from.step === "number"
      ? from.step - 1 // 1-based on the API, because the trace numbers steps from 1
      : source.steps.findIndex((s) => s.agent === from.agent && !s.item);
  if (idx < 0 || idx >= source.steps.length) {
    throw new Error(
      from.agent
        ? `no step in run ${runId} runs agent "${from.agent}"`
        : `run ${runId} has no step ${from.step}`,
    );
  }

  assertFunds(tenant, countInFlight(tenant));

  // Re-runs exist to iterate: fix the flow, re-run the step. So the reset
  // steps take their instructions from the flow file as it reads *now*, not
  // as it read when the source run started — a re-run that replays a stale
  // instruction re-fails for the exact reason the author just fixed. Matched
  // positionally over the run's template steps (fan-out instances aside) and
  // only where the agent still agrees; a reshaped flow falls back to the
  // recorded text, because guessing at alignment would rewrite the wrong
  // step's orders. Carried steps keep their history either way — they ran.
  const currentFlow = listWorkspaceFlows(tenant, workspace).find((f) => f.name === source.flow);
  const freshInstruction = (runIdx: number): string | null => {
    if (!currentFlow) return null;
    const templates = source.steps.filter((st) => !st.item);
    if (templates.length !== currentFlow.steps.length) return null;
    const tIdx = templates.indexOf(source.steps[runIdx]);
    const now_ = currentFlow.steps[tIdx];
    return now_ && now_.agent === source.steps[runIdx].agent ? now_.instruction : null;
  };

  const now = new Date().toISOString();
  const steps: RunRecord["steps"] = [];
  for (let i = 0; i < source.steps.length; i++) {
    const s = source.steps[i];
    if (i < idx) {
      steps.push({
        ...s,
        carriedFrom: runId,
        costUsd: null,
        computeSecs: null,
        startupSecs: null,
        events: [
          { t: now, type: "info", text: `carried from ${runId} — ran there, shown here as context` },
        ],
      });
      continue;
    }
    if (s.item) continue; // an instance of a fan-out that will re-expand
    steps.push({
      ...s,
      instruction: freshInstruction(i) ?? s.instruction,
      status: "pending",
      events: [],
      result: null,
      costUsd: null,
      computeSecs: null,
      startupSecs: null,
      attempts: 0,
      skipReason: undefined,
      approvedAt: undefined,
      item: undefined,
      loopRemaining: undefined,
      carriedFrom: undefined,
    });
  }

  const run: RunRecord = {
    id: `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    flow: source.flow,
    tags: source.tags,
    status: "queued",
    startedAt: now,
    finishedAt: null,
    steps,
  };
  writeRun(tenant, workspace, run);
  enqueue({ tenant, workspace, runId: run.id });
  return run;
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
  const n = Number(process.env.FOLDRUN_CONCURRENCY);
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
  if (started || process.env.FOLDRUN_DISABLE_WORKER === "1") return;
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
          // The plan's parallelism, enforced where a run would actually start.
          // At the cap, the job returns to the queue's tail rather than
          // running — admission was already paid for at enqueue; this only
          // decides when, never whether.
          const cap = Number(process.env.FOLDRUN_PLAN_CONCURRENCY);
          if (
            run && run.status !== "completed" && run.status !== "failed" && !stillAsking &&
            Number.isFinite(cap) && cap > 0 && billingEnabled() &&
            countRunning(tenant) >= cap
          ) {
            fs.rmSync(claim.claimedFile, { force: true });
            enqueue(claim.job);
            inFlight -= 1;
            return;
          }
          if (run && run.status !== "completed" && run.status !== "failed" && !stillAsking) {
            await driveRun(tenant, workspace, run, modelOverride, tags ?? run.tags ?? [], {
              parkOnApproval: true,
            });
            // Settle the bill once the run is genuinely over. Idempotent by
            // run id, so a parked run settling on its *final* drive is safe
            // even if an earlier drive raced it.
            const settled = readRun(tenant, workspace, runId);
            if (settled && (settled.status === "completed" || settled.status === "failed")) {
              recordRunCost(tenant, workspace, runId, runMeter(settled));
            }
            // Tell whoever asked to be told. Terminal states and parks alike
            // — "waiting for your approval" is the one message that cannot
            // wait for someone to happen to open the dashboard.
            if (settled) await sendRunNotification(tenant, workspace, settled);
          }
        } catch (err) {
          console.error(`[foldrun] worker: run ${claim.job.runId} threw`, err);
        } finally {
          fs.rmSync(claim.claimedFile, { force: true });
          inFlight -= 1;
        }
      })();
    }
  };

  setInterval(tick, POLL_MS).unref();
  tick();

  // The recurring half of the bill, swept hourly: accrueDaily is idempotent
  // per calendar day, so the schedule here only decides how soon after
  // midnight the line appears — not how many appear.
  const accrue = () => {
    if (!billingEnabled()) return;
    const retentionDays = Number(process.env.FOLDRUN_RETENTION_DAYS);
    const cutoff = Number.isFinite(retentionDays) && retentionDays > 0
      ? Date.now() - retentionDays * 24 * 60 * 60 * 1000
      : null;
    for (const tenant of listTenants()) {
      try {
        const usage = accountUsage(tenant);
        accrueDaily(tenant, usage.totals.storageBytes);
        // The plan's history window. Policy pruning, not a person erasing
        // history, so no per-run ledger note — the charges stand and the
        // ledger itself is never pruned. Live runs are never touched.
        if (cutoff !== null) {
          for (const ws of listWorkspaces(tenant)) {
            for (const r of listRuns(tenant, ws.name)) {
              if ((r.status === "completed" || r.status === "failed") &&
                  r.finishedAt && new Date(r.finishedAt).getTime() < cutoff) {
                const dir = path.join(workspaceDir(tenant, ws.name), "runs");
                fs.rmSync(path.join(dir, `${r.id}.json`), { force: true });
                fs.rmSync(path.join(dir, r.id), { recursive: true, force: true });
              }
            }
          }
        }
      } catch (err) {
        console.error(`[foldrun] accrual for ${tenant} failed`, err);
      }
    }
  };
  setInterval(accrue, 60 * 60 * 1000).unref();
  accrue();
}
