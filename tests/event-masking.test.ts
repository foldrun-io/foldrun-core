// A credential in a run EVENT that is not in the vault.
//
// The runner scrubbed events by the step's own secret values only. A tool
// failure's first 300 characters, a "delegating to X: <prompt>" line, a
// script's stderr tail all come out of the sandbox as text, and a key the
// tool printed (a token it read from a file, an AWS key in an env dump, a
// private key from `cat ~/.ssh/id_rsa`) is not a vault value, so it landed on
// the record in clear — where viewers, A2A callers, notifications and
// exports read it. Captured calls were already pattern-masked (capture.ts);
// events now go through the same mask.
//
//   node --test tests/event-masking.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startFlowRun, waitForRun } from "../src/runner.ts";
import { registerPlatform, platform } from "../src/platform.ts";
import type { RunInContainerArgs, ContainerStepOutcome } from "../src/run-container.ts";

const GHP = "ghp_" + "aB3dE5fG7hJ9kL1mN3pQ5rS7tU9vW1xY3zA5";
const ANT = "sk-ant-api03-" + "Zx9Qw3Er5Ty7Ui1Op3As5Df7Gh9Jk1Lz3Xc5Vb7Nm9Q-Az3Rt5Yu7";
const AWS = "AKIA" + "IOSFODNN7XQ4ZPLM";
// built, not spelled: a literal key body here trips the repo's secret scanner
const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const line = (k: number) => Array.from({ length: 64 }, (_, i) => B64[(i * k + 5) % 64]).join("");
const KEY_BODY = `${line(13)}\n${line(29)}`;
const PEM = `-----BEGIN RSA PRIVATE KEY-----\n${KEY_BODY}\n-----END RSA PRIVATE KEY-----`;
const SHAPES = [GHP, ANT, AWS, KEY_BODY.slice(0, 40)];

async function withFake(fake: (args: RunInContainerArgs) => Promise<ContainerStepOutcome>, body: (root: string) => Promise<void>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-evmask-"));
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
    fs.writeFileSync(path.join(ws, "agents/worker/agent.md"), "---\nname: worker\ndescription: works\n---\n\nWork.\n");
    await body(root);
  } finally {
    registerPlatform({ isolation: prevIso });
    for (const [k, v] of [["FOLDRUN_DATA", prev.data], ["FOLDRUN_RUN_ISOLATION", prev.iso]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const run = async (fake: (args: RunInContainerArgs) => Promise<ContainerStepOutcome>) => {
  let done: Awaited<ReturnType<typeof waitForRun>>["run"];
  await withFake(fake, async () => {
    const r = startFlowRun("acme", "desk", [{ agent: "worker", instruction: "work", group: 1, optional: false }], "f");
    done = (await waitForRun("acme", "desk", r.id, 20_000)).run;
  });
  return done!;
};

test("a credential not in the vault never reaches a stored event (tool error, delegation, stderr, operator)", async () => {
  const done = await run(async (args) => {
    // what step-exec emits for a failed tool: `<name>: <first 300 chars of the output>`
    args.emit("error", `Bash: cat failed — GITHUB_TOKEN=${GHP} was rejected, key ${ANT}`, { call: "t1" });
    // `delegating to X: <first 160 chars of the prompt>`
    args.emit("info", `delegating to scout: use ${AWS} to list the bucket`, { subagent: "scout" });
    // the stderr tail the container driver reports
    args.emit("error", `Traceback (most recent call last):\n  File "x.py", line 3\n${PEM}`);
    // a question the agent asked: stored on the event and on step.questions
    args.emit("info", "asked", { operator: { kind: "asked", id: "q1", question: `Is ${GHP} the right token?`, options: [AWS, "no"] } });
    return { status: "failed", result: null, conclusion: null, costUsd: 0 };
  });
  const s = done.steps[0]!;
  const raw = JSON.stringify(done);
  for (const piece of SHAPES) assert.ok(!raw.includes(piece), `the record must not carry ${piece.slice(0, 8)}…`);
  assert.ok(s.events.some((e) => e.type === "error" && /^Bash: cat failed/.test(e.text)), "the sentence around the key stays");
  assert.ok(s.events.some((e) => /^delegating to scout: use /.test(e.text)));
  // the failure the run shows is the last error event, masked
  assert.ok(!JSON.stringify(s.tries ?? []).includes("BEGIN RSA"), "the retry row carries no key block");
});

test("ordinary output stays readable: ids, urls, paths, hashes, plain words", async () => {
  const lines = [
    "Bash: ENOENT: no such file or directory, open '/workspace/data/report.csv'",
    "WebFetch: 404 for https://example.com/docs/page?id=12345&sort=asc&ref=abcdef0123456789",
    "run-mvfa499h-brps failed at commit 3f786850e387550fdab836ed7e6dc881de23001b",
    "request id 123e4567-e89b-12d3-a456-426614174000 took 4.2s; token limit 100000 reached",
    "password: required — set api_key: ${API_KEY} in the vault; Bearer <token> is the format",
    "toolu_01A09q90qw90lq917835lq9 returned 3 rows; sha256 of the file is e3b0c44298fc1c149afbf4c8996fb924",
  ];
  const done = await run(async (args) => {
    for (const l of lines) args.emit("error", l);
    return { status: "failed", result: null, conclusion: null, costUsd: 0 };
  });
  const text = done.steps[0]!.events.map((e) => e.text);
  for (const l of lines) assert.ok(text.includes(l), `unchanged: ${l}`);
});
