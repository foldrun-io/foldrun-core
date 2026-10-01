// limits: — per-step call limits, counted in the PreToolUse hook every call
// passes. The pure parts (keys, cascade, counter, check) first; then the
// hook itself, with a fake SDK that runs a tool only when the hook lets it.
//
//   node --test tests/limits.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { HookInput } from "@anthropic-ai/claude-agent-sdk";
import {
  CallCounter, cascadeLimits, limitKeyProblems, limitKeysFor, parseStepLimits, readLimits, toolOwners,
} from "../src/limits.ts";
import { executeStep, type QueryFn } from "../src/step-exec.ts";
import { parseFlow } from "../src/store.ts";
import { deployIssues } from "../src/deploy.ts";

// ------------------------------------------------------------------ keys

test("each kind of tool counts under the name it is granted as", () => {
  const owners = toolOwners(
    [{ name: "crm" }, { name: "crm_admin" }],
    ["mcp__foldrun_apis__crm_list_contacts", "mcp__foldrun_apis__call_crm", "mcp__foldrun_apis__crm_admin_purge"],
    [{ name: "desk_email" }],
  );
  // the web tool: the aggregate and the action
  assert.deepEqual(limitKeysFor("mcp__foldrun_scripts__web", { action: "search", query: "x" }), ["calls", "web", "web.search"]);
  assert.deepEqual(limitKeysFor("mcp__foldrun_scripts__web", { action: "Fetch" }), ["calls", "web", "web.fetch"]);
  // a model provider's own search or fetch stands in for the web tool's
  assert.deepEqual(limitKeysFor("WebSearch", {}), ["calls", "web", "web.search"]);
  assert.deepEqual(limitKeysFor("WebFetch", {}), ["calls", "web", "web.fetch"]);
  // an http tool: every operation of an openapi tool, and the generic call, under the tool's name
  assert.deepEqual(limitKeysFor("mcp__foldrun_apis__crm_list_contacts", {}, owners), ["calls", "crm"]);
  assert.deepEqual(limitKeysFor("mcp__foldrun_apis__call_crm", {}, owners), ["calls", "crm"]);
  assert.deepEqual(limitKeysFor("mcp__foldrun_apis__crm_admin_purge", {}, owners), ["calls", "crm_admin"], "the longer name wins");
  // a script tool
  assert.deepEqual(limitKeysFor("mcp__foldrun_scripts__desk_email", {}, owners), ["calls", "desk_email"]);
  // an MCP server, every one of its tools
  assert.deepEqual(limitKeysFor("mcp__linear__create_issue", {}), ["calls", "linear"]);
  // the platform's own groups and consults
  assert.deepEqual(limitKeysFor("mcp__foldrun_search__search_files", {}), ["calls", "search"]);
  assert.deepEqual(limitKeysFor("mcp__foldrun_ask__ask_person", {}), ["calls", "ask"]);
  assert.deepEqual(limitKeysFor("mcp__foldrun_agents__consult_editor", {}), ["calls", "editor"]);
  // built-ins: the group and the SDK name
  assert.deepEqual(limitKeysFor("Read", {}), ["calls", "read", "Read"]);
  assert.deepEqual(limitKeysFor("Edit", {}), ["calls", "write", "Edit"]);
  assert.deepEqual(limitKeysFor("Bash", {}), ["calls", "code", "Bash"]);
  // a delegation is a call, nothing more; its sub-agent's calls count on their own
  assert.deepEqual(limitKeysFor("Agent", { subagent_type: "r" }), ["calls"]);
});

// ------------------------------------------------------------- the block

test("readLimits takes counts, web.<action> and a nested web block; refuses the rest", () => {
  assert.deepEqual(readLimits({ "web.search": 40, web: 150, crm: "20", calls: 300 }).limits, { "web.search": 40, web: 150, crm: 20, calls: 300 });
  assert.deepEqual(readLimits({ web: { search: 10, fetch: 5 } }).limits, { "web.search": 10, "web.fetch": 5 });
  const bad = readLimits({ "web.surf": 3, crm: 0, calls: 2.5, x: "lots", "a.b": 1 });
  assert.deepEqual(bad.limits, {});
  assert.equal(bad.problems.length, 5);
  assert.match(bad.problems[0], /web\.surf.*web\.search/);
  assert.match(bad.problems[1], /crm: 0 — a whole number of calls, 1 or more/);
  assert.match(readLimits([1, 2]).problems[0], /is a block/);
});

test("nearest wins per key: account, workspace, agent, step", () => {
  assert.deepEqual(
    cascadeLimits([{ calls: 500, "web.search": 100 }, { calls: 300 }, { "web.search": 40, crm: 20 }, { "web.search": 10 }]),
    { calls: 300, "web.search": 10, crm: 20 },
  );
  // dashes and underscores are one tool
  assert.deepEqual(cascadeLimits([{ "desk-email": 5 }, { desk_email: 2 }]), { desk_email: 2 });
  assert.deepEqual(cascadeLimits([undefined, null, {}]), {});
});

