// foldrun's models from the runner's side: an account that chose the
// platform's key for a provider runs on it — through the egress proxy only,
// as a supply grant the proxy fills — and an account whose choice cannot be
// had now is refused, never moved onto its stored key or the operator's.
// Exercised through a fake executor and a fake lease.
//
//   node --test tests/model-supply.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startFlowRun, waitForRun } from "../src/runner.ts";
import { registerPlatform, platform } from "../src/platform.ts";
import { setSecret } from "../src/secrets.ts";
import { ACCOUNT_MODEL_SECRETS } from "../src/model-credential.ts";
import { billedTokenCost, runMeter, type RunRecord, type StepRecord } from "../src/store.ts";
import type { SupplyAnswer } from "../src/model-supply.ts";
import { supplyProviderOfToken, supplyToken, supplyViaOfToken } from "../src/model-supply.ts";
import type { EgressGrant, EgressLease } from "../src/egress.ts";
import type { RunInContainerArgs, ContainerStepOutcome } from "../src/run-container.ts";

type Captured = { calls: RunInContainerArgs[]; grants: EgressGrant[]; leases: Record<string, unknown>[] };

async function withAccount(
  opts: { supply: SupplyAnswer; noDoor?: boolean; lease?: boolean; agentProvider?: string; ownKeys?: boolean; agentModel?: string; wsFront?: string; supplyFor?: (want: { provider: string; model?: string }) => SupplyAnswer; asked?: unknown[] },
  body: (c: Captured) => Promise<void>,
) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-supply-"));
  const prev = { data: process.env.FOLDRUN_DATA, iso: process.env.FOLDRUN_RUN_ISOLATION, key: process.env.ANTHROPIC_API_KEY };
  process.env.FOLDRUN_DATA = root;
  process.env.FOLDRUN_RUN_ISOLATION = "fake";
  process.env.ANTHROPIC_API_KEY = "sk-ant-api03-the-operators-own-key-000000";
  const c: Captured = { calls: [], grants: [], leases: [] };
  const fake = async (args: RunInContainerArgs): Promise<ContainerStepOutcome> => {
    c.calls.push(args);
    return { status: "completed", result: "done", costUsd: 0.25 };
  };
  const lease = async (args: { grant: EgressGrant }): Promise<EgressLease | null> => {
    if (opts.lease === false) return null;
    c.grants.push(args.grant);
    c.leases.push(args as unknown as Record<string, unknown>);
    return { url: "http://egress.test/e/tok", commit: async () => {}, drainLog: async () => [], release: async () => {} } as unknown as EgressLease;
  };
  const prevHooks = { isolation: platform.isolation, allowed: platform.platformKeyAllowed, supply: platform.modelSupply, egress: platform.egress, own: platform.ownModelKeys };
  // The platform's egress proxy answers foldrun's door (one door, 23 Nov
  // 2026) unless a test says it does not.
  const withDoor = (a: SupplyAnswer): SupplyAnswer => (a.kind === "foldrun" && !opts.noDoor ? { ...a, door: true } : a);
  registerPlatform({ isolation: { fake }, platformKeyAllowed: () => false, modelSupply: (_t, want) => {
    if (!want) return withDoor(opts.supply);
    opts.asked?.push(want);
    return withDoor(opts.supplyFor?.(want) ?? { kind: "refused", reason: "not asked for in this test" });
  }, egress: { lease }, ownModelKeys: opts.ownKeys === undefined ? undefined : () => opts.ownKeys! });
  try {
    const ws = path.join(root, "acme/workspaces/desk");
    fs.mkdirSync(path.join(ws, "agents/worker"), { recursive: true });
    fs.mkdirSync(path.join(ws, "runs"), { recursive: true });
    fs.writeFileSync(path.join(ws, "AGENTS.md"), `---\nname: desk\n${opts.wsFront ?? ""}---\n`);
    fs.writeFileSync(path.join(ws, "agents/worker/agent.md"), `---\nname: worker\ndescription: works\n${opts.agentModel ? `model: ${opts.agentModel}\n` : ""}${opts.agentProvider ?? ""}---\n\nWork.\n`);
    await body(c);
  } finally {
    registerPlatform({ isolation: prevHooks.isolation, platformKeyAllowed: prevHooks.allowed, modelSupply: prevHooks.supply, egress: prevHooks.egress, ownModelKeys: prevHooks.own });
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
const events = (s: StepRecord) => s.events.map((e) => e.text).join("\n");

test("an account on foldrun's models runs on the platform's key — as a supply grant, never a value in the pod", async () => {
  await withAccount({ supply: { kind: "foldrun", provider: "anthropic", tiers: {} } }, async (c) => {
    // A stored key of its own is set too: the choice wins over it.
    setSecret("acme", ACCOUNT_MODEL_SECRETS.key, "sk-ant-api03-the-customers-own-key-111111");
    const done = await run();
    assert.equal(done.status, "completed", events(done.steps[0]));
    assert.equal(done.steps[0].supply, "foldrun");
    assert.equal(done.steps[0].supplyProvider, "anthropic");
    assert.equal(done.steps[0].credential, "foldrun models · Anthropic");
    const env = JSON.stringify(c.calls[0].env);
    assert.ok(!env.includes("sk-ant-api03"), "neither the operator's key nor the customer's reaches the pod");
    assert.ok(!env.includes("foldrun-supply:"), "nor the marker: the pod holds a placeholder");
    assert.match(env, /"ANTHROPIC_API_KEY":"\$\{FOLDRUN_MODEL_KEY\}"/);
    // One door (23 Nov 2026): to foldrun's door, which the proxy answers itself.
    assert.match(env, /egress\.test\/e\/tok\/https:\/\/models\.foldrun\.internal/);
    const g = c.grants[0].secrets.FOLDRUN_MODEL_KEY;
    assert.deepEqual(g, { value: "", hosts: ["models.foldrun.internal"], supply: { provider: "anthropic" } }, "a supply grant: no value in the lease");
    assert.equal(done.steps[0].tries?.[0].supply, "foldrun");
  });
});

test("an account on its Claude subscription (16 Nov 2026): a subscription grant — the proxy sends it on a login, never a value in the pod", async () => {
  await withAccount({ supply: { kind: "foldrun", provider: "anthropic", tiers: {}, via: "login" } }, async (c) => {
    const done = await run();
    assert.equal(done.status, "completed", events(done.steps[0]));
    assert.equal(done.steps[0].supply, "foldrun", "billed as foldrun's models are: by the proxy, never from the step's own tokens");
    assert.equal(done.steps[0].credential, "Claude subscription");
    const env = JSON.stringify(c.calls[0].env);
    assert.ok(!env.includes("sk-ant-api03") && !env.includes("foldrun-supply:"), "no key and no marker in the pod");
    assert.match(env, /egress\.test\/e\/tok\/https:\/\/models\.foldrun\.internal/);
    assert.deepEqual(c.grants[0].secrets.FOLDRUN_MODEL_KEY, { value: "", hosts: ["models.foldrun.internal"], supply: { provider: "anthropic", via: "login" } });
  });
});

test("an OpenAI-format provider: Anthropic's format to foldrun's door, which translates — no translator in the pod, the tier a door name, the key a placeholder", async () => {
  await withAccount({ supply: { kind: "foldrun", provider: "openai", tiers: { default: "gpt-x" } } }, async (c) => {
    const done = await run();
    assert.equal(done.status, "completed", events(done.steps[0]));
    const t = (c.calls[0] as unknown as { input: { translator?: unknown } }).input.translator;
    assert.equal(t ?? null, null);
    const env = c.calls[0].env as Record<string, string>;
    assert.match(env.ANTHROPIC_BASE_URL, /\/e\/tok\/https:\/\/models\.foldrun\.internal$/);
    assert.equal(env.ANTHROPIC_API_KEY, "${FOLDRUN_MODEL_KEY}");
    assert.equal(env.ANTHROPIC_DEFAULT_SONNET_MODEL, "openai/gpt-x");
    assert.deepEqual(c.grants[0].secrets.FOLDRUN_MODEL_KEY.supply, { provider: "openai" });
    assert.ok(!JSON.stringify(c.calls[0]).includes("foldrun-supply:"));
  });
});

test("chosen but refused now: the step fails with why, before a sandbox, and never on the stored key", async () => {
  await withAccount({ supply: { kind: "refused", reason: "foldrun's models are switched off on this platform" } }, async (c) => {
    setSecret("acme", ACCOUNT_MODEL_SECRETS.key, "sk-ant-api03-the-customers-own-key-111111");
    const done = await run();
    assert.equal(done.status, "failed");
    assert.equal(c.calls.length, 0, "no sandbox");
    assert.match(events(done.steps[0]), /switched off .* switch this account back to its own key/);
  });
});

test("no egress proxy: refused before it runs — the key goes nowhere unmetered", async () => {
  await withAccount({ supply: { kind: "foldrun", provider: "anthropic", tiers: {} }, lease: false }, async (c) => {
    const done = await run();
    assert.equal(done.status, "failed");
    assert.equal(c.calls.length, 0);
    assert.match(events(done.steps[0]), /need the platform's egress proxy/);
  });
});

test("a provider: block the account wrote still wins over the choice", async () => {
  await withAccount(
    { supply: { kind: "foldrun", provider: "anthropic", tiers: {} }, agentProvider: "provider:\n  name: anthropic\n  token: ${MINE}\n" },
    async (c) => {
      setSecret("acme", "MINE", "sk-ant-api03-written-in-the-block-22222");
      const done = await run();
      assert.equal(done.status, "completed", events(done.steps[0]));
      assert.equal(done.steps[0].supply, "own");
      assert.ok(!c.grants[0].secrets.FOLDRUN_MODEL_KEY?.supply, "an ordinary grant, the account's own key");
    },
  );
});

test("the meter bills only the operator's credential from the step; foldrun's models are the gateway's to bill", () => {
  const s = (o: Partial<StepRecord>): StepRecord => ({ agent: "a", instruction: "", group: 1, optional: false, status: "completed", events: [], result: "", costUsd: 1, ...o }) as StepRecord;
  assert.equal(billedTokenCost(s({ supply: "operator" })), 1);
  assert.equal(billedTokenCost(s({ supply: "foldrun" })), 0, "billed per call by the gateway, not twice");
  assert.equal(billedTokenCost(s({ supply: "own" })), 0);
  assert.equal(billedTokenCost(s({ credential: "API key (ANTHROPIC_API_KEY)" })), 1, "an old record: the old rule");
  // Attempts on different supplies: each billed by its own.
  const mixed = s({
    supply: "foldrun",
    costUsd: 3,
    tries: [
      { n: 1, status: "failed", costUsd: 2, tokens: null, computeSecs: 1, startedAt: "", finishedAt: "", supply: "operator" },
      { n: 2, status: "completed", costUsd: 1, tokens: null, computeSecs: 1, startedAt: "", finishedAt: "", supply: "foldrun" },
    ],
  });
  assert.equal(billedTokenCost(mixed), 2);
  // A lost slim go spent its tokens: billed by its own supply too.
  const lostGo = s({
    supply: "operator",
    costUsd: 1.5,
    tries: [
      { n: 1, attempt: 1, status: "lost", costUsd: 0.5, tokens: null, computeSecs: 1, startedAt: "", finishedAt: "", supply: "operator" },
      { n: 2, attempt: 1, status: "completed", costUsd: 1, tokens: null, computeSecs: 1, startedAt: "", finishedAt: "", supply: "operator" },
    ],
  });
  assert.equal(billedTokenCost(lostGo), 1.5);
  const r = { id: "r", flow: "f", status: "completed", steps: [mixed, s({ supply: "own" })] } as unknown as RunRecord;
  assert.equal(runMeter(r).tokenCostUsd, 2);
});

test("the marker is a word, not a secret, and only names a known provider", () => {
  assert.equal(supplyProviderOfToken(supplyToken("gemini")), "gemini");
  assert.equal(supplyProviderOfToken("foldrun-supply:nope"), null);
  assert.equal(supplyProviderOfToken("sk-ant-x"), null);
  // The subscription's marker: Claude's alone, and told apart from the API key's.
  assert.equal(supplyProviderOfToken(supplyToken("anthropic", "login")), "anthropic");
  assert.equal(supplyViaOfToken(supplyToken("anthropic", "login")), "login");
  assert.equal(supplyViaOfToken(supplyToken("anthropic")), null);
  assert.equal(supplyProviderOfToken("foldrun-supply:openai+login"), null);
  assert.equal(supplyViaOfToken("foldrun-supply:openai+login"), null);
});

test("outside a step (a judge, a grader, a draft): the same rung, through a host lease, or refused", async () => {
  const { accountModelEnv, withModelEnv, ModelKeyError } = await import("../src/model-env.ts");
  await withAccount({ supply: { kind: "refused", reason: "not available to this account" } }, async () => {
    assert.throws(() => accountModelEnv("acme", "desk", () => ({})), (e: unknown) => e instanceof ModelKeyError && e.status === 403);
  });
  await withAccount({ supply: { kind: "foldrun", provider: "anthropic", tiers: {} }, lease: false }, async () => {
    const m = accountModelEnv("acme", "desk", () => ({ ANTHROPIC_API_KEY: "sk-operator" }));
    assert.equal(m.supply, "foldrun");
    assert.ok(!JSON.stringify(m.env).includes("sk-operator"), "never the operator's key");
    await assert.rejects(withModelEnv(m, async () => "x", { kind: "grade", name: "g" }), (e: unknown) => e instanceof ModelKeyError && e.status === 503);
  });
  const leases: { runId: string; job?: unknown; grant: EgressGrant }[] = [];
  await withAccount({ supply: { kind: "foldrun", provider: "anthropic", tiers: {} } }, async () => {
    const prev = platform.egress;
    // A fake proxy: what reaches it is what the platform's would see.
    const got: { url: string; key: string | undefined }[] = [];
    const http = await import("node:http");
    const proxy = http.createServer((req, res) => {
      got.push({ url: req.url ?? "", key: req.headers["x-api-key"] as string | undefined });
      req.resume();
      req.on("end", () => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ id: "m", type: "message", content: [], usage: { input_tokens: 1, output_tokens: 1 } }));
      });
    });
    await new Promise<void>((r) => proxy.listen(0, "127.0.0.1", () => r()));
    const port = (proxy.address() as { port: number }).port;
    registerPlatform({
      egress: {
        lease: async (a) => {
          leases.push(a as (typeof leases)[number]);
          return { url: `http://127.0.0.1:${port}/e/tok`, commit: async () => {}, drainLog: async () => [], release: async () => {} } as unknown as EgressLease;
        },
      },
    });
    try {
      const m = accountModelEnv("acme", "desk", () => ({}));
      const seen = await withModelEnv(
        m,
        async (env) => {
          const r = await fetch(`${env.ANTHROPIC_BASE_URL}/v1/messages`, { method: "POST", headers: { "content-type": "application/json", "x-api-key": env.ANTHROPIC_API_KEY ?? "" }, body: "{}" });
          await r.text();
          return env.ANTHROPIC_BASE_URL ?? "";
        },
        { kind: "grade", name: "quality" },
      );
      assert.match(seen, /^http:\/\/127\.0\.0\.1:\d+/, "the SDK talks to loopback; the translator sends through the lease");
      assert.equal(got.length, 1, "the call went through the proxy (Codex review: the passthrough had ignored it)");
      assert.equal(got[0].url, "/e/tok/https://models.foldrun.internal/v1/messages");
      assert.equal(got[0].key, "${FOLDRUN_MODEL_KEY}", "a placeholder, filled by the proxy");
      assert.equal(leases[0].runId, "grade:quality");
      assert.deepEqual(leases[0].job, { kind: "grade", name: "quality" });
      assert.deepEqual(leases[0].grant.secrets.FOLDRUN_MODEL_KEY.supply, { provider: "anthropic" });
      assert.equal(leases[0].grant.enforce, true, "the lease reaches its model and nothing else through the forward door");
    } finally {
      registerPlatform({ egress: prev });
      proxy.close();
    }
  });
});

