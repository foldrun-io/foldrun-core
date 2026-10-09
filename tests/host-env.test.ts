// What a step's children inherit from the host process: an allowlist, never
// process.env whole.
//
// On a platform process.env holds FOLDRUN_SECRET_KEY — the root every
// tenant's vault and hook token derives from — the database URL and the
// object-store, mail and Stripe credentials. Scripts, verify: shells and the
// SDK's Bash tool used to start from all of it; the Test button had its own
// stripped copy. One definition now, on every in-process spawn.
//
//   node --test tests/host-env.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { hostEnvAllowed, hostSafeEnv } from "../src/host-env.ts";
import { runScript, type ScriptSpec } from "../src/script-tools.ts";
import { checkVerify } from "../src/step-exec.ts";

const PLANTED = {
  FOLDRUN_SECRET_KEY: "root-key-0123456789",
  DATABASE_URL: "postgres://user:pw@db/foldrun",
  AWS_SECRET_ACCESS_KEY: "aws-secret-0123456789",
  STRIPE_SECRET_KEY: "sk_live_0123456789",
  FOLDRUN_RESEND_API_KEY: "re_0123456789",
};

function planted<T>(body: () => Promise<T> | T): Promise<T> | T {
  const prev: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(PLANTED)) {
    prev[k] = process.env[k];
    process.env[k] = v;
  }
  process.env.FOLDRUN_RUN_ID = "run-host-env";
  const done = () => {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    delete process.env.FOLDRUN_RUN_ID;
  };
  try {
    const r = body();
    return r instanceof Promise ? r.finally(done) : (done(), r);
  } catch (e) {
    done();
    throw e;
  }
}

test("the rule: an interpreter's needs, the locale, the clock, proxies, and the run's own identifiers", () => {
  for (const k of ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "LC_CTYPE", "TZ", "TERM", "NODE_ENV", "NODE_OPTIONS", "HTTPS_PROXY", "FOLDRUN_RUN_ID", "FOLDRUN_STEP_INDEX", "CLAUDE_CONFIG_DIR"]) {
    assert.ok(hostEnvAllowed(k), `${k} passes`);
  }
  for (const k of [...Object.keys(PLANTED), "FOLDRUN_DATA", "FOLDRUN_FALLBACK_TOKEN", "FOLDRUN_RUNNER_IMAGE", "ANTHROPIC_API_KEY", "GITHUB_TOKEN", "KUBECONFIG"]) {
    assert.ok(!hostEnvAllowed(k), `${k} is kept back`);
  }
});

test("hostSafeEnv is process.env minus everything that is not on the list", () =>
  planted(() => {
    const env = hostSafeEnv();
    for (const k of Object.keys(PLANTED)) assert.equal(env[k], undefined, `${k} must not cross`);
    assert.equal(env.FOLDRUN_RUN_ID, "run-host-env");
    assert.equal(env.PATH, process.env.PATH);
    // A fresh object: layering secrets on top never writes into the host's env.
    env.PLANTED_BY_TEST = "x";
    assert.equal(process.env.PLANTED_BY_TEST, undefined);
  }));

test("an in-process script sees its declared secret and the run id, and none of the platform's", () =>
  planted(async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-hostenv-"));
    try {
      const agentDir = path.join(root, "agents", "worker");
      fs.mkdirSync(agentDir, { recursive: true });
      const spec: ScriptSpec = {
        name: "env",
        run: "",
        description: "prints the environment",
        args: {},
        code: "process.stdout.write(JSON.stringify(process.env));\n",
        codeExt: ".mjs",
      };
      const { code, out } = await runScript(agentDir, spec, {}, { MY_TOKEN: "declared-0123456789" }, "", {}, null);
      assert.equal(code, 0, out);
      const seen = JSON.parse(out) as Record<string, string>;
      assert.equal(seen.MY_TOKEN, "declared-0123456789", "the declared secret is there");
      assert.equal(seen.FOLDRUN_RUN_ID, "run-host-env", "the run's identifier is there");
      assert.ok(seen.PATH, "an interpreter can still be found");
      for (const k of Object.keys(PLANTED)) assert.equal(seen[k], undefined, `${k} reached the script`);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }));

test("a verify: shell starts from the same base", () =>
  planted(async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-hostenv-"));
    try {
      const verdict = await checkVerify(
        root,
        'test -z "$FOLDRUN_SECRET_KEY" && test -z "$DATABASE_URL" && test -n "$MY_TOKEN" && test "$FOLDRUN_RUN_ID" = run-host-env',
        { env: { MY_TOKEN: "declared" }, result: null },
      );
      assert.equal(verdict.ok, true, verdict.detail);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }));

// A desk that reads its own run history wrote the host into its files, so the
// same workspace would have called dev.foldrun.io after moving to production.
test("a step learns its own API's address from the install, never from the desk", async () => {
  const { platformApiUrl, expandPlatformVars } = await import("../src/host-env.ts");
  const { parseApis } = await import("../src/store.ts");
  assert.equal(platformApiUrl({ FOLDRUN_PUBLIC_URL: "https://app.foldrun.io/" }), "https://app.foldrun.io/api");
  assert.equal(platformApiUrl({ FOLDRUN_API_URL: "https://api.foldrun.io/", FOLDRUN_PUBLIC_URL: "https://x" }), "https://api.foldrun.io");
  assert.equal(platformApiUrl({}), undefined);
  assert.equal(expandPlatformVars("${FOLDRUN_API_URL}/v1", { FOLDRUN_PUBLIC_URL: "https://app.foldrun.io" }), "https://app.foldrun.io/api/v1");
  // Only the install's addresses: a secret named in a base stays unexpanded,
  // because the base is printed in the prompt.
  assert.equal(expandPlatformVars("https://${CRM_TOKEN}@x", { CRM_TOKEN: "s3cret" }), "https://${CRM_TOKEN}@x");
  assert.equal(expandPlatformVars("${FOLDRUN_API_URL}", {}), "${FOLDRUN_API_URL}");
  const before = process.env.FOLDRUN_PUBLIC_URL;
  process.env.FOLDRUN_PUBLIC_URL = "https://app.foldrun.io";
  try {
    assert.equal(parseApis([{ name: "self", base: "${FOLDRUN_API_URL}/" }])[0].base, "https://app.foldrun.io/api");
  } finally {
    if (before === undefined) delete process.env.FOLDRUN_PUBLIC_URL; else process.env.FOLDRUN_PUBLIC_URL = before;
  }
});

test("an apis: base left unfilled is reported unavailable, not handed to the model", async () => {
  const { buildApiTools } = await import("../src/api-tools.ts");
  const r = buildApiTools("t", [{ name: "self", base: "${FOLDRUN_API_URL}", description: "", headers: {}, query: {}, methods: ["GET"] }], "ws", { env: {}, missing: [] });
  assert.equal(r.toolNames.length, 0);
  assert.match(r.promptLines.join("\n"), /self\*\* — unavailable this run/);
});
