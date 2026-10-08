import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createFlowRun, driveRun, startFlowRun, waitForRun, isModelConnectionLost, dropRetrySafe, wroteToolCallAsText, TEXT_CALL_NOTE } from "../src/runner.ts";
import { readRun, writeRun, type FlowStep } from "../src/store.ts";
import { registerPlatform, platform } from "../src/platform.ts";
import type { RunInContainerArgs, ContainerStepOutcome } from "../src/run-container.ts";
import { putFile, storageBaseline, readFileBytes } from "../src/storage.ts";

// The retry policy and the resume, exercised through a fake executor
// registered under FOLDRUN_RUN_ISOLATION=fake. The fake sees exactly what
// the k8s executor sees — the args — and answers what a cluster would.

type Fake = (args: RunInContainerArgs) => Promise<ContainerStepOutcome>;

async function withFake(fake: Fake, resumable: boolean, body: (ws: string) => Promise<void>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-retry-"));
  const prev = { data: process.env.FOLDRUN_DATA, iso: process.env.FOLDRUN_RUN_ISOLATION, base: process.env.FOLDRUN_RETRY_BASE_MS };
  process.env.FOLDRUN_DATA = root;
  process.env.FOLDRUN_RUN_ISOLATION = "fake";
  process.env.FOLDRUN_RETRY_BASE_MS = "40"; // 40 ms, 80 ms, … instead of 15 s, 30 s, …
  const prevIso = platform.isolation;
  const prevRes = platform.sandboxResumable;
  registerPlatform({ isolation: { fake }, sandboxResumable: (kind) => resumable && kind === "fake" });
  try {
    const ws = path.join(root, "acme/workspaces/desk");
    fs.mkdirSync(path.join(ws, "agents/worker"), { recursive: true });
    fs.mkdirSync(path.join(ws, "runs"), { recursive: true });
    fs.writeFileSync(path.join(ws, "AGENTS.md"), "---\nname: desk\n---\n");
    fs.writeFileSync(path.join(ws, "agents/worker/agent.md"), "---\nname: worker\ndescription: works\n---\n\nWork.\n");
    await body(ws);
  } finally {
    registerPlatform({ isolation: prevIso, sandboxResumable: prevRes });
    for (const [k, v] of [["FOLDRUN_DATA", prev.data], ["FOLDRUN_RUN_ISOLATION", prev.iso], ["FOLDRUN_RETRY_BASE_MS", prev.base]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const step = (extra: Partial<FlowStep> = {}): FlowStep => ({ agent: "worker", instruction: "work", group: 1, optional: false, ...extra });

test("retry: waits with backoff, and an OOM-killed attempt comes back one size up", async () => {
  const seen: { size?: string; at: number }[] = [];
  const fake: Fake = async (args) => {
    seen.push({ size: args.size, at: Date.now() });
    if (seen.length === 1) return { status: "failed", result: null, costUsd: null, reason: "OOMKilled (exit 137)" };
    if (seen.length === 2) return { status: "failed", result: null, costUsd: null, reason: "Evicted: ephemeral-storage" };
    return { status: "completed", result: "done", costUsd: 0 };
  };
  await withFake(fake, false, async () => {
    const run = startFlowRun("acme", "desk", [step({ retry: 2 })], "f");
    const { run: done } = await waitForRun("acme", "desk", run.id, 20_000);
    assert.equal(done?.status, "completed");
    const s = done!.steps[0];
    assert.equal(s.attempts, 3);
    assert.equal(s.sizeUp, "heavy", "large → heavy after the OOM; heavy stays heavy after the eviction");
    assert.deepEqual(seen.map((x) => x.size), ["large", "heavy", "heavy"], "the executor was asked for the bigger class");
    const waits = s.events.filter((e) => /retrying in \d+s/.test(e.text));
    assert.equal(waits.length, 2);
    assert.match(waits[0].text, /at size: heavy/);
    assert.ok(s.events.some((e) => /sandbox ended: OOMKilled/.test(e.text)), "the cluster's reason is on the record");
    // The second wait is longer than the first: backoff, not a fixed pause.
    assert.ok(seen[2].at - seen[1].at >= 60, `second wait ${seen[2].at - seen[1].at}ms should be ~80ms`);
    assert.equal(s.sandbox, null, "no sandbox left on a settled step");
  });
});

test("a step whose driver died is re-attached, not re-run, when the executor can resume", async () => {
  const calls: RunInContainerArgs[] = [];
  const fake: Fake = async (args) => {
    calls.push(args);
    return { status: "completed", result: "carried on", costUsd: 0 };
  };
  await withFake(fake, true, async (ws) => {
    // The record a rolled worker leaves behind: the step running, its pod
    // named, two lines already applied, attempt 1 of 2.
    const run = createFlowRun("acme", "desk", [step({ retry: 1 })], "f", "running");
    run.steps[0].status = "running";
    run.steps[0].attempts = 1;
    run.steps[0].sandbox = { kind: "fake", ref: "pod-abc", consumed: 2, since: new Date().toISOString() };
    writeRun("acme", "desk", run);
    await driveRun("acme", "desk", readRun("acme", "desk", run.id)!);
    const done = readRun("acme", "desk", run.id)!;
    assert.equal(done.status, "completed");
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].resume, { ref: "pod-abc", consumed: 2 }, "the executor was told where to attach");
    assert.equal(done.steps[0].attempts, 1, "a resume is the same attempt, not a retry");
    assert.ok(done.steps[0].events.some((e) => /re-attaching to the running sandbox \(pod-abc, 2 lines already applied\)/.test(e.text)));
    assert.equal(done.steps[0].sandbox, null);
    assert.ok(fs.existsSync(path.join(ws, "runs", `${run.id}.json`)));
  });
});

test("the same orphan is run again from the start when the executor cannot resume", async () => {
  const calls: RunInContainerArgs[] = [];
  const fake: Fake = async (args) => {
    calls.push(args);
    return { status: "completed", result: "from scratch", costUsd: 0 };
  };
  await withFake(fake, false, async () => {
    const run = createFlowRun("acme", "desk", [step()], "f", "running");
    run.steps[0].status = "running";
    run.steps[0].sandbox = { kind: "fake", ref: "pod-abc", consumed: 2, since: new Date().toISOString() };
    writeRun("acme", "desk", run);
    await driveRun("acme", "desk", readRun("acme", "desk", run.id)!);
    const done = readRun("acme", "desk", run.id)!;
    assert.equal(done.status, "completed");
    assert.equal(calls[0].resume ?? null, null, "no resume for an executor that cannot");
    assert.ok(done.steps[0].events.some((e) => /interrupted mid-step/.test(e.text)));
  });
});

// 6 Oct 2026: a worker restart re-drove reddit-desk's run, and the storage/
// mirror was refilled from the store before anything else — putting the
// 2 Oct post back over the draft the finished writer step had just saved.
test("a run re-driven after its worker died keeps what its finished steps wrote to storage/", async () => {
  const seen: string[] = [];
  const fake: Fake = async (args) => {
    seen.push(fs.readFileSync(path.join(args.workspaceRoot, "storage", "post.json"), "utf8"));
    return { status: "completed", result: "validated", costUsd: 0 };
  };
  await withFake(fake, true, async (ws) => {
    await putFile("acme", "desk", "post.json", Buffer.from("2 Oct post, already live"), "run:old");
    fs.mkdirSync(path.join(ws, "storage"), { recursive: true });
    fs.writeFileSync(path.join(ws, "storage", "post.json"), "2 Oct post, already live");
    // What the dead driver left: step 1 (the writer) done, its draft on disk
    // only, the baseline it took when the run began, step 2 mid-flight.
    const run = createFlowRun("acme", "desk", [step(), step({ group: 2 })], "f", "running");
    fs.mkdirSync(path.join(ws, "runs", run.id), { recursive: true });
    fs.writeFileSync(path.join(ws, "runs", run.id, "storage-baseline.json"), JSON.stringify(storageBaseline("acme", "desk")));
    fs.rmSync(path.join(ws, "storage", "post.json"));
    fs.writeFileSync(path.join(ws, "storage", "post.json"), "6 Oct draft");
    run.steps[0].status = "completed";
    run.steps[1].status = "running";
    run.steps[1].sandbox = { kind: "fake", ref: "pod-v", consumed: 1, since: new Date().toISOString() };
    writeRun("acme", "desk", run);

    await driveRun("acme", "desk", readRun("acme", "desk", run.id)!);
    const done = readRun("acme", "desk", run.id)!;
    assert.equal(done.status, "completed");
    assert.deepEqual(seen, ["6 Oct draft"], "the resumed step saw the old post");
    assert.equal(fs.readFileSync(path.join(ws, "storage", "post.json"), "utf8"), "6 Oct draft");
    assert.equal((await readFileBytes("acme", "desk", "post.json"))?.toString(), "6 Oct draft");
    assert.ok(done.steps[0].events.some((e) => /files: kept post\.json/.test(e.text)));
  });
});

// 6 Oct 2026: the worker (and the egress proxy inside it) restarted every
// 4.5 minutes, and every running step failed on a cut model connection.
test("a cut model connection is the platform's: the step runs again without a retry: of its own", async () => {
  let calls = 0;
  const fake: Fake = async (args) => {
    calls++;
    if (calls === 1) {
      args.emit("error", "Claude Code returned an error result: API Error: Connection refused — a firewall or proxy may be blocking it (ECONNREFUSED)");
      return { status: "failed", result: null, costUsd: 0 };
    }
    return { status: "completed", result: "validated", costUsd: 0 };
  };
  await withFake(fake, false, async () => {
    const run = startFlowRun("acme", "desk", [step()], "f"); // no retry: declared
    const { run: done } = await waitForRun("acme", "desk", run.id, 20_000);
    assert.equal(done?.status, "completed");
    assert.equal(calls, 2);
    assert.ok(done!.steps[0].events.some((e) => /the model connection dropped .* running the step again/.test(e.text)));
  });
});

test("the connection rule: only the run's own final error, and never after outward tools ran", () => {
  assert.ok(isModelConnectionLost("Claude Code returned an error result: API Error: Connection refused — a firewall or proxy may be blocking it (ECONNREFUSED)"));
  assert.ok(isModelConnectionLost("Claude Code returned an error result: API Error: Connection dropped (ECONNRESET)"));
  assert.ok(!isModelConnectionLost("WebFetch: API Error: Connection refused — a firewall or proxy may be blocking it (ECONNREFUSED)"), "a tool's own fetch is the step's business");
  assert.ok(!isModelConnectionLost("Claude Code returned an error result: API Error: 529 overloaded"), "a busy provider has its own retry");
  assert.ok(dropRetrySafe(false, [{ type: "tool" }]), "tools that only touch the workspace: safe to run again");
  assert.ok(dropRetrySafe(true, [{ type: "text" }, { type: "error" }]), "outward tools granted but none ran: safe");
  assert.ok(!dropRetrySafe(true, [{ type: "tool" }, { type: "error" }]), "an outward tool ran: the post may be up — not again");
});

test("a step whose outward tool ran is not run again when its connection drops", async () => {
  let calls = 0;
  const fake: Fake = async (args) => {
    calls++;
    args.emit("tool", "mcp__foldrun_scripts__send");
    args.emit("error", "Claude Code returned an error result: API Error: Connection dropped (ECONNRESET)");
    return { status: "failed", result: null, costUsd: 0 };
  };
  await withFake(fake, false, async (ws) => {
    fs.mkdirSync(path.join(ws, "tools"), { recursive: true });
    fs.writeFileSync(path.join(ws, "tools", "send.md"), "---\ntransport: script\nname: send\noutward: true\ndescription: Sends one email.\nrun: send.mjs\ninterpreter: node\n---\n");
    fs.writeFileSync(path.join(ws, "tools", "send.mjs"), "console.log('sent')\n");
    fs.writeFileSync(path.join(ws, "agents/worker/agent.md"), "---\nname: worker\ndescription: works\ntools: [send]\n---\n\nWork.\n");
    const run = startFlowRun("acme", "desk", [step()], "f");
    const { run: done } = await waitForRun("acme", "desk", run.id, 20_000);
    assert.equal(done?.status, "failed");
    assert.equal(calls, 1, "sent once, not twice");
    assert.ok(done!.steps[0].events.some((e) => /dropped after this step's tools ran — not retried/.test(e.text)), done!.steps[0].events.map((e) => e.text).join("\n"));
  });
});

test("an on-fail rescuer inherits the step's verify, so a rescue cannot skip the check that failed", async () => {
  const fake: Fake = async (args) => {
    if (args.input.agentName === "worker" || calls++ === 0) return { status: "failed", result: null, costUsd: 0 };
    return { status: "completed", result: "fixed", costUsd: 0 };
  };
  let calls = 0;
  await withFake(fake, false, async (ws) => {
    fs.mkdirSync(path.join(ws, "agents/fixer"), { recursive: true });
    fs.writeFileSync(path.join(ws, "agents/fixer/agent.md"), "---\nname: fixer\ndescription: fixes\n---\n\nFix.\n");
    const run = startFlowRun("acme", "desk", [step({ onFail: "fixer", verify: "test -s workspace/storage/out.txt" })], "f");
    const { run: done } = await waitForRun("acme", "desk", run.id, 20_000);
    const rescue = done!.steps.find((s) => s.agent === "fixer");
    assert.ok(rescue, done!.steps.map((s) => s.agent).join(","));
    assert.equal(rescue!.verify, "test -s workspace/storage/out.txt");
  });
});

test("a tool call written out as text is caught, and the step runs once more with a note", async () => {
  const prompts: string[] = [];
  const fake: Fake = async (args) => {
    prompts.push(String(args.input.prompt));
    if (prompts.length === 1) {
      return { status: "completed", result: 'Let me look.\n<invoke name="recall_desk_runs">\n<parameter name="since">2026-10-04T18:00</parameter>\n</invoke>', costUsd: 0 };
    }
    return { status: "completed", result: "GOOD — the digest", costUsd: 0 };
  };
  await withFake(fake, false, async () => {
    const run = startFlowRun("acme", "desk", [step()], "f");
    const { run: done } = await waitForRun("acme", "desk", run.id, 20_000);
    assert.equal(done?.status, "completed");
    assert.equal(prompts.length, 2, "run once more");
    assert.ok(prompts[1].includes(TEXT_CALL_NOTE), "the second attempt is told what went wrong");
    assert.ok(!prompts[0].includes(TEXT_CALL_NOTE));
    assert.equal(done!.steps[0].result, "GOOD — the digest");
    assert.ok(done!.steps[0].events.some((e) => /wrote a tool call as text/.test(e.text)));
  });
});

test("the text-call rule: only a call left at the end of the reply", () => {
  assert.ok(wroteToolCallAsText('<invoke name="x">\n<parameter name="a">1</parameter>\n</invoke>'));
  assert.ok(wroteToolCallAsText("I'll call it now.\n<function_calls>\n<invoke name=\"x\">"), "an unclosed call");
  assert.ok(!wroteToolCallAsText("GOOD — all done, nothing to call."));
  assert.ok(!wroteToolCallAsText('The model once wrote <invoke name="x"></invoke> as text; ' + "and then the reply carries on for a good while. ".repeat(10)), "quoted mid-reply, then a real reply");
});

test("web brings Read with it (disallowedTools still wins), and the prompt names the read-first rule and exact tool names", async () => {
  const seen: RunInContainerArgs[] = [];
  const fake: Fake = async (args) => {
    seen.push(args);
    return { status: "completed", result: "done", costUsd: 0 };
  };
  await withFake(fake, false, async (ws) => {
    fs.mkdirSync(path.join(ws, "agents/looker"), { recursive: true });
    fs.writeFileSync(path.join(ws, "agents/looker/agent.md"), "---\nname: looker\ndescription: looks\ntools: [web, ping]\n---\n\nLook.\n");
    fs.mkdirSync(path.join(ws, "tools"), { recursive: true });
    fs.mkdirSync(path.join(ws, "scripts"), { recursive: true });
    fs.writeFileSync(path.join(ws, "tools/ping.md"), "---\ntransport: script\nname: ping\ndescription: Answers pong.\nrun: workspace/scripts/ping.mjs\n---\n");
    fs.writeFileSync(path.join(ws, "scripts/ping.mjs"), "console.log('pong')\n");
    fs.mkdirSync(path.join(ws, "agents/blind"), { recursive: true });
    fs.writeFileSync(path.join(ws, "agents/blind/agent.md"), "---\nname: blind\ndescription: looks\ntools: [web]\ndisallowedTools: [Read]\n---\n\nLook.\n");
    const run = startFlowRun("acme", "desk", [step({ agent: "looker" }), step({ agent: "blind", group: 2 })], "f");
    const { run: done } = await waitForRun("acme", "desk", run.id, 20_000);
    assert.equal(done?.status, "completed");
    const [looker, blind] = seen;
    assert.ok(looker.input.allowed.includes("Read"), `web grants Read: ${looker.input.allowed}`);
    assert.ok(!blind.input.allowed.includes("Read"), "disallowedTools removes it again");
    const sys = String(looker.input.systemPrompt);
    assert.match(sys, /Read it first — Write refuses a file you have not Read/);
    assert.match(sys, /Built-in tools are capitalised: Read, Write, Edit, Glob, Grep, Bash/);
    assert.match(sys, /called by its full name, `mcp__foldrun_scripts__<name>`/);
  });
});
