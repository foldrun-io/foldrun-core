// Grading live runs — an eval with `trigger: runs` (FOL-feature 1, 24 Oct 2026).
//
// An eval tests an agent on cases someone wrote; it says nothing about the
// runs that actually happened. A desk that runs at 3am every night is only
// ever checked by its own `verify:` lines, and a reply that passes them but
// is quietly worse than last month's goes unseen. A grader is an eval file
// that, instead of running cases, reads a sample of the real finished runs
// of its agent or flow and holds each to its checks:
//
//   evals/digest-quality.md
//   ---
//   flow: weekly-digest          # or agent: writer — that agent's steps
//   trigger: runs
//   sample: 25                   # percent of finished runs graded (default 25)
//   model: fast                  # the judge
//   ---
//
//   ## cites its sources
//   expect:
//     - judge: every claim names the source it came from
//   ## no placeholders
//   expect:
//     - not-contains: lorem ipsum
//
// The same assertions as an eval case, cheap ones first; the judge runs only
// when they pass, and is given the run's task so it grades the reply against
// what was asked. `file:` and `run:` are refused — they would read or execute
// on the platform's host, not in the run's sandbox — and so is `matches:`: a
// regular expression over any run's output, on the scheduler, could stall it.
//
// Which runs: completed ones (a crash is already an issue), not test runs,
// not eval runs, finished after the grader was first seen — a new grader
// does not back-fill a week of runs in one burst — and inside the last
// three days. Sampled by a hash of the run id and the eval's name, so the
// same run is in or out however many times the pass looks at it.
//
// Where: one line per graded run in evals/.results/grades/<eval>.jsonl
// (beside the eval history the deploy never touches). A run graded again —
// on demand, from the dashboard or the CLI — appends a newer line, and the
// newest line per run is its grade. Kept 90 days, at most 5,000 lines; the
// pass only looks three days back, so a run is never graded twice by it.
//
// Who: the platform's grade pass (platform grade-pass.ts) every few minutes,
// a few judges at a time; or a person, for one run, at once.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { workspaceDir, listRunSummaries, readRun, assertSafeName, type RunRecord, type RunSummary } from "./store.ts";
import { listEvals, checkAssertion, judgeCall, judgeProcessEnv, type EvalInfo, type Assertion } from "./evals.ts";
import { accountModelEnv, withModelEnv } from "./model-env.ts";
import { judgeVerdict } from "./judge-verdict.ts";

/** How far back the pass looks for runs to grade. */
export const GRADE_WINDOW_MS = 3 * 86400_000;
/** How long grades are kept, and how many per eval. */
export const GRADE_KEEP_MS = 90 * 86400_000;
export const GRADE_KEEP_LINES = 5000;

export interface GradeAssertion {
  type: Assertion["type"];
  value: string;
  passed: boolean;
  detail: string;
}

export interface GradeCheck {
  /** The `## heading` of the check. */
  name: string;
  passed: boolean;
  /** Set when the check could not be decided — the judge failed to answer.
   *  An error is not a failure: nobody's work was found wanting. */
  error?: string;
  assertions: GradeAssertion[];
}

export interface Grade {
  eval: string;
  runId: string;
  /** The run's flow (`adhoc:<agent>` for a direct agent run). */
  flow: string;
  at: string;
  /** pass: every check passed. fail: at least one failed. error: none
   *  failed but at least one could not be decided. */
  status: "pass" | "fail" | "error";
  checks: GradeCheck[];
  /** What the judges cost, USD — the run's own cost is on the run. */
  costUsd: number;
  /** The judge's model. */
  model: string;
  /** Which version of the grader graded it (a hash of the eval file), and
   *  which version of the workspace the run ran (RunRecord.revision). */
  evalRevision: string;
  runRevision: string | null;
  runFinishedAt: string | null;
  /** `sample` when the pass picked it; a person's email (or key label)
   *  when someone asked for it. */
  by: string;
}

function refuse(message: string, status: number): Error {
  return Object.assign(new Error(message), { status });
}

const gradesDir = (tenant: string, workspace: string) => path.join(workspaceDir(tenant, workspace), "evals", ".results", "grades");

function gradesFile(tenant: string, workspace: string, name: string) {
  assertSafeName(name, "eval");
  return path.join(gradesDir(tenant, workspace), `${name}.jsonl`);
}

function stateFile(tenant: string, workspace: string, name: string) {
  assertSafeName(name, "eval");
  return path.join(gradesDir(tenant, workspace), `${name}.state.json`);
}

