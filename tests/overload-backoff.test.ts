// A busy provider is waited out; a broken account is not. The two
// decisions the runner makes when a model API says no.
//
//   node --test tests/overload-backoff.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { isTransientOverload, backoffMs, OVERLOAD_RETRIES } from "../src/runner.ts";

test("busy means wait; out of money never does, whatever the status code", () => {
  // The provider is saturated — the same key works in a moment.
  for (const text of [
    "API Error: 429 rate_limit_error",
    "API Error: 529 overloaded_error",
    "API Error: 503 Service Unavailable",
    "Overloaded",
    "Rate limit reached for gpt-4o-mini, please try again",
    "429 Too Many Requests",
  ]) {
    assert.equal(isTransientOverload(text), true, text);
  }
  // The account is the problem. Waiting is the one thing that cannot help,
  // and this is the case the fallback provider exists for — a 429 that says
  // "quota" is not the same 429 as one that says "slow down".
  for (const text of [
    "API Error: 429 You exceeded your current quota",
    "API Error: 402 insufficient credits",
    "API Error: 401 invalid x-api-key",
    "API Error: 403 permission denied",
    "billing: add a payment method",
    "429 quota exceeded for this billing period",
  ]) {
    assert.equal(isTransientOverload(text), false, text);
  }
  assert.equal(isTransientOverload(""), false, "no refusal, nothing to wait for");
});

test("the wait grows, is jittered, and never runs away", () => {
  // Deterministic random: the low end of the jitter, then the high end.
  const low = backoffMs(1, "", () => 0);
  const high = backoffMs(1, "", () => 1);
  assert.equal(low, 1000, "half of two seconds");
  assert.equal(high, 2000, "all of it");
  assert.ok(backoffMs(2, "", () => 1) > high, "attempt 2 waits longer than attempt 1");
  assert.ok(backoffMs(3, "", () => 1) > backoffMs(2, "", () => 1));
  // Capped: an eighth attempt would be four minutes without one.
  assert.equal(backoffMs(20, "", () => 1), 30_000);
  // Jitter is real — twenty steps that failed together must not return
  // together, or the second wave is the first wave again.
  const spread = new Set(Array.from({ length: 40 }, () => backoffMs(2)));
  assert.ok(spread.size > 10, `expected a spread of waits, got ${spread.size}`);
});

test("a provider that names its own retry-after is believed, within the cap", () => {
  assert.equal(backoffMs(1, 'retry-after: 7'), 7000);
  assert.equal(backoffMs(1, '"retry_after":12'), 12_000);
  assert.equal(backoffMs(1, "Retry After 3 seconds"), 3000);
  assert.equal(backoffMs(1, "retry-after: 600"), 30_000, "still capped");
  assert.equal(backoffMs(1, "retry-after: 0"), 1000, "zero is a second, not an instant hammer");
});

test("three attempts, and the retry budget is a number a person can hold", () => {
  assert.equal(OVERLOAD_RETRIES, 3);
  // Worst case at full jitter: 2 + 4 + 8 seconds of waiting before the
  // fallback provider is even considered.
  const worst = [1, 2, 3].reduce((sum, n) => sum + backoffMs(n, "", () => 1), 0);
  assert.equal(worst, 14_000);
});
