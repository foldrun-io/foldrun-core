// The tool loop's model session gets our tools and nothing else. The SDK
// does not document what tools: [] means, so this starts a real session
// with runToolLoop's own options (no model call: it stops at the session's
// init message) and fails the day an SDK upgrade lets a built-in back in.
//
//   node --test tests/tool-loop.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { foreignTools, loopSession, loopToolName, type LoopOptions } from "../src/tool-loop.ts";

const opts: LoopOptions = {
  system: "test",
  prompt: "hi",
  tools: [{ name: "search_docs", description: "search", args: { q: {} }, run: () => "x" }],
  model: "claude-haiku-5-5",
  // Nowhere to reach: the session must be judged before any model call.
  env: { ANTHROPIC_API_KEY: "sk-ant-test", ANTHROPIC_BASE_URL: "http://127.0.0.1:9" },
  maxTurns: 1,
  maxBudgetUsd: 0.01,
  maxOutputTokens: 100,
  wallSeconds: 30,
};

test("a session starts with our tools and our MCP server only", async () => {
  const abort = new AbortController();
  const { options, scratch } = loopSession(opts, abort);
  try {
    let init: { tools: string[]; mcp_servers: { name: string }[] } | null = null;
    for await (const m of query({ prompt: "hi", options })) {
      if (m.type === "system" && m.subtype === "init") {
        init = m;
        abort.abort();
        break;
      }
    }
    assert.ok(init, "no init message");
    assert.deepEqual(init.tools, [loopToolName("search_docs")]);
    assert.deepEqual(init.mcp_servers.map((s) => s.name), ["foldrun_tools"]);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

test("the hook refuses any tool not ours, and lets ours through", async () => {
  const { options, scratch } = loopSession(opts, new AbortController());
  fs.rmSync(scratch, { recursive: true, force: true });
  const hook = options.hooks!.PreToolUse![0].hooks[0];
  const call = (tool_name: string) =>
    hook({ hook_event_name: "PreToolUse", tool_name, tool_input: {}, tool_use_id: "t", session_id: "s", transcript_path: "", cwd: "" } as never, "t", { signal: new AbortController().signal });
  for (const t of ["Bash", "Read", "Agent", "WebFetch", "Skill", "mcp__other__x"]) {
    const out = (await call(t)) as { hookSpecificOutput?: { permissionDecision?: string } };
    assert.equal(out.hookSpecificOutput?.permissionDecision, "deny", t);
  }
  assert.deepEqual(await call(loopToolName("search_docs")), {});
});

test("a session with anything extra is named, so the loop refuses it", () => {
  const ours = new Set([loopToolName("search_docs")]);
  assert.deepEqual(foreignTools({ tools: [loopToolName("search_docs")], mcp_servers: [{ name: "foldrun_tools" }] }, ours), []);
  assert.deepEqual(foreignTools({ tools: [loopToolName("search_docs"), "Bash"], mcp_servers: [{ name: "foldrun_tools" }, { name: "github" }] }, ours), ["Bash", "github"]);
});

test("each session has its own home, config, memory and optional traffic off", () => {
  const { options, scratch } = loopSession(opts, new AbortController());
  try {
    const env = options.env!;
    assert.ok(env.HOME!.startsWith(scratch));
    assert.ok(env.CLAUDE_CONFIG_DIR!.startsWith(scratch));
    assert.ok(options.cwd!.startsWith(scratch));
    assert.equal(env.CLAUDE_CODE_DISABLE_AUTO_MEMORY, "1");
    assert.equal(env.ENABLE_CLAUDEAI_MCP_SERVERS, "false");
    assert.equal(env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, "1");
    assert.notEqual(env.HOME, process.env.HOME);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});
