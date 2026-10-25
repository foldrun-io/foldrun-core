// A run as one tree (FOL-72 step 5): run → step → model call → tool call,
// each with when it started and ended, what it cost in tokens and how it
// ended — the waterfall every agent-tracing tool opens on. Built from the
// run record alone (steps, step.calls, the paired tool events), so the run
// page, GET …/runs/<id>/trace and `foldrun report --tree` read one function.
//
// A tool call nests under the model call that asked for it: its event names
// the call (`inCall`) since 19 Oct 2026; older records are matched by time,
// to the last model call that answered before the tool started. Pure: no
// node imports, so the browser can use it.

import type { RunRecord, StepRecord, RunEvent, ModelCall } from "./store.ts";

export type SpanKind = "run" | "step" | "model" | "tool" | "error";
export type SpanStatus = "ok" | "error" | "running" | "waiting" | "skipped" | "pending";

export interface TraceSpan {
  /** Stable within the run: "run", "s2", "s2/m3", "s2/t:<call>", "s2/e5". */
  id: string;
  kind: SpanKind;
  /** What the line says: the flow, the agent, the model, the tool. */
  label: string;
  /** Epoch ms; null when the record does not say. */
  start: number | null;
  end: number | null;
  status: SpanStatus;
  /** Model and step spans: tokens (input is all input, as on the record). */
  tokens?: { input: number; output: number; cacheRead: number; cacheWrite: number };
  /** Step spans: the provider's token cost, USD. */
  costUsd?: number | null;
  model?: string;
  /** Model spans: why it stopped. */
  stop?: string;
  /** Tool spans: the call id, and whether its input and output were recorded. */
  call?: string;
  captured?: boolean;
  /** Error spans and failed tools: the words. */
  text?: string;
  subagent?: string;
  /** Index into run.steps, on a step and everything under it. */
  step?: number;
  children: TraceSpan[];
}

const ms = (iso: string | null | undefined) => {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
};

function stepStatus(s: StepRecord): SpanStatus {
  if (s.status === "completed") return "ok";
  if (s.status === "failed") return "error";
  if (s.status === "running") return "running";
  if (s.status === "awaiting-approval") return "waiting";
  if (s.status === "skipped") return "skipped";
  return "pending";
}

/** Tool events paired: the call's start, its duration, whether it erred. */
function toolCalls(events: RunEvent[]): { e: RunEvent; start: number | null; end: number | null; err: boolean; captured: boolean }[] {
  const byCall = new Map<string, { e: RunEvent; start: number | null; end: number | null; err: boolean; captured: boolean }>();
  const out: { e: RunEvent; start: number | null; end: number | null; err: boolean; captured: boolean }[] = [];
  for (const e of events) {
    if (e.type !== "tool") continue;
    if (e.call && e.ms != null && byCall.has(e.call)) {
      const open = byCall.get(e.call)!;
      open.end = (open.start ?? ms(e.t) ?? 0) + e.ms;
      open.err ||= e.err === true;
      open.captured ||= e.captured === true;
      continue;
    }
    const c = { e, start: ms(e.t), end: null as number | null, err: e.err === true, captured: e.captured === true };
    if (e.call) byCall.set(e.call, c);
    out.push(c);
  }
  return out;
}

function modelSpan(c: ModelCall, step: number): TraceSpan {
  const at = ms(c.at);
  return {
    id: `s${step}/m${c.attempt && c.attempt > 1 ? `${c.attempt}.` : ""}${c.n}`,
    kind: "model",
    label: c.model ?? "model",
    // The request went out `ms` before the response began arriving.
    start: at !== null ? at - c.ms : null,
    end: at,
    status: "ok",
    tokens: c.tokens,
    ...(c.model ? { model: c.model } : {}),
    ...(c.stop ? { stop: c.stop } : {}),
    ...(c.subagent ? { subagent: c.subagent } : {}),
    step,
    children: [],
  };
}

