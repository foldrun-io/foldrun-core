// Two runs of one flow side by side (FOL-72 step 6): "why did this get
// worse" read off the records — which files changed between the revisions
// they ran, and step by step what differs: status, the instruction, the
// model, time, tokens, model calls, the tools it used and the errors it hit.
// Pure; the caller hands in the changed files (history.ts changedPathsBetween).

import type { RunRecord, StepRecord } from "./store.ts";

export interface StepSide {
  status: string;
  instruction: string;
  model?: string;
  secs: number | null;
  tokensIn: number;
  tokensOut: number;
  modelCalls: number;
  /** Tool name → how many calls. */
  tools: Record<string, number>;
  toolErrors: number;
  /** The first errors it wrote, each one line. */
  errors: string[];
  /** The first line of what it concluded. */
  said: string | null;
}

export interface StepDiff {
  /** 1-based, as the trace numbers steps. */
  step: number;
  agent: string;
  base: StepSide | null;
  run: StepSide | null;
  /** What differs, in words, most telling first; [] when nothing does. */
  changes: string[];
}

export interface RunComparison {
  base: { id: string; status: string; startedAt: string; revision: string | null };
  run: { id: string; status: string; startedAt: string; revision: string | null };
  revisionChanged: boolean;
  /** Files changed between the two revisions; null when that cannot be said. */
  changedFiles: string[] | null;
  steps: StepDiff[];
}

const firstLine = (s: string | null | undefined, n = 200) => {
  const l = (s ?? "").split("\n").map((x) => x.trim()).find(Boolean);
  return l ? l.slice(0, n) : null;
};

function side(s: StepRecord): StepSide {
  const tools: Record<string, number> = {};
  let toolErrors = 0;
  for (const e of s.events) {
    if (e.type !== "tool") continue;
    // A pair is one call: count the call, and its completion's error.
    if (e.ms == null) tools[e.text] = (tools[e.text] ?? 0) + 1;
    else if (e.err) toolErrors++;
  }
  const start = s.startedAt ? Date.parse(s.startedAt) : NaN;
  const end = s.finishedAt ? Date.parse(s.finishedAt) : NaN;
  return {
    status: s.status,
    instruction: s.instruction,
    ...(s.model ? { model: s.model } : {}),
    secs: Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, Math.round((end - start) / 1000)) : null,
    tokensIn: s.tokens?.input ?? 0,
    tokensOut: s.tokens?.output ?? 0,
    modelCalls: s.calls?.length ?? s.turns ?? 0,
    tools,
    toolErrors,
    errors: s.events.filter((e) => e.type === "error").slice(0, 3).map((e) => firstLine(e.text) ?? ""),
    said: firstLine(s.conclusion ?? s.result),
  };
}

const k = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

/** Much more or much less: by a quarter and by a real amount. */
const moved = (a: number, b: number, floor: number) => Math.abs(b - a) >= floor && (a === 0 ? b > 0 : Math.abs(b - a) / a >= 0.25);

function changes(a: StepSide | null, b: StepSide | null): string[] {
  if (!a && b) return ["new step: not in the base run"];
  if (a && !b) return ["not in this run"];
  if (!a || !b) return [];
  const out: string[] = [];
  if (a.status !== b.status) out.push(`status: ${a.status} → ${b.status}`);
  const newErrors = b.errors.filter((e) => !a.errors.includes(e));
  if (newErrors.length) out.push(`new error: ${newErrors[0]}`);
  if (a.instruction.trim() !== b.instruction.trim()) out.push("instruction changed");
  if ((a.model ?? "") !== (b.model ?? "")) out.push(`model: ${a.model ?? "default"} → ${b.model ?? "default"}`);
  if (b.toolErrors > a.toolErrors) out.push(`tool errors: ${a.toolErrors} → ${b.toolErrors}`);
  const names = new Set([...Object.keys(a.tools), ...Object.keys(b.tools)]);
  const toolDiff = [...names]
    .map((n) => ({ n, d: (b.tools[n] ?? 0) - (a.tools[n] ?? 0) }))
    .filter((x) => x.d !== 0)
    .sort((x, y) => Math.abs(y.d) - Math.abs(x.d))
    .slice(0, 4)
    .map((x) => `${x.d > 0 ? "+" : "−"}${x.n} ×${Math.abs(x.d)}`);
  if (toolDiff.length) out.push(`tools: ${toolDiff.join(", ")}`);
  if (a.secs !== null && b.secs !== null && moved(a.secs, b.secs, 10)) out.push(`took ${a.secs}s → ${b.secs}s`);
  if (moved(a.tokensIn, b.tokensIn, 5000)) out.push(`tokens in ${k(a.tokensIn)} → ${k(b.tokensIn)}`);
  if (moved(a.modelCalls, b.modelCalls, 3)) out.push(`model calls ${a.modelCalls} → ${b.modelCalls}`);
  if (a.said !== b.said && b.said) out.push(`said: ${b.said}`);
  return out;
}

/** Steps lined up: the flow's own steps by position where the agents agree,
 *  fan-out instances by agent and order. */
function align(a: StepRecord[], b: StepRecord[]): [StepRecord | null, StepRecord | null][] {
  const pairs: [StepRecord | null, StepRecord | null][] = [];
  const used = new Set<number>();
  b.forEach((s, i) => {
    let j = a[i] && a[i]!.agent === s.agent && !used.has(i) ? i : -1;
    if (j < 0) j = a.findIndex((x, m) => !used.has(m) && x.agent === s.agent);
    if (j >= 0) used.add(j);
    pairs.push([j >= 0 ? a[j]! : null, s]);
  });
  a.forEach((s, m) => !used.has(m) && pairs.push([s, null]));
  return pairs;
}

export function compareRuns(base: RunRecord, run: RunRecord, changedFiles: string[] | null = null): RunComparison {
  const head = (r: RunRecord) => ({ id: r.id, status: r.status, startedAt: r.startedAt, revision: r.revision ?? null });
  return {
    base: head(base),
    run: head(run),
    revisionChanged: (base.revision ?? null) !== (run.revision ?? null),
    changedFiles,
    steps: align(base.steps, run.steps).map(([a, b], i) => {
      const sa = a ? side(a) : null;
      const sb = b ? side(b) : null;
      return { step: b ? run.steps.indexOf(b) + 1 : i + 1, agent: (b ?? a)!.agent, base: sa, run: sb, changes: changes(sa, sb) };
    }),
  };
}

/** The run to compare a run with when none is named: the newest earlier run
 *  of the same flow that finished well (completed, not BLOCKED or BAD), or
 *  null. `outcomeOf` is the caller's, so this stays free of the verdict reader. */
export function lastGoodBefore<R extends { id: string; flow: string; startedAt: string }>(runs: R[], run: { id: string; flow: string; startedAt: string }, good: (r: R) => boolean): R | null {
  return (
    runs
      .filter((r) => r.flow === run.flow && r.id !== run.id && r.startedAt < run.startedAt && good(r))
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0] ?? null
  );
}
