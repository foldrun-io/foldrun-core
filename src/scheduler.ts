// Cron scheduler for flows with `trigger: schedule`.
//
// A single interval ticks every 30s, scans every tenant's flows, and starts
// any flow whose cron expression matched since its last fire. Last-fire
// times live in data/schedule.json so restarts don't replay history.
//
// Deliberately dependency-free: a 5-field cron parser is ~40 lines and this
// avoids pulling a scheduling library into the platform for one feature.

import fs from "node:fs";
import path from "node:path";
import { dataRoot } from "./paths.ts";
import { listWorkspaces, listFlows, listTenants, type FlowInfo } from "./store.ts";
import { reconcileAllRuns } from "./runner.ts";
import { enqueueFlowRun } from "./queue.ts";
import { flowHasLiveRun } from "./store.ts";
import { sweepFinishedRunPods } from "./run-k8s.ts";
import { applyPendingPush } from "./deploy.ts";
import { filesAt } from "./gitrepo.ts";
import { evaluateDeployed } from "./evals.ts";

const stateFile = () => path.join(dataRoot(), "schedule.json");
const TICK_MS = 30_000;

// How often the same interval also closes out abandoned runs. Reconciliation
// used to happen only when the server booted, which assumed the only way to
// abandon a run was for the process to die. It isn't: a step can stop
// emitting — a container that never exits, a model call that never settles —
// while the server carries on serving pages, and nothing then closes the run.
// One was found five hours idle and still rendering as live.
//
// It reads every run file, so it does not belong on the 30s tick. A tenth of
// them is every five minutes, well inside the 30-minute idle window.
export const RECONCILE_EVERY = 10;
let ticksSinceReconcile = 0;

interface ScheduleState {
  // key: `${tenant}/${workspace}/${flow}` → ISO timestamp of last fire
  lastFired: Record<string, string>;
}

function readState(): ScheduleState {
  if (!fs.existsSync(stateFile())) return { lastFired: {} };
  try {
    return JSON.parse(fs.readFileSync(stateFile(), "utf8"));
  } catch {
    return { lastFired: {} };
  }
}

function writeState(state: ScheduleState) {
  fs.mkdirSync(path.dirname(stateFile()), { recursive: true });
  fs.writeFileSync(stateFile(), JSON.stringify(state, null, 2));
}

// ---- cron ----

const NAMED: Record<string, string> = {
  "@hourly": "0 * * * *",
  "@daily": "0 0 * * *",
  "@midnight": "0 0 * * *",
  "@weekly": "0 0 * * 0",
  "@monthly": "0 0 1 * *",
};

const DOW_NAMES = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const MONTH_NAMES = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

// Expand one cron field ("*", "*/15", "1-5", "mon,fri", "3") to a value set.
function expandField(field: string, min: number, max: number, names?: string[]): Set<number> | null {
  const out = new Set<number>();
  for (const part of field.split(",")) {
    const [rangePart, stepPart] = part.split("/");
    const step = stepPart ? Number(stepPart) : 1;
    if (!Number.isInteger(step) || step < 1) return null;

    let lo = min;
    let hi = max;
    if (rangePart !== "*") {
      const bounds = rangePart.split("-");
      const parse = (raw: string): number | null => {
        const token = raw.trim().toLowerCase();
        if (names) {
          const idx = names.indexOf(token);
          if (idx !== -1) return idx;
        }
        const n = Number(token);
        return Number.isInteger(n) ? n : null;
      };
      const a = parse(bounds[0]);
      if (a === null) return null;
      lo = a;
      if (bounds.length > 1) {
        const b = parse(bounds[1]);
        if (b === null) return null;
        hi = b;
      } else {
        hi = stepPart ? max : a; // "5" → just 5; "5/10" → 5,15,25...
      }
    }
    if (lo < min || hi > max || lo > hi) return null;
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return out;
}

export interface Cron {
  minute: Set<number>;
  hour: Set<number>;
  dom: Set<number>;
  month: Set<number>;
  dow: Set<number>;
  domRestricted: boolean;
  dowRestricted: boolean;
}

export function parseCron(expr: string): Cron | null {
  const normalized = (NAMED[expr.trim().toLowerCase()] ?? expr).trim();
  const fields = normalized.split(/\s+/);
  if (fields.length !== 5) return null;
  const [mi, ho, dm, mo, dw] = fields;

  const minute = expandField(mi, 0, 59);
  const hour = expandField(ho, 0, 23);
  const dom = expandField(dm, 1, 31);
  const month = expandField(mo, 1, 12, MONTH_NAMES);
  const dowRaw = expandField(dw, 0, 7, DOW_NAMES);
  if (!minute || !hour || !dom || !month || !dowRaw) return null;

  // cron allows both 0 and 7 for Sunday.
  const dowSet = new Set([...dowRaw].map((d) => (d === 7 ? 0 : d)));

  return {
    minute,
    hour,
    dom,
    month,
    dow: dowSet,
    domRestricted: dm.trim() !== "*",
    dowRestricted: dw.trim() !== "*",
  };
}

// Wall-clock fields for a date in an IANA timezone.
function zoned(date: Date, timeZone: string) {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    weekday: "short",
    hour12: false,
  });
  const parts: Record<string, string> = {};
  for (const p of fmt.formatToParts(date)) parts[p.type] = p.value;
  return {
    minute: Number(parts.minute),
    hour: Number(parts.hour) % 24,
    dom: Number(parts.day),
    month: Number(parts.month),
    dow: DOW_NAMES.indexOf(parts.weekday.toLowerCase().slice(0, 3)),
  };
}

