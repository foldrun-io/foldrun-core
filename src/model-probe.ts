// "Can this model hold a tool loop?" — answered by running one, not by
// reading a spec sheet.
//
// The catalogue's `tools` flag is the gateway's claim; this is the ground
// truth. The probe hands the model exactly one tool, whose result is a nonce
// invented per run, and asks it to call the tool and repeat the nonce back.
// A model that can drive an agent loop does this in two turns. A model that
// cannot — no tool support, tool calls narrated as prose, a gateway route
// that strips tool blocks — has no other way to learn the nonce, so the
// verdict cannot be faked by a model that merely talks about calling tools.
// That distinction is the entire reason the probe exists: it is the same
// failure the run-start gate guards against, demonstrated live through
// whatever provider env the caller passes.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { executeStep } from "./step-exec.ts";
import type { Effort } from "./store.ts";

export interface ProbeReport {
  model: string;
  /** The model made a real tool call — the handler ran. */
  calledTool: boolean;
  /** The nonce came back in the reply: the loop closed end to end. */
  echoedNonce: boolean;
  /** calledTool && echoedNonce — what "can drive an agent" actually means. */
  ok: boolean;
  status: "completed" | "failed";
  costUsd: number | null;
  durationMs: number;
  /** The reply itself, for the human reading a failure. */
  reply: string | null;
}

const PROBE_TIMEOUT_SEC = 120;

/**
 * Run the tool-loop probe against one model, through whatever endpoint the
 * env points at — pass the same env a step would get (provider base URL,
 * token, tier remaps) and the probe exercises the exact path a run takes.
 */
export async function probeModel(
  model: string,
  env: Record<string, string | undefined>,
  effort: Effort | null = null,
): Promise<ProbeReport> {
  const nonce = `probe-${randomBytes(6).toString("hex")}`;
  let calledTool = false;

  const probeTool = tool(
    "probe_fetch_token",
    "Returns a secret token. Call it exactly once.",
    {
      // One required argument, because a loop that can't pass arguments
      // can't run real tools either — echoing a fixed call is the easiest
      // possible tool use, and we deliberately don't test the easiest.
      purpose: z.string().describe("Why you are fetching the token, in a few words"),
    },
    async () => {
      calledTool = true;
      return { content: [{ type: "text" as const, text: nonce }] };
    },
  );

  // Homeless on purpose, like a consult: the probe reads and writes nothing,
  // and a throwaway cwd means even a confused model call has no tree to touch.
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-probe-"));
  const started = Date.now();
  try {
    const outcome = await executeStep({
      agentDir: scratch,
      workspaceRoot: scratch,
      libraryRoot: scratch,
      prompt:
        "Call the probe_fetch_token tool once, then reply with exactly the token it " +
        "returns and nothing else. If you cannot call tools, reply CANNOT.",
      model,
      effort,
      systemPrompt:
        "You are a connectivity probe. Follow the instruction literally. Do not explain.",
      allowed: [],
      mcpNames: ["foldrun_probe"],
      mcpServers: {
        foldrun_probe: createSdkMcpServer({
          name: "foldrun_probe",
          version: "1.0.0",
          tools: [probeTool],
        }),
      },
      env,
      timeoutSec: PROBE_TIMEOUT_SEC,
      emit: () => {}, // the probe's transcript is the report, not a run log
    });
    const echoedNonce = (outcome.result ?? "").includes(nonce);
    return {
      model,
      calledTool,
      echoedNonce,
      ok: calledTool && echoedNonce,
      status: outcome.status,
      costUsd: outcome.costUsd,
      durationMs: Date.now() - started,
      reply: outcome.result,
    };
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}
