// One run as one record: its funnel, what it held and used, what it cost,
// and how it ended (FOL-122) — the platform's wide event, built from the
// run record (and what the queue adds) by one pure function, so every
// writer and every test reads the same answer.
//
//   submitted → queued → scheduled → pod ready → sandbox up → first output → finished
//
// · submitted    the record was created (run.startedAt; status `queued`)
// · queued       its job first went into the queue (the platform's
//                run_events row, written at enqueue; else submitted)
// · eligible     when that job could first be claimed: the later of queued
//                and its `not_before` (a wait: is not queue wait)
// · claimed      a worker first claimed the job — which can still hand it
//                back (overlap:, the account's cap, a pause)
// · scheduled    a worker began driving the run (run.drivenAt): queue wait
//                is eligible → scheduled, what the customer waited
// · pod ready    the funnel step's pod was Running          (startup `ready`)
// · sandbox up   its runtime and tools were built            (`tools`)
// · first output the funnel step's model's first text or tool call
//                (`model`) — the same step's, so pod ready → first output
//                is one sandbox's cold start; the run's earliest output of
//                any step is kept beside it (earliestOutput)
// · finished     run.finishedAt
//
// The FUNNEL STEP is the step (not one carried from an earlier run, not a
// rescue or a sub-agent) whose start-up began first. Its marks are its last
// attempt's — the record keeps no earlier attempt's — placed on the clock
// from `startupAt` (the executor's own origin, 5 Nov 2026 on), else from
// the attempt's start: then `origin` says "estimated". The queue wait is the
// FIRST enqueue's; a run resumed later waits again, and that is not in it.
//
// What it may hold (FOL-121): the record's metadata only — ids, names,
// counts, durations, figures, classes. Never an instruction, a reply, an
// error's words or a file: those stay in the account's own run record.
// The ops trace built from it (opsTrace, below) is stricter still: every
// attribute goes through ops-log's field shapes.

import crypto from "node:crypto";
import { isSplicedRecord, runFailure, type RunRecord, type StepRecord } from "./store.ts";
import { ERROR_CLASSES, opsLine, type ErrorClass, type OpsFields } from "./ops-log.ts";
import { explainFailure, type FailureExplained, type FailureKind, type LimitScope } from "./failure.ts";
import { startupBreakdown, type StartupPhase } from "./startup.ts";

/** The funnel's marks, in order. */
export const FUNNEL = ["submitted", "queued", "eligible", "claimed", "scheduled", "podReady", "sandboxUp", "firstOutput", "finished"] as const;
export type FunnelMark = (typeof FUNNEL)[number];

/** Whether a finished run counts toward the success-rate SLI: `good`
 *  (completed), `bad` (failed, and the failure is ours, a provider's or the
 *  cluster's), or `excluded` (the customer's own code, settings or decision
 *  — sloOutcome). Null while the run is not finished. */
export type SloOutcome = "good" | "bad" | "excluded";

/** Why a failed run is excluded from the success rate, or why it is bad. */
export const SLO_REASONS = [
  "completed",
  // excluded
  "cancelled", "customer_code", "customer_check", "customer_budget", "customer_security", "customer_network", "customer_credential", "customer_limit",
  // bad
  "platform", "model", "capacity", "deadline", "unexplained",
] as const;
export type SloReason = (typeof SLO_REASONS)[number];

/** The SLO rule's version, on every row: a row says which rule judged it,
 *  so a change to the rule never silently rewrites history's meaning. */
export const SLO_RULES_VERSION = 1;

