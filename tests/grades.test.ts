// Grading live runs — evals with `trigger: runs`.
//
//   node --test tests/grades.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.FOLDRUN_HISTORY = "journal";

import { parseEval, listEvals, runEval, evaluateDeployed } from "../src/evals.ts";
import { gradeRun, recordGrade, readGrades, gradeWorkspace, gradeCandidates, sampled, summariseGrades, gradesOfRun, graderSince, listGraders, type Grade } from "../src/grades.ts";
import { writeRun, readRun, type RunRecord } from "../src/store.ts";
import { checkFiles } from "../src/deploy.ts";

const T = "acme";
const W = "desk";

function withWorkspace(body: (ws: string) => Promise<void> | void) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-grades-"));
  const previous = process.env.FOLDRUN_DATA;
  const previousWs = process.env.FOLDRUN_WORKSPACE;
  process.env.FOLDRUN_DATA = root;
  delete process.env.FOLDRUN_WORKSPACE;
  const ws = path.join(root, T, "workspaces", W);
  fs.mkdirSync(path.join(ws, "evals"), { recursive: true });
  fs.mkdirSync(path.join(ws, "agents", "writer"), { recursive: true });
  fs.writeFileSync(path.join(ws, "agents", "writer", "agent.md"), "---\nname: writer\n---\n\nWrite.\n");
  return Promise.resolve(body(ws)).finally(() => {
    if (previous === undefined) delete process.env.FOLDRUN_DATA;
    else process.env.FOLDRUN_DATA = previous;
    if (previousWs !== undefined) process.env.FOLDRUN_WORKSPACE = previousWs;
    fs.rmSync(root, { recursive: true, force: true });
  });
}

const GRADER = `---
name: digest-quality
flow: digest
trigger: runs
sample: 100
model: fast
---

## cites a source
expect:
  - judge: names where each claim came from

## no placeholders
expect:
  - not-contains: lorem ipsum
`;

function run(id: string, over: Partial<RunRecord> = {}, reply = "GOOD — prices rose 3% (source: ABS)."): RunRecord {
  const now = Date.now();
  return {
    id,
    flow: "digest",
    status: "completed",
    startedAt: new Date(now - 60_000).toISOString(),
    finishedAt: new Date(now - 30_000).toISOString(),
    summary: reply.split("\n")[0],
    revision: "rev-1",
    steps: [
      { agent: "writer", instruction: "Write the digest.\n\n<run_task>\nthis week's prices\n</run_task>", group: 1, optional: false, status: "completed", events: [], result: reply, costUsd: 0.02 } as RunRecord["steps"][number],
    ],
    ...over,
  } as RunRecord;
}

/** A judge that passes when the output says "source". */
const fakeJudge = async (rubric: string, output: string, _m: string, _e: unknown, _env: unknown, context?: string) => {
  calls.push({ rubric, context });
  return { text: /source/.test(output) ? "It names ABS.\nPASS" : "Nothing is attributed.\nFAIL", costUsd: 0.001 };
};
let calls: { rubric: string; context?: string }[] = [];

test("trigger: runs parses, with sample and improve", () => {
  const info = parseEval("g.md", GRADER);
  assert.equal(info.trigger, "runs");
  assert.equal(info.sample, 100);
  assert.equal(info.improve, null);
  assert.deepEqual(info.problems, []);
  assert.equal(info.cases.length, 2);
  assert.equal(parseEval("g.md", GRADER.replace("sample: 100", "sample: 25%")).sample, 25);
  assert.equal(parseEval("g.md", GRADER.replace("sample: 100", "improve: true")).improve, 5);
  assert.equal(parseEval("g.md", GRADER.replace("sample: 100", "improve: 3")).improve, 3);
  assert.equal(parseEval("g.md", GRADER.replace("sample: 100", "")).sample, 25, "default 25");
});

