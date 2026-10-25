// A run as an OTLP trace: one trace per run, the tree as parent links, ids
// stable across sends, secrets by name, and a config that refuses a token
// written into the file.
//
//   node --test tests/otel.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseTelemetry, runToOtlp, telemetryHeaders, telemetrySecretNames } from "../src/otel.ts";
import type { RunRecord, StepRecord } from "../src/store.ts";

const T = (s: number) => new Date(Date.parse("2026-10-21T00:00:00.000Z") + s * 1000).toISOString();
const tokens = { input: 100, output: 10, cacheRead: 50, cacheWrite: 0 };
const run = {
  id: "run-1", flow: "daily", status: "failed", startedAt: T(0), finishedAt: T(20), startedBy: "ana@acme.io",
  steps: [{
    agent: "writer", instruction: "", group: 1, optional: false, status: "failed", result: null, costUsd: 0.02, startedAt: T(1), finishedAt: T(10),
    calls: [{ id: "m1", n: 1, at: T(3), ms: 1000, model: "claude-sonnet", stop: "tool_use", tokens, tools: 1 }],
    events: [
      { t: T(3), type: "tool", text: "crm", call: "a", inCall: "m1" },
      { t: T(5), type: "tool", text: "crm", call: "a", ms: 2000, err: true },
    ],
  } as unknown as StepRecord],
} as unknown as RunRecord;

test("one trace: run → step → model → tool, parents linked, the failure on its span", () => {
  const body = runToOtlp(run, { tenant: "acme", workspace: "desk", owners: { writer: "ana@acme.io" } }, Date.parse(T(30)));
  const spans = body.resourceSpans[0]!.scopeSpans[0]!.spans as { traceId: string; spanId: string; parentSpanId?: string; name: string; kind: number; status: { code: number }; attributes: { key: string; value: Record<string, unknown> }[]; startTimeUnixNano: string }[];
  assert.equal(new Set(spans.map((s) => s.traceId)).size, 1);
  const [r, st, m, tool] = spans;
  assert.equal(r!.name, "run daily");
  assert.equal(r!.parentSpanId, undefined);
  assert.equal(st!.parentSpanId, r!.spanId);
  assert.equal(m!.parentSpanId, st!.spanId);
  assert.equal(tool!.parentSpanId, m!.spanId);
  assert.equal(m!.name, "chat claude-sonnet");
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
