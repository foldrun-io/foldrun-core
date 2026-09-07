// The hard cap: a step stops itself at its share of what the run has left.
//
//   node --test tests/budget-ceiling.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { priceTurn, stepCeiling, FALLBACK_PRICE } from "../src/step-exec.ts";

test("a turn is priced from the catalogue, cache traffic counted as input", () => {
  const price = { input: 3e-6, output: 15e-6 };
  const usd = priceTurn({ input_tokens: 1000, cache_read_input_tokens: 4000, cache_creation_input_tokens: 0, output_tokens: 200 }, price);
  assert.equal(usd, 5000 * 3e-6 + 200 * 15e-6);
  // Missing fields are zero, not NaN.
  assert.equal(priceTurn({}, price), 0);
});

test("with no catalogue price the fallback is Opus-class — a ceiling still bites on an unknown gateway model", () => {
  const usd = priceTurn({ input_tokens: 10_000, output_tokens: 1_000 }, null);
  assert.equal(usd, 10_000 * FALLBACK_PRICE.input + 1_000 * FALLBACK_PRICE.output);
  assert.ok(usd > priceTurn({ input_tokens: 10_000, output_tokens: 1_000 }, { input: 3e-6, output: 15e-6 }), "conservative, never cheaper than a real rate");
});

test("the ceiling is the remainder shared across the steps launching together — the shares sum to what is left", () => {
  assert.equal(stepCeiling(10, 4, 1), 6);
  assert.equal(stepCeiling(10, 4, 4), 1.5, "a fan-out of four gets four equal shares");
  assert.equal(stepCeiling(10, 4, 4)! * 4, 6, "and cannot end the run over the cap");
  assert.equal(stepCeiling(10, 12, 3), 0, "already over: nothing left to spend");
  assert.equal(stepCeiling(10, 4, 0), 6, "a zero divisor is treated as one");
  assert.equal(stepCeiling(null, 4, 2), null, "no budget, no ceiling");
  assert.equal(stepCeiling(undefined, 4, 2), null);
  assert.equal(stepCeiling(0, 4, 2), null, "a zero budget is 'none', as the flow parser treats it");
});
