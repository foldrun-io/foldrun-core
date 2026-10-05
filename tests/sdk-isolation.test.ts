// An agent gets the tools foldrun grants it and nothing of the person whose
// machine it runs on. A local run handed every agent the signed-in claude.ai
// account's connectors: the hello template's agents had only "the Claude
// Docs ones", no file tools, and wrote nothing.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { executeStep, sdkEnv, type QueryFn } from "../src/step-exec.ts";

test("a step's SDK session loads no claude.ai connectors and no on-disk MCP config", async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-iso-")));
  const agentDir = path.join(root, "agents", "a");
  fs.mkdirSync(agentDir, { recursive: true });
  let seen: Record<string, unknown> | null = null;
  const query: QueryFn = ({ options }) => {
    seen = options as Record<string, unknown>;
    return Object.assign((async function* () {
      yield { type: "result", subtype: "success", result: "done", total_cost_usd: 0 };
    })(), { async interrupt() {} });
  };
  try {
    await executeStep({
      agentDir, workspaceRoot: root, libraryRoot: "/nonexistent",
      prompt: "p", model: "haiku", systemPrompt: "s", allowed: ["Read"], mcpNames: [], mcpServers: {}, env: { KEEP: "1" },
      emit: () => {},
    }, query);
    assert.ok(seen, "the query ran");
    const opts = seen as unknown as { strictMcpConfig?: boolean; env?: Record<string, string>; settingSources?: unknown[]; permissionMode?: string };
    assert.equal(opts.strictMcpConfig, true);
    // Never the SDK's choice: unset, it ran auto mode and its classifier
    // refused a granted script before canUseTool saw it.
    assert.equal(opts.permissionMode, "default");
    assert.equal(opts.env?.ENABLE_CLAUDEAI_MCP_SERVERS, "false");
    assert.equal(opts.env?.KEEP, "1", "the step's own env is kept");
    assert.deepEqual(opts.settingSources, []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("sdkEnv cannot be talked out of it: the step's env does not switch connectors back on", () => {
  assert.equal(sdkEnv({ ENABLE_CLAUDEAI_MCP_SERVERS: "true" }).ENABLE_CLAUDEAI_MCP_SERVERS, "false");
  assert.equal(sdkEnv(undefined).ENABLE_CLAUDEAI_MCP_SERVERS, "false");
});
