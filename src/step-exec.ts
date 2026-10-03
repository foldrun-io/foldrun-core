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
import os from "node:os";
import path from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { HookInput, McpServerConfig, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { Effort } from "./store.ts";
import type { TestEffect } from "./test-mode.ts";
import type { OperatorEvent } from "./operator.ts";
import { spawn } from "node:child_process";
import { checkPaths, checkBash, isFilesystemTool, linkWorkspace, workspaceLinkEnv, resolveAgentPath, isWithin } from "./confine.ts";
import { DELEGATE_TOOLS, subagentGuard, toAgentDefinitions, type SubagentSpec } from "./subagents.ts";
import { hostSafeEnv } from "./host-env.ts";
import { validateSchema, describeSchemaErrors, looksLikeSchema } from "./json-schema.ts";
import { CallCounter, limitKeysFor, type Limits } from "./limits.ts";
import { classifyCall, podAt, readPodEvents, type BrowserPodOutcome, type CallKind, type ClassifyContext } from "./browser-pod.ts";

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
  /** Set only when some turns ran on a different model from the step's — a
   *  sub-agent with its own `model:`. The sum of every turn, each priced at
   *  its own model. `usage` above is one lump and cannot be repriced at the
   *  step's model without charging the sub-agent's turns at the wrong rate;
   *  the runner reads this instead (repriced in runner.ts). */
  turnsCostUsd?: number;
  /** Why the model's last turn ended, as the SDK's result message says:
   *  end_turn, max_tokens, stop_sequence, tool_use, pause_turn, refusal or
   *  model_context_window_exceeded. Null when no result arrived. */
  stopReason?: string | null;
  /** Set when the step browsed through the account's browser pod from the
   *  slim image (ExecOptions.browserPod): its reconnects, and — when the pod
   *  was lost — why, and what the step had written by then. */
  browserPod?: BrowserPodOutcome;
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
  /** The most this step may spend, in USD, before it is stopped mid-turn.
   *  The runner derives it from the flow's `budget:` and what the run has
   *  already spent; absent means no ceiling on this step. */
  budgetUsd?: number | null;
  /** Which line set the ceiling, for the error that names it — "budget: in
   *  the flow file" or "budget: on the <agent> agent". */
  budgetNote?: string;
  /** Price per token for the model, when the catalogue knows it, so spend
   *  can be counted turn by turn instead of learned at the end. Without it
   *  the step prices its turns from the SDK's own running total. */
  price?: { input: number; output: number } | null;
  /** A check the step must pass to count as done: a shell command that must
   *  exit 0, or an eval-style assertion (`contains: x`, `not-contains: x`,
   *  `matches: re`, `file: path`, `judge: sentence`) — see checkVerify. */
  verify?: string;
  verifyEnv?: Record<string, string>;
  /** `output: json` — the reply must carry one JSON value; extracting it is
   *  part of finishing the step, and failing to is failing the step. */
  output?: "json";
  /** `schema:` — what that value must look like; a value that does not fit
   *  fails the step naming the field. See json-schema.ts. */
  schema?: Record<string, unknown> | boolean;
  /** `max_turns:` — the most model turns before the step is stopped. The
   *  SDK enforces it; the step reads the result's reason and says so. */
  maxTurns?: number;
  /** false when the caller is already an isolation boundary (a run
   *  container): the SDK's bash sandbox is then redundant and would block
   *  declared network use. Default (undefined/true) keeps it on. */
  sandboxBash?: boolean;
  /** Has a person asked for the run to stop? Polled every couple of
   *  seconds while the model loop runs; true interrupts it. The in-process
   *  runner answers from the run record (stopRun writes there from another
   *  process); a container has a sandbox that is destroyed instead. */
  stopRequested?: () => boolean;
  /** Reads the run's inbox (operator.ts inboxReader): what a person wrote
   *  in while the step runs, handed to the model after its next tool call.
   *  Absent where nobody can write in (no egress proxy). */
  inbox?: () => Promise<string | null>;
  /** `subagents:` — colleagues the model may delegate to, each with its own
   *  context and tools no wider than this step's (subagents.ts). Absent or
   *  empty: no Agent tool, as before. */
  subagents?: SubagentSpec[];
  /** `limits:` — the most calls this step may make, per tool and in all,
   *  resolved host-side (account, workspace, agent, step: nearest wins per
   *  key). Counted in the PreToolUse hook below; see limits.ts. */
  limits?: Limits;
  /** SDK tool name → the foldrun name it counts under, for the tools whose
   *  SDK name does not say (limits.ts toolOwners). */
  toolOwners?: Record<string, string>;
  /** The step runs on the slim image and browses through the account's
   *  browser pod (browser-pod.ts). `events` is the file the web tool writes
   *  its reconnects to; the classify context says which API operations and
   *  web actions are writes. A lost pod stops the step, and the outcome
   *  says what it had written, so the runner can re-run it or fail it. */
  browserPod?: { events: string } & ClassifyContext;
  emit: (type: "text" | "tool" | "info" | "error", text: string, extra?: EventExtra) => void;
}

