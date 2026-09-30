// Granting a script tool grants the secrets its file lists. strata-desk's
// reporter granted desk_email (`secrets: [RESEND_API_KEY, EMAIL_FROM]` in its
// tool.md), declared nothing itself, and failed at 07:00 on 1 Oct with
// "RESEND_API_KEY is not set": only the agent's own list reached the sandbox.
//
//   node --test tests/tool-secrets-grant.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startFlowRun, waitForRun } from "../src/runner.ts";
import { setSecret } from "../src/secrets.ts";
import { registerPlatform, platform } from "../src/platform.ts";
import type { RunInContainerArgs, ContainerStepOutcome } from "../src/run-container.ts";

const VALUE = "re_live_0123456789abcdef";

async function withDesk(tool: string, agentExtra: string, body: (seen: RunInContainerArgs[]) => Promise<void>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-tool-secrets-"));
  const prev = { data: process.env.FOLDRUN_DATA, iso: process.env.FOLDRUN_RUN_ISOLATION };
  process.env.FOLDRUN_DATA = root;
  process.env.FOLDRUN_RUN_ISOLATION = "fake";
  const prevIso = platform.isolation;
  const seen: RunInContainerArgs[] = [];
  const fake = async (args: RunInContainerArgs): Promise<ContainerStepOutcome> => {
    seen.push(args);
    return { status: "completed", result: `sent with ${args.env.RESEND_API_KEY ?? "nothing"}`, costUsd: 0 };
  };
  registerPlatform({ isolation: { fake } });
  try {
    const ws = path.join(root, "acme/workspaces/desk");
    fs.mkdirSync(path.join(ws, "agents/reporter"), { recursive: true });
    fs.mkdirSync(path.join(ws, "tools/desk-email"), { recursive: true });
    fs.mkdirSync(path.join(ws, "runs"), { recursive: true });
    fs.writeFileSync(path.join(ws, "AGENTS.md"), "---\nname: desk\n---\n");
    fs.writeFileSync(path.join(ws, "tools/desk-email/tool.md"), tool);
    fs.writeFileSync(path.join(ws, "tools/desk-email/send.mjs"), "console.log('ok')\n");
    fs.writeFileSync(path.join(ws, "agents/reporter/agent.md"), `---\nname: reporter\ndescription: reports\ntools: [desk_email]\n${agentExtra}---\n\nSend it.\n`);
    setSecret("acme", "RESEND_API_KEY", VALUE, "desk");
    setSecret("acme", "EMAIL_FROM", "dev@example.com", "desk");
    await body(seen);
  } finally {
    registerPlatform({ isolation: prevIso });
    for (const [k, v] of [["FOLDRUN_DATA", prev.data], ["FOLDRUN_RUN_ISOLATION", prev.iso]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const TOOL = (secrets: string) =>
  `---\nname: desk_email\ntransport: script\nrun: send.mjs\ndescription: emails dev@\n${secrets}---\n`;

test("an agent that grants the tool gets the secrets the tool lists, without declaring them", () =>
  withDesk(TOOL("secrets: [RESEND_API_KEY, EMAIL_FROM]\n"), "", async (seen) => {
    const run = startFlowRun("acme", "desk", [{ agent: "reporter", instruction: "send", group: 1, optional: false }], "f");
    const { run: done } = await waitForRun("acme", "desk", run.id, 20_000);
    assert.equal(done?.status, "completed", JSON.stringify(done?.steps[0]?.events?.slice(-3)));
    assert.equal(seen[0].env.RESEND_API_KEY, VALUE);
    assert.equal(seen[0].env.EMAIL_FROM, "dev@example.com");
    // And it is treated as a secret: the value is redacted on the record.
    assert.match(done!.steps[0].result!, /\[redacted:RESEND_API_KEY\]/);
  }));

test("declaring it on the agent as well changes nothing; proxied/materialised name no secrets", async () => {
  await withDesk(TOOL("secrets: [RESEND_API_KEY, EMAIL_FROM]\n"), "secrets: [RESEND_API_KEY]\n", async (seen) => {
    const run = startFlowRun("acme", "desk", [{ agent: "reporter", instruction: "send", group: 1, optional: false }], "f");
    await waitForRun("acme", "desk", run.id, 20_000);
    assert.equal(seen[0].env.RESEND_API_KEY, VALUE);
  });
  await withDesk(TOOL("secrets: materialised\n"), "", async (seen) => {
    const run = startFlowRun("acme", "desk", [{ agent: "reporter", instruction: "send", group: 1, optional: false }], "f");
    await waitForRun("acme", "desk", run.id, 20_000);
    assert.equal(seen[0].env.RESEND_API_KEY, undefined, "a tool that lists no names grants none");
  });
});
