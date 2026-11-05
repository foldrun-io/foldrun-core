// A run as an OpenTelemetry trace — OTLP/HTTP JSON, the body a collector's
// /v1/traces takes — so an account's agent runs sit in the tracing it
// already has (Grafana Tempo, Honeycomb, Datadog, Jaeger, Langfuse…) beside
// the services they act on. Built from buildTraceTree, the same tree the run
// page draws: run → step → model call → tool call.
//
//   telemetry:
//     otlp: https://otel.example.com/v1/traces
//     headers:
//       authorization: ${OTEL_TOKEN}     # a vault secret, by name
//
// In AGENTS.md (the workspace's, else the account's — the block replaces
// whole, like notify:). Ids are derived from the run and span ids, so a run
// sent twice is the same trace, not two. No OpenTelemetry SDK: the wire
// format is small, and a dependency in every runner image is not.
//
// Names follow the OpenTelemetry GenAI semantic conventions — since 2026 in
// their own repository, github.com/open-telemetry/semantic-conventions-genai
// (docs/gen-ai/gen-ai-agent-spans.md, gen-ai-spans.md, client-inference.md;
// read at 58daeb9, 5 Nov 2026, status Development):
//
//   run        invoke_workflow {flow}   INTERNAL  gen_ai.workflow.name
//   step       invoke_agent {agent}     INTERNAL  gen_ai.agent.name
//   model call chat {model}             CLIENT    gen_ai.provider.name, usage
//   tool call  execute_tool {tool}      INTERNAL  gen_ai.tool.name, call.id
//
// each with gen_ai.operation.name, and error.type on a failed span. A direct
// agent run (flow "adhoc:<agent>") is not a workflow — the spec says not to
// report one for a standalone agent — so its root stays `run adhoc:<agent>`
// with no operation, and the step under it is the invoke_agent.
//
// Content stays out: no gen_ai.input/output.messages, no tool call
// arguments or results — the spec makes every one of them Opt-In, and a
// trace is built from the run record alone, which holds none of them (a
// captured call's content is under runs/<run>/calls/, never read here).
// What a span says of a failure is its class (error.type) and the step's
// own error line as the status message, capped.

import crypto from "node:crypto";
import { isSplicedRecord, type RunRecord, type StepRecord } from "./store.ts";
import { buildTraceTree, type TraceSpan } from "./trace-tree.ts";
import { errorClass, type ErrorClass } from "./ops-log.ts";
import { platformCause } from "./issues.ts";

export { parseTelemetry, telemetrySecretNames, telemetryHeaders, type TelemetryConfig } from "./otel-config.ts";

type AttrValue = { stringValue: string } | { intValue: string } | { doubleValue: number } | { boolValue: boolean } | { arrayValue: { values: { stringValue: string }[] } };
type Attr = { key: string; value: AttrValue };

const strings = (key: string, v: readonly string[]): Attr[] => (v.length ? [{ key, value: { arrayValue: { values: v.map((x) => ({ stringValue: x })) } } }] : []);

const attr = (key: string, v: string | number | boolean | null | undefined): Attr[] => {
  if (v === null || v === undefined || v === "") return [];
  if (typeof v === "boolean") return [{ key, value: { boolValue: v } }];
  if (typeof v === "number") return [{ key, value: Number.isInteger(v) ? { intValue: String(v) } : { doubleValue: v } }];
  return [{ key, value: { stringValue: v } }];
};

const hex = (s: string, len: number) => crypto.createHash("sha256").update(s).digest("hex").slice(0, len);
const nanos = (msEpoch: number) => (BigInt(Math.round(msEpoch)) * BigInt(1_000_000)).toString();

/** OTLP span kinds: INTERNAL, and CLIENT for a call that leaves the platform. */
const SPAN_KIND = { internal: 1, client: 3 } as const;

/** What `error.type` may say: one of the platform's error classes
 *  (ops-log.ts, FOL-121), or the spec's `_OTHER` when the words of the
 *  failure match none. The spec asks an instrumentation to document the
 *  list it reports; this is it. */
export const SPAN_ERROR_TYPES = ["timeout", "cancelled", "model_error", "oom", "disk_full", "network_error", "not_found", "policy_denied", "platform_error", "_OTHER"] as const;
export type SpanErrorType = (typeof SPAN_ERROR_TYPES)[number];