test("a step's limits: option, on one line", () => {
  assert.deepEqual(parseStepLimits("{web.search: 10, calls: 50}").limits, { "web.search": 10, calls: 50 });
  assert.deepEqual(parseStepLimits("crm: 3").limits, { crm: 3 });
  const f = parseFlow("f.md", "---\ntrigger: manual\n---\n\n1. [[scout]] — find them\n   limits: {web.search: 10}\n2. [[writer]] — write\n   limits: {calls: 0}\n");
  assert.deepEqual(f.steps[0].limits, { "web.search": 10 });
  assert.equal(f.steps[0].instruction, "find them");
  assert.equal(f.steps[1].limits, undefined);
  assert.match(f.steps[1].problems?.[0] ?? "", /^limits: \{calls: 0\} — calls: 0 — a whole number/);
});

test("the deploy gate refuses a limits: it cannot read", () => {
  const r = deployIssues([
    { path: "AGENTS.md", content: "---\nlimits:\n  calls: none\n---\n" },
    { path: "agents/a/agent.md", content: "---\nname: a\nlimits:\n  web.search: 40\n---\nWork.\n" },
  ]);
  assert.ok(r.some((p) => p.where === "AGENTS.md" && /calls: none/.test(p.message)), JSON.stringify(r));
  assert.ok(!r.some((p) => p.where === "agents/a/agent.md"), JSON.stringify(r));
});

// ------------------------------------------------------------ the counter

test("a call past a limit is refused, counts toward nothing, and the summary says so", () => {
  const c = new CallCounter({ "web.search": 2, web: 3, calls: 10 });
  const search = ["calls", "web", "web.search"];
  const fetch = ["calls", "web", "web.fetch"];
  assert.equal(c.take(search), null);
  assert.equal(c.take(search), null);
  const r = c.take(search);
  assert.equal(r?.message, "limit reached: web.search 2 of 2 in this step — work with what you have, or say what more you would need");
  assert.equal(c.count("web"), 2, "the refused call was not counted under web");
  assert.equal(c.count("calls"), 2);
  assert.equal(c.take(fetch), null, "another action still has room under web");
  assert.match(c.take(fetch)?.message ?? "", /^limit reached: web 3 of 3/);
  assert.equal(c.summary(), "limits: web.search 2/2, web 3/3, calls 3/10 — 2 calls refused");
  assert.equal(new CallCounter({}).summary(), null);
  const total = new CallCounter({ calls: 1 });
  assert.equal(total.take(["calls", "read", "Read"]), null);
  assert.match(total.take(["calls", "crm"])?.message ?? "", /^limit reached: calls 1 of 1/);
});

// ------------------------------------------------------------- check

test("check: a key that names nothing is an error, a tool not granted a warning", () => {
  const p = limitKeyProblems({ "web.search": 4, calls: 9, crm: 3, ghost: 2, read: 5, hubspot: 1 }, {
    known: ["crm", "hubspot", "desk_email"],
    granted: ["web", "crm", "write"],
  });
  assert.deepEqual(p.map((x) => x.level), ["error", "warn"]);
  assert.match(p[0].message, /^limits: ghost — not a tool this agent could call\. The keys: calls, web, web\.search/);
  assert.match(p[0].message, /crm/);
  assert.match(p[1].message, /^limits: hubspot — this agent is not granted hubspot/);
  // web.<action> without the web tool
  assert.equal(limitKeyProblems({ "web.fetch": 2 }, { known: [], granted: ["read"] })[0].level, "warn");
});

// ------------------------------------------------- the hook, with a fake SDK

type Pre = (i: unknown) => Promise<{ hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string } }>;

function withAgent(body: (agentDir: string) => Promise<void>) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-limits-")));
  const agentDir = path.join(root, "agents", "scout");
  fs.mkdirSync(agentDir, { recursive: true });
  return body(agentDir).finally(() => fs.rmSync(root, { recursive: true, force: true }));
}

