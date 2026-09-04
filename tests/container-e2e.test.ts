// The runner container, for real: build the image, put a workspace in, run
// the driver, read the protocol back. No model call and no credentials —
// the query fails inside, which is exactly what proves the plumbing: the
// image built, core loaded in there, events streamed out, the container was
// torn down, and nothing forbidden came back.
//
// Opt-in (needs Docker and a few minutes the first time):
//
//   npm run container
//
// With ANTHROPIC_API_KEY set, a second test makes one real model call from
// inside the container — the full isolated path, end to end.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ensureRunnerImage,
  runStepInContainer,
} from "../packages/core/src/run-container.ts";

const enabled = process.env.FOLDRUN_CONTAINER_E2E === "1";
const opts = { skip: enabled ? false : "set FOLDRUN_CONTAINER_E2E=1 to run (needs Docker)" };
// Either credential the SDK accepts via env works inside the container —
// an API key, or a Claude subscription OAuth token (what CI uses).
const modelCreds: Record<string, string> = process.env.ANTHROPIC_API_KEY
  ? { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY }
  : process.env.CLAUDE_CODE_OAUTH_TOKEN
    ? { CLAUDE_CODE_OAUTH_TOKEN: process.env.CLAUDE_CODE_OAUTH_TOKEN }
    : {};
const paid = {
  skip: !enabled
    ? "set FOLDRUN_CONTAINER_E2E=1 to run"
    : Object.keys(modelCreds).length
      ? false
      : "set ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN as well to make a real model call from inside the container",
};

function stageWorkspace(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-ce2e-"));
  fs.mkdirSync(path.join(root, "agents/writer"), { recursive: true });
  fs.mkdirSync(path.join(root, "knowledge"), { recursive: true });
  fs.writeFileSync(path.join(root, "AGENTS.md"), "---\nname: desk\n---\n");
  fs.writeFileSync(
    path.join(root, "agents/writer/agent.md"),
    "---\nname: writer\ndescription: writes\n---\n\nWrite one short sentence to outputs/note.md.\n",
  );
  fs.writeFileSync(path.join(root, "knowledge/policy.md"), "authored truth\n");
  fs.writeFileSync(path.join(root, "secrets.json"), "{}");
  return root;
}

const baseInput = {
  agentRel: "agents/writer",
  prompt: "Say hello.",
  model: "haiku",
  systemPrompt: "You write one short sentence.",
  allowed: ["Read", "Write"],
  mcpNames: [],
  mcpServers: {},
  apis: [],
  scripts: [],
  runtime: null,
  consults: [],
  timeoutSec: 120,
};

test("the image builds and the driver answers the protocol, even with no credentials", opts, async () => {
  const { tag } = ensureRunnerImage();
  assert.match(tag, /^foldrun-runner:/);

  const ws = stageWorkspace();
  const events: { type: string; text: string }[] = [];
  try {
    const outcome = await runStepInContainer({
      workspaceRoot: ws,
      libraryRoot: path.join(ws, "..", "no-library"),
      input: baseInput,
      env: {},
      emit: (type, text) => events.push({ type, text }),
    });
    // No credentials in there → the loop fails — as a protocol message, not
    // a hang or a crash out here.
    assert.equal(outcome.status, "failed");
    assert.ok(events.length > 0, "the failure arrived as streamed events");
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test("a real model call runs isolated, and only owned paths come back", paid, async () => {
  const ws = stageWorkspace();
  const events: { type: string; text: string }[] = [];
  try {
    const outcome = await runStepInContainer({
      workspaceRoot: ws,
      libraryRoot: path.join(ws, "..", "no-library"),
      input: {
        ...baseInput,
        prompt:
          "Write exactly one short sentence into outputs/note.md using the Write tool, then stop.",
      },
      env: modelCreds,
      emit: (type, text) => events.push({ type, text }),
    });
    assert.equal(outcome.status, "completed", JSON.stringify(events.slice(-5)));
    assert.ok(
      fs.existsSync(path.join(ws, "agents/writer/outputs/note.md")),
      "the file written inside arrived on the host",
    );
    assert.equal(
      fs.readFileSync(path.join(ws, "knowledge/policy.md"), "utf8"),
      "authored truth\n",
      "knowledge survives whatever happened in there",
    );
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});