export function cronMatches(cron: Cron, date: Date, timeZone = "UTC"): boolean {
  let t;
  try {
    t = zoned(date, timeZone);
  } catch {
    t = zoned(date, "UTC"); // unknown timezone → UTC rather than never firing
  }
  if (!cron.minute.has(t.minute) || !cron.hour.has(t.hour) || !cron.month.has(t.month)) return false;
  // Standard cron: when both day fields are restricted, either may match.
  const domOk = cron.dom.has(t.dom);
  const dowOk = cron.dow.has(t.dow);
  if (cron.domRestricted && cron.dowRestricted) return domOk || dowOk;
  if (cron.domRestricted) return domOk;
  if (cron.dowRestricted) return dowOk;
  return true;
}

// Did this cron match any minute in (after, now]? Bounded to 24h of catch-up
// so a long downtime doesn't fire hundreds of runs.
function firedSince(cron: Cron, after: Date, now: Date, timeZone: string): boolean {
  const start = Math.max(after.getTime(), now.getTime() - 24 * 60 * 60_000);
  for (let t = Math.floor(start / 60_000) * 60_000 + 60_000; t <= now.getTime(); t += 60_000) {
    if (cronMatches(cron, new Date(t), timeZone)) return true;
  }
  return false;
}

export interface DueFlow {
  tenant: string;
  workspace: string;
  flow: FlowInfo;
}

