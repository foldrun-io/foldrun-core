// FOL-460: a step on the platform's credential has no gateway catalogue, and
// the runner priced it from the model's name alone — three families known,
// every other at the fallback rate.
import { test } from "node:test";
import assert from "node:assert/strict";
import { priceWithoutCatalogue, subagentPrices } from "../src/runner.ts";
import { registerPlatform, resetPlatform } from "../src/platform.ts";
import { FALLBACK_PRICE, knownPrice, priceTurn } from "../src/step-exec.ts";

const LIST: Record<string, { input: number; output: number; cacheRead?: number | null; cacheWrite?: number | null }> = {
  "anthropic/claude-new-9": { input: 8e-6, output: 40e-6, cacheRead: 0.8e-6, cacheWrite: 10e-6 },
  "anthropic/claude-sonnet-5-5": { input: 3e-6, output: 15e-6 },
  "deepseek/deepseek-v4": { input: 0.5e-6, output: 2e-6 },
};

test("the platform's price list is asked before the model's name, and only on the platform's credential", () => {
  const asked: string[] = [];
  registerPlatform({ modelPrice: (provider, model) => (asked.push(`${provider}/${model}`), LIST[`${provider}/${model}`] ?? null) });
  try {
    // A model the name table does not know: the list's price, not the fallback.
    assert.deepEqual(priceWithoutCatalogue("anthropic", "claude-new-9"), LIST["anthropic/claude-new-9"]);
    // A model the name table does know: the list still wins (the console is the authority).
    assert.deepEqual(priceWithoutCatalogue("anthropic", "claude-sonnet-5-5"), LIST["anthropic/claude-sonnet-5-5"]);
    assert.deepEqual(priceWithoutCatalogue("deepseek", "deepseek-v4"), LIST["deepseek/deepseek-v4"]);
    // Not on the list: what the name says, else nothing (the caller's fallback).
    assert.deepEqual(priceWithoutCatalogue("anthropic", "claude-haiku-9"), knownPrice("claude-haiku-9"));
    assert.equal(priceWithoutCatalogue("anthropic", "claude-unlisted-1"), null);
    // The account's own key: the platform's list says nothing about its price.
    asked.length = 0;
    assert.equal(priceWithoutCatalogue(null, "claude-new-9"), null);
    assert.deepEqual(asked, []);
  } finally {
    resetPlatform();
  }
});

test("a price list that answers nonsense is not used; no price list keeps the name's price", () => {
  for (const bad of [{ input: NaN, output: 1e-6 }, { input: 1e-6, output: -1 }, { input: Infinity, output: 1e-6 }]) {
    registerPlatform({ modelPrice: () => bad });
    try {
      assert.deepEqual(priceWithoutCatalogue("anthropic", "claude-sonnet-5-5"), knownPrice("claude-sonnet-5-5"));
      assert.equal(priceWithoutCatalogue("anthropic", "claude-new-9"), null);
    } finally {
      resetPlatform();
    }
  }
  assert.deepEqual(priceWithoutCatalogue("anthropic", "claude-opus-5-5"), knownPrice("claude-opus-5-5"));
  assert.equal(priceWithoutCatalogue("anthropic", "claude-new-9"), null);
});

test("a planner's turns: $4.33 at the fallback rate, $2.32 at a list price of $8 / $40", () => {
  // A real stopped step, as the runner summed it.
  const turns = { input_tokens: 16, output_tokens: 35, cache_read_input_tokens: 156349, cache_creation_input_tokens: 218535 };
  assert.equal(Number(priceTurn(turns, null).toFixed(8)), 4.33491975);
  assert.equal(priceTurn(turns, null), priceTurn(turns, FALLBACK_PRICE));
  registerPlatform({ modelPrice: (provider, model) => LIST[`${provider}/${model}`] ?? null });
  try {
    const listed = priceWithoutCatalogue("anthropic", "claude-new-9");
    assert.equal(Number(priceTurn(turns, listed).toFixed(6)), Number((218535 * 10e-6 + 156349 * 0.8e-6 + 16 * 8e-6 + 35 * 40e-6).toFixed(6)));
  } finally {
    resetPlatform();
  }
});

test("sub-agents on another model: priced by the id the model is sent as and by the declared word", () => {
  registerPlatform({ modelPrice: (provider, model) => LIST[`${provider}/${model}`] ?? null });
  try {
    const fable = LIST["anthropic/claude-new-9"];
    // An alias the operator sends as a listed id: both keys carry the list's price.
    const mapped = subagentPrices("anthropic", { opus: "claude-new-9" }, ["opus"]);
    assert.deepEqual(mapped["claude-new-9"], fable);
    assert.deepEqual(mapped.opus, fable);
    // Unmapped aliases keep the name's price; a declared id is looked up as itself.
    assert.deepEqual(mapped.haiku, knownPrice("haiku"));
    assert.deepEqual(subagentPrices("anthropic", {}, ["claude-new-9", "inherit", ""])["claude-new-9"], fable);
    assert.equal("inherit" in subagentPrices("anthropic", {}, ["inherit"]), false);
    // Nothing listed and no name to go by: no entry, never a made-up price.
    assert.equal("claude-unlisted-1" in subagentPrices("anthropic", {}, ["claude-unlisted-1"]), false);
    // The account's own key: names only.
    assert.equal("claude-new-9" in subagentPrices(null, { opus: "claude-new-9" }, ["opus"]), false);
  } finally {
    resetPlatform();
  }
  // resetPlatform takes the hook away again.
  assert.equal(priceWithoutCatalogue("anthropic", "claude-new-9"), null);
});
