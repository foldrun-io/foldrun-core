// tools: [debate, review] in a cloud step (FOL-444) — a second opinion from a
// model of another provider (`second_model:`), while the step works on its own.
//
// In `foldrun code` these are foldrun's server tools, declared on the request
// (FOL-418). A cloud step runs on the Agent SDK, which cannot declare them, so
// here they are tools in the sandbox that go out through the one live door a
// run pod has: the worker's egress proxy, at the lease address the pod holds
// (FOLDRUN_EGRESS = http://<proxy>/e/<lease>). The proxy answers the door only
// for a lease the runner granted `secondModel` — the tools and the model the
// agent file names — and bills the call to the run's step on the account's
// meter. Only the step's own agent is given the tools: a consult, a judge, or
// a sub-agent that does not list them has nothing to call.
//
//   POST {base}/second/{token}
//   body: {tool: "debate" | "review", input, max_tokens?, max_usd?}
//   200:  {tool, model, text, usage, cost_usd, review?}   4xx/5xx: {error, message}
//
// What leaves is the tool's input alone — never the conversation. A review may
// name files in the sandbox (`diff_path`, `paths`) instead of writing them out
// as tokens; they are read here, under the file tools' own confinement.
//
// `max_usd` is what the step's budget has left (SideSpend.left): the door
// refuses a call whose worst case is more, before anything is sent. What a
// call cost is added to the step's spend against its ceiling (SideSpend.usd).
// It is not added to the step's own cost: the door has metered it already.

import fs from "node:fs";
import path from "node:path";
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { checkPaths, expandVirtual, type Roots } from "./confine.ts";
import { operatorEndpoint } from "./operator.ts";
import type { EventExtra } from "./step-exec.ts";

export const SECOND_SERVER = "foldrun_second";
/** The granted names, by tools: entry. */
export const SECOND_TOOL_NAMES = { debate: `mcp__${SECOND_SERVER}__debate`, review: `mcp__${SECOND_SERVER}__review` } as const;
/** The longest one call is given: the second model writes up to 16k tokens. */
export const SECOND_TIMEOUT_MS = 5 * 60_000;
/** The most text read from the sandbox for one review (the door's own limit, server-tools REVIEW_INPUT_MAX). */
export const SECOND_REVIEW_MAX_CHARS = 200_000;

/** The step's spend beside its own turns: what the second model's calls cost
 *  (`usd`, added as each comes back), and what its budget has left (`left`,
 *  set by executeStep once the ceiling is known; null when there is none). */
export interface SideSpend {
  usd: number;
  left?: () => number | null;
}

type Emit = (type: "text" | "tool" | "info" | "error", text: string, extra?: EventExtra) => void;

/** The prompt's lines for the tools granted. */
export function secondPromptLine(tools: readonly ("debate" | "review")[], model: string): string {
  const lines = [`A model of another provider, ${model}, gives a second opinion. It sees only what you send it, never this conversation; each call is a paid model call.`];
  if (tools.includes("debate")) lines.push("- **debate(topic, position?, context?)** — it tests your position on a question and says where it is wrong. Use it on a decision worth a second look, not on every step.");
  if (tools.includes("review")) {
    lines.push(
      "- **review(diff | diff_path, paths?, instructions?)** — it reviews a change and lists findings by file and line. Write the diff to a file in your folder (`git diff > outputs/change.diff`) and pass `diff_path: outputs/change.diff`, rather than pasting it; `paths` adds whole files for context.",
    );
  }
  return lines.join("\n");
}

/** The `debate` and `review` tools. `egress` is the step's FOLDRUN_EGRESS
 *  (null in process: the tools then refuse); the roots confine which files a
 *  review may read. `fetchImpl` is for tests. */
