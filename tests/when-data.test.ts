// `when: rows of <csv>`, the reply a shell `verify:` can read, and the
// options a `[[flow:x]]` step silently dropped.
//
// All three came out of one weekly flow on a live desk: scan for unanswered
// reviews, fan a writer out over the CSV the scan wrote, collate, then an
// approval gate before publishing. On a week with nothing to answer the
// writer skipped itself (an `each:` over an empty file) — and the collator
// and the gate ran anyway, because a skipped fan-out leaves no marker for a
// `when:` to read. A person was asked to approve publishing nothing. Gating
// each step on a marker the step above had to write worked, but it took a
// marker in three agents, and a `verify:` per step to enforce each one.
//
//   node --test tests/when-data.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startFlowRun, waitForRun } from "../src/runner.ts";
import { parseFlow, readRun, whenRowsPath, type FlowStep } from "../src/store.ts";
import { lintFlow } from "../src/flow-lint.ts";
import { checkVerify } from "../src/step-exec.ts";

/** A stubbed workspace with some files already in it, run to the end. */
async function withStubbedRun(
  agents: Record<string, string>,
  files: Record<string, string>,
  steps: FlowStep[],
  body: (finished: NonNullable<ReturnType<typeof readRun>>) => void,
) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-when-data-"));
  const prevData = process.env.FOLDRUN_DATA;
  const prevStub = process.env.FOLDRUN_STUB_STEP;
  process.env.FOLDRUN_DATA = root;
  process.env.FOLDRUN_STUB_STEP = "1";
  try {
    const ws = path.join(root, "acme/workspaces/desk");
    for (const [name, stub] of Object.entries(agents)) {
      const dir = path.join(ws, "agents", name);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "agent.md"), `---\nname: ${name}\ndescription: stub\n---\n\nStub.\n`);
      fs.writeFileSync(path.join(dir, "stub.md"), stub);
    }
    for (const [rel, content] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(ws, rel)), { recursive: true });
      fs.writeFileSync(path.join(ws, rel), content);
    }
    fs.writeFileSync(path.join(ws, "AGENTS.md"), "---\nname: desk\n---\n");

    const run = startFlowRun("acme", "desk", steps, "when-data-test");
    const { run: finished } = await waitForRun("acme", "desk", run.id, 30_000);
    assert.ok(finished, "the run record survived");
    body(finished);
  } finally {
    if (prevData === undefined) delete process.env.FOLDRUN_DATA;
    else process.env.FOLDRUN_DATA = prevData;
    if (prevStub === undefined) delete process.env.FOLDRUN_STUB_STEP;
    else process.env.FOLDRUN_STUB_STEP = prevStub;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const step = (agent: string, group: number, extra: Partial<FlowStep> = {}): FlowStep => ({
  agent,
  instruction: `do the ${agent} thing`,
  group,
  optional: false,
  ...extra,
});

const CSV = "../../storage/unanswered.csv";
const AGENTS = { scan: "All answered.", writer: "a reply", sheet: "the table", poster: "posted" };
// The reviews flow's shape, minus the gate (a gate parks the run, which is
// the approval tests' business): each follower asks the file, not the prose.
const reviewsFlow = () => [
  step("scan", 1),
  step("writer", 2, { each: "rows", eachPath: CSV }),
  step("sheet", 3, { when: `rows of ${CSV}` }),
  step("poster", 4, { when: `rows of ${CSV}` }),
];

test("whenRowsPath: the whole phrase is a data condition, a bare word stays a marker", () => {
  assert.equal(whenRowsPath("rows of ../../storage/x.csv"), "../../storage/x.csv");
  assert.equal(whenRowsPath("  ROWS OF  a.csv "), "a.csv");
  assert.equal(whenRowsPath("ROWS"), null, "a flow keyed on a ROWS marker keeps working");
  assert.equal(whenRowsPath("rows of"), null);
  assert.equal(whenRowsPath("REPLIES"), null);
});

test("when: rows of — a header-only CSV skips every follower, not just the fan-out", () =>
  withStubbedRun(AGENTS, { "storage/unanswered.csv": "review_id,comment\n" }, reviewsFlow(), (run) => {
    assert.equal(run.status, "completed");
    const by = (name: string) => run.steps.find((s) => s.agent === name)!;
    assert.equal(by("scan").status, "completed");
    for (const name of ["writer", "sheet", "poster"]) assert.equal(by(name).status, "skipped", name);
    assert.match(by("sheet").skipReason ?? "", /when rows — .*has no data rows/);
  }));

test("when: rows of — a CSV with a row runs the followers, whatever the prose above says", () =>
  withStubbedRun(
    AGENTS,
    { "storage/unanswered.csv": 'review_id,comment\nr1,"Great, thorough"\n' },
    reviewsFlow(),
    (run) => {
      assert.equal(run.status, "completed");
      // The fan-out's own record is marked expanded; its one instance, the
      // sheet and the poster all ran.
      const by = (name: string) => run.steps.filter((s) => s.agent === name).map((s) => s.status);
      assert.deepEqual(by("writer"), ["skipped", "completed"]);
      assert.match(run.steps.find((s) => s.agent === "writer")!.skipReason ?? "", /expanded into 1 item/);
      assert.deepEqual(by("sheet"), ["completed"]);
      assert.deepEqual(by("poster"), ["completed"]);
    },
  ));

test("when: rows of — a missing file is a skip that says so", () =>
  withStubbedRun(AGENTS, {}, [step("scan", 1), step("sheet", 2, { when: `rows of ${CSV}` })], (run) => {
    const sheet = run.steps.find((s) => s.agent === "sheet")!;
    assert.equal(sheet.status, "skipped");
    assert.match(sheet.skipReason ?? "", /does not exist/);
  }));

test("when: rows of — a path outside the workspace never opens the step", () =>
  withStubbedRun(AGENTS, {}, [step("scan", 1), step("sheet", 2, { when: "rows of ../../../../../etc/passwd" })], (run) => {
    const sheet = run.steps.find((s) => s.agent === "sheet")!;
    assert.equal(sheet.status, "skipped");
    assert.match(sheet.skipReason ?? "", /outside this workspace/);
  }));

test("when: rows of parses from a flow file and is not a 'runs first' warning", () => {
  const flow = parseFlow(
    "flows/x.md",
    `---\nname: x\n---\n\n1. [[sheet]] — collate\n   when: rows of ${CSV}\n2. [[poster]] — post\n   when: READY\n`,
  );
  assert.equal(flow.steps[0].when, `rows of ${CSV}`);
  const messages = lintFlow(flow, { agents: ["sheet", "poster"] }).map((w) => w.message);
  assert.ok(!messages.some((m) => m.includes("runs first")), messages.join(" | "));
});

test("a marker when: in the first group still warns", () => {
  const flow = parseFlow("flows/x.md", "---\nname: x\n---\n\n1. [[sheet]] — collate\n   when: READY\n");
  const messages = lintFlow(flow, { agents: ["sheet"] }).map((w) => w.message);
  assert.ok(messages.some((m) => m.includes("runs first")), messages.join(" | "));
});

test("options under a [[flow:x]] step are named as ignored", () => {
  const flow = parseFlow(
    "flows/x.md",
    "---\nname: x\n---\n\n1. [[scan]] — look\n2! [[flow:publish]] — publish it\n   when: READY\n   retry: 2\n",
  );
  const w = lintFlow(flow, { agents: ["scan"] }).find((x) => x.message.includes("flow:publish"));
  assert.ok(w, "a warning names the nested flow");
  assert.match(w.message, /an approval \(!\), when:, retry:/);
});

test("a bare [[flow:x]] step, or one marked optional, is not warned about", () => {
  const flow = parseFlow("flows/x.md", "---\nname: x\n---\n\n1. [[scan]] — look\n2?. [[flow:publish]] — publish it\n");
  const messages = lintFlow(flow, { agents: ["scan"] }).map((w) => w.message);
  assert.ok(!messages.some((m) => m.includes("nested flow ignores")), messages.join(" | "));
});

test("a shell verify: reads the reply from FOLDRUN_REPLY_FILE", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-verify-reply-"));
  try {
    fs.writeFileSync(path.join(dir, "out.json"), "{}");
    const cmd = `grep -q '^READY' "$FOLDRUN_REPLY_FILE" && test -s out.json`;
    const pass = await checkVerify(dir, cmd, { env: {}, result: "turn one\n\nREADY 2", conclusion: "READY 2" });
    assert.equal(pass.ok, true, pass.detail);
    const fail = await checkVerify(dir, cmd, { env: {}, result: "QUIET", conclusion: "QUIET" });
    assert.equal(fail.ok, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the reply file is gone once the check has run", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-verify-reply-"));
  try {
    const r = await checkVerify(dir, `echo "$FOLDRUN_REPLY_FILE"`, { env: {}, result: "x", conclusion: "x" });
    const file = r.detail.trim();
    assert.ok(file.endsWith("reply.md"), file);
    assert.equal(fs.existsSync(file), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