test("a grader's problems are named: task:, file:/run:, sample out of range, settings on a case eval", () => {
  const said = (t: string) => parseEval("g.md", t).problems.join(" | ");
  assert.match(said(GRADER.replace("expect:\n  - not-contains", "task: do it\nexpect:\n  - not-contains")), /task: does nothing/);
  assert.match(said(GRADER.replace("- not-contains: lorem ipsum", "- run: ls")), /run: cannot grade a finished run/);
  assert.match(said(GRADER.replace("sample: 100", "sample: 140")), /a percent from 0 to 100/);
  assert.match(said(GRADER.replace("sample: 100", "improve: 99")), /1 to 50/);
  assert.match(said(GRADER.replace("trigger: runs", "trigger: deploy")), /sample: only applies/);
  assert.match(said(GRADER.replace("- not-contains: lorem ipsum", "")), /has no expect: lines/);
});

test("the deploy refuses a grader it cannot read", () => {
  const issues = checkFiles([
    { path: "agents/writer/agent.md", content: "---\nname: writer\n---\n\nWrite.\n" },
    { path: "evals/digest-quality.md", content: GRADER.replace("sample: 100", "sample: 140") },
  ]);
  assert.ok(issues.some((i) => i.file === "evals/digest-quality.md" && /a percent from 0 to 100/.test(i.message)), JSON.stringify(issues));
});

test("a grader is never run as cases — not by a deploy, not by runEval", async () => {
  await withWorkspace(async (ws) => {
    fs.writeFileSync(path.join(ws, "evals", "digest-quality.md"), GRADER);
    const [info] = listEvals(T, W);
    await assert.rejects(runEval(T, W, info), /grades real runs/);
    const r = await evaluateDeployed(T, W, "c1");
    assert.equal(r.ran, 0);
    assert.equal(r.skipped, "no evals");
  });
});

test("gradeRun: cheap checks first, the judge sees the task, cost is the judge's", async () => {
  await withWorkspace(async (ws) => {
    fs.writeFileSync(path.join(ws, "evals", "digest-quality.md"), GRADER);
    const [info] = listGraders(T, W);
    calls = [];
    const good = await gradeRun(T, W, info, run("run-good"), { judge: fakeJudge as never });
    assert.equal(good.status, "pass");
    assert.equal(good.costUsd, 0.001);
    assert.equal(good.runRevision, "rev-1");
    assert.equal(calls[0].context, "this week's prices", "the judge is given the run's task");
    const bad = await gradeRun(T, W, info, run("run-bad", {}, "GOOD — prices rose."), { judge: fakeJudge as never });
    assert.equal(bad.status, "fail");
    assert.equal(bad.checks.find((c) => c.name === "cites a source")?.passed, false);
    const lorem = await gradeRun(T, W, info, run("run-lorem", {}, "lorem ipsum (source: x)"), { judge: fakeJudge as never });
    assert.equal(lorem.checks.find((c) => c.name === "no placeholders")?.passed, false);
    // A judge that does not answer is an error, not a failure.
    const broken = await gradeRun(T, W, info, run("run-x"), { judge: (async () => { throw new Error("cap reached"); }) as never });
    assert.equal(broken.status, "error");
    assert.match(broken.checks[0].error ?? "", /cap reached/);
  });
});

test("gradeRun refuses what it should not grade", async () => {
  await withWorkspace(async (ws) => {
    fs.writeFileSync(path.join(ws, "evals", "digest-quality.md"), GRADER);
    const [info] = listGraders(T, W);
    await assert.rejects(gradeRun(T, W, info, run("r1", { flow: "other" })), /not flow digest/);
    await assert.rejects(gradeRun(T, W, info, run("r2", { status: "running", finishedAt: null })), /has not finished/);
    await assert.rejects(gradeRun(T, W, info, run("r3", {}, "")), /no reply/);
  });
});

test("an agent grader grades that agent's steps, wherever they ran", async () => {
  await withWorkspace(async (ws) => {
    fs.writeFileSync(path.join(ws, "evals", "w.md"), GRADER.replace("flow: digest", "agent: writer").replace("name: digest-quality", "name: w"));
    const [info] = listGraders(T, W);
    const r = run("r-agent", { flow: "anything" });
    r.steps.push({ ...r.steps[0], agent: "editor", result: "lorem ipsum" });
    const g = await gradeRun(T, W, info, r, { judge: fakeJudge as never });
    assert.equal(g.status, "pass", "the editor's lorem ipsum is not the writer's");
  });
});

