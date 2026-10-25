// Model comparisons: one eval's cases, run under two to four model settings,
// side by side (feature 2, 24 Oct 2026).
//
// "Could this step run on the fast model?" was a guess: switch it, watch a
// week of desks, switch it back. A comparison answers it from the cases you
// already have — each configuration runs every case, `repeat` times, and the
// result says per configuration how many passed, what it cost (the runs and
// their judges) and how long a run took, and per case where they differ.
//
// The rules, settled in a Codex debate (24 Oct 2026):
//   · The model is forced on the steps (every step of a flow eval, or only
//     `agent`'s), so it wins over the agent's own `model:` and the flow's.
//   · Every run is a test run, whatever the eval or the flow says about
//     `live:` — a comparison is never the reason something was sent.
//   · The judge is the eval's own, the same for every configuration: what
//     changes is the subject, never the grader.
//   · Bounded twice: at most MAX_TRIALS case runs, and `maxUsd` — once the
//     runs and judges have spent it, the rest are recorded as not run.
//   · A run's time is from a worker picking it up to its end; queueing is
//     left out, so a busy account does not read as a slow model.
//   · The repeats interleave (each configuration once, then again), so a
//     provider that slows down mid-way slows every configuration alike.
//   · Graders and saved inputs are not comparable: they have no cases to run.
//   · Nothing here writes the eval's latest result or its history.

import { runEval, type EvalInfo, type EvalResult } from "./evals.ts";
import { resolveEffort, type Effort } from "./store.ts";
import { loadFlow } from "./runner.ts";

export const MAX_CONFIGS = 4;
export const MAX_REPEAT = 5;
export const MAX_TRIALS = 60;
export const DEFAULT_MAX_USD = 5;
export const MAX_MAX_USD = 100;

export interface CompareConfig {
  /** A tier (fast, default, max) or a model id. */
  model: string;
  effort?: Effort | null;
  /** Flow evals: only this agent's steps take the model. */
  agent?: string | null;
}

export interface ComparePlan {
  configs: CompareConfig[];
  repeat: number;
  maxUsd: number;
  /** cases × configs × repeat. */
  trials: number;
}

export interface CompareCaseRow {
  case: string;
  /** Per configuration, in order: passed of trials. */
  passed: number[];
  trials: number[];
}

export interface CompareConfigResult extends CompareConfig {
  label: string;
  trials: number;
  passed: number;
  /** Trials that were not run (the cap) or could not run (an error before any check). */
  notRun: number;
  /** passed / decided trials; null when none ran. */
  rate: number | null;
  /** The runs and their judges, USD. */
  costUsd: number;
  judgeCostUsd: number;
  /** Per case run that finished, the mean, USD and seconds. */
  avgCostUsd: number | null;
  avgSecs: number | null;
  /** Every run this configuration started, for opening one. */
  runIds: string[];
}

export interface EvalComparison {
  eval: string;
  target: { flow: string | null; agent: string | null };
  judge: { model: string; effort: Effort | null };
  startedAt: string;
  finishedAt: string;
  repeat: number;
  maxUsd: number;
  spentUsd: number;
  /** Why it stopped early, when it did. */
  stopped: string | null;
  configs: CompareConfigResult[];
  cases: CompareCaseRow[];
}

function refuse(message: string, status: number): Error {
  return Object.assign(new Error(message), { status });
}

const MODEL = /^[A-Za-z0-9][\w.:/-]{0,99}$/;

export const configLabel = (c: CompareConfig) =>
  `${c.model}${c.effort ? ` · ${c.effort}` : ""}${c.agent ? ` · ${c.agent} only` : ""}`;

/**
 * Read and bound a request. Throws with a status: 400 for a shape, 413 when
 * it is too big to run. The eval must have cases and not be a grader.
 */
export function planComparison(info: EvalInfo, body: unknown): ComparePlan {
  if (info.trigger === "runs") throw refuse(`${info.name} grades real runs — it has no cases to compare models on`, 400);
  if (info.inputs) throw refuse(`${info.name} is a file of saved inputs, not an eval`, 400);
  if (info.cases.length === 0) throw refuse(`${info.name} has no cases`, 400);
  // A comparison promises test runs only; a run: check is a command on the
  // platform's host, run again for every case of every setting and repeat.
  const runs = info.cases.find((c) => c.expect.some((a) => a.type === "run"));
  if (runs) throw refuse(`${info.name} has a run: check (case "${runs.name}") — a comparison repeats every check many times and run: executes a command, so it cannot be compared; use contains, matches or judge`, 400);
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  if (!Array.isArray(b.configs) || b.configs.length < 2) throw refuse("expected { configs: [{ model, effort?, agent? }, …] } — two to four settings to compare", 400);
  if (b.configs.length > MAX_CONFIGS) throw refuse(`at most ${MAX_CONFIGS} settings in one comparison`, 400);
  const configs: CompareConfig[] = b.configs.map((raw, i) => {
    const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
    if (typeof r.model !== "string" || !MODEL.test(r.model.trim())) throw refuse(`configs[${i}].model is a tier (fast, default, max) or a model id`, 400);
    let effort: Effort | null = null;
    if (r.effort !== undefined && r.effort !== null && r.effort !== "") {
      effort = resolveEffort(r.effort);
      if (!effort) throw refuse(`configs[${i}].effort is low, medium, high, xhigh or max`, 400);
    }
    let agent: string | null = null;
    if (r.agent !== undefined && r.agent !== null && r.agent !== "") {
      if (!info.flow) throw refuse(`configs[${i}].agent picks one agent's steps of a flow eval — ${info.name} tests agent ${info.agent} already`, 400);
      if (typeof r.agent !== "string" || !/^[a-z0-9][a-z0-9-]{0,60}$/.test(r.agent)) throw refuse(`configs[${i}].agent is an agent's name`, 400);
      agent = r.agent;
    }
    return { model: r.model.trim(), effort, agent };
  });
  const keys = configs.map(configLabel);
  if (new Set(keys).size !== keys.length) throw refuse("two settings are the same — each one should differ", 400);
  const repeat = b.repeat === undefined ? 1 : Number(b.repeat);
  if (!Number.isInteger(repeat) || repeat < 1 || repeat > MAX_REPEAT) throw refuse(`repeat is a whole number from 1 to ${MAX_REPEAT}`, 400);
  const maxUsd = b.maxUsd === undefined ? DEFAULT_MAX_USD : Number(b.maxUsd);
  if (!Number.isFinite(maxUsd) || maxUsd <= 0 || maxUsd > MAX_MAX_USD) throw refuse(`maxUsd is a spend limit in USD, above 0 and at most ${MAX_MAX_USD}`, 400);
  const trials = info.cases.length * configs.length * repeat;
  if (trials > MAX_TRIALS) {
    throw refuse(`${info.cases.length} cases × ${configs.length} settings × ${repeat} = ${trials} runs — at most ${MAX_TRIALS}; fewer settings or repeats`, 413);
  }
  return { configs, repeat, maxUsd, trials };
}

