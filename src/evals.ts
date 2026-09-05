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

import fs from "node:fs";
import path from "node:path";
import { deployedCommit } from "./deploy.ts";
import { latestRevisionId } from "./history.ts";
import matter from "gray-matter";
import { spawn } from "node:child_process";
import { query } from "@anthropic-ai/claude-agent-sdk";
import {
  workspaceDir,
  readRun,
  writeWorkspaceFile,
  resolveModel,
  resolveEffort,
  assertSafeName,
  type Effort,
} from "./store.ts";
import { startFlowRun, loadFlow } from "./runner.ts";
import { platform } from "./platform.ts";
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
   *  eval that costs a whole run and touches real systems every time. */
  trigger: "deploy" | "manual";
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

export function parseEval(file: string, raw: string): EvalInfo {
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

  return {
    name: data.name ?? file.replace(/\.md$/, ""),
    file,
    agent: typeof data.agent === "string" ? data.agent : null,
    flow: typeof data.flow === "string" ? data.flow : null,
    model: resolveModel(data.model ?? "fast"),
    effort: resolveEffort(data.effort ?? "low"),
    trigger: data.trigger === "manual" ? "manual" : "deploy",
    cases,
  };
}

export function listEvals(tenant: string, workspace: string): EvalInfo[] {
  const dir = path.join(workspaceDir(tenant, workspace), "evals");
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .sort()
    .map((f) => parseEval(f, fs.readFileSync(path.join(dir, f), "utf8")));
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
  opts: { evalName?: string; caseName?: string; expect?: string[]; by?: string } = {},
): { file: string; created: boolean; caseName: string } {
  const run = readRun(tenant, workspace, runId);
  if (!run) throw refuse(`run ${runId} not found`, 404);
  if (run.status !== "completed") {
    throw refuse(`only a completed run can become an eval — this one is ${run.status}`, 409);
  }
  const produced = run.steps.filter((s) => (s.result ?? "").trim());
  const last = produced[produced.length - 1];
  if (!last) throw refuse("this run produced no result to hold the next one to", 409);
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
      const m = oneLine(line).match(/^([a-z-]+):\s*(.*)$/);
      if (!m || !(ASSERTION_TYPES as readonly string[]).includes(m[1]) || !m[2]) {
        throw refuse(
          `"${line}" is not an assertion — expected one of ${ASSERTION_TYPES.map((t) => `${t}:`).join(", ")} followed by a value`,
          400,
        );
      }
      return `${m[1]}: ${m[2]}`;
    });
  } else {
    const conclusion = oneLine(run.summary?.trim() || (last.result ?? "")).slice(0, 200);
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
    content = `${existing.replace(/\s+$/, "")}\n\n${caseText}`;
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
}

export interface CaseResult {
  name: string;
  task: string;
  runId: string | null;
  passed: boolean;
  /** Set when the agent itself failed, before any assertion could run. */
  error: string | null;
  assertions: AssertionResult[];
  costUsd: number;
}

export interface EvalResult {
  eval: string;
  startedAt: string;
  finishedAt: string;
  passed: number;
  failed: number;
  costUsd: number;
  cases: CaseResult[];
}

/** Wait for a run to finish, with a ceiling so a hung agent can't hang an eval. */
/**
 * A web replica never drives a run: it has no route to the cluster API and
 * no right to create a pod, by design — so an eval started there (a push,
 * the Run button) queues its run for the worker like any other. From 29 Aug
 * every eval on the split platform died at "pod create failed: connection
 * refused" for exactly this reason. A single process — the CLI, a laptop,
 * FOLDRUN_ROLE unset — still drives it right here, as it always did.
 */
const runsViaQueue = () => process.env.FOLDRUN_ROLE === "web";