export function buildSecondTools(opts: {
  egress: string | null | undefined;
  tools: readonly ("debate" | "review")[];
  model: string;
  agentDir: string;
  workspaceRoot: string;
  libraryRoot: string;
  spend: SideSpend;
  emit?: Emit;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}) {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const roots: Roots = { agentDir: opts.agentDir, workspaceRoot: opts.workspaceRoot, libraryRoot: opts.libraryRoot };
  const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });
  const fail = (t: string) => ({ ...text(t), isError: true });

  /** A file the review may read, or why not: the file tools' own rule. */
  const readFile = (raw: string, label: string): { content: string } | { error: string } => {
    const verdict = checkPaths("Read", { file_path: raw }, roots);
    if (!verdict.ok) return { error: (verdict.reason ?? `"${raw}" may not be read`).replace(/^Read was denied/, `review was refused (${label})`) };
    const abs = expandVirtual(raw, roots)?.abs ?? path.resolve(roots.agentDir, raw);
    // Read from the file that was checked, not from a name that may point elsewhere by then (Codex): open it,
    // then confirm the open file is the one its real path names, and that path still passes the rule.
    let fd: number;
    try {
      // Non-blocking: a named pipe with no writer would otherwise hold the driver here before fstat can refuse it (Codex).
      fd = fs.openSync(abs, fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0));
    } catch {
      return { error: `review: "${raw}" does not exist` };
    }
    try {
      const st = fs.fstatSync(fd);
      if (!st.isFile()) return { error: `review: "${raw}" is not a file` };
      const real = fs.realpathSync(abs);
      const there = fs.statSync(real);
      if (there.dev !== st.dev || there.ino !== st.ino || !checkPaths("Read", { file_path: real }, roots).ok) return { error: `review: "${raw}" changed while it was read; nothing was sent` };
      if (st.size > SECOND_REVIEW_MAX_CHARS * 4) return { error: `review: "${raw}" is larger than one review takes` };
      const buf = Buffer.alloc(st.size);
      let off = 0;
      while (off < buf.length) {
        const n = fs.readSync(fd, buf, off, buf.length - off, off);
        if (n === 0) break;
        off += n;
      }
      return { content: buf.subarray(0, off).toString("utf8") };
    } catch {
      return { error: `review: "${raw}" could not be read` };
    } finally {
      fs.closeSync(fd);
    }
  };

  // One at a time, from reading what the budget has left to counting what the call cost (Codex): two calls
  // the model makes in parallel would otherwise both be sent with the same balance.
  let chain: Promise<unknown> = Promise.resolve();
  const ask = (which: "debate" | "review", input: Record<string, unknown>, maxTokens: number | undefined) => {
    const next = chain.then(() => askOne(which, input, maxTokens));
    chain = next.catch(() => {});
    return next;
  };
  // A call whose answer never came back may have been charged an amount not known here: no more are sent in
  // this step, since what the budget has left is no longer known (Codex).
  let unknownSpend = false;
  const askOne = async (which: "debate" | "review", input: Record<string, unknown>, maxTokens: number | undefined) => {
    if (unknownSpend) return fail(`${which}: an earlier debate or review in this step got no answer back and may have been charged, so what the step's budget has left is not known; nothing was sent`);
    const ep = operatorEndpoint(opts.egress);
    if (!ep) return fail(`${which} needs a platform run: the second model is reached through the step's egress proxy, and this step has none (a local or in-process run). Nothing was sent.`);
    const left = opts.spend.left?.() ?? null;
    if (left !== null && left <= 0) return fail(`${which}: the step's budget is spent; nothing was sent`);
    opts.emit?.("info", `${which}: asking ${opts.model}`);
    let res: Response;
    try {
      res = await fetchImpl(`${ep.base}/second/${ep.token}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tool: which, input, ...(maxTokens ? { max_tokens: maxTokens } : {}), ...(left !== null ? { max_usd: left } : {}) }),
        signal: AbortSignal.timeout(opts.timeoutMs ?? SECOND_TIMEOUT_MS),
      });
    } catch (err) {
      unknownSpend = true;
      return fail(`${which}: the egress proxy did not answer (${err instanceof Error ? err.message : String(err)}); it may have been charged if it reached the model`);
    }
    const body = (await res.json().catch(() => {
      unknownSpend = true;
      return {};
    })) as { text?: unknown; model?: unknown; cost_usd?: unknown; message?: unknown; error?: unknown; maybe_charged?: unknown };
    if (typeof body.cost_usd === "number" && body.cost_usd > 0) opts.spend.usd += body.cost_usd;
    const cost = typeof body.cost_usd === "number" ? ` ($${body.cost_usd.toFixed(4)})` : "";
    if (!res.ok || typeof body.text !== "string") {
      const why = typeof body.message === "string" ? body.message : typeof body.error === "string" ? body.error : `the proxy answered ${res.status}`;
      opts.emit?.("error", `${which}: refused — ${why}`);
      if (body.maybe_charged === true && typeof body.cost_usd !== "number") unknownSpend = true;
      return fail(`${which} was not answered: ${why}${body.maybe_charged === true ? " (it may have been charged)" : ""}`);
    }
    opts.emit?.("info", `${which}: ${typeof body.model === "string" ? body.model : opts.model} answered${cost}`);
    return text(body.text);
  };

  const maxTokens = z.number().int().min(1024).max(16_000).optional().describe("The longest answer, in tokens (default 4096)");
  const defs = [];
  if (opts.tools.includes("debate")) {
    defs.push(
      tool(
        "debate",
        `A second opinion from ${opts.model}, a model of another provider: it tests your position on a question and says where it is wrong. It sees only what you send here.`,
        {
          topic: z.string().describe("The question or decision"),
          position: z.string().optional().describe("Your current position, and why"),
          context: z.string().optional().describe("What it needs to know to judge: constraints, facts, what was tried"),
          max_tokens: maxTokens,
        },
        (args) => debate(args),
      ),
    );
  }
  if (opts.tools.includes("review")) {
    defs.push(
      tool(
        "review",
        `A code review from ${opts.model}, a model of another provider: findings by file and line on a change. Give the diff as a file in your folder (diff_path, e.g. outputs/change.diff from git diff > outputs/change.diff) or as text (diff); paths adds whole files. It sees only what you send.`,
        {
          diff: z.string().optional().describe("The change, as a unified diff"),
          diff_path: z.string().optional().describe("A file holding the unified diff — instead of diff"),
          paths: z.array(z.string()).max(50).optional().describe("Whole files to send beside the diff, for context"),
          instructions: z.string().optional().describe("What to look at closely"),
          max_tokens: maxTokens,
        },
        (args) => review(args),
      ),
    );
  }
  return {
    server: defs.length ? createSdkMcpServer({ name: SECOND_SERVER, version: "1.0.0", tools: defs }) : null,
    toolNames: opts.tools.map((t) => SECOND_TOOL_NAMES[t]),
    /** The handlers, for tests. */
    call: { debate, review },
  };

  async function debate(args: { topic: string; position?: string; context?: string; max_tokens?: number }) {
    return ask("debate", { topic: args.topic, ...(args.position ? { position: args.position } : {}), ...(args.context ? { context: args.context } : {}) }, args.max_tokens);
  }

  async function review(args: { diff?: string; diff_path?: string; paths?: string[]; instructions?: string; max_tokens?: number }) {
    let diff = typeof args.diff === "string" ? args.diff : "";
    if (args.diff_path) {
      if (diff) return fail("review takes diff or diff_path, not both");
      const got = readFile(args.diff_path, "diff_path");
      if ("error" in got) return fail(got.error);
      diff = got.content;
    }
    if (!diff.trim()) return fail("review needs the change: diff (a unified diff) or diff_path (a file holding one). Nothing was sent.");
    const files: { path: string; content: string }[] = [];
    let size = diff.length + (args.instructions?.length ?? 0);
    for (const p of args.paths ?? []) {
      const got = readFile(p, p);
      if ("error" in got) return fail(got.error);
      size += got.content.length;
      files.push({ path: p.replace(/^workspace\//, ""), content: got.content });
    }
    if (size > SECOND_REVIEW_MAX_CHARS) return fail(`review: the diff and files are ${size.toLocaleString("en-US")} characters; one review takes ${SECOND_REVIEW_MAX_CHARS.toLocaleString("en-US")}. Send fewer files, or review in parts. Nothing was sent.`);
    return ask("review", { diff, ...(files.length ? { files } : {}), ...(args.instructions ? { instructions: args.instructions } : {}) }, args.max_tokens);
  }
}
