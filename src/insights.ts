// Insights (FOL-72 step 8): the problems that recur without failing anything,
// found in the runs with no setup — each with its evidence, what it costs and
// what to do. The operator's "3 problems, here is why" instead of a list of
// runs. Pure: the API, the Observe page and `foldrun insights` read the same.
//
//   cache      an agent re-reads a big prompt uncached, step after step
//   big-result a tool's result is large and every later model call sends it again
//   retry-loop a tool errors again and again inside one step
//   timeout    steps that use most of their `timeout:` — the next bigger input fails
//
// Costs are estimates in credits from the steps' own token costs (a credit
// is a cent of USD), said as "about".

import type { RunRecord, StepRecord } from "./store.ts";

export type InsightKind = "cache" | "big-result" | "retry-loop" | "timeout";

export interface Insight {
  id: string;
  kind: InsightKind;
  workspace: string;
  agent: string;
  tool?: string;
  title: string;
  /** Why it happens, in a sentence. */
  why: string;
  fix: string;
  /** About how many credits it cost in the window; null when not money. */
  credits: number | null;
  /** How many steps showed it. */
  steps: number;
  /** The newest runs it was seen in, at most 5. */
  evidence: { workspace: string; runId: string; step: number }[];
}

type Run = RunRecord & { workspace: string };

/** A cached input token costs about a tenth of a fresh one. */
const CACHE_SAVING = 0.9;
/** Characters to tokens, roughly, for text in a conversation. */
const CHARS_PER_TOKEN = 4;
const BIG_RESULT = 20_000;

const stepRefs = (hits: { run: Run; index: number }[]) =>
  [...hits].sort((a, b) => b.run.startedAt.localeCompare(a.run.startedAt)).slice(0, 5).map((h) => ({ workspace: h.run.workspace, runId: h.run.id, step: h.index + 1 }));

const credits = (usd: number) => Math.round(usd * 100);

