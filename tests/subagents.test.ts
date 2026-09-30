// Sub-agents (`subagents:`): their own context and tools, never wider than
// the step that delegates, depth one, and the parent's checks on every call.
//
//   node --test tests/subagents.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { HookInput } from "@anthropic-ai/claude-agent-sdk";
import { subagentTools, toAgentDefinitions, subagentGuard, gatherSubagents, checkOverlap, type SubagentSpec } from "../src/subagents.ts";
import { executeStep, type ExecOptions, type QueryFn } from "../src/step-exec.ts";
import { buildSubagentSpecs, repriced } from "../src/runner.ts";
import { workspaceDir } from "../src/store.ts";

const researcher: SubagentSpec = {
  name: "researcher",
  description: "Reads sources and summarises them",
  prompt: "You research.",
  tools: ["Read", "Glob", "Grep"],
  disallowedTools: [],
  model: "inherit",
};

test("a sub-agent's tools are its own, cut to the parent's — never wider, never the delegate tool", () => {
  const own = ["Read", "Write", "Bash", "mcp__foldrun_scripts__post_check", "Agent", "Task", "mcp__crm__lookup"];
  const parent = ["Read", "Grep", "mcp__foldrun_scripts__post_check", "mcp__crm", "mcp__crm__*", "Agent"];
  assert.deepEqual(subagentTools(own, parent), ["Read", "mcp__foldrun_scripts__post_check", "mcp__crm__lookup"]);
  assert.deepEqual(subagentTools(["Write"], ["Read"]), [], "nothing the parent lacks");
});

test("every SDK definition carries an explicit tool list — an absent one would inherit everything", () => {
  const defs = toAgentDefinitions([{ ...researcher, tools: [] }, researcher]);
  assert.deepEqual(defs.researcher.tools, ["Read", "Glob", "Grep"]);
  for (const d of Object.values(defs)) {
    assert.ok(Array.isArray(d.tools), "tools is always an array");
    assert.ok(d.disallowedTools.includes("Agent") && d.disallowedTools.includes("Task"), "depth one");
  }
});

test("the guard: a sub-agent may not delegate, nor use a tool outside its list", () => {
  const guard = subagentGuard([researcher]);
  const sub = (tool: string, agentType: string | undefined = "researcher") => guard({ agentId: "a1", agentType, tool, input: {} });
  assert.match(sub("Agent") ?? "", /cannot start another/);
  assert.match(sub("Bash") ?? "", /not one of researcher's tools/);
  assert.equal(sub("Read"), null);
  assert.equal(guard({ tool: "Bash", input: {} }), null, "the main thread's own tools are canUseTool's business");
});

test("the guard: an agent this step did not declare is refused — the SDK's built-ins included", () => {
  const guard = subagentGuard([researcher]);
  // A call from inside a sub-agent nobody declared: general-purpose has every tool.
  assert.match(guard({ agentId: "a1", agentType: "general-purpose", tool: "Bash", input: {} }) ?? "", /general-purpose.*not declared/);
  assert.match(guard({ agentId: "a1", tool: "Read", input: {} }) ?? "", /not declared/, "no agent_type at all");
  // The delegation itself, from the main thread.
  const gp = guard({ tool: "Agent", input: { subagent_type: "general-purpose", prompt: "anything" } }) ?? "";
  assert.match(gp, /general-purpose/);
  assert.match(gp, /researcher/, "names the ones it may use");
  assert.match(guard({ tool: "Task", input: { prompt: "no type" } }) ?? "", /researcher/, "no subagent_type is not a pass");
  assert.equal(guard({ tool: "Agent", input: { subagent_type: "researcher", prompt: "read" } }), null);
});
test("check's overlap reads groups the way the runtime does", () => {
  assert.deepEqual(checkOverlap(["read", "web"], ["write"]).sort(), ["Glob", "Grep", "Read"]);
  assert.deepEqual(checkOverlap(["read"], ["code"]), []);
});

// ------------------------------------------------ executeStep, with a fake SDK

function withAgent(body: (agentDir: string) => Promise<void>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-sub-"));
  const agentDir = path.join(root, "agents", "lead");
  fs.mkdirSync(agentDir, { recursive: true });
  return body(agentDir).finally(() => fs.rmSync(root, { recursive: true, force: true }));
}

function execOpts(agentDir: string, events: { type: string; text: string; extra?: Record<string, unknown> }[]): ExecOptions {
  return {
    agentDir,
    workspaceRoot: path.dirname(path.dirname(agentDir)),
    libraryRoot: path.join(agentDir, "..", "..", "library"),
    prompt: "work",
    model: "haiku",
    systemPrompt: "you lead",
    allowed: ["Read", "Glob", "Grep", "Agent"],
    mcpNames: [],
    mcpServers: {},
    env: {},
    subagents: [researcher],
    emit: (type, text, extra) => events.push({ type, text, extra: extra as Record<string, unknown> | undefined }),
  };
}

type PreToolUse = (input: HookInput) => Promise<{ hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string; updatedInput?: Record<string, unknown> } }>;

