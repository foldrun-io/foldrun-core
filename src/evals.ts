// Evals — tests for agents.
//
// An agent's output varies between runs, so an eval can't assert equality.
// It asserts *properties*: this text appears, that file exists, this command
// exits 0, a judge agrees with a rubric. That's the same shape promptfoo and
// OpenAI evals settled on, and it's the only shape that survives a model that
// phrases things differently each time.
//
// The file is markdown, like everything else here:
//
//   evals/writer-quality.md
//   ---
//   name: writer-quality
//   agent: writer            # or `flow: publish`
//   model: fast              # the judge's model, not the agent's
//   ---
//
//   ## mentions the audience
//   task: Write a short draft about cleaning a rain gauge.
//   expect:
//     - contains: farmer
//     - not-contains: leverage
//     - judge: speaks to working farmers, not to gardeners
//
//   ## quotes the real price
//   task: Write one line quoting the price of the RG-40.
//   expect:
//     - contains: $34
//
// Deterministic checks run first and cost nothing. The judge only runs if
// they pass — no point paying a model to grade output already known to be
// wrong.

import { accountModelEnv, withModelEnv } from "./model-env.ts";
import type { TranslatorSpec } from "./translator.ts";
import { sdkEnv } from "./step-exec.ts";
import { platformModelEnv } from "./runner.ts";
import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { deployedCommit } from "./deploy.ts";
import { latestRevisionId } from "./history.ts";
import matter from "./matter.ts";
import { spawn } from "node:child_process";
import { judgeVerdict, JUDGE_VERDICT_INSTRUCTION, parseJudge } from "./judge-verdict.ts";
import { readAgentsMdKeys } from "./agents-md.ts";
import { query } from "@anthropic-ai/claude-agent-sdk";
import {
  workspaceDir,
  accountDir,
  readRun,
  runVerdict,
  writeWorkspaceFile,
  resolveModel,
  resolveEffort,
  assertSafeName,
  type Effort,
} from "./store.ts";
import { startFlowRun, loadFlow } from "./runner.ts";
import { platform, platformQueues } from "./platform.ts";
import type { FlowStep } from "./store.ts";

export type Assertion =
  | { type: "contains"; value: string }
  | { type: "not-contains"; value: string }
  | { type: "matches"; value: string }
  | { type: "file"; value: string }
  | { type: "run"; value: string }
  | { type: "judge"; value: string };

export interface EvalCase {
  name: string;
  task: string;
  expect: Assertion[];
}

export interface EvalInfo {
  name: string;
  file: string;
  /** The agent under test, or null when a flow is. */
  agent: string | null;
  flow: string | null;
  /** Model for the judge. Cases run the agent on its own model. */
  model: string;
  /** Effort for the judge. PASS/FAIL against one sentence is not deep work,
   *  so this is one of the few places a low default is the right one. */
  effort: Effort | null;
  /** When it runs. `deploy` (default): after every push, with the rest.
   *  `manual`: only when a person presses Run or the CLI asks — for a flow
   *  eval that costs a whole run and touches real systems every time.
   *  `runs`: never run as cases — it grades real finished runs of its agent
   *  or flow (grades.ts), a `sample` of them, as they finish. */
  trigger: "deploy" | "manual" | "runs";
  /** trigger: runs — the percent of finished runs graded, 0–100. */
  sample: number;
  /** trigger: runs — propose a fix (improve.ts) once this many graded runs
   *  failed and no person has looked yet. Null: never on its own. */
  improve: number | null;
  /** What in the file cannot be read as written, one sentence each — the
   *  deploy's checks and `foldrun check` report them. */
  problems: string[];
  /** A hash of the file as it was read (listEvals), when it was. */
  revision?: string;
  /** An eval's runs are test runs — nothing outward, state untouched —
   *  unless the file says `live: true`. A flow eval that must really send
   *  to prove itself opts in; nothing opts in by accident. */
  live: boolean;
  /** A file of saved inputs for a flow, not a test: `inputs: true`. Its
   *  cases are named tasks the dashboard's "Run with…" and `foldrun invoke
   *  --inputs` start the flow with; nothing is asserted, so no eval run,
   *  deploy or `foldrun eval` ever runs them. */
  inputs: boolean;
  cases: EvalCase[];
}

const ASSERTION_TYPES = ["contains", "not-contains", "matches", "file", "run", "judge"] as const;

/**
 * A scalar that may continue onto following lines.
 *
 * YAML block scalars (`judge: >` / `judge: |`) and plain multi-line values
 * both used to be read as whatever sat on the first line — which for `>` is
 * the single character `>`. The judge then received ">" as its whole rubric,
 * decided it could not grade against that, and returned FAIL. A four-case
 * eval read 2/4 with two false failures, and nothing anywhere said the file
 * had not been understood.
 *
 * Returns the value and the index of the last line consumed.
 */