export function findInsights(runs: Run[], opts: { minSteps?: number } = {}): Insight[] {
  const min = opts.minSteps ?? 3;
  const steps: { run: Run; index: number; s: StepRecord }[] = [];
  for (const run of runs) run.steps.forEach((s, index) => {
    if (s.status === "completed" || s.status === "failed") steps.push({ run, index, s });
  });
  const out: Insight[] = [];
  const byAgent = new Map<string, typeof steps>();
  for (const x of steps) {
    const k = `${x.run.workspace}\u0000${x.s.agent}`;
    (byAgent.get(k) ?? byAgent.set(k, []).get(k)!).push(x);
  }

  for (const [k, list] of byAgent) {
    const [workspace, agent] = k.split("\u0000") as [string, string];

    // cache: big inputs, little of it from the cache, on most of its steps.
    const measured = list.filter((x) => x.s.tokens && x.s.tokens.cacheRead !== undefined && x.s.tokens.input >= 20_000);
    const poor = measured.filter((x) => (x.s.tokens!.cacheRead ?? 0) / x.s.tokens!.input < 0.3);
    if (poor.length >= min && poor.length >= measured.length / 2) {
      const usd = poor.reduce((n, x) => {
        const t = x.s.tokens!;
        const uncached = Math.max(0, t.input - (t.cacheRead ?? 0)) / Math.max(1, t.input);
        return n + (x.s.costUsd ?? 0) * uncached * CACHE_SAVING * 0.5;
      }, 0);
      const rate = Math.round((100 * poor.reduce((n, x) => n + (x.s.tokens!.cacheRead ?? 0), 0)) / Math.max(1, poor.reduce((n, x) => n + x.s.tokens!.input, 0)));
      out.push({
        id: `cache/${workspace}/${agent}`,
        kind: "cache",
        workspace,
        agent,
        title: `${agent} reads its prompt mostly uncached (${rate}% from the cache)`,
        why: "Each call sends a large prompt that the model's cache rarely serves: something near its start changes from call to call (a date, a run id, a file listing), or the steps are spaced further apart than the cache lasts.",
        fix: "Keep what changes (dates, ids, the task) at the end of the agent's prompt and the large fixed part first; run its steps closer together.",
        credits: credits(usd),
        steps: poor.length,
        evidence: stepRefs(poor),
      });
    }

    // big-result: a tool's result over 20k characters with calls after it,
    // each of which sends it again.
    const big = new Map<string, { hits: typeof list; usd: number; chars: number }>();
    for (const x of list) {
      const callsAfter = (at: string) => (x.s.calls ?? []).filter((c) => c.at > at).length;
      const turns = x.s.calls?.length ?? x.s.turns ?? 0;
      for (const e of x.s.events) {
        if (e.type !== "tool" || e.ms == null || (e.bytes ?? 0) < BIG_RESULT) continue;
        const after = x.s.calls ? callsAfter(e.t) : Math.max(0, turns - 1);
        if (after < 2) continue;
        const tokensResent = ((e.bytes ?? 0) / CHARS_PER_TOKEN) * after;
        const input = Math.max(1, x.s.tokens?.input ?? 0);
        const share = Math.min(1, tokensResent / input);
        const b = big.get(e.text) ?? { hits: [], usd: 0, chars: 0 };
        if (!b.hits.includes(x)) b.hits.push(x);
        b.usd += (x.s.costUsd ?? 0) * share;
        b.chars = Math.max(b.chars, e.bytes ?? 0);
        big.set(e.text, b);
      }
    }
    for (const [tool, b] of big) {
      if (b.hits.length < min) continue;
      out.push({
        id: `big-result/${workspace}/${agent}/${tool}`,
        kind: "big-result",
        workspace,
        agent,
        tool,
        title: `${tool} hands ${agent} results up to ${Math.round(b.chars / 1000)}k characters, sent again on every later call`,
        why: "A tool result stays in the conversation, so every model call after it pays for it again.",
        fix: `Have ${tool} return less (filter, a summary, or write the bulk to a file and return the path), or split the step so the big read ends it.`,
        credits: credits(b.usd),
        steps: b.hits.length,
        evidence: stepRefs(b.hits),
      });
    }

    // retry-loop: one tool erroring three or more times in a step.
    const loops = new Map<string, typeof list>();
    for (const x of list) {
      const errs = new Map<string, number>();
      for (const e of x.s.events) if (e.type === "tool" && e.ms != null && e.err) errs.set(e.text, (errs.get(e.text) ?? 0) + 1);
      for (const [tool, n] of errs) if (n >= 3) (loops.get(tool) ?? loops.set(tool, []).get(tool)!).push(x);
    }
    for (const [tool, hits] of loops) {
      if (hits.length < Math.min(min, 2)) continue;
      out.push({
        id: `retry-loop/${workspace}/${agent}/${tool}`,
        kind: "retry-loop",
        workspace,
        agent,
        tool,
        title: `${agent} keeps retrying ${tool} after it errors`,
        why: "The tool fails the same way and the agent tries again instead of stopping — every attempt is a model call and a tool call.",
        fix: `Read one of the errors (the trace's input / output): fix the tool or its input, or tell ${agent} in its prompt to stop after one failure and say BLOCKED with why.`,
        credits: credits(hits.reduce((n, x) => n + (x.s.costUsd ?? 0) * 0.3, 0)),
        steps: hits.length,
        evidence: stepRefs(hits),
      });
    }

    // timeout: steps that took 80% or more of their timeout.
    const tight = list.filter((x) => {
      if (!x.s.timeout || !x.s.startedAt || !x.s.finishedAt) return false;
      const secs = (Date.parse(x.s.finishedAt) - Date.parse(x.s.startedAt)) / 1000;
      return secs >= 0.8 * x.s.timeout;
    });
    if (tight.length >= Math.min(min, 2)) {
      const limit = tight[0]!.s.timeout!;
      out.push({
        id: `timeout/${workspace}/${agent}`,
        kind: "timeout",
        workspace,
        agent,
        title: `${agent} uses most of its ${limit}s timeout`,
        why: "Steps finish just inside their limit; a slightly bigger input or a slow site and they are cut off.",
        fix: "Raise timeout: on the step, or give the agent less to do per step (each: to fan out, a smaller batch).",
        credits: null,
        steps: tight.length,
        evidence: stepRefs(tight),
      });
    }
  }
  const order: Record<InsightKind, number> = { "retry-loop": 0, timeout: 1, "big-result": 2, cache: 3 };
  return out.sort((a, b) => (b.credits ?? -1) - (a.credits ?? -1) || order[a.kind] - order[b.kind]);
}
