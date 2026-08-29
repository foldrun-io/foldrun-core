// What your agents actually did — read out of the run journals that already
// hold every fact.
//
// The account already had a usage report: cost, tokens and compute, rolled up
// by flow and by agent. That answers "what did this spend". It does not answer
// the questions a developer asks when something is wrong:
//
//   which step fails, and how often
//   which agent has to retry to get through
//   which tool is slow, and which one errors
//   what changed this week
//   show me the last failures and what they said
//
// Every one of those is already in `runs/*.json` — per step: attempts, status,
// costUsd, tokens, computeSecs, startupSecs, and an event trail with each
// tool call in it. Nothing here instruments anything new; it reads what the
// runner has always written. That matters for trust: a number on this page
// can be checked against the run it came from.
//
// Two honesties, carried from usage.ts and extended:
//
//   · A tool call's DURATION is only reported where it was measured. Script
//     and API tools log their own elapsed time, so those are real. A built-in
//     tool (read, web) records only that it was called, and the gap to the
//     next event is not its duration — it includes the model thinking about
//     the result. Reporting that as latency would be inventing a number, so
//     calls and errors are counted for every tool and latency only for the
//     ones that measured it.
//
//   · A percentile over three samples is not a percentile. Anything computed
//     from fewer than five observations is returned as null rather than as a
//     confident-looking number, and the sample count travels with the stat so
//     a reader can see what it rests on.

import { listRuns, type RunRecord, type StepRecord } from "./store.ts";

export interface Sampled {
  /** How many observations this rests on. */
  n: number;
  p50: number | null;
  p95: number | null;
  max: number | null;
}

export interface AgentStat {
  agent: string;
  steps: number;
  failed: number;
  /** Steps that needed more than one attempt to get through. */
  retried: number;
  /** Steps a `when:`/`case:` condition skipped — not failures, but a step
   *  that never runs is worth seeing beside one that always does. */
  skipped: number;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  /** Seconds of sandbox time, per step. */
  seconds: Sampled;
}

export interface ToolStat {
  name: string;
  calls: number;
  errors: number;
  /** Calls whose duration the tool itself reported. */
  measured: number;
  ms: Sampled;
  /** Which agents call it — the blast radius when it breaks. */
  agents: string[];
}

export interface FlowStat {
  flow: string;
  runs: number;
  failed: number;
  /** Wall-clock seconds from start to finish, per run. */
  seconds: Sampled;
  costUsd: number;
}

export interface DayStat {
  day: string; // YYYY-MM-DD
  runs: number;
  failed: number;
  costUsd: number;
}

export interface Failure {
  runId: string;
  flow: string;
  agent: string;
  at: string;
  attempts: number;
  /** The last error the step recorded, or its status if it said nothing. */
  text: string;
}

export interface Observation {
  workspace: string;
  /** The window these numbers describe. */
  sinceDays: number;
  from: string | null;
  runs: number;
  failedRuns: number;
  steps: number;
  costUsd: number;
  agents: AgentStat[];
  tools: ToolStat[];
  flows: FlowStat[];
  days: DayStat[];
  failures: Failure[];
}

const MIN_SAMPLES = 5;

/** Percentiles, or null when there is not enough to say. */
export function sampled(values: number[]): Sampled {
  const xs = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (xs.length === 0) return { n: 0, p50: null, p95: null, max: null };
  const at = (q: number) => xs[Math.min(xs.length - 1, Math.floor(q * xs.length))];
  return {
    n: xs.length,
    // A percentile over a handful of runs reads as precision that isn't
    // there. The max is still shown: "the worst one was 94s" is a fact
    // however few there were.
    p50: xs.length >= MIN_SAMPLES ? at(0.5) : null,
    p95: xs.length >= MIN_SAMPLES ? at(0.95) : null,
    max: xs[xs.length - 1],
  };
}

