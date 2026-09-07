import { test } from "node:test";
import assert from "node:assert/strict";
import { priceTurn, knownPrice, stepCeiling, FALLBACK_PRICE } from "../src/step-exec.ts";

// The meter a step stops itself by. It killed a real indexing run on
// 2026-09-08 — three steps reported $0.93–$1.17 against a $0.93 ceiling
// having actually spent about a tenth of that, because with no catalogue
// every model was priced at Opus rates and cache reads at the full input
// rate. The run ended having spent $0.38 of a $4 budget.

test("a model we know by name is priced by name, not at the Opus fallback", () => {
  assert.deepEqual(knownPrice("haiku"), { input: 1e-6, output: 5e-6 });
  assert.deepEqual(knownPrice("sonnet"), { input: 2e-6, output: 10e-6 });
  assert.deepEqual(knownPrice("claude-sonnet-5"), { input: 2e-6, output: 10e-6 });
  assert.deepEqual(knownPrice("claude-opus-5"), { input: 5e-6, output: 25e-6 });
  assert.equal(knownPrice("some-gateway/mystery-7b"), null, "an unknown id still falls back");
  assert.equal(knownPrice(undefined), null);
});

test("cache reads cost a tenth of fresh input, writes a quarter more", () => {
  const p = { input: 2e-6, output: 10e-6 };
  // 10k fresh, 10k written, 100k read, 1k out
  const cost = priceTurn(
    { input_tokens: 10_000, cache_creation_input_tokens: 10_000, cache_read_input_tokens: 100_000, output_tokens: 1_000 },
    p,
  );
  const expected = 10_000 * 2e-6 + 10_000 * 2e-6 * 1.25 + 100_000 * 2e-6 * 0.1 + 1_000 * 10e-6;
  assert.ok(Math.abs(cost - expected) < 1e-12, `${cost} != ${expected}`);
  // The old arithmetic counted every cached token at the full input rate.
  const naive = 120_000 * 2e-6 + 1_000 * 10e-6;
  assert.ok(cost < naive / 3, `a long cached prompt should not read as ${naive}`);
});

test("the real indexing turn that was killed prices under its ceiling", () => {
  // thin-judge: sonnet, roughly the usage of the runs that completed.
  const usage = { input_tokens: 20_000, cache_read_input_tokens: 60_000, output_tokens: 3_700 };
  const now = priceTurn(usage, knownPrice("sonnet"));
  assert.ok(now < 0.12, `priced at $${now.toFixed(4)}, should be well under the $0.93 ceiling`);
  // What the old meter did: Opus rates, and every cached token at the full
  // input rate. Both halves of the bug, together.
  const before =
    (usage.input_tokens + usage.cache_read_input_tokens) * FALLBACK_PRICE.input +
    usage.output_tokens * FALLBACK_PRICE.output;
  assert.ok(before > 1.4, `the old meter read $${before.toFixed(4)}`);
  assert.ok(before / now > 15, `it read ${(before / now).toFixed(1)}× the real cost`);
  // The price alone, without the cache half, is still 7.5× on sonnet.
  assert.ok(priceTurn(usage, FALLBACK_PRICE) / now > 7, "Opus rates alone are 7.5x sonnet");
});

test("stepCeiling still shares the remainder so a group cannot end over the cap", () => {
  assert.equal(stepCeiling(4, 0.2886, 4), (4 - 0.2886) / 4);
  assert.equal(stepCeiling(null, 1, 2), null);
  assert.equal(stepCeiling(4, 9, 2), 0, "spent past the budget leaves nothing");
});