/** The graders of a workspace: its `trigger: runs` evals that can be read. */
export function listGraders(tenant: string, workspace: string): EvalInfo[] {
  return listEvals(tenant, workspace).filter((e) => e.trigger === "runs");
}

/** The version of a grader, as its file reads now. */
export function evalRevision(tenant: string, workspace: string, info: EvalInfo): string {
  try {
    const raw = fs.readFileSync(path.join(workspaceDir(tenant, workspace), "evals", info.file), "utf8");
    return crypto.createHash("sha256").update(raw).digest("hex").slice(0, 12);
  } catch {
    return "unknown";
  }
}

/** Is this run in this grader's sample? Stable: a hash, not a coin. */
export function sampled(runId: string, evalName: string, percent: number): boolean {
  if (percent >= 100) return true;
  if (percent <= 0) return false;
  const h = crypto.createHash("sha256").update(`${evalName}\u0000${runId}`).digest();
  return h.readUInt32BE(0) % 10_000 < Math.round(percent * 100);
}

/** What a run's task was — the input a flow run was given, else its first
 *  step's instruction. */
function taskOfRun(run: RunRecord): string {
  const first = run.steps[0]?.instruction ?? "";
  const block = first.match(/<(run_task|webhook_payload|email|previous_run|storage_event|watched_content)>\n?([\s\S]*?)\n?<\/\1>/);
  return (block ? block[2] : first).trim().slice(0, 4000);
}

/** Is a run one this grader is about? Its flow, or a step by its agent. */
function about(info: EvalInfo, run: Pick<RunSummary, "flow" | "steps">): boolean {
  if (info.flow) return run.flow === info.flow;
  if (info.agent) return run.flow === `adhoc:${info.agent}` || run.steps.some((s) => s.agent === info.agent);
  return false;
}

/** The text a grader grades: every step's reply for a flow, the agent's
 *  replies for an agent. Null when the run has nothing of it. */
export function gradedOutput(info: EvalInfo, run: RunRecord): string | null {
  const steps = info.flow ? run.steps : run.steps.filter((s) => s.agent === info.agent);
  const out = steps.map((s) => (s.result ?? "").trim()).filter(Boolean).join("\n\n");
  return out || null;
}

/** Grade one finished run. Writes nothing; `recordGrade` keeps it. */
export async function gradeRun(
  tenant: string,
  workspace: string,
  info: EvalInfo,
  run: RunRecord,
  opts: { by?: string; now?: number; judge?: typeof judgeCall } = {},
): Promise<Grade> {
  if (info.trigger !== "runs") throw refuse(`${info.name} is not a grader — it runs cases (set trigger: runs to grade real runs)`, 400);
  if (info.problems.length) throw refuse(`${info.name} cannot be read as written: ${info.problems[0]}`, 422);
  if (run.status !== "completed" && run.status !== "failed") throw refuse(`run ${run.id} has not finished — it is ${run.status}`, 409);
  if (!about(info, run)) {
    throw refuse(`run ${run.id} is a run of ${run.flow}, not ${info.flow ? `flow ${info.flow}` : `agent ${info.agent}`} — ${info.name} grades only those`, 400);
  }
  const output = gradedOutput(info, run);
  if (!output) throw refuse(`run ${run.id} produced no reply ${info.agent ? `from ${info.agent} ` : ""}to grade`, 409);
  // A flow's task is what the run was given; an agent's is what ITS steps
  // were told — an editor late in a flow is graded against its own brief,
  // not the researcher's.
  const task = info.flow
    ? taskOfRun(run)
    : run.steps
        .filter((s) => s.agent === info.agent)
        .map((s) => (s.instruction ?? "").trim())
        .filter(Boolean)
        .join("\n\n")
        .slice(0, 4000) || taskOfRun(run);
  const agentDir = path.join(workspaceDir(tenant, workspace), "agents", info.agent ?? "");
  const ask = opts.judge ?? judgeCall;
  let costUsd = 0;
  const checks: GradeCheck[] = [];
  for (const c of info.cases) {
    const assertions: GradeAssertion[] = [];
    // The judges that did not decide — threw, or answered with no verdict —
    // by their place in `assertions`. A check whose only misses are these is
    // undecided, never failed: nobody's work was found wanting.
    const undecided = new Set<number>();
    const errors: string[] = [];
    const cheap = c.expect.filter((a) => a.type !== "judge");
    const judges = c.expect.filter((a) => a.type === "judge");
    for (const a of cheap) {
      if (a.type === "file" || a.type === "run" || a.type === "matches") {
        assertions.push({ type: a.type, value: a.value, passed: false, detail: `${a.type}: is not used to grade a finished run` });
        continue;
      }
      const r = await checkAssertion(a, output, agentDir, info.model, info.effort);
      assertions.push({ type: a.type, value: a.value, passed: r.passed, detail: r.detail });
    }
    if (assertions.every((a) => a.passed)) {
      for (const a of judges) {
        try {
          const m = accountModelEnv(tenant, workspace, judgeProcessEnv);
          const said = await withModelEnv(m, (env) => ask(a.value, output, info.model, info.effort, env, task));
          costUsd += said.costUsd;
          const v = judgeVerdict(said.text);
          if (v.decided === false) {
            undecided.add(assertions.length);
            errors.push(v.detail);
          }
          assertions.push({ type: "judge", value: a.value, passed: v.passed, detail: v.detail });
        } catch (err) {
          const why = `the judge did not answer — ${err instanceof Error ? err.message : String(err)}`;
          undecided.add(assertions.length);
          errors.push(why);
          assertions.push({ type: "judge", value: a.value, passed: false, detail: why });
        }
      }
    } else {
      for (const a of judges) assertions.push({ type: "judge", value: a.value, passed: false, detail: "not run — an earlier check failed" });
    }
    const decidedFail = assertions.some((a, i) => !a.passed && !undecided.has(i));
    const error = errors.length ? errors.join("; ").slice(0, 600) : undefined;
    checks.push({
      name: c.name,
      passed: assertions.length > 0 && assertions.every((a) => a.passed),
      ...(error && !decidedFail ? { error } : {}),
      assertions,
    });
  }
  const failed = checks.some((c) => !c.passed && !c.error);
  const undecided = checks.some((c) => c.error);
  return {
    eval: info.name,
    runId: run.id,
    flow: run.flow,
    at: new Date(opts.now ?? Date.now()).toISOString(),
    status: failed ? "fail" : undecided ? "error" : "pass",
    checks,
    costUsd: Math.round(costUsd * 1e6) / 1e6,
    model: info.model,
    evalRevision: info.revision ?? evalRevision(tenant, workspace, info),
    runRevision: run.revision ?? null,
    runFinishedAt: run.finishedAt,
    by: opts.by ?? "sample",
  };
}

