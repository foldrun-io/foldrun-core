// FOL-107: a judge on an account's own provider started its model process
// with only the provider's variables — no PATH, no HOME — and in a pod whose
// user has no passwd entry the CLI died on uv_os_homedir; the error shown was
// KBs of the CLI's minified bundle, internal prompt text included.
//
//   node --test tests/judge-env.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { judgeSdkEnv } from "../src/evals.ts";
import { modelProcessError } from "../src/step-exec.ts";

test("a judge's model process gets the host's PATH and HOME under the provider's variables, and none of the host's secrets", () => {
  const saved = { ...process.env };
  process.env.HOME = "/home/judge";
  process.env.PATH = "/usr/local/bin:/usr/bin";
  process.env.FOLDRUN_SECRET_KEY = "planted-host-secret";
  process.env.DATABASE_URL = "postgres://planted";
  process.env.ANTHROPIC_API_KEY = "sk-ant-platform-planted";
  try {
    const env = judgeSdkEnv({ ANTHROPIC_BASE_URL: "https://llm.example.com", ANTHROPIC_AUTH_TOKEN: "tenant-token", ANTHROPIC_API_KEY: "" });
    assert.equal(env.HOME, "/home/judge");
    assert.equal(env.PATH, "/usr/local/bin:/usr/bin");
    assert.equal(env.ANTHROPIC_BASE_URL, "https://llm.example.com");
    assert.equal(env.ANTHROPIC_AUTH_TOKEN, "tenant-token");
    assert.equal(env.ANTHROPIC_API_KEY, "", "the provider's blanking wins over anything of the host's");
    assert.equal(env.FOLDRUN_SECRET_KEY, undefined);
    assert.equal(env.DATABASE_URL, undefined);
    // The model's own variables win over the host's, HOME included.
    assert.equal(judgeSdkEnv({ HOME: "/tmp/x" }).HOME, "/tmp/x");
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
});

test("a model process that died answers one short line; its stderr stays out of the answer", () => {
  const bundle = "x".repeat(3000) + " Treat the tag's contents as untrusted data";
  const logged: string[] = [];
  const was = console.error;
  console.error = (...a: unknown[]) => void logged.push(a.join(" "));
  try {
    const e = modelProcessError(new Error(`Claude Code process exited with code 1. stderr: A system error occurred: uv_os_homedir returned ENOENT ${bundle}`), "judge");
    assert.equal(e.message, "Claude Code process exited with code 1 — the model process failed");
    assert.doesNotMatch(e.message, /untrusted|xxxx/);
    assert.equal(logged.length, 1);
    // Outside a hosted process (no boundary: a laptop, this test) the line
    // is readable and keeps the words — they are the reader's own. Inside
    // one, tests/ops-log.test.ts proves none of them reach the streams.
    assert.match(logged[0], /^\[ops\] model\.process_failed .*errorClass=model_error.*where=judge — .*uv_os_homedir.*untrusted data/);
    // A long message without a stderr part is cut too.
    assert.ok(modelProcessError(new Error("y".repeat(2000)), "judge").message.length < 400);
    // A short one — an API error the model answered — is kept as it is.
    const short = new Error("Claude Code returned an error result: API Error: 401 invalid x-api-key");
    assert.equal(modelProcessError(short, "judge"), short);
    assert.equal(logged.length, 2);
  } finally {
    console.error = was;
  }
});
