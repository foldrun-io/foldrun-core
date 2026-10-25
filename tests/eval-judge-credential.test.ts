// The eval judge runs in the web process, whose CLAUDE_CODE_OAUTH_TOKEN is the
// copy it got at boot. The box refreshes the Claude login every four hours and
// the old token is revoked, so the judge has to read the live credential file
// (FOLDRUN_MODEL_KEY_FILE) the way agent steps do. On 2026-10-21 it did not,
// and every judged eval after a refresh failed with "OAuth token revoked".

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { judgeProcessEnv } from "../src/evals.ts";

test("the judge reads the live credential file, not the boot copy", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "judge-cred-"));
  const file = path.join(dir, "token");
  fs.writeFileSync(file, "sk-ant-oat01-fresh\n");
  const saved = { file: process.env.FOLDRUN_MODEL_KEY_FILE, token: process.env.CLAUDE_CODE_OAUTH_TOKEN };
  process.env.FOLDRUN_MODEL_KEY_FILE = file;
  process.env.CLAUDE_CODE_OAUTH_TOKEN = "sk-ant-oat01-boot";
  try {
    assert.equal(judgeProcessEnv().CLAUDE_CODE_OAUTH_TOKEN, "sk-ant-oat01-fresh");
    // After a refresh the file changes and the next judge sees it at once.
    fs.writeFileSync(file, "sk-ant-oat01-refreshed\n");
    assert.equal(judgeProcessEnv().CLAUDE_CODE_OAUTH_TOKEN, "sk-ant-oat01-refreshed");
    // The rest of the environment (PATH and the like) is still there.
    assert.equal(judgeProcessEnv().PATH, process.env.PATH);
  } finally {
    if (saved.file === undefined) delete process.env.FOLDRUN_MODEL_KEY_FILE;
    else process.env.FOLDRUN_MODEL_KEY_FILE = saved.file;
    if (saved.token === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    else process.env.CLAUDE_CODE_OAUTH_TOKEN = saved.token;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("with no credential file the judge keeps the process's own token", () => {
  const saved = { file: process.env.FOLDRUN_MODEL_KEY_FILE, token: process.env.CLAUDE_CODE_OAUTH_TOKEN };
  delete process.env.FOLDRUN_MODEL_KEY_FILE;
  process.env.CLAUDE_CODE_OAUTH_TOKEN = "sk-ant-oat01-local";
  try {
    assert.equal(judgeProcessEnv().CLAUDE_CODE_OAUTH_TOKEN, "sk-ant-oat01-local");
  } finally {
    if (saved.file === undefined) delete process.env.FOLDRUN_MODEL_KEY_FILE;
    else process.env.FOLDRUN_MODEL_KEY_FILE = saved.file;
    if (saved.token === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    else process.env.CLAUDE_CODE_OAUTH_TOKEN = saved.token;
  }
});
