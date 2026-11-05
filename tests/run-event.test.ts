// FOL-122: one run as one record — its funnel, what it held and used, how
// it ended and whether that counts against the platform's success rate —
// and the same run as an ops trace that carries nothing an account wrote.
//
//   node --test tests/run-event.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  runWideEvent, sloOutcome, terminalFailure, funnelSecs, opsTrace, opsTraceId, opsAttributes,
  OPS_SPAN_FIELDS, OPS_SPAN_NAMES, OPS_SERVICES, SLO_REASONS,
} from "../src/run-event.ts";
import { FIELDS, ERROR_CLASSES } from "../src/ops-log.ts";
import { runToOtlp } from "../src/otel.ts";
import { refusalText } from "../src/network.ts";
import type { RunRecord, StepRecord } from "../src/store.ts";

const T0 = Date.parse("2026-11-05T10:00:00.000Z");
const at = (secs: number) => new Date(T0 + secs * 1000).toISOString();
const ev = (type: "error" | "info", text: string, extra: Record<string, unknown> = {}) => ({ t: at(0), type, text, ...extra });

function step(p: Partial<StepRecord> = {}): StepRecord {
  return { agent: "writer", instruction: "SECRET-INSTRUCTION", group: 1, optional: false, status: "completed", events: [], result: "SECRET-REPLY", costUsd: 0.1, ...p } as StepRecord;
}
function run(steps: StepRecord[], p: Partial<RunRecord> = {}): RunRecord {
  return { id: "run-mh2k9x-ab12", flow: "daily", status: "completed", startedAt: at(0), finishedAt: at(60), drivenAt: at(4), steps, ...p } as RunRecord;
}
const sandboxed = (p: Partial<StepRecord> = {}) =>
  step({
    startedAt: at(5),
    startupAt: at(5),
    startup: { room: 0.1, applied: 0.4, ready: 3, files: 4, go: 4.2, shim: 4.3, driver: 5, imports: 5.5, tools: 6, model: 9 },
    startupSecs: 3,
    computeSecs: 40,
    size: "large",
    image: { variant: "slim" },
    reserved: { cpus: 2, memGiB: 4, diskGiB: 20 },
    actual: { busyCpuSecs: 12, peakMemBytes: 1.5 * 1024 ** 3, throttledSecs: 1, rxBytes: 10, txBytes: 10 },
    calls: [{ id: "m1", n: 1, at: at(14), ms: 5000, model: "claude-sonnet-4-5", tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } }] as StepRecord["calls"],
    attempts: 1,
    ...p,
  });

test("the funnel: each mark an instant, from the record and the queue's row", () => {
  const e = runWideEvent("acme", "desk", run([sandboxed()]), { queuedAt: at(0.05), eligibleAt: at(0.05), claimedAt: at(3) });
  assert.deepEqual(e.at, {
    submitted: at(0), queued: at(0.05), eligible: at(0.05), claimed: at(3), scheduled: at(4),
    podReady: at(8), sandboxUp: at(11), firstOutput: at(14), finished: at(60),
  });
  assert.equal(e.origin, "exact");
  assert.equal(e.funnelStep, 0);
  assert.equal(funnelSecs(e, "eligible", "scheduled"), 3.95);
  assert.equal(funnelSecs(e, "podReady", "firstOutput"), 6);
  assert.deepEqual([e.image, e.size, e.model, e.kind, e.flow, e.slo, e.sloReason], ["slim", "large", "claude-sonnet-4-5", "flow", "daily", "good", "completed"]);
  assert.deepEqual([e.cpuLimit, e.cpuBusySecs, e.memLimitGiB, e.diskLimitGiB, e.diskUsedBytes], [2, 12, 4, 20, null]);
  assert.equal(e.costUsd, 0.1);
});

test("a record from before startupAt: placed from the attempt's start, and said to be an estimate", () => {
  const s = sandboxed({ startupAt: undefined, tries: [{ n: 1, status: "failed", costUsd: 0, tokens: null, computeSecs: 1, startedAt: at(5), finishedAt: at(6) }, { n: 2, status: "completed", costUsd: 0, tokens: null, computeSecs: 1, startedAt: at(20), finishedAt: at(40) }] });
  const e = runWideEvent("acme", "desk", run([s]));
  assert.equal(e.origin, "estimated");
  assert.equal(e.at.podReady, at(23)); // the LAST attempt's start + ready
  assert.equal(e.at.queued, at(0)); // no queue row: submitted stands in
  assert.equal(e.at.claimed, null);
});