test("each provider is sent only what its API documents: Kimi's schema, DeepSeek without context editing", async () => {
  const { SUPPLY_PROVIDERS, shapeRequest } = await import("../src/model-supply.ts");
  // What the agent runtime sends, captured from the SDK on 3 Nov 2026.
  const sdk = () => ({
    model: "m", max_tokens: 32000, stream: true, system: [{ type: "text", text: "s" }], messages: [{ role: "user", content: "hi" }],
    tools: [{ name: "Read", input_schema: { type: "object" } }], metadata: { user_id: "u" },
    thinking: { type: "adaptive", display: "updates" }, output_config: { effort: "medium" }, context_management: { edits: [] },
  });
  const kimi = sdk();
  assert.equal(shapeRequest(SUPPLY_PROVIDERS.moonshot, kimi), true);
  assert.deepEqual(Object.keys(kimi).sort(), ["max_tokens", "messages", "metadata", "model", "output_config", "stream", "system", "tools"]);
  assert.deepEqual(kimi.output_config, { effort: "high" }, "medium is not a Kimi word");
  for (const [w, to] of [["low", "low"], ["xhigh", "high"], ["max", "max"]]) {
    const b = { ...sdk(), output_config: { effort: w } };
    shapeRequest(SUPPLY_PROVIDERS.moonshot, b);
    assert.equal(b.output_config.effort, to, w);
  }
  const ds = sdk();
  assert.equal(shapeRequest(SUPPLY_PROVIDERS.deepseek, ds), true);
  assert.ok(!("context_management" in ds));
  assert.deepEqual(ds.thinking, { type: "adaptive" });
  assert.deepEqual(ds.output_config, { effort: "medium" }, "DeepSeek spells every level");
  const claude = sdk();
  assert.equal(shapeRequest(SUPPLY_PROVIDERS.anthropic, claude), false, "Anthropic gets the request as written");
});

