// The 401 that is a rotation, not a bad key.
//
// The refresher turns the long-lived grant into an 8h access token every
// four hours and Anthropic revokes the old one the moment the new one is
// minted. The platform reads the credential per step from the mounted file,
// so a restart is no longer needed — but a step already mid-turn when the
// rotation lands still gets a hard 401, and the replacement does not reach
// the mounted file until the kubelet syncs it, about a minute later.
//
// Every 401 on the live account in three weeks fell inside that window:
// 02:07:22 and 02:07:24 against a 02:07 refresh; 22:08:12, 22:08:17,
// 22:08:30 and 22:09:03 against 22:08. The desks that lost a run every
// night were the ones scheduled on the hour the refresher shares.
//
//   node --test tests/credential-rotation.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { awaitRotatedCredential, isTransientOverload } from "../src/runner.ts";
import { proxyModelEnv, type EgressGrant } from "../src/egress.ts";

/** A clock that runs as fast as the test asks it to, so a 90s window costs
 *  nothing. The poll still awaits a real timer; only the deadline is faked. */
function fakeClock(startMs = 0) {
  let t = startMs;
  return { now: () => (t += 1_000) };
}

test("a credential that changes inside the window is returned", async () => {
  const reads = ["old", "old", "new"];
  let i = 0;
  const got = await awaitRotatedCredential("old", fakeClock().now, () => reads[Math.min(i++, reads.length - 1)], 90_000, 1);
  assert.equal(got, "new");
});

test("a credential that never changes is not a rotation — the key is wrong", async () => {
  // This is the case that must still fail the step: waiting cannot fix a
  // key that is genuinely invalid, and the caller falls through to the
  // second supply exactly as it did before.
  const got = await awaitRotatedCredential("dead", fakeClock().now, () => "dead", 5_000, 1);
  assert.equal(got, null);
});

test("an empty read does not count as a change", async () => {
  // A momentarily unreadable file (the kubelet writing it) must not be
  // mistaken for a new token, or the retry rides an empty credential.
  const reads = ["", undefined, "old", "new"];
  let i = 0;
  const got = await awaitRotatedCredential("old", fakeClock().now, () => reads[Math.min(i++, reads.length - 1)], 90_000, 1);
  assert.equal(got, "new");
});

test("with no credential to compare against there is nothing to wait for", async () => {
  // A local install or a BYOK step has no platform credential; the 401 it
  // got is about its own key and must fail immediately, not stall 90s.
  const got = await awaitRotatedCredential(undefined, fakeClock().now, () => "anything", 90_000, 1);
  assert.equal(got, null);
});

test("a subscription's weekly limit is a refusal for the second supply, never a retry", () => {
  // Claude Code on a Max plan says this with no status code and none of the
  // money words. Every opus-tier step on the account failed on it on
  // 2026-09-21 while sonnet steps ran, and nothing recognised it.
  const msg = "Claude Code returned an error result: You've hit your weekly limit · resets 5am (Australia/Sydney)";
  // Not transient: the window is a week, and waiting thirty seconds three
  // times would only burn three sandboxes.
  assert.equal(isTransientOverload(msg), false);
});

test("re-granting the model key after a rotation replaces the value the proxy fills", () => {
  // The lease holds the grant by reference and commit() re-seals whatever
  // is in it. Before this, the retry after awaitRotatedCredential re-granted
  // the new token under the same name and the old, revoked one stayed —
  // so the proxy sent the revoked token and the retry 401'd as well.
  const grant: EgressGrant = { secrets: {}, timezone: "UTC" };
  const env = { CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-old" };
  proxyModelEnv(env, "http://lease", grant);
  proxyModelEnv({ CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-new" }, "http://lease", grant);
  assert.equal(grant.secrets.FOLDRUN_MODEL_KEY.value, "sk-ant-oat01-new");
  assert.deepEqual(grant.secrets.FOLDRUN_MODEL_KEY.hosts, ["api.anthropic.com"]);
});