test("grades are kept per run, the newest line wins, and summed up", async () => {
  await withWorkspace(async (ws) => {
    fs.writeFileSync(path.join(ws, "evals", "digest-quality.md"), GRADER);
    const base = { eval: "digest-quality", flow: "digest", checks: [], costUsd: 0.01, model: "m", evalRevision: "e", runRevision: null, runFinishedAt: null, by: "sample" };
    recordGrade(T, W, { ...base, runId: "a", at: "2026-10-20T01:00:00.000Z", status: "fail" } as Grade);
    recordGrade(T, W, { ...base, runId: "a", at: "2026-10-21T01:00:00.000Z", status: "pass", by: "ana@example.com" } as Grade);
    recordGrade(T, W, { ...base, runId: "b", at: "2026-10-21T02:00:00.000Z", status: "fail" } as Grade);
    recordGrade(T, W, { ...base, runId: "c", at: "2026-10-22T02:00:00.000Z", status: "error" } as Grade);
    fs.appendFileSync(path.join(ws, "evals", ".results", "grades", "digest-quality.jsonl"), '{"torn');
    const grades = readGrades(T, W, "digest-quality");
    assert.deepEqual(grades.map((g) => g.runId), ["c", "b", "a"]);
    assert.equal(grades.find((g) => g.runId === "a")?.status, "pass", "graded again: the newer grade");
    const s = summariseGrades(grades);
    assert.deepEqual([s.graded, s.passed, s.failed, s.errors, s.rate], [3, 1, 1, 1, 0.5]);
    assert.deepEqual(s.byDay.map((d) => d.day), ["2026-10-21", "2026-10-22"]);
    assert.equal(gradesOfRun(T, W, "b")[0]?.status, "fail");
  });
});

test("sampling is stable, and 0 and 100 mean none and all", () => {
  assert.equal(sampled("run-1", "g", 100), true);
  assert.equal(sampled("run-1", "g", 0), false);
  assert.equal(sampled("run-1", "g", 25), sampled("run-1", "g", 25));
  const hits = Array.from({ length: 2000 }, (_, i) => sampled(`run-${i}`, "g", 25)).filter(Boolean).length;
  assert.ok(hits > 400 && hits < 600, `about a quarter: ${hits}`);
});

test("the pass: only runs since the grader was first seen, once each, never test or eval runs", async () => {
  await withWorkspace(async (ws) => {
    fs.writeFileSync(path.join(ws, "evals", "digest-quality.md"), GRADER);
    const old = run("run-old");
    old.finishedAt = new Date(Date.now() - 600_000).toISOString();
    writeRun(T, W, old);
    const [info] = listGraders(T, W);
    // First sight: the grader starts now, so the run that finished before it is never graded.
    graderSince(T, W, info.name, Date.now() - 60_000);
    writeRun(T, W, run("run-new"));
    writeRun(T, W, run("run-test", { test: true }));
    writeRun(T, W, run("run-eval", { flow: "eval:digest-quality" }));
    writeRun(T, W, run("run-other", { flow: "other" }));
    writeRun(T, W, run("run-failed", { status: "failed" }));
    assert.deepEqual(gradeCandidates(T, W, info), ["run-new"]);
    calls = [];
    const seen: string[] = [];
    const first = await gradeWorkspace(T, W, { judge: fakeJudge as never, onGrade: (g) => { seen.push(g.runId); } });
    assert.equal(first.graded, 1);
    assert.deepEqual(seen, ["run-new"]);
    const again = await gradeWorkspace(T, W, { judge: fakeJudge as never });
    assert.equal(again.graded, 0, "a graded run is not graded again");
    assert.ok(readRun(T, W, "run-new"), "the run itself is untouched");
  });
});