test("DeepSeek and Kimi: the SDK's mid-conversation system message joins the user turn; the deferred-tool placeholder is dropped (e2e, 3 Nov 2026)", async () => {
  const { SUPPLY_PROVIDERS, shapeRequest } = await import("../src/model-supply.ts");
  for (const p of [SUPPLY_PROVIDERS.deepseek, SUPPLY_PROVIDERS.moonshot]) {
    const body: Record<string, unknown> = {
      model: "m",
      messages: [
        { role: "user", content: "hi" },
        { role: "system", content: [{ type: "text", text: "# Environment\ncwd /work" }] },
        { role: "assistant", content: [{ type: "text", text: "ok" }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: "x" }] },
        { role: "system", content: [] },
      ],
      tools: [{ name: "Read", input_schema: { type: "object" } }, { name: "DeferredToolPlaceholder", defer_loading: true, input_schema: { type: "object" } }],
    };
    assert.equal(shapeRequest(p, body), true);
    assert.deepEqual(body.messages, [
      { role: "user", content: [{ type: "text", text: "hi" }, { type: "text", text: "# Environment\ncwd /work" }] },
      { role: "assistant", content: [{ type: "text", text: "ok" }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: "x" }] },
    ], `${p.name}: no system role left, words kept, an empty one gone`);
    assert.deepEqual((body.tools as { name: string }[]).map((t) => t.name), ["Read"]);
  }
});

