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
import { notifyConfig, sendRunNotification } from "../packages/core/src/notify.ts";
import { setSecret } from "../packages/core/src/secrets.ts";
import type { RunRecord } from "../packages/core/src/store.ts";

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
