// Outbound run notifications: one URL in AGENTS.md, one JSON POST per event
// someone asked to hear about.
//
//   node --test tests/notify.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { notifyConfig, sendRunNotification, isQuietFlow, notifyMail, platformMail, attemptWebhook, nextAttemptAt, WEBHOOK_BACKOFF_MS, newDeliveryId } from "../src/notify.ts";
import crypto from "node:crypto";
import { setSecret } from "../src/secrets.ts";
import type { RunRecord } from "../src/store.ts";

function withWorkspace(
  agentsMd: string | null,
  body: () => void | Promise<void>,
  accountAgentsMd?: string,
) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-notify-"));
  const previous = process.env.FOLDRUN_DATA;
  process.env.FOLDRUN_DATA = root;
  const done = () => {
    if (previous === undefined) delete process.env.FOLDRUN_DATA;
    else process.env.FOLDRUN_DATA = previous;
    fs.rmSync(root, { recursive: true, force: true });
  };
  try {
    const ws = path.join(root, "acme/workspaces/desk");
    fs.mkdirSync(ws, { recursive: true });
    if (agentsMd !== null) fs.writeFileSync(path.join(ws, "AGENTS.md"), agentsMd);
    if (accountAgentsMd) fs.writeFileSync(path.join(root, "acme/AGENTS.md"), accountAgentsMd);
    const out = body();
    if (out && typeof (out as Promise<void>).then === "function") {
      return (out as Promise<void>).finally(done);
    }
    done();
  } catch (err) {
    done();
    throw err;
  }
}

const run = (status: RunRecord["status"]): RunRecord => ({
  id: "run-x",
  flow: "publish",
  status,
  startedAt: new Date().toISOString(),
  finishedAt: status === "awaiting-approval" ? null : new Date().toISOString(),
  steps: [
    {
      agent: "writer",
      instruction: "draft",
      group: 1,
      optional: false,
      attempts: 1,
      status: status === "completed" ? "completed" : status === "failed" ? "failed" : "awaiting-approval",
      events: [],
      result: null,
      costUsd: 0.12,
    },
  ],
});

test("no notify block means no config", () =>
  withWorkspace("---\nname: desk\n---\n", () => {
    assert.equal(notifyConfig("acme", "desk"), null);
  }));

test("a bare string is a URL with the default events", () =>
  withWorkspace('---\nnotify: https://example.test/hook\n---\n', () => {
    const config = notifyConfig("acme", "desk")!;
    assert.equal(config.url, "https://example.test/hook");
    assert.deepEqual(config.events, ["failed", "awaiting-approval"]);
  }));

test("the workspace's block replaces the account's whole, like provider:", () =>
  withWorkspace(
    '---\nnotify:\n  url: https://workspace.test/hook\n  events: [completed]\n---\n',
    () => {
      const config = notifyConfig("acme", "desk")!;
      assert.equal(config.url, "https://workspace.test/hook");
      assert.deepEqual(config.events, ["completed"]);
    },
    '---\nnotify: https://account.test/hook\n---\n',
  ));

test("the account's block covers workspaces that declare none", () =>
  withWorkspace("---\nname: desk\n---\n", () => {
    assert.equal(notifyConfig("acme", "desk")!.url, "https://account.test/hook");
  }, '---\nnotify: https://account.test/hook\n---\n'));

test("an event nobody asked about sends nothing", () =>
  withWorkspace('---\nnotify: https://127.0.0.1:1/hook\n---\n', async () => {
    // completed is not in the defaults; an attempted send to that port would
    // error, so `false` here proves no request was even made.
    assert.equal(await sendRunNotification("acme", "desk", run("completed")), false);
  }));

test("an eval or adhoc run completing is nobody's news; its failure or gate still is", () =>
  withWorkspace('---\nnotify:\n  url: https://127.0.0.1:1/hook\n  events: [completed, failed, awaiting-approval]\n---\n', async () => {
    // Port 1 refuses: a send that was attempted resolves false after logging,
    // a send that was never attempted also resolves false — so the proof is
    // in the flow name deciding, pinned by isQuietFlow directly.
    assert.equal(isQuietFlow("eval:post-spec"), true);
    assert.equal(isQuietFlow("adhoc:local-serp"), true);
    assert.equal(isQuietFlow("rankings"), false);
    assert.equal(isQuietFlow("evaluate"), false);
    assert.equal(await sendRunNotification("acme", "desk", { ...run("completed"), flow: "eval:post-spec" }), false);
  }));