export interface RunWideEvent {
  runId: string;
  tenant: string;
  workspace: string;
  /** The flow's name, or the agent's for a direct agent run. */
  flow: string;
  kind: "flow" | "agent";
  test: boolean;
  status: RunRecord["status"];
  errorClass: ErrorClass | null;
  failureKind: FailureKind | null;
  failureScope: LimitScope | null;
  slo: SloOutcome | null;
  sloReason: SloReason | null;
  rulesVersion: number;
  /** The funnel step's runner image, model (its first model call's, else
   *  the step's own setting) and size class. */
  image: "full" | "slim" | null;
  model: string | null;
  size: string | null;
  /** ISO instants; null where the run did not reach the mark, or the
   *  record does not say. */
  at: Record<FunnelMark, string | null>;
  /** The earliest model output of any step this run executed — with
   *  parallel steps, possibly not the funnel step's. */
  earliestOutput: string | null;
  /** The funnel step's index; its start-up marks, in seconds from `startupAt`
   *  (STARTUP_PHASES); and whether that origin is the executor's own
   *  (`exact`) or the attempt's start (`estimated`). */
  funnelStep: number | null;
  startup: Record<string, number> | null;
  startupAt: string | null;
  origin: "exact" | "estimated" | null;
  /** Steps in the record (rescues and sub-agents included), how many ran in
   *  a sandbox, and attempts across the steps this run executed. */
  steps: number;
  sandboxedSteps: number;
  attempts: number;
  /** Summed over every attempt of every step this run executed. */
  costUsd: number;
  computeSecs: number;
  /** The funnel step's sandbox start-up (step.startupSecs). */
  startupSecs: number | null;
  /** The largest any one step's sandbox held, and the most any one used —
   *  not the run's capacity (parallel steps add up), and the limit and the
   *  use may be two different steps'. Each step's last attempt. Disk used
   *  is not measured in the sandbox today: null, never estimated. CPU busy
   *  and throttled seconds are summed. */
  cpuLimit: number | null;
  cpuBusySecs: number | null;
  cpuThrottledSecs: number | null;
  memLimitGiB: number | null;
  memPeakBytes: number | null;
  diskLimitGiB: number | null;
  diskUsedBytes: number | null;
}

/** What the queue knows that the record does not (the platform's row). */
export interface QueueFacts {
  queuedAt?: string | null;
  eligibleAt?: string | null;
  claimedAt?: string | null;
}

const iso = (ms: number | null): string | null => (ms === null || !Number.isFinite(ms) ? null : new Date(ms).toISOString());
const msOf = (s: string | null | undefined): number | null => {
  if (!s) return null;
  const v = Date.parse(s);
  return Number.isFinite(v) ? v : null;
};
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** A step this run executed itself: not carried from an earlier run, not a
 *  rescue or a sub-agent spliced in. */
const ownStep = (s: StepRecord) => !s.carriedFrom && !isSplicedRecord(s);
const hasMarks = (s: StepRecord) => !!s.startup && typeof s.startup === "object" && Object.keys(s.startup).length > 0;

/** When the step's marks count from, and whether that is the executor's
 *  own origin or the attempt's start. */
function originOf(step: StepRecord): { ms: number; exact: boolean } | null {
  const exact = msOf(step.startupAt);
  if (exact !== null) return { ms: exact, exact: true };
  const est = msOf(step.tries?.at(-1)?.startedAt) ?? msOf(step.startedAt);
  return est === null ? null : { ms: est, exact: false };
}

/** The step's own model: its first call's, else what the step asked for. */
function modelOf(step: StepRecord): string | null {
  const call = step.calls?.find((c) => typeof c.model === "string" && c.model);
  return call?.model ?? (typeof step.model === "string" && step.model ? step.model : null);
}

/** The step that failed the run, by the runner's rule (otel.ts uses the
 *  same): failed, not optional, not carried, not spliced; else any failed. */
const failingStep = (run: RunRecord) =>
  run.steps.find((s) => s.status === "failed" && !s.optional && ownStep(s)) ?? run.steps.find((s) => s.status === "failed");

/**
 * Why a failed run failed, for the wide event. runFailure (store.ts, the
 * customer's view) reads the first failed step, an optional one included,
 * and a stop only when no step failed; the funnel wants the run's own
 * terminal cause: a stop first, then the step that failed the run.
 */
export function terminalFailure(run: RunRecord): (FailureExplained & { text: string; step: StepRecord | null }) | null {
  if (run.status !== "failed") return null;
  if (run.stopRequested) {
    const text = `stopped by ${run.stoppedBy ?? "a person"}`;
    return { ...explainFailure(text, null), text, step: null };
  }
  const step = failingStep(run);
  if (step) {
    const text = step.events.filter((e) => e.type === "error").at(-1)?.text ?? "failed without an error event";
    return { ...explainFailure(text, step), text, step };
  }
  const f = runFailure(run);
  return f ? { ...f, text: f.reason, step: null } : null;
}

/** The scopes of a limit the customer sets or buys: their step's own
 *  (timeout:, size:, resources:), their flow's or workspace's pool, their
 *  plan's. The install's and the largest node's are ours. */