/** A failure's class from its words, the way an operator counts them.
 *  Only the class leaves: the words stay where they were. */
export function spanErrorType(text: string | null | undefined, stopped = false): SpanErrorType {
  if (stopped) return "cancelled";
  if (!text) return "_OTHER";
  // What stopRun writes on the step it interrupted, and on the run.
  if (/\b(stopped by a person|cancelled by .+) — sandbox destroyed|^run (stopped|cancelled)\b/.test(text)) return "cancelled";
  const cause = platformCause(text)?.key;
  if (cause === "model-auth" || cause === "model-cap" || cause === "model-busy") return "model_error";
  if (cause === "sandbox" || cause === "worker") return "platform_error";
  if (/\btimed out\b/i.test(text)) return "timeout";
  const cls: ErrorClass = errorClass({ message: text });
  return cls !== "platform_error" && (SPAN_ERROR_TYPES as readonly string[]).includes(cls) ? (cls as SpanErrorType) : "_OTHER";
}

/** The step that failed the run, by the runner's own rule (runner.ts: a
 *  failed step that is not optional, carried from an earlier run or a
 *  spliced record); else any failed one. */
const failingStep = (run: RunRecord) =>
  run.steps.find((s) => s.status === "failed" && !s.optional && !s.carriedFrom && !isSplicedRecord(s)) ?? run.steps.find((s) => s.status === "failed");

const lastError = (s: StepRecord | undefined) => {
  const errors = (s?.events ?? []).filter((e) => e.type === "error");
  return errors[errors.length - 1]?.text ?? null;
};

/** gen_ai.provider.name — the spec's well-known value, only where the record
 *  says whose model it was: the platform's own Claude credential, or one of
 *  foldrun's models. An account's own provider: block could be anyone's, so
 *  it says nothing rather than guess. */
const PROVIDER: Record<string, string> = { anthropic: "anthropic", openai: "openai", gemini: "gcp.gemini", deepseek: "deepseek", moonshot: "moonshot_ai" };
function providerOf(step: StepRecord | undefined): string | null {
  if (!step) return null;
  // A refusal retried on the fallback supply (runner.ts) runs calls the
  // step's `supply` does not describe; the record does not say which call
  // went where, so none of them claims a provider.
  if (step.events.some((e) => e.type === "info" && /retrying this step on the fallback provider/.test(e.text))) return null;
  if (step.supply === "operator") return "anthropic";
  if (step.supply === "foldrun" && step.supplyProvider) return PROVIDER[step.supplyProvider] ?? step.supplyProvider;
  return null;
}

export interface TraceContext {
  tenant: string;
  workspace: string;
  /** Agent name → its owner (owner: …), stamped on its step spans. */
  owners?: Record<string, string | null>;
  /** The platform version, as the instrumentation scope's. */
  version?: string;
}

