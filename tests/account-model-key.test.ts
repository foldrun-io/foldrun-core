// Multi-tenant model keys: a hosted platform runs only its operator's
// accounts on its own model credential, and every other account brings its
// own API key — set once in the account vault (Settings → Model), no
// provider: block needed. Exercised through a fake executor, which sees the
// args a cluster would.
//
//   node --test tests/account-model-key.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startFlowRun, waitForRun } from "../src/runner.ts";
import { registerPlatform, platform } from "../src/platform.ts";
import { setSecret } from "../src/secrets.ts";
import { ACCOUNT_MODEL_SECRETS, accountModelBlock, isClaudeLoginToken } from "../src/model-credential.ts";
import type { RunInContainerArgs, ContainerStepOutcome } from "../src/run-container.ts";

type Fake = (args: RunInContainerArgs) => Promise<ContainerStepOutcome>;

async function withAccount(opts: { allowed: boolean }, body: (calls: RunInContainerArgs[]) => Promise<void>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-modelkey-"));
  const prev = { data: process.env.FOLDRUN_DATA, iso: process.env.FOLDRUN_RUN_ISOLATION, key: process.env.ANTHROPIC_API_KEY };
  process.env.FOLDRUN_DATA = root;
  process.env.FOLDRUN_RUN_ISOLATION = "fake";
  process.env.ANTHROPIC_API_KEY = "sk-ant-api03-the-operators-own-key-000000";
  const calls: RunInContainerArgs[] = [];
  const fake: Fake = async (args) => {
    calls.push(args);
    return { status: "completed", result: "done", costUsd: 0 };
  };
  const prevHooks = { isolation: platform.isolation, allowed: platform.platformKeyAllowed };
  registerPlatform({ isolation: { fake }, platformKeyAllowed: () => opts.allowed });
  try {
    const ws = path.join(root, "acme/workspaces/desk");
    fs.mkdirSync(path.join(ws, "agents/worker"), { recursive: true });
    fs.mkdirSync(path.join(ws, "runs"), { recursive: true });
    fs.writeFileSync(path.join(ws, "AGENTS.md"), "---\nname: desk\n---\n");
    fs.writeFileSync(path.join(ws, "agents/worker/agent.md"), "---\nname: worker\ndescription: works\n---\n\nWork.\n");
    await body(calls);
  } finally {
    registerPlatform({ isolation: prevHooks.isolation, platformKeyAllowed: prevHooks.allowed });
    for (const [k, v] of [["FOLDRUN_DATA", prev.data], ["FOLDRUN_RUN_ISOLATION", prev.iso], ["ANTHROPIC_API_KEY", prev.key]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const step = { agent: "worker", instruction: "work", group: 1, optional: false };
const run = async () => {
  const r = startFlowRun("acme", "desk", [step], "f");
  return (await waitForRun("acme", "desk", r.id, 20_000)).run!;
};

test("a customer account with no key of its own is refused before a sandbox, and told what to do", async () => {
  await withAccount({ allowed: false }, async (calls) => {
    const done = await run();
    assert.equal(done.status, "failed");
    assert.equal(calls.length, 0, "no sandbox rented, and the operator's key never used");
    assert.ok(done.steps[0].events.some((e) => /no model key: .*Settings → Model/.test(e.text)), done.steps[0].events.map((e) => e.text).join("\n"));
  });
});

test("a customer's own API key, set in the account vault, is what its steps run on", async () => {
  await withAccount({ allowed: false }, async (calls) => {
    setSecret("acme", ACCOUNT_MODEL_SECRETS.provider, "anthropic");
    setSecret("acme", ACCOUNT_MODEL_SECRETS.key, "sk-ant-api03-the-customers-own-key-111111");
    const done = await run();
    assert.equal(done.status, "completed", done.steps[0].events.map((e) => e.text).join("\n"));
    assert.equal(calls.length, 1);
    assert.match(done.steps[0].credential ?? "", /^provider: anthropic https:\/\/api\.anthropic\.com/);
    const env = JSON.stringify(calls[0].env);
    assert.doesNotMatch(env, /the-operators-own-key/, "the operator's key never reaches a customer's step");
  });
});

test("a Claude login token is refused as a customer's key", async () => {
  await withAccount({ allowed: false }, async (calls) => {
    setSecret("acme", ACCOUNT_MODEL_SECRETS.provider, "anthropic");
    setSecret("acme", ACCOUNT_MODEL_SECRETS.key, "sk-ant-oat01-a-claude-login-token-222222");
    const done = await run();
    assert.equal(done.status, "failed");
    assert.equal(calls.length, 0);
    assert.ok(done.steps[0].events.some((e) => /Claude login token .* cannot be used here/.test(e.text)));
  });
});

test("the operator's own accounts keep running on the platform key", async () => {
  await withAccount({ allowed: true }, async (calls) => {
    const done = await run();
    assert.equal(done.status, "completed", done.steps[0].events.map((e) => e.text).join("\n"));
    assert.equal(calls.length, 1);
    assert.doesNotMatch(done.steps[0].credential ?? "", /^provider:/, "the platform credential, not a provider");
  });
});

test("the account block and the login-token test", () => {
  const read = (m: Record<string, string>) => (n: string) => m[n] ?? null;
  assert.equal(accountModelBlock(read({})), undefined, "no key, no block");
  assert.deepEqual(accountModelBlock(read({ FOLDRUN_MODEL_API_KEY: "k", FOLDRUN_MODEL_PROVIDER: "openrouter" })), {
    token: "${FOLDRUN_MODEL_API_KEY}",
    name: "openrouter",
  });
  assert.deepEqual(
    accountModelBlock(read({ FOLDRUN_MODEL_API_KEY: "k", FOLDRUN_MODEL_BASE_URL: "https://llm.example.com/v1", FOLDRUN_MODEL_FORMAT: "openai" })),
    { token: "${FOLDRUN_MODEL_API_KEY}", base_url: "https://llm.example.com/v1", format: "openai" },
  );
  assert.ok(isClaudeLoginToken("sk-ant-oat01-abc"));
  assert.ok(!isClaudeLoginToken("sk-ant-api03-abc"));
  assert.ok(!isClaudeLoginToken("sk-or-v1-abc"));
});

// Work outside a step — an eval's judge, drafting a flow with AI — resolves
// its key the same way (model-env.ts) and is refused, not billed to the
// operator, for a customer with no key.
test("outside a step: the account's own key, the platform's only when allowed, a login token refused", async () => {
  const { accountModelEnv, ModelKeyError } = await import("../src/model-env.ts");
  await withAccount({ allowed: false }, async () => {
    let platformAsked = 0;
    const platformEnv = () => {
      platformAsked++;
      return { ANTHROPIC_API_KEY: "operator" };
    };
    assert.throws(() => accountModelEnv("acme", "desk", platformEnv), (e: unknown) => e instanceof ModelKeyError && /no model key/.test((e as Error).message));
    assert.equal(platformAsked, 0, "the operator's env is never even built for a customer");
    setSecret("acme", ACCOUNT_MODEL_SECRETS.provider, "anthropic");
    setSecret("acme", ACCOUNT_MODEL_SECRETS.key, "sk-ant-api03-customer-333333");
    const m = accountModelEnv("acme", "desk", platformEnv);
    assert.equal(m.supply, "provider");
    assert.equal(m.env.ANTHROPIC_BASE_URL, "https://api.anthropic.com");
    assert.match(JSON.stringify(m.env), /customer-333333/);
    setSecret("acme", ACCOUNT_MODEL_SECRETS.key, "sk-ant-oat01-login-444444");
    assert.throws(() => accountModelEnv("acme", "desk", platformEnv), /Claude login token/);
  });
  await withAccount({ allowed: true }, async () => {
    const m = accountModelEnv("acme", "desk", () => ({ ANTHROPIC_API_KEY: "operator" }));
    assert.equal(m.supply, "platform");
    assert.equal(m.env.ANTHROPIC_API_KEY, "operator");
  });
});

// Billing: tokens are charged only for steps that ran on the platform's own
// model credential, and only in the run they ran in.
test("the meter charges tokens only for platform-key steps that ran here", async () => {
  const { runMeter } = await import("../src/store.ts");
  const s = (o: Record<string, unknown>) => ({ agent: "a", instruction: "", group: 1, optional: false, events: [], status: "completed", ...o });
  const run = {
    id: "r", flow: "f", status: "completed", startedAt: "", steps: [
      s({ credential: "Claude login token (CLAUDE_CODE_OAUTH_TOKEN)", costUsd: 1.0 }),
      s({ credential: "provider: anthropic https://api.anthropic.com", costUsd: 5.0 }),
      s({ credential: "API key (ANTHROPIC_API_KEY)", costUsd: 0.5, carriedFrom: "run-earlier" }),
      s({ credential: "API key (ANTHROPIC_API_KEY)", costUsd: 9.0, status: "skipped" }),
    ],
  } as never;
  assert.equal(runMeter(run).tokenCostUsd, 1.0, "BYOK, carried and skipped steps are not charged tokens");
  assert.equal(runMeter(run).steps, 2);
});