test("a subscribed event POSTs the run, with secrets resolved into the URL", () =>
  withWorkspace(null, async () => {
    const received: { url?: string; body?: string } = {};
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        received.url = req.url;
        received.body = body;
        res.writeHead(200).end("ok");
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;

    const ws = path.join(process.env.FOLDRUN_DATA!, "acme/workspaces/desk");
    fs.writeFileSync(
      path.join(ws, "AGENTS.md"),
      `---\nnotify:\n  url: http://127.0.0.1:${port}/hook/\${HOOK_PATH}\n  events: [failed]\n---\n`,
    );
    setSecret("acme", "HOOK_PATH", "sekrit-path", "desk");

    try {
      assert.equal(await sendRunNotification("acme", "desk", run("failed")), true);
      assert.equal(received.url, "/hook/sekrit-path");
      const payload = JSON.parse(received.body!);
      assert.equal(payload.status, "failed");
      assert.equal(payload.runId, "run-x");
      assert.match(payload.text, /✗ publish failed at writer/);
      assert.match(payload.text, /\$0\.1200/);
    } finally {
      server.close();
    }
  }));

test("a dead receiver is logged, never thrown", () =>
  withWorkspace('---\nnotify:\n  url: http://127.0.0.1:1/hook\n  events: [failed]\n---\n', async () => {
    assert.equal(await sendRunNotification("acme", "desk", run("failed")), false);
  }));

test("notify: email is a destination like a URL is", () =>
  withWorkspace(
    "---\nname: desk\nnotify:\n  email: ops@example.com\n  events: [failed, completed]\n---\n",
    () => {
      const c = notifyConfig("acme", "desk")!;
      assert.equal(c.email, "ops@example.com");
      assert.equal(c.url, undefined);
      assert.deepEqual(c.events, ["failed", "completed"]);
    },
  ));

test("a bare string destination is read as what it looks like", () =>
  withWorkspace("---\nname: desk\nnotify: ops@example.com\n---\n", () => {
    assert.equal(notifyConfig("acme", "desk")!.email, "ops@example.com");
  }));

test("a bare URL string stays a webhook", () =>
  withWorkspace("---\nname: desk\nnotify: https://ntfy.sh/topic\n---\n", () => {
    assert.equal(notifyConfig("acme", "desk")!.url, "https://ntfy.sh/topic");
  }));

test("a run notification is the account's mail first; the platform's is the fallback", () =>
  withWorkspace("---\nnotify: ops@example.com\n---\n", () => {
    const hadKey = process.env.FOLDRUN_RESEND_API_KEY;
    const hadFrom = process.env.FOLDRUN_EMAIL_FROM;
    try {
      process.env.FOLDRUN_RESEND_API_KEY = "re_platform";
      process.env.FOLDRUN_EMAIL_FROM = "foldrun <hello@foldrun.io>";
      // No account key: the platform's connection carries the notification.
      assert.deepEqual(notifyMail("acme"), { key: "re_platform", from: "foldrun <hello@foldrun.io>" });
      // The account chose its own: that wins for notifications.
      setSecret("acme", "RESEND_API_KEY", "re_theirs");
      setSecret("acme", "EMAIL_FROM", "Owner Inspections <marketing@ownerinspections.com.au>");
      assert.deepEqual(notifyMail("acme"), { key: "re_theirs", from: "Owner Inspections <marketing@ownerinspections.com.au>" });
      // An account with its own sender gets ALL its mail from it — invites,
      // resets and low-balance too. No foldrun.io beside its own domain.
      assert.deepEqual(platformMail("acme"), { key: "re_theirs", from: "Owner Inspections <marketing@ownerinspections.com.au>" });
      // A key with no sender of its own is not a choice of sender: platform mail stays the platform's.
      setSecret("acme", "EMAIL_FROM", "");
      assert.deepEqual(platformMail("acme"), { key: "re_platform", from: "foldrun <hello@foldrun.io>" });
    } finally {
      if (hadKey === undefined) delete process.env.FOLDRUN_RESEND_API_KEY; else process.env.FOLDRUN_RESEND_API_KEY = hadKey;
      if (hadFrom === undefined) delete process.env.FOLDRUN_EMAIL_FROM; else process.env.FOLDRUN_EMAIL_FROM = hadFrom;
    }
  }));

