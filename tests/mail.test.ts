// One door for every email: categories, preferences honoured at send time,
// and the RFC 8058 one-click unsubscribe token.
//
//   node --test tests/mail.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  sendMail,
  unsubscribeToken,
  readUnsubscribeToken,
  unsubscribeHeaders,
  isRequiredCategory,
  MAIL_CATEGORIES,
} from "../src/mail.ts";
import { registerPlatform, resetPlatform } from "../src/platform.ts";

process.env.FOLDRUN_SECRET_KEY ??= "mail-test-install-key";

/** Every Resend call, answered 200; anything else is not expected here. */
function captureResend() {
  const sent: { to: unknown; subject: string; text: string; headers?: Record<string, string> }[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    assert.match(String(url), /api\.resend\.com\/emails/);
    sent.push(JSON.parse(String(init?.body)));
    return new Response(JSON.stringify({ id: "m1" }), { status: 200 });
  }) as typeof fetch;
  return { sent, restore: () => (globalThis.fetch = real) };
}

const mail = { key: "re_test", from: "foldrun <hello@foldrun.io>" };

test("the categories: four required, four a person may refuse", () => {
  assert.deepEqual(MAIL_CATEGORIES.filter((c) => c.required).map((c) => c.id), ["security", "invites", "billing", "account"]);
  assert.deepEqual(MAIL_CATEGORIES.filter((c) => !c.required).map((c) => c.id), ["run-alerts", "approvals", "low-balance", "product-updates"]);
  assert.ok(MAIL_CATEGORIES.filter((c) => c.required).every((c) => c.why), "a required category says why");
  assert.equal(isRequiredCategory("security"), true);
  assert.equal(isRequiredCategory("run-alerts"), false);
});

test("an unsubscribe token reads back to who, what and which workspace", () => {
  const t = unsubscribeToken({ tenant: "acme", email: " Ops@Example.test ", category: "run-alerts", workspace: "seo-desk" });
  const r = readUnsubscribeToken(t);
  assert.ok("claim" in r, JSON.stringify(r));
  assert.equal(r.claim.tenant, "acme");
  assert.equal(r.claim.email, "ops@example.test", "the address is normalised");
  assert.equal(r.claim.category, "run-alerts");
  assert.equal(r.claim.workspace, "seo-desk");
});

test("a forged, altered or missing token is refused; an expired one says so", () => {
  const t = unsubscribeToken({ tenant: "acme", email: "a@example.test", category: "low-balance", workspace: null });
  const [payload, sig] = t.split(".");
  const other = Buffer.from(JSON.stringify({ t: "acme", e: "victim@example.test", c: "low-balance", w: null, x: Date.now() + 1e9 })).toString("base64url");
  assert.deepEqual(readUnsubscribeToken(`${other}.${sig}`), { error: "invalid token", status: 401 }, "a payload swapped under an old signature");
  assert.deepEqual(readUnsubscribeToken(`${payload}.${"A".repeat(sig.length)}`), { error: "invalid token", status: 401 });
  assert.deepEqual(readUnsubscribeToken("garbage"), { error: "invalid token", status: 401 });
  assert.equal((readUnsubscribeToken("") as { status: number }).status, 400);
  const old = unsubscribeToken({ tenant: "acme", email: "a@example.test", category: "low-balance", workspace: null, expiresAt: Date.now() - 1000 });
  const r = readUnsubscribeToken(old);
  assert.equal((r as { status: number }).status, 410);
  assert.match((r as { error: string }).error, /expired/);
});

test("the RFC 8058 pair, only when the install knows its address", () => {
  const prev = process.env.FOLDRUN_PUBLIC_URL;
  try {
    delete process.env.FOLDRUN_PUBLIC_URL;
    assert.deepEqual(unsubscribeHeaders({ tenant: "acme", email: "a@example.test", category: "run-alerts", workspace: "w" }), {});
    process.env.FOLDRUN_PUBLIC_URL = "https://app.example.test/";
    const h = unsubscribeHeaders({ tenant: "acme", email: "a@example.test", category: "run-alerts", workspace: "w" });
    assert.match(h["List-Unsubscribe"], /^<https:\/\/app\.example\.test\/api\/unsubscribe\?token=[^>]+>$/);
    assert.equal(h["List-Unsubscribe-Post"], "List-Unsubscribe=One-Click");
  } finally {
    if (prev === undefined) delete process.env.FOLDRUN_PUBLIC_URL;
    else process.env.FOLDRUN_PUBLIC_URL = prev;
  }
});

test("an optional mail is not sent to someone who turned it off — asked at send time, per workspace", async () => {
  const asked: unknown[][] = [];
  registerPlatform({
    mailPreference: async (tenant, email, category, workspace) => {
      asked.push([tenant, email, category, workspace]);
      return email !== "off@example.test";
    },
  });
  process.env.FOLDRUN_PUBLIC_URL = "https://app.example.test";
  const cap = captureResend();
  try {
    const r = await sendMail({ tenant: "acme", mail, to: "on@example.test, OFF@example.test", subject: "✗ publish failed", text: "body", category: "run-alerts", workspace: "desk" });
    assert.equal(r.ok, true);
    assert.deepEqual(r.sent, ["on@example.test"]);
    assert.deepEqual(r.suppressed, ["OFF@example.test"]);
    assert.deepEqual(asked, [["acme", "on@example.test", "run-alerts", "desk"], ["acme", "off@example.test", "run-alerts", "desk"]]);
    assert.equal(cap.sent.length, 1, "one copy, to the one who wants it");
    assert.equal(cap.sent[0].to, "on@example.test");
    assert.ok(cap.sent[0].headers?.["List-Unsubscribe"], "with its own unsubscribe");
    assert.match(cap.sent[0].text, /Stop run alerts from desk: https:\/\/app\.example\.test\/unsubscribe\?token=/);
  } finally {
    cap.restore();
    resetPlatform();
    delete process.env.FOLDRUN_PUBLIC_URL;
  }
});

test("required mail is never held back and carries no unsubscribe", async () => {
  let asked = 0;
  registerPlatform({
    mailPreference: async () => {
      asked++;
      return false;
    },
  });
  process.env.FOLDRUN_PUBLIC_URL = "https://app.example.test";
  const cap = captureResend();
  try {
    const r = await sendMail({ tenant: "acme", mail, to: "me@example.test", subject: "Reset your password", text: "link", category: "security" });
    assert.equal(r.ok, true);
    assert.equal(asked, 0, "a required category is not even asked about");
    assert.equal(cap.sent.length, 1);
    assert.equal(cap.sent[0].headers, undefined);
    assert.doesNotMatch(cap.sent[0].text, /unsubscribe/i);
  } finally {
    cap.restore();
    resetPlatform();
    delete process.env.FOLDRUN_PUBLIC_URL;
  }
});

test("a preference store that throws sends anyway — a missed alert is worse", async () => {
  registerPlatform({ mailPreference: async () => { throw new Error("db down"); } });
  const cap = captureResend();
  try {
    const r = await sendMail({ tenant: "acme", mail, to: "me@example.test", subject: "s", text: "t", category: "low-balance" });
    assert.equal(r.ok, true);
    assert.equal(cap.sent.length, 1);
  } finally {
    cap.restore();
    resetPlatform();
  }
});
