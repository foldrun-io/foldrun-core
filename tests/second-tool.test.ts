// tools: [debate, review] in a cloud step (FOL-444): second-tool.ts against a
// fake proxy, and the runner's grant — what it sends, what it refuses before
// anything leaves, what it adds to the step's spend.
//
//   node --test tests/second-tool.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SECOND_SERVER, SECOND_TOOL_NAMES, buildSecondTools, secondPromptLine, type SideSpend } from "../src/second-tool.ts";
import { limitKeysFor } from "../src/limits.ts";
import { classifyCall } from "../src/browser-pod.ts";

const TOKEN = "t".repeat(24);
const EGRESS = `http://foldrun-egress:8090/e/${TOKEN}`;
const textOf = (r: { content: { type: string; text?: string }[] }) => r.content.map((c) => c.text ?? "").join("");
const isError = (r: unknown) => (r as { isError?: boolean }).isError === true;

function layout() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "second-tool-"));
  const ws = path.join(root, "ws");
  const agentDir = path.join(ws, "agents", "coder");
  const lib = path.join(root, "library");
  fs.mkdirSync(path.join(ws, "storage"), { recursive: true });
  fs.mkdirSync(agentDir, { recursive: true });
  fs.mkdirSync(lib, { recursive: true });
  return { ws, agentDir, lib };
}

