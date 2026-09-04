// The Stripe webhook signature scheme, implemented by hand — so tested by
// hand: a signature we mint verifies, and every mutation of it does not.
//
//   node --test tests/stripe.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { verifyStripeSignature } from "../web/server/stripe.ts";

const SECRET = "whsec_testing";

function signedHeader(payload: string, atSec: number, secret = SECRET) {
  const mac = crypto.createHmac("sha256", secret).update(`${atSec}.${payload}`).digest("hex");
  return `t=${atSec},v1=${mac}`;
}

test("a genuine signature verifies", () => {
  const payload = '{"id":"evt_1","type":"checkout.session.completed"}';
  const now = 1_800_000_000;
  assert.ok(verifyStripeSignature(payload, signedHeader(payload, now), SECRET, now));
});

test("tampering with the payload breaks it", () => {
  const now = 1_800_000_000;
  const header = signedHeader('{"amount":5}', now);
  assert.ok(!verifyStripeSignature('{"amount":500}', header, SECRET, now));
});

test("the wrong secret breaks it", () => {
  const payload = "{}";
  const now = 1_800_000_000;
  assert.ok(!verifyStripeSignature(payload, signedHeader(payload, now, "whsec_other"), SECRET, now));
});

test("a stale timestamp is a replay, not a payment", () => {
  const payload = "{}";
  const now = 1_800_000_000;
  const header = signedHeader(payload, now - 6 * 60); // signed 6 minutes ago
  assert.ok(!verifyStripeSignature(payload, header, SECRET, now));
});

test("garbage headers refuse quietly", () => {
  assert.ok(!verifyStripeSignature("{}", null, SECRET));
  assert.ok(!verifyStripeSignature("{}", "", SECRET));
  assert.ok(!verifyStripeSignature("{}", "t=abc,v1=def", SECRET));
  assert.ok(!verifyStripeSignature("{}", "v1=deadbeef", SECRET));
});