/** Keep a grade: one line, appended. */
export function recordGrade(tenant: string, workspace: string, grade: Grade): void {
  const file = gradesFile(tenant, workspace, grade.eval);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(grade)}\n`);
}

/** Every line of a grader's file, oldest first; a torn line is skipped. */
function readLines(tenant: string, workspace: string, name: string): Grade[] {
  let raw: string;
  try {
    raw = fs.readFileSync(gradesFile(tenant, workspace, name), "utf8");
  } catch {
    return [];
  }
  const out: Grade[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const g = JSON.parse(line) as Grade;
      if (g && typeof g.runId === "string" && typeof g.at === "string") out.push(g);
    } catch {
      /* a line torn by a crash mid-append costs that line, not the file */
    }
  }
  return out;
}

/** A grader's grades, newest first — one per run, the newest line for it. */
export function readGrades(tenant: string, workspace: string, name: string, opts: { sinceMs?: number } = {}): Grade[] {
  const byRun = new Map<string, Grade>();
  for (const g of readLines(tenant, workspace, name)) {
    const prev = byRun.get(g.runId);
    if (!prev || g.at >= prev.at) byRun.set(g.runId, g);
  }
  return [...byRun.values()]
    .filter((g) => (opts.sinceMs === undefined ? true : Date.parse(g.at) >= opts.sinceMs))
    .sort((a, b) => b.at.localeCompare(a.at));
}

/** The grades of one run, across every grader of the workspace. */
export function gradesOfRun(tenant: string, workspace: string, runId: string): Grade[] {
  const out: Grade[] = [];
  for (const g of listGraders(tenant, workspace)) {
    const mine = readGrades(tenant, workspace, g.name).find((x) => x.runId === runId);
    if (mine) out.push(mine);
  }
  return out;
}

export interface GradeSummary {
  graded: number;
  passed: number;
  failed: number;
  errors: number;
  /** passed / (passed + failed); null when nothing was decided. */
  rate: number | null;
  costUsd: number;
  /** One row per UTC day that has grades, oldest first. */
  byDay: { day: string; graded: number; passed: number; failed: number }[];
}

export function summariseGrades(grades: Grade[]): GradeSummary {
  const days = new Map<string, { graded: number; passed: number; failed: number }>();
  let passed = 0;
  let failed = 0;
  let errors = 0;
  let costUsd = 0;
  for (const g of grades) {
    if (g.status === "pass") passed++;
    else if (g.status === "fail") failed++;
    else errors++;
    costUsd += g.costUsd ?? 0;
    const day = g.at.slice(0, 10);
    const d = days.get(day) ?? { graded: 0, passed: 0, failed: 0 };
    d.graded++;
    if (g.status === "pass") d.passed++;
    if (g.status === "fail") d.failed++;
    days.set(day, d);
  }
  return {
    graded: grades.length,
    passed,
    failed,
    errors,
    rate: passed + failed ? Math.round((passed / (passed + failed)) * 1000) / 1000 : null,
    costUsd: Math.round(costUsd * 1e4) / 1e4,
    byDay: [...days.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([day, d]) => ({ day, ...d })),
  };
}

/** When the pass first saw this grader — runs that finished before it are
 *  never sampled, so a new grader starts from now rather than back-filling. */
export function graderSince(tenant: string, workspace: string, name: string, now = Date.now()): number {
  const file = stateFile(tenant, workspace, name);
  try {
    const s = JSON.parse(fs.readFileSync(file, "utf8")) as { since?: string };
    const t = s.since ? Date.parse(s.since) : NaN;
    if (Number.isFinite(t)) return t;
  } catch {
    /* first sight */
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(`${file}.tmp`, JSON.stringify({ since: new Date(now).toISOString() }));
  fs.renameSync(`${file}.tmp`, file);
  return now;
}

/** When a grader last had a run graded by the pass (0: never) — the pass
 *  serves the longest-waiting grader first, so fairness holds across passes. */
export function graderLastServed(tenant: string, workspace: string, name: string): number {
  try {
    const s = JSON.parse(fs.readFileSync(stateFile(tenant, workspace, name), "utf8")) as { lastServed?: string };
    const t = s.lastServed ? Date.parse(s.lastServed) : NaN;
    return Number.isFinite(t) ? t : 0;
  } catch {
    return 0;
  }
}

function markServed(tenant: string, workspace: string, name: string, now: number): void {
  const file = stateFile(tenant, workspace, name);
  let state: Record<string, unknown> = {};
  try {
    state = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
  } catch {
    /* graderSince writes it first; a missing one is rebuilt */
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(`${file}.tmp`, JSON.stringify({ ...state, lastServed: new Date(now).toISOString() }));
  fs.renameSync(`${file}.tmp`, file);
}

/** How long an undecided grade (the judge did not answer — a spent usage
 *  cap, a provider outage) waits before the pass tries the run again, and
 *  how many tries it gets. */
export const GRADE_RETRY_MS = 3600_000;
export const GRADE_TRIES = 3;

/** The runs the pass is done with: decided (pass or fail), or undecided
 *  too often, or too recently to try again. */
function settledRuns(lines: Grade[], now: number): Set<string> {
  const errors = new Map<string, { n: number; last: number }>();
  const done = new Set<string>();
  for (const g of lines) {
    if (g.status !== "error") {
      done.add(g.runId);
      continue;
    }
    const e = errors.get(g.runId) ?? { n: 0, last: 0 };
    errors.set(g.runId, { n: e.n + 1, last: Math.max(e.last, Date.parse(g.at) || 0) });
  }
  for (const [id, e] of errors) if (e.n >= GRADE_TRIES || now - e.last < GRADE_RETRY_MS) done.add(id);
  return done;
}

/** The runs the pass should grade for one grader, oldest first. */
export function gradeCandidates(tenant: string, workspace: string, info: EvalInfo, now = Date.now()): string[] {
  const since = Math.max(graderSince(tenant, workspace, info.name, now), now - GRADE_WINDOW_MS);
  const graded = settledRuns(readLines(tenant, workspace, info.name), now);
  return listRunSummaries(tenant, workspace)
    .filter((r) =>
      r.status === "completed" &&
      !r.test &&
      !r.flow.startsWith("eval:") &&
      !!r.finishedAt &&
      Date.parse(r.finishedAt) >= since &&
      about(info, r) &&
      !graded.has(r.id) &&
      sampled(r.id, info.name, info.sample),
    )
    .sort((a, b) => (a.finishedAt ?? "").localeCompare(b.finishedAt ?? ""))
    .map((r) => r.id);
}

/** Drop grades past the keeping window or the line cap. Rewritten whole
 *  (temp, then rename); only the pass prunes. */
export function pruneGrades(tenant: string, workspace: string, name: string, now = Date.now()): number {
  const file = gradesFile(tenant, workspace, name);
  if (!fs.existsSync(file)) return 0;
  // Read whatever its size: the 90 days hold for a quiet grader too.
  const lines = readLines(tenant, workspace, name);
  // The line cap never takes a grade from the last GRADE_WINDOW_MS (and a
  // day's margin): those are what keeps the pass from grading a run twice.
  const recent = (g: Grade) => now - Date.parse(g.at) < GRADE_WINDOW_MS + 86400_000;
  const old = lines.filter((g) => !recent(g) && now - Date.parse(g.at) < GRADE_KEEP_MS);
  const room = GRADE_KEEP_LINES - lines.filter(recent).length;
  const kept = [...(room > 0 ? old.slice(-room) : []), ...lines.filter(recent)]
    .sort((a, b) => a.at.localeCompare(b.at));
  if (kept.length === lines.length) return 0;
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, kept.map((g) => JSON.stringify(g)).join("\n") + (kept.length ? "\n" : ""));
  fs.renameSync(tmp, file);
  return lines.length - kept.length;
}

/**
 * Grade what is due in one workspace: for each grader, the sampled runs that
 * finished since it was first seen and are not graded yet. At most `limit`
 * judges' worth of runs; `keepGoing` is asked before each run, so a pass
 * that lost its lease stops between runs, never mid-grade.
 */
export async function gradeWorkspace(
  tenant: string,
  workspace: string,
  opts: { now?: number; limit?: number; keepGoing?: () => Promise<boolean> | boolean; onGrade?: (g: Grade, info: EvalInfo) => void | Promise<void>; judge?: typeof judgeCall } = {},
): Promise<{ graded: number; failed: number; errors: string[] }> {
  const now = opts.now ?? Date.now();
  let left = opts.limit ?? 5;
  const errors: string[] = [];
  let graded = 0;
  let failed = 0;
  // Every grader's candidates first — which also stamps a new grader's start
  // whatever the budget — then taken in turns, one run from each grader in
  // round, so one busy grader cannot have the whole pass every time.
  const queues: { info: EvalInfo; runs: string[] }[] = [];
  for (const info of listGraders(tenant, workspace)) {
    if (info.problems.length || info.sample <= 0) continue;
    pruneGrades(tenant, workspace, info.name, now);
    queues.push({ info, runs: gradeCandidates(tenant, workspace, info, now) });
  }
  // The grader that has waited longest goes first: within a pass they take
  // turns, and across passes the ones left out last time lead the next.
  queues.sort((a, b) => graderLastServed(tenant, workspace, a.info.name) - graderLastServed(tenant, workspace, b.info.name) || a.info.name.localeCompare(b.info.name));
  const turns: { info: EvalInfo; runId: string }[] = [];
  for (let i = 0; queues.some((q) => i < q.runs.length); i++) {
    for (const q of queues) if (i < q.runs.length) turns.push({ info: q.info, runId: q.runs[i] });
  }
  for (const { info, runId } of turns) {
    if (left <= 0) break;
    if (opts.keepGoing && !(await opts.keepGoing())) return { graded, failed, errors };
    const run = readRun(tenant, workspace, runId);
    if (!run) continue;
    left--;
    markServed(tenant, workspace, info.name, Date.now());
    let g: Grade;
    try {
      g = await gradeRun(tenant, workspace, info, run, { now: Date.now(), judge: opts.judge });
      recordGrade(tenant, workspace, g);
      graded++;
      if (g.status === "fail") failed++;
    } catch (err) {
      // A run that cannot be graded (it said nothing, it is no longer the
      // grader's) is written down as an error so the pass does not pick it
      // again every few minutes.
      const message = err instanceof Error ? err.message : String(err);
      errors.push(`${info.name} ${runId}: ${message}`);
      recordGrade(tenant, workspace, {
        eval: info.name,
        runId,
        flow: run.flow,
        at: new Date().toISOString(),
        status: "error",
        checks: [{ name: "grade", passed: false, error: message, assertions: [] }],
        costUsd: 0,
        model: info.model,
        evalRevision: evalRevision(tenant, workspace, info),
        runRevision: run.revision ?? null,
        runFinishedAt: run.finishedAt,
        by: "sample",
      });
      continue;
    }
    // What follows a grade is not the grade: a hook that fails is said,
    // and the recorded verdict stands.
    try {
      await opts.onGrade?.(g, info);
    } catch (err) {
      errors.push(`${info.name} ${runId}: after grading — ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { graded, failed, errors };
}
