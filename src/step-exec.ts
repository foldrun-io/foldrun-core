// The model loop, extracted to run in two places: the server process (the
// classic path) and the runner container's driver (the isolated path). One
// implementation, because the moment these fork, the sandboxed path becomes
// the less-tested one — backwards from its whole purpose.
//
// Everything here takes values, not stores: the caller resolves secrets,
// assembles the system prompt and builds MCP servers, then hands this the
// results. That is what lets the same function run somewhere the vault, the
// library and the account do not exist.

import fs from "node:fs";
import path from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { McpServerConfig } from "@anthropic-ai/claude-agent-sdk";
import { spawn } from "node:child_process";
import { checkPaths, checkBash, isFilesystemTool } from "./confine.ts";

export interface ExecOutcome {
  status: "completed" | "failed";
  result: string | null;
  costUsd: number | null;
}

export interface ExecOptions {
  agentDir: string;
  workspaceRoot: string;
  libraryRoot: string;
  prompt: string;
  model: string;
  systemPrompt: string;
  /** Exact SDK tool names the agent may use. */
  allowed: string[];
  /** MCP server names the agent was granted — tools from these pass. */
  mcpNames: string[];
  mcpServers: Record<string, McpServerConfig>;
  /** The child environment: process env + secrets + provider. */
  env: Record<string, string | undefined>;
  timeoutSec?: number;
  /** Shell command that must exit 0 for the step to count as done. */
  verify?: string;
  verifyEnv?: Record<string, string>;
  /** false when the caller is already an isolation boundary (a run
   *  container): the SDK's bash sandbox is then redundant and would block
   *  declared network use. Default (undefined/true) keeps it on. */
  sandboxBash?: boolean;
  emit: (type: "text" | "tool" | "info" | "error", text: string) => void;
}

export async function executeStep(opts: ExecOptions): Promise<ExecOutcome> {
  const { agentDir, workspaceRoot, libraryRoot, emit } = opts;
  let status: "running" | "completed" | "failed" = "running";
  let costUsd: number | null = null;
  const texts: string[] = [];

  fs.mkdirSync(path.join(agentDir, "outputs"), { recursive: true });
  fs.mkdirSync(path.join(agentDir, "memory"), { recursive: true });

  const q = query({
    prompt: opts.prompt,
    options: {
      cwd: agentDir,
      model: opts.model,
      systemPrompt: opts.systemPrompt,
      // Restrict the toolset itself, not just approval: an agent that
      // declares no tools gets none, instead of seeing the full Claude
      // Code toolset and burning turns on denied calls.
      tools: opts.allowed,
      // Deliberately NOT allowedTools: listing them there auto-approves and
      // skips canUseTool entirely, which is where confinement happens. The
      // toolset is still restricted by `tools` above.
      settingSources: [],
      // Sandbox the shell — but only when the shell would otherwise run in a
      // process worth protecting. In an isolated run the container IS the
      // boundary (non-root, cap-dropped, host-less, icc-disabled network),
      // so the SDK's own bash sandbox is redundant there and actively harms:
      // it blocks outbound network, which a declared SSH or curl step
      // legitimately needs. So the container relaxes it (opts.sandboxBash =
      // false) and the container's walls do the containing; the in-process
      // path (the CLI on someone's laptop, and the host executor) keeps it,
      // because there a shell escape reaches the real machine.
      sandbox: {
        enabled: opts.sandboxBash !== false,
        // Must stay false. Auto-allowing bash because it's sandboxed skips
        // canUseTool entirely — and the OS sandbox blocks writes outside the
        // tree but still permits reads, so `cat ../../secrets.json` walked
        // straight out. Verified by probe: true leaks, false denies.
        autoAllowBashIfSandboxed: false,
        failIfUnavailable: false,
      },
      env: opts.env,
      mcpServers: opts.mcpServers,
      canUseTool: async (toolName: string, input: Record<string, unknown>) => {
        // The toolset was already narrowed to what the agent declared, so
        // anything outside it is a denial with a reason the model can act on.
        const fromGrantedServer = opts.mcpNames.some((n) => toolName.startsWith(`mcp__${n}__`));
        if (!opts.allowed.includes(toolName) && !fromGrantedServer) {
          return {
            behavior: "deny" as const,
            message: `Tool ${toolName} is not enabled for this agent.`,
          };
        }
        const verdict =
          toolName === "Bash"
            ? checkBash(String(input.command ?? ""))
            : isFilesystemTool(toolName)
              ? checkPaths(toolName, input, { agentDir, workspaceRoot, libraryRoot })
              : { ok: true as const };
        if (!verdict.ok) {
          emit("error", verdict.reason!);
          return { behavior: "deny" as const, message: verdict.reason! };
        }
        return { behavior: "allow" as const, updatedInput: verdict.updatedInput ?? input };
      },
    },
  });

  const deadline = opts.timeoutSec ? Date.now() + opts.timeoutSec * 1000 : null;

  for await (const message of q) {
    if (deadline && Date.now() > deadline) {
      emit("error", `step exceeded its ${opts.timeoutSec}s timeout`);
      status = "failed";
      break;
    }
    if (message.type === "assistant") {
      for (const block of message.message.content) {
        if (block.type === "text" && block.text.trim()) {
          texts.push(block.text);
          emit("text", block.text);
        } else if (block.type === "tool_use") {
          emit("tool", block.name);
        }
      }
    } else if (message.type === "result") {
      status = message.subtype === "success" ? "completed" : "failed";
      costUsd = "total_cost_usd" in message ? (message.total_cost_usd ?? null) : null;
    }
  }
  // The SDK ends a healthy run with a `result` message. A stream that just
  // stops — subprocess OOM-killed, crashed, or torn down — used to fall
  // through as "completed", which reported a run that produced nothing as a
  // success. Silence is not success.
  if (status === "running") {
    status = "failed";
    emit(
      "error",
      "the model stream ended without a result — the model process likely died (out of memory?)",
    );
  }
  const result = texts.join("\n").trim() || null;

  // "Done" should mean a check passed, not that the model stopped talking.
  if (status === "completed" && opts.verify) {
    const { code, out } = await runVerify(agentDir, opts.verify, opts.verifyEnv ?? {});
    emit(code === 0 ? "info" : "error", `verify \`${opts.verify}\` → exit ${code ?? "error"}`);
    if (out.trim()) emit(code === 0 ? "info" : "error", out.slice(0, 1000));
    if (code !== 0) status = "failed";
  }

  return { status, result, costUsd };
}

// Verification runs in the agent's directory with its secrets available, so
// a check can be as simple as `npm run build` or `test -s outputs/report.md`.
function runVerify(
  agentDir: string,
  command: string,
  env: Record<string, string>,
): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const child = spawn("bash", ["-lc", command], {
      cwd: agentDir,
      env: { ...process.env, ...env },
      timeout: 120_000,
    });
    let out = "";
    const append = (c: Buffer) => {
      if (out.length < 4000) out += c.toString();
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    child.on("error", (e) => resolve({ code: null, out: e.message }));
    child.on("close", (code) => resolve({ code, out }));
  });
}