test("the parent's hooks judge a sub-agent's calls: its list, and the same file confinement", () =>
  withAgent(async (agentDir) => {
    let seen: Record<string, unknown> = {};
    const query: QueryFn = ({ options }) => {
      seen = options;
      return Object.assign((async function* () {
        yield { type: "result", subtype: "success", total_cost_usd: 0 };
      })(), { async interrupt() {} });
    };
    const events: { type: string; text: string; extra?: Record<string, unknown> }[] = [];
    await executeStep(execOpts(agentDir, events), query);

    const agents = seen.agents as Record<string, { tools: string[] }>;
    assert.deepEqual(agents.researcher.tools, ["Read", "Glob", "Grep"], "the SDK is given the explicit list");

    const pre = (seen.hooks as { PreToolUse: { hooks: PreToolUse[] }[] }).PreToolUse[0].hooks[0];
    const fromSub = (tool: string, input: Record<string, unknown>) =>
      pre({ hook_event_name: "PreToolUse", tool_name: tool, tool_input: input, agent_id: "a1", agent_type: "researcher" } as unknown as HookInput);

    const bash = await fromSub("Bash", { command: "ls" });
    assert.equal(bash.hookSpecificOutput?.permissionDecision, "deny", "outside the sub-agent's list");
    const nest = await fromSub("Agent", { subagent_type: "researcher", prompt: "again" });
    const builtin = await pre({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "ls" }, agent_id: "a2", agent_type: "general-purpose" } as unknown as HookInput);
    assert.equal(builtin.hookSpecificOutput?.permissionDecision, "deny", "an undeclared sub-agent is not waved through");
    const toBuiltin = await pre({ hook_event_name: "PreToolUse", tool_name: "Agent", tool_input: { subagent_type: "general-purpose", prompt: "x" } } as unknown as HookInput);
    assert.equal(toBuiltin.hookSpecificOutput?.permissionDecision, "deny", "the main thread may delegate only to a declared one");
    assert.match(toBuiltin.hookSpecificOutput?.permissionDecisionReason ?? "", /researcher/);
    assert.equal((seen.env as Record<string, string>).CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS, "1", "the SDK's built-in agents are switched off");
    assert.equal(nest.hookSpecificOutput?.permissionDecision, "deny", "depth one");
    const escape = await fromSub("Read", { file_path: "/etc/passwd" });
    assert.equal(escape.hookSpecificOutput?.permissionDecision, "deny", "confine.ts applies to the sub-agent's reads");
    const ok = await fromSub("Read", { file_path: "../../knowledge/a.md" });
    assert.notEqual(ok.hookSpecificOutput?.permissionDecision, "deny", "an in-workspace read passes");
    assert.ok(events.some((e) => e.type === "error" && e.extra?.subagent === "researcher"), "the refusal is on the trace, labelled");
    // The path refusal itself names the sub-agent — not only its tool-list
    // refusal (live run-munqdvda-vurd showed /etc/passwd refused unlabelled).
    const passwd = events.filter((e) => e.type === "error" && /passwd|outside/i.test(e.text));
    assert.ok(passwd.length, "the /etc/passwd refusal is on the trace");
    assert.ok(passwd.every((e) => e.extra?.subagent === "researcher"), "and it says which agent tried");
    // canUseTool sees only the id; the name the hook saw is carried over.
    const can = seen.canUseTool as (t: string, i: Record<string, unknown>, o?: { agentID?: string }) => Promise<{ behavior: string }>;
    const before = events.length;
    const viaCan = await can("Read", { file_path: "/etc/shadow" }, { agentID: "a1" });
    assert.equal(viaCan.behavior, "deny");
    assert.equal(events.slice(before).find((e) => e.type === "error")?.extra?.subagent, "researcher", "canUseTool's refusal is labelled too");
    const main = await can("Read", { file_path: "/etc/shadow" });
    assert.equal(main.behavior, "deny");
    assert.equal(events.at(-1)?.extra?.subagent, undefined, "the main thread's refusal is not labelled as a sub-agent's");
  }));

