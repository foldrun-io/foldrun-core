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
import type { Effort } from "./store.ts";
import { spawn } from "node:child_process";
import { checkPaths, checkBash, isFilesystemTool } from "./confine.ts";

export interface ExecOutcome {
  status: "completed" | "failed";
  result: string | null;
  /** The LAST text block, which is the model's answer. `result` is every
   *  block joined, and the first of those is usually narration before a tool
   *  call — so anything wanting "what did this conclude" must read this. */
  conclusion: string | null;
  /** The JSON an `output: json` step returned — parsed, so the next step
   *  gets the value and not a re-extraction of it from prose. Undefined for
   *  a step that declared no output shape. */
  data?: unknown;
  costUsd: number | null;
  /** Token counts off the SDK's result message. costUsd is priced from
   *  Anthropic's table, which is wrong for a routed model — these are the
   *  raw numbers a caller with a gateway's own prices can reprice from. */
  usage: { inputTokens: number; outputTokens: number } | null;
}

export interface ExecOptions {
  agentDir: string;
  workspaceRoot: string;
  libraryRoot: string;
  prompt: string;
  model: string;
  /** How hard the model thinks before answering — orthogonal to which model
   *  it is. Null leaves it to the SDK's own default rather than guessing a
   *  level on the author's behalf. */
  effort?: Effort | null;
  systemPrompt: string;
  /** Exact SDK tool names the agent may use. */
  allowed: string[];
  /** MCP server names the agent was granted — tools from these pass. */
  mcpNames: string[];
  mcpServers: Record<string, McpServerConfig>;
  /** The child environment: process env + secrets + provider. */
  env: Record<string, string | undefined>;
  timeoutSec?: number;
  /** A check the step must pass to count as done: a shell command that must
   *  exit 0, or an eval-style assertion (`contains: x`, `not-contains: x`,
   *  `matches: re`, `file: path`, `judge: sentence`) — see checkVerify. */
  verify?: string;
  verifyEnv?: Record<string, string>;
  /** `output: json` — the reply must carry one JSON value; extracting it is
   *  part of finishing the step, and failing to is failing the step. */
  output?: "json";
  /** false when the caller is already an isolation boundary (a run
   *  container): the SDK's bash sandbox is then redundant and would block
   *  declared network use. Default (undefined/true) keeps it on. */
  sandboxBash?: boolean;
  emit: (type: "text" | "tool" | "info" | "error", text: string, extra?: EventExtra) => void;
}

/** The pairing fields on a tool event — see RunEvent in store.ts. */
export type EventExtra = { call?: string; ms?: number; err?: boolean };

export async function executeStep(opts: ExecOptions): Promise<ExecOutcome> {
  const { agentDir, workspaceRoot, libraryRoot, emit } = opts;
  let status: "running" | "completed" | "failed" = "running";
  let costUsd: number | null = null;
  let usage: ExecOutcome["usage"] = null;
  const texts: string[] = [];

  fs.mkdirSync(path.join(agentDir, "outputs"), { recursive: true });
  fs.mkdirSync(path.join(agentDir, "memory"), { recursive: true });

  const q = query({
    prompt: opts.prompt,
    options: {
      cwd: agentDir,
      model: opts.model,
      // Omitted, not passed as undefined-with-a-default: an unset effort
      // should mean "whatever this model does normally", which is not a
      // level we can name — it moves as models ship.
      ...(opts.effort ? { effort: opts.effort } : {}),
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

  // Open tool calls, by the provider's id, so the result can be paired with
  // its call and the trace can say how long each tool ran.
  const openCalls = new Map<string, { name: string; at: number }>();

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
          openCalls.set(block.id, { name: block.name, at: Date.now() });
          emit("tool", block.name, { call: block.id });
        }
      }
    } else if (message.type === "user") {
      // Tool results ride back as user turns. The completion event closes
      // the span the call opened; the runner's journal keeps both.
      const content = message.message.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type !== "tool_result") continue;
          const open = openCalls.get(block.tool_use_id);
          if (!open) continue;
          openCalls.delete(block.tool_use_id);
          emit("tool", open.name, {
            call: block.tool_use_id,
            ms: Date.now() - open.at,
            ...(block.is_error ? { err: true } : {}),
          });
        }
      }
    } else if (message.type === "result") {
      status = message.subtype === "success" ? "completed" : "failed";
      costUsd = "total_cost_usd" in message ? (message.total_cost_usd ?? null) : null;
      if ("usage" in message && message.usage) {
        const u = message.usage as unknown as Record<string, number | undefined>;
        usage = {
          // Cache traffic is input the provider still bills (at its own
          // rates); folding it into the input count over-approximates for
          // gateways with cheaper cache reads, which errs on the honest side.
          inputTokens:
            (u.input_tokens ?? 0) +
            (u.cache_creation_input_tokens ?? 0) +
            (u.cache_read_input_tokens ?? 0),
          outputTokens: u.output_tokens ?? 0,
        };
      }
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
  // A step's reply is not one message: the model narrates ("Now let me read
  // the outputs…"), calls tools, and answers last. Joining those and reading
  // the first line — which is what the run summary did — reports the plan
  // and never the outcome. The final block is the answer; keep it so the
  // summary has something true to read.
  const conclusion = texts.at(-1)?.trim() || null;

  // output: json — the declared shape is a contract, checked here where both
  // executors run. A reply with no JSON in it is not "done with a caveat";
  // it is the failure the next step would otherwise inherit as garbage.
  let data: unknown = undefined;
  if (status === "completed" && opts.output === "json") {
    const extracted = extractJson(result);
    if (extracted.ok) {
      data = extracted.value;
      emit("info", `output: json — ${describeJson(data)}`);
    } else {
      emit("error", `output: json — ${extracted.reason}`);
      status = "failed";
    }
  }

  // "Done" should mean a check passed, not that the model stopped talking.
  if (status === "completed" && opts.verify) {
    const verdict = await checkVerify(agentDir, opts.verify, {
      env: opts.verifyEnv ?? {},
      result,
      conclusion,
      data,
      modelEnv: opts.env,
    });
    emit(verdict.ok ? "info" : "error", `verify \`${opts.verify}\` → ${verdict.headline}`);
    if (verdict.detail.trim()) emit(verdict.ok ? "info" : "error", verdict.detail.slice(0, 1000));
    if (!verdict.ok) status = "failed";
  }

  return { status, result, conclusion, ...(opts.output ? { data } : {}), costUsd, usage };
}

