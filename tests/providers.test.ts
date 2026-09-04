// Providers by name: a `name:` resolves to a wire format, an address and a
// header shape; anything spelled out beside it wins; an unknown name is a
// warning, never a guess.
//
//   node --test tests/providers.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { PROVIDERS, providerPreset, looksOpenAiShaped, PROTECTED_PARAMS } from "../packages/core/src/providers.ts";
import { parseProvider, providerEnvFor } from "../packages/core/src/store.ts";
import { translatorSpecFor } from "../packages/core/src/translator.ts";

test("every preset has a format, an auth shape, and either an address or a note saying why not", () => {
  const names = new Set<string>();
  for (const p of PROVIDERS) {
    assert.ok(!names.has(p.name), `duplicate preset ${p.name}`);
    names.add(p.name);
    assert.ok(["anthropic", "openai"].includes(p.format), p.name);
    assert.ok(["bearer", "x-api-key"].includes(p.auth), p.name);
    assert.ok(p.baseUrl || p.note, `${p.name}: no base URL and no note explaining where it lives`);
    if (p.baseUrl) assert.match(p.baseUrl, /^https?:\/\//, p.name);
  }
});

test("a name resolves loosely — case, dots and dashes do not matter", () => {
  assert.equal(providerPreset("OpenRouter")?.name, "openrouter");
  assert.equal(providerPreset("z.ai")?.name, "zai");
  assert.equal(providerPreset("hugging-face")?.name, "huggingface");
  assert.equal(providerPreset("nope"), null);
  assert.equal(providerPreset(42), null);
});

test("name: fills in the address, format and auth; explicit keys win", () => {
  const groq = parseProvider({ name: "groq", token: "${GROQ_API_KEY}" })!;
  assert.equal(groq.name, "groq");
  assert.equal(groq.format, "openai");
  assert.equal(groq.baseUrl, "https://api.groq.com/openai/v1");
  assert.equal(groq.auth, "bearer");
  assert.deepEqual(groq.warnings, []);

  const deepseek = parseProvider({ name: "deepseek", token: "x" })!;
  assert.equal(deepseek.format, "anthropic");
  assert.equal(deepseek.auth, "x-api-key");

  const custom = parseProvider({ name: "openai", base_url: "https://proxy.example/v1", token: "x", auth: "x-api-key" })!;
  assert.equal(custom.baseUrl, "https://proxy.example/v1");
  assert.equal(custom.auth, "x-api-key");
  assert.equal(custom.format, "openai");
});

test("an unknown name warns and the block reads as spelled out", () => {
  const p = parseProvider({ name: "acme-llm", base_url: "https://llm.acme.test", token: "x" })!;
  assert.equal(p.name, null);
  assert.equal(p.baseUrl, "https://llm.acme.test");
  assert.ok(p.warnings.some((w) => /acme-llm/.test(w)));
});

test("a preset whose address is per account needs base_url, and says so", () => {
  const p = parseProvider({ name: "cloudflare", token: "x" })!;
  assert.ok(p.warnings.some((w) => /needs a base_url/.test(w)));
});

test("format: and auth: accept their words and reject the rest with a warning", () => {
  assert.equal(parseProvider({ base_url: "https://x.test", token: "t", format: "OpenAI" })!.format, "openai");
  assert.equal(parseProvider({ base_url: "https://x.test", token: "t", auth: "api-key" })!.auth, "x-api-key");
  const bad = parseProvider({ base_url: "https://x.test", token: "t", format: "grpc", auth: "magic" })!;
  assert.equal(bad.format, "anthropic");
  assert.equal(bad.auth, "bearer");
  assert.equal(bad.warnings.filter((w) => /format:|auth:/.test(w)).length, 2);
});

test("a pasted Chat-Completions URL without format: is warned about", () => {
  assert.ok(looksOpenAiShaped("https://api.groq.com/openai/v1"));
  assert.ok(looksOpenAiShaped("https://api.openai.com/v1"));
  assert.ok(!looksOpenAiShaped("https://api.deepseek.com/anthropic"));
  assert.ok(!looksOpenAiShaped("https://openrouter.ai/api"));
  const p = parseProvider({ base_url: "https://api.mistral.ai/v1", token: "t" })!;
  assert.ok(p.warnings.some((w) => /format: openai/.test(w)));
});

test("providerEnvFor puts the key in the header the endpoint wants, and blanks the other", () => {
  const bearer = providerEnvFor({ baseUrl: "https://x.test", token: "tok", auth: "bearer", models: {}, headers: {} });
  assert.equal(bearer.ANTHROPIC_AUTH_TOKEN, "tok");
  assert.equal(bearer.ANTHROPIC_API_KEY, "");
  const key = providerEnvFor({ baseUrl: "https://x.test", token: "tok", auth: "x-api-key", models: {}, headers: {} });
  assert.equal(key.ANTHROPIC_API_KEY, "tok");
  assert.equal(key.ANTHROPIC_AUTH_TOKEN, "");
  const legacy = providerEnvFor({ baseUrl: "https://x.test", token: "tok", models: {}, headers: {} });
  assert.equal(legacy.ANTHROPIC_AUTH_TOKEN, "tok", "no auth given: bearer, as before");
});

test("only an openai-format block gets a translator", () => {
  assert.equal(translatorSpecFor({ format: "anthropic", baseUrl: "https://a.test", token: "t", headers: {} }), null);
  const t = translatorSpecFor({ format: "openai", baseUrl: "https://api.openai.com/v1", token: "t", headers: { "X-Title": "foldrun" }, name: "openai", maxTokensParam: "max_completion_tokens", reasoningEffort: true })!;
  assert.equal(t.upstreamBase, "https://api.openai.com/v1");
  assert.equal(t.upstreamKey, "t");
  assert.equal(t.maxTokensParam, "max_completion_tokens");
  assert.equal(t.reasoningEffort, true);
  assert.match(t.label!, /^openai/);
});

test("fallback: carries its own name, format and auth", () => {
  const p = parseProvider({ name: "openrouter", token: "a", fallback: { name: "groq", token: "b" } })!;
  assert.equal(p.fallback?.name, "groq");
  assert.equal(p.fallback?.format, "openai");
});

// ------------------------------------------------------------------ docs

test("every preset is in docs/providers.md and the spec names the three keys", async () => {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const root = path.join(import.meta.dirname, "..");
  const doc = fs.readFileSync(path.join(root, "docs/providers.md"), "utf8");
  for (const p of PROVIDERS) {
    assert.ok(doc.includes(`| \`${p.name}\` |`), `docs/providers.md does not list ${p.name}`);
  }
  const spec = fs.readFileSync(path.join(root, "SPEC.md"), "utf8");
  for (const key of ["name:", "format: anthropic | openai", "auth: bearer | x-api-key"]) {
    assert.ok(spec.includes(key), `SPEC.md does not document provider ${key}`);
  }
});

// ---------------------------------------------------------------- params

test("params: is read as written, and only reaches a translated endpoint", () => {
  const p = parseProvider({
    name: "groq",
    token: "t",
    params: { temperature: 0.2, seed: 7, provider: { order: ["Groq"] }, service_tier: "auto" },
  })!;
  assert.deepEqual(p.params, { temperature: 0.2, seed: 7, provider: { order: ["Groq"] }, service_tier: "auto" });
  assert.deepEqual(p.warnings, []);

  // On an Anthropic-shaped block the SDK talks to the provider directly, so
  // there is nothing for us to merge into — say so rather than pretend.
  const direct = parseProvider({ name: "openrouter", token: "t", params: { temperature: 0.2 } })!;
  assert.ok(direct.warnings.some((w) => /format: openai/.test(w)));

  assert.deepEqual(parseProvider({ base_url: "https://x.test", token: "t" })!.params, {});
  const notMap = parseProvider({ base_url: "https://x.test", token: "t", params: "hot" })!;
  assert.ok(notMap.warnings.some((w) => /map of field/.test(w)));
});

test("params: cannot overwrite the conversation", () => {
  const p = parseProvider({
    name: "openai",
    token: "t",
    params: { messages: [], tools: [], stream: false, stream_options: {}, model: "sneaky", temperature: 0.5 },
  })!;
  assert.deepEqual(Object.keys(p.params), ["temperature"]);
  for (const key of PROTECTED_PARAMS) {
    assert.ok(p.warnings.some((w) => w.startsWith(`provider.params.${key}:`)), `no warning for ${key}`);
  }
});

test("fallback: carries its own params", () => {
  const p = parseProvider({ name: "openrouter", token: "a", fallback: { name: "groq", token: "b", params: { temperature: 0 } } })!;
  assert.deepEqual(p.fallback?.params, { temperature: 0 });
});
