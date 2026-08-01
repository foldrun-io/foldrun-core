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
import matter from "gray-matter";
import { spawn } from "node:child_process";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { workspaceDir, readRun, resolveModel, assertSafeName } from "./store.ts";
import { startFlowRun, loadFlow } from "./runner.ts";

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
  cases: EvalCase[];
}

const ASSERTION_TYPES = ["contains", "not-contains", "matches", "file", "run", "judge"] as const;

export function parseEval(file: string, raw: string): EvalInfo {
  const { data, content } = matter(raw);
  const cases: EvalCase[] = [];
  let current: EvalCase | null = null;
  let inExpect = false;

  for (const line of content.split("\n")) {
    const heading = line.match(/^##\s+(?:case:\s*)?(.+?)\s*$/);
    if (heading) {
      if (current) cases.push(current);
      current = { name: heading[1], task: "", expect: [] };
      inExpect = false;
      continue;
    }
    if (!current) continue;

    const task = line.match(/^\s*task:\s*(.+)$/);
    if (task) {
      current.task = task[1].trim();
      inExpect = false;
      continue;
    }
    if (/^\s*expect:\s*$/.test(line)) {
      inExpect = true;
      continue;
    }
    if (inExpect) {
      const item = line.match(/^\s*-\s*([a-z-]+):\s*(.+)$/);
      if (item && (ASSERTION_TYPES as readonly string[]).includes(item[1])) {
        current.expect.push({
          type: item[1] as Assertion["type"],
          value: item[2].trim().replace(/^["']|["']$/g, ""),
        } as Assertion);
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
async function waitForRun(tenant: string, workspace: string, runId: string, timeoutMs = 300_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const run = readRun(tenant, workspace, runId);
    if (run?.finishedAt) return run;
    // An eval never answers an approval gate: a test that needs a human isn't
    // a test. Fail it clearly instead of waiting for a timeout.
    if (run?.status === "awaiting-approval") return run;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return readRun(tenant, workspace, runId);
}

function shell(command: string, cwd: string): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const child = spawn("bash", ["-lc", command], { cwd, timeout: 60_000 });
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
async function judge(rubric: string, output: string, model: string): Promise<AssertionResult["detail"] & string> {
  const prompt =
    `You are grading one piece of output against one criterion. Answer with exactly ` +
    `PASS or FAIL on the first line, then one short sentence of reason.\n\n` +
    `Criterion: ${rubric}\n\n<output>\n${output.slice(0, 20000)}\n</output>`;

  let text = "";
  const q = query({
    prompt,
    options: { model, tools: [], allowedTools: [], settingSources: [], maxTurns: 1 },
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
      const verdict = await judge(assertion.value, output, model);
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
        run = startFlowRun(tenant, workspace, steps, `eval:${info.name}`, flow.model);
      } else {
        if (!target) throw new Error("this eval names neither an agent nor a flow");
        run = startFlowRun(
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
      for (const a of cheap) assertions.push(await checkAssertion(a, output, agentDir, info.model));
      if (assertions.every((r) => r.passed)) {
        for (const a of judges) assertions.push(await checkAssertion(a, output, agentDir, info.model));
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

export function writeEvalResult(tenant: string, workspace: string, result: EvalResult) {
  const dir = path.join(workspaceDir(tenant, workspace), "evals", ".results");
  fs.mkdirSync(dir, { recursive: true });
  assertSafeName(result.eval, "eval");
  fs.writeFileSync(path.join(dir, `${result.eval}.json`), JSON.stringify(result, null, 2));
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