function fakeFetch(answer: (body: Record<string, unknown>) => { status: number; body: unknown }) {
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  const impl = (async (url: string | URL, init: RequestInit = {}) => {
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    calls.push({ url: String(url), body });
    const a = answer(body);
    return new Response(JSON.stringify(a.body), { status: a.status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { calls, impl };
}

const build = (o: { spend?: SideSpend; egress?: string | null; tools?: ("debate" | "review")[]; impl?: typeof fetch } = {}) => {
  const { ws, agentDir, lib } = layout();
  const spend = o.spend ?? { usd: 0 };
  const events: string[] = [];
  const t = buildSecondTools({ egress: o.egress === undefined ? EGRESS : o.egress, tools: o.tools ?? ["debate", "review"], model: "openai/gpt-x", agentDir, workspaceRoot: ws, libraryRoot: lib, spend, emit: (_k, s) => events.push(s), ...(o.impl ? { fetchImpl: o.impl } : {}) });
  return { t, ws, agentDir, spend, events };
};

test("names, limit keys, and a paid call a lost pod must not repeat unsaid", () => {
  assert.equal(SECOND_SERVER, "foldrun_second");
  assert.deepEqual(SECOND_TOOL_NAMES, { debate: "mcp__foldrun_second__debate", review: "mcp__foldrun_second__review" });
  assert.deepEqual(limitKeysFor(SECOND_TOOL_NAMES.debate, {}), ["calls", "debate"]);
  assert.deepEqual(limitKeysFor(SECOND_TOOL_NAMES.review, {}), ["calls", "review"]);
  assert.deepEqual(classifyCall(SECOND_TOOL_NAMES.review, {}), { write: true, what: "a paid second opinion (review)" });
  assert.match(secondPromptLine(["review"], "openai/gpt-x"), /openai\/gpt-x.*never this conversation[\s\S]*diff_path/);
  assert.doesNotMatch(secondPromptLine(["review"], "openai/gpt-x"), /debate\(/);
});

test("debate: the door, the input alone, the step's budget left as max_usd, the cost added to the step's spend", async () => {
  const f = fakeFetch(() => ({ status: 200, body: { tool: "debate", model: "openai/gpt-x", text: "It does not stand.", cost_usd: 0.0123 } }));
  const spend: SideSpend = { usd: 0, left: () => 0.5 };
  const { t, events } = build({ spend, impl: f.impl });
  const r = await t.call.debate({ topic: "cache or not?", position: "cache it" });
  assert.equal(isError(r), false);
  assert.equal(textOf(r), "It does not stand.");
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0]!.url, `http://foldrun-egress:8090/second/${TOKEN}`);
  assert.deepEqual(f.calls[0]!.body, { tool: "debate", input: { topic: "cache or not?", position: "cache it" }, max_usd: 0.5 });
  assert.equal(spend.usd, 0.0123);
  assert.match(events.join("\n"), /debate: openai\/gpt-x answered \(\$0\.0123\)/);
});

test("refused before anything leaves: no proxy, a spent budget, no diff, a file outside the workspace, too much", async () => {
  const f = fakeFetch(() => ({ status: 200, body: {} }));
  let { t } = build({ egress: null, impl: f.impl });
  assert.match(textOf(await t.call.debate({ topic: "x" })), /needs a platform run/);
  ({ t } = build({ spend: { usd: 1, left: () => 0 }, impl: f.impl }));
  assert.match(textOf(await t.call.debate({ topic: "x" })), /budget is spent/);
  ({ t } = build({ impl: f.impl }));
  assert.match(textOf(await t.call.review({})), /needs the change/);
  assert.match(textOf(await t.call.review({ diff_path: "/etc/passwd" })), /refused|may not/);
  assert.match(textOf(await t.call.review({ diff: "x", diff_path: "y" })), /not both/);
  assert.match(textOf(await t.call.review({ diff: "x".repeat(200_001) })), /one review takes/);
  // A named pipe with no writer is refused, not waited on.
  const { ws } = build({ impl: f.impl });
  const { execFileSync } = await import("node:child_process");
  execFileSync("mkfifo", [path.join(ws, "storage", "pipe")]);
  ({ t } = build({ impl: f.impl }));
  const piped = buildSecondTools({ egress: EGRESS, tools: ["review"], model: "openai/gpt-x", agentDir: path.join(ws, "agents", "coder"), workspaceRoot: ws, libraryRoot: ws, spend: { usd: 0 }, fetchImpl: f.impl });
  assert.match(textOf(await piped.call.review({ diff_path: "workspace/storage/pipe" })), /not a file/);
  assert.equal(f.calls.length, 0);
});

test("review: the diff and files read from the sandbox, so the model never writes them out", async () => {
  const f = fakeFetch(() => ({ status: 200, body: { tool: "review", model: "openai/gpt-x", text: "openai/gpt-x reviewed the change: fine\nNo findings.", cost_usd: 0.002 } }));
  const { t, ws } = build({ tools: ["review"], impl: f.impl });
  fs.writeFileSync(path.join(ws, "storage", "change.diff"), "diff --git a/a.ts b/a.ts\n+x\n");
  fs.writeFileSync(path.join(ws, "storage", "a.ts"), "export const x = 1;\n");
  const r = await t.call.review({ diff_path: "workspace/storage/change.diff", paths: ["workspace/storage/a.ts"], instructions: "look at x" });
  assert.equal(isError(r), false, textOf(r));
  assert.deepEqual(f.calls[0]!.body, { tool: "review", input: { diff: "diff --git a/a.ts b/a.ts\n+x\n", files: [{ path: "storage/a.ts", content: "export const x = 1;\n" }], instructions: "look at x" } });
  assert.equal(t.call.debate !== undefined, true);
  assert.equal(t.toolNames.join(), SECOND_TOOL_NAMES.review);
});

test("a refusal is said as one, with whether it may have been charged; a cost is counted even then", async () => {
  const f = fakeFetch(() => ({ status: 503, body: { error: "unavailable", message: "openai/gpt-x gave no answer", maybe_charged: true, cost_usd: 0.001 } }));
  const spend: SideSpend = { usd: 0 };
  const { t } = build({ spend, impl: f.impl });
  const r = await t.call.debate({ topic: "x" });
  assert.equal(isError(r), true);
  assert.match(textOf(r), /not answered: openai\/gpt-x gave no answer \(it may have been charged\)/);
  assert.equal(spend.usd, 0.001);
});

test("the runner grants the tools and the lease's door for them, and says why it will not", async () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), "second-grant-"));
  process.env.FOLDRUN_DATA = data;
  const { agentContext } = await import("../src/runner.ts");
  const ws = path.join(data, "acme", "workspaces", "desk");
  const mk = (name: string, front: string) => {
    const d = path.join(ws, "agents", name);
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, "agent.md"), `---\nname: ${name}\n${front}---\n\nWork.\n`);
    return d;
  };
  type Ctx = { allowed: string[]; second: { tools: string[]; model: string } | null; providerWarnings: string[] };
  const ctx = (d: string) => agentContext(d, "acme", [], {}, null, true) as unknown as Ctx;
  const both = ctx(mk("both", "model: anthropic/claude-x\ntools: [read, debate, review]\nsecond_model: openai/gpt-x\n"));
  assert.deepEqual(both.second, { tools: ["debate", "review"], model: "openai/gpt-x" });
  assert.ok(both.allowed.includes(SECOND_TOOL_NAMES.debate) && both.allowed.includes(SECOND_TOOL_NAMES.review));
  assert.ok(!both.providerWarnings.some((w) => /FOL-444/.test(w)), both.providerWarnings.join("\n"));
  const none = ctx(mk("none", "tools: [read, review]\n"));
  assert.equal(none.second, null);
  assert.ok(!none.allowed.includes(SECOND_TOOL_NAMES.review));
  assert.ok(none.providerWarnings.some((w) => /needs second_model:/.test(w)));
  // Same provider or not is decided at launch, for the model actually sent (model-supply.test.ts).
  const denied = ctx(mk("denied", "tools: [debate, review]\nsecond_model: openai/gpt-x\ndisallowedTools: [review]\n"));
  assert.deepEqual(denied.second?.tools, ["debate"]);
  const asking = ctx(mk("asking", "tools:\n  - read\n  - review: ask\nsecond_model: openai/gpt-x\n"));
  assert.equal(asking.second, null);
  assert.ok(asking.providerWarnings.some((w) => /review: ask/.test(w)), asking.providerWarnings.join("\n"));
});

