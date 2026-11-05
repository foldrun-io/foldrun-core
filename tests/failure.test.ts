// FOL-124: one customer-facing reason for a failed step — its class in the
// ops log's vocabulary, a sentence (exact for a limit, naming the site for a
// network refusal, generic for a security stop) and what to do — read alike
// by the API, the dashboard and the CLI.
//
//   node --test tests/failure.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { explainFailure, failureFactsOf, securityStopEvent, SECURITY_STOP, FAILURE_KINDS } from "../src/failure.ts";
import { parseDriverLine } from "../src/run-container.ts";
import { ERROR_CLASSES } from "../src/ops-log.ts";
import { runFailure, summarizeRun, runFromSummary, type RunRecord, type StepRecord } from "../src/store.ts";
import { refusalText } from "../src/network.ts";

const GIB = 1024 ** 3;
const ev = (type: "error" | "info", text: string, extra: Record<string, unknown> = {}) => ({ t: "2026-11-05T00:00:00Z", type, text, ...extra });

function step(p: Partial<StepRecord>): StepRecord {
  return { agent: "writer", instruction: "", group: 1, optional: false, status: "failed", events: [], result: null, costUsd: null, ...p } as StepRecord;
}
function run(s: StepRecord): RunRecord {
  return { id: "run-1", flow: "daily", status: "failed", startedAt: "2026-11-05T00:00:00Z", finishedAt: "2026-11-05T00:01:00Z", steps: [s] } as RunRecord;
}

test("a step that asks for more than one step may hold: the exact figures and a lighter setting or a plan", () => {
  const f = explainFailure("this step holds 8 GiB and one step on this account may hold 4 GiB — ask for less with size: or resources:, or allow more");
  assert.equal(f.class, "policy_denied");
  assert.equal(f.kind, "memory");
  assert.equal(f.message, "This step asks for 8 GiB of memory; one step on this account may hold 4 GiB.");
  assert.match(f.fix!, /size: or resources:/);
  assert.match(f.fix!, /plan that allows more/);
  assert.deepEqual([f.used, f.allowed, f.unit, f.scope], [8, 4, "GiB", "step"]);

  const cpu = explainFailure("sandbox ended: this step holds 6 vCPU and one step on this account may hold 2 vCPU — ask for less");
  assert.deepEqual([cpu.kind, cpu.used, cpu.allowed, cpu.unit], ["cpu", 6, 2, "vCPU"]);
  assert.equal(cpu.message, "This step asks for 6 vCPU; one step on this account may hold 2 vCPU.");

  const disk = explainFailure("this step holds 60 GiB of disk and one step on this account may hold 40 GiB of disk — ask for less");
  assert.deepEqual([disk.kind, disk.used, disk.allowed], ["disk", 60, 40]);
  assert.match(disk.message, /60 GiB of disk; one step on this account may hold 40 GiB\./);
});