test("a completed run whose verdict is BLOCKED is sent as blocked — to whoever hears failures, not to completed-only", () =>
  withWorkspace(null, async () => {
    const bodies: string[] = [];
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        bodies.push(body);
        res.writeHead(200).end("ok");
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    const ws = path.join(process.env.FOLDRUN_DATA!, "acme/workspaces/desk");
    const events = (list: string) =>
      fs.writeFileSync(path.join(ws, "AGENTS.md"), `---\nnotify:\n  url: http://127.0.0.1:${port}/hook\n  events: [${list}]\n---\n`);
    const blocked = { ...run("completed"), summary: "BLOCKED — applied 78 links, not the 7 approved; nothing pushed", verdict: "BLOCKED" as const };
    const good = { ...run("completed"), summary: "GOOD — 6 links", verdict: "GOOD" as const };
    try {
      events("failed");
      assert.equal(await sendRunNotification("acme", "desk", blocked), true, "failed hears blocked");
      assert.equal(await sendRunNotification("acme", "desk", good), false, "failed does not hear good");
      const payload = JSON.parse(bodies[0]);
      assert.equal(payload.verdict, "BLOCKED");
      assert.equal(payload.status, "completed");
      assert.match(payload.text, /⛔ publish blocked — BLOCKED/);

      events("completed");
      assert.equal(await sendRunNotification("acme", "desk", blocked), false, "completed-only does not hear blocked");
      assert.equal(await sendRunNotification("acme", "desk", good), true);

      events("blocked");
      assert.equal(await sendRunNotification("acme", "desk", blocked), true, "blocked alone hears it");
      assert.equal(await sendRunNotification("acme", "desk", run("failed")), false);
    } finally {
      server.close();
    }
  }));

test("the retry schedule: at once, then 1m, 5m, 30m, 2h, 6h — and nothing after the sixth", () => {
  assert.deepEqual([...WEBHOOK_BACKOFF_MS], [0, 60_000, 300_000, 1_800_000, 7_200_000, 21_600_000]);
  const t = 1_000_000;
  assert.equal(nextAttemptAt(1, t), t + 60_000);
  assert.equal(nextAttemptAt(2, t), t + 300_000);
  assert.equal(nextAttemptAt(3, t), t + 1_800_000);
  assert.equal(nextAttemptAt(4, t), t + 7_200_000);
  assert.equal(nextAttemptAt(5, t), t + 21_600_000);
  assert.equal(nextAttemptAt(6, t), null, "six attempts, then given up");
  assert.match(newDeliveryId(), /^dlv_[0-9a-f]{32}$/);
});

test("an attempt carries the delivery id, the event and a signature over timestamp.body that a receiver can verify", () =>
  withWorkspace(null, async () => {
    const got: { headers?: http.IncomingHttpHeaders; body?: string } = {};
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        got.headers = req.headers;
        got.body = body;
        res.writeHead(503).end("x".repeat(900));
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    const ws = path.join(process.env.FOLDRUN_DATA!, "acme/workspaces/desk");
    fs.writeFileSync(path.join(ws, "AGENTS.md"), `---\nnotify:\n  url: http://127.0.0.1:${port}/hook\n  signing_secret: HOOK_KEY\n---\n`);
    setSecret("acme", "HOOK_KEY", "whsec-test", "desk");
    try {
      const body = JSON.stringify({ status: "failed", runId: "run-x" });
      const a = await attemptWebhook("acme", "desk", { id: "dlv_abc", event: "failed", body, attempt: 3 });
      assert.equal(a.ok, false);
      assert.equal(a.statusCode, 503);
      assert.equal(a.n, 3);
      assert.equal(a.error, "HTTP 503");
      assert.equal(a.response!.length, 500, "the answer is kept to 500 characters");
      assert.ok(a.durationMs >= 0);
      const h = got.headers!;
      assert.equal(h["x-foldrun-delivery"], "dlv_abc");
      assert.equal(h["x-foldrun-event"], "failed");
      assert.equal(h["x-foldrun-attempt"], "3");
      // The receiver's side, as the docs write it.
      const ts = String(h["x-foldrun-timestamp"]);
      assert.ok(Math.abs(Date.now() / 1000 - Number(ts)) < 60, "a fresh timestamp");
      const want = crypto.createHmac("sha256", "whsec-test").update(`${ts}.${got.body}`).digest("hex");
      assert.equal(h["x-foldrun-signature"], `sha256=${want}`);
      const replayed = crypto.createHmac("sha256", "whsec-test").update(`${Number(ts) - 3600}.${got.body}`).digest("hex");
      assert.notEqual(h["x-foldrun-signature"], `sha256=${replayed}`, "the timestamp is inside what is signed");
    } finally {
      server.close();
    }
  }));

test("an attempt at a workspace whose notify: lost its url fails with the reason, not a throw", () =>
  withWorkspace("---\nname: desk\n---\n", async () => {
    const a = await attemptWebhook("acme", "desk", { id: "dlv_x", event: "failed", body: "{}", attempt: 2 });
    assert.equal(a.ok, false);
    assert.equal(a.statusCode, null);
    assert.match(a.error!, /no url/);
  }));