/**
 * A script or API tool logs its own outcome as an info event. Those lines are
 * the only place a real duration exists, so they are parsed rather than
 * guessed at:
 *
 *   script: ads_summary(customer_id=123) → exit 0 (412ms, sandbox)
 *   api: GET /v18/customers → 200 (91ms)
 *
 * A line that does not match is not an error — plenty of info events are
 * prose — it simply contributes nothing.
 */
export function parseToolLog(
  text: string,
): { kind: "script" | "api"; name: string; ok: boolean; ms: number | null } | null {
  const script = /^script:\s*([A-Za-z0-9_]+)\(.*?\)\s*→\s*exit\s+(\S+)\s*\((\d+)ms/.exec(text);
  if (script) {
    return { kind: "script", name: script[1], ok: script[2] === "0", ms: Number(script[3]) };
  }
  // The ms group must not sit after a lazy wildcard — an optional group
  // beyond `.*?` is satisfied by matching nothing, so it never captures.
  const api = /^api:\s*([A-Z]+)\s+(\S+)\s*→\s*(?:(\d{3})\s*\((\d+)ms\)|(\d{3})|error\b)/.exec(text);
  if (api) {
    const status = api[3] ?? api[5]; // timed, or untimed; undefined = "error"
    return {
      kind: "api",
      name: `${api[1]} ${api[2]}`,
      ok: status !== undefined && Number(status) < 400,
      ms: api[4] ? Number(api[4]) : null,
    };
  }
  return null;
}

const day = (iso: string) => iso.slice(0, 10);

/** Seconds a run took end to end, or null while it is still going. */
function runSeconds(r: RunRecord): number | null {
  if (!r.finishedAt) return null;
  const ms = Date.parse(r.finishedAt) - Date.parse(r.startedAt);
  return Number.isFinite(ms) && ms >= 0 ? ms / 1000 : null;
}

/** The most useful line a failed step recorded — its own words, not ours. */
function failureText(s: StepRecord): string {
  const errors = (s.events ?? []).filter((e) => e.type === "error");
  if (errors.length) return errors[errors.length - 1].text;
  if (s.skipReason) return s.skipReason;
  return s.result ? String(s.result).slice(0, 300) : `step ${s.status}`;
}

export function observeWorkspace(
  tenant: string,
  workspace: string,
  sinceDays = 30,
  now = new Date(),
): Observation {
  const cutoff = new Date(now.getTime() - sinceDays * 86_400_000).toISOString();
  const runs = listRuns(tenant, workspace).filter((r) => r.startedAt >= cutoff);

  const agents = new Map<string, AgentStat & { _secs: number[] }>();
  const tools = new Map<string, ToolStat & { _ms: number[]; _agents: Set<string> }>();
  const flows = new Map<string, FlowStat & { _secs: number[] }>();
  const days = new Map<string, DayStat>();
  const failures: Failure[] = [];

  let steps = 0;
  let costUsd = 0;
  let failedRuns = 0;

  for (const r of runs) {
    const d = days.get(day(r.startedAt)) ?? { day: day(r.startedAt), runs: 0, failed: 0, costUsd: 0 };
    d.runs += 1;
    if (r.status === "failed") {
      d.failed += 1;
      failedRuns += 1;
    }

    const f = flows.get(r.flow) ?? { flow: r.flow, runs: 0, failed: 0, seconds: sampled([]), costUsd: 0, _secs: [] };
    f.runs += 1;
    if (r.status === "failed") f.failed += 1;
    const secs = runSeconds(r);
    if (secs !== null) f._secs.push(secs);

    for (const s of r.steps ?? []) {
      steps += 1;
      const a = agents.get(s.agent) ?? {
        agent: s.agent, steps: 0, failed: 0, retried: 0, skipped: 0,
        costUsd: 0, inputTokens: 0, outputTokens: 0, seconds: sampled([]), _secs: [],
      };
      a.steps += 1;
      if (s.status === "failed") a.failed += 1;
      if ((s.attempts ?? 1) > 1) a.retried += 1;
      if (s.status === "skipped" || s.skipReason) a.skipped += 1;
      a.costUsd += s.costUsd ?? 0;
      a.inputTokens += s.tokens?.input ?? 0;
      a.outputTokens += s.tokens?.output ?? 0;
      if (typeof s.computeSecs === "number") a._secs.push(s.computeSecs);
      agents.set(s.agent, a);

      costUsd += s.costUsd ?? 0;
      f.costUsd += s.costUsd ?? 0;
      d.costUsd += s.costUsd ?? 0;

      if (s.status === "failed") {
        failures.push({
          runId: r.id,
          flow: r.flow,
          agent: s.agent,
          at: (s.events ?? []).at(-1)?.t ?? r.startedAt,
          attempts: s.attempts ?? 1,
          text: failureText(s),
        });
      }

      // Tool calls: the `tool` events count them, the info lines measure the
      // ones that measured themselves.
      for (const e of s.events ?? []) {
        if (e.type === "tool") {
          const name = e.text.replace(/^mcp__foldrun_(scripts|apis)__/, "");
          const t = tools.get(name) ?? {
            name, calls: 0, errors: 0, measured: 0, ms: sampled([]), agents: [],
            _ms: [], _agents: new Set<string>(),
          };
          t.calls += 1;
          t._agents.add(s.agent);
          tools.set(name, t);
        } else if (e.type === "info") {
          const parsed = parseToolLog(e.text);
          if (!parsed) continue;
          const t = tools.get(parsed.name) ?? {
            name: parsed.name, calls: 0, errors: 0, measured: 0, ms: sampled([]), agents: [],
            _ms: [], _agents: new Set<string>(),
          };
          // A script tool's outcome line describes a call its `tool` event
          // already counted, so it adds outcome, never a count. An API tool
          // has no tool_use event of its own name — its log line IS the only
          // record the call happened, so every line counts. (This used to
          // count only the timed ones, and a tool whose two calls both
          // errored untimed showed errors > calls.)
          if (parsed.kind === "api") t.calls += 1;
          if (!parsed.ok) t.errors += 1;
          if (parsed.ms !== null) {
            t._ms.push(parsed.ms);
            t.measured += 1;
          }
          t._agents.add(s.agent);
          tools.set(parsed.name, t);
        }
      }
    }

    flows.set(r.flow, f);
    days.set(d.day, d);
  }

  const finishAgents = [...agents.values()]
    .map(({ _secs, ...a }) => ({ ...a, seconds: sampled(_secs) }))
    .sort((x, y) => y.costUsd - x.costUsd || y.steps - x.steps);

  const finishTools = [...tools.values()]
    .map(({ _ms, _agents, ...t }) => ({ ...t, ms: sampled(_ms), agents: [..._agents].sort() }))
    .sort((x, y) => y.errors - x.errors || y.calls - x.calls);

  const finishFlows = [...flows.values()]
    .map(({ _secs, ...f }) => ({ ...f, seconds: sampled(_secs) }))
    .sort((x, y) => y.runs - x.runs);

  // Zero-fill the day series: a month with three active days must render as
  // a month with gaps, not as three adjacent bars pretending to be a streak.
  for (let i = sinceDays - 1; i >= 0; i--) {
    const d = day(new Date(now.getTime() - i * 86_400_000).toISOString());
    if (!days.has(d)) days.set(d, { day: d, runs: 0, failed: 0, costUsd: 0 });
  }

  return {
    workspace,
    sinceDays,
    from: runs.length ? runs[runs.length - 1].startedAt : null,
    runs: runs.length,
    failedRuns,
    steps,
    costUsd,
    agents: finishAgents,
    tools: finishTools,
    flows: finishFlows,
    days: [...days.values()].sort((a, b) => a.day.localeCompare(b.day)),
    // Newest first, and bounded: this is a "what just broke" list, not an
    // archive. The run trace is the archive.
    failures: failures.sort((a, b) => b.at.localeCompare(a.at)).slice(0, 50),
  };
}
