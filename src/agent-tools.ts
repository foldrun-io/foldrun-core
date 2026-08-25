// Agent-as-tool: consult a colleague without ending your turn.
//
//   agents: [researcher]        # in agent.md frontmatter
//
// gives the agent one tool per named colleague — consult_researcher(question)
// — that runs that agent's persona as a one-shot, toolless model call and
// returns its answer inline. "Toolless" is the design, not a shortcut: a
// consult is asking a specialist what they think, and a consultant who could
// edit files or call APIs mid-question would be the supervisor pattern the
// spec rejects, wearing a different hat. Depth is structurally one — the
// callee is built without an agents server of its own.
//
// The flow file still owns the orchestration: who may be consulted is
// declared per agent, cost lands on the consulting step, and nothing about
// what runs next is decided by a model.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import matter from "gray-matter";
import { z } from "zod";
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { resolveModel } from "./store.ts";
import { executeStep } from "./step-exec.ts";

export interface ConsultSpec {
  name: string;
  systemPrompt: string;
  model: string;
}

const CONSULT_TIMEOUT_SEC = 300;

/**
 * Read the consultable colleagues' personas, host-side. Names that don't
 * resolve to an agent are reported, not silently dropped.
 */
export function gatherConsults(
  workspaceRoot: string,
  names: unknown,
): { consults: ConsultSpec[]; missing: string[] } {
  const list = Array.isArray(names) ? names.map(String) : [];
  const consults: ConsultSpec[] = [];
  const missing: string[] = [];
  for (const name of list) {
    const file = path.join(workspaceRoot, "agents", name, "agent.md");
    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name) || !fs.existsSync(file)) {
      missing.push(name);
      continue;
    }
    const parsed = matter(fs.readFileSync(file, "utf8"));
    consults.push({
      name,
      systemPrompt:
        `${parsed.content.trim()}\n\n` +
        `You are being consulted by another agent mid-task. Answer the question ` +
        `directly and completely in your reply — you have no tools and no files; ` +
        `everything you know is in this prompt and the question.`,
      model: resolveModel((parsed.data as { model?: string }).model),
    });
  }
  return { consults, missing };
}

export interface ConsultToolResult {
  /** Passed to the SDK as an in-process MCP server (the agent just sees tools). */
  server: ReturnType<typeof createSdkMcpServer> | null;
  toolNames: string[];
  /** Model spend by the consults so far — the caller adds it to its step. */
  drainCost: () => number;
}

/**
 * The MCP server carrying one consult_<name> tool per colleague. Works in
 * both homes — the server process and the runner container — because it
 * takes values, not stores.
 */
export function buildConsultTools(
  consults: ConsultSpec[],
  env: Record<string, string | undefined>,
  emit: (type: "info" | "error", text: string) => void,
): ConsultToolResult {
  if (consults.length === 0) return { server: null, toolNames: [], drainCost: () => 0 };
  let cost = 0;

  const tools = consults.map((c) =>
    tool(
      `consult_${c.name.replaceAll("-", "_")}`,
      `Ask ${c.name} — a colleague agent — one question and get their answer inline. ` +
        `They see only your question, not your files or conversation; include everything they need in it.`,
      { question: z.string().describe("The complete, self-contained question") },
      async (args) => {
        const started = Date.now();
        // Toolless and homeless on purpose: the consult reads and writes
        // nothing — cwd is a throwaway so even a confused model call has no
        // tree to touch (and no tools to touch it with).
        const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "mdagent-consult-"));
        try {
          const outcome = await executeStep({
            agentDir: scratch,
            workspaceRoot: scratch,
            libraryRoot: scratch,
            prompt: args.question,
            model: c.model,
            systemPrompt: c.systemPrompt,
            allowed: [],
            mcpNames: [],
            mcpServers: {},
            env,
            timeoutSec: CONSULT_TIMEOUT_SEC,
            emit: () => {}, // the consult's inner monologue stays its own
          });
          cost += outcome.costUsd ?? 0;
          emit(
            "info",
            `consult ${c.name} → ${outcome.status} ($${(outcome.costUsd ?? 0).toFixed(4)}, ${Date.now() - started}ms)`,
          );
          return {
            content: [{ type: "text" as const, text: outcome.result ?? "(no answer)" }],
            isError: outcome.status === "failed",
          };
        } finally {
          fs.rmSync(scratch, { recursive: true, force: true });
        }
      },
    ),
  );

  return {
    server: createSdkMcpServer({ name: "mdagent_agents", version: "1.0.0", tools }),
    toolNames: consults.map((c) => `mcp__mdagent_agents__consult_${c.name.replaceAll("-", "_")}`),
    drainCost: () => cost,
  };
}