const CUSTOMER_SCOPES: readonly LimitScope[] = ["step", "run", "workspace", "account"];

/**
 * Does this run count against the platform's success rate, and why?
 *
 * Excluded — the customer's own code, settings or decision:
 *   cancelled            a person or a caller stopped it
 *   customer_code        their script, tool or hook failed
 *   customer_check       their verify:, output: json or schema: did not hold
 *   customer_budget      their budget: ran out
 *   customer_security    a platform security control stopped what their agent did
 *   customer_network     the error IS the proxy refusing a site off their
 *                        network: list (a refusal merely on the trail of a
 *                        step that failed for another reason does not count)
 *   customer_credential  their own model key was refused (supply `own`)
 *   customer_limit       a limit whose scope is theirs (CUSTOMER_SCOPES)
 * Bad — everything else: platform (ours, or a node short of memory or disk
 * evicting it), model (a provider failing, the platform's key refused),
 * capacity (the install's or the node's limit), deadline (a time limit with
 * no scope of theirs), unexplained.
 */
export function sloOutcome(run: RunRecord, failure = terminalFailure(run)): { slo: SloOutcome; reason: SloReason } | null {
  if (run.status === "completed") return { slo: "good", reason: "completed" };
  if (run.status !== "failed") return null;
  const excluded = (reason: SloReason) => ({ slo: "excluded" as const, reason });
  const bad = (reason: SloReason) => ({ slo: "bad" as const, reason });
  if (!failure) return bad("unexplained");
  switch (failure.kind) {
    case "stopped":
      return excluded("cancelled");
    case "code":
      return excluded("customer_code");
    case "check":
      return excluded("customer_check");
    case "budget":
      return excluded("customer_budget");
    case "security":
      return excluded("customer_security");
    case "network": {
      // explainFailure reads a refusal on the step's trail before a code
      // error, for the customer's message. Here the cause has to be the
      // refusal itself: the same step without its trail's refusals, and
      // what that says is the cause.
      const step = failure.step;
      const bare = explainFailure(failure.text, step ? { ...step, events: step.events.filter((e) => e.type === "error"), failureFacts: step.failureFacts ? { ...step.failureFacts, refusedHosts: undefined, secretHosts: undefined } : undefined } : null);
      if (bare.kind === "network") return excluded("customer_network");
      return sloOutcome(run, { ...bare, text: failure.text, step });
    }
    case "credential":
      return failure.step?.supply === "own" ? excluded("customer_credential") : bad("model");
    case "memory":
    case "cpu":
    case "disk":
    case "timeout":
      if (failure.scope && CUSTOMER_SCOPES.includes(failure.scope)) return excluded("customer_limit");
      if (failure.scope) return bad("capacity");
      return failure.kind === "timeout" ? bad("deadline") : bad("platform");
    case "model":
      return bad("model");
    case "platform":
      return bad("platform");
    default:
      return bad("unexplained");
  }
}