test("a refused call never runs: the script's counter file stays at the limit", () =>
  withAgent(async (agentDir) => {
    const counterFile = path.join(agentDir, "runs.txt");
    const replies: string[] = [];
    // The SDK's contract, as the fake keeps it: ask the hook, run the tool
    // only when it is not denied, hand the refusal back to the model.
    const query: QueryFn = ({ options }) => {
      const pre = (options as { hooks: { PreToolUse: { hooks: Pre[] }[] } }).hooks.PreToolUse[0].hooks[0];
      return Object.assign((async function* () {
        for (let i = 0; i < 5; i++) {
          const v = await pre({ hook_event_name: "PreToolUse", tool_name: "mcp__foldrun_scripts__lookup", tool_input: { q: String(i) } });
          if (v.hookSpecificOutput?.permissionDecision === "deny") replies.push(v.hookSpecificOutput.permissionDecisionReason ?? "");
          else fs.appendFileSync(counterFile, "x");
        }
        yield { type: "result", subtype: "success", result: "done", total_cost_usd: 0 };
      })(), { async interrupt() {} });
    };
    const events: { type: string; text: string }[] = [];
    const out = await executeStep({
      agentDir, workspaceRoot: path.dirname(path.dirname(agentDir)), libraryRoot: "/nonexistent",
      prompt: "p", model: "haiku", systemPrompt: "s", allowed: ["mcp__foldrun_scripts__lookup"], mcpNames: [], mcpServers: {}, env: {},
      limits: { lookup: 3 }, toolOwners: { mcp__foldrun_scripts__lookup: "lookup" },
      emit: (type, text) => events.push({ type, text }),
    }, query);
    assert.equal(out.status, "completed");
    assert.equal(fs.readFileSync(counterFile, "utf8").length, 3, "the 4th and 5th calls never ran");
    assert.equal(replies.length, 2);
    assert.equal(replies[0], "limit reached: lookup 3 of 3 in this step — work with what you have, or say what more you would need");
    assert.equal(events.filter((e) => e.type === "info" && /^limit reached: lookup 3 of 3/.test(e.text)).length, 2, "each refusal is on the trace");
    assert.ok(events.some((e) => e.type === "info" && e.text === "limits: lookup 3/3 — 2 calls refused"), JSON.stringify(events));
  }));

test("a sub-agent's calls count toward the same step", () =>
  withAgent(async (agentDir) => {
    const decisions: (string | undefined)[] = [];
    const query: QueryFn = ({ options }) => {
      const pre = (options as { hooks: { PreToolUse: { hooks: Pre[] }[] } }).hooks.PreToolUse[0].hooks[0];
      return Object.assign((async function* () {
        // the step's own search, then the sub-agent's two
        for (const agent of [undefined, "a1", "a1"]) {
          const v = await pre({
            hook_event_name: "PreToolUse", tool_name: "mcp__foldrun_scripts__web", tool_input: { action: "search", query: "q" },
            ...(agent ? { agent_id: agent, agent_type: "researcher" } : {}),
          } as unknown as HookInput);
          decisions.push(v.hookSpecificOutput?.permissionDecision);
        }
        yield { type: "result", subtype: "success", result: "done", total_cost_usd: 0 };
      })(), { async interrupt() {} });
    };
    const events: { type: string; text: string; extra?: { subagent?: string } }[] = [];
    await executeStep({
      agentDir, workspaceRoot: path.dirname(path.dirname(agentDir)), libraryRoot: "/nonexistent",
      prompt: "p", model: "haiku", systemPrompt: "s", allowed: ["mcp__foldrun_scripts__web", "Agent"], mcpNames: [], mcpServers: {}, env: {},
      subagents: [{ name: "researcher", description: "reads", prompt: "r", tools: ["mcp__foldrun_scripts__web"], disallowedTools: [], model: "inherit" }],
      limits: { "web.search": 2 },
      emit: (type, text, extra) => events.push({ type, text, extra: extra as { subagent?: string } }),
    }, query);
    assert.deepEqual(decisions, [undefined, undefined, "deny"]);
    const refusal = events.find((e) => /^limit reached: web\.search 2 of 2/.test(e.text));
    assert.equal(refusal?.extra?.subagent, "researcher", "the refusal names the sub-agent that tried");
    assert.ok(events.some((e) => e.text === "limits: web.search 2/2 — 1 call refused"));
  }));

test("no limits: no counting, no summary line", () =>
  withAgent(async (agentDir) => {
    const query: QueryFn = ({ options }) => {
      const pre = (options as { hooks: { PreToolUse: { hooks: Pre[] }[] } }).hooks.PreToolUse[0].hooks[0];
      return Object.assign((async function* () {
        for (let i = 0; i < 3; i++) assert.deepEqual(await pre({ hook_event_name: "PreToolUse", tool_name: "mcp__x__y", tool_input: {} }), {});
        yield { type: "result", subtype: "success", result: "done", total_cost_usd: 0 };
      })(), { async interrupt() {} });
    };
    const events: string[] = [];
    await executeStep({
      agentDir, workspaceRoot: path.dirname(path.dirname(agentDir)), libraryRoot: "/nonexistent",
      prompt: "p", model: "haiku", systemPrompt: "s", allowed: [], mcpNames: ["x"], mcpServers: {}, env: {},
      emit: (_t, text) => events.push(text),
    }, query);
    assert.ok(!events.some((e) => /^limits:/.test(e)));
  }));