function stepSpan(s: StepRecord, i: number, now: number): TraceSpan {
  const first = s.events[0] ? ms(s.events[0].t) : null;
  const last = s.events.length ? ms(s.events[s.events.length - 1]!.t) : null;
  const status = stepStatus(s);
  const span: TraceSpan = {
    id: `s${i}`,
    kind: "step",
    label: s.agent,
    start: ms(s.startedAt) ?? first,
    end: ms(s.finishedAt) ?? (status === "running" ? now : last),
    status,
    ...(s.tokens ? { tokens: { input: s.tokens.input, output: s.tokens.output, cacheRead: s.tokens.cacheRead ?? 0, cacheWrite: s.tokens.cacheWrite ?? 0 } } : {}),
    costUsd: s.costUsd ?? null,
    ...(s.model ? { model: s.model } : {}),
    step: i,
    children: [],
  };

  const models = (s.calls ?? []).map((c) => ({ c, span: modelSpan(c, i) }));
  const byId = new Map(models.map((m) => [m.c.id, m.span]));
  const homeOf = (e: RunEvent, start: number | null): TraceSpan => {
    if (e.inCall && byId.has(e.inCall)) return byId.get(e.inCall)!;
    // Older records: the last model call (of the same agent) that answered
    // before the tool started.
    const same = models.filter((m) => (m.c.subagent ?? null) === (e.subagent ?? null) && m.span.end !== null && start !== null && m.span.end <= start + 50);
    return same.length ? same[same.length - 1]!.span : span;
  };

  for (const t of toolCalls(s.events)) {
    const home = homeOf(t.e, t.start);
    const tool: TraceSpan = {
      id: `s${i}/t:${t.e.call ?? `${t.start}`}`,
      kind: "tool",
      label: t.e.text,
      start: t.start,
      end: t.end ?? (status === "running" ? now : t.start),
      status: t.err ? "error" : t.end === null && status === "running" ? "running" : "ok",
      ...(t.e.call ? { call: t.e.call } : {}),
      ...(t.captured ? { captured: true } : {}),
      ...(t.e.subagent ? { subagent: t.e.subagent } : {}),
      step: i,
      children: [],
    };
    home.children.push(tool);
  }
  // A model call lasts until the last tool it asked for has finished.
  for (const m of models) {
    const ends = m.span.children.map((c) => c.end).filter((x): x is number => x !== null);
    if (ends.length && m.span.end !== null) m.span.end = Math.max(m.span.end, ...ends);
  }
  span.children.push(...models.map((m) => m.span));

  // Errors, as leaves: why the step failed, read without opening the trace.
  s.events.forEach((e, k) => {
    if (e.type !== "error") return;
    span.children.push({ id: `s${i}/e${k}`, kind: "error", label: "error", start: ms(e.t), end: ms(e.t), status: "error", text: e.text, step: i, children: [] });
  });
  span.children.sort((a, b) => (a.start ?? Infinity) - (b.start ?? Infinity));
  return span;
}

export function buildTraceTree(run: RunRecord, now = Date.now()): TraceSpan {
  const status: SpanStatus =
    run.status === "completed" ? "ok" : run.status === "failed" ? "error" : run.status === "awaiting-approval" ? "waiting" : run.status === "queued" ? "pending" : "running";
  return {
    id: "run",
    kind: "run",
    label: run.flow,
    start: ms(run.startedAt),
    end: ms(run.finishedAt) ?? (status === "running" || status === "waiting" ? now : null),
    status,
    children: run.steps.map((s, i) => stepSpan(s, i, now)),
  };
}

/** The ids from the root to the first thing that went wrong — what the
 *  view opens on; [] when nothing did. A failed tool beats the step's error
 *  line, which beats the failed step itself. */
export function failurePath(root: TraceSpan): string[] {
  let best: { path: string[]; rank: number } | null = null;
  const rank = (s: TraceSpan) => (s.kind === "tool" ? 3 : s.kind === "error" ? 2 : s.kind === "step" ? 1 : 0);
  const walk = (s: TraceSpan, path: string[]) => {
    const here = [...path, s.id];
    if (s.status === "error" && s.kind !== "run" && (!best || rank(s) > best.rank)) best = { path: here, rank: rank(s) };
    for (const c of s.children) walk(c, here);
  };
  walk(root, []);
  return best ? (best as { path: string[] }).path : [];
}