async function beginEvalRun(
  tenant: string,
  workspace: string,
  steps: FlowStep[],
  flowName: string,
  model?: string | null,
  effort?: string | null,
) {
  if (!runsViaQueue()) return startFlowRun(tenant, workspace, steps, flowName, model, [], effort);
  // The job carries a model override but no effort one, and driveRun cannot
  // re-read a flow called `eval:<name>`. Put the flow's defaults onto the
  // steps that have none — which is what nearest-wins resolves to anyway.
  const withDefaults = steps.map((s) => ({
    ...s,
    ...(s.model || !model ? {} : { model }),
    ...(s.effort || !effort ? {} : { effort }),
  }));
  return platform.enqueueFlowRun(tenant, workspace, withDefaults, flowName, model ?? null, []);
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

// The judge gets the rubric and the output, and must answer with one word.
// Constrained output beats asking for a score: "PASS" or "FAIL" can't be
// misread, where "7/10" needs a threshold nobody agreed on.
async function judge(
  rubric: string,
  output: string,
  model: string,
  effort: Effort | null,
): Promise<AssertionResult["detail"] & string> {
  const prompt =
    `You are grading one piece of output against one criterion. Answer with exactly ` +
    `PASS or FAIL on the first line, then one short sentence of reason.\n\n` +
    `Criterion: ${rubric}\n\n<output>\n${output.slice(0, 20000)}\n</output>`;

  let text = "";
  const q = query({
    prompt,
    options: {
      model,
      ...(effort ? { effort } : {}),
      tools: [],
      allowedTools: [],
      settingSources: [],
      maxTurns: 1,
    },
  });
  for await (const message of q) {
    if (message.type === "assistant") {
      for (const block of message.message.content) {
        if (block.type === "text") text += block.text;
      }
    }
  }
  return text.trim();
}

async function checkAssertion(
  assertion: Assertion,
  output: string,
  agentDir: string,
  model: string,
  effort: Effort | null,
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
      const verdict = await judge(assertion.value, output, model, effort);
      const passed = /^\s*PASS\b/i.test(verdict);
      return { assertion, passed, detail: verdict.slice(0, 300) || "judge returned nothing" };
    }
  }
}

export async function runEval(
  tenant: string,
  workspace: string,
  info: EvalInfo,
): Promise<EvalResult> {
  const startedAt = new Date().toISOString();
  const results: CaseResult[] = [];

  for (const testCase of info.cases) {
    const target = info.flow ? null : info.agent;
    let runId: string | null = null;
    let output = "";
    let error: string | null = null;
    let costUsd = 0;

    try {
      let run;
      if (info.flow) {
        const flow = loadFlow(tenant, workspace, info.flow);
        if (!flow || flow.steps.length === 0) throw new Error(`flow ${info.flow} not found or empty`);
        // The case's task reaches the first step; output passing carries it on.
        const steps = flow.steps.map((s, i) =>
          i === 0
            ? { ...s, instruction: `${s.instruction}\n\n<run_task>\n${testCase.task}\n</run_task>` }
            : s,
        );
        run = await beginEvalRun(tenant, workspace, steps, `eval:${info.name}`, flow.model, flow.effort);
      } else {
        if (!target) throw new Error("this eval names neither an agent nor a flow");
        run = await beginEvalRun(
          tenant,
          workspace,
          [{ agent: target, instruction: testCase.task, group: 1, optional: false }],
          `eval:${info.name}`,
        );
      }
      runId = run.id;
      const finished = await waitForRun(tenant, workspace, run.id);
      if (!finished) throw new Error("run disappeared");
      if (finished.status === "awaiting-approval") {
        throw new Error("this run pauses for approval — an eval cannot answer a human gate");
      }
      output = finished.steps.map((s) => s.result ?? "").join("\n\n");
      costUsd = finished.steps.reduce((sum, s) => sum + (s.costUsd ?? 0), 0);
      if (finished.status === "failed" && !output.trim()) error = "the run failed and produced nothing";
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
        for (const a of judges) assertions.push(await checkAssertion(a, output, agentDir, info.model, info.effort));
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
    });
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
  commit: string,
): Promise<{ ran: number; skipped: string | null }> {
  // Only the evals that asked to run on deploy — a `trigger: manual` eval is
  // one a person runs on purpose, because it costs a whole flow run.
  const evals = listEvals(tenant, workspace).filter((e) => e.trigger !== "manual");
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
  fs.writeFileSync(lock, commit);
  let ran = 0;
  try {
    for (const info of evals) {
      try {
        const result = await runEval(tenant, workspace, info);
        writeEvalResult(tenant, workspace, result, commit);
        ran += 1;
      } catch (err) {
        // One eval failing to run must not stop the rest; it is recorded as
        // a run with nothing passing, so the series shows the gap.
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
          } as EvalResult,
          commit,
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