/** The run's wide event. Pure: the record, and what the queue adds. */
export function runWideEvent(tenant: string, workspace: string, run: RunRecord, queue: QueueFacts = {}): RunWideEvent {
  // The funnel step: of the steps this run executed in a sandbox, the one
  // whose start-up began first (parallel steps start in any order).
  let fi: number | null = null;
  let fo: { ms: number; exact: boolean } | null = null;
  let earliestOutput: number | null = null;
  let sandboxed = 0;
  run.steps.forEach((s, i) => {
    if (!ownStep(s) || !hasMarks(s)) return;
    sandboxed += 1;
    const o = originOf(s);
    if (!o) return;
    if (!fo || o.ms < fo.ms) {
      fi = i;
      fo = o;
    }
    const m = num(s.startup?.model);
    if (m !== null && (earliestOutput === null || o.ms + m * 1000 < earliestOutput)) earliestOutput = o.ms + m * 1000;
  });
  const fs = fi === null ? null : run.steps[fi]!;
  const origin = fo as { ms: number; exact: boolean } | null;
  const mark = (p: StartupPhase): number | null => {
    const v = num(fs?.startup?.[p]);
    return v === null || !origin ? null : origin.ms + v * 1000;
  };

  const submitted = msOf(run.startedAt);
  const queued = msOf(queue.queuedAt) ?? submitted;
  const eligible = msOf(queue.eligibleAt) ?? queued;
  const finished = run.status === "completed" || run.status === "failed" ? msOf(run.finishedAt) : null;
  const failure = terminalFailure(run);
  const slo = sloOutcome(run, failure);

  let attempts = 0;
  let cost = 0;
  let compute = 0;
  let cpuLimit: number | null = null;
  let memLimit: number | null = null;
  let diskLimit: number | null = null;
  let peak: number | null = null;
  let busy: number | null = null;
  let throttled: number | null = null;
  const max = (a: number | null, b: unknown) => (num(b) === null ? a : a === null ? (b as number) : Math.max(a, b as number));
  const add = (a: number | null, b: unknown) => (num(b) === null ? a : (a ?? 0) + (b as number));
  for (const s of run.steps) {
    // A step carried from an earlier run ran (and was billed) there.
    if (s.carriedFrom) continue;
    attempts += typeof s.attempts === "number" ? s.attempts : (s.tries?.length ?? 0);
    cost += num(s.costUsd) ?? 0;
    compute += num(s.computeSecs) ?? 0;
    cpuLimit = max(cpuLimit, s.reserved?.cpus);
    memLimit = max(memLimit, s.reserved?.memGiB);
    diskLimit = max(diskLimit, s.reserved?.diskGiB);
    peak = max(peak, s.actual?.peakMemBytes);
    busy = add(busy, s.actual?.busyCpuSecs);
    throttled = add(throttled, s.actual?.throttledSecs);
  }

  const adhoc = run.flow.startsWith("adhoc:");
  return {
    runId: run.id,
    tenant,
    workspace,
    flow: adhoc ? run.flow.slice("adhoc:".length) : run.flow,
    kind: adhoc ? "agent" : "flow",
    test: run.test === true,
    status: run.status,
    errorClass: run.status === "failed" ? (failure?.class ?? "platform_error") : null,
    failureKind: failure?.kind ?? null,
    failureScope: failure?.scope ?? null,
    slo: slo?.slo ?? null,
    sloReason: slo?.reason ?? null,
    rulesVersion: SLO_RULES_VERSION,
    image: fs?.image?.variant ?? null,
    model: fs ? modelOf(fs) : null,
    size: fs?.size ?? null,
    at: {
      submitted: iso(submitted),
      queued: iso(queued),
      eligible: iso(eligible),
      claimed: iso(msOf(queue.claimedAt)),
      scheduled: iso(msOf(run.drivenAt)),
      podReady: iso(mark("ready")),
      sandboxUp: iso(mark("tools")),
      firstOutput: iso(mark("model")),
      finished: iso(finished),
    },
    earliestOutput: iso(earliestOutput),
    funnelStep: fi,
    startup: fs?.startup ? { ...fs.startup } : null,
    startupAt: origin ? iso(origin.ms) : null,
    origin: origin ? (origin.exact ? "exact" : "estimated") : null,
    steps: run.steps.length,
    sandboxedSteps: sandboxed,
    attempts,
    costUsd: Math.round(cost * 1e6) / 1e6,
    computeSecs: Math.round(compute * 1000) / 1000,
    startupSecs: num(fs?.startupSecs),
    cpuLimit,
    cpuBusySecs: busy,
    cpuThrottledSecs: throttled,
    memLimitGiB: memLimit,
    memPeakBytes: peak,
    diskLimitGiB: diskLimit,
    diskUsedBytes: null,
  };
}

/** Seconds between two marks of an event, or null when either is missing
 *  (or the later reads earlier: two clocks). */
export function funnelSecs(ev: Pick<RunWideEvent, "at">, from: FunnelMark, to: FunnelMark): number | null {
  const a = msOf(ev.at[from]);
  const b = msOf(ev.at[to]);
  if (a === null || b === null || b < a) return null;
  return (b - a) / 1000;
}