test("the pass stops when told to, and caps how many it grades", async () => {
  await withWorkspace(async (ws) => {
    fs.writeFileSync(path.join(ws, "evals", "digest-quality.md"), GRADER);
    const [info] = listGraders(T, W);
    graderSince(T, W, info.name, Date.now() - 60_000);
    for (let i = 0; i < 4; i++) writeRun(T, W, run(`r${i}`));
    const capped = await gradeWorkspace(T, W, { judge: fakeJudge as never, limit: 2 });
    assert.equal(capped.graded, 2);
    const stopped = await gradeWorkspace(T, W, { judge: fakeJudge as never, keepGoing: () => false });
    assert.equal(stopped.graded, 0);
  });
});

test("an undecided grade is tried again after an hour, at most three times", async () => {
  await withWorkspace(async (ws) => {
    fs.writeFileSync(path.join(ws, "evals", "digest-quality.md"), GRADER);
    const [info] = listGraders(T, W);
    graderSince(T, W, info.name, Date.now() - 600_000);
    writeRun(T, W, run("run-cap"));
    const broken = (async () => { throw new Error("weekly limit"); }) as never;
    assert.equal((await gradeWorkspace(T, W, { judge: broken })).graded, 1);
    assert.deepEqual(gradeCandidates(T, W, info), [], "not again within the hour");
    const hourOn = Date.now() + 3601_000;
    assert.deepEqual(gradeCandidates(T, W, info, hourOn), ["run-cap"], "tried again after an hour");
    await gradeWorkspace(T, W, { judge: broken, now: hourOn });
    await gradeWorkspace(T, W, { judge: broken, now: hourOn + 3601_000 });
    assert.deepEqual(gradeCandidates(T, W, info, hourOn + 7300_000), [], "three tries, then left alone");
  });
});

test("a judge that gives no verdict, or two judges that both fail to answer, leave the run undecided", async () => {
  await withWorkspace(async (ws) => {
    const two = GRADER.replace("  - judge: names where each claim came from", "  - judge: names where each claim came from\n  - judge: says when the figures are from");
    fs.writeFileSync(path.join(ws, "evals", "digest-quality.md"), two);
    const [info] = listGraders(T, W);
    const mute = (async () => ({ text: "I cannot tell.", costUsd: 0 })) as never;
    const g = await gradeRun(T, W, info, run("run-mute"), { judge: mute });
    assert.equal(g.status, "error", "no PASS or FAIL is not a failure");
    let n = 0;
    const flaky = (async () => { throw new Error(`outage ${++n}`); }) as never;
    const h = await gradeRun(T, W, info, run("run-flaky"), { judge: flaky });
    assert.equal(h.status, "error", "two different errors are still undecided, not failed");
    assert.match(h.checks[0].error ?? "", /outage 1.*outage 2/);
    // A real FAIL beside an error is a failure.
    let k = 0;
    const mixed = (async () => (++k === 1 ? { text: "No sources.\nFAIL", costUsd: 0 } : Promise.reject(new Error("down")))) as never;
    assert.equal((await gradeRun(T, W, info, run("run-mixed"), { judge: mixed })).status, "fail");
  });
});

test("a hook that fails after a grade leaves the grade as it was", async () => {
  await withWorkspace(async (ws) => {
    fs.writeFileSync(path.join(ws, "evals", "digest-quality.md"), GRADER);
    const [info] = listGraders(T, W);
    graderSince(T, W, info.name, Date.now() - 600_000);
    writeRun(T, W, run("run-hook"));
    const r = await gradeWorkspace(T, W, { judge: fakeJudge as never, onGrade: () => { throw new Error("queue down"); } });
    assert.equal(r.graded, 1);
    assert.match(r.errors.join(" "), /after grading — queue down/);
    const g = readGrades(T, W, "digest-quality").find((x) => x.runId === "run-hook");
    assert.equal(g?.status, "pass", "the verdict stands");
    assert.equal(g?.costUsd, 0.001);
  });
});