test("the funnel step is the sandbox that started first; carried and spliced steps are not this run's", () => {
  const carried = sandboxed({ startupAt: at(1), carriedFrom: "run-old" });
  const rescue = sandboxed({ startupAt: at(1.5), rescueOf: "writer" });
  const late = sandboxed({ startupAt: at(9), group: 1, agent: "b" });
  const early = sandboxed({ startupAt: at(6), group: 1, agent: "a", startup: { ready: 2, tools: 3, model: 30 } });
  const e = runWideEvent("acme", "desk", run([carried, rescue, late, early]));
  assert.equal(e.funnelStep, 3);
  assert.equal(e.at.firstOutput, at(36)); // the funnel step's own output
  assert.equal(e.earliestOutput, at(18)); // the parallel step answered sooner
  assert.equal(e.sandboxedSteps, 2);
  // In-process: no pod marks at all.
  const plain = runWideEvent("acme", "desk", run([step()]));
  assert.deepEqual([plain.at.podReady, plain.at.sandboxUp, plain.at.firstOutput, plain.funnelStep, plain.origin], [null, null, null, null, null]);
});

test("no sandbox_up guess: a step without a tools mark has none", () => {
  const e = runWideEvent("acme", "desk", run([sandboxed({ startup: { ready: 3, driver: 5, model: 9 } })]));
  assert.equal(e.at.sandboxUp, null);
  assert.equal(e.at.firstOutput, at(14));
});

test("SLO: the customer's own code, settings and decisions are excluded; ours, a provider's and the unknown are bad", () => {
  const failed = (text: string, p: Partial<StepRecord> = {}, rp: Partial<RunRecord> = {}) =>
    sloOutcome(run([step({ status: "failed", events: [ev("error", text)], ...p })], { status: "failed", ...rp }));
  assert.deepEqual(sloOutcome(run([step()])), { slo: "good", reason: "completed" });
  assert.equal(sloOutcome(run([step({ status: "running" })], { status: "running" })), null);
  assert.deepEqual(failed("anything", {}, { stopRequested: true }), { slo: "excluded", reason: "cancelled" });
  assert.deepEqual(failed("script fetch.py exited (code 1)"), { slo: "excluded", reason: "customer_code" });
  assert.deepEqual(failed("verify: exit 1", { events: [ev("error", "verify: exit 1", { check: true })] }), { slo: "excluded", reason: "customer_check" });
  assert.deepEqual(failed("over budget — the flow's budget: $1 is spent"), { slo: "excluded", reason: "customer_budget" });
  assert.deepEqual(failed("sandbox ended: OOMKilled (exit 137)", { reserved: { cpus: 1, memGiB: 2 } }), { slo: "excluded", reason: "customer_limit" });
  assert.deepEqual(failed("timed out after 900s (timeout: in the flow file)"), { slo: "excluded", reason: "customer_limit" });
  assert.deepEqual(failed("sandbox ended: this step holds 64 GiB, more than the largest node's 32 GiB"), { slo: "bad", reason: "capacity" });
  assert.deepEqual(failed("sandbox ended: DeadlineExceeded"), { slo: "bad", reason: "deadline" });
  assert.deepEqual(failed("sandbox ended: Evicted: The node was low on resource: memory."), { slo: "bad", reason: "platform" });
  assert.deepEqual(failed("pod never became ready in 300s"), { slo: "bad", reason: "platform" });
  assert.deepEqual(failed("Claude Code process exited with code 1"), { slo: "bad", reason: "model" });
  assert.deepEqual(failed("something nobody has seen"), { slo: "bad", reason: "unexplained" });
  // A model key refused: theirs is excluded, the platform's is ours.
  assert.deepEqual(failed("authentication_error: invalid x-api-key", { supply: "own" }), { slo: "excluded", reason: "customer_credential" });
  assert.deepEqual(failed("authentication_error: invalid x-api-key", { supply: "operator" }), { slo: "bad", reason: "model" });
  for (const r of ["completed", "cancelled", "customer_code", "customer_limit", "capacity", "deadline", "model", "platform", "unexplained"]) assert.ok(SLO_REASONS.includes(r as never), r);
});

test("SLO network: the refusal itself is theirs; a refusal merely on the trail of a code error is classified as the code error", () => {
  const refusal = `${refusalText({ level: "trusted" }, "evil.example")} Refused.`;
  const direct = sloOutcome(run([step({ status: "failed", events: [ev("error", refusal)] })], { status: "failed" }));
  assert.deepEqual(direct, { slo: "excluded", reason: "customer_network" });
  // The customer's view says network (both said); the SLO reads the cause.
  const s = step({ status: "failed", events: [ev("info", refusal), ev("error", "TypeError: x is undefined")] });
  const r = run([s], { status: "failed" });
  assert.equal(terminalFailure(r)!.kind, "network");
  assert.deepEqual(sloOutcome(r), { slo: "excluded", reason: "customer_code" });
  const s2 = step({ status: "failed", events: [ev("info", refusal), ev("error", "pod never became ready in 300s")] });
  assert.deepEqual(sloOutcome(run([s2], { status: "failed" })), { slo: "bad", reason: "platform" });
});

test("the terminal cause is the step that failed the run, not an optional one before it", () => {
  const optional = step({ status: "failed", optional: true, events: [ev("error", "script x exited (code 1)")] });
  const real = step({ status: "failed", events: [ev("error", "pod never became ready in 300s")] });
  const e = runWideEvent("acme", "desk", run([optional, real], { status: "failed" }));
  assert.deepEqual([e.errorClass, e.failureKind, e.slo, e.sloReason], ["platform_error", "platform", "bad", "platform"]);
});