/** The ExportTraceServiceRequest for one run. */
export function runToOtlp(run: RunRecord, ctx: TraceContext, now = Date.now()) {
  const tree = buildTraceTree(run, now);
  const traceId = hex(`foldrun-trace\0${ctx.tenant}\0${ctx.workspace}\0${run.id}`, 32);
  const spans: unknown[] = [];
  const adhoc = run.flow.startsWith("adhoc:");
  const visit = (s: TraceSpan, parent: string | null, inherited: { start: number; agent?: string }) => {
    const spanId = hex(`${traceId}\0${s.id}`, 16);
    const start = s.start ?? inherited.start;
    const end = Math.max(start, s.end ?? s.start ?? now);
    const step = s.step !== undefined ? run.steps[s.step] : undefined;
    const agent = s.kind === "step" ? step?.agent : inherited.agent;
    const operation =
      s.kind === "run" ? (adhoc ? null : "invoke_workflow") : s.kind === "step" ? "invoke_agent" : s.kind === "model" ? "chat" : s.kind === "tool" ? "execute_tool" : null;
    const name =
      s.kind === "run" ? (adhoc ? `run ${s.label}` : `invoke_workflow ${s.label}`)
      : s.kind === "step" ? `invoke_agent ${s.label}`
      : s.kind === "model" ? `chat ${s.model ?? s.label}`
      : s.kind === "tool" ? `execute_tool ${s.label}`
      : s.label;
    // Why it failed, as a class: the run by its failing step, a step by its
    // last error line, an error leaf by its own words. A failed tool call's
    // record holds no words, only that it erred.
    const failed = s.status === "error";
    // A person (or a caller) stopping the run is why the run failed; a step
    // that failed before the stop failed for its own reason — the step the
    // stop interrupted is marked skipped, and its error line says cancelled.
    const stopped = run.stopRequested === true && s.kind === "run";
    const errorText = !failed ? null
      : s.kind === "run" ? lastError(failingStep(run))
      : s.kind === "step" ? lastError(step)
      : s.text ?? null;
    spans.push({
      traceId,
      spanId,
      ...(parent ? { parentSpanId: parent } : {}),
      name,
      kind: s.kind === "model" ? SPAN_KIND.client : SPAN_KIND.internal,
      startTimeUnixNano: nanos(start),
      endTimeUnixNano: nanos(end),
      attributes: [
        ...attr("gen_ai.operation.name", operation),
        ...attr("foldrun.span.kind", s.kind),
        ...attr("foldrun.status", s.status),
        ...(s.kind === "run" && !adhoc ? attr("gen_ai.workflow.name", s.label) : []),
        ...(s.kind === "step" ? [...attr("gen_ai.agent.name", agent), ...attr("foldrun.agent", agent), ...attr("foldrun.owner", agent ? ctx.owners?.[agent] ?? null : null), ...attr("foldrun.step", s.step)] : []),
        ...(s.kind === "model" ? attr("gen_ai.provider.name", providerOf(step)) : []),
        ...attr("gen_ai.request.model", s.model),
        ...(s.tokens
          ? [
              ...attr("gen_ai.usage.input_tokens", s.tokens.input),
              ...attr("gen_ai.usage.output_tokens", s.tokens.output),
              // The spec's names: "when available and non-zero".
              ...(s.tokens.cacheRead ? attr("gen_ai.usage.cache_read.input_tokens", s.tokens.cacheRead) : []),
              ...(s.tokens.cacheWrite ? attr("gen_ai.usage.cache_write.input_tokens", s.tokens.cacheWrite) : []),
              // Deprecated (5 Nov 2026): the names this export sent before the
              // spec named them. Kept for one release; read the ones above.
              ...attr("gen_ai.usage.cache_read_tokens", s.tokens.cacheRead),
              ...attr("gen_ai.usage.cache_write_tokens", s.tokens.cacheWrite),
            ]
          : []),
        ...(s.stop ? strings("gen_ai.response.finish_reasons", [s.stop]) : []),
        // Deprecated (5 Nov 2026): the singular this export sent before; the
        // spec's is the array above. Kept for one release.
        ...attr("gen_ai.response.finish_reason", s.stop),
        ...(typeof s.costUsd === "number" ? attr("foldrun.cost_usd", s.costUsd) : []),
        ...(s.kind === "tool" ? [...attr("gen_ai.tool.name", s.label), ...attr("gen_ai.tool.call.id", s.call), ...attr("gen_ai.agent.name", s.subagent ?? agent)] : []),
        ...attr("foldrun.subagent", s.subagent),
        ...(failed ? attr("error.type", spanErrorType(errorText, stopped)) : []),
      ],
      status: failed ? { code: 2, ...(errorText ? { message: errorText.slice(0, 500) } : {}) } : { code: 0 },
    });
    for (const c of s.children) visit(c, spanId, { start, agent });
  };
  visit(tree, null, { start: Date.parse(run.startedAt) || now });
  return {
    resourceSpans: [
      {
        resource: {
          attributes: [
            ...attr("service.name", "foldrun"),
            ...attr("foldrun.account", ctx.tenant),
            ...attr("foldrun.workspace", ctx.workspace),
            ...attr("foldrun.flow", run.flow),
            ...attr("foldrun.run_id", run.id),
            ...attr("foldrun.started_by", run.startedBy ?? null),
          ],
        },
        scopeSpans: [{ scope: { name: "foldrun", ...(ctx.version ? { version: ctx.version } : {}) }, spans }],
      },
    ],
  };
}
