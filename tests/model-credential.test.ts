// The platform's model credential is read when a step needs it, not when the
// process booted. Refreshing an OAuth token revokes the old one, so a worker
// holding a boot-time copy answers 401 until somebody restarts it — which is
// what happened on 2026-09-18, to every desk, for two hours.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { platformModelCredential } from "../src/runner.ts";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "cred-"));

test("the file wins over the environment, and is read fresh every time", () => {
  const dir = tmp();
  const file = path.join(dir, "claude-oauth-token");
  fs.writeFileSync(file, "token-one\n");
  const env = { FOLDRUN_MODEL_KEY_FILE: file, CLAUDE_CODE_OAUTH_TOKEN: "stale-boot-copy" } as NodeJS.ProcessEnv;
  assert.equal(platformModelCredential(env), "token-one", "trailing newline trimmed");
  // The refresher rewrites the file in place; the next step must see it
  // without this process being restarted.
  fs.writeFileSync(file, "token-two");
  assert.equal(platformModelCredential(env), "token-two", "no caching: the second read is the new token");
});

test("no file, or an empty one, means the environment — the local and compose path", () => {
  const env = { CLAUDE_CODE_OAUTH_TOKEN: "from-env" } as NodeJS.ProcessEnv;
  assert.equal(platformModelCredential(env), "from-env");
  const dir = tmp();
  const empty = path.join(dir, "empty");
  fs.writeFileSync(empty, "   \n");
  assert.equal(platformModelCredential({ ...env, FOLDRUN_MODEL_KEY_FILE: empty }), "from-env",
    "an empty file is a half-written secret, not an instruction to sign out");
});

test("an unreadable file falls back rather than failing the step", () => {
  const env = { FOLDRUN_MODEL_KEY_FILE: "/does/not/exist", CLAUDE_CODE_OAUTH_TOKEN: "from-env" } as NodeJS.ProcessEnv;
  assert.equal(platformModelCredential(env), "from-env");
});

test("nothing anywhere is undefined, not an empty string", () => {
  assert.equal(platformModelCredential({} as NodeJS.ProcessEnv), undefined);
});