test("a sub-agent's tool calls are labelled with its name; its words are not the step's result", () =>
  withAgent(async (agentDir) => {
    const query: QueryFn = () =>
      Object.assign((async function* () {
        yield { type: "assistant", message: { id: "m1", usage: { input_tokens: 5, output_tokens: 5 }, content: [
          { type: "tool_use", id: "call-agent", name: "Agent", input: { subagent_type: "researcher", prompt: "read two files" } },
        ] }, parent_tool_use_id: null };
        yield { type: "assistant", message: { id: "m2", usage: { input_tokens: 5, output_tokens: 5 }, content: [
          { type: "text", text: "sub-agent thinking aloud" },
          { type: "tool_use", id: "call-read", name: "Read", input: { file_path: "a.md" } },
        ] }, parent_tool_use_id: "call-agent" };
        yield { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "call-read", content: "A" }] }, parent_tool_use_id: "call-agent" };
        yield { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "call-agent", content: "summary" }] }, parent_tool_use_id: null };
        yield { type: "assistant", message: { id: "m3", usage: { input_tokens: 5, output_tokens: 5 }, content: [{ type: "text", text: "Both files agree." }] }, parent_tool_use_id: null };
        yield { type: "result", subtype: "success", total_cost_usd: 0.01, usage: { input_tokens: 15, output_tokens: 15 } };
      })(), { async interrupt() {} });
    const events: { type: string; text: string; extra?: Record<string, unknown> }[] = [];
    const out = await executeStep(execOpts(agentDir, events), query);
    const read = events.filter((e) => e.type === "tool" && e.text === "Read");
    assert.equal(read.length, 2, "call and completion");
    assert.ok(read.every((e) => e.extra?.subagent === "researcher"));
    const agent = events.filter((e) => e.type === "tool" && e.text === "Agent");
    assert.ok(agent.every((e) => e.extra?.subagent === undefined), "the delegation itself is the parent's");
    assert.ok(!events.some((e) => e.type === "text" && e.text.includes("thinking aloud")));
    assert.equal(out.result, "Both files agree.");
    assert.equal(out.costUsd, 0.01, "cost once, from the result");
  }));

test("no subagents: no agents option and no Agent tool — the step is what it was", () =>
  withAgent(async (agentDir) => {
    let seen: Record<string, unknown> = {};
    const query: QueryFn = ({ options }) => {
      seen = options;
      return Object.assign((async function* () {
        yield { type: "result", subtype: "success" };
      })(), { async interrupt() {} });
    };
    await executeStep({ ...execOpts(agentDir, []), subagents: undefined, allowed: ["Read"] }, query);
    assert.equal(seen.agents, undefined);
  }));

test("a person's message reaches the step's own model, never a sub-agent's context", () =>
  withAgent(async (agentDir) => {
    let seen: Record<string, unknown> = {};
    const query: QueryFn = ({ options }) => {
      seen = options;
      return Object.assign((async function* () {
        yield { type: "result", subtype: "success" };
      })(), { async interrupt() {} });
    };
    let drained = 0;
    await executeStep({ ...execOpts(agentDir, []), inbox: async () => (drained++, "stop after the second file") }, query);
    type Post = (input: HookInput) => Promise<{ hookSpecificOutput?: { additionalContext?: string } }>;
    const post = (seen.hooks as { PostToolUse: { hooks: Post[] }[] }).PostToolUse[0].hooks[0];
    const fromSub = await post({ hook_event_name: "PostToolUse", tool_name: "Read", tool_input: {}, tool_response: "", agent_id: "a1", agent_type: "researcher" } as unknown as HookInput);
    assert.deepEqual(fromSub, {}, "nothing handed to the sub-agent");
    assert.equal(drained, 0, "and the inbox is left for the parent");
    const fromMain = await post({ hook_event_name: "PostToolUse", tool_name: "Read", tool_input: {}, tool_response: "" } as unknown as HookInput);
    assert.equal(fromMain.hookSpecificOutput?.additionalContext, "stop after the second file");
  }));

/** A fast parent that delegates to a max sub-agent; no closing result. */
function mixedQuery(subModel: string | undefined): QueryFn {
  return () => Object.assign((async function* () {
    yield { type: "assistant", message: { id: "m1", model: "claude-haiku-4-5", usage: { input_tokens: 1000, output_tokens: 1000 }, content: [
      { type: "tool_use", id: "call-agent", name: "Agent", input: { subagent_type: "researcher", prompt: "dig" } },
    ] }, parent_tool_use_id: null };
    yield { type: "assistant", message: { id: "m2", ...(subModel ? { model: subModel } : {}), usage: { input_tokens: 0, output_tokens: 100_000 }, content: [
      { type: "text", text: "digging" },
    ] }, parent_tool_use_id: "call-agent" };
  })(), { async interrupt() {} });
}
const HAIKU = { input: 1e-6, output: 5e-6 };
const maxResearcher: SubagentSpec = { ...researcher, model: "opus" };

