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
import { awaitRotatedCredential } from "../src/runner.ts";

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