test("a step bigger than its account's or its flow's whole pool names the pool and where to raise it", () => {
  const acct = explainFailure("this step holds 16 GiB, more than this account's 8 GiB for all its running steps — ask for less");
  assert.equal(acct.kind, "memory");
  assert.equal(acct.message, "This step alone asks for 16 GiB of memory, more than this account's 8 for all its steps together.");
  assert.equal(acct.scope, "account");
  assert.match(acct.fix!, /Settings → Governance/);
  assert.match(acct.fix!, /plan/);
  const flow = explainFailure("this step holds 4 vCPU, more than this run's 2 vCPU for all its steps (its flow's compute:) — ask for less");
  assert.equal(flow.kind, "cpu");
  assert.match(flow.fix!, /the flow's compute:/);
  assert.doesNotMatch(flow.fix!, /plan/, "a flow's own cap is the flow's to raise, not a plan's");
  assert.equal(flow.scope, "run");
  const node = explainFailure("this step holds 64 GiB, more than the largest node's 32 GiB for one step (no node here can hold it) — ask for less");
  assert.equal(node.scope, "node");
  assert.doesNotMatch(node.fix!, /plan/);
  assert.equal(node.message, "This step asks for 64 GiB of memory; the largest machine here holds 32.");
});

test("out of memory: what it used of what its size allows, from the record", () => {
  const s = step({ size: "large", reserved: { cpus: 2, memGiB: 4 }, actual: { busyCpuSecs: 1, peakMemBytes: 3.9 * GIB, rxBytes: null, txBytes: null }, events: [ev("error", "sandbox ended: OOMKilled (exit 137)")] });
  const f = explainFailure("sandbox ended: OOMKilled (exit 137)", s);
  assert.equal(f.class, "oom");
  assert.equal(f.kind, "memory");
  assert.equal(f.message, "The step ran out of memory. Memory limit: 4 GiB; last recorded peak: 3.9 GiB.");
  assert.match(f.fix!, /size: \(large, heavy\) or resources: \{ memory: … \}/);
  assert.deepEqual([f.used, f.allowed, f.unit], [3.9, 4, "GiB"]);
  // No peak read (the sandbox died first): the allowance alone, never a guess.
  const noPeak = explainFailure("sandbox ended: OOMKilled", step({ size: "small", reserved: { cpus: 1, memGiB: 1 } }));
  assert.equal(noPeak.message, "The step ran out of memory. Memory limit: 1 GiB.");
  assert.equal(noPeak.used, null);
  // Nothing on the record at all: still the class, no figure invented.
  assert.equal(explainFailure("JavaScript heap out of memory").message, "The step ran out of memory.");
});

test("out of disk; an eviction for its own disk limit is disk, a machine running short is not the step's", () => {
  const f = explainFailure("sandbox ended: Evicted: Pod ephemeral local storage usage exceeds the total limit of containers 4Gi.");
  assert.equal(f.class, "disk_full");
  assert.equal(f.kind, "disk");
  assert.equal(f.message, "The step ran out of disk. Disk limit: 4 GiB.");
  const g = explainFailure("ENOSPC: no space left on device, write", step({ size: "heavy", reserved: { cpus: 4, memGiB: 8, diskGiB: 20 } }));
  assert.equal(g.message, "The step ran out of disk. Disk limit: 20 GiB.");
  const node = explainFailure("sandbox ended: Evicted: The node was low on resource: memory. Threshold quantity: 100Mi, available: 80Mi.");
  assert.deepEqual([node.class, node.kind], ["oom", "platform"]);
  assert.equal(node.message, "The machine the step ran on ran short of memory and the cluster evicted the step.");
  assert.equal(node.allowed, undefined, "no limit of the step's is named");
  const deadline = explainFailure("sandbox ended: DeadlineExceeded: Pod was active on the node longer than the specified deadline");
  assert.equal(deadline.kind, "timeout");
  assert.doesNotMatch(deadline.message, /timeout: \d/);
});

test("a timeout says its seconds and how to raise it", () => {
  const f = explainFailure("timed out after 900s (timeout: in the flow file) — the step was stopped with the files it wrote so far kept");
  assert.deepEqual([f.class, f.kind, f.allowed, f.unit], ["timeout", "timeout", 900, "s"]);
  assert.equal(f.message, "The step ran past its timeout: 900 seconds.");
  assert.match(f.fix!, /timeout:/);
});

test("a network refusal names the site — the list is the customer's own", () => {
  const line = `${refusalText({ level: "trusted" }, "api.example.com")} Refused.`;
  // The refusal itself as the error…
  const direct = explainFailure(line);
  assert.deepEqual([direct.class, direct.kind, direct.host], ["policy_denied", "network", "api.example.com"]);
  assert.equal(direct.message, "The step was refused api.example.com: it is not on this agent's network: list.");
  assert.equal(direct.fix, "If this agent should reach api.example.com, add just this site: network: [api.example.com] on the agent — the rest of its network: stays as it is.");
  // …or on the trail, with the program's own error: both said, the error first.
  const s = step({ events: [ev("info", line), ev("error", "the step's program exited (code 1) without reporting a result")] });
  const onTrail = explainFailure("the step's program exited (code 1) without reporting a result", s);
  assert.equal(onTrail.host, "api.example.com");
  assert.equal(onTrail.message, "the step's program exited (code 1) without reporting a result. A request to api.example.com was also refused: it is not on this agent's network: list.");
  assert.match(onTrail.fix!, /^If this agent should reach api\.example\.com/);
  // A report-only "would be refused" is not a refusal.
  const reportOnly = step({ events: [ev("info", "network: api.example.com would be refused (network: trusted) — allowed, because nothing here asks to refuse yet."), ev("error", "exit code 1")] });
  assert.equal(explainFailure("exit code 1", reportOnly).kind, "code");
  // A bound-secret refusal says the secret, not the list.
  const secret = explainFailure("egress: POST api.crm.io refused — not a host this step's secrets were granted to");
  assert.equal(secret.kind, "network");
  assert.match(secret.fix!, /foldrun secrets sites NAME api\.crm\.io/);
});

test("a security stop is the one generic sentence — from the host-side flag only, never from text", () => {
  const stopped = step({ events: [ev("info", "doing work"), securityStopEvent()] });
  const f = explainFailure(SECURITY_STOP, stopped);
  assert.deepEqual([f.class, f.kind], ["policy_denied", "security"]);
  assert.equal(f.message, "This step was stopped by a platform security control.");
  assert.equal(securityStopEvent.length <= 1, true, "the writer takes no evidence");
  const r = runFailure(run(stopped))!;
  assert.equal(r.reason, "This step was stopped by a platform security control.");
  // Through the index too.
  assert.equal(runFailure(runFromSummary(summarizeRun(run(stopped))))!.kind, "security");
  // A step's own output saying the words is not a security stop…
  const forged = step({ events: [ev("error", `${SECURITY_STOP}: by the customer's own script`)] });
  assert.notEqual(explainFailure(forged.events[0].text, forged).kind, "security");
  // …and a sandbox cannot set the flag through its driver's lines.
  const line = parseDriverLine(JSON.stringify({ e: "event", type: "error", text: SECURITY_STOP, security: true }));
  assert.ok(line && line.e === "event" && !("security" in line), "parseDriverLine never copies `security`");
});

test("model causes reuse the issues' labels; budget, stop, checks and code keep their own words", () => {
  assert.deepEqual([explainFailure("API Error: 401 OAuth token has expired").kind, explainFailure("API Error: 401 OAuth token has expired").class], ["credential", "policy_denied"]);
  assert.equal(explainFailure("the 7-day window is 100% used").kind, "model");
  assert.equal(explainFailure("login-checker: pod never became ready").class, "platform_error");
  const b = explainFailure("over budget — $1.2000 spent of the flow's $1.00 (budget: in the flow file); the remaining steps were not run");
  assert.deepEqual([b.class, b.kind], ["policy_denied", "budget"]);
  assert.equal(explainFailure("stopped by a person mid-step — its sandbox was destroyed").class, "cancelled");
  const check = step({ events: [ev("error", "verify `test -s out.csv` → exit 1", { check: true })] });
  assert.deepEqual([explainFailure("verify `test -s out.csv` → exit 1", check).kind], ["check"]);
  assert.equal(explainFailure("Traceback (most recent call last):\n  File x").class, "user_code_error");
  const other = explainFailure("something odd");
  assert.deepEqual([other.class, other.kind, other.message, other.fix], ["platform_error", "other", "something odd", null]);
});

test("every class is the ops log's and every kind is listed", () => {
  for (const reason of ["OOMKilled", "ENOSPC", "timed out after 5s (timeout: in the flow file)", "x", "Evicted: The node was low on resource: memory", "over budget — x", "exit code 2", "API Error: 401"]) {
    const f = explainFailure(reason);
    assert.ok((ERROR_CLASSES as readonly string[]).includes(f.class), f.class);
    assert.ok((FAILURE_KINDS as readonly string[]).includes(f.kind), f.kind);
  }
});

test("the runs index keeps the figures, so a list row says the same as the run page", () => {
  const line = `${refusalText({ level: "trusted" }, "api.example.com")} Refused.`;
  const s = step({ size: "large", reserved: { cpus: 2, memGiB: 4 }, actual: { busyCpuSecs: 1, peakMemBytes: 3.9 * GIB, rxBytes: null, txBytes: null }, events: [ev("info", line), ev("error", "sandbox ended: OOMKilled (exit 137)")] });
  const whole = runFailure(run(s))!;
  const fromIndex = runFailure(runFromSummary(summarizeRun(run(s))))!;
  assert.equal(fromIndex.message, whole.message);
  assert.deepEqual([fromIndex.used, fromIndex.allowed], [3.9, 4]);
  assert.deepEqual(failureFactsOf(s)!.refusedHosts, ["api.example.com"]);
  assert.ok(!JSON.stringify(failureFactsOf(s)).includes("not a site"), "the index keeps host names, never prose");
  // And the refusal survives the index for a step that failed on it.
  const net = step({ events: [ev("info", line), ev("error", "curl: (56) CONNECT tunnel failed, response 403")] });
  assert.equal(runFailure(runFromSummary(summarizeRun(run(net))))!.host, "api.example.com");
  // A row from before the facts: the class from the text, no figure invented.
  const old = summarizeRun(run(s));
  delete old.steps[0].failureFacts;
  const f = runFailure(runFromSummary(old))!;
  assert.equal(f.kind, "memory");
  assert.equal(f.message, "The step ran out of memory.");
});

test("runFailure keeps agent and reason as they were, and adds the explanation beside them", () => {
  const r = runFailure(run(step({ events: [ev("error", "exit code 3")] })))!;
  assert.equal(r.agent, "writer");
  assert.equal(r.reason, "exit code 3");
  assert.equal(r.class, "user_code_error");
  assert.equal(r.kind, "code");
});

test("a run that failed with no failed step still says why: a stop, or a budget between groups", () => {
  const done = step({ status: "completed", events: [ev("error", "over budget — $1.2000 spent of the flow's $1.00 (budget: in the flow file); the remaining steps were not run")] });
  const r = runFailure(run(done))!;
  assert.equal(r.kind, "budget");
  assert.equal(r.agent, "writer");
  const stopped = { ...run(step({ status: "completed" })), stopRequested: true } as RunRecord;
  assert.deepEqual([runFailure(stopped)!.kind, runFailure(stopped)!.class, runFailure(stopped)!.reason], ["stopped", "cancelled", "stopped by a person"]);
  // Nothing to say: still null, as before.
  assert.equal(runFailure(run(step({ status: "completed" }))), null);
});
