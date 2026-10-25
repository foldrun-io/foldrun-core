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

import crypto from "node:crypto";
import type { RunRecord } from "./store.ts";
import { buildTraceTree, type TraceSpan } from "./trace-tree.ts";

export { parseTelemetry, telemetrySecretNames, telemetryHeaders, type TelemetryConfig } from "./otel-config.ts";

type AttrValue = { stringValue: string } | { intValue: string } | { doubleValue: number } | { boolValue: boolean };
type Attr = { key: string; value: AttrValue };

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
  const visit = (s: TraceSpan, parent: string | null, inherited: { start: number; agent?: string }) => {
    const spanId = hex(`${traceId}\0${s.id}`, 16);
    const start = s.start ?? inherited.start;
    const end = Math.max(start, s.end ?? s.start ?? now);
    const step = s.step !== undefined ? run.steps[s.step] : undefined;
    const agent = s.kind === "step" ? step?.agent : inherited.agent;
    spans.push({
      traceId,
      spanId,
      ...(parent ? { parentSpanId: parent } : {}),
      name: s.kind === "run" ? `run ${s.label}` : s.kind === "step" ? `step ${s.label}` : s.kind === "model" ? `chat ${s.model ?? s.label}` : s.kind === "tool" ? `tool ${s.label}` : s.label,
      kind: s.kind === "model" ? SPAN_KIND.client : SPAN_KIND.internal,
      startTimeUnixNano: nanos(start),
      endTimeUnixNano: nanos(end),
      attributes: [
        ...attr("foldrun.span.kind", s.kind),
        ...attr("foldrun.status", s.status),
        ...(s.kind === "step" ? [...attr("foldrun.agent", agent), ...attr("foldrun.owner", agent ? ctx.owners?.[agent] ?? null : null), ...attr("foldrun.step", s.step)] : []),
        ...attr("gen_ai.request.model", s.model),
        ...(s.tokens ? [...attr("gen_ai.usage.input_tokens", s.tokens.input), ...attr("gen_ai.usage.output_tokens", s.tokens.output), ...attr("gen_ai.usage.cache_read_tokens", s.tokens.cacheRead), ...attr("gen_ai.usage.cache_write_tokens", s.tokens.cacheWrite)] : []),
        ...attr("gen_ai.response.finish_reason", s.stop),
        ...(typeof s.costUsd === "number" ? attr("foldrun.cost_usd", s.costUsd) : []),
        ...(s.kind === "tool" ? [...attr("gen_ai.tool.name", s.label), ...attr("gen_ai.tool.call.id", s.call)] : []),
        ...attr("foldrun.subagent", s.subagent),
      ],
      status: s.status === "error" ? { code: 2, ...(s.text ? { message: s.text.slice(0, 500) } : {}) } : { code: 0 },
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
