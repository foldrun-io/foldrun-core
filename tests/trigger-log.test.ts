// The record of why nothing happened, and what a person reads off it.
//
//   node --test tests/trigger-log.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { recordTriggerEvent, readTriggerEvents, summariseTriggers } from "../src/trigger-log.ts";
import { outcomeFor, noteSecretUse, secretHealth, failingSecrets, forgetSecretHealth, flushSecretHealth, healthKey } from "../src/secret-health.ts";

async function withWorkspace(body: () => void | Promise<void>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-tlog-"));
  const prev = process.env.FOLDRUN_DATA;
  process.env.FOLDRUN_DATA = root;
  try {
    fs.mkdirSync(path.join(root, "acme/workspaces/desk"), { recursive: true });
    await body();
    await flushSecretHealth();
  } finally {
    if (prev === undefined) delete process.env.FOLDRUN_DATA;
    else process.env.FOLDRUN_DATA = prev;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const at = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString();

// ------------------------------------------------------------ the log

test("events come back newest first, and a missing log is empty rather than an error", () =>
  withWorkspace(() => {
    assert.deepEqual(readTriggerEvents("acme", "desk"), []);
    recordTriggerEvent("acme", "desk", { t: at(10), flow: "orders", trigger: "webhook", outcome: "started" });
    recordTriggerEvent("acme", "desk", { t: at(5), flow: "orders", trigger: "webhook", outcome: "duplicate" });
    const events = readTriggerEvents("acme", "desk");
    assert.deepEqual(events.map((e) => e.outcome), ["duplicate", "started"]);
  }));

test("recording against a workspace that does not exist is a no-op, not a crash", () =>
  withWorkspace(() => {
    recordTriggerEvent("acme", "nowhere", { t: at(1), flow: "x", trigger: "webhook", outcome: "started" });
    assert.deepEqual(readTriggerEvents("acme", "nowhere"), []);
  }));

// -------------------------------------------------------- the summary

test("the summary is the gap between fired and started, with the reasons for it", () =>
  withWorkspace(() => {
    for (let i = 0; i < 8; i++) {
      recordTriggerEvent("acme", "desk", {
        t: at(60 - i),
        flow: "orders",
        trigger: "webhook",
        outcome: "duplicate",
        detail: "already handled this x-delivery — no run started",
      });
    }
    recordTriggerEvent("acme", "desk", { t: at(50), flow: "orders", trigger: "webhook", outcome: "throttled", detail: "throttle: 900s" });
    recordTriggerEvent("acme", "desk", { t: at(3), flow: "orders", trigger: "webhook", outcome: "started" });

    const [row] = summariseTriggers("acme", "desk");
    assert.equal(row.flow, "orders");
    assert.equal(row.fired, 10);
    assert.equal(row.started, 1);
    // Biggest reason first: that is the one worth acting on.
    assert.deepEqual(row.dropped.map((d) => [d.outcome, d.count]), [["duplicate", 8], ["throttled", 1]]);
    assert.equal(row.lastStartedAt !== null, true);
  }));

test("the window excludes what is outside it", () =>
  withWorkspace(() => {
    recordTriggerEvent("acme", "desk", { t: at(60 * 24 * 30), flow: "old", trigger: "schedule", outcome: "started" });
    recordTriggerEvent("acme", "desk", { t: at(5), flow: "new", trigger: "schedule", outcome: "started" });
    const recent = summariseTriggers("acme", "desk", Date.now() - 86400_000);
    assert.deepEqual(recent.map((r) => r.flow), ["new"]);
    assert.equal(summariseTriggers("acme", "desk").length, 2, "no window is everything the log still holds");
  }));

test("flows are ranked by how often they fired, so the noisy one is first", () =>
  withWorkspace(() => {
    recordTriggerEvent("acme", "desk", { t: at(5), flow: "quiet", trigger: "schedule", outcome: "started" });
    for (let i = 0; i < 4; i++) {
      recordTriggerEvent("acme", "desk", { t: at(10 + i), flow: "noisy", trigger: "storage", outcome: "debounced" });
    }
    assert.deepEqual(summariseTriggers("acme", "desk").map((r) => r.flow), ["noisy", "quiet"]);
  }));

// ------------------------------------------------------ secret health

test("only 401, 402 and 403 are the credential's fault", () => {
  assert.equal(outcomeFor(200), "accepted");
  assert.equal(outcomeFor(204), "accepted");
  assert.equal(outcomeFor(401), "refused");
  assert.equal(outcomeFor(402), "refused");
  assert.equal(outcomeFor(403), "refused");
  // A provider failing at its end says nothing about the key, and calling it
  // a credential failure would send someone to rotate the wrong thing.
  assert.equal(outcomeFor(500), "error");
  assert.equal(outcomeFor(429), "error");
  assert.equal(outcomeFor(null), "error");
});

test("a run of refusals accumulates, an acceptance clears it, and the last success is kept", () =>
  withWorkspace(async () => {
    fs.mkdirSync(path.join(process.env.FOLDRUN_DATA!, "acme"), { recursive: true });
    // Captured once: two calls to at() a millisecond apart are two different
    // timestamps, which is a bug in the test rather than in the code.
    const worked = at(1000);
    const k = healthKey("RESEND_API_KEY", "account");
    noteSecretUse("acme", k, { host: "api.resend.com", status: 200, at: worked });
    noteSecretUse("acme", k, { host: "api.resend.com", status: 401, at: at(100) });
    noteSecretUse("acme", k, { host: "api.resend.com", status: 401, at: at(50) });
    await flushSecretHealth();

    let record = secretHealth("acme")[k];
    assert.equal(record.refusals, 2);
    assert.equal(record.last.outcome, "refused");
    assert.equal(record.lastAccepted, worked, "the date it last worked is what dates the breakage");

    noteSecretUse("acme", k, { host: "api.resend.com", status: 200, at: at(1) });
    await flushSecretHealth();
    record = secretHealth("acme")[k];
    assert.equal(record.refusals, 0);
    assert.equal(record.last.outcome, "accepted");
  }));

test("an error at the far end does not count against the key", () =>
  withWorkspace(async () => {
    fs.mkdirSync(path.join(process.env.FOLDRUN_DATA!, "acme"), { recursive: true });
    noteSecretUse("acme", "account:K", { host: "api.example.com", status: 401, at: at(20) });
    noteSecretUse("acme", "account:K", { host: "api.example.com", status: 500, at: at(10) });
    await flushSecretHealth();
    assert.equal(secretHealth("acme")["account:K"].refusals, 1, "still one, not two");
  }));

test("failing secrets are the ones refused last, worst first", () =>
  withWorkspace(async () => {
    fs.mkdirSync(path.join(process.env.FOLDRUN_DATA!, "acme"), { recursive: true });
    noteSecretUse("acme", "account:GOOD", { host: "a.example.com", status: 200 });
    noteSecretUse("acme", "account:BAD_ONCE", { host: "b.example.com", status: 403 });
    for (let i = 0; i < 3; i++) noteSecretUse("acme", "account:BAD_OFTEN", { host: "c.example.com", status: 401 });
    await flushSecretHealth();
    assert.deepEqual(failingSecrets("acme").map((f) => f.name), ["account:BAD_OFTEN", "account:BAD_ONCE"]);
  }));

test("rotating or deleting a secret forgets what the old one did", () =>
  withWorkspace(async () => {
    fs.mkdirSync(path.join(process.env.FOLDRUN_DATA!, "acme"), { recursive: true });
    noteSecretUse("acme", "account:K", { host: "a.example.com", status: 401 });
    await flushSecretHealth();
    forgetSecretHealth("acme", "account:K");
    // A fresh key showing its predecessor's refusals is the moment someone
    // stops trusting the indicator.
    assert.equal(secretHealth("acme")["account:K"], undefined);
  }));

test("the same name in two scopes is two credentials", () =>
  withWorkspace(async () => {
    fs.mkdirSync(path.join(process.env.FOLDRUN_DATA!, "acme"), { recursive: true });
    noteSecretUse("acme", healthKey("API_KEY", "workspace", "blog"), { host: "x.example.com", status: 401 });
    noteSecretUse("acme", healthKey("API_KEY", "account"), { host: "x.example.com", status: 200 });
    await flushSecretHealth();
    const h = secretHealth("acme");
    assert.equal(h["workspace:blog:API_KEY"].last.outcome, "refused");
    assert.equal(h["account:API_KEY"].last.outcome, "accepted");
  }));

test("a secret nothing has used has no health, which is a third state", () =>
  withWorkspace(() => {
    fs.mkdirSync(path.join(process.env.FOLDRUN_DATA!, "acme"), { recursive: true });
    assert.equal(secretHealth("acme").NEVER_USED, undefined);
  }));
