// A model with tools that live in this process, and nothing else.
//
// What the platform's assistant needs (and what the eval judge and the flow
// draft are a toolless special case of): one Agent SDK query whose ONLY
// tools are the ones the caller passes — no built-in tool, no file system,
// no shell, no sub-agent, no MCP server the machine happens to have — run in
// a throwaway directory, inside a turn, dollar and wall-clock ceiling.
//
// The tools run here, in the caller's process, so whatever they read they
// read with the caller's own scoping; the model only ever sees what a tool
// returns. That is why this needs no sandbox pod: nothing the model asks for
// is executed as code.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { query, createSdkMcpServer, tool, type Options } from "@anthropic-ai/claude-agent-sdk";
import { hostSafeEnv } from "./host-env.ts";

/** One string argument: what it means, whether it may be left out, how long it may be. */
export interface LoopArg {
  description?: string;
  optional?: boolean;
  max?: number;
}

export interface LoopTool {
  name: string;
  description: string;
  args: Record<string, LoopArg>;
  /** The answer the model reads. A throw becomes an error result, not a crash. */
  run: (args: Record<string, string | undefined>) => Promise<string> | string;
}

export interface LoopUsage {
  /** Everything sent, cache reads and writes included; the two cache
   *  fields say how much of it the prompt cache served or stored. */
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
}

export interface LoopResult {
  /** The last turn's text — the answer, not the thinking aloud between tool calls. */
  text: string;
  /** What the SDK reports the query cost; 0 when it never reported (killed). */
  costUsd: number;
  usage: LoopUsage | null;
  /** Why it ended, when it did not end well: max turns, budget, wall clock. */
  stopped: string | null;
}

export interface LoopOptions {
  system: string;
  prompt: string;
  tools: LoopTool[];
  model: string;
  /** The model credential and anything else the SDK process needs. */
  env: Record<string, string | undefined>;
  maxTurns: number;
  maxBudgetUsd: number;
  maxOutputTokens: number;
  wallSeconds: number;
  /** The reply as it is written, for a live view. */
  onText?: (delta: string) => void;
}

const SERVER = "foldrun_tools";

/** The Agent SDK's name for one of our tools. */
export const loopToolName = (name: string) => `mcp__${SERVER}__${name}`;

function schemaOf(args: Record<string, LoopArg>): z.ZodRawShape {
  return Object.fromEntries(
    Object.entries(args).map(([name, a]) => {
      let s = z.string().min(a.optional ? 0 : 1);
      if (a.max) s = s.max(a.max);
      if (a.description) s = s.describe(a.description);
      return [name, a.optional ? s.optional() : s];
    }),
  );
}

/** What a session was started with that we did not give it: any tool or MCP server not ours. */
export function foreignTools(init: { tools: string[]; mcp_servers: { name: string }[] }, ours: Set<string>): string[] {
  return [...init.tools.filter((t) => !ours.has(t)), ...init.mcp_servers.map((m) => m.name).filter((n) => n !== SERVER)];
}

/**
 * The query's options, and the throwaway directory they run in (the caller
 * removes it). Apart from runToolLoop so a test can start a session with
 * exactly these and read what it was given.
 */
