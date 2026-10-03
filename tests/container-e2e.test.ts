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
} from "../src/run-container.ts";

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

// The local executor's other container: one per script call. A folder tool's
// code sits in the workspace's tools/<name>/, which was never mounted, so the
// hello template's wordcount failed on every call with "can't open file".
test("a folder tool runs in its script container, while the step holds its workspace link: tools/ is mounted, outputs/ is writable", opts, async () => {
  const { runScript } = await import("../src/script-tools.ts");
  const { ensureImage } = await import("../src/container.ts");
  const { scriptMounts } = await import("../src/runner.ts");
  const ws = stageWorkspace();
  try {
    fs.mkdirSync(path.join(ws, "tools/count"), { recursive: true });
    fs.writeFileSync(
      path.join(ws, "tools/count/run.py"),
      "import sys\nn=len(sys.argv[2].split())\nopen('outputs/count.txt','w').write(str(n))\nprint('words', n)\n",
    );
    const agentDir = path.join(ws, "agents/writer");
    // The link every step holds while it runs (`docker cp` refused it), and
    // the outputs/ every step makes before it starts.
    fs.symlinkSync("../..", path.join(agentDir, "workspace"), "dir");
    fs.mkdirSync(path.join(agentDir, "outputs"), { recursive: true });
    const image = ensureImage(null);
    assert.equal(image.error, null, image.log.join("\n"));
    const got = await runScript(
      agentDir,
      { name: "count", run: "workspace/tools/count/run.py", args: { text: "the text" }, description: "" } as never,
      { text: "two words" },
      {},
      "",
      {},
      { executor: "docker", image: image.tag, mounts: scriptMounts(agentDir, "default"), network: false },
    );
    assert.equal(got.code, 0, got.out);
    assert.match(got.out, /words 2/);
    // docker cp lands files as root and scripts run as `agent`: outputs/
    // was never writable, and the copy-back after the run had nothing to bring.
    assert.equal(fs.readFileSync(path.join(agentDir, "outputs/count.txt"), "utf8"), "2");
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

// workspace/… is the workspace root on the host (the step's link) and in a
// run container. A script container has no link, so each such argument is
// staged in and what the script wrote is copied back.
test("a script handed workspace/… paths reads one and writes another, as on the host", opts, async () => {
  const { runScript } = await import("../src/script-tools.ts");
  const { ensureImage } = await import("../src/container.ts");
  const { scriptMounts } = await import("../src/runner.ts");
  const ws = stageWorkspace();
  try {
    fs.mkdirSync(path.join(ws, "storage"), { recursive: true });
    fs.writeFileSync(path.join(ws, "storage/in.csv"), "a,b\n1,2\n3,4\n");
    const old = new Date("2026-01-01T00:00:00Z");
    fs.utimesSync(path.join(ws, "storage/in.csv"), old, old);
    fs.mkdirSync(path.join(ws, "tools/rows"), { recursive: true });
    fs.writeFileSync(
      path.join(ws, "tools/rows/run.py"),
      "import argparse\np=argparse.ArgumentParser();p.add_argument('--src');p.add_argument('--dst');a=p.parse_args()\n" +
        "n=len(open(a.src).read().strip().splitlines())-1\nopen(a.dst,'w').write(f'rows {n}\\n');print('rows',n)\n",
    );
    const agentDir = path.join(ws, "agents/writer");
    fs.symlinkSync("../..", path.join(agentDir, "workspace"), "dir");
    const image = ensureImage(null);
    const got = await runScript(
      agentDir,
      { name: "rows", run: "workspace/tools/rows/run.py", args: { src: "in", dst: "out" }, description: "" } as never,
      { src: "workspace/storage/in.csv", dst: "workspace/storage/report/rows.txt" },
      {}, "", {},
      { executor: "docker", image: image.tag, mounts: scriptMounts(agentDir, "default"), network: false },
    );
    assert.equal(got.code, 0, got.out);
    assert.match(got.out, /rows 2/);
    assert.equal(fs.readFileSync(path.join(ws, "storage/report/rows.txt"), "utf8"), "rows 2\n", "the write came back");
    assert.equal(fs.statSync(path.join(ws, "storage/in.csv")).mtime.getTime(), old.getTime(), "the input kept its mtime");
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});
