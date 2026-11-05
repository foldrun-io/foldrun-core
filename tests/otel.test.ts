// A run as an OTLP trace: one trace per run, the tree as parent links, ids
// stable across sends, secrets by name, and a config that refuses a token
// written into the file.
//
//   node --test tests/otel.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseTelemetry, runToOtlp, spanErrorType, telemetryHeaders, telemetrySecretNames, SPAN_ERROR_TYPES } from "../src/otel.ts";
import { ERROR_CLASSES } from "../src/ops-log.ts";
import type { RunRecord, StepRecord } from "../src/store.ts";

const T = (s: number) => new Date(Date.parse("2026-10-21T00:00:00.000Z") + s * 1000).toISOString();
const tokens = { input: 100, output: 10, cacheRead: 50, cacheWrite: 0 };
const run = {
  id: "run-1", flow: "daily", status: "failed", startedAt: T(0), finishedAt: T(20), startedBy: "ana@acme.io",
  steps: [{
    agent: "writer", instruction: "", group: 1, optional: false, status: "failed", result: null, costUsd: 0.02, startedAt: T(1), finishedAt: T(10), supply: "operator",
    calls: [{ id: "m1", n: 1, at: T(3), ms: 1000, model: "claude-sonnet", stop: "tool_use", tokens, tools: 1 }],
    events: [
      { t: T(3), type: "tool", text: "crm", call: "a", inCall: "m1" },
      { t: T(5), type: "tool", text: "crm", call: "a", ms: 2000, err: true },
      { t: T(9), type: "error", text: "timed out after 900s (timeout: in the flow file) — the step was stopped with the files it wrote so far kept" },
    ],
  } as unknown as StepRecord],
} as unknown as RunRecord;

test("one trace: run → step → model → tool, parents linked, the failure on its span", () => {
  const body = runToOtlp(run, { tenant: "acme", workspace: "desk", owners: { writer: "ana@acme.io" } }, Date.parse(T(30)));
  const spans = body.resourceSpans[0]!.scopeSpans[0]!.spans as { traceId: string; spanId: string; parentSpanId?: string; name: string; kind: number; status: { code: number }; attributes: { key: string; value: Record<string, unknown> }[]; startTimeUnixNano: string }[];
  assert.equal(new Set(spans.map((s) => s.traceId)).size, 1);
  const [r, st, m, tool] = spans;
  assert.equal(r!.name, "invoke_workflow daily");
  assert.equal(r!.parentSpanId, undefined);
  assert.equal(st!.parentSpanId, r!.spanId);
  assert.equal(m!.parentSpanId, st!.spanId);
  assert.equal(tool!.parentSpanId, m!.spanId);
  assert.equal(m!.name, "chat claude-sonnet");
  assert.equal(st!.name, "invoke_agent writer");
  assert.equal(tool!.name, "execute_tool crm");
  assert.equal(m!.kind, 3, "a model call leaves the platform: CLIENT");
  assert.equal(tool!.status.code, 2);
  const a = (s: (typeof spans)[number], k: string) => s.attributes.find((x) => x.key === k)?.value;
  assert.deepEqual(a(st!, "foldrun.owner"), { stringValue: "ana@acme.io" });
  assert.deepEqual(a(m!, "gen_ai.usage.input_tokens"), { intValue: "100" });
  assert.deepEqual(a(tool!, "gen_ai.tool.name"), { stringValue: "crm" });
  assert.equal(st!.startTimeUnixNano, (BigInt(Date.parse(T(1))) * 1_000_000n).toString());
  const res = body.resourceSpans[0]!.resource.attributes;
  assert.ok(res.some((x) => x.key === "service.name" && (x.value as { stringValue: string }).stringValue === "foldrun"));
  const again = runToOtlp(run, { tenant: "acme", workspace: "desk" }, Date.parse(T(30)));
  assert.equal(again.resourceSpans[0]!.scopeSpans[0]!.spans[0]!.traceId, r!.traceId, "the same run is the same trace");
});

test("telemetry: an https endpoint; headers by secret name; a token written in is refused", () => {
  const ok = parseTelemetry({ otlp: "https://otel.example.com/v1/traces", headers: { Authorization: "${OTEL_TOKEN}", "x-team": "agents" } });
  assert.deepEqual(ok.problems, []);
  assert.deepEqual(telemetrySecretNames(ok.config!), ["OTEL_TOKEN"]);
  assert.deepEqual(telemetryHeaders(ok.config!, (n) => (n === "OTEL_TOKEN" ? "Bearer abc" : null)).headers, { authorization: "Bearer abc", "x-team": "agents" });
  assert.deepEqual(telemetryHeaders(ok.config!, () => null).missing, ["OTEL_TOKEN"]);
  assert.match(parseTelemetry({ otlp: "http://otel.example.com" }).problems.join(), /an https:\/\/ URL/);
  assert.match(parseTelemetry({ otlp: "https://x.io/v1/traces", headers: { authorization: "Bearer abc" } }).problems.join(), /written into the file — put it in the vault/);
  assert.equal(parseTelemetry(undefined).config, null);
});

type Span = { name: string; kind: number; status: { code: number; message?: string }; attributes: { key: string; value: Record<string, unknown> }[] };
const spansOf = (r: RunRecord) => runToOtlp(r, { tenant: "acme", workspace: "desk" }, Date.parse(T(30))).resourceSpans[0]!.scopeSpans[0]!.spans as Span[];
const at = (s: Span, k: string) => s.attributes.find((x) => x.key === k)?.value;