test("a refusal from foldrun's models is never retried as a busy provider (e2e, 3 Nov 2026)", async () => {
  const { isTransientOverload } = await import("../src/runner.ts");
  assert.equal(isTransientOverload("429 egress: the daily limit on foldrun's models is reached ($0.04 of $0.00 today, UTC)"), false);
  assert.equal(isTransientOverload("503 egress: foldrun's models: gemini is not available on this platform right now"), false);
  assert.equal(isTransientOverload("429 Too Many Requests: overloaded"), true, "a provider's own overload still is");
});

test("max_output_tokens: the runtime is told its limit — the agent's, a step's, never above the price list's ceiling (3 Nov 2026)", async () => {
  const anthropic = (): SupplyAnswer => ({ kind: "foldrun", provider: "anthropic", tiers: { default: "claude-sonnet-5-5" }, ceilings: { "claude-sonnet-5-5": 32000 } });
  const out = (c: Captured) => (c.calls[0].env as Record<string, string>).CLAUDE_CODE_MAX_OUTPUT_TOKENS;
  // Unset: the ceiling, so the runtime never asks for more than may be sent.
  await withAccount({ supply: anthropic() }, async (c) => {
    const done = await run();
    assert.equal(done.status, "completed", events(done.steps[0]));
    assert.equal(out(c), "32000");
  });
  // The agent's own, under the ceiling.
  await withAccount({ supply: anthropic(), agentProvider: "max_output_tokens: 16000\n" }, async (c) => {
    await run();
    assert.equal(out(c), "16000");
  });
  // Above it: the ceiling, said on the step.
  await withAccount({ supply: anthropic(), agentProvider: "max_output_tokens: 64000\n" }, async (c) => {
    const done = await run();
    assert.equal(out(c), "32000");
    assert.match(events(done.steps[0]), /max_output_tokens: 64000 runs as 32000 — the price list's ceiling/);
  });
  // A step's own wins over the agent's.
  await withAccount({ supply: anthropic(), agentProvider: "max_output_tokens: 16000\n" }, async (c) => {
    const r = startFlowRun("acme", "desk", [{ ...step, maxOutputTokens: 8000 }], "f");
    await waitForRun("acme", "desk", r.id, 20_000);
    assert.equal(out(c), "8000");
  });
});

test("Claude Code's attribution line is switched off on foldrun's door, whatever the provider: the door sends what the provider takes (3 Nov 2026; one door, 23 Nov)", async () => {
  const attr = (c: Captured) => (c.calls[0].env as Record<string, string>).CLAUDE_CODE_ATTRIBUTION_HEADER;
  await withAccount({ supply: { kind: "foldrun", provider: "deepseek", tiers: { default: "deepseek-v4-pro" } } }, async (c) => {
    const done = await run();
    assert.equal(done.status, "completed", events(done.steps[0]));
    assert.equal(attr(c), "0");
  });
  await withAccount({ supply: { kind: "foldrun", provider: "anthropic", tiers: {} } }, async (c) => {
    await run();
    assert.equal(attr(c), "0");
  });
});

test("a flow's max_output_tokens is snapshotted on the run and reaches its steps (3 Nov 2026)", async () => {
  const supply: SupplyAnswer = { kind: "foldrun", provider: "anthropic", tiers: { default: "claude-sonnet-5-5" }, ceilings: { "claude-sonnet-5-5": 32000 } };
  await withAccount({ supply }, async (c) => {
    const flows = path.join(process.env.FOLDRUN_DATA!, "acme/workspaces/desk/flows");
    fs.mkdirSync(flows, { recursive: true });
    fs.writeFileSync(path.join(flows, "f.md"), "---\ntrigger: manual\nmax_output_tokens: 12000\n---\n1. [[worker]] — work\n");
    const r = startFlowRun("acme", "desk", [step], "f");
    const done = (await waitForRun("acme", "desk", r.id, 20_000)).run!;
    assert.equal(done.steps[0].flowMaxOutputTokens, 12000);
    assert.equal(done.steps[0].maxOutputTokens, 12000);
    assert.equal((c.calls[0].env as Record<string, string>).CLAUDE_CODE_MAX_OUTPUT_TOKENS, "12000");
  });
});

test("a nested flow's max_output_tokens holds for its own steps; a step's own still wins (Codex review)", async () => {
  const { loadFlow } = await import("../src/runner.ts");
  await withAccount({ supply: { kind: "none" } }, async () => {
    const flows = path.join(process.env.FOLDRUN_DATA!, "acme/workspaces/desk/flows");
    fs.mkdirSync(flows, { recursive: true });
    fs.writeFileSync(path.join(flows, "child.md"), "---\ntrigger: manual\nmax_output_tokens: 4000\n---\n1. [[worker]] — a\n2. [[worker]] — b\n   max_output_tokens: 2000\n");
    fs.writeFileSync(path.join(flows, "parent.md"), "---\ntrigger: manual\n---\n1. [[worker]] — first\n2. [[flow:child]]\n");
    const f = loadFlow("acme", "desk", "parent")!;
    assert.deepEqual(f.steps.map((s) => s.maxOutputTokens), [undefined, 4000, 2000]);
  });
});

test("Z.ai, Qwen, MiniMax and MiMo are sent only what each documents (10 Nov 2026)", async () => {
  const { SUPPLY_PROVIDERS, SUPPLY_TITLES, shapeRequest, supplyProviderBlock, effortRunsAs } = await import("../src/model-supply.ts");
  const sdk = () => ({
    model: "m", max_tokens: 32000, stream: true, system: [{ type: "text", text: "s" }],
    messages: [{ role: "user", content: "hi" }, { role: "system", content: [{ type: "text", text: "# Environment" }] }],
    tools: [{ name: "Read", input_schema: { type: "object" } }, { name: "DeferredToolPlaceholder", defer_loading: true, input_schema: { type: "object" } }],
    metadata: { user_id: "u" }, service_tier: "priority",
    thinking: { type: "adaptive", display: "updates" }, output_config: { effort: "medium" }, context_management: { edits: [] },
  });
  for (const name of ["zai", "qwen", "minimax", "mimo"] as const) {
    const p = SUPPLY_PROVIDERS[name];
    const b: Record<string, unknown> = sdk();
    assert.equal(shapeRequest(p, b), true, name);
    assert.ok(!("context_management" in b), `${name}: no context editing`);
    assert.ok(!("service_tier" in b), `${name}: no tier that bills more (MiniMax's priority is 1.5x)`);
    assert.deepEqual((b.tools as { name: string }[]).map((t) => t.name), ["Read"], `${name}: the deferred-tool placeholder is dropped`);
    assert.ok(SUPPLY_TITLES[name]);
    // The step's provider block points at foldrun's door, in Anthropic's
    // format, the tier a door name the door routes to this provider.
    const block = supplyProviderBlock(name, { default: "x" }, undefined, true);
    assert.equal(new URL(String(block.base_url)).host, "models.foldrun.internal", name);
    assert.equal(block.format, "anthropic");
    assert.deepEqual(block.models, { default: `${name}/x` });
  }
  const z: Record<string, unknown> = sdk();
  shapeRequest(SUPPLY_PROVIDERS.zai, z);
  assert.deepEqual(z.thinking, { type: "enabled" }, "Z.ai documents enabled | disabled");
  assert.equal((z.messages as unknown[]).length, 1, "the mid-conversation system message joins the user turn");
  const q: Record<string, unknown> = sdk();
  shapeRequest(SUPPLY_PROVIDERS.qwen, q);
  assert.deepEqual(q.thinking, { type: "enabled" });
  assert.equal((q.messages as unknown[]).length, 1, "Qwen takes user and assistant roles only");
  const mm: Record<string, unknown> = { ...sdk(), thinking: { type: "enabled", budget_tokens: 4000 } };
  shapeRequest(SUPPLY_PROVIDERS.minimax, mm);
  assert.deepEqual(mm.thinking, { type: "adaptive" }, "MiniMax documents disabled | adaptive, no budget");
  assert.deepEqual(mm.output_config, { effort: "medium" }, "MiniMax spells every level");
  const mi: Record<string, unknown> = sdk();
  shapeRequest(SUPPLY_PROVIDERS.mimo, mi);
  assert.deepEqual(Object.keys(mi).sort(), ["max_tokens", "messages", "model", "stream", "system", "thinking", "tools"], "MiMo's schema alone");
  assert.deepEqual(mi.thinking, { type: "enabled" });
  assert.equal((mi.messages as unknown[]).length, 2, "MiMo takes a system role in messages");
  assert.equal(effortRunsAs("minimax", "MiniMax-M3", "xhigh"), "xhigh");
  assert.equal(effortRunsAs("qwen", "qwen3.8-max", "high"), "xhigh", "Qwen 3.8: high and max run as xhigh");
  assert.equal(effortRunsAs("qwen", "qwen3.8-flash", "max"), "xhigh");
  assert.equal(effortRunsAs("qwen", "qwen3.8-max", "medium"), "medium");
  assert.equal(effortRunsAs("qwen", "qwen3.7-plus", "high"), "high", "its other models: as written");
});

// ---------------------------------------------- own keys off (models.byok, 22 Nov 2026)

test("own keys off: an agent that names its own provider: is refused before a sandbox — nothing runs on an endpoint the platform does not meter", async () => {
  await withAccount(
    { supply: { kind: "foldrun", provider: "anthropic", tiers: {} }, ownKeys: false, agentProvider: "provider:\n  name: anthropic\n  token: ${MINE}\n" },
    async (c) => {
      setSecret("acme", "MINE", "sk-ant-api03-written-in-the-block-22222");
      const done = await run();
      assert.equal(done.status, "failed");
      assert.equal(c.calls.length, 0, "no sandbox");
      assert.match(events(done.steps[0]), /cannot name its own model endpoint .*provider:/);
      assert.doesNotMatch(events(done.steps[0]), /switch this account back to its own key/, "no way back offered where there is none");
    },
  );
});

test("own keys off: a stored key of the account's is never read — the step runs on foldrun's models", async () => {
  await withAccount({ supply: { kind: "foldrun", provider: "anthropic", tiers: {} }, ownKeys: false }, async (c) => {
    setSecret("acme", ACCOUNT_MODEL_SECRETS.key, "sk-ant-api03-the-customers-own-key-111111");
    const done = await run();
    assert.equal(done.status, "completed", events(done.steps[0]));
    assert.equal(done.steps[0].supply, "foldrun");
    assert.ok(!JSON.stringify(c.calls[0]).includes("the-customers-own-key"));
  });
});

test("own keys off and no foldrun's models for this account: the stored key is still not used — the step fails, never on it", async () => {
  await withAccount({ supply: { kind: "none" }, ownKeys: false }, async (c) => {
    setSecret("acme", ACCOUNT_MODEL_SECRETS.provider, "anthropic");
    setSecret("acme", ACCOUNT_MODEL_SECRETS.key, "sk-ant-api03-the-customers-own-key-111111");
    const done = await run();
    assert.equal(done.status, "failed", events(done.steps[0]));
    assert.ok(!JSON.stringify(c.calls).includes("the-customers-own-key"), "the stored key reached nothing");
  });
});

test("own keys on (the hook says yes, or no platform at all): a written provider: and a stored key work as before", async () => {
  await withAccount({ supply: { kind: "none" }, ownKeys: true }, async (c) => {
    setSecret("acme", ACCOUNT_MODEL_SECRETS.provider, "anthropic");
    setSecret("acme", ACCOUNT_MODEL_SECRETS.key, "sk-ant-api03-the-customers-own-key-111111");
    const done = await run();
    assert.equal(done.status, "completed", events(done.steps[0]));
    assert.equal(done.steps[0].supply, "own");
  });
});

test("own keys off, outside a step (a judge, a grader): a written provider: is refused and the stored key is never read", async () => {
  const { accountModelEnv, ModelKeyError } = await import("../src/model-env.ts");
  await withAccount({ supply: { kind: "none" }, ownKeys: false }, async () => {
    fs.writeFileSync(path.join(process.env.FOLDRUN_DATA!, "acme/workspaces/desk/AGENTS.md"), "---\nname: desk\nprovider:\n  name: anthropic\n  token: ${MINE}\n---\n");
    assert.throws(() => accountModelEnv("acme", "desk", () => ({})), (e: unknown) => e instanceof ModelKeyError && e.status === 403 && /cannot name its own model endpoint/.test(e.message));
    fs.writeFileSync(path.join(process.env.FOLDRUN_DATA!, "acme/workspaces/desk/AGENTS.md"), "---\nname: desk\n---\n");
    setSecret("acme", ACCOUNT_MODEL_SECRETS.provider, "anthropic");
    setSecret("acme", ACCOUNT_MODEL_SECRETS.key, "sk-ant-api03-the-customers-own-key-111111");
    // No foldrun's models and not the operator's account: refused, never on the stored key.
    assert.throws(() => accountModelEnv("acme", "desk", () => ({})), (e: unknown) => e instanceof ModelKeyError);
  });
});

const sentModel = (c: Captured) => (c.calls[0] as unknown as { input: { model: string } }).input.model;

test("a model named outright runs on its own provider of foldrun's models (23 Nov 2026, /model): the grant and the id follow it", async () => {
  const asked: unknown[] = [];
  await withAccount(
    {
      supply: { kind: "foldrun", provider: "anthropic", tiers: {}, via: "login" },
      agentModel: "deepseek/deepseek-chat",
      asked,
      supplyFor: (w) => (w.provider === "deepseek" ? { kind: "foldrun", provider: "deepseek", tiers: { default: "deepseek-chat" } } : { kind: "refused", reason: "no" }),
    },
    async (c) => {
      const done = await run();
      assert.equal(done.status, "completed", events(done.steps[0]));
      assert.deepEqual(asked, [{ provider: "deepseek", model: "deepseek-chat" }]);
      assert.equal(done.steps[0].supplyProvider, "deepseek");
      assert.equal(sentModel(c), "deepseek/deepseek-chat", "the door's name: the door routes it to DeepSeek");
      assert.deepEqual(c.grants[0].secrets.FOLDRUN_MODEL_KEY.supply, { provider: "deepseek" }, "DeepSeek's key, not the Claude login");
    },
  );
});

test("a bare name with another provider's prefix routes too; a tier word and a bare Claude id stay on the account's provider", async () => {
  for (const [model, provider, sent] of [["gpt-5", "openai", "openai/gpt-5"], ["default", "anthropic", "sonnet"], ["claude-opus-5-5", "anthropic", "claude-opus-5-5"], ["anthropic/claude-opus-5-5", "anthropic", "claude-opus-5-5"]] as const) {
    const asked: unknown[] = [];
    await withAccount(
      { supply: { kind: "foldrun", provider: "anthropic", tiers: {} }, agentModel: model, asked, supplyFor: (w) => ({ kind: "foldrun", provider: w.provider as "openai", tiers: {} }) },
      async (c) => {
        const done = await run();
        assert.equal(done.status, "completed", `${model}: ${events(done.steps[0])}`);
        assert.equal(done.steps[0].supplyProvider, provider, model);
        assert.equal(sentModel(c), sent, model);
        assert.equal(asked.length, model.includes("/") || provider !== "anthropic" ? 1 : 0, `${model}: the platform is asked for a model named outright (its ceiling), never for a tier word or a bare Claude id`);
      },
    );
  }
});

test("a named provider that cannot be had now fails the step with why — never quietly on the account's own provider", async () => {
  await withAccount(
    { supply: { kind: "foldrun", provider: "anthropic", tiers: {} }, agentModel: "kimi/kimi-k2", supplyFor: () => ({ kind: "refused", reason: "moonshot is not available on this platform right now" }) },
    async (c) => {
      const done = await run();
      assert.equal(done.status, "failed");
      assert.equal(c.calls.length, 0, "no sandbox");
      assert.match(events(done.steps[0]), /moonshot is not available/);
    },
  );
});

test("an account on its own key: a provider/model is sent as written, the platform never asked", async () => {
  const asked: unknown[] = [];
  await withAccount(
    { supply: { kind: "foldrun", provider: "anthropic", tiers: {} }, agentModel: "deepseek/deepseek-chat", asked, agentProvider: "provider:\n  name: anthropic\n  token: ${MINE}\n" },
    async (c) => {
      setSecret("acme", "MINE", "sk-ant-api03-written-in-the-block-22222");
      const done = await run();
      assert.equal(done.status, "completed", events(done.steps[0]));
      assert.equal(asked.length, 0);
      assert.equal(sentModel(c), "deepseek/deepseek-chat");
    },
  );
});

test("the account's own provider refused now: a step naming another, available one still runs on it", async () => {
  await withAccount(
    { supply: { kind: "refused", reason: "openai is not available on this platform right now" }, agentModel: "deepseek/deepseek-chat", supplyFor: () => ({ kind: "foldrun", provider: "deepseek", tiers: {} }) },
    async (c) => {
      const done = await run();
      assert.equal(done.status, "completed", events(done.steps[0]));
      assert.equal(sentModel(c), "deepseek/deepseek-chat");
    },
  );
});

test("a judge pinned to another provider's id grades with the switched step's own model, said so; one on the same provider gets its door name", async () => {
  for (const [judge, want] of [["claude-opus-5-5", "deepseek/deepseek-chat"], ["deepseek/deepseek-reasoner", "deepseek/deepseek-reasoner"]] as const) {
    await withAccount(
      { supply: { kind: "foldrun", provider: "anthropic", tiers: {} }, agentModel: "deepseek/deepseek-chat", wsFront: `judge:\n  model: ${judge}\n`, supplyFor: () => ({ kind: "foldrun", provider: "deepseek", tiers: {} }) },
      async (c) => {
        const done = await run();
        assert.equal(done.status, "completed", events(done.steps[0]));
        assert.equal((c.calls[0] as unknown as { input: { judgeModel?: string } }).input.judgeModel, want, judge);
        if (judge === "claude-opus-5-5") assert.match(events(done.steps[0]), /judge: claude-opus-5-5 is not on DeepSeek, .* the step's model \(deepseek-chat\)/);
      },
    );
  }
});

test("one door (23 Nov 2026): a step on the operator's own credential sends its calls to foldrun's door with the operator's marker — the credential never in the lease or the pod — and the door is its one meter: its own tokens are not billed again", async () => {
  await withAccount({ supply: { kind: "none" } }, async (c) => {
    registerPlatform({ platformKeyAllowed: () => true, operatorDoor: () => true });
    try {
      const done = await run();
      assert.equal(done.status, "completed", events(done.steps[0]));
      assert.equal(done.steps[0].supply, "operator");
      assert.equal(done.steps[0].meteredAtDoor, true);
      assert.equal(billedTokenCost({ ...done.steps[0], costUsd: 1 }), 0, "the door billed each call");
      const env = c.calls[0].env as Record<string, string>;
      assert.match(env.ANTHROPIC_BASE_URL, /\/e\/tok\/https:\/\/models\.foldrun\.internal$/);
      assert.equal(env.ANTHROPIC_API_KEY, "${FOLDRUN_MODEL_KEY}");
      assert.ok(!JSON.stringify(c.calls[0]).includes("sk-ant-api03-the-operators-own-key"), "the operator's key is not in the pod");
      assert.deepEqual(c.grants[0].secrets.FOLDRUN_MODEL_KEY, { value: "", hosts: ["models.foldrun.internal"], supply: { provider: "anthropic", via: "operator", metered: true } }, "nor in the lease");
    } finally {
      registerPlatform({ platformKeyAllowed: () => false, operatorDoor: undefined });
    }
  });
  // Without the platform's word: the credential in the lease, to Anthropic, as before.
  await withAccount({ supply: { kind: "none" } }, async (c) => {
    registerPlatform({ platformKeyAllowed: () => true });
    try {
      const done = await run();
      assert.deepEqual(c.grants[0].secrets.FOLDRUN_MODEL_KEY.hosts, ["api.anthropic.com"]);
      assert.equal(done.steps[0].meteredAtDoor, undefined);
      assert.ok(billedTokenCost({ ...done.steps[0], costUsd: 1 }) > 0, "billed from the step's tokens, as before");
    } finally {
      registerPlatform({ platformKeyAllowed: () => false });
    }
  });
});

test("the operator's marker: Claude's alone, and read back as such", () => {
  assert.equal(supplyToken("anthropic", "operator"), "foldrun-supply:anthropic+operator");
  assert.equal(supplyProviderOfToken("foldrun-supply:anthropic+operator"), "anthropic");
  assert.equal(supplyViaOfToken("foldrun-supply:anthropic+operator"), "operator");
  assert.equal(supplyProviderOfToken("foldrun-supply:deepseek+operator"), null);
});

test("a platform whose proxy does not know the door: the provider's own endpoint, format and ids, as before", async () => {
  await withAccount({ supply: { kind: "foldrun", provider: "deepseek", tiers: { default: "deepseek-v4" } }, noDoor: true }, async (c) => {
    const done = await run();
    assert.equal(done.status, "completed", events(done.steps[0]));
    const env = c.calls[0].env as Record<string, string>;
    assert.match(env.ANTHROPIC_BASE_URL, /\/e\/tok\/https:\/\/api\.deepseek\.com/);
    assert.equal(env.ANTHROPIC_DEFAULT_SONNET_MODEL, "deepseek-v4");
  });
});

test("a provider: block or stored key carrying one of foldrun's markers is refused, before a sandbox: only the platform grants those", async () => {
  await withAccount({ supply: { kind: "none" }, ownKeys: true, agentProvider: "provider:\n  name: anthropic\n  token: foldrun-supply:anthropic+operator\n" }, async (c) => {
    const done = await run();
    assert.equal(done.status, "failed");
    assert.equal(c.calls.length, 0);
    assert.match(events(done.steps[0]), /may not carry a foldrun-supply: token/);
  });
});

test("a step metered at the door bills none of its tokens, attempt by attempt", () => {
  assert.equal(billedTokenCost({ supply: "operator", meteredAtDoor: true, costUsd: 2 }), 0);
  assert.equal(billedTokenCost({ supply: "operator", costUsd: 2, tries: [{ n: 1, supply: "operator", meteredAtDoor: true, costUsd: 1 }, { n: 2, supply: "operator", costUsd: 1 }] as never }), 1);
});

test("one door: a host job on the operator's credential goes through foldrun's door on a job lease, never with the key from the host", async () => {
  const { accountModelEnv } = await import("../src/model-env.ts");
  registerPlatform({ platformKeyAllowed: () => true, operatorDoor: () => true, ownModelKeys: () => false, modelSupply: () => ({ kind: "none" }) });
  try {
    const m = accountModelEnv("acme", "desk", () => ({ ANTHROPIC_API_KEY: "sk-operator-host" }));
    assert.equal(m.supply, "foldrun", "through a lease (withSupply)");
    assert.equal(m.env.ANTHROPIC_BASE_URL, "https://models.foldrun.internal");
    assert.equal(m.env.ANTHROPIC_API_KEY, "foldrun-supply:anthropic+operator+metered");
    assert.ok(!JSON.stringify(m.env).includes("sk-operator-host"));
  } finally {
    registerPlatform({ platformKeyAllowed: () => false, operatorDoor: undefined, ownModelKeys: undefined, modelSupply: undefined });
  }
});

test("the metered operator marker: read as the operator's, metered; the plain one is not", () => {
  assert.equal(supplyProviderOfToken("foldrun-supply:anthropic+operator+metered"), "anthropic");
  assert.equal(supplyViaOfToken("foldrun-supply:anthropic+operator+metered"), "operator");
  assert.equal(supplyProviderOfToken("foldrun-supply:deepseek+operator+metered"), null);
  assert.equal(supplyProviderOfToken("foldrun-supply:anthropic+metered"), null);
});

// ------------------------------------------------------------ tools: [debate, review] (FOL-418)

const SECOND = "tools: [read, debate, review]\nsecond_model: openai/gpt-x\n";

test("tools: [debate, review] in a cloud step (FOL-444): the lease is granted the second door for those tools and that model only", async () => {
  await withAccount({ supply: { kind: "foldrun", provider: "anthropic", tiers: {} }, agentProvider: SECOND }, async (c) => {
    const done = await run();
    assert.equal(done.status, "completed", events(done.steps[0]));
    assert.deepEqual(c.leases[0]!.secondModel, { tools: ["debate", "review"], model: "openai/gpt-x", firstProvider: "anthropic", maxUsd: null, uses: {} });
    assert.doesNotMatch(events(done.steps[0]), /FOL-444|not offered/);
  });
  // Plan mode is read-only: no lease, no server, for tools it cannot call.
  await withAccount({ supply: { kind: "foldrun", provider: "anthropic", tiers: {} }, agentProvider: "tools: [read, review]\nsecond_model: openai/gpt-x\npermissionMode: plan\n" }, async (c) => {
    await run();
    assert.equal(c.leases[0]!.secondModel, undefined);
  });
  // The step's own provider, for the model actually sent: the account's supply here, so anthropic/ is the same one.
  await withAccount({ supply: { kind: "foldrun", provider: "anthropic", tiers: {} }, agentProvider: "tools: [read, review]\nsecond_model: anthropic/claude-y\n" }, async (c) => {
    const done = await run();
    assert.equal(c.leases[0]!.secondModel, undefined);
    assert.match(events(done.steps[0]), /second_model: anthropic\/claude-y is the provider this step's model .* is on — tools: \[review\] not offered/);
  });
  await withAccount({ supply: { kind: "foldrun", provider: "anthropic", tiers: {} }, agentProvider: `${SECOND}disallowedTools: [review]\n` }, async (c) => {
    await run();
    assert.deepEqual(c.leases[0]!.secondModel?.tools, ["debate"]);
  });
  await withAccount({ supply: { kind: "foldrun", provider: "anthropic", tiers: {} }, agentProvider: "tools: [read, debate]\n" }, async (c) => {
    const done = await run();
    assert.match(events(done.steps[0]), /needs second_model:/);
    assert.equal(c.leases[0]!.secondModel, undefined, "no grant without second_model:");
  });
});