// ------------------------------------------------------------ output: json

/**
 * The one JSON value a reply carries. A ```json fence wins — it is what the
 * step was asked to write — and the LAST one at that, because a model that
 * shows its working often quotes an earlier draft first. Without a fence,
 * the reply's trailing `{…}` or `[…]` is tried, so a model that answered
 * with bare JSON is not failed for good behaviour.
 */
export function extractJson(result: string | null): { ok: true; value: unknown } | { ok: false; reason: string } {
  const text = (result ?? "").trim();
  if (!text) return { ok: false, reason: "the reply was empty" };
  const fences = [...text.matchAll(/```(?:json|JSON)?\s*\n([\s\S]*?)\n\s*```/g)].map((m) => m[1].trim());
  const candidates = fences.length ? fences.reverse() : [];
  if (!candidates.length) {
    // The largest trailing bracketed span: walk back from the end to the
    // last closing bracket, then forward to the matching opener.
    const close = Math.max(text.lastIndexOf("}"), text.lastIndexOf("]"));
    if (close !== -1) {
      const opener = text[close] === "}" ? "{" : "[";
      for (let i = text.indexOf(opener); i !== -1 && i < close; i = text.indexOf(opener, i + 1)) {
        candidates.push(text.slice(i, close + 1));
      }
    }
  }
  let lastError = "no JSON value found in the reply";
  for (const c of candidates) {
    try {
      return { ok: true, value: JSON.parse(c) };
    } catch (err) {
      lastError = `could not parse: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
  return { ok: false, reason: lastError };
}

function describeJson(value: unknown): string {
  if (Array.isArray(value)) return `an array of ${value.length}`;
  if (value && typeof value === "object") return `an object with keys ${Object.keys(value).slice(0, 8).join(", ")}`;
  return `a ${typeof value}`;
}

// ----------------------------------------------------------------- verify:

/** The eval vocabulary a `verify:` may borrow. Anything else is a shell command. */
const VERIFY_ASSERTION = /^(contains|not-contains|matches|file|judge):\s*([\s\S]+)$/;

export interface VerifyVerdict {
  ok: boolean;
  /** One line for the trace: "exit 0", "found", "PASS"… */
  headline: string;
  detail: string;
}

/**
 * Decide a `verify:`. Two dialects, one key: an eval assertion, when the
 * value starts with one of the eval file's assertion words, or a shell
 * command. The assertion form exists so that a flow and an eval share a
 * vocabulary — "the output must mention the price" is the same sentence in
 * both places — and so that the commonest checks need no shell at all.
 */
export async function checkVerify(
  agentDir: string,
  verify: string,
  ctx: {
    env: Record<string, string>;
    result: string | null;
    /** The final turn — what the step concluded. `contains:`, `not-contains:`
     *  and `matches:` test this, because it is also what the run's headline
     *  is read from: a reporter that narrated between tool calls ("Now let
     *  me write the report…") failed `matches: ^BAD\b` with a correct
     *  headline while the check read every turn joined. `judge:` still grades
     *  the whole result. */
    conclusion?: string | null;
    data?: unknown;
    /** The step's own model environment, for `judge:` — it grades on the
     *  fast tier through the same credential the step rode. */
    modelEnv?: Record<string, string | undefined>;
  },
): Promise<VerifyVerdict> {
  const m = verify.trim().match(VERIFY_ASSERTION);
  if (!m) {
    const { code, out } = await runVerify(agentDir, verify, ctx.env, ctx.data);
    return { ok: code === 0, headline: `exit ${code ?? "error"}`, detail: out };
  }
  const [, kind, rawValue] = m;
  const value = rawValue.trim().replace(/^["']|["']$/g, "");
  const output = (kind === "judge" ? ctx.result : (ctx.conclusion ?? ctx.result)) ?? "";
  const hay = output.toLowerCase();
  switch (kind) {
    case "contains": {
      const ok = hay.includes(value.toLowerCase());
      return { ok, headline: ok ? "found" : `"${value}" not in the reply`, detail: "" };
    }
    case "not-contains": {
      const ok = !hay.includes(value.toLowerCase());
      return { ok, headline: ok ? "absent" : `"${value}" appeared in the reply`, detail: "" };
    }
    case "matches": {
      try {
        const ok = new RegExp(value, "i").test(output);
        return { ok, headline: ok ? "matched" : "no match", detail: "" };
      } catch {
        return { ok: false, headline: "invalid regular expression", detail: "" };
      }
    }
    case "file": {
      const target = path.resolve(agentDir, value);
      if (!target.startsWith(path.resolve(agentDir) + path.sep)) {
        return { ok: false, headline: "path escapes the agent directory", detail: "" };
      }
      const ok = fs.existsSync(target) && fs.statSync(target).size > 0;
      return { ok, headline: ok ? "present and non-empty" : `${value} is missing or empty`, detail: "" };
    }
    case "judge": {
      const verdict = await judgeReply(value, output, ctx.modelEnv ?? {});
      const ok = /^\s*PASS\b/i.test(verdict);
      return { ok, headline: ok ? "PASS" : "FAIL", detail: verdict.slice(0, 300) };
    }
  }
  return { ok: false, headline: `unknown check "${kind}"`, detail: "" };
}

/**
 * A toolless, fast-tier grading call: does the reply satisfy the sentence?
 * Same shape as the eval judge, and answered with one word first so the
 * verdict is a prefix test rather than a reading.
 */
async function judgeReply(
  rubric: string,
  output: string,
  env: Record<string, string | undefined>,
): Promise<string> {
  const texts: string[] = [];
  try {
    const q = query({
      prompt:
        `You are grading a reply against one requirement. Answer with PASS or FAIL as the ` +
        `first word, then one sentence of reason.\n\nRequirement: ${rubric}\n\n` +
        `<reply>\n${output.slice(0, 40_000)}\n</reply>`,
      options: {
        model: "haiku",
        systemPrompt: "You grade text against a stated requirement. Be strict and literal.",
        tools: [],
        settingSources: [],
        env,
        maxTurns: 1,
      },
    });
    for await (const message of q) {
      if (message.type === "assistant") {
        for (const block of message.message.content) {
          if (block.type === "text") texts.push(block.text);
        }
      }
    }
  } catch (err) {
    return `FAIL — the judge could not run: ${err instanceof Error ? err.message : String(err)}`;
  }
  return texts.join("\n").trim();
}

// Verification runs in the agent's directory with its secrets available, so
// a check can be as simple as `npm run build` or `test -s outputs/report.md`.
function runVerify(
  agentDir: string,
  command: string,
  env: Record<string, string>,
  data?: unknown,
): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    // No clock of the platform's: a verify like `npm run build` takes what
    // it takes, and the step's own `timeout:` is the bound if the flow set one.
    const child = spawn("bash", ["-lc", command], {
      cwd: agentDir,
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    // An `output: json` step's data arrives on stdin, so a check can be
    // `jq -e '.total > 0'` — arithmetic in a real tool, reading the value
    // the step actually returned rather than re-parsing its prose.
    child.stdin.on("error", () => {});
    if (data !== undefined) child.stdin.end(JSON.stringify(data));
    else child.stdin.end();
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
