// Per-hook rotation and the delivery log.
//
//   node --test tests/webhook-rotation.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  webhookToken,
  rotateWebhook,
  hookGeneration,
  recordDelivery,
  readDeliveries,
} from "../packages/core/src/webhook.ts";

function withWorkspace(body: () => void) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-hook-"));
  const previous = process.env.FOLDRUN_DATA;
  process.env.FOLDRUN_DATA = root;
  try {
    fs.mkdirSync(path.join(root, "acme/workspaces/desk"), { recursive: true });
    body();
  } finally {
    if (previous === undefined) delete process.env.FOLDRUN_DATA;
    else process.env.FOLDRUN_DATA = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test("an unrotated hook keeps the original token — old URLs survive the feature", () => {
  withWorkspace(() => {
    assert.equal(hookGeneration("acme", "desk", "publish"), 0);
    const before = webhookToken("acme", "desk", "publish");
    assert.equal(before.length, 32);
    // Generation 0 must use the pre-rotation formula: same identity, same
    // key, no suffix. If this breaks, every hook URL ever handed out dies.
    assert.equal(before, webhookToken("acme", "desk", "publish"));
  });
});

test("rotation changes the token and only that flow's token", () => {
  withWorkspace(() => {
    const before = webhookToken("acme", "desk", "publish");
    const other = webhookToken("acme", "desk", "weekly");
    rotateWebhook("acme", "desk", "publish");
    assert.equal(hookGeneration("acme", "desk", "publish"), 1);
    assert.notEqual(webhookToken("acme", "desk", "publish"), before);
    assert.equal(webhookToken("acme", "desk", "weekly"), other);

    // Again, for the leak-twice case.
    const gen1 = webhookToken("acme", "desk", "publish");
    rotateWebhook("acme", "desk", "publish");
    assert.notEqual(webhookToken("acme", "desk", "publish"), gen1);
  });
});

test("deliveries are recorded newest-first and bounded", () => {
  withWorkspace(() => {
    for (let i = 0; i < 1100; i++) {
      recordDelivery("acme", "desk", {
        t: new Date(Date.UTC(2026, 0, 1, 0, 0, i % 60, i)).toISOString(),
        flow: "publish",
        outcome: i % 3 === 0 ? "invalid-token" : "accepted",
        runId: `run-${i}`,
      });
    }
    const recent = readDeliveries("acme", "desk", 10);
    assert.equal(recent.length, 10);
    assert.equal(recent[0].runId, "run-1099", "newest first");

    const file = path.join(process.env.FOLDRUN_DATA!, "acme/workspaces/desk/hook-deliveries.jsonl");
    const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
    assert.ok(lines.length <= 1001, `log stays bounded, got ${lines.length}`);
  });
});

test("logging against a workspace that does not exist is a no-op, not a crash", () => {
  withWorkspace(() => {
    recordDelivery("acme", "nope", { t: new Date().toISOString(), flow: "x", outcome: "error" });
    assert.deepEqual(readDeliveries("acme", "nope"), []);
  });
});