test("the wide event holds metadata only — no instruction, reply or error words", () => {
  const s = sandboxed({ status: "failed", events: [ev("error", "SECRET-ERROR-WORDS script exited (code 2)")] });
  const e = runWideEvent("acme", "desk", run([s], { status: "failed", summary: "SECRET-SUMMARY" }));
  const text = JSON.stringify(e);
  assert.ok(!/SECRET/.test(text), text);
});

test("a direct agent run is kind agent, named by its agent", () => {
  const e = runWideEvent("acme", "desk", run([sandboxed()], { flow: "adhoc:researcher" }));
  assert.deepEqual([e.kind, e.flow], ["agent", "researcher"]);
});

test("ops trace: three services, fixed names, children inside their parents, ids of its own", () => {
  const r = run([sandboxed()]);
  const e = runWideEvent("acme", "desk", r, { queuedAt: at(0.05), eligibleAt: at(0.05), claimedAt: at(3) });
  const body = opsTrace(e)!;
  assert.deepEqual(body.resourceSpans.map((x) => x.resource.attributes[0]!.value), OPS_SERVICES.map((s) => ({ stringValue: s })));
  const spans = body.resourceSpans.flatMap((x) => x.scopeSpans[0]!.spans);
  const names = spans.map((s) => s.name);
  for (const n of ["run", "submit", "queue.wait", "drive", "pod.start", "sandbox.start", "first_output", "startup.files", "startup.tools"]) assert.ok(names.includes(n), n);
  for (const n of names) assert.ok((OPS_SPAN_NAMES as readonly string[]).includes(n), n);
  assert.ok(!names.includes("startup.room"), "phases before the pod was ready belong to pod.start");
  const byId = new Map(spans.map((s) => [s.spanId, s]));
  for (const s of spans) {
    assert.equal(s.traceId, opsTraceId("acme", "desk", r.id));
    assert.ok(BigInt(s.endTimeUnixNano) >= BigInt(s.startTimeUnixNano), s.name);
    const parent = "parentSpanId" in s ? byId.get(s.parentSpanId as string) : undefined;
    if (s.name === "run") continue;
    assert.ok(parent, `${s.name} has a parent`);
    assert.ok(BigInt(s.startTimeUnixNano) >= BigInt(parent!.startTimeUnixNano) && BigInt(s.endTimeUnixNano) <= BigInt(parent!.endTimeUnixNano), `${s.name} inside ${parent!.name}`);
  }
  // Not the account's own trace (otel.ts).
  const account = runToOtlp(r, { tenant: "acme", workspace: "desk" });
  assert.notEqual(account.resourceSpans[0]!.scopeSpans[0]!.spans[0] && (account.resourceSpans[0]!.scopeSpans[0]!.spans[0] as { traceId: string }).traceId, spans[0]!.traceId);
  assert.notEqual(opsTraceId("acme", "desk", r.id), opsTraceId("other", "desk", r.id));
});

test("ops trace attributes: only the span fields, only values in their ops-log shape — no content gets through", () => {
  for (const f of OPS_SPAN_FIELDS) assert.ok(f in FIELDS, `${f} is an ops-log field`);
  const s = sandboxed({ status: "failed", events: [ev("error", "SECRET words: /etc/passwd user@example.com")] });
  const e = runWideEvent("acme", "desk", run([s], { status: "failed", summary: "SECRET" }));
  // A model and a flow name that are not identifiers are dropped, not cut.
  const body = opsTrace({ ...e, model: "a model with spaces", flow: "has:colon" })!;
  const text = JSON.stringify(body);
  assert.ok(!/SECRET|passwd|example\.com|spaces|has:colon/.test(text), text);
  const spans = body.resourceSpans.flatMap((x) => x.scopeSpans[0]!.spans);
  for (const sp of spans) {
    assert.deepEqual(Object.keys(sp.status), ["code"], "no status message");
    for (const a of sp.attributes) {
      if (a.key === "error.type") {
        assert.ok(ERROR_CLASSES.includes((a.value as { stringValue: string }).stringValue as never));
        continue;
      }
      assert.match(a.key, /^foldrun\.[A-Za-z]+$/);
      assert.ok((OPS_SPAN_FIELDS as readonly string[]).includes(a.key.slice("foldrun.".length)), a.key);
    }
  }
  const root = spans.find((x) => x.name === "run")!;
  assert.deepEqual(root.status, { code: 2 });
  assert.ok(root.attributes.some((a) => a.key === "error.type"));
  // Fields outside the span list never come through, even ops-log ones.
  assert.deepEqual(opsAttributes({ fingerprint: "abc", runId: "run-1", tenant: "has space" }), [{ key: "foldrun.runId", value: { stringValue: "run-1" } }]);
});

test("ops trace: none for a run that has not finished", () => {
  assert.equal(opsTrace(runWideEvent("acme", "desk", run([step({ status: "running" })], { status: "running", finishedAt: null }))), null);
});