/** How often the stop flag is read while a step runs. */
export const STOP_POLL_MS = 2000;
/** The least a `verify:` gets when the step used up most of its `timeout:` —
 *  capped by the timeout itself, so the step and its check together never
 *  run past timeout + this. Under the isolated path's backstop (+60 s). */
export const VERIFY_FLOOR_MS = 30_000;

/** How long a `verify:` may run: what is left of the step's `timeout:`,
 *  with a floor. Null when the flow set no timeout — `timeout:` is the only
 *  clock there is, and a stop still ends the check. */
export function verifyBudgetMs(timeoutSec: number | undefined, elapsedMs: number): number | null {
  if (!timeoutSec || timeoutSec <= 0) return null;
  const total = timeoutSec * 1000;
  return Math.max(total - elapsedMs, Math.min(VERIFY_FLOOR_MS, total));
}
/** After an interrupt is asked for, how long the model loop gets to wind
 *  down on its own before the query is aborted outright. */
export const INTERRUPT_GRACE_MS = 10_000;

/** The model loop, as executeStep needs it — the SDK's `query`, or a test's
 *  stand-in. Only the shape the loop reads. */
export type QueryLike = AsyncIterable<unknown> & { interrupt(): Promise<unknown> };
export type QueryFn = (args: { prompt: string; options: Record<string, unknown> }) => QueryLike;

/** The pairing fields on a tool event — see RunEvent in store.ts. */
export type EventExtra = { call?: string; ms?: number; err?: boolean; effect?: TestEffect; operator?: OperatorEvent; subagent?: string; check?: boolean };

/** The tag on every event a failed check writes — `verify:`, `output: json`,
 *  a schema — headline and detail alike. The runner's no-retry rule for
 *  outward steps reads it (actedThenFailedCheck); reading the wording of the
 *  last error missed a check whose detail line came after its headline. */
const CHECK = { check: true } as const;


/** Conservative per-token rates for a model nothing else can price — an
 *  unknown id on a gateway with no catalogue. Opus-class, so a ceiling
 *  still means something. Only ever reached when `knownPrice` below does
 *  not recognise the model either. */
export const FALLBACK_PRICE = { input: 15e-6, output: 75e-6 };

/** The rates we know without asking anyone: the tiers this runtime resolves
 *  (`fast`/`default`/`max` → haiku/sonnet/opus) and the model ids that carry
 *  those words. A gateway with a catalogue still wins — that is the
 *  authority — but the platform's own Anthropic key has no catalogue, and
 *  pricing its steps at Opus rates made every mid-turn ceiling read up to
 *  fifteen times high: an indexing run was stopped at "$1.17" having
 *  actually spent $0.15 (2026-09-08). Per token, input/output. */
const KNOWN_PRICES: [RegExp, { input: number; output: number }][] = [
  [/haiku/i, { input: 1e-6, output: 5e-6 }],
  [/sonnet/i, { input: 2e-6, output: 10e-6 }],
  [/\bopus\b/i, { input: 5e-6, output: 25e-6 }],
];

/** What a token costs on this model, when we can say without a catalogue. */
export function knownPrice(model: string | undefined): { input: number; output: number } | null {
  if (!model) return null;
  return KNOWN_PRICES.find(([re]) => re.test(model))?.[1] ?? null;
}

/** Anthropic's cache multipliers, and the shape every gateway that bills
 *  for caching at all has copied: a write costs a quarter more than fresh
 *  input, a read a tenth of it. Counting both at the full input rate — as
 *  this did — makes a long cached prompt read about ten times its price,
 *  which on a ceiling is not "the honest direction to be wrong in", it is
 *  a step killed for spending money it never spent. */
const CACHE_WRITE_MULTIPLIER = 1.25;
const CACHE_READ_MULTIPLIER = 0.1;

/**
 * What one assistant turn cost, from the usage the SDK reports. Pure.
 *
 * A gateway whose cache is priced differently is over- or under-counted
 * here by that difference alone; the run record's own cost is repriced
 * from the catalogue afterwards and stays the authority on the bill. This
 * number exists to stop a runaway step mid-turn, and wants to be close.
 */
export function priceTurn(u: Record<string, number | undefined>, price: { input: number; output: number } | null): number {
  const p = price ?? FALLBACK_PRICE;
  const fresh = u.input_tokens ?? 0;
  const written = u.cache_creation_input_tokens ?? 0;
  const read = u.cache_read_input_tokens ?? 0;
  const outTok = u.output_tokens ?? 0;
  return (
    fresh * p.input +
    written * p.input * CACHE_WRITE_MULTIPLIER +
    read * p.input * CACHE_READ_MULTIPLIER +
    outTok * p.output
  );
}