export function findDueFlows(now: Date, state: ScheduleState, tenants: string[]): DueFlow[] {
  const due: DueFlow[] = [];
  for (const tenant of tenants) {
    for (const workspace of listWorkspaces(tenant)) {
      // A push refused only because a run was in flight is a deploy that has
      // not happened yet, and git already told the client it succeeded. Apply
      // it now the runs are done, before deciding what to fire — a schedule
      // should read the flows the newest push shipped.
      try {
        const applied = applyPendingPush(tenant, workspace.name, filesAt);
        if (applied) {
          console.log(
            `[scheduler] applied the push that was waiting on a run: ${tenant}/${workspace.name} @ ${applied.commit.slice(0, 7)}`,
          );
          void evaluateDeployed(tenant, workspace.name, applied.commit).catch(() => {});
        }
      } catch (err) {
        console.error(`[scheduler] pending push for ${tenant}/${workspace.name}:`, err);
      }
      for (const flow of listFlows(tenant, workspace.name)) {
        if (flow.trigger !== "schedule" || !flow.schedule || flow.steps.length === 0) continue;
        const cron = parseCron(flow.schedule);
        if (!cron) continue;
        const key = `${tenant}/${workspace.name}/${flow.name}`;
        const last = state.lastFired[key];
        // First sighting: record now, don't backfire.
        if (!last) {
          state.lastFired[key] = now.toISOString();
          continue;
        }
        if (firedSince(cron, new Date(last), now, flow.timezone ?? "UTC")) {
          // overlap: skip — a cron refiring while yesterday's run is still
          // going almost never means "run two". The tick is consumed either
          // way: when the long run finally ends, the flow waits for its next
          // scheduled time rather than firing a stale make-up run.
          if (flow.overlap === "skip" && flowHasLiveRun(tenant, workspace.name, flow.name)) {
            console.log(`[scheduler] ${key}: skipped — a run of this flow is still live (overlap: skip)`);
            state.lastFired[key] = now.toISOString();
            continue;
          }
          due.push({ tenant, workspace: workspace.name, flow });
          state.lastFired[key] = now.toISOString();
        }
      }
    }
  }
  if (++ticksSinceReconcile >= RECONCILE_EVERY) {
    ticksSinceReconcile = 0;
    // Terminated run pods whose driver died with the process that created
    // them. Fire-and-forget: it is housekeeping, and a cluster that cannot be
    // reached right now is not a reason to stop firing flows.
    void sweepFinishedRunPods()
      .then((n) => n && console.log(`[scheduler] swept ${n} finished run pod(s)`))
      .catch((err) => console.error("[scheduler] run-pod sweep failed:", err));
    try {
      for (const closed of reconcileAllRuns(now.getTime())) {
        console.log(
          `[scheduler] closed abandoned run ${closed.tenant}/${closed.workspace}/${closed.runId}` +
            (closed.interrupted.length ? ` — interrupted: ${closed.interrupted.join(", ")}` : ""),
        );
      }
    } catch (err) {
      // A run that cannot be reconciled must not stop flows from firing.
      console.error("[scheduler] reconcile failed:", err);
    }
  }

  return due;
}

// One scheduler per data directory, however many processes share it. The
// lease is a file naming its holder; a holder renews by rewriting it, and
// anyone finding it stale (no renewal for three tick intervals) takes over.
// The take-over race is a read-then-write and deliberately so: the worst
// case is two processes firing one tick together, once, during a handover —
// a bounded duplicate, not a corruption — and a lock that could deadlock a
// fleet to prevent it would be the worse trade.
const LEASE_STALE_MS = 90_000;
const OWNER = `${process.pid}-${Math.random().toString(36).slice(2, 8)}`;

function leaseFile() {
  return path.join(dataRoot(), ".scheduler-lease");
}

function holdsLease(now: number): boolean {
  const file = leaseFile();
  try {
    const current = JSON.parse(fs.readFileSync(file, "utf8")) as {
      owner: string;
      renewedAt: number;
    };
    if (current.owner !== OWNER && now - current.renewedAt < LEASE_STALE_MS) return false;
  } catch {
    // no lease yet, or unreadable — claimable
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${OWNER}`;
  fs.writeFileSync(tmp, JSON.stringify({ owner: OWNER, renewedAt: now }));
  fs.renameSync(tmp, file);
  return true;
}

export async function tick(now = new Date()): Promise<DueFlow[]> {
  if (!holdsLease(now.getTime())) return [];
  const state = readState();
  const due = findDueFlows(now, state, listTenants());
  writeState(state);
  for (const d of due) {
    try {
      // Through the queue, not straight to driveRun — the scheduler shares a
      // process with the worker, and firing five flows at one minute past
      // midnight should respect the same concurrency cap as everything else.
      await enqueueFlowRun(d.tenant, d.workspace, d.flow.steps, d.flow.name);
      console.log(`[scheduler] queued ${d.tenant}/${d.workspace}/${d.flow.name}`);
    } catch (err) {
      console.error(`[scheduler] failed ${d.tenant}/${d.workspace}/${d.flow.name}:`, err);
    }
  }
  return due;
}

// Started once per server process from instrumentation.ts.
let started = false;

export function startScheduler() {
  if (started || process.env.FOLDRUN_DISABLE_SCHEDULER === "1") return;
  started = true;
  setInterval(() => {
    // The tick is async now (enqueueing can be a database write), so its
    // failure is a rejected promise rather than a throw a try/catch here would
    // ever see — an unhandled one takes the process down.
    void tick().catch((err) => console.error("[scheduler] tick failed:", err));
  }, TICK_MS).unref?.();
  console.log("[scheduler] started (30s tick)");
}
