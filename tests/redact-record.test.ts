// A secret in a step's REPLY was written to the run record in clear.
//
// Events were scrubbed on the way in — every tool line, every script's
// stdout — but the reply, the conclusion and an `output: json` value were
// copied straight off the outcome. A model that quoted a script's output
// ("the key is sk-…") put a live credential on a record the dashboard
// renders to anyone who can read a run. Same scrub, every field.
//
//   node --test tests/redact-record.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startFlowRun, waitForRun } from "../src/runner.ts";
import { setSecret } from "../src/secrets.ts";
import { registerPlatform, platform } from "../src/platform.ts";
import type { RunInContainerArgs, ContainerStepOutcome } from "../src/run-container.ts";

const SECRET = "sk-live-0123456789abcdef";

async function withFake(fake: (args: RunInContainerArgs) => Promise<ContainerStepOutcome>, body: () => Promise<void>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-redact-"));
  const prev = { data: process.env.FOLDRUN_DATA, iso: process.env.FOLDRUN_RUN_ISOLATION };
  process.env.FOLDRUN_DATA = root;
  process.env.FOLDRUN_RUN_ISOLATION = "fake";
  const prevIso = platform.isolation;
  registerPlatform({ isolation: { fake } });
  try {
    const ws = path.join(root, "acme/workspaces/desk");
    fs.mkdirSync(path.join(ws, "agents/worker"), { recursive: true });
    fs.mkdirSync(path.join(ws, "runs"), { recursive: true });
    fs.writeFileSync(path.join(ws, "AGENTS.md"), "---\nname: desk\n---\n");
    fs.writeFileSync(
      path.join(ws, "agents/worker/agent.md"),
      "---\nname: worker\ndescription: works\nsecrets: [DEMO_TOKEN]\n---\n\nWork.\n",
    );
    setSecret("acme", "DEMO_TOKEN", SECRET, "desk");
    await body();
  } finally {
    registerPlatform({ isolation: prevIso });
    for (const [k, v] of [["FOLDRUN_DATA", prev.data], ["FOLDRUN_RUN_ISOLATION", prev.iso]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test("a secret quoted in the reply, the conclusion or the data is redacted on the record", async () => {
  await withFake(
    async () => ({
      status: "completed",
      result: `Narration first.\nThe key is ${SECRET}, as the script printed.`,
      conclusion: `The key is ${SECRET}.`,
      data: { token: SECRET, nested: [{ again: SECRET }], count: 2 },
      costUsd: 0,
    }),
    async () => {
      const run = startFlowRun("acme", "desk", [{ agent: "worker", instruction: "work", group: 1, optional: false, output: "json" }], "f");
      const { run: done } = await waitForRun("acme", "desk", run.id, 20_000);
      assert.equal(done?.status, "completed");
      const s = done!.steps[0];
      assert.ok(!s.result!.includes(SECRET), "the reply must not carry the value");
      assert.match(s.result!, /\[redacted:DEMO_TOKEN\]/);
      assert.equal(s.conclusion, "The key is [redacted:DEMO_TOKEN].");
      assert.deepEqual(s.data, { token: "[redacted:DEMO_TOKEN]", nested: [{ again: "[redacted:DEMO_TOKEN]" }], count: 2 });
      // The whole record, not just the fields we thought of.
      const raw = JSON.stringify(done);
      assert.ok(!raw.includes(SECRET), "nothing on the record carries the value");
    },
  );
});