test("a grader with no checks is refused; old grades are pruned however small the file", async () => {
  assert.match(parseEval("g.md", "---\nflow: digest\ntrigger: runs\n---\n\nNo checks here.\n").problems.join(" "), /at least one check/);
  await withWorkspace(async (ws) => {
    fs.writeFileSync(path.join(ws, "evals", "digest-quality.md"), GRADER);
    const base = { eval: "digest-quality", flow: "digest", checks: [], costUsd: 0, model: "m", evalRevision: "e", runRevision: null, runFinishedAt: null, by: "sample", status: "pass" };
    recordGrade(T, W, { ...base, runId: "old", at: new Date(Date.now() - 100 * 86400_000).toISOString() } as Grade);
    recordGrade(T, W, { ...base, runId: "new", at: new Date().toISOString() } as Grade);
    const { pruneGrades } = await import("../src/grades.ts");
    assert.equal(pruneGrades(T, W, "digest-quality"), 1);
    assert.deepEqual(readGrades(T, W, "digest-quality").map((g) => g.runId), ["new"]);
  });
});

test("graders take turns: a busy one cannot have every pass, and a new one starts its clock at once", async () => {
  await withWorkspace(async (ws) => {
    fs.writeFileSync(path.join(ws, "evals", "a-busy.md"), GRADER.replace("name: digest-quality", "name: a-busy"));
    fs.writeFileSync(path.join(ws, "evals", "b-quiet.md"), GRADER.replace("name: digest-quality", "name: b-quiet"));
    for (const g of ["a-busy", "b-quiet"]) graderSince(T, W, g, Date.now() - 600_000);
    for (let i = 0; i < 6; i++) writeRun(T, W, run(`r${i}`));
    await gradeWorkspace(T, W, { judge: fakeJudge as never, limit: 2 });
    assert.equal(readGrades(T, W, "a-busy").length, 1);
    assert.equal(readGrades(T, W, "b-quiet").length, 1, "the second grader got its turn");
    fs.writeFileSync(path.join(ws, "evals", "c-new.md"), GRADER.replace("name: digest-quality", "name: c-new"));
    await gradeWorkspace(T, W, { judge: fakeJudge as never, limit: 0 });
    assert.ok(fs.existsSync(path.join(ws, "evals", ".results", "grades", "c-new.state.json")), "its start is stamped even with no budget");
  });
});

test("across passes, the grader left out last time goes first", async () => {
  await withWorkspace(async (ws) => {
    for (const n of ["a", "b", "c"]) fs.writeFileSync(path.join(ws, "evals", `${n}.md`), GRADER.replace("name: digest-quality", `name: ${n}`));
    for (const n of ["a", "b", "c"]) graderSince(T, W, n, Date.now() - 600_000);
    for (let i = 0; i < 4; i++) writeRun(T, W, run(`r${i}`));
    await gradeWorkspace(T, W, { judge: fakeJudge as never, limit: 2 });
    assert.equal(readGrades(T, W, "c").length, 0, "a and b took this pass");
    await gradeWorkspace(T, W, { judge: fakeJudge as never, limit: 1 });
    assert.equal(readGrades(T, W, "c").length, 1, "c leads the next");
  });
});

test("an agent grader gives the judge that agent's own instruction", async () => {
  await withWorkspace(async (ws) => {
    fs.writeFileSync(path.join(ws, "evals", "e.md"), GRADER.replace("flow: digest", "agent: editor").replace("name: digest-quality", "name: e"));
    const [info] = listGraders(T, W);
    const r = run("r-ed");
    r.steps.push({ ...r.steps[0], agent: "editor", instruction: "Tighten the draft to 200 words.", result: "Tightened (source: ABS)." });
    calls = [];
    await gradeRun(T, W, info, r, { judge: fakeJudge as never });
    assert.equal(calls[0].context, "Tighten the draft to 200 words.");
  });
});

test("a grader refuses matches:, which would run a regular expression on the scheduler", () => {
  assert.match(parseEval("g.md", GRADER.replace("- not-contains: lorem ipsum", "- matches: (a+)+$")).problems.join(" "), /matches: is not used to grade live runs/);
});

test("a grader asks at most five judges per run", () => {
  const six = Array.from({ length: 6 }, (_, i) => `## c${i}\nexpect:\n  - judge: claim ${i}\n`).join("\n");
  assert.match(parseEval("g.md", `---\nflow: digest\ntrigger: runs\n---\n\n${six}`).problems.join(" "), /at most 5 judges per run/);
});