/**
 * Each step launched together gets an equal share of what is left of the
 * run's budget: the shares sum to the remainder, so a group cannot end
 * over the cap however many steps it fans out to. No budget, no ceiling.
 */
export function stepCeiling(budgetUsd: number | null | undefined, spentUsd: number, launching: number): number | null {
  if (!budgetUsd || budgetUsd <= 0) return null;
  return Math.max(0, budgetUsd - spentUsd) / Math.max(1, launching);
}

/**
 * The ceiling a step actually runs under, and which line set it.
 *
 * Two caps can apply to one step: the flow's `budget:` gives it an equal
 * share of what the run has left; the agent's own `budget:` is the most that
 * agent may spend in one run, less what its steps in this run have cost or
 * may still cost, shared across `sharing` — this step and the agent's steps
 * launched with it that have not started yet. Without the share, twenty
 * fan-out copies of one agent each got the whole remainder, because none of
 * them has recorded a cent when the next one starts.
 * The tighter one wins, and the note says which, because "over budget" with
 * no line to go and raise is a message that sends someone to the wrong file.
 */
export function stepCeilingFor(
  flowShareUsd: number | null,
  agentBudgetUsd: number | null | undefined,
  agentSpentUsd: number,
  agent: string,
  sharing = 1,
): { ceilingUsd: number | null; note: string } {
  const flow = { ceilingUsd: flowShareUsd, note: "budget: in the flow file" };
  if (!agentBudgetUsd || agentBudgetUsd <= 0) return flow;
  const left = Math.max(0, agentBudgetUsd - agentSpentUsd) / Math.max(1, sharing);
  if (flowShareUsd !== null && flowShareUsd <= left) return flow;
  return { ceilingUsd: left, note: `budget: on the ${agent} agent` };
}

export async function executeStep(
  opts: ExecOptions,
  /** The model loop. Injected so the clock and the stop can be tested
   *  without a model; production passes nothing and gets the SDK. */
  runQuery: QueryFn = query as unknown as QueryFn,
): Promise<ExecOutcome> {
  // `workspace/…` for the shell, the scripts and a shell `verify:` — the
  // file tools expand the prefix themselves. Held for the step, verify
  // included, and gone before anyone reads the step's files back
  // (confine.ts#linkWorkspace says why it is not permanent).
  fs.mkdirSync(opts.agentDir, { recursive: true });
  const link = linkWorkspace(opts.agentDir, opts.workspaceRoot);
  if (link.note) opts.emit("info", `workspace/: ${link.note}`);
  try {
    // And a Node program started through it is still its own main module
    // (confine.ts#workspaceLinkEnv) — for the model's Bash, which inherits
    // the SDK's env; the shell verify: and the scripts get it where they
    // spawn.
    return await executeStepInner({ ...opts, env: workspaceLinkEnv(opts.env, opts.agentDir) }, runQuery);
  } finally {
    link.release();
  }
}