test("GenAI semconv: an operation on each span, the workflow and agent named, finish reasons an array, the spec's cache names", () => {
  const [r, st, m, tool, err] = spansOf(run);
  assert.deepEqual(at(r!, "gen_ai.operation.name"), { stringValue: "invoke_workflow" });
  assert.deepEqual(at(r!, "gen_ai.workflow.name"), { stringValue: "daily" });
  assert.deepEqual(at(st!, "gen_ai.operation.name"), { stringValue: "invoke_agent" });
  assert.deepEqual(at(st!, "gen_ai.agent.name"), { stringValue: "writer" });
  assert.deepEqual(at(m!, "gen_ai.operation.name"), { stringValue: "chat" });
  assert.deepEqual(at(m!, "gen_ai.provider.name"), { stringValue: "anthropic" }, "the platform's Claude credential");
  assert.deepEqual(at(m!, "gen_ai.response.finish_reasons"), { arrayValue: { values: [{ stringValue: "tool_use" }] } });
  assert.deepEqual(at(m!, "gen_ai.response.finish_reason"), { stringValue: "tool_use" }, "the old singular, kept one release");
  assert.deepEqual(at(m!, "gen_ai.usage.cache_read.input_tokens"), { intValue: "50" });
  assert.equal(at(m!, "gen_ai.usage.cache_write.input_tokens"), undefined, "non-zero only, as the spec says");
  assert.deepEqual(at(m!, "gen_ai.usage.cache_read_tokens"), { intValue: "50" }, "the old name, kept one release");
  assert.deepEqual(at(tool!, "gen_ai.operation.name"), { stringValue: "execute_tool" });
  assert.deepEqual(at(tool!, "gen_ai.agent.name"), { stringValue: "writer" });
  assert.equal(tool!.kind, 1, "a tool runs inside the platform: INTERNAL");
  assert.equal(err!.name, "error");
  assert.equal(at(err!, "gen_ai.operation.name"), undefined, "an error line is not a GenAI operation");
});

test("error.type on every failed span, a class from the words; nothing on a span that did not fail", () => {
  const [r, st, m, tool, err] = spansOf(run);
  assert.deepEqual(at(r!, "error.type"), { stringValue: "timeout" }, "the run, by its failing step");
  assert.deepEqual(at(st!, "error.type"), { stringValue: "timeout" });
  assert.deepEqual(at(err!, "error.type"), { stringValue: "timeout" });
  assert.deepEqual(at(tool!, "error.type"), { stringValue: "_OTHER" }, "a failed tool's record holds no words");
  assert.equal(at(m!, "error.type"), undefined);
  assert.match(st!.status.message ?? "", /^timed out after 900s/);
  const stopped = spansOf({ ...run, stopRequested: true } as RunRecord);
  assert.deepEqual(at(stopped[0]!, "error.type"), { stringValue: "cancelled" }, "the run: stopped");
  assert.deepEqual(at(stopped[1]!, "error.type"), { stringValue: "timeout" }, "a step that failed on its own keeps its own class");
  assert.equal(spanErrorType("stopped by a person — sandbox destroyed"), "cancelled");
  assert.equal(spanErrorType("cancelled by A2A caller lead-bot — sandbox destroyed"), "cancelled");
  assert.equal(spanErrorType("the 7-day window is 100% used"), "model_error");
  assert.equal(spanErrorType("pod never became ready"), "platform_error");
  assert.equal(spanErrorType("Error: OOMKilled"), "oom");
  assert.equal(spanErrorType("verify: the draft has no title"), "_OTHER");
  assert.equal(spanErrorType(null), "_OTHER");
  for (const t of SPAN_ERROR_TYPES) assert.ok(t === "_OTHER" || (ERROR_CLASSES as readonly string[]).includes(t), `${t} is one of the platform's error classes`);
});

test("a direct agent run is not a workflow; foldrun's models name their provider; no content on any span", () => {
  const adhoc = { ...run, flow: "adhoc:writer", status: "completed", steps: [{ ...run.steps[0]!, status: "completed", supply: "foldrun", supplyProvider: "moonshot", events: run.steps[0]!.events.slice(0, 1) }] } as unknown as RunRecord;
  const [r, st, m] = spansOf(adhoc);
  assert.equal(r!.name, "run adhoc:writer");
  assert.equal(at(r!, "gen_ai.operation.name"), undefined);
  assert.equal(st!.name, "invoke_agent writer");
  assert.deepEqual(at(m!, "gen_ai.provider.name"), { stringValue: "moonshot_ai" });
  const own = { ...adhoc, steps: [{ ...adhoc.steps[0]!, supply: "own" }] } as unknown as RunRecord;
  assert.equal(at(spansOf(own)[2]!, "gen_ai.provider.name"), undefined, "an own provider: block could be anyone's");
  const keys = new Set(spansOf(run).flatMap((s) => s.attributes.map((a) => a.key)));
  for (const k of ["gen_ai.input.messages", "gen_ai.output.messages", "gen_ai.system_instructions", "gen_ai.tool.call.arguments", "gen_ai.tool.call.result"]) assert.ok(!keys.has(k), `${k} is opt-in content`);
  for (const s of spansOf(adhoc)) assert.equal(s.status.code, 0);
});

test("the run's error.type is the step that failed it: an optional step's failure first does not", () => {
  const optional = { ...run.steps[0]!, agent: "scout", optional: true, events: [{ t: T(2), type: "error", text: "Error: OOMKilled" }] } as unknown as StepRecord;
  const twoFailures = { ...run, steps: [optional, run.steps[0]!] } as RunRecord;
  const [root] = spansOf(twoFailures);
  assert.deepEqual(at(root!, "error.type"), { stringValue: "timeout" }, "the required step's, not the optional scout's oom");
  assert.match(root!.status.message ?? "", /^timed out/);
});
