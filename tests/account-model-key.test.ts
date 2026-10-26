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
    // The command it names is the CLI's real one, and the record never says
    // the step ran on the operator's login (FOL-14, 18 Oct 2026).
    assert.ok(done.steps[0].events.some((e) => /`foldrun account model set <provider> --key …`/.test(e.text)));
    assert.ok(!done.steps[0].events.some((e) => /^model credential: /.test(e.text)), "no credential line for a refused account");
    assert.equal(done.steps[0].credential, "none — this account has no model key");
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

// FOL-16: a judge or a draft on an OpenAI-format key goes through the same
// translator a step uses, instead of "judge not run".
test("outside a step: an OpenAI-format account key is reached through the translator", async () => {
  const http = await import("node:http");
  const { accountModelEnv, withModelEnv } = await import("../src/model-env.ts");
  const seen: { path: string; auth: string; body: Record<string, unknown> }[] = [];
  const upstream = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c: Buffer) => (raw += c.toString()));
    req.on("end", () => {
      seen.push({ path: req.url ?? "", auth: String(req.headers.authorization ?? ""), body: JSON.parse(raw || "{}") });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        id: "c1", object: "chat.completion", model: "gpt-test",
        choices: [{ index: 0, message: { role: "assistant", content: "PASS — it does" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 5, completion_tokens: 3 },
      }));
    });
  });
  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
  const port = (upstream.address() as { port: number }).port;
  try {
    await withAccount({ allowed: false }, async () => {
      setSecret("acme", ACCOUNT_MODEL_SECRETS.key, "sk-openai-customer-555555");
      setSecret("acme", ACCOUNT_MODEL_SECRETS.baseUrl, `http://127.0.0.1:${port}/v1`);
      setSecret("acme", ACCOUNT_MODEL_SECRETS.format, "openai");
      const m = accountModelEnv("acme", "desk", () => ({}));
      assert.equal(m.format, "openai");
      assert.ok(m.translator, "a Chat Completions key needs the translator");
      const text = await withModelEnv(m, async (env) => {
        assert.match(env.ANTHROPIC_BASE_URL ?? "", /^http:\/\/127\.0\.0\.1:\d+/);
        assert.notEqual(env.ANTHROPIC_BASE_URL, `http://127.0.0.1:${port}/v1`, "the SDK talks to the translator, not the provider");
        const res = await fetch(`${env.ANTHROPIC_BASE_URL}/v1/messages`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-api-key": env.ANTHROPIC_API_KEY ?? "", "anthropic-version": "2023-06-01" },
          body: JSON.stringify({ model: "gpt-test", max_tokens: 50, messages: [{ role: "user", content: "grade this" }] }),
        });
        assert.equal(res.status, 200);
        const body = (await res.json()) as { content: { type: string; text?: string }[] };
        return body.content.map((b) => b.text ?? "").join("");
      });
      assert.match(text, /^PASS/);
      assert.equal(seen.length, 1);
      assert.equal(seen[0].path, "/v1/chat/completions");
      assert.equal(seen[0].auth, "Bearer sk-openai-customer-555555");
    });
  } finally {
    upstream.close();
  }
});

test("an Anthropic-format key needs no translator, and withModelEnv passes its env straight through", async () => {
  const { withModelEnv } = await import("../src/model-env.ts");
  const env = { ANTHROPIC_BASE_URL: "https://api.anthropic.com" };
  assert.equal(await withModelEnv({ env, translator: null }, async (e) => e), env);
});

// FOL-19: a declared secret named like the step's model variables used to be
// spread over them in the sandbox's env, replacing the model's endpoint/key.
test("a secret named like a model variable crosses under a prefix; the model keeps its own", async () => {
  await withAccount({ allowed: true }, async (calls) => {
    const ws = path.join(process.env.FOLDRUN_DATA!, "acme/workspaces/desk");
    fs.writeFileSync(
      path.join(ws, "agents/worker/agent.md"),
      "---\nname: worker\ndescription: works\nsecrets: [ANTHROPIC_BASE_URL, ANTHROPIC_API_KEY, MY_TOKEN]\n---\n\nWork.\n",
    );
    setSecret("acme", "ANTHROPIC_BASE_URL", "https://attacker.example.com", "desk");
    setSecret("acme", "ANTHROPIC_API_KEY", "sk-ant-api03-customer-declared-777777", "desk");
    setSecret("acme", "MY_TOKEN", "tok-888888", "desk");
    const done = await run();
    assert.equal(done.status, "completed", done.steps[0].events.map((e) => e.text).join("\n"));
    const env = calls[0].env as Record<string, string>;
    assert.notEqual(env.ANTHROPIC_BASE_URL, "https://attacker.example.com");
    assert.notEqual(env.ANTHROPIC_BASE_URL, "${ANTHROPIC_BASE_URL}", "not even as a placeholder");
    assert.doesNotMatch(env.ANTHROPIC_API_KEY ?? "", /customer-declared|\$\{ANTHROPIC_API_KEY\}/);
    assert.ok("FOLDRUN_DECLARED_ANTHROPIC_BASE_URL" in env && "FOLDRUN_DECLARED_ANTHROPIC_API_KEY" in env, "they cross under the prefix, for the agent's own tools");
    assert.ok("MY_TOKEN" in env, "other declared secrets cross as before");
    assert.ok(done.steps[0].events.some((e) => /secrets: ANTHROPIC_BASE_URL, ANTHROPIC_API_KEY kept away from the model's own settings/.test(e.text)));
  });
});

test("a container step with no model credential anywhere is refused before a sandbox, saying what to set", async () => {
  await withAccount({ allowed: true }, async (calls) => {
    // Core's own Docker executor, as self-hosting runs it: refused before it
    // is reached, so no Docker is needed here.
    process.env.FOLDRUN_RUN_ISOLATION = "container";
    const saved = { key: process.env.ANTHROPIC_API_KEY, oauth: process.env.CLAUDE_CODE_OAUTH_TOKEN, auth: process.env.ANTHROPIC_AUTH_TOKEN };
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    delete process.env.ANTHROPIC_AUTH_TOKEN;
    try {
      const done = await run();
      assert.equal(done.status, "failed");
      assert.equal(calls.length, 0, "no sandbox rented for a step that could only fail at the model");
      const texts = done.steps[0].events.map((e) => e.text).join("\n");
      assert.match(texts, /no model credential: .*ANTHROPIC_API_KEY.*self-hosting\/\.env.*Settings → Model/, texts);
      assert.equal(done.steps[0].credential, "none set");
      assert.doesNotMatch(texts, /fall back to whatever login/, "no machine login to fall back to in a container");
    } finally {
      for (const [k, v] of [["ANTHROPIC_API_KEY", saved.key], ["CLAUDE_CODE_OAUTH_TOKEN", saved.oauth], ["ANTHROPIC_AUTH_TOKEN", saved.auth]] as const) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });
});

test("a registered executor with no platform credential is still offered the step: it may bring its own", async () => {
  await withAccount({ allowed: true }, async (calls) => {
    const saved = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      const done = await run();
      assert.equal(calls.length, 1);
      assert.equal(done.status, "completed");
    } finally {
      if (saved === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = saved;
    }
  });
});