async function executeStepInner(opts: ExecOptions, runQuery: QueryFn): Promise<ExecOutcome> {
  const { agentDir, workspaceRoot, libraryRoot, emit } = opts;
  let status: "running" | "completed" | "failed" = "running";
  let costUsd: number | null = null;
  let usage: ExecOutcome["usage"] = null;
  let stopReason: string | null = null;
  const texts: string[] = [];

  fs.mkdirSync(path.join(agentDir, "outputs"), { recursive: true });
  fs.mkdirSync(path.join(agentDir, "memory"), { recursive: true });

  // The one handle that can end the loop from outside: the timeout and a
  // stop both ask the query to interrupt, and abort it outright if it has
  // not wound down within the grace period.
  const abort = new AbortController();
  const subagents = opts.subagents?.length ? opts.subagents : null;
  const guardSubagent = subagents ? subagentGuard(subagents) : null;
  // A sub-agent's calls reach both the hook (which sees its id AND name) and
  // canUseTool (which sees only the id). Remembered here so every refusal —
  // its own list, a path outside the workspace, a shell command — names the
  // agent that tried, not just the step.
  const subagentNames = new Map<string, string>();
  // `limits:` — this step's counts. A new step, a retry of one, or a
  // fan-out instance each start from zero.
  const counter = new CallCounter(opts.limits);

  const q = runQuery({
    prompt: opts.prompt,
    options: {
      cwd: agentDir,
      abortController: abort,
      model: opts.model,
      // Omitted, not passed as undefined-with-a-default: an unset effort
      // should mean "whatever this model does normally", which is not a
      // level we can name — it moves as models ship.
      ...(opts.effort ? { effort: opts.effort } : {}),
      systemPrompt: opts.systemPrompt,
      ...(opts.maxTurns ? { maxTurns: opts.maxTurns } : {}),
      // Sub-agents: the SDK's own delegation. Every definition carries an
      // explicit tool list (an absent one inherits all of ours).
      ...(subagents ? { agents: toAgentDefinitions(subagents) } : {}),
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
      // With sub-agents, the SDK would also offer its built-in ones
      // (general-purpose has every tool the session has). Only the declared
      // ones may run; the guard in the hook below refuses the rest as well.
      env: sdkEnv(opts.env, subagents ? { CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS: "1" } : {}),
      mcpServers: opts.mcpServers,
      // Only the servers foldrun passes. See sdkEnv for the claude.ai half.
      strictMcpConfig: true,
      // canUseTool is only asked when the SDK wants permission, and it never
      // asks for a read inside the cwd — so `Read workspace/storage/x` went
      // to `<agentDir>/workspace/storage/x` unchecked and unrewritten. On
      // 2026-09-24 that read a stray copy a broken write had left there,
      // with no error. A PreToolUse hook runs on every call: expand the
      // virtual prefix (and refuse an escape) here for every filesystem tool,
      // and leave the rest of the decision to canUseTool.
      hooks: {
        PreToolUse: [{
          hooks: [async (hookInput: HookInput) => {
            if (hookInput.hook_event_name !== "PreToolUse") return {};
            // A sub-agent's calls come through here too, tagged with its
            // name; anything outside its own list — or from a sub-agent this
            // step did not declare — is refused before the shared checks
            // below (which apply to it unchanged). So is a delegation from
            // the main thread to anything but a declared sub-agent.
            const agentId = "agent_id" in hookInput && hookInput.agent_id ? String(hookInput.agent_id) : undefined;
            const agentType = agentId ? (hookInput as { agent_type?: string }).agent_type : undefined;
            const via = agentId ? (agentType ?? "subagent") : undefined;
            if (agentId && via) subagentNames.set(agentId, via);
            if (guardSubagent) {
              const why = guardSubagent({ agentId, agentType, tool: hookInput.tool_name, input: (hookInput.tool_input ?? {}) as Record<string, unknown> });
              if (why) {
                emit("error", why, { subagent: via });
                return { hookSpecificOutput: { hookEventName: "PreToolUse" as const, permissionDecision: "deny" as const, permissionDecisionReason: why } };
              }
            }
            const verdict = isFilesystemTool(hookInput.tool_name)
              ? checkPaths(hookInput.tool_name, hookInput.tool_input as Record<string, unknown>, { agentDir, workspaceRoot, libraryRoot })
              : null;
            if (verdict && !verdict.ok) {
              emit("error", verdict.reason!, via ? { subagent: via } : undefined);
              return { hookSpecificOutput: { hookEventName: "PreToolUse" as const, permissionDecision: "deny" as const, permissionDecisionReason: verdict.reason! } };
            }
            // `limits:` — last, so a call another check refused counts
            // toward nothing. Every call passes here, the step's own and its
            // sub-agents', so one count covers both. A call past a limit is
            // refused before it runs: the tool, and any paid API behind it,
            // never sees it.
            if (counter.active) {
              const refusal = counter.take(limitKeysFor(hookInput.tool_name, hookInput.tool_input as Record<string, unknown>, opts.toolOwners));
              if (refusal) {
                emit("info", `${refusal.message} (${hookInput.tool_name} refused)`, via ? { subagent: via } : undefined);
                return { hookSpecificOutput: { hookEventName: "PreToolUse" as const, permissionDecision: "deny" as const, permissionDecisionReason: refusal.message } };
              }
            }
            if (!verdict?.updatedInput) return {};
            return { hookSpecificOutput: { hookEventName: "PreToolUse" as const, permissionDecision: "allow" as const, updatedInput: verdict.updatedInput } };
          }],
        }],
        // A message a person sent into the running step reaches the model
        // after its next tool call, as context — never as a change to what it
        // may do. A model that is only writing, calling no tools, hears it at
        // the next call it makes.
        ...(opts.inbox
          ? {
              PostToolUse: [{
                hooks: [async (hookInput: HookInput) => {
                  if (hookInput.hook_event_name !== "PostToolUse") return {};
                  // A sub-agent's call: the message is for the step's own
                  // model, and draining it here would hand it to a context
                  // that ends with the delegation — and lose it.
                  if ("agent_id" in hookInput && hookInput.agent_id) return {};
                  const context = await opts.inbox!().catch(() => null);
                  return context ? { hookSpecificOutput: { hookEventName: "PostToolUse" as const, additionalContext: context } } : {};
                }],
              }],
            }
          : {}),
      },
      canUseTool: async (toolName: string, input: Record<string, unknown>, options?: { agentID?: string }) => {
        const via = options?.agentID ? (subagentNames.get(options.agentID) ?? "subagent") : undefined;
        // The toolset was already narrowed to what the agent declared, so
        // anything outside it is a denial with a reason the model can act on.
        const fromGrantedServer = opts.mcpNames.some((n) => toolName.startsWith(`mcp__${n}__`));
        // A call the hook counted and this refuses never ran: give it back.
        const refund = () => { if (counter.active) counter.refund(limitKeysFor(toolName, input, opts.toolOwners)); };
        if (!opts.allowed.includes(toolName) && !fromGrantedServer) {
          refund();
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
          refund();
          emit("error", verdict.reason!, via ? { subagent: via } : undefined);
          return { behavior: "deny" as const, message: verdict.reason! };
        }
        return { behavior: "allow" as const, updatedInput: verdict.updatedInput ?? input };
      },
    },
  });

  // Why the loop was ended from outside, if it was. The deadline used to be
  // checked only when a message arrived, so a step waiting on one long tool
  // call — a crawl, a build — sailed past its timeout: with no message there
  // was nothing to check it against. The backstop timer fires regardless,
  // and a stop is read on a clock rather than between groups.
  let ended: "timeout" | "stopped" | "pod-lost" | null = null;
  const startedAt = Date.now();
  const timers: NodeJS.Timeout[] = [];
  const endWith = (why: "timeout" | "stopped" | "pod-lost") => {
    if (ended) return;
    ended = why;
    void q.interrupt().catch(() => {});
    timers.push(setTimeout(() => abort.abort(), INTERRUPT_GRACE_MS));
  };
  if (opts.timeoutSec) timers.push(setTimeout(() => endWith("timeout"), opts.timeoutSec * 1000));
  if (opts.stopRequested) {
    timers.push(setInterval(() => {
      try {
        if (opts.stopRequested!()) endWith("stopped");
      } catch {
        // an unreadable record is not a stop
      }
    }, STOP_POLL_MS));
  }
  // The clocks stay referenced on purpose: a step hanging in a tool call may
  // be the only thing keeping the loop alive, and an unreferenced timer
  // would let the process exit around it instead of ending it. They are all
  // cleared when the step ends, so nothing outlives the step.

  // The hard cap. Spend is counted as each assistant turn arrives — its
  // usage is in the message — so the step can stop at the ceiling rather
  // than learn afterwards that it crossed it. Cache traffic is counted as
  // input at the input rate, which over-approximates: on the money side
  // that is the honest direction to be wrong in.
  const ceiling = typeof opts.budgetUsd === "number" && opts.budgetUsd > 0 ? opts.budgetUsd : null;
  let spentUsd = 0;
  // Every turn's usage, by the model message's id. The SDK can emit one
  // turn as several assistant messages that repeat the same usage, so a
  // turn is counted once — and the sum is the step's cost whenever the
  // closing `result` never arrives: a timeout or a stop ends the loop before
  // it, and a step that made 193 model calls was recorded as $0 (lawyer-desk,
  // 2026-09-25 09:00).
  // Each with the rate it is priced at: a sub-agent with its own `model:`
  // runs its turns on that model, and pricing them at the parent's put a
  // max sub-agent under a fast parent at a fifth of its cost — against the
  // ceiling and on the bill.
  const turns = new Map<string, { u: Record<string, number | undefined>; price: { input: number; output: number } | null }>();
  let anonymousTurns = 0;
  const specByName = new Map((subagents ?? []).map((s) => [s.name, s]));
  const priceOf = (message: unknown): { input: number; output: number } | null => {
    const parent = (message as { parent_tool_use_id?: string | null }).parent_tool_use_id;
    if (!parent) return opts.price ?? null;
    const declared = specByName.get(delegations.get(parent) ?? "")?.model;
    if (declared === undefined || declared === "inherit" || declared === opts.model) return opts.price ?? null;
    const model = (message as { message?: { model?: unknown } }).message?.model;
    return knownPrice(typeof model === "string" ? model : undefined) ?? knownPrice(declared);
  };
  const turnsTotal = () => [...turns.values()].reduce((sum, t) => sum + priceTurn(t.u, t.price), 0);
  const mixedModels = () => [...turns.values()].some((t) => t.price !== (opts.price ?? null));

  // Open tool calls, by the provider's id, so the result can be paired with
  // its call and the trace can say how long each tool ran.
  const openCalls = new Map<string, { name: string; at: number; subagent?: string }>();
  // Delegations in flight: the parent's Agent call id → the sub-agent's name.
  // The SDK tags every message a sub-agent produces with that call's id
  // (parent_tool_use_id), which is how its tool calls are labelled here.
  const delegations = new Map<string, string>();
  const subagentOf = (message: unknown): string | undefined => {
    const parent = (message as { parent_tool_use_id?: string | null }).parent_tool_use_id;
    return parent ? (delegations.get(parent) ?? "subagent") : undefined;
  };

  // Slim browsing (browser-pod.ts): every call the step makes, read or
  // write, in the order the model asked for them — the step's own and its
  // sub-agents'. Classified when asked for, not when answered: a call in
  // flight when the pod goes is counted as made. And the web tool's pod log,
  // read after every tool result.
  const pod = opts.browserPod ?? null;
  const ledger = new Map<string, CallKind>();
  const podState: BrowserPodOutcome = { reconnects: 0, reconnected: 0 };
  let podOffset = 0;
  const readPod = (callId: string) => {
    if (!pod) return;
    let text: string;
    try {
      text = fs.readFileSync(pod.events, "utf8");
    } catch {
      return; // nothing written yet
    }
    const { events, next } = readPodEvents(text, podOffset);
    podOffset = next;
    let closedAgain = false;
    for (const [i, e] of events.entries()) {
      if (e.kind === "reconnect") {
        podState.reconnects += 1;
        // A reconnect that reached the pod, and then the call dropped again
        // at once (the web tool's next line is "lost"), did not get
        // through: the pod answered while it shut down. Live, 2026-10-01,
        // "reconnected (try 1 of 3)" was followed by "lost after 1
        // reconnect try" and the step read "1 got through".
        closedAgain = !!e.ok && events[i + 1]?.kind === "lost";
        if (closedAgain) podState.closedAgain = (podState.closedAgain ?? 0) + 1;
        else if (e.ok) podState.reconnected += 1;
        // `at` is when the try happened: these lines reach the run when the
        // call returns, so the run's own stamps on them are all the same.
        emit("info", `browser pod: ${e.ok ? "reconnected" : "reconnect failed"} (try ${e.attempt ?? "?"} of ${e.of ?? "?"}${podAt(e.at)})${!e.ok && e.error ? ` — ${e.error}` : ""}${closedAgain ? ", but the pod closed again" : ""}`);
      } else if (!podState.lost) {
        // A call that never reached the pod changed nothing, whatever its
        // arguments asked for.
        if (e.ran === false) ledger.delete(callId);
        podState.lost = { cause: e.kind, detail: (e.kind === "needs-full" ? e.why : e.error) ?? "connection closed" };
        emit("info", e.kind === "needs-full"
          ? `browser pod: this call needs a browser in the step, which the slim image has not (${podState.lost.detail}) — stopping the step`
          : closedAgain
            ? `browser pod: lost — the call dropped again after the reconnect (${podState.lost.detail}${podAt(e.at)}) — stopping the step`
            : `browser pod: lost after ${podState.reconnects} reconnect tr${podState.reconnects === 1 ? "y" : "ies"} (${podState.lost.detail}${podAt(e.at)}) — stopping the step`);
        endWith("pod-lost");
      }
    }
  };

  try {
  for await (const message of q as AsyncIterable<SDKMessage>) {
    if (ended) break;
    if (message.type === "assistant") {
      const m = message.message as unknown as { id?: string; usage?: Record<string, number | undefined> };
      const u = m.usage;
      if (u) turns.set(m.id ?? `turn-${anonymousTurns++}`, { u, price: priceOf(message) });
      if (ceiling && u) {
        spentUsd = turnsTotal();
        if (spentUsd >= ceiling) {
          emit("error", `over budget — this step reached $${spentUsd.toFixed(4)} of its $${ceiling.toFixed(4)} ceiling mid-turn and was stopped (${opts.budgetNote ?? "budget: in the flow file"})`);
          status = "failed";
          break;
        }
      }
      const via = subagentOf(message);
      for (const block of message.message.content) {
        if (block.type === "text" && block.text.trim()) {
          // A sub-agent's own words are its business; the parent's reply is
          // the step's result. (The SDK forwards only tool blocks by default.)
          if (via) continue;
          texts.push(block.text);
          emit("text", block.text);
        } else if (block.type === "tool_use") {
          if (!via && (DELEGATE_TOOLS as readonly string[]).includes(block.name)) {
            const input = block.input as { subagent_type?: unknown; description?: unknown; prompt?: unknown } | undefined;
            const to = String(input?.subagent_type ?? "subagent");
            delegations.set(block.id, to);
            // One line a person can read: who got the job, and what it was.
            const job = String(input?.description ?? input?.prompt ?? "").replace(/\s+/g, " ").trim().slice(0, 160);
            emit("info", `delegating to ${to}${job ? `: ${job}` : ""}`, { subagent: to });
          }
          openCalls.set(block.id, { name: block.name, at: Date.now(), ...(via ? { subagent: via } : {}) });
          if (pod) ledger.set(block.id, classifyCall(block.name, block.input as Record<string, unknown> | undefined, pod));
          emit("tool", block.name, { call: block.id, ...(via ? { subagent: via } : {}) });
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
            ...(open.subagent ? { subagent: open.subagent } : {}),
          });
          readPod(block.tool_use_id);
        }
      }
    } else if (message.type === "result") {
      status = message.subtype === "success" ? "completed" : "failed";
      if (message.subtype === "error_max_turns") {
        emit("error", `stopped after ${opts.maxTurns ?? "its"} turns (max_turns: in the flow file) — the step did not finish`);
      }
      costUsd = "total_cost_usd" in message ? (message.total_cost_usd ?? null) : null;
      stopReason = "stop_reason" in message && typeof message.stop_reason === "string" ? message.stop_reason : null;
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
  } catch (err) {
    // An abort we asked for is not an error of the step's; anything else is.
    if (!ended) throw err;
  } finally {
    for (const t of timers) clearTimeout(t);
  }
  // What the step used of each limit, on the trace whenever any is set —
  // so "it stopped searching at 40" is read off the run, not guessed.
  const limitLine = counter.summary();
  if (limitLine) emit("info", limitLine);
  // No result message — a timeout, a stop, a budget stop, a stream that
  // died — means no total from the SDK. The turns it did take were billed by
  // the provider all the same, so the step's cost is their sum.
  if (costUsd === null && turns.size) {
    let input = 0;
    let output = 0;
    let priced = 0;
    for (const { u: t, price } of turns.values()) {
      input += (t.input_tokens ?? 0) + (t.cache_creation_input_tokens ?? 0) + (t.cache_read_input_tokens ?? 0);
      output += t.output_tokens ?? 0;
      priced += priceTurn(t, price);
    }
    costUsd = priced;
    usage ??= { inputTokens: input, outputTokens: output };
    emit("info", `cost from ${turns.size} model turn${turns.size === 1 ? "" : "s"}: $${priced.toFixed(4)} — the step ended before the model's closing total`);
  }
  if (ended === "timeout") {
    emit("error", `timed out after ${opts.timeoutSec}s (timeout: in the flow file) — the step was stopped with the files it wrote so far kept`);
    status = "failed";
  } else if (ended === "stopped") {
    emit("error", "stopped by a person mid-step");
    status = "failed";
  } else if (ended === "pod-lost") {
    // The runner says what happens next — a re-run on the full image, or a
    // failure naming what was written. Not an error of the step's own.
    status = "failed";
  }
  if (pod) {
    readPod("");
    if (podState.lost) {
      podState.writes = [...ledger.values()].flatMap((k) => (k.write ? [k.what] : []));
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
      // The declared shape, checked here beside the extraction: a value
      // that parses but is not what the next step was promised is the same
      // failure as no value, and the message names the field.
      const errors = opts.schema !== undefined && looksLikeSchema(opts.schema) ? validateSchema(data, opts.schema) : [];
      if (errors.length) {
        emit("error", `schema: the value does not fit — ${describeSchemaErrors(errors)}`, CHECK);
        status = "failed";
      }
    } else {
      emit("error", `output: json — ${extracted.reason}`, CHECK);
      status = "failed";
    }
  }

  // "Done" should mean a check passed, not that the model stopped talking.
  // The loop's clocks are cleared by now, so the check gets its own: what is
  // left of the step's `timeout:` (never less than VERIFY_FLOOR_MS of it),
  // and a stop read on the same clock the loop used. No `timeout:`, no clock:
  // it is the only one there is, here as in the loop. A `verify:` that hangs
  // — a build waiting on a lock, a judge that never answers — used to hold
  // the step, and the run, with nothing to end it.
  if (status === "completed" && opts.verify) {
    const verifyMs = verifyBudgetMs(opts.timeoutSec, Date.now() - startedAt);
    const halt = new AbortController();
    let cut: "timeout" | "stopped" | null = null;
    const clocks: NodeJS.Timeout[] = [];
    if (verifyMs !== null) {
      clocks.push(setTimeout(() => {
        cut ??= "timeout";
        halt.abort();
      }, verifyMs));
    }
    if (opts.stopRequested) {
      clocks.push(setInterval(() => {
        try {
          if (opts.stopRequested!()) {
            cut ??= "stopped";
            halt.abort();
          }
        } catch {
          // an unreadable record is not a stop
        }
      }, STOP_POLL_MS));
    }
    let verdict: VerifyVerdict;
    try {
      verdict = await checkVerify(agentDir, opts.verify, {
        env: opts.verifyEnv ?? {},
        result,
        conclusion,
        data,
        modelEnv: opts.env,
        signal: halt.signal,
      });
    } finally {
      for (const t of clocks) clearTimeout(t);
    }
    if (cut === "timeout") {
      emit("error", `verify \`${opts.verify}\` → timed out after ${Math.round(verifyMs! / 1000)}s (what was left of timeout: in the flow file) — it was stopped`, CHECK);
      status = "failed";
    } else if (cut === "stopped") {
      emit("error", `verify \`${opts.verify}\` → stopped by a person mid-check`, CHECK);
      status = "failed";
    } else {
      emit(verdict.ok ? "info" : "error", `verify \`${opts.verify}\` → ${verdict.headline}`, verdict.ok ? undefined : CHECK);
      if (verdict.detail.trim()) emit(verdict.ok ? "info" : "error", verdict.detail.slice(0, 1000), verdict.ok ? undefined : CHECK);
      if (!verdict.ok) status = "failed";
    }
  }

  return {
    status, result, conclusion, ...(opts.output ? { data } : {}), costUsd, usage,
    ...(mixedModels() ? { turnsCostUsd: turnsTotal() } : {}),
    stopReason,
    ...(pod ? { browserPod: podState } : {}),
  };
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
    /** Ends a shell check or a judge mid-way: the step's clock ran out, or a
     *  person asked the run to stop. */
    signal?: AbortSignal;
  },
): Promise<VerifyVerdict> {
  const m = verify.trim().match(VERIFY_ASSERTION);
  if (!m) {
    // The step's final turn, as a file named in FOLDRUN_REPLY_FILE — so one
    // command can check the reply and the artefact together
    // (`grep -q '^READY' "$FOLDRUN_REPLY_FILE" && test -s out.json`). A step
    // has one `verify:`, and a shell check that could not see the reply
    // made authors choose between the two.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-reply-"));
    const replyFile = path.join(dir, "reply.md");
    fs.writeFileSync(replyFile, ctx.conclusion ?? ctx.result ?? "");
    try {
      const { code, out } = await runVerify(agentDir, verify, { ...ctx.env, FOLDRUN_REPLY_FILE: replyFile }, ctx.data, ctx.signal);
      return { ok: code === 0, headline: `exit ${code ?? "error"}`, detail: out };
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
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
      // Agent-relative like every path in a flow, or `workspace/…` from the
      // workspace root; confined to the workspace. It was confined to the
      // agent's own folder, so the one place a step's deliverable belongs —
      // `workspace/storage/x`, or `../../storage/x` — was always "escapes".
      const workspaceRoot = path.resolve(agentDir, "..", "..");
      const target = resolveAgentPath(workspaceRoot, agentDir, value);
      if (!isWithin(workspaceRoot, target) || target === workspaceRoot) {
        return { ok: false, headline: "path escapes the workspace", detail: "" };
      }
      const ok = fs.existsSync(target) && fs.statSync(target).size > 0;
      return { ok, headline: ok ? "present and non-empty" : `${value} is missing or empty`, detail: "" };
    }
    case "judge": {
      const verdict = await judgeReply(value, output, ctx.modelEnv ?? {}, ctx.signal);
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
  signal?: AbortSignal,
): Promise<string> {
  const texts: string[] = [];
  const abortController = new AbortController();
  if (signal?.aborted) abortController.abort();
  signal?.addEventListener("abort", () => abortController.abort(), { once: true });
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
        env: sdkEnv(env),
        strictMcpConfig: true,
        maxTurns: 1,
        abortController,
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
  signal?: AbortSignal,
): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    // The clock is the caller's (executeStep): what is left of the step's
    // `timeout:`, ended through `signal`, which a stop also fires.
    // The allowlisted host base plus what the caller passed: the step's
    // secrets and identifiers on the in-process path (runner.ts), the
    // container's own environment on the isolated one (run-container.ts).
    // Never process.env whole — see host-env.ts.
    const child = spawn("bash", ["-lc", command], {
      cwd: agentDir,
      // workspaceLinkEnv: `node workspace/tools/x/check.mjs` must run its
      // check, not pass for having skipped it (confine.ts says how).
      env: workspaceLinkEnv({ ...hostSafeEnv(), ...env }, agentDir),
      stdio: ["pipe", "pipe", "pipe"],
      // Its own process group, so an abort ends what the shell started
      // (`npm run build` and its children) and not only bash.
      detached: true,
    });
    const kill = () => {
      try {
        process.kill(-child.pid!, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    };
    if (signal?.aborted) kill();
    else signal?.addEventListener("abort", kill, { once: true });
    child.on("close", () => signal?.removeEventListener("abort", kill));
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

/**
 * The environment an Agent SDK session starts with: the step's, minus the
 * connectors of whoever is signed in to claude.ai on this machine. Claude
 * Code loads an account's claude.ai MCP servers (Docs, Drive, …) unless told
 * not to, and `settingSources: []` does not reach them — they come with the
 * login, not from a settings file. A local `foldrun run` handed every agent
 * the person's own connectors: the hello template's agents reported that
 * "the only tools I have are the Claude Docs ones". `strictMcpConfig` keeps
 * the rest of the on-disk MCP configuration out; this keeps the account's.
 */
export function sdkEnv(base: Record<string, string | undefined> | undefined, extra: Record<string, string> = {}): Record<string, string | undefined> {
  return { ...(base ?? process.env), ...extra, ENABLE_CLAUDEAI_MCP_SERVERS: "false" };
}
