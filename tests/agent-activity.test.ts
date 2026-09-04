// One agent's own history, and the line it opened its reply with.
//
// The runs list is keyed by flow. An agent in four flows has its work spread
// across four filters, and one that only ever runs directly is reachable only
// by knowing the `adhoc:` prefix — so "is this agent any good" had no answer
// that did not involve opening runs one at a time.
//
//   node --test tests/agent-activity.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { headlineOf, listAgentSteps, runSummary, stepHeadline, writeRun, type RunRecord } from "../packages/core/src/store.ts";

test("a headline is the first line a person would recognise as the point", () => {
  assert.equal(headlineOf("## Done: 4 findings\n\nDetail follows."), "Done: 4 findings");
  assert.equal(headlineOf("- **12 pages** fixed\nmore"), "12 pages fixed");
  assert.equal(headlineOf("> quoted opener\nrest"), "quoted opener");
  // Decoration is not a headline: a rule, a bare hash, an opening fence, and
  // a line that is only brackets.
  assert.equal(headlineOf("---\n\n# \n\n```json\n{}\n```\nReal line."), "Real line.");
  // A reply that is ONLY a JSON value has no sentence to find, and its first
  // content line is what comes back. `output: json` steps are told to put the
  // prose first, so in practice the headline is found before the fence.
  assert.equal(headlineOf("```json\n{\"a\": 1}\n```"), '{"a": 1}');
  assert.equal(headlineOf(""), null);
  assert.equal(headlineOf(null), null);
  // A hash that is part of the sentence survives the heading strip.
  assert.equal(headlineOf("#1 priority is the sitemap"), "#1 priority is the sitemap");
  // Truncated to 197 characters plus the ellipsis that says it was cut.
  const long = headlineOf("x".repeat(250))!;
  assert.equal(long.length, 198);
  assert.ok(long.endsWith("…"));
});

/** Build a throwaway account on disk and point core at it for one callback. */
function withAccount(run: () => void) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-activity-"));
  const previous = process.env.FOLDRUN_DATA;
  process.env.FOLDRUN_DATA = root;
  try {
    const ws = path.join(root, "acme", "workspaces", "desk");
    fs.mkdirSync(path.join(ws, "runs"), { recursive: true });
    fs.writeFileSync(path.join(ws, "AGENTS.md"), "---\nname: desk\n---\n");
    run();
  } finally {
    if (previous === undefined) delete process.env.FOLDRUN_DATA;
    else process.env.FOLDRUN_DATA = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const step = (agent: string, result: string | null, over: Partial<RunRecord["steps"][number]> = {}) => ({
  agent,
  instruction: "go",
  group: 1,
  optional: false,
  status: "completed" as const,
  events: [],
  result,
  costUsd: 0.01,
  ...over,
});

test("an agent's steps come back newest first, from every flow and from direct runs", () => {
  withAccount(() => {
    writeRun("acme", "desk", {
      id: "r1",
      flow: "weekly",
      status: "completed",
      startedAt: "2026-09-01T00:00:00Z",
      finishedAt: "2026-09-01T00:10:00Z",
      steps: [step("writer", "Drafted the digest."), step("editor", "Approved.")],
    } as RunRecord);
    writeRun("acme", "desk", {
      id: "r2",
      flow: "adhoc:writer",
      status: "failed",
      startedAt: "2026-09-02T00:00:00Z",
      finishedAt: null,
      steps: [step("writer", null, { status: "failed" })],
    } as RunRecord);

    const steps = listAgentSteps("acme", "desk", "writer");
    assert.equal(steps.length, 2, "both the flow step and the direct run");
    assert.equal(steps[0].runId, "r2", "newest first");
    assert.equal(steps[0].stepStatus, "failed");
    assert.equal(steps[0].headline, null, "a failed step recorded no reply");
    assert.equal(steps[1].headline, "Drafted the digest.");
    // The step's OWN line, not the run's summary — the editor ran after it.
    assert.notEqual(steps[1].headline, "Approved.");
    assert.equal(steps[1].flow, "weekly");

    assert.deepEqual(
      listAgentSteps("acme", "desk", "editor").map((s) => s.headline),
      ["Approved."],
    );
    assert.deepEqual(listAgentSteps("acme", "desk", "nobody"), []);
  });
});

test("the runtime asks for the sentence the summary reads", () => {
  // The convention was load-bearing and unstated: every agent.md had to think
  // of it, and the ones written before summaries existed never did.
  const src = fs.readFileSync(
    path.join(import.meta.dirname, "..", "packages", "core", "src", "runner.ts"),
    "utf8",
  );
  assert.match(src, /Open your reply with one sentence/);
});

test("a summary reads the model's answer, not the narration it opened with", () => {
  // `result` is every text block joined, so a model that says "Now let me read
  // the outputs…" before calling a tool puts that at the top of it. Reading
  // the joined text reported the plan of every step that used a tool — which
  // is most of them. The last block is the answer.
  const step = {
    agent: "reporter",
    instruction: "go",
    group: 1,
    optional: false,
    status: "completed" as const,
    events: [],
    result: "Now let me read the auditor outputs:\nI'll write the report.\n115 indexed, 5 missing — the report is at storage/index-report.md.",
    conclusion: "115 indexed, 5 missing — the report is at storage/index-report.md.",
    costUsd: 0.01,
  };
  assert.equal(stepHeadline(step), "115 indexed, 5 missing — the report is at storage/index-report.md.");
  assert.equal(
    runSummary({ steps: [step] } as unknown as RunRecord),
    "115 indexed, 5 missing — the report is at storage/index-report.md.",
  );
  // A step recorded before `conclusion` existed reads exactly as it always
  // did — the fallback is what keeps old runs rendering.
  const { conclusion: _drop, ...legacy } = step;
  assert.equal(stepHeadline(legacy), "Now let me read the auditor outputs:");
  // An answer that is only a JSON fence has no sentence in it; fall back to
  // the whole reply rather than showing nothing.
  assert.equal(stepHeadline({ ...step, conclusion: "```json\n{}\n```" }), "Now let me read the auditor outputs:");
});