test("a sub-agent's turns are priced at its own model — the bill", () =>
  withAgent(async (agentDir) => {
    for (const subModel of ["claude-opus-4-8", undefined]) {
      const out = await executeStep({ ...execOpts(agentDir, []), subagents: [maxResearcher], price: HAIKU }, mixedQuery(subModel));
      // parent: 1000 in + 1000 out at haiku; sub-agent: 100k out at opus ($25/MTok).
      const want = 1000 * 1e-6 + 1000 * 5e-6 + 100_000 * 25e-6;
      assert.ok(Math.abs((out.costUsd ?? 0) - want) < 1e-9, `${subModel ?? "no model field"}: ${out.costUsd} vs ${want}`);
      assert.ok(Math.abs((out.turnsCostUsd ?? 0) - want) < 1e-9, "the per-turn total rides out for the runner's repricing");
    }
  }));

test("a sub-agent's turns are priced at its own model — the live ceiling", () =>
  withAgent(async (agentDir) => {
    const events: { type: string; text: string }[] = [];
    // At haiku rates the sub-agent's turn is $0.50 — under $1. At opus it is $2.50.
    await executeStep({ ...execOpts(agentDir, events), subagents: [maxResearcher], price: HAIKU, budgetUsd: 1 }, mixedQuery("claude-opus-4-8"));
    assert.ok(events.some((e) => e.type === "error" && /over budget/.test(e.text)), "stopped at the ceiling");
  }));

test("the runner reprices a mixed-model step from its turns, not all at the parent's catalogue rate", () => {
  const catalog = { baseUrl: "x", fetchedAt: "", models: [{ id: "cheap", name: "cheap", contextLength: null, promptPrice: 1e-6, completionPrice: 1e-6, tools: true, reasoning: null }] };
  const usage = { inputTokens: 1000, outputTokens: 101_000 };
  assert.equal(repriced(catalog as never, "cheap", usage, 3, () => {}, 2.506), 2.506);
  assert.ok(Math.abs(repriced(catalog as never, "cheap", usage, 3, () => {})! - 0.102) < 1e-9, "one model: the catalogue as before");
});

// --------------------------------------------- built from the files, host-side

test("buildSubagentSpecs: resolved from agent.md, cut to the parent, with every refusal on the step", () => {
  const ws = workspaceDir("default", `sub-ws-${process.pid}`);
  const agent = (name: string, front: string, body = "You work.") => {
    fs.mkdirSync(path.join(ws, "agents", name), { recursive: true });
    fs.writeFileSync(path.join(ws, "agents", name, "agent.md"), `---\nname: ${name}\n${front}---\n\n${body}\n`);
  };
  try {
    agent("lead", "tools: [read, write]\nsubagents: [researcher, silent, nothing, lead, ghost]\n");
    agent("researcher", "description: Reads sources\ntools: [read, code]\nmodel: fast\n", "You research.");
    agent("silent", "tools: [read]\n");
    agent("nothing", "description: Only shells\ntools: [code]\n");
    const lines: string[] = [];
    const specs = buildSubagentSpecs({
      names: ["researcher", "silent", "nothing", "lead", "ghost"],
      self: "lead",
      workspaceRoot: ws,
      tenant: "default",
      parentAllowed: ["Read", "Glob", "Grep", "Write", "Edit"],
      push: (type, text) => lines.push(`${type}: ${text}`),
    });
    const r = specs.find((s) => s.name === "researcher")!;
    assert.deepEqual(r.tools.sort(), ["Glob", "Grep", "Read"], "code (Bash) dropped: the parent does not hold it");
    assert.equal(r.model, "haiku");
    assert.match(r.prompt, /You research\./);
    assert.match(r.prompt, /agents\/lead\//, "told it works in the parent's directory");
    assert.ok(lines.some((l) => /"ghost" is not an agent/.test(l)));
    assert.ok(lines.some((l) => /"silent" has no description/.test(l)));
    assert.ok(lines.some((l) => /"lead" is this agent itself/.test(l)));
    assert.ok(lines.some((l) => /"nothing" holds none of its tools/.test(l)));
    assert.equal(specs.find((s) => s.name === "nothing")?.tools.length, 0, "kept, but with an explicit empty list");
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test("gatherSubagents reports names that are not agents", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-gather-"));
  fs.mkdirSync(path.join(root, "agents", "a"), { recursive: true });
  fs.writeFileSync(path.join(root, "agents", "a", "agent.md"), "---\nname: a\n---\n");
  const { found, missing } = gatherSubagents(root, ["a", "b", "../x"]);
  assert.deepEqual(found.map((f) => f.name), ["a"]);
  assert.deepEqual(missing, ["b", "../x"]);
  fs.rmSync(root, { recursive: true, force: true });
});