// ------------------------------------------------------------- ops trace
//
// The run's funnel as an OpenTelemetry trace for OUR operations stack — not
// the account's `telemetry:` export (otel.ts), which goes to the account's
// own collector under ids of its own. Three services, one trace:
//
//   foldrun-web     run                   submitted → finished (the root)
//                   ├ submit              submitted → queued
//                   └ queue.wait          eligible → scheduled
//   foldrun-worker  drive                 scheduled → finished
//                   └ pod.start           the funnel step's start → pod ready
//   foldrun-runner  sandbox.start         pod ready → sandbox up
//                   │ └ startup.<phase>   each phase after the pod was ready
//                   └ first_output        sandbox up (else pod ready) → first output
//
// RECONSTRUCTED, every span: built once, by the worker, when the run ends,
// from the run record and the platform's row. The run pod cannot reach a
// collector (its namespace's egress is locked), and no tier carries a W3C
// context to the next: what joins them is the trace id, which any tier can
// derive from (account, workspace, run).
//
// Every attribute is one of OPS_SPAN_FIELDS and goes through ops-log's
// opsLine: each value in its field's shape, anything else dropped — the
// rule a log line leaving the cluster keeps (FOL-121). Span names are
// fixed. No status message, no events, no links: a failure is its class
// (`error.type`, one of ERROR_CLASSES).

/** The ops-log fields an ops span may carry — the collector's allowlist
 *  (foldrun-infra alloy-config.yaml) is held to this list by its test. */
export const OPS_SPAN_FIELDS = [
  "runId", "tenant", "workspace", "flow", "agent", "kind", "outcome", "errorClass", "verdict",
  "reason", "image", "size", "model", "usd", "step", "attempt", "phase", "ms",
] as const;

/** Every name an ops span may have. */
export const OPS_SPAN_NAMES = [
  "run", "submit", "queue.wait", "drive", "pod.start", "sandbox.start", "first_output",
  ...(["services", "room", "applied", "ready", "files", "go", "shim", "system", "driver", "imports", "tools"] as const).map((p) => `startup.${p}` as const),
] as const;

export const OPS_SERVICES = ["foldrun-web", "foldrun-worker", "foldrun-runner"] as const;

type Attr = { key: string; value: { stringValue: string } | { intValue: string } | { doubleValue: number } | { boolValue: boolean } };

/** An ops span's fields as OTLP attributes, `foldrun.<field>`: only
 *  OPS_SPAN_FIELDS, only values opsLine lets through. */
export function opsAttributes(fields: OpsFields): Attr[] {
  const allowed = new Set<string>(OPS_SPAN_FIELDS);
  const line = opsLine("info", "span", Object.fromEntries(Object.entries(fields).filter(([k]) => allowed.has(k))));
  const out: Attr[] = [];
  for (const [k, v] of Object.entries(line)) {
    if (!allowed.has(k)) continue; // ops, level, event, dropped
    const key = `foldrun.${k}`;
    if (typeof v === "boolean") out.push({ key, value: { boolValue: v } });
    else if (typeof v === "number") out.push({ key, value: Number.isInteger(v) ? { intValue: String(v) } : { doubleValue: v } });
    else if (typeof v === "string") out.push({ key, value: { stringValue: v } });
  }
  return out;
}

const hex = (s: string, len: number) => crypto.createHash("sha256").update(s).digest("hex").slice(0, len);
const nanos = (ms: number) => (BigInt(Math.round(ms)) * BigInt(1_000_000)).toString();

type OpsSpanName = (typeof OPS_SPAN_NAMES)[number];
interface OpsSpan {
  service: (typeof OPS_SERVICES)[number];
  name: OpsSpanName;
  id: string;
  parent: string | null;
  start: number;
  end: number;
  fields: OpsFields;
  error?: boolean;
}

/** The trace id of a run's ops trace — under a key of its own, never the
 *  account's trace id (otel.ts). */
export function opsTraceId(tenant: string, workspace: string, runId: string): string {
  return hex(`foldrun-ops-trace\0${tenant}\0${workspace}\0${runId}`, 32);
}

/**
 * The run's ops trace as an OTLP/HTTP JSON body, or null when the run has
 * no start and end to draw between.
 */
