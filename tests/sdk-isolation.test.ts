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

test("sdkEnv: the model process sends no telemetry, update checks or flag fetches (FOL-49)", () => {
  assert.equal(sdkEnv({ CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "" }).CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, "1");
  assert.equal(sdkEnv(undefined, { A: "b" }).CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, "1");
});

test("sdkEnv cannot be talked out of it: the step's env does not switch connectors back on", () => {
  assert.equal(sdkEnv({ ENABLE_CLAUDEAI_MCP_SERVERS: "true" }).ENABLE_CLAUDEAI_MCP_SERVERS, "false");
  assert.equal(sdkEnv(undefined).ENABLE_CLAUDEAI_MCP_SERVERS, "false");
});

test("sdkEnv: the model process publishes, schedules, syncs and installs nothing on its own (FOL-338)", () => {
  const e = sdkEnv({ CLAUDE_CODE_DISABLE_ARTIFACT: "0", CLAUDE_CODE_SYNC_SKILLS: "1" });
  assert.equal(e.CLAUDE_CODE_DISABLE_ARTIFACT, "1");
  assert.equal(e.CLAUDE_CODE_DISABLE_CRON, "1");
  assert.equal(e.CLAUDE_CODE_SYNC_SKILLS, "0");
  assert.equal(e.CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL, "1");
});

test("a secret named after anything the model process reads goes in under the declared prefix (FOL-338)", async () => {
  const { isModelEnvName } = await import("../src/model-credential.ts");
  for (const n of ["ANTHROPIC_BETAS", "ANTHROPIC_BEDROCK_BASE_URL", "CLAUDE_CODE_EXTRA_BODY", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_ENV_FILE", "CLAUDECODE", "OTEL_EXPORTER_OTLP_ENDPOINT", "OTEL_LOG_RAW_API_BODIES", "BETA_TRACING_ENDPOINT", "AWS_BEARER_TOKEN_BEDROCK", "MAX_THINKING_TOKENS", "DISABLE_PROMPT_CACHING_OPUS", "ANTHROPIC_API_KEY", "FOLDRUN_MODEL_KEY"]) assert.ok(isModelEnvName(n), n);
  for (const n of ["CRM_TOKEN", "GITHUB_TOKEN", "AWS_ACCESS_KEY_ID", "OPENAI_API_KEY", "MY_ANTHROPIC_KEY", "DISABLE_SOMETHING"]) assert.ok(!isModelEnvName(n), n);
});

test("declaredEnv: reserved names go under the prefix, a prefixed declaration keeps its own value, others pass (FOL-338, Codex)", async () => {
  const { declaredEnv } = await import("../src/model-credential.ts");
  assert.deepEqual(declaredEnv({ CRM: "c", CLAUDE_CODE_USE_VERTEX: "1", OTEL_SERVICE_NAME: "a", FOLDRUN_DECLARED_OTEL_SERVICE_NAME: "b" }), {
    CRM: "c", FOLDRUN_DECLARED_CLAUDE_CODE_USE_VERTEX: "1", FOLDRUN_DECLARED_OTEL_SERVICE_NAME: "b",
  });
  assert.deepEqual(declaredEnv({ HTTPS_PROXY: "x" }, (n) => n === "HTTPS_PROXY"), { FOLDRUN_DECLARED_HTTPS_PROXY: "x" });
});
