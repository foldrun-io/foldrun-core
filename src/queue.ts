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
import { walletGuard, assertWorkspaceBudget } from "./wallet.ts";
import { runComputeMeter, runMeter } from "./store.ts";
import { accountUsage } from "./usage.ts";
import { databaseEnabled, db } from "./db.ts";
import { cacheEnabled, leaseHeld, releaseLease, takeLease } from "./cache.ts";
import {
  claimNextDb,
  enqueueDb,
  hasJobDb,
  inFlightDb,
  recoverStaleDb,
  releaseDb,
  removeDb,
  statsDb,
} from "./queue-db.ts";

export interface QueueJob {
  tenant: string;
  workspace: string;
  runId: string;
  modelOverride?: string | null;
  tags?: string[];
  /** Claimable only from this ISO time — how a `wait:` parks in the queue
   *  instead of in a process. */
  notBefore?: string;
}

function queueDir(state: "pending" | "claimed") {
  return path.join(dataRoot(), "queue", state);
}

function jobFileName(job: QueueJob) {
  // Millisecond prefix for FIFO ordering; runId for uniqueness (it already
  // carries its own randomness). Re-enqueueing the same run overwrites any
  // pending file for it — see await enqueue().
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

async function countInFlight(tenant: string): Promise<number> {
  if (databaseEnabled()) return inFlightDb(tenant);
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

async function enqueue(job: QueueJob) {
  // One pending job per run, ever. Approving two steps in quick succession, or
  // reconcile racing the approval API, must not line the same run up twice —
  // driveRun on an already-finished record would find no pending steps and
  // mark everything skipped. The file queue got this from a filename check;
  // the table gets it from a unique index, which cannot race.
  if (databaseEnabled()) {
    if (await hasJobDb(job.runId)) return;
    await enqueueDb(job);
    return;
  }

  const dir = queueDir("pending");
  fs.mkdirSync(dir, { recursive: true });
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
export async function enqueueFlowRun(
  tenant: string,
  workspace: string,
  steps: FlowStep[],
  flowName: string,
  modelOverride?: string | null,
  tags: string[] = [],
): Promise<RunRecord> {
  // Money is checked where work is added, and only where work is added —
  // resuming a parked run skips this on purpose. No-op unless the install
  // enforces billing (FOLDRUN_BILLING=1).
  assertFunds(tenant, await countInFlight(tenant));
  assertWorkspaceBudget(tenant, workspace);
  const run = createFlowRun(tenant, workspace, steps, flowName, "queued", tags);
  await enqueue({ tenant, workspace, runId: run.id, modelOverride, tags });
  return run;
}

/**
 * Line an existing run back up — the approval API calls this for a parked
 * run once a decision lands. driveRun re-enters on the record as saved, so
 * the job carries no model override: a resumed step's model was already
 * resolved onto the record's events the first time through, and the
 * override, if any, came from the flow file which is re-read regardless.
 */
export async function enqueueResume(tenant: string, workspace: string, runId: string) {
  await enqueue({ tenant, workspace, runId });
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
 * Start a flow from one of its steps, fresh — the current flow file, not a
 * recorded run. The steps before the starting point are marked skipped with
 * the reason on them: they did not run in THIS run, and pretending
 * otherwise would put results in the record that nothing produced. Later
 * steps find their inputs where these flows actually keep them — files/ —
 * which is what makes a partial start meaningful at all.
 *
 * This is also the cheap way to iterate on a late step: fixture runs, with
 * the workspace's own files as the fixtures, without paying for the steps
 * that produce them.
 */
export async function startFlowFromStep(
  tenant: string,
  workspace: string,
  flowName: string,
  fromStep: number, // the step number as the flow file numbers it — a GROUP,
  //                   so "from step 3" keeps all of step 3's parallel agents
): Promise<RunRecord> {
  const flow = listWorkspaceFlows(tenant, workspace).find((f) => f.name === flowName);
  if (!flow) throw new Error(`flow ${flowName} not found`);
  const maxGroup = Math.max(...flow.steps.map((s) => s.group));
  if (fromStep < 1 || fromStep > maxGroup) {
    throw new Error(`flow ${flowName} has no step ${fromStep} (it has ${maxGroup})`);
  }
  assertFunds(tenant, await countInFlight(tenant));
  assertWorkspaceBudget(tenant, workspace);
  const run = createFlowRun(tenant, workspace, flow.steps, flowName, "queued");
  for (const step of run.steps) {
    if (step.group < fromStep) {
      step.status = "skipped";
      step.skipReason = `started from step ${fromStep}`;
    }
  }
  writeRun(tenant, workspace, run);
  await enqueue({ tenant, workspace, runId: run.id });
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
export async function rerunFrom(
  tenant: string,
  workspace: string,
  runId: string,
  from: { agent?: string; step?: number },
): Promise<RunRecord> {
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

  assertFunds(tenant, await countInFlight(tenant));
  assertWorkspaceBudget(tenant, workspace);

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
  await enqueue({ tenant, workspace, runId: run.id });
  return run;
}

/** Claim the oldest pending job, or null. Loses every race gracefully. */
/**
 * Order the pending queue FAIRLY across accounts, not by arrival alone.
 *
 * A plain `readdir().sort()` is FIFO by the timestamp in each filename, which
 * is correct for one account and wrong the moment there are two: an account
 * enqueuing five hundred jobs puts every other customer behind all five
 * hundred of them. That is the difference between "the platform is slow" and
 * "that account is slow", and it is the complaint you cannot answer once you
 * have it.
 *
 * So: round-robin by account, FIFO within each. Every account's oldest job
 * before anyone's second, every account's second before anyone's third. A busy
 * account still finishes all its work and still takes more of the queue than a
 * quiet one — it simply cannot make the quiet one wait behind its whole
 * backlog.
 *
 * The tenant comes from the job BODY, not the filename: the name is
 * `<ms>-<runId>.json` and every runId begins `run-`, so a name-derived tenant
 * would put every account in one bucket and silently degrade to the FIFO this
 * replaces. claimNext already reads each candidate for its notBefore, so this
 * costs the same reads, done once.
 */
export function fairOrder(entries: { name: string; tenant: string }[]): string[] {
  const byTenant = new Map<string, string[]>();
  for (const e of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
    const list = byTenant.get(e.tenant);
    if (list) list.push(e.name);
    else byTenant.set(e.tenant, [e.name]);
  }
  // Accounts taken in the order their OLDEST job arrived, so round-robin does
  // not quietly become alphabetical-by-account.
  const queues = [...byTenant.values()].sort((a, b) => a[0].localeCompare(b[0]));
  const out: string[] = [];
  for (let round = 0; ; round += 1) {
    let moved = false;
    for (const q of queues) {
      if (round < q.length) {
        out.push(q[round]);
        moved = true;
      }
    }
    if (!moved) break;
  }
  return out;
}

/** Pending jobs with the tenant each belongs to, unreadable ones last so a
 *  file caught mid-write is retried rather than dropped from the ordering. */
function pendingWithTenant(dir: string): { name: string; tenant: string }[] {
  const out: { name: string; tenant: string }[] = [];
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith(".json")) continue;
    try {
      const job = JSON.parse(fs.readFileSync(path.join(dir, name), "utf8")) as QueueJob;
      // Held by its own deadline: not a candidate, and not counted against
      // its account's share either.
      if (job.notBefore && new Date(job.notBefore).getTime() > Date.now()) continue;
      out.push({ name, tenant: job.tenant });
    } catch {
      out.push({ name, tenant: "" }); // mid-write; the claim path settles it
    }
  }
  return out;
}

/**
 * Take the next job, or null.
 *
 * `release` replaces the claimed FILE the caller used to delete: with a
 * database the claim is a row, and handing back a closure means the worker
 * does not have to know which store it is talking to — the one place that
 * could get "finished with this job" wrong is here, not at every call site.
 */
export async function claimNext(): Promise<
  { job: QueueJob; release: () => Promise<void> } | null
> {
  if (databaseEnabled()) {
    const job = await claimNextDb(WORKER_OWNER);
    if (!job) return null;
    return {
      job: job as QueueJob,
      release: () => releaseDb(job.runId),
    };
  }

  const pending = queueDir("pending");
  if (!fs.existsSync(pending)) return null;
  // A job with an unexpired notBefore stays where it is: a wait: is a deadline
  // in the queue, and skipping is cheaper than claim-and-repark. That filter
  // now lives in pendingWithTenant, which has to open each job anyway.
  for (const name of fairOrder(pendingWithTenant(pending))) {
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
      return { job, release: async () => fs.rmSync(to, { force: true }) };
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
export async function recoverQueue(): Promise<QueueRecovery> {
  const requeued: string[] = [];
  const dropped: string[] = [];

  if (databaseEnabled()) {
    // Two differences from the file path, and both are the point of the move.
    //
    // A claim carries WHEN it was made, so an abandoned one is recoverable at
    // any time rather than only at boot before any worker starts — which is
    // what lets a second worker pick up after a first is killed, instead of the
    // run waiting for someone to restart the platform.
    //
    // And a run that finished while its job sat there is dropped by asking the
    // record, exactly as before: the queue's one fact is "nobody is driving
    // this yet", and the record is still the source of truth for the rest.
    const stale = await recoverStaleDb(CLAIM_STALE_MS);
    if (stale) requeued.push(`${stale} stale claim(s)`);
    const p = db();
    if (p) {
      const { rows } = await p.query<{ run_id: string; tenant: string; workspace: string }>(
        `SELECT run_id, tenant, workspace FROM queue`,
      );
      for (const r of rows) {
        const run = readRun(r.tenant, r.workspace, r.run_id);
        if (!run || run.status === "completed" || run.status === "failed") {
          await removeDb(r.run_id);
          dropped.push(r.run_id);
        }
      }
    }
    return { requeued, dropped };
  }

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
        await enqueue({ tenant, workspace: workspace.name, runId: summary.id, tags: summary.tags });
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

/** How long a claim may go unrenewed before another worker may take the job.
 *  Longer than any single step's backstop, so a slow run is never stolen from
 *  a worker that is still driving it. */
const CLAIM_STALE_MS = Number(process.env.FOLDRUN_CLAIM_STALE_MS) || 30 * 60_000;

// One worker per data directory, enforced at runtime rather than by a YAML
// comment. Same shape as the scheduler's lease: a file naming its holder,
// renewed each tick, stale after three missed renewals, takeover by
// read-then-write. The worst case is one bounded double-claim attempt during
// a handover — and claimNext's rename already makes a double-claim lose
// cleanly. What this prevents is the quiet catastrophe: a second worker
// replica double-DRIVING every run on shared storage.
// Observed 2026-08-28: Next bundles this module more than once, each bundle
// runs its own worker loop, and they share the lease file — one holds it and
// drains, the others defer. When the holder's interval dies (its bundle was
// torn down) the queue sits idle until the lease goes stale and a surviving
// loop takes over. At 90s that handover window read as a stalled platform —
// runs queued for minutes with healthz green. 30s is still thirty missed
// renewals (the tick is 1s), far beyond jitter, and it bounds the outage a
// dead holder can cause to half a minute.
const WORKER_LEASE_STALE_MS = 30_000;
const WORKER_OWNER = `${process.pid}-${Math.random().toString(36).slice(2, 8)}`;

function workerLeaseFile() {
  return path.join(dataRoot(), ".worker-lease");
}

/**
 * True when this process holds (or just took) the worker lease.
 *
 * Redis when there is one, the file otherwise. The difference is not
 * cosmetic: the file version reads, decides, then writes, so two workers can
 * both read "stale" and both write — its own comment admits the worst case is
 * one bounded double-claim during a handover. `SET NX PX` has no such window,
 * which is what makes more than one worker replica safe at all.
 */
export async function holdsWorkerLease(now = Date.now()): Promise<boolean> {
  if (cacheEnabled()) {
    const state = await takeLease("worker", WORKER_OWNER, WORKER_LEASE_STALE_MS);
    return state.held;
  }

  const file = workerLeaseFile();
  try {
    const current = JSON.parse(fs.readFileSync(file, "utf8")) as { owner: string; renewedAt: number };
    if (current.owner !== WORKER_OWNER && now - current.renewedAt < WORKER_LEASE_STALE_MS) return false;
  } catch {
    // no lease yet, or unreadable — claimable
  }
  // A takeover — the previous holder stopped renewing. Say so: a queue that
  // sat idle through a handover window is otherwise indistinguishable from
  // one that never had work, and this line is how the next stall gets a
  // timestamped trail instead of a shrug.
  try {
    const prev = JSON.parse(fs.readFileSync(file, "utf8")) as { owner: string; renewedAt: number };
    if (prev.owner !== WORKER_OWNER) {
      console.error(
        `[foldrun] worker lease taken over from ${prev.owner} (idle ${Math.round((now - prev.renewedAt) / 1000)}s)`,
      );
    }
  } catch {
    /* no previous lease — first boot */
  }
  const tmp = `${file}.${WORKER_OWNER}`;
  fs.writeFileSync(tmp, JSON.stringify({ owner: WORKER_OWNER, renewedAt: now }));
  fs.renameSync(tmp, file);
  return true;
}

/** Hand the lease back on a clean shutdown, so the next worker starts driving
 *  immediately instead of waiting out the TTL. */
export async function releaseWorkerLease(): Promise<void> {
  if (cacheEnabled()) await releaseLease("worker", WORKER_OWNER);
}

/**
 * Whether a LIVE worker holds the lease on this data directory — a pure
 * read that never writes (a probe taking a stale lease would hold it while
 * running no worker, quietly stopping every run). Deliberately not "is it
 * me": Next bundles this module separately for routes and for the worker's
 * process hook, so identity comparison across bundles always said false.
 * The operational question is that a worker exists, not which copy asked.
 */
export async function peekWorkerLease(now = Date.now()): Promise<boolean> {
  if (cacheEnabled()) return leaseHeld("worker");
  try {
    const current = JSON.parse(fs.readFileSync(workerLeaseFile(), "utf8")) as { renewedAt: number };
    return now - current.renewedAt < WORKER_LEASE_STALE_MS;
  } catch {
    return false;
  }
}

let started = false;

/**
 * The worker loop: claim → drive → delete the job. One per process, started
 * beside the scheduler. Parked and finished runs both end with the job file
 * deleted — for a parked run the *approval* mints the next job, so a job in
 * claimed/ always means "a driver is (or died) on it", never "waiting".
 */
/**
 * Refuse to serve more than one tenant without step isolation.
 *
 * Without FOLDRUN_RUN_ISOLATION, a step runs in the platform's own process:
 * correct on a laptop, where there is nothing to isolate from, and
 * catastrophic for a multi-tenant install, where one tenant's agent would run
 * with the platform's filesystem, its vault and every other tenant's data in
 * reach. Nothing used to refuse that configuration — a missing or misspelled
 * env var degraded silently from "sandboxed" to "shared", and the only symptom
 * was a run trace nobody was reading.
 *
 * So it is a boot condition now, not a footnote. A single-tenant install (the
 * CLI, a developer's box) is unaffected; the moment a second account exists,
 * or FOLDRUN_MULTI_TENANT=1 says one is coming, isolation must be configured.
 */
export function assertIsolationSafe(): void {
  const isolation = process.env.FOLDRUN_RUN_ISOLATION;
  if (isolation === "container" || isolation === "k8s") return;

  const declared = process.env.FOLDRUN_MULTI_TENANT === "1";
  let tenants: string[] = [];
  try {
    tenants = listTenants();
  } catch {
    // An unreadable data root is a different problem; do not mask it as this one.
    return;
  }
  if (!declared && tenants.length <= 1) return;

  const why = declared
    ? "FOLDRUN_MULTI_TENANT=1 is set"
    : `${tenants.length} accounts exist (${tenants.slice(0, 4).join(", ")}${tenants.length > 4 ? ", …" : ""})`;
  throw new Error(
    `refusing to start: ${why}, but FOLDRUN_RUN_ISOLATION is ` +
      `${isolation ? `"${isolation}", which is not a recognised mode` : "unset"}. ` +
      `Steps would run in this process, sharing the platform's filesystem, vault and ` +
      `every account's data. Set FOLDRUN_RUN_ISOLATION=k8s (a cluster) or =container ` +
      `(one box). Single-account installs may run without it.`,
  );
}

export function startWorker() {
  if (started || process.env.FOLDRUN_DISABLE_WORKER === "1") return;
  started = true;

  let inFlight = 0;

  const tick = async () => {
    // Not the holder → not a worker this tick. A web replica pointed at the
    // same data, or a second worker from a misapplied manifest, idles here
    // instead of double-driving runs.
    if (!holdsWorkerLease()) return;
    while (inFlight < concurrency()) {
      // Reserve the slot BEFORE awaiting the claim. The await yields, and a
      // second tick arriving in that window would read the same inFlight and
      // claim past the concurrency cap — the file queue never showed this
      // because its claim was synchronous.
      inFlight += 1;
      const claim = await claimNext();
      if (!claim) {
        inFlight -= 1;
        return;
      }

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
          // overlap: queue — one run of this flow at a time; later ones keep
          // their place and start when the live one finishes. Same shape as
          // the plan cap below: back to the tail, when not whether.
          const flowInfo = run
            ? listWorkspaceFlows(tenant, workspace).find((f) => f.name === run.flow)
            : null;
          if (
            run && run.status === "queued" && flowInfo?.overlap === "queue" &&
            listRuns(tenant, workspace).some(
              (r) => r.flow === run.flow && r.id !== run.id && r.status === "running",
            )
          ) {
            // The finally below removes the claim file and gives the slot
            // back — doing either here double-counted: every deferral
            // leaked inFlight downward, quietly raising real concurrency.
            await enqueue(claim.job);
            return;
          }

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
            // The finally below removes the claim file and gives the slot
            // back — doing either here double-counted: every deferral
            // leaked inFlight downward, quietly raising real concurrency.
            await enqueue(claim.job);
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
            // A run that parked on a wait: goes back to the queue carrying
            // the earliest deadline — without notBefore this would busy-loop
            // claim → park → claim until the wait expired.
            if (settled && settled.status === "queued" && settled.parkedAt) {
              const due = settled.steps
                .filter((st) => st.status === "pending" && st.waitUntil)
                .map((st) => new Date(st.waitUntil!).getTime())
                .filter((t) => t > Date.now());
              if (due.length) {
                // Cleanup is the finally's; see the gates above.
                await enqueue({ ...claim.job, notBefore: new Date(Math.min(...due)).toISOString() });
                return;
              }
            }
            if (settled && (settled.status === "completed" || settled.status === "failed")) {
              recordRunCost(tenant, workspace, runId, {
                ...runMeter(settled),
                compute: runComputeMeter(settled),
              });
            }
            // Tell whoever asked to be told. Terminal states and parks alike
            // — "waiting for your approval" is the one message that cannot
            // wait for someone to happen to open the dashboard.
            if (settled) await sendRunNotification(tenant, workspace, settled);
          }
        } catch (err) {
          console.error(`[foldrun] worker: run ${claim.job.runId} threw`, err);
        } finally {
          // Whichever store this came from knows how to let it go.
          await claim.release().catch((err) =>
            console.error(`[foldrun] worker: releasing ${claim.job.runId}:`, err),
          );
          inFlight -= 1;
        }
      })();
    }
  };

  setInterval(() => void tick().catch((err) => console.error("[foldrun] worker tick:", err)), POLL_MS).unref();
  void tick().catch((err) => console.error("[foldrun] worker tick:", err));

  // The recurring half of the bill, swept hourly: accrueDaily is idempotent
  // per calendar day, so the schedule here only decides how soon after
  // midnight the line appears — not how many appear.
  const accrue = async () => {
    if (!billingEnabled()) return;
    const retentionDays = Number(process.env.FOLDRUN_RETENTION_DAYS);
    const cutoff = Number.isFinite(retentionDays) && retentionDays > 0
      ? Date.now() - retentionDays * 24 * 60 * 60 * 1000
      : null;
    for (const tenant of listTenants()) {
      try {
        const usage = await accountUsage(tenant);
        await accrueDaily(tenant, usage.totals.storageBytes);
        // The wallet's hourly look: auto top-up from a saved card, or a
        // low-balance email, before a scheduled flow finds an empty account
        // at run start with nobody watching.
        void walletGuard(tenant).catch((err) =>
          console.error(`[foldrun] wallet guard ${tenant}: ${err instanceof Error ? err.message : err}`),
        );
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
  setInterval(() => void accrue().catch((err) => console.error("[foldrun] hourly accrual:", err)), 60 * 60 * 1000).unref();
  accrue();
}

/** The queue, described: what /healthz and the metrics endpoint report.
 *  Cheap enough to call per-scrape — two readdirs and a stat each. */
export async function queueStats(): Promise<{
  pending: number;
  /** Jobs waiting on a wait: deadline rather than a free slot. */
  scheduledAhead: number;
  claimed: number;
  oldestPendingSecs: number | null;
}> {
  if (databaseEnabled()) return statsDb();
  const now = Date.now();
  let pending = 0;
  let scheduledAhead = 0;
  let oldest: number | null = null;
  const dir = queueDir("pending");
  if (fs.existsSync(dir)) {
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith(".json")) continue;
      try {
        const file = path.join(dir, name);
        const job = JSON.parse(fs.readFileSync(file, "utf8")) as QueueJob;
        if (job.notBefore && new Date(job.notBefore).getTime() > now) {
          scheduledAhead += 1;
          continue; // waiting on its own deadline, not on us
        }
        pending += 1;
        const age = now - fs.statSync(file).mtimeMs;
        if (oldest === null || age > oldest) oldest = age;
      } catch {
        // mid-write or mid-claim — count nothing, next scrape settles it
      }
    }
  }
  const claimedDir = queueDir("claimed");
  const claimed = fs.existsSync(claimedDir)
    ? fs.readdirSync(claimedDir).filter((f) => f.endsWith(".json")).length
    : 0;
  return {
    pending,
    scheduledAhead,
    claimed,
    oldestPendingSecs: oldest === null ? null : Math.round(oldest / 1000),
  };
}


/**
 * Move any jobs still sitting in the file queue into the database, once.
 *
 * Called at boot before the worker starts. Without it, switching an install to
 * Postgres makes every in-flight job invisible in the same instant — the runs
 * stay `queued` on disk forever with nobody driving them, which looks like the
 * platform quietly stopping rather than like a migration.
 *
 * Claimed files come across as unclaimed: whatever was driving them died with
 * the old process, which is exactly what boot recovery already assumed.
 * Idempotent, because enqueueDb upserts on run_id.
 */
export async function importQueueToDatabase(): Promise<number> {
  if (!databaseEnabled()) return 0;
  let moved = 0;
  for (const state of ["claimed", "pending"] as const) {
    const dir = queueDir(state);
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith(".json")) continue;
      const file = path.join(dir, name);
      try {
        const job = JSON.parse(fs.readFileSync(file, "utf8")) as QueueJob;
        await enqueueDb(job);
        fs.rmSync(file, { force: true });
        moved += 1;
      } catch {
        // An unreadable job is dropped exactly as recoverQueue would drop it:
        // the run record survives, and reconcile is what closes it out.
        fs.rmSync(file, { force: true });
      }
    }
  }
  return moved;
}