/**
 * Run the comparison. `onProgress` hears each finished pass of one
 * configuration (done of total case runs). `run` is the eval runner —
 * injectable, so a test needs no model.
 */
/** A flow eval's `agent` must have steps in the flow, or the comparison
 *  would run the original models under the requested labels. */
function assertAgentsInFlow(tenant: string, workspace: string, info: EvalInfo, plan: ComparePlan) {
  const named = plan.configs.map((c) => c.agent).filter((a): a is string => !!a);
  if (!info.flow || !named.length) return;
  const flow = loadFlow(tenant, workspace, info.flow);
  const agents = new Set((flow?.steps ?? []).map((s) => s.agent));
  const missing = named.find((a) => !agents.has(a));
  if (missing) throw refuse(`flow ${info.flow} has no step by ${missing} — pick an agent it runs`, 400);
}

export async function compareEval(
  tenant: string,
  workspace: string,
  info: EvalInfo,
  plan: ComparePlan,
  opts: { onProgress?: (done: number, total: number) => void | Promise<void>; run?: typeof runEval } = {},
): Promise<EvalComparison> {
  if (!opts.run) assertAgentsInFlow(tenant, workspace, info, plan);
  const run = opts.run ?? runEval;
  const startedAt = new Date().toISOString();
  const results: EvalResult[][] = plan.configs.map(() => []);
  let spent = 0;
  let stopped: string | null = null;
  let done = 0;
  for (let r = 0; r < plan.repeat; r++) {
    for (let i = 0; i < plan.configs.length; i++) {
      const cfg = plan.configs[i];
      const result = await run(tenant, workspace, info, {
        model: cfg.model,
        effort: cfg.effort ?? null,
        agent: cfg.agent ?? null,
        forceTest: true,
        beforeCase: () => {
          if (spent >= plan.maxUsd) {
            stopped ??= `the spend limit of $${plan.maxUsd.toFixed(2)} was reached`;
            return stopped;
          }
          return null;
        },
        // Counted as each case ends, so the limit holds inside a setting too.
        afterCase: (c) => {
          spent += c.costUsd + (c.judgeCostUsd ?? 0);
        },
      });
      results[i].push(result);
      done += info.cases.length;
      await opts.onProgress?.(done, plan.trials);
    }
  }

  const round = (n: number, d = 4) => Math.round(n * 10 ** d) / 10 ** d;
  const configs: CompareConfigResult[] = plan.configs.map((cfg, i) => {
    const cases = results[i].flatMap((r) => r.cases);
    const ran = cases.filter((c) => c.runId);
    const notRun = cases.filter((c) => !c.passed && c.error && !c.assertions.length).length;
    const passed = cases.filter((c) => c.passed).length;
    const decided = cases.length - notRun;
    const cost = cases.reduce((n, c) => n + c.costUsd, 0);
    const judge = cases.reduce((n, c) => n + (c.judgeCostUsd ?? 0), 0);
    const timed = ran.filter((c) => typeof c.secs === "number");
    return {
      ...cfg,
      label: configLabel(cfg),
      trials: cases.length,
      passed,
      notRun,
      rate: decided ? round(passed / decided, 3) : null,
      costUsd: round(cost + judge),
      judgeCostUsd: round(judge),
      avgCostUsd: ran.length ? round((cost + judge) / ran.length) : null,
      avgSecs: timed.length ? Math.round((timed.reduce((n, c) => n + (c.secs ?? 0), 0) / timed.length) * 10) / 10 : null,
      runIds: ran.map((c) => c.runId!),
    };
  });
  const cases: CompareCaseRow[] = info.cases.map((c) => ({
    case: c.name,
    passed: results.map((rs) => rs.flatMap((r) => r.cases).filter((x) => x.name === c.name && x.passed).length),
    trials: results.map((rs) => rs.flatMap((r) => r.cases).filter((x) => x.name === c.name).length),
  }));
  return {
    eval: info.name,
    target: { flow: info.flow, agent: info.agent },
    judge: { model: info.model, effort: info.effort },
    startedAt,
    finishedAt: new Date().toISOString(),
    repeat: plan.repeat,
    maxUsd: plan.maxUsd,
    spentUsd: round(spent),
    stopped,
    configs,
    cases,
  };
}
