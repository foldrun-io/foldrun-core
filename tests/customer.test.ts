// An end customer's id (FOL-168): the rule a partner's id follows, the
// provider's end-user id (hashed with the account, never the id itself),
// and setting it in each body shape without touching anything else.

import { test } from "node:test";
import assert from "node:assert/strict";
import { customerProblem, providerUserId, customerKey, withProviderUser } from "../src/customer.ts";
import { parseRunFilter, matchesRunFilter } from "../src/runs-filter.ts";
import { summarizeRun } from "../src/store.ts";

test("the id rule; the provider id is per account, opaque and fits every provider's limit", () => {
  assert.equal(customerProblem("c-8812"), null);
  assert.equal(customerProblem("tenant:org.42@eu"), null);
  for (const bad of ["", "has space", "x".repeat(129), "naïve", 7]) assert.ok(customerProblem(bad), String(bad));
  const a = providerUserId("acme", "user-1");
  assert.match(a, /^fr-[0-9a-f]{32}$/);
  assert.equal(a, providerUserId("acme", "user-1"), "stable");
  assert.notEqual(a, providerUserId("rival", "user-1"), "two partners' user-1 are not one identity");
  assert.ok(a.length <= 64, "inside OpenAI's safety_identifier limit");
  assert.notEqual(customerKey("acme", "user-1"), a);
});

test("set in each shape: Anthropic metadata (other metadata kept), Responses, Chat; not JSON left alone", () => {
  const anth = JSON.parse(withProviderUser(Buffer.from(JSON.stringify({ model: "m", metadata: { user_id: "theirs", other: 1 } })), "fr-x", "anthropic").toString());
  assert.deepEqual(anth.metadata, { user_id: "fr-x", other: 1 });
  assert.equal(JSON.parse(withProviderUser(Buffer.from('{"model":"m"}'), "fr-x", "responses").toString()).safety_identifier, "fr-x");
  assert.equal(JSON.parse(withProviderUser(Buffer.from('{"model":"m"}'), "fr-x", "chat").toString()).user, "fr-x");
  assert.equal(withProviderUser(Buffer.from("not json"), "fr-x", "chat").toString(), "not json");
});

test("runs filter and summary carry the customer", () => {
  const { filter } = parseRunFilter(new URLSearchParams("customer=c-1"));
  const run = { id: "r", flow: "f", status: "completed" as const, startedAt: "2026-11-11T00:00:00.000Z", finishedAt: "2026-11-11T00:01:00.000Z", customer: "c-1", steps: [] };
  assert.equal(matchesRunFilter(run, filter), true);
  assert.equal(matchesRunFilter({ ...run, customer: "c-11" }, filter), false);
  assert.equal(summarizeRun(run).customer, "c-1");
});