test("a paid second opinion that answered stops a whole-step retry from asking again", async () => {
  const { paidSecondRan } = await import("../src/runner.ts");
  assert.equal(paidSecondRan([{ type: "tool", text: SECOND_TOOL_NAMES.review }]), true);
  assert.equal(paidSecondRan([{ type: "tool", text: "Read" }, { type: "text", text: SECOND_TOOL_NAMES.debate }]), false);
});

test("the door's spend line is read back, and two calls at once are sent one after the other", async () => {
  const { secondSpentOf } = await import("../src/runner.ts");
  assert.equal(secondSpentOf("second opinion spent: review $0.012300"), 0.0123);
  assert.equal(secondSpentOf("egress: POST second/review → 200 ($0.0123)"), 0);
  let inFlight = 0;
  let most = 0;
  const seenLeft: unknown[] = [];
  const spend: SideSpend = { usd: 0 };
  spend.left = () => 0.1 - spend.usd;
  const impl = (async (_url: string | URL, init: RequestInit = {}) => {
    seenLeft.push((JSON.parse(String(init.body)) as { max_usd?: number }).max_usd);
    inFlight++;
    most = Math.max(most, inFlight);
    await new Promise((r) => setTimeout(r, 20));
    inFlight--;
    return new Response(JSON.stringify({ text: "ok", cost_usd: 0.04 }), { status: 200 });
  }) as typeof fetch;
  const { t } = build({ spend, impl });
  await Promise.all([t.call.debate({ topic: "a" }), t.call.debate({ topic: "b" })]);
  assert.equal(most, 1, "never two at once");
  assert.equal(seenLeft.length, 2);
  assert.ok(Math.abs((seenLeft[1] as number) - 0.06) < 1e-9, "the second is sent with what the first left");
});

test("after a call that got no answer back, no more are sent in the step", async () => {
  let n = 0;
  const impl = (async () => {
    n++;
    throw new Error("socket hang up");
  }) as typeof fetch;
  const { t } = build({ impl });
  assert.match(textOf(await t.call.debate({ topic: "a" })), /did not answer/);
  assert.match(textOf(await t.call.review({ diff: "x" })), /may have been charged, so what the step's budget has left is not known/);
  assert.equal(n, 1);
});
