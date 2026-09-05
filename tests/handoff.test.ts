// What a step is handed from the steps before it, and what the checks read.
//
// Three faults with one cause, found on 2026-09-04/05 across the SEO desks:
// a group saw only the group immediately before it; `verify:` read every
// turn joined while the headline read the final one; `each: lines` split
// the joined turns too. The handoff is now every earlier group, and the
// checks and the fan-out read what a step concluded.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { joinEarlierGroups, startFlowRun, waitForRun } from "../src/runner.ts";
import { readRun, type FlowStep } from "../src/store.ts";
import { checkVerify } from "../src/step-exec.ts";
import { suggestPath } from "../src/confine.ts";

test("a step is handed every earlier group, oldest first", () => {
  const groups = ["group one measured", "group two diagnosed", "group three", null];
  assert.equal(joinEarlierGroups(groups, 3), "group one measured\n\ngroup two diagnosed\n\ngroup three");
  assert.equal(joinEarlierGroups(groups, 1), "group one measured");
  assert.equal(joinEarlierGroups(groups, 0), null);
  assert.equal(joinEarlierGroups([null, "b"], 2), "b", "a group that produced nothing is skipped");
});

test("over the cap, the oldest groups go first and whole", () => {
  const groups = ["a".repeat(50), "b".repeat(50), "c".repeat(50)];
  const kept = joinEarlierGroups(groups, 3, 110);
  assert.equal(kept, "b".repeat(50) + "\n\n" + "c".repeat(50), "the oldest was dropped, the newest two kept intact");
  assert.equal(joinEarlierGroups(groups, 3, 10), "c".repeat(50), "the newest survives even when it alone is over the cap");
});

test("contains/matches read the conclusion; judge would read the whole result", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-verify-"));
  try {
    const result = "I'll start by reading the files.\nNow let me write the report.\nBAD — Melbourne is absent";
    const conclusion = "BAD — Melbourne is absent";
    const anchored = await checkVerify(dir, "matches: ^BAD\\b", { env: {}, result, conclusion });
    assert.equal(anchored.ok, true, "the headline is what the check sees");
    const narration = await checkVerify(dir, "not-contains: let me write", { env: {}, result, conclusion });
    assert.equal(narration.ok, true, "narration in an earlier turn is not the reply");
    const legacy = await checkVerify(dir, "matches: ^BAD\\b", { env: {}, result });
    assert.equal(legacy.ok, false, "a record with no conclusion still checks the joined result");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the refusal names the path the agent probably meant", () => {
  assert.match(suggestPath("/tmp/outputs/report.md"), /outputs\/report\.md/);
  assert.match(suggestPath("/data/acme/workspaces/desk/storage/x.md"), /workspace\/storage\/x\.md/);
  assert.match(suggestPath("/tmp/foldrun-site/content/a.mdx"), /through that tool/);
  assert.match(suggestPath("/etc/passwd"), /relative to your agent directory/);
});

/** A stubbed run: agents answer from stub.md; `===` separates turns. */
async function withStubbedRun(
  agents: Record<string, string>,
  steps: FlowStep[],
  body: (finished: NonNullable<ReturnType<typeof readRun>>) => void,
) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-handoff-"));
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
    fs.writeFileSync(path.join(ws, "AGENTS.md"), "---\nname: desk\n---\n");
    const run = startFlowRun("acme", "desk", steps, "handoff-test");
    const { run: finished } = await waitForRun("acme", "desk", run.id, 30_000);
    assert.ok(finished);
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

test("each: lines fans out over what the previous step concluded, not its narration", () =>
  withStubbedRun(
    {
      translator: "I have compiled a list.\n===\nStill compiling.\n===\nalpha\nbeta\ngamma",
      validator: "checked",
    },
    [step("translator", 1), step("validator", 2, { each: "lines", max: 5 })],
    (run) => {
      assert.equal(run.status, "completed");
      const items = run.steps.filter((s) => s.agent === "validator" && s.item).map((s) => s.item);
      assert.deepEqual(items, ["alpha", "beta", "gamma"], "the final turn's lines, none of the narration");
    },
  ));
