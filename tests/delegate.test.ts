// Isolated sub-agents (`sandbox: own`): a job handed over a door runs as a
// step of its own — its own sandbox and its own tools, not cut to the
// parent's — and only its reply comes back.
//
//   node --test tests/delegate.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createFlowRun, driveRun, buildSubagentSpecs, buildDelegateSpecs, runResult } from "../src/runner.ts";
import { readRun, writeRun, isSplicedRecord, workspaceDir, type FlowStep } from "../src/store.ts";
import { registerPlatform, platform } from "../src/platform.ts";
import type { RunInContainerArgs, ContainerStepOutcome } from "../src/run-container.ts";
import type { DelegationJob, EgressHooks } from "../src/egress.ts";
import type { DelegationResult, OperatorChannel } from "../src/operator.ts";
import { buildDelegateTools, localDelegateChannel, replyText, readCopyBack, copyBackFiles, COPY_BACK_MAX_BYTES } from "../src/delegate-tools.ts";
import { applyContainerChanges } from "../src/run-container.ts";
import { scanFiles } from "../src/scan.ts";

type Fake = (args: RunInContainerArgs) => Promise<ContainerStepOutcome>;
type Serve = (job: DelegationJob) => Promise<DelegationResult>;

const AGENTS: Record<string, string> = {
  writer: "---\nname: writer\ndescription: writes\ntools: [read]\nsubagents: [reader]\n---\n\nWrite it.\n",
  reader: "---\nname: reader\ndescription: Reads and summarises.\ntools: [code]\nsandbox: own\n---\n\nRead it.\n",
};