function readScalar(
  lines: string[],
  start: number,
  inline: string,
  indent: number,
): { value: string; end: number } {
  const block = inline.trim().match(/^([>|])[-+]?$/);
  const parts: string[] = [];
  let i = start;

  while (i + 1 < lines.length) {
    const next = lines[i + 1];
    if (!next.trim()) {
      // A blank line ends a plain scalar; inside a block it is a paragraph
      // break, which folds to nothing more than the space we already add.
      if (!block) break;
      i++;
      continue;
    }
    const nextIndent = next.length - next.trimStart().length;
    // A sibling list item or anything dedented back to the key's own column
    // belongs to the parent, not to this value.
    if (nextIndent <= indent || /^\s*-\s/.test(next)) break;
    parts.push(next.trim());
    i++;
  }

  if (block) {
    // `|` keeps the line breaks it was written with; `>` folds to one line.
    const value = block[1] === "|" ? parts.join("\n") : parts.join(" ");
    return { value: value.trim(), end: i };
  }
  const first = inline.trim().replace(/^["']|["']$/g, "");
  return { value: [first, ...parts].join(" ").trim(), end: i };
}

/** `defaults`: the workspace's `judge:` (AGENTS.md), used where the eval
 *  names no model or effort of its own. */
export function parseEval(file: string, raw: string, defaults: { model?: string; effort?: string } = {}): EvalInfo {
  const { data, content } = matter(raw);
  const cases: EvalCase[] = [];
  let current: EvalCase | null = null;
  let inExpect = false;

  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const heading = line.match(/^##\s+(?:case:\s*)?(.+?)\s*$/);
    if (heading) {
      if (current) cases.push(current);
      current = { name: heading[1], task: "", expect: [] };
      inExpect = false;
      continue;
    }
    if (!current) continue;

    const task = line.match(/^(\s*)task:\s*(.*)$/);
    if (task) {
      const read = readScalar(lines, i, task[2], task[1].length);
      current.task = read.value;
      i = read.end;
      inExpect = false;
      continue;
    }
    if (/^\s*expect:\s*$/.test(line)) {
      inExpect = true;
      continue;
    }
    if (inExpect) {
      const item = line.match(/^(\s*)-\s*([a-z-]+):\s*(.*)$/);
      if (item && (ASSERTION_TYPES as readonly string[]).includes(item[2])) {
        const read = readScalar(lines, i, item[3], item[1].length);
        current.expect.push({
          type: item[2] as Assertion["type"],
          value: read.value,
        } as Assertion);
        i = read.end;
      } else if (line.trim() && !line.startsWith(" ")) {
        inExpect = false;
      }
    }
  }
  if (current) cases.push(current);

  const trigger: EvalInfo["trigger"] = data.trigger === "manual" ? "manual" : data.trigger === "runs" ? "runs" : "deploy";
  const problems: string[] = [];
  const sample = parseSample(data.sample, problems);
  const improve = parseImprove(data.improve, problems);
  if (trigger !== "runs") {
    if (data.sample !== undefined) problems.push("sample: only applies to an eval with trigger: runs — this one runs its cases");
    if (data.improve !== undefined) problems.push("improve: only applies to an eval with trigger: runs");
  } else {
    // A grader reads what a run said; it never starts one, so a task has
    // nothing to go to, and file:/run: would execute or read on the
    // platform's host rather than in the run's sandbox.
    for (const c of cases) {
      if (c.task) problems.push(`## ${c.name}: task: does nothing in a trigger: runs eval — it grades real runs, so each check is only an expect: list`);
      for (const a of c.expect) {
        if (a.type === "file" || a.type === "run") problems.push(`## ${c.name}: ${a.type}: cannot grade a finished run — use contains, not-contains or judge`);
        // Graded on the platform's scheduler, over whatever a run said: a
        // regular expression that backtracks would hold the scheduler with it.
        if (a.type === "matches") problems.push(`## ${c.name}: matches: is not used to grade live runs — a regular expression over any run's output can stall the platform; use contains, not-contains or judge`);
      }
      if (c.expect.length === 0) problems.push(`## ${c.name}: has no expect: lines, so it grades nothing`);
    }
    if (cases.length === 0) problems.push("a grader needs at least one check — a `## <name>` section with an expect: list; with none it would pass every run");
    // The pass budgets graded runs; this bounds the judges each one costs.
    const judges = cases.reduce((n, c) => n + c.expect.filter((x) => x.type === "judge").length, 0);
    if (judges > MAX_GRADER_JUDGES) problems.push(`${judges} judge: lines — a grader asks at most ${MAX_GRADER_JUDGES} judges per run; fold related claims into one`);
    if (data.live === true) problems.push("live: does nothing in a trigger: runs eval — it never starts a run");
    if (data.inputs === true) problems.push("inputs: and trigger: runs cannot go together");
  }

  return {
    name: data.name ?? file.replace(/\.md$/, ""),
    file,
    agent: typeof data.agent === "string" ? data.agent : null,
    flow: typeof data.flow === "string" ? data.flow : null,
    model: resolveModel(data.model ?? defaults.model ?? "fast"),
    effort: resolveEffort(data.effort ?? defaults.effort ?? "low"),
    trigger,
    sample,
    improve: trigger === "runs" ? improve : null,
    problems,
    live: data.live === true,
    inputs: data.inputs === true,
    cases,
  };
}

/** Judges one graded run may cost — the grade pass counts runs, not calls. */
export const MAX_GRADER_JUDGES = 5;

/** `sample: 25`, `sample: "25%"` — percent of finished runs graded. */
function parseSample(v: unknown, problems: string[]): number {
  if (v === undefined || v === null) return 25;
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v.trim().replace(/%$/, "")) : NaN;
  if (!Number.isFinite(n) || n < 0 || n > 100) {
    problems.push(`sample: ${String(v)} — a percent from 0 to 100 (25 grades about one run in four; 0 grades none on its own)`);
    return 25;
  }
  return Math.round(n * 100) / 100;
}

/** `improve: true` (5), `improve: 3`, `improve: false`. */
function parseImprove(v: unknown, problems: string[]): number | null {
  if (v === undefined || v === null || v === false) return null;
  if (v === true) return 5;
  const n = typeof v === "number" ? v : NaN;
  if (!Number.isInteger(n) || n < 1 || n > 50) {
    problems.push(`improve: ${String(v)} — true, or how many failed grades open a proposal (1 to 50)`);
    return null;
  }
  return n;
}

export function listEvals(tenant: string, workspace: string): EvalInfo[] {
  const dir = path.join(workspaceDir(tenant, workspace), "evals");
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .sort()
    .map((f) => {
      const raw = fs.readFileSync(path.join(dir, f), "utf8");
      // The version is taken from the same read the eval is parsed from, so
      // a grade names the rubric that produced it even if the file changes
      // while its judges answer.
      return { ...parseEval(f, raw, judgeDefaults(tenant, workspace)), revision: crypto.createHash("sha256").update(raw).digest("hex").slice(0, 12) };
    });
}

/** `judge:` from AGENTS.md, field by field: the workspace's model (or
 *  effort), else the account's — so a workspace that sets only an effort
 *  keeps the account's model (Codex debate: the form says so). */
export function judgeDefaults(tenant: string, workspace: string): { model?: string; effort?: string } {
  const ws = parseJudge(readAgentsMdKeys(workspaceDir(tenant, workspace)).judge);
  const account = parseJudge(readAgentsMdKeys(accountDir(tenant)).judge);
  const model = ws.model ?? account.model;
  const effort = ws.effort ?? account.effort;
  return { ...(model ? { model } : {}), ...(effort ? { effort } : {}) };
}

// ---------- promoting a run ----------

/** An error a route can turn into the right status without knowing HTTP. */
function refuse(message: string, status: number): Error {
  return Object.assign(new Error(message), { status });
}

/** Whatever the run was actually asked to do. A flow run carries its input
 *  inside `<run_task>` (the Run button, the API) or `<webhook_payload>` (a
 *  hook) appended to the first step's instruction; an ad-hoc agent run's
 *  instruction IS the task. */
function taskOf(instruction: string): string {
  const block = instruction.match(/<(run_task|webhook_payload)>\n?([\s\S]*?)\n?<\/\1>/);
  return (block ? block[2] : instruction).trim();
}

/** One line for the eval file: the parser reads a scalar to the end of its
 *  line, and a stray newline would become a new key. */
const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();

/**
 * Lay a task out as the eval parser will read it back.
 *
 * A single line sits after `task:`. Anything longer goes in a `|` block,
 * indented — which also keeps a line beginning `## ` from opening a new
 * case. A `- ` at the start of a line ends a block scalar even indented, so
 * a markdown bullet is written as `* `: the same bullet to a reader and to
 * a model, and the case survives.
 */
function layoutTask(task: string): string {
  // A quote at either end of a one-liner would be stripped on read.
  if (!task.includes("\n") && !/^["']|["']$/.test(task)) return `task: ${task}`;
  const lines = task.split("\n").map((l) => `  ${l.replace(/^(\s*)-\s/, "$1* ")}`);
  return `task: |\n${lines.join("\n")}`;
}

/**
 * Turn a finished run into a regression case.
 *
 * A run that worked is the best test of the agent that did it: the task is
 * on record, and so is the answer. This writes both into `evals/` — the task
 * verbatim, the answer as a rubric the judge holds the next run to — so a
 * later edit to the markdown that changes the conclusion shows up as a red
 * case rather than as a customer noticing. Appends to the target's
 * regressions file when there is one, so a flow collects its cases in one
 * place instead of one file per press.
 */
export function promoteRunToEval(
  tenant: string,
  workspace: string,
  runId: string,
  /** `should`: what a run that went wrong should have done, in a sentence —
   *  the judge's claim for the case (FOL-72 step 10). */
  opts: { evalName?: string; caseName?: string; expect?: string[]; should?: string; by?: string } = {},
): { file: string; created: boolean; caseName: string } {
  const run = readRun(tenant, workspace, runId);
  if (!run) throw refuse(`run ${runId} not found`, 404);
  if (run.status !== "completed" && run.status !== "failed") {
    throw refuse(`only a finished run can become an eval — this one is ${run.status}`, 409);
  }
  // A run that went wrong is the test worth having most — but its own answer
  // is the wrong one to hold the next run to, so it needs to be told what
  // was right (FOL-72 step 10).
  const should = oneLine(opts.should ?? "");
  const wentWrong = run.status === "failed" || ["BAD", "BLOCKED"].includes(runVerdict(run) ?? "");
  if (wentWrong && !should && !(opts.expect && opts.expect.length)) {
    throw refuse("this run went wrong, so its answer is not the one to keep — say what it should have done (`should`, a sentence for the judge) or give `expect` lines", 409);
  }
  const produced = run.steps.filter((s) => (s.result ?? "").trim());
  const last = produced[produced.length - 1];
  if (!last && !should && !(opts.expect && opts.expect.length)) throw refuse("this run produced no result to hold the next one to", 409);
  if (run.steps.length === 0 || !run.steps[0].instruction?.trim()) {
    throw refuse("this run has no task on record", 409);
  }
  if (run.flow.startsWith("eval:")) {
    throw refuse("this run was itself an eval case — promote the run it was checking", 409);
  }

  // The target: the agent for a direct run, the flow otherwise.
  const target = run.flow.startsWith("adhoc:")
    ? { kind: "agent" as const, name: run.flow.slice("adhoc:".length) }
    : { kind: "flow" as const, name: run.flow };
  assertSafeName(target.name, target.kind);

  const evalName = opts.evalName ?? `${target.name}-regressions`;
  assertSafeName(evalName, "eval name");
  const rel = `evals/${evalName}.md`;
  const abs = path.join(workspaceDir(tenant, workspace), rel);
  const existing = fs.existsSync(abs) ? fs.readFileSync(abs, "utf8") : null;

  // The expectations, checked before anything is written: a line the
  // parser would skip is a case that passes on nothing.
  let expect: string[];
  if (opts.expect && opts.expect.length > 0) {
    expect = opts.expect.map((line) => {
      const m = oneLine(line).match(/^([a-z-]+):(.*)$/);
      if (m) m[2] = m[2].trim();
      if (!m || !(ASSERTION_TYPES as readonly string[]).includes(m[1]) || !m[2]) {
        throw refuse(
          `"${line}" is not an assertion — expected one of ${ASSERTION_TYPES.map((t) => `${t}:`).join(", ")} followed by a value`,
          400,
        );
      }
      return `${m[1]}: ${m[2]}`;
    });
  } else if (should) {
    expect = [`judge: ${should.slice(0, 400)}`];
  } else {
    const conclusion = oneLine(run.summary?.trim() || (last!.result ?? "")).slice(0, 200);
    expect = [`judge: reaches the same conclusion as the recorded run: ${conclusion}`];
  }

  // The case name: what the caller said, else the run and the day it ran —
  // made unique in the file, so promoting the same run twice reads as two
  // cases rather than one case declared twice.
  const taken = new Set(existing ? parseEval(rel, existing).cases.map((c) => c.name) : []);
  const base = oneLine(opts.caseName ?? "") || `run ${run.id} (${run.startedAt.slice(0, 10)})`;
  let caseName = base;
  for (let n = 2; taken.has(caseName); n++) caseName = `${base} (${n})`;

  const task = taskOf(run.steps[0].instruction);
  if (!task) throw refuse("this run has no task on record", 409);
  const caseText =
    `## ${caseName}\n${layoutTask(task)}\nexpect:\n${expect.map((e) => `  - ${e}`).join("\n")}\n`;

  let content: string;
  if (existing) {
    // Appending to a file that tests something else would run this case
    // against the wrong target and call the result a regression.
    const info = parseEval(rel, existing);
    const points = info.flow ? { kind: "flow", name: info.flow } : { kind: "agent", name: info.agent };
    if (points.kind !== target.kind || points.name !== target.name) {
      throw refuse(
        `${rel} tests ${points.kind} ${points.name ?? "(nothing)"}, not ${target.kind} ${target.name} — pick another evalName`,
        409,
      );
    }
    content = `${existing.trimEnd()}\n\n${caseText}`;
  } else {
    // A flow eval costs a whole run and touches real systems, so it waits
    // for a person to press Run rather than following every push.
    const front =
      `---\nname: ${evalName}\n${target.kind}: ${target.name}\nmodel: fast\n` +
      (target.kind === "flow" ? "trigger: manual\n" : "") +
      `---\n`;
    content = `${front}\n${caseText}`;
  }

  // Read it back the way the runner will before it is written: a case the
  // parser holds differently from what was meant is not a test of anything.
  const written = parseEval(rel, content).cases.find((c) => c.name === caseName);
  const wanted = task
    .split("\n")
    .map((l) => l.replace(/^(\s*)-\s/, "$1* ").trim())
    .filter(Boolean)
    .join("\n");
  if (!written || written.task !== wanted || written.expect.length !== expect.length) {
    throw refuse("the task on this run cannot be written in the eval format as it stands", 400);
  }

  writeWorkspaceFile(tenant, workspace, rel, content, {
    by: opts.by,
    message: `${existing ? "added a case to" : "created"} ${rel} from run ${run.id}`,
  });
  return { file: rel, created: !existing, caseName };
}

// ---------- running ----------

export interface AssertionResult {
  assertion: Assertion;
  passed: boolean;
  detail: string;
  /** What a judge cost, USD; absent for the free checks. */
  costUsd?: number;
}

export interface CaseResult {
  name: string;
  task: string;
  runId: string | null;
  passed: boolean;
  /** Set when the agent itself failed, before any assertion could run. */
  error: string | null;
  assertions: AssertionResult[];
  /** What the case's run cost — the subject, not the judge. */
  costUsd: number;
  /** What its judges cost, USD. Absent on results from before 24 Oct 2026. */
  judgeCostUsd?: number;
  /** How long the run took from a worker picking it up to its end — its
   *  time in the queue left out, so a busy account does not read as a slow
   *  model. Null when it never ran. */
  secs?: number | null;
}

/** How a model comparison (eval-compare.ts) runs one eval: every step it
 *  forces onto a model, always as a test run, and whether to go on. */
export interface EvalRunOptions {
  /** Forced onto the subject's steps — every step of a flow eval, or only
   *  `agent`'s when it is set — as a step-level setting, so it wins over
   *  the agent's own `model:` and the flow's defaults. `effort` likewise
   *  when given; none keeps each step's own effort, so a model-only
   *  comparison changes the model and nothing else. */
  model?: string;
  effort?: Effort | null;
  agent?: string | null;
  /** A test run whatever the eval or flow says about `live:`. */
  forceTest?: boolean;
  /** Asked before each case; a reason stops the eval there, the rest of its
   *  cases recorded as not run with it. */
  beforeCase?: () => string | null;
  /** Told each case as it ends — what a comparison counts its spend by, so
   *  its limit holds between the cases of one setting, not only after. */
  afterCase?: (c: CaseResult) => void;
}

export interface EvalResult {
  eval: string;
  startedAt: string;
  finishedAt: string;
  passed: number;
  failed: number;
  costUsd: number;
  cases: CaseResult[];
  /** Why the eval could not run at all — a missing secret, an agent that
   *  failed to load. Set only when `cases` is empty for that reason, so a
   *  0-of-n result says what went wrong instead of looking like n wrong
   *  answers. */
  error?: string;
}

/**
 * A web replica never drives a run: it has no route to the cluster API and
 * no right to create a pod, by design — so an eval started there (a push,
 * the Run button) queues its run for the worker like any other. From 29 Aug
 * every eval on the split platform died at "pod create failed: connection
 * refused" for exactly this reason. A single process — the CLI, a laptop,
 * no platform registered — still drives it right here, as it always did.
 *
 * The test is whether a platform owns the queue, not which role this
 * process was started as: on a worker the role read "worker", the eval
 * started its run in-process, and the run never passed through the
 * account cap or the lanes the platform enforces on every other run.
 */
const runsViaQueue = () => platformQueues();

async function beginEvalRun(
  tenant: string,
  workspace: string,
  steps: FlowStep[],
  flowName: string,
  model?: string | null,
  effort?: string | null,
  test = true,
) {
  if (!runsViaQueue()) return startFlowRun(tenant, workspace, steps, flowName, model, [], effort, null, { test });
  // The job carries a model override but no effort one, and driveRun cannot
  // re-read a flow called `eval:<name>`. Put the flow's defaults onto the
  // steps that have none — which is what nearest-wins resolves to anyway.
  const withDefaults = steps.map((s) => ({
    ...s,
    ...(s.model || !model ? {} : { model }),
    ...(s.effort || !effort ? {} : { effort }),
  }));
  return platform.enqueueFlowRun(tenant, workspace, withDefaults, flowName, model ?? null, [], null, { test });
}

// Waits for as long as the run runs. There was a cap here (5 minutes, then
// 30) and it marked a flow eval "run disappeared" at the cap while the flow
// carried on for another half hour — the eval failed for a reason that had
// nothing to do with the flow. The run is the thing that is bounded, by the
// flow's own step timeouts; the eval just watches it.
async function waitForRun(tenant: string, workspace: string, runId: string) {
  for (;;) {
    const run = readRun(tenant, workspace, runId);
    if (!run) return null;
    if (run.finishedAt) return run;
    // An eval never answers an approval gate: a test that needs a human isn't
    // a test. Fail it clearly instead of waiting.
    if (run.status === "awaiting-approval") return run;
    await new Promise((r) => setTimeout(r, 1000));
  }
}

function shell(command: string, cwd: string): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const child = spawn("bash", ["-lc", command], { cwd });
    let out = "";
    const append = (c: Buffer) => {
      if (out.length < 2000) out += c.toString();
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    child.on("close", (code) => resolve({ code, out: out.trim() }));
    child.on("error", (err) => resolve({ code: null, out: String(err) }));
  });
}

// The judge gets the rubric and the output, and ends with one word.
// Constrained output beats asking for a score: "PASS" or "FAIL" can't be
// misread, where "7/10" needs a threshold nobody agreed on. The word comes
// LAST, after the reasoning: asked for it first, the judge committed before
// it had looked, then argued the other way — "FAIL … which meets the
// criterion" (vaza evals, 21 Oct 2026).
/** How long one judge may take before it is cut off: a verdict on one
 *  sentence is seconds; a stalled model must not hold a grade pass. */
export const JUDGE_TIMEOUT_MS = 120_000;

/** One judge call: its words and what it cost (the SDK's result line). */
export async function judgeCall(
  rubric: string,
  output: string,
  model: string,
  effort: Effort | null,
  env: Record<string, string | undefined>,
  /** What the output was an answer to — a live run's task, so the judge
   *  grades the reply against what was asked rather than in a vacuum. */
  context?: string,
): Promise<{ text: string; costUsd: number }> {
  const prompt =
    `You are grading one piece of output against one criterion. ${JUDGE_VERDICT_INSTRUCTION}\n\n` +
    `Criterion: ${rubric}\n\n` +
    (context ? `<task>\n${context.slice(0, 4000)}\n</task>\n\n` : "") +
    `<output>\n${output.slice(0, 20000)}\n</output>`;

  let text = "";
  let costUsd = 0;
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), JUDGE_TIMEOUT_MS);
  timer.unref?.();
  try {
    const q = query({
      prompt,
      options: {
        model,
        ...(effort ? { effort } : {}),
        tools: [],
        allowedTools: [],
        settingSources: [],
        strictMcpConfig: true,
        env,
        maxTurns: 1,
        abortController: abort,
      },
    });
    for await (const message of q) {
      if (message.type === "assistant") {
        for (const block of message.message.content) {
          if (block.type === "text") text += block.text;
        }
      } else if (message.type === "result") {
        costUsd = Number((message as { total_cost_usd?: number }).total_cost_usd) || 0;
      }
    }
  } catch (err) {
    if (abort.signal.aborted) throw new Error(`the judge took longer than ${JUDGE_TIMEOUT_MS / 1000}s and was stopped`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
  return { text: text.trim(), costUsd };
}


/**
 * The judge's environment: this process's, with the platform's model
 * credential read live. The process's own CLAUDE_CODE_OAUTH_TOKEN is the copy
 * it was handed at boot; the box refreshes the login every four hours and the
 * old token is then revoked, so a judge on the boot copy failed with "OAuth
 * token revoked" from the first refresh until the pod restarted, while the
 * agent steps (which read the live file) kept working (2026-10-21).
 */
export function judgeProcessEnv(): Record<string, string | undefined> {
  const live = Object.fromEntries(Object.entries(platformModelEnv()).filter(([, v]) => v !== undefined));
  return sdkEnv({ ...process.env, ...live });
}

export async function checkAssertion(
  assertion: Assertion,
  output: string,
  agentDir: string,
  model: string,
  effort: Effort | null,
  judgeEnv: () => { env: Record<string, string | undefined>; translator?: TranslatorSpec | null } = () => ({ env: judgeProcessEnv() }),
): Promise<AssertionResult> {
  const hay = output.toLowerCase();
  switch (assertion.type) {
    case "contains": {
      const passed = hay.includes(assertion.value.toLowerCase());
      return { assertion, passed, detail: passed ? "found" : `"${assertion.value}" not in the output` };
    }
    case "not-contains": {
      const passed = !hay.includes(assertion.value.toLowerCase());
      return { assertion, passed, detail: passed ? "absent" : `"${assertion.value}" appeared` };
    }
    case "matches": {
      try {
        const passed = new RegExp(assertion.value, "i").test(output);
        return { assertion, passed, detail: passed ? "matched" : "no match" };
      } catch {
        return { assertion, passed: false, detail: "invalid regular expression" };
      }
    }
    case "file": {
      const target = path.resolve(agentDir, assertion.value);
      if (!target.startsWith(path.resolve(agentDir))) {
        return { assertion, passed: false, detail: "path escapes the agent directory" };
      }
      const exists = fs.existsSync(target) && fs.statSync(target).size > 0;
      return { assertion, passed: exists, detail: exists ? "present and non-empty" : "missing or empty" };
    }
    case "run": {
      const { code, out } = await shell(assertion.value, agentDir);
      return { assertion, passed: code === 0, detail: `exit ${code ?? "error"}${out ? ` — ${out.slice(0, 200)}` : ""}` };
    }
    case "judge": {
      // The judge runs on the account's own model key, never quietly on the
      // platform's: a customer's eval is not the operator's bill.
      let m: ReturnType<typeof judgeEnv>;
      try {
        m = judgeEnv();
      } catch (err) {
        return { assertion, passed: false, detail: `judge not run — ${err instanceof Error ? err.message : String(err)}` };
      }
      const said = await withModelEnv(m, (env) => judgeCall(assertion.value, output, model, effort, env));
      const { passed, detail } = judgeVerdict(said.text);
      return { assertion, passed, detail, costUsd: said.costUsd };
    }
  }
}

export async function runEval(
  tenant: string,
  workspace: string,
  info: EvalInfo,
  opts: EvalRunOptions = {},
): Promise<EvalResult> {
  if (info.trigger === "runs") {
    throw refuse(`${info.name} grades real runs (trigger: runs) — it has no cases to run; grade a run with POST …/evals/${info.name}/grade { run }`, 400);
  }
  const startedAt = new Date().toISOString();
  const results: CaseResult[] = [];
  // Saved inputs carry no assertions: running them would start and bill a
  // run per case only to report every one failed. Nothing to grade.
  const cases = info.inputs ? [] : info.cases;

  for (const testCase of cases) {
    const target = info.flow ? null : info.agent;
    let runId: string | null = null;
    let output = "";
    let error: string | null = null;
    let costUsd = 0;
    let secs: number | null = null;
    const stop = opts.beforeCase?.() ?? null;
    if (stop) {
      results.push({ name: testCase.name, task: testCase.task, runId: null, error: `not run — ${stop}`, passed: false, assertions: [], costUsd: 0, judgeCostUsd: 0, secs: null });
      continue;
    }
    // A step forced onto the comparison's model: step-level, so it wins.
    const force = <S extends FlowStep>(st: S): S =>
      opts.model && (!opts.agent || st.agent === opts.agent)
        ? { ...st, model: opts.model, ...(opts.effort ? { effort: opts.effort } : {}) }
        : st;

    try {
      let run;
      if (info.flow) {
        const flow = loadFlow(tenant, workspace, info.flow);
        if (!flow || flow.steps.length === 0) throw new Error(`flow ${info.flow} not found or empty`);
        // The case's task reaches the first step; output passing carries it on.
        const steps = flow.steps.map((s, i) =>
          force(i === 0
            ? { ...s, instruction: `${s.instruction}\n\n<run_task>\n${testCase.task}\n</run_task>` }
            : s),
        );
        // Test unless the eval OR the flow says live: an eval that runs a
        // flow written `live: true` was written by someone who knew. A
        // comparison is a test whatever they say.
        run = await beginEvalRun(tenant, workspace, steps, `eval:${info.name}`, flow.model, flow.effort, opts.forceTest ? true : !(info.live || flow.live));
      } else {
        if (!target) throw new Error("this eval names neither an agent nor a flow");
        run = await beginEvalRun(
          tenant,
          workspace,
          [force({ agent: target, instruction: testCase.task, group: 1, optional: false } as FlowStep)],
          `eval:${info.name}`,
          undefined,
          undefined,
          opts.forceTest ? true : !info.live,
        );
      }
      runId = run.id;
      const finished = await waitForRun(tenant, workspace, run.id);
      if (!finished) throw new Error("run disappeared");
      // What the steps before a gate spent is spent: counted before the
      // gate is refused, so a comparison's limit sees it.
      costUsd = finished.steps.reduce((sum, s) => sum + (s.costUsd ?? 0), 0);
      if (finished.status === "awaiting-approval") {
        throw new Error("this run pauses for approval — an eval cannot answer a human gate");
      }
      output = finished.steps.map((s) => s.result ?? "").join("\n\n");
      const from = Date.parse(finished.drivenAt ?? finished.startedAt);
      const to = finished.finishedAt ? Date.parse(finished.finishedAt) : NaN;
      secs = Number.isFinite(from) && Number.isFinite(to) ? Math.max(0, Math.round((to - from) / 100) / 10) : null;
      if (finished.status === "failed" && !output.trim()) {
        // Quote the run's own last error. "Produced nothing" on a fresh
        // workspace is almost always "secret X is not set" or a tool that
        // did not load, and the eval page is where the developer is looking.
        const why = finished.steps
          .flatMap((s) => s.events ?? [])
          .filter((e) => e.type === "error")
          .map((e) => e.text.split("\n")[0].slice(0, 300))
          .pop();
        error = why ? `the run failed: ${why}` : "the run failed and produced nothing";
      }
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }

    const agentDir = path.join(workspaceDir(tenant, workspace), "agents", target ?? "");
    const assertions: AssertionResult[] = [];
    if (!error) {
      // Cheap checks first; the judge only runs once they've all passed, so a
      // clearly-wrong answer never costs a model call.
      const cheap = testCase.expect.filter((a) => a.type !== "judge");
      const judges = testCase.expect.filter((a) => a.type === "judge");
      for (const a of cheap) assertions.push(await checkAssertion(a, output, agentDir, info.model, info.effort));
      if (assertions.every((r) => r.passed)) {
        const judgeEnv = () => accountModelEnv(tenant, workspace, judgeProcessEnv);
        for (const a of judges) assertions.push(await checkAssertion(a, output, agentDir, info.model, info.effort, judgeEnv));
      } else {
        for (const a of judges) {
          assertions.push({ assertion: a, passed: false, detail: "not run — an earlier check failed" });
        }
      }
    }

    results.push({
      name: testCase.name,
      task: testCase.task,
      runId,
      error,
      passed: !error && assertions.length > 0 && assertions.every((r) => r.passed),
      assertions,
      costUsd,
      judgeCostUsd: Math.round(assertions.reduce((n, a) => n + (a.costUsd ?? 0), 0) * 1e6) / 1e6,
      secs,
    });
    opts.afterCase?.(results[results.length - 1]);
  }

  return {
    eval: info.name,
    startedAt,
    finishedAt: new Date().toISOString(),
    passed: results.filter((r) => r.passed).length,
    failed: results.filter((r) => !r.passed).length,
    costUsd: results.reduce((sum, r) => sum + r.costUsd, 0),
    cases: results,
  };
}

/**
 * The latest result, and one line of history.
 *
 * `<eval>.json` is the latest run, overwritten each time — what the evals
 * page shows. `history.jsonl` is every run, one line each, stamped with the
 * commit the workspace was running. That stamp is the whole feature: a score
 * with no commit says quality changed; a score with one says WHICH change.
 * Manual runs are stamped too — the commit on record is whatever deploy put
 * there — so a button press and a post-deploy run land in the same series.
 */
export function writeEvalResult(
  tenant: string,
  workspace: string,
  result: EvalResult,
  // A deployed commit when there is one; otherwise the latest revision —
  // so a workspace that has never seen a git repository still gets a
  // series with ids in it, and the "this change made it worse" table works.
  commit: string | null = deployedCommit(tenant, workspace)?.commit ?? latestRevisionId(tenant, workspace),
) {
  const dir = path.join(workspaceDir(tenant, workspace), "evals", ".results");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${result.eval}.json`), JSON.stringify(result, null, 2));
  const line: EvalHistoryEntry = {
    eval: result.eval,
    at: result.finishedAt,
    commit,
    passed: result.passed,
    failed: result.failed,
    costUsd: result.costUsd,
  };
  fs.appendFileSync(path.join(dir, "history.jsonl"), `${JSON.stringify(line)}\n`);
}

export interface EvalHistoryEntry {
  eval: string;
  at: string;
  /** The commit the workspace was running. Null on an install that has
   *  never deployed from git — the series still exists, just unattributed. */
  commit: string | null;
  passed: number;
  failed: number;
  costUsd: number;
}

export function readEvalHistory(tenant: string, workspace: string): EvalHistoryEntry[] {
  const file = path.join(workspaceDir(tenant, workspace), "evals", ".results", "history.jsonl");
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .flatMap((l) => {
      try {
        return [JSON.parse(l) as EvalHistoryEntry];
      } catch {
        return []; // a torn line from a crash mid-append is not a reason to lose the rest
      }
    });
}

export interface EvalTrend {
  eval: string;
  /** Newest first. */
  latest: EvalHistoryEntry;
  /** The most recent run on a DIFFERENT commit — the comparison that names a
   *  change. Null when every run so far was on the same commit. */
  previous: EvalHistoryEntry | null;
  /** Pass count now minus pass count on the previous commit. */
  delta: number | null;
}

/**
 * Per eval: where it stands, and against which commit that is a change.
 *
 * Compares to the last run on a different commit rather than the last run,
 * because two runs on one commit differ only by the model's mood — and a
 * "regression" that is really variance would teach people to ignore the
 * real ones.
 */
export function evalTrends(tenant: string, workspace: string): EvalTrend[] {
  const history = readEvalHistory(tenant, workspace).sort((a, b) => b.at.localeCompare(a.at));
  const byEval = new Map<string, EvalHistoryEntry[]>();
  for (const h of history) {
    if (!byEval.has(h.eval)) byEval.set(h.eval, []);
    byEval.get(h.eval)!.push(h);
  }
  return [...byEval.entries()]
    .map(([name, runs]) => {
      const latest = runs[0];
      const previous = runs.find((r) => r.commit !== latest.commit) ?? null;
      return {
        eval: name,
        latest,
        previous,
        delta: previous ? latest.passed - previous.passed : null,
      };
    })
    .sort((a, b) => (a.delta ?? 0) - (b.delta ?? 0) || a.eval.localeCompare(b.eval));
}

/**
 * Run every eval against what was just deployed, stamped with its commit.
 *
 * Fire-and-forget from the deploy: a deploy answers in milliseconds and an
 * eval takes minutes and money, so the two are never in one request. Runs
 * one at a time — evals are model calls and a deploy should not fan out
 * into all of them at once. A second deploy while one is still evaluating
 * waits its turn behind the lock rather than doubling the spend.
 */
export async function evaluateDeployed(
  tenant: string,
  workspace: string,
  // The commit when the deploy knows one (a git push, `deploy --commit`);
  // otherwise the revision the save just recorded. A plain `foldrun deploy`
  // passes no commit, and until this defaulted the eval never ran for it —
  // "every deploy is evaluated" was true only of pushes.
  commit: string | null = null,
): Promise<{ ran: number; skipped: string | null }> {
  const stamp = commit ?? deployedCommit(tenant, workspace)?.commit ?? latestRevisionId(tenant, workspace);
  if (!stamp) return { ran: 0, skipped: "no revision to stamp the result with" };
  // Only the evals that asked to run on deploy — a `trigger: manual` eval is
  // one a person runs on purpose, because it costs a whole flow run, and a
  // `trigger: runs` one grades real runs and has no cases to run.
  const evals = listEvals(tenant, workspace).filter((e) => e.trigger === "deploy" && !e.inputs);
  if (evals.length === 0) return { ran: 0, skipped: "no evals" };
  const dir = path.join(workspaceDir(tenant, workspace), "evals", ".results");
  fs.mkdirSync(dir, { recursive: true });
  const lock = path.join(dir, ".evaluating");
  // A lock older than an hour is a crash, not a run.
  try {
    if (Date.now() - fs.statSync(lock).mtimeMs < 60 * 60_000) {
      return { ran: 0, skipped: "evals already running for an earlier deploy" };
    }
  } catch {
    // no lock
  }
  fs.writeFileSync(lock, stamp);
  let ran = 0;
  try {
    for (const info of evals) {
      try {
        const result = await runEval(tenant, workspace, info);
        writeEvalResult(tenant, workspace, result, stamp);
        ran += 1;
      } catch (err) {
        // One eval failing to run must not stop the rest; it is recorded as
        // a run with nothing passing, so the series shows the gap — and with
        // the reason, so "0 of 2" on a fresh workspace reads "secret
        // LINKEDIN_OAUTH is not set" rather than "two wrong answers".
        writeEvalResult(
          tenant,
          workspace,
          {
            eval: info.name,
            startedAt: new Date().toISOString(),
            finishedAt: new Date().toISOString(),
            passed: 0,
            failed: info.cases.length,
            costUsd: 0,
            cases: [],
            error: err instanceof Error ? err.message : String(err),
          } as EvalResult,
          stamp,
        );
      }
    }
  } finally {
    fs.rmSync(lock, { force: true });
  }
  return { ran, skipped: null };
}

export function readEvalResult(tenant: string, workspace: string, name: string): EvalResult | null {
  try {
    assertSafeName(name, "eval");
    const file = path.join(workspaceDir(tenant, workspace), "evals", ".results", `${name}.json`);
    return fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, "utf8")) as EvalResult) : null;
  } catch {
    return null;
  }
}