export function loopSession(o: LoopOptions, abort: AbortController): { options: Options; ours: Set<string>; scratch: string } {
  const server = createSdkMcpServer({
    name: SERVER,
    version: "1.0.0",
    tools: o.tools.map((t) =>
      tool(t.name, t.description, schemaOf(t.args), async (args: Record<string, unknown>) => {
        try {
          const plain = Object.fromEntries(Object.entries(args).map(([k, v]) => [k, v === undefined ? undefined : String(v)]));
          return { content: [{ type: "text" as const, text: await t.run(plain) }] };
        } catch (err) {
          return { content: [{ type: "text" as const, text: `error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
        }
      }),
    ),
  });
  // Homeless on purpose: there are no file tools, and a throwaway cwd means
  // even a confused call has no tree to touch. Its own home too: the CLI
  // reads ~/.claude.json and auto memory whatever settingSources says, so
  // one reply must never find another's.
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-loop-"));
  const home = path.join(scratch, "home");
  const work = path.join(scratch, "work");
  fs.mkdirSync(home);
  fs.mkdirSync(work);
  const ours = new Set(o.tools.map((t) => loopToolName(t.name)));
  const options: Options = {
    model: o.model,
    systemPrompt: o.system,
    // No built-in tool at all (no Task, so no sub-agents either) — only
    // ours, each pre-approved; anything else is refused unasked.
    tools: [],
    mcpServers: { [SERVER]: server },
    strictMcpConfig: true,
    allowedTools: [...ours],
    permissionMode: "dontAsk",
    settingSources: [],
    persistSession: false,
    maxTurns: o.maxTurns,
    maxBudgetUsd: o.maxBudgetUsd,
    includePartialMessages: true,
    cwd: work,
    abortController: abort,
    // tools: [] is what keeps the built-ins out, and the SDK does not
    // document it; a hook runs before every other permission step, so
    // anything not ours is refused even if a later SDK lets it back in.
    hooks: {
      PreToolUse: [
        {
          hooks: [
            async (input) => {
              const name = "tool_name" in input ? String(input.tool_name) : "";
              if (ours.has(name)) return {};
              return {
                hookSpecificOutput: {
                  hookEventName: "PreToolUse" as const,
                  permissionDecision: "deny" as const,
                  permissionDecisionReason: `${name} is not one of this assistant's tools`,
                },
              };
            },
          ],
        },
      ],
    },
    env: {
      ...hostSafeEnv(),
      ...o.env,
      HOME: home,
      CLAUDE_CONFIG_DIR: path.join(home, ".claude"),
      CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
      ENABLE_CLAUDEAI_MCP_SERVERS: "false",
      // Telemetry, update checks, feature flags: none of it is the reply, and
      // where the network allows only the model API it would hang on a
      // blocked host.
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(o.maxOutputTokens),
    },
  };
  return { options, ours, scratch };
}

export async function runToolLoop(o: LoopOptions): Promise<LoopResult> {
  const abort = new AbortController();
  const { options, ours, scratch } = loopSession(o, abort);
  let refused: string | null = null;
  let killed = false;
  const watchdog = setTimeout(() => {
    killed = true;
    abort.abort();
  }, o.wallSeconds * 1000);
  watchdog.unref?.();

  let text = "";
  let costUsd = 0;
  let usage: LoopUsage | null = null;
  let stopped: string | null = null;
  try {
    const q = query({ prompt: o.prompt, options });
    let turn = "";
    for await (const message of q) {
      // Fail closed: a session that starts with any tool or MCP server we did
      // not give it never reaches the model.
      if (message.type === "system" && message.subtype === "init") {
        const extra = foreignTools(message, ours);
        if (extra.length) {
          refused = `the model session started with tools it must not have: ${extra.join(", ")}`;
          abort.abort();
          break;
        }
        continue;
      }
      if (message.type === "stream_event") {
        const e = message.event;
        if (e.type === "message_start") turn = "";
        if (e.type === "content_block_delta" && e.delta.type === "text_delta") {
          turn += e.delta.text;
          o.onText?.(e.delta.text);
        }
      } else if (message.type === "assistant") {
        const said = message.message.content
          .filter((b) => b.type === "text")
          .map((b) => (b as { text: string }).text)
          .join("");
        if (said.trim()) text = said;
      } else if (message.type === "result") {
        costUsd = message.total_cost_usd ?? 0;
        const models = Object.values(message.modelUsage ?? {});
        usage = {
          inputTokens: models.reduce((n, m) => n + (m.inputTokens ?? 0) + (m.cacheReadInputTokens ?? 0) + (m.cacheCreationInputTokens ?? 0), 0),
          outputTokens: models.reduce((n, m) => n + (m.outputTokens ?? 0), 0),
          cacheReadTokens: models.reduce((n, m) => n + (m.cacheReadInputTokens ?? 0), 0),
          cacheWriteTokens: models.reduce((n, m) => n + (m.cacheCreationInputTokens ?? 0), 0),
          costUsd,
        };
        if (message.subtype === "success") {
          if (message.result?.trim()) text = message.result;
        } else {
          stopped = message.subtype;
          if (!text) text = turn;
        }
      }
    }
  } catch (err) {
    if (!killed) throw err;
  } finally {
    clearTimeout(watchdog);
    fs.rmSync(scratch, { recursive: true, force: true });
  }
  if (refused) throw new Error(refused);
  if (killed) stopped = `ran past ${o.wallSeconds}s`;
  return { text, costUsd, usage, stopped };
}
