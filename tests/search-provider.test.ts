import test from "node:test";
import assert from "node:assert/strict";
import { resolveSearch, PROVIDERS } from "../src/providers.ts";

test("unset means the account's own search engine", () => {
  for (const unset of [undefined, null, "", "ours"]) {
    const got = resolveSearch(unset);
    assert.equal(got.provider, null);
    assert.equal(got.error, undefined);
  }
});

test("a provider that searches resolves to its shape and its index", () => {
  const a = resolveSearch("anthropic");
  assert.equal(a.provider, "anthropic");
  assert.equal(a.shape, "anthropic");
  assert.match(a.index!, /Brave/);

  // Same wire shape, a different index — which is the whole point of the key.
  const z = resolveSearch("zai");
  assert.equal(z.shape, "anthropic");
  assert.match(z.index!, /Zhipu/);

  assert.equal(resolveSearch("kimi").shape, "builtin_fn");
  assert.equal(resolveSearch("openrouter").shape, "plugin");
  assert.equal(resolveSearch("openai").shape, "openai");
});

test("an Anthropic-shaped endpoint with no search is refused, not quietly allowed", () => {
  // DeepSeek is the case this exists for: the wire is Anthropic's, so every
  // shape check passes, and there is still no search behind it.
  const preset = PROVIDERS.find((p) => p.name === "deepseek")!;
  assert.equal(preset.format, "anthropic", "the trap only matters while this is true");
  const got = resolveSearch("deepseek");
  assert.equal(got.provider, null);
  assert.match(got.error!, /no server-side search/);
  assert.match(got.error!, /own search engine/, "the error says what to do instead");
});

test("a typo names the providers that would have worked", () => {
  const got = resolveSearch("anthropc");
  assert.match(got.error!, /no provider by that name/);
  assert.match(got.error!, /anthropic/);
});

test("case and padding do not decide whether a desk can search", () => {
  assert.equal(resolveSearch("  Anthropic  ").provider, "anthropic");
});

test("a non-string is an error rather than a silent fallback", () => {
  assert.match(resolveSearch(true)!.error!, /provider name/);
});