async function withDesk(fake: Fake, egress: Partial<EgressHooks> | null, body: (ws: string) => Promise<void>, agents = AGENTS) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-delegate-"));
  const prev = { data: process.env.FOLDRUN_DATA, iso: process.env.FOLDRUN_RUN_ISOLATION };
  process.env.FOLDRUN_DATA = root;
  process.env.FOLDRUN_RUN_ISOLATION = "fake";
  const before = { isolation: platform.isolation, sandboxResumable: platform.sandboxResumable, egress: platform.egress, killSandbox: platform.killSandbox };
  // An executor that can stop one job (records and kills its sandbox), as
  // the k8s one does — the condition for offering delegation at all.
  registerPlatform({ isolation: { fake }, sandboxResumable: () => true, killSandbox: () => {}, ...(egress ? { egress: { lease: async () => null, ...egress } } : {}) });
  try {
    const ws = path.join(root, "acme/workspaces/desk");
    fs.mkdirSync(path.join(ws, "runs"), { recursive: true });
    fs.writeFileSync(path.join(ws, "AGENTS.md"), "---\nname: desk\n---\n");
    for (const [a, text] of Object.entries(agents)) {
      fs.mkdirSync(path.join(ws, "agents", a), { recursive: true });
      fs.writeFileSync(path.join(ws, "agents", a, "agent.md"), text);
    }
    await body(ws);
  } finally {
    registerPlatform(before);
    for (const [k, v] of [["FOLDRUN_DATA", prev.data], ["FOLDRUN_RUN_ISOLATION", prev.iso]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const agentOf = (args: RunInContainerArgs) => String(args.input.agentRel).split("/").pop();
const step = (agent: string): FlowStep => ({ agent, instruction: "work", group: 1, optional: false });
const lease = () => ({ url: "http://proxy:8090/e/abcdefghijklmnopqrstuv", commit: async () => {}, drainLog: async () => [], release: async () => {} });

test("a sandbox: own job runs as a step of its own, with its own tools, and only its reply goes back", async () => {
  const seen: Record<string, RunInContainerArgs> = {};
  let serve: Serve | null = null;
  let leaseDelegates: string[] | undefined;
  let closed = 0;
  let parentGot: DelegationResult | null = null;
  const fake: Fake = async (args) => {
    const who = agentOf(args)!;
    seen[who] = args;
    if (who === "reader") {
      // What its copy-out put in the workspace, as the executor does.
      const notes = path.join(process.env.FOLDRUN_DATA!, "acme/workspaces/desk/storage/notes.md");
      fs.mkdirSync(path.dirname(notes), { recursive: true });
      fs.writeFileSync(notes, "# notes\n");
      return { status: "completed", result: "three sources, summarised", costUsd: 0.02, applied: ["storage/notes.md"] };
    }
    // The parent's pod hands a job over the door and waits for the reply.
    parentGot = await serve!({ id: "j1", agent: "reader", job: "read the three pages" });
    return { status: "completed", result: `wrote it from: ${parentGot.result}`, costUsd: 0.01 };
  };
  const egress: Partial<EgressHooks> = {
    lease: async (a) => {
      if (a.who?.agent === "writer") leaseDelegates = a.delegates;
      return lease();
    },
    delegations: (_args, run) => {
      serve = run;
      return { close: async () => void closed++ };
    },
  };
  await withDesk(fake, egress, async () => {
    const run = createFlowRun("acme", "desk", [step("writer")], "f", "running");
    writeRun("acme", "desk", run);
    await driveRun("acme", "desk", readRun("acme", "desk", run.id)!);
    const done = readRun("acme", "desk", run.id)!;

    const parent = seen.writer.input;
    assert.deepEqual(parent.delegates, [{ name: "reader", description: "Reads and summarises." }]);
    assert.equal(parent.subagents, undefined, "not an SDK sub-agent inside the parent's session");
    assert.ok(parent.allowed.includes("mcp__foldrun_delegate__delegate_reader"));
    assert.ok(!parent.allowed.includes("Bash"), "the parent does not hold the sub-agent's tools");
    assert.ok(parent.mcpNames.includes("foldrun_delegate"));
    assert.deepEqual(leaseDelegates, ["reader"], "the door takes only the declared name");
    assert.ok(seen.reader.input.allowed.includes("Bash"), "the sub-agent holds its own tools, uncut");
    assert.equal(seen.reader.input.delegates, undefined, "depth one");
    assert.equal(closed, 1, "serving stops when the parent's attempt ends");

    assert.deepEqual(parentGot, {
      status: "completed",
      result: "three sources, summarised",
      wrote: ["storage/notes.md"],
      files: [{ path: "storage/notes.md", base64: Buffer.from("# notes\n").toString("base64") }],
      filesOmitted: [],
    }, "its files travel back with the reply, for the parent's sandbox");
    assert.equal(done.status, "completed");
    assert.equal(done.steps.length, 2);
    const [w, r] = done.steps;
    assert.equal(r.subagentOf, "writer");
    assert.equal(r.group, w.group);
    assert.ok(isSplicedRecord(r));
    assert.deepEqual(r.wrote, ["storage/notes.md"]);
    assert.equal(w.delegations?.length, 1);
    assert.equal(w.delegations![0].status, "completed");
    assert.equal(w.delegations![0].id, r.delegation, "found by id, not by index");
    assert.equal(w.delegations![0].costUsd, 0.02);
    assert.equal(w.result, "wrote it from: three sources, summarised", "the flow's output is the parent's, not the child's");
  });
});

test("no door to the worker: not offered, and the step says why", async () => {
  const seen: Record<string, RunInContainerArgs> = {};
  const fake: Fake = async (args) => {
    seen[agentOf(args)!] = args;
    return { status: "completed", result: "ok", costUsd: 0 };
  };
  await withDesk(fake, { lease: async () => lease() }, async () => {
    const run = createFlowRun("acme", "desk", [step("writer")], "f", "running");
    writeRun("acme", "desk", run);
    await driveRun("acme", "desk", readRun("acme", "desk", run.id)!);
    const done = readRun("acme", "desk", run.id)!;
    assert.equal(seen.writer.input.delegates, undefined);
    assert.ok(!seen.writer.input.allowed.some((t) => t.includes("delegate_")));
    assert.ok(!seen.writer.input.prompt.includes("isolated-subagents"), "the prompt does not offer what it cannot do");
    assert.ok(done.steps[0].events.some((e) => e.type === "error" && /own sandbox.*not offered/.test(e.text)));
  });
});

test("a failed job comes back as a failed reply; the parent decides, the group does not fail for it", async () => {
  let serve: Serve | null = null;
  let got: DelegationResult | null = null;
  const fake: Fake = async (args) => {
    if (agentOf(args) === "reader") return { status: "failed", result: null, reason: "OOMKilled", costUsd: 0 };
    got = await serve!({ id: "j1", agent: "reader", job: "read" });
    return { status: "completed", result: "carried on without it", costUsd: 0 };
  };
  await withDesk(fake, { lease: async () => lease(), delegations: (_a, run) => ((serve = run), { close: async () => {} }) }, async () => {
    const run = createFlowRun("acme", "desk", [step("writer")], "f", "running");
    writeRun("acme", "desk", run);
    await driveRun("acme", "desk", readRun("acme", "desk", run.id)!);
    const done = readRun("acme", "desk", run.id)!;
    assert.equal(got!.status, "failed");
    assert.equal(done.steps[1].status, "failed");
    assert.equal(done.status, "completed", done.steps.map((s) => `${s.agent}:${s.status}`).join(","));
  });
});

test("specs: sandbox: own goes to the delegate list, never into the SDK's sub-agents", () => {
  const root = workspaceDir("default", `delegate-ws-${process.pid}`);
  try {
    for (const [a, text] of Object.entries({
      ...AGENTS,
      helper: "---\nname: helper\ndescription: helps\ntools: [read]\n---\n",
      bare: "---\nname: bare\nsandbox: own\n---\n",
    })) {
      fs.mkdirSync(path.join(root, "agents", a), { recursive: true });
      fs.writeFileSync(path.join(root, "agents", a, "agent.md"), text);
    }
    const lines: string[] = [];
    const push = (_t: string, text: string) => void lines.push(text);
    const names = ["reader", "helper", "bare"];
    const shared = buildSubagentSpecs({ names, self: "writer", workspaceRoot: root, tenant: "default", parentAllowed: ["Read", "Glob", "Grep"], push });
    assert.deepEqual(shared.map((s) => s.name), ["helper"]);
    const own = buildDelegateSpecs({ names, self: "writer", workspaceRoot: root, canRun: true, push });
    assert.deepEqual(own, [{ name: "reader", description: "Reads and summarises." }]);
    assert.ok(lines.some((l) => /"bare" has no description/.test(l)));
    lines.length = 0;
    assert.deepEqual(buildDelegateSpecs({ names, self: "writer", workspaceRoot: root, canRun: false, push }), []);
    assert.ok(lines.some((l) => /"reader" runs in its own sandbox.*not offered/.test(l)), "depth one, said");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("the tool: hands the job over, waits through empty polls, returns reply and files", async () => {
  const calls: string[] = [];
  let polls = 0;
  const channel: OperatorChannel = {
    ask: async () => ({ id: "x" }),
    poll: async () => null,
    inbox: async () => [],
    delegate: async (agent, job) => (calls.push(`${agent}:${job}`), { id: "d1" }),
    delegation: async () => (++polls < 3 ? null : { status: "completed", result: "done", wrote: ["storage/a.md"] }),
  };
  const events: string[] = [];
  const t = buildDelegateTools({ specs: [{ name: "reader", description: "Reads." }], channel, emit: (_k, text) => void events.push(text) });
  assert.deepEqual(t.toolNames, ["mcp__foldrun_delegate__delegate_reader"]);
  const out = (await t.calls.reader("summarise the pages")) as { content: { text: string }[]; isError?: boolean };
  assert.deepEqual(calls, ["reader:summarise the pages"]);
  assert.equal(polls, 3);
  assert.match(out.content[0].text, /^done/);
  assert.match(out.content[0].text, /storage\/a\.md/);
  assert.equal(out.isError, undefined);
  assert.ok(events.some((e) => e.startsWith("delegating to reader (own sandbox)")));

  const empty = (await t.calls.reader("   ")) as { isError?: boolean };
  assert.equal(empty.isError, true, "an empty job is refused before anything starts");
  assert.equal(buildDelegateTools({ specs: [{ name: "r", description: "d" }], channel: null, emit: () => {} }).server, null, "no channel, no tools");
  assert.match(replyText("reader", { status: "failed", result: "boom" }), /did not finish \(failed\)/);
});

test("the local channel: runs the job here and answers the poll", async () => {
  let cancelledSeen = false;
  const ch = localDelegateChannel(async (agent, job, cancelled) => {
    await new Promise((r) => setTimeout(r, 30));
    cancelledSeen = cancelled();
    return { status: "completed", result: `${agent} did ${job}` };
  });
  const { id } = await ch.delegate!("reader", "it");
  assert.equal(await ch.delegation!(id, 1), null, "still running");
  assert.deepEqual(await ch.delegation!(id, 1000), { status: "completed", result: "reader did it" });
  assert.equal(cancelledSeen, false);
  const bad = localDelegateChannel(async () => {
    throw new Error("no room");
  });
  const j = await bad.delegate!("reader", "it");
  assert.deepEqual(await bad.delegation!(j.id, 1000), { status: "failed", result: "no room" });
});

test("scan: an own-sandbox sub-agent's extra tools are said as such, not as a wider sub-agent", () => {
  const files = Object.entries(AGENTS).map(([a, content]) => ({ path: `agents/${a}/agent.md`, content }));
  const ids = scanFiles(files).map((f) => f.rule);
  assert.ok(ids.includes("security/subagent-own-sandbox"), ids.join(","));
  assert.ok(!ids.includes("security/subagent-wider"));
});

test("a job is not started when its agent's budget is spent or held by a job in flight", async () => {
  let serve: Serve | null = null;
  const replies: DelegationResult[] = [];
  const agents = { ...AGENTS, reader: AGENTS.reader.replace("sandbox: own", "sandbox: own\nbudget: 0.05") };
  const ceilings: (number | null | undefined)[] = [];
  const fake: Fake = async (args) => {
    if (agentOf(args) === "reader") {
      ceilings.push(args.input.budgetUsd);
      await new Promise((r) => setTimeout(r, 50));
      return { status: "completed", result: "ok", costUsd: 0.05 };
    }
    // Two at once: the first holds the agent's whole remaining budget while
    // it runs, so the second is refused. Then one after the first has spent it.
    replies.push(...(await Promise.all([serve!({ id: "a", agent: "reader", job: "one" }), serve!({ id: "b", agent: "reader", job: "two" })])));
    replies.push(await serve!({ id: "c", agent: "reader", job: "three" }));
    return { status: "completed", result: "done", costUsd: 0 };
  };
  await withDesk(fake, { lease: async () => lease(), delegations: (_a, run) => ((serve = run), { close: async () => {} }) }, async () => {
    const run = createFlowRun("acme", "desk", [step("writer")], "f", "running");
    writeRun("acme", "desk", run);
    await driveRun("acme", "desk", readRun("acme", "desk", run.id)!);
    assert.deepEqual(ceilings, [0.05], "only the first job started, capped at the agent's budget");
    assert.deepEqual(replies.map((r) => r.status), ["completed", "failed", "failed"]);
    assert.match(replies[1].result, /over budget/);
    assert.match(replies[2].result, /over budget/);
  }, agents);
});

test("the run's summary is the flow's last step, never an appended job's reply", async () => {
  let serve: Serve | null = null;
  const fake: Fake = async (args) => {
    if (agentOf(args) === "reader") return { status: "completed", result: "BAD — the reader's opinion", costUsd: 0 };
    await serve!({ id: "a", agent: "reader", job: "read" });
    return { status: "completed", result: "GOOD — the writer's verdict", costUsd: 0 };
  };
  await withDesk(fake, { lease: async () => lease(), delegations: (_a, run) => ((serve = run), { close: async () => {} }) }, async () => {
    const run = createFlowRun("acme", "desk", [step("writer")], "f", "running");
    writeRun("acme", "desk", run);
    await driveRun("acme", "desk", readRun("acme", "desk", run.id)!);
    const done = readRun("acme", "desk", run.id)!;
    assert.equal(done.steps.at(-1)!.subagentOf, "writer");
    assert.match(done.summary ?? "", /writer's verdict/);
    assert.match(runResult(done) ?? "", /writer's verdict/, "runResult too");
  });
});

test("a flow budget: a job gets only what the running steps do not hold", async () => {
  let serve: Serve | null = null;
  let got: DelegationResult | null = null;
  const fake: Fake = async (args) => {
    if (agentOf(args) === "reader") return { status: "completed", result: "ok", costUsd: 0 };
    got = await serve!({ id: "a", agent: "reader", job: "read" });
    return { status: "completed", result: "done", costUsd: 0 };
  };
  await withDesk(fake, { lease: async () => lease(), delegations: (_a, run) => ((serve = run), { close: async () => {} }) }, async () => {
    const run = createFlowRun("acme", "desk", [step("writer")], "f", "running");
    run.budgetUsd = 1;
    writeRun("acme", "desk", run);
    await driveRun("acme", "desk", readRun("acme", "desk", run.id)!);
    // The one step of the group holds the whole remaining flow budget, so
    // there is nothing left for its job: refused, not a second allowance.
    assert.equal(got!.status, "failed");
    assert.match(got!.result, /over budget/);
  });
});

test("a delegate whose tools act outward makes the delegating step not safe to re-run after a drop", async () => {
  let calls = 0;
  const fake: Fake = async (args) => {
    calls++;
    args.emit("tool", "mcp__foldrun_delegate__delegate_reader");
    args.emit("error", "Claude Code returned an error result: API Error: Connection dropped (ECONNRESET)");
    return { status: "failed", result: null, costUsd: 0 };
  };
  await withDesk(fake, { lease: async () => lease(), delegations: () => ({ close: async () => {} }) }, async (ws) => {
    fs.mkdirSync(path.join(ws, "tools"), { recursive: true });
    fs.writeFileSync(path.join(ws, "tools", "send.md"), "---\ntransport: script\nname: send\noutward: true\ndescription: Sends one email.\nrun: send.mjs\ninterpreter: node\n---\n");
    fs.writeFileSync(path.join(ws, "tools", "send.mjs"), "console.log('sent')\n");
    fs.writeFileSync(path.join(ws, "agents/reader/agent.md"), AGENTS.reader.replace("tools: [code]", "tools: [send]"));
    const run = createFlowRun("acme", "desk", [step("writer")], "f", "running");
    writeRun("acme", "desk", run);
    await driveRun("acme", "desk", readRun("acme", "desk", run.id)!);
    const done = readRun("acme", "desk", run.id)!;
    assert.equal(calls, 1, "not re-run: its job may have sent something");
    assert.ok(done.steps[0].events.some((e) => /not retried/.test(e.text)), done.steps[0].events.map((e) => e.text).join("\n"));
  });
});

test("a job left running by a dead worker is failed on resume, never launched; its parent hears so", async () => {
  const ran: string[] = [];
  const fake: Fake = async (args) => {
    ran.push(agentOf(args)!);
    return { status: "completed", result: "ok", costUsd: 0 };
  };
  await withDesk(fake, { lease: async () => lease(), delegations: () => ({ close: async () => {} }) }, async () => {
    const run = createFlowRun("acme", "desk", [step("writer")], "f", "running");
    run.steps[0].status = "running";
    run.steps[0].delegations = [{ id: "d_x", agent: "reader", status: "running" }];
    run.steps.push({ agent: "reader", subagentOf: "writer", delegation: "d_x", instruction: "read", group: 1, optional: true, attempts: 1, status: "running", events: [], result: null, costUsd: null, sandbox: { kind: "fake", ref: "pod-of-reader", consumed: 3, since: new Date().toISOString() } });
    writeRun("acme", "desk", run);
    const killed: string[] = [];
    registerPlatform({ killSandbox: (sb) => void killed.push(sb.ref) });
    await driveRun("acme", "desk", readRun("acme", "desk", run.id)!);
    const done = readRun("acme", "desk", run.id)!;
    assert.deepEqual(killed, ["pod-of-reader"], "its sandbox is destroyed before its reference is dropped");
    assert.equal(done.steps[1].sandbox, null);
    assert.deepEqual(ran, ["writer"], "the orphaned job was not launched as a step");
    assert.equal(done.steps[1].status, "failed");
    assert.match(done.steps[1].events.at(-1)!.text, /restarted/);
    assert.equal(done.steps[0].delegations![0].status, "failed");
  });
});

test("depth one: a job's own subagents: are not offered, of either kind", async () => {
  let serve: Serve | null = null;
  const seen: Record<string, RunInContainerArgs> = {};
  const agents = {
    ...AGENTS,
    reader: AGENTS.reader.replace("sandbox: own", "sandbox: own\nsubagents: [helper, deep]"),
    helper: "---\nname: helper\ndescription: helps\ntools: [read]\n---\n",
    deep: "---\nname: deep\ndescription: deeper\ntools: [read]\nsandbox: own\n---\n",
  };
  const fake: Fake = async (args) => {
    seen[agentOf(args)!] = args;
    if (agentOf(args) === "reader") return { status: "completed", result: "ok", costUsd: 0 };
    await serve!({ id: "a", agent: "reader", job: "read" });
    return { status: "completed", result: "done", costUsd: 0 };
  };
  await withDesk(fake, { lease: async () => lease(), delegations: (_a, run) => ((serve = run), { close: async () => {} }) }, async () => {
    const run = createFlowRun("acme", "desk", [step("writer")], "f", "running");
    writeRun("acme", "desk", run);
    await driveRun("acme", "desk", readRun("acme", "desk", run.id)!);
    const r = seen.reader.input;
    assert.equal(r.subagents, undefined);
    assert.equal(r.delegates, undefined);
    assert.ok(!r.allowed.includes("Agent"));
    const done = readRun("acme", "desk", run.id)!;
    assert.ok(done.steps[1].events.some((e) => /does not delegate again/.test(e.text)));
  }, agents);
});

test("a step that throws still closes its delegate service", async () => {
  let closed = 0;
  const fake: Fake = async () => {
    throw new Error("the cluster said no");
  };
  await withDesk(fake, { lease: async () => lease(), delegations: () => ({ close: async () => void closed++ }) }, async () => {
    const run = createFlowRun("acme", "desk", [step("writer")], "f", "running");
    writeRun("acme", "desk", run);
    await driveRun("acme", "desk", readRun("acme", "desk", run.id)!);
    assert.equal(closed, 1);
  });
});

test("when the parent stops waiting, the running job's sandbox is destroyed", async () => {
  let serve: Serve | null = null;
  const killed: string[] = [];
  let cancel = false;
  const fake: Fake = async (args) => {
    if (agentOf(args) === "reader") {
      // A pod that runs until it is killed: the checkpoint names it.
      await args.checkpoint?.("pod-of-reader", 0);
      for (let i = 0; i < 100 && !killed.length; i++) await new Promise((r) => setTimeout(r, 100));
      return { status: "failed", result: null, costUsd: 0, reason: "pod deleted" };
    }
    setTimeout(() => (cancel = true), 300);
    const got = await serve!({ id: "a", agent: "reader", job: "read", cancelled: () => cancel });
    return { status: "completed", result: `gave up: ${got.status}`, costUsd: 0 };
  };
  await withDesk(fake, { lease: async () => lease(), delegations: (_a, run) => ((serve = run), { close: async () => {} }) }, async () => {
    registerPlatform({ killSandbox: (sb) => void killed.push(sb.ref), sandboxResumable: () => true });
    const run = createFlowRun("acme", "desk", [step("writer")], "f", "running");
    writeRun("acme", "desk", run);
    await driveRun("acme", "desk", readRun("acme", "desk", run.id)!);
    const done = readRun("acme", "desk", run.id)!;
    assert.deepEqual(killed, ["pod-of-reader"]);
    assert.ok(done.steps[1].events.some((e) => /stopped waiting for it/.test(e.text)));
  });
});

test("an executor that cannot stop one job's sandbox is not offered delegation", async () => {
  const seen: Record<string, RunInContainerArgs> = {};
  const fake: Fake = async (args) => ((seen[agentOf(args)!] = args), { status: "completed", result: "ok", costUsd: 0 });
  await withDesk(fake, { lease: async () => lease(), delegations: () => ({ close: async () => {} }) }, async () => {
    registerPlatform({ killSandbox: undefined });
    const run = createFlowRun("acme", "desk", [step("writer")], "f", "running");
    writeRun("acme", "desk", run);
    await driveRun("acme", "desk", readRun("acme", "desk", run.id)!);
    const done = readRun("acme", "desk", run.id)!;
    assert.equal(seen.writer.input.delegates, undefined);
    assert.ok(done.steps[0].events.some((e) => /cannot stop one job's sandbox/.test(e.text)));
  });
});

// Owner, 23 Oct 2026: a job's files are copied back into the delegating
// step's sandbox, so its model and its `verify: file:` see them there.
test("a job's files are copied into the parent's sandbox; what is too large is named, not cut", async () => {
  const host = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-copyback-host-"));
  const pod = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-copyback-pod-"));
  try {
    fs.mkdirSync(path.join(host, "storage/deep"), { recursive: true });
    fs.writeFileSync(path.join(host, "storage/deep/a.txt"), "alpha");
    fs.writeFileSync(path.join(host, "storage/big.bin"), Buffer.alloc(COPY_BACK_MAX_BYTES + 1));
    fs.symlinkSync("/etc/hosts", path.join(host, "storage/link"));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-copyback-outside-"));
    fs.writeFileSync(path.join(outside, "secret.txt"), "not yours");
    fs.symlinkSync(outside, path.join(host, "storage/shared"));
    const back = readCopyBack(host, ["storage/deep/a.txt", "storage/big.bin", "storage/link", "storage/shared/secret.txt", "../outside", "storage/gone.txt"]);
    fs.rmSync(outside, { recursive: true, force: true });
    assert.deepEqual(back.files.map((f) => f.path), ["storage/deep/a.txt"], "files only: no links, nothing outside, nothing missing");
    assert.deepEqual(back.omitted, ["storage/big.bin"]);

    let polls = 0;
    const channel: OperatorChannel = {
      ask: async () => ({ id: "x" }), poll: async () => null, inbox: async () => [],
      delegate: async () => ({ id: "j" }),
      delegation: async () => (++polls < 2 ? null : { status: "completed", result: "done", wrote: ["storage/deep/a.txt", "storage/big.bin"], files: back.files, filesOmitted: back.omitted }),
    };
    const events: string[] = [];
    const t = buildDelegateTools({ specs: [{ name: "reader", description: "Reads." }], channel, emit: (_k, text) => void events.push(text), workspaceRoot: pod });
    const out = (await t.calls.reader("write it")) as { content: { text: string }[] };
    assert.equal(fs.readFileSync(path.join(pod, "storage/deep/a.txt"), "utf8"), "alpha", "in the parent's sandbox now");
    assert.ok(!fs.existsSync(path.join(pod, "storage/big.bin")));
    assert.match(out.content[0].text, /copied into your sandbox at the same paths:\n- storage\/deep\/a\.txt/);
    assert.match(out.content[0].text, /not in your sandbox \(too large to copy back[^\n]*\n- storage\/big\.bin/);
    assert.ok(events.some((e) => /1 copied into this sandbox/.test(e)));
  } finally {
    fs.rmSync(host, { recursive: true, force: true });
    fs.rmSync(pod, { recursive: true, force: true });
  }
});

test("copying back never writes outside the sandbox's workspace, nor through a link", () => {
  const pod = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-copyback-"));
  const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-copyback-out-"));
  try {
    fs.symlinkSync(elsewhere, path.join(pod, "storage"));
    const b64 = Buffer.from("x").toString("base64");
    const { copied: done } = copyBackFiles(pod, [
      { path: "../escape.txt", base64: b64 },
      { path: "/etc/abs.txt", base64: b64 },
      { path: "storage/via-link.txt", base64: b64 },
      { path: "state/ok.txt", base64: b64 },
    ]);
    assert.deepEqual(done, ["state/ok.txt"]);
    assert.deepEqual(fs.readdirSync(elsewhere), [], "nothing landed through the planted link");
    assert.ok(!fs.existsSync(path.join(path.dirname(pod), "escape.txt")));
  } finally {
    fs.rmSync(pod, { recursive: true, force: true });
    fs.rmSync(elsewhere, { recursive: true, force: true });
  }
});

test("a file the parent changed itself is kept; the job's version goes beside it (Codex review)", () => {
  const pod = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-copyback-"));
  try {
    fs.mkdirSync(path.join(pod, "storage"));
    fs.writeFileSync(path.join(pod, "storage/untouched.md"), "old");
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(path.join(pod, "storage/untouched.md"), old, old);
    const since = Date.now() - 1_000;
    fs.writeFileSync(path.join(pod, "storage/mine.md"), "the parent's edit");
    const b64 = (t: string) => Buffer.from(t).toString("base64");
    const r = copyBackFiles(pod, [
      { path: "storage/untouched.md", base64: b64("job") },
      { path: "storage/mine.md", base64: b64("job's") },
    ], { since, from: "reader" });
    assert.deepEqual(r.copied, ["storage/untouched.md"]);
    assert.deepEqual(r.conflicts, [{ path: "storage/mine.md", copy: "storage/mine.from-reader.md" }]);
    assert.equal(fs.readFileSync(path.join(pod, "storage/mine.md"), "utf8"), "the parent's edit");
    assert.equal(fs.readFileSync(path.join(pod, "storage/mine.from-reader.md"), "utf8"), "job's");
    // A second job's copy over the first job's copy is not the parent's edit.
    const again = copyBackFiles(pod, [{ path: "storage/untouched.md", base64: b64("job 2") }], { since, from: "reader" });
    assert.deepEqual(again.copied, ["storage/untouched.md"]);
  } finally {
    fs.rmSync(pod, { recursive: true, force: true });
  }
});

test("the copy-out does not apply a copied-back job change a second time (Codex review)", () => {
  const host = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-copyout-host-"));
  const pod = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-copyout-pod-"));
  try {
    // Handed in: A. The job appended B (now on the host); copied back into the
    // parent's sandbox, then the parent appended C.
    fs.mkdirSync(path.join(host, "state"));
    fs.mkdirSync(path.join(pod, "state"));
    fs.writeFileSync(path.join(host, "state/log.md"), "A\nB\n");
    fs.writeFileSync(path.join(pod, "state/log.md"), "A\n");
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(path.join(pod, "state/log.md"), old, old);
    const baseline = { "state/log.md": crypto.createHash("sha256").update("A\n").digest("hex") };
    copyBackFiles(pod, [{ path: "state/log.md", base64: Buffer.from("A\nB\n").toString("base64") }], { since: Date.now() - 1_000, from: "reader" });
    fs.appendFileSync(path.join(pod, "state/log.md"), "C\n");
    applyContainerChanges(host, pod, baseline);
    assert.equal(fs.readFileSync(path.join(host, "state/log.md"), "utf8"), "A\nB\nC\n", "B once, then C");
    assert.ok(!fs.existsSync(path.join(host, ".foldrun/copied-back.json")), "the manifest stays in the sandbox");
  } finally {
    fs.rmSync(host, { recursive: true, force: true });
    fs.rmSync(pod, { recursive: true, force: true });
  }
});

test("a conflict copy never lands on an existing file, and the manifest never through a link (Codex review)", () => {
  const pod = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-copyback-"));
  const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-copyback-out-"));
  try {
    fs.mkdirSync(path.join(pod, "storage"));
    const since = Date.now() - 1_000;
    fs.writeFileSync(path.join(pod, "storage/mine.md"), "edit");
    fs.writeFileSync(path.join(pod, "storage/mine.from-reader.md"), "the parent's work on the last copy");
    fs.symlinkSync(elsewhere, path.join(pod, ".foldrun"));
    const r = copyBackFiles(pod, [{ path: "storage/mine.md", base64: Buffer.from("job").toString("base64") }], { since, from: "reader" });
    assert.deepEqual(r.conflicts, [{ path: "storage/mine.md", copy: "storage/mine.from-reader-2.md" }]);
    assert.equal(fs.readFileSync(path.join(pod, "storage/mine.from-reader.md"), "utf8"), "the parent's work on the last copy");
    assert.deepEqual(fs.readdirSync(elsewhere), [], "no manifest written through the planted link");
  } finally {
    fs.rmSync(pod, { recursive: true, force: true });
    fs.rmSync(elsewhere, { recursive: true, force: true });
  }
});