export function opsTrace(ev: RunWideEvent) {
  const at = (m: FunnelMark) => msOf(ev.at[m]);
  const submitted = at("submitted");
  const finished = at("finished");
  if (submitted === null || finished === null || finished < submitted) return null;
  const traceId = opsTraceId(ev.tenant, ev.workspace, ev.runId);
  const sid = (name: string) => hex(`${traceId}\0${name}`, 16);
  const failed = ev.status === "failed";
  const spans: OpsSpan[] = [];
  /** A span, kept inside its parent's interval; none where it would be
   *  empty or backwards. */
  const push = (s: Omit<OpsSpan, "id">, within?: { start: number; end: number }) => {
    const start = within ? Math.max(s.start, within.start) : s.start;
    const end = within ? Math.min(s.end, within.end) : s.end;
    if (!(end >= start)) return null;
    const span = { ...s, start, end, id: sid(s.name) };
    spans.push(span);
    return span;
  };
  const who: OpsFields = { runId: ev.runId };
  const root = push({
    service: "foldrun-web",
    name: "run",
    parent: null,
    start: submitted,
    end: finished,
    fields: {
      ...who,
      tenant: ev.tenant,
      workspace: ev.workspace,
      ...(ev.kind === "agent" ? { agent: ev.flow } : { flow: ev.flow }),
      kind: ev.kind,
      outcome: ev.status,
      errorClass: ev.errorClass,
      verdict: ev.slo,
      reason: ev.sloReason,
      image: ev.image,
      size: ev.size,
      model: ev.model,
      usd: ev.costUsd,
      step: ev.steps,
      attempt: ev.attempts,
    },
    error: failed,
  })!;
  const queued = at("queued");
  const eligible = at("eligible");
  const scheduled = at("scheduled");
  if (queued !== null) push({ service: "foldrun-web", name: "submit", parent: root.id, start: submitted, end: queued, fields: who }, root);
  if (eligible !== null && scheduled !== null) push({ service: "foldrun-web", name: "queue.wait", parent: root.id, start: eligible, end: scheduled, fields: who }, root);
  const drive = scheduled !== null
    ? push({ service: "foldrun-worker", name: "drive", parent: root.id, start: scheduled, end: finished, fields: { ...who, outcome: ev.status, errorClass: ev.errorClass }, error: failed }, root)
    : null;
  const host = drive ?? root;

  const origin = at("podReady") !== null ? msOf(ev.startupAt) : null;
  const podReady = at("podReady");
  const sandboxUp = at("sandboxUp");
  const firstOutput = at("firstOutput");
  const step = ev.funnelStep ?? undefined;
  if (origin !== null && podReady !== null) {
    push({ service: "foldrun-worker", name: "pod.start", parent: host.id, start: origin, end: podReady, fields: { ...who, step, size: ev.size, image: ev.image } }, host);
    if (sandboxUp !== null) {
      const sandbox = push({ service: "foldrun-runner", name: "sandbox.start", parent: host.id, start: podReady, end: sandboxUp, fields: { ...who, step, image: ev.image } }, host);
      // The phases after the pod was ready, as the run page draws them
      // (overlap-aware), each inside sandbox.start.
      if (sandbox) {
        for (const span of startupBreakdown(ev.startup)) {
          const end = origin + span.at * 1000;
          if (span.phase === "model" || end <= podReady || end > sandbox.end) continue;
          const name = `startup.${span.phase}` as OpsSpanName;
          if (!(OPS_SPAN_NAMES as readonly string[]).includes(name)) continue;
          push({ service: "foldrun-runner", name, parent: sandbox.id, start: origin + span.from * 1000, end, fields: { ...who, phase: span.phase, ms: Math.round(span.took * 1000) } }, sandbox);
        }
      }
    }
    if (firstOutput !== null) {
      push({ service: "foldrun-runner", name: "first_output", parent: host.id, start: sandboxUp ?? podReady, end: firstOutput, fields: { ...who, step, model: ev.model } }, host);
    }
  }

  const errorType = failed && ev.errorClass && (ERROR_CLASSES as readonly string[]).includes(ev.errorClass) ? ev.errorClass : null;
  return {
    resourceSpans: OPS_SERVICES.map((service) => ({
      resource: { attributes: [{ key: "service.name", value: { stringValue: service } }, { key: "service.namespace", value: { stringValue: "foldrun" } }] },
      scopeSpans: [
        {
          scope: { name: "foldrun-ops" },
          spans: spans
            .filter((s) => s.service === service)
            .map((s) => ({
              traceId,
              spanId: s.id,
              ...(s.parent ? { parentSpanId: s.parent } : {}),
              name: s.name,
              kind: 1,
              startTimeUnixNano: nanos(s.start),
              endTimeUnixNano: nanos(s.end),
              attributes: [...opsAttributes(s.fields), ...(s.error && errorType ? [{ key: "error.type", value: { stringValue: errorType } }] : [])],
              status: { code: s.error ? 2 : 0 },
            })),
        },
      ],
    })).filter((r) => r.scopeSpans[0]!.spans.length > 0),
  };
}
