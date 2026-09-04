// One-click approval from a notification: the link's token, the decision it
// applies, and the links riding in the notification itself.
//
//   node --test tests/approve-link.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { approveToken, publicUrl, webhookToken } from "../packages/core/src/webhook.ts";
import { decideApproval } from "../packages/core/src/approvals.ts";
import { sendRunNotification } from "../packages/core/src/notify.ts";
import { readRun, writeRun, type RunRecord } from "../packages/core/src/store.ts";

/** A tenant/workspace on disk, core pointed at it, and env restored after. */
function withWorkspace(body: () => void | Promise<void>, agentsMd = "---\nname: desk\n---\n") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-approve-"));
  const previous = { data: process.env.FOLDRUN_DATA, key: process.env.FOLDRUN_SECRET_KEY, url: process.env.FOLDRUN_PUBLIC_URL };
  process.env.FOLDRUN_DATA = root;
  const restore = (name: "FOLDRUN_DATA" | "FOLDRUN_SECRET_KEY" | "FOLDRUN_PUBLIC_URL", value: string | undefined) => {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  };
  const done = () => {
    restore("FOLDRUN_DATA", previous.data);
    restore("FOLDRUN_SECRET_KEY", previous.key);
    restore("FOLDRUN_PUBLIC_URL", previous.url);
    fs.rmSync(root, { recursive: true, force: true });
  };
  try {
    const ws = path.join(root, "acme/workspaces/desk");
    fs.mkdirSync(ws, { recursive: true });
    fs.writeFileSync(path.join(ws, "AGENTS.md"), agentsMd);
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

const parkedRun = (id: string, extra: Partial<RunRecord> = {}): RunRecord => ({
  id,
  flow: "publish",
  status: "awaiting-approval",
  startedAt: new Date().toISOString(),
  finishedAt: null,
  steps: [
    {
      agent: "writer",
      instruction: "draft",
      group: 1,
      optional: false,
      approve: true,
      ask: "Ship the Sydney batch too?",
      status: "awaiting-approval",
      events: [],
      result: null,
      costUsd: 0.12,
    },
  ],
  ...extra,
});

// ------------------------------------------------------------------ tokens

test("the approve token is stable, and a different run gets a different one", () =>
  withWorkspace(() => {
    const a = approveToken("acme", "desk", "run-1");
    assert.equal(a.length, 32);
    assert.equal(a, approveToken("acme", "desk", "run-1"));
    assert.notEqual(a, approveToken("acme", "desk", "run-2"));
    assert.notEqual(a, approveToken("acme", "other", "run-1"));
  }));

test("rotating the install key invalidates every approval link at once", () =>
  withWorkspace(() => {
    process.env.FOLDRUN_SECRET_KEY = "key-one";
    const before = approveToken("acme", "desk", "run-1");
    process.env.FOLDRUN_SECRET_KEY = "key-two";
    assert.notEqual(approveToken("acme", "desk", "run-1"), before);
  }));

test("an approve token is never a hook token for the same-looking identity", () =>
  withWorkspace(() => {
    // The families share a key; the prefix is what keeps them apart.
    assert.notEqual(approveToken("acme", "desk", "publish"), webhookToken("acme", "desk", "publish"));
  }));

test("publicUrl is the env value without its trailing slash, or null", () =>
  withWorkspace(() => {
    delete process.env.FOLDRUN_PUBLIC_URL;
    assert.equal(publicUrl(), null);
    process.env.FOLDRUN_PUBLIC_URL = "   ";
    assert.equal(publicUrl(), null);
    process.env.FOLDRUN_PUBLIC_URL = "https://app.example.test/";
    assert.equal(publicUrl(), "https://app.example.test");
  }));

// ---------------------------------------------------------------- deciding

test("approving stamps the step and carries the note, and says who decided", () =>
  withWorkspace(async () => {
    writeRun("acme", "desk", parkedRun("run-a"));
    const { steps } = await decideApproval("acme", "desk", "run-a", {
      decision: "approve",
      note: "  yes, but skip Sydney  ",
      by: "via emailed link",
    });
    assert.deepEqual(steps, [0]);
    const step = readRun("acme", "desk", "run-a")!.steps[0];
    assert.equal(step.status, "pending");
    assert.ok(step.approvedAt, "approval is a fact about the past and must be recorded");
    assert.equal(step.approvalNote, "yes, but skip Sydney");
    assert.equal(step.events.at(-1)!.type, "info");
    assert.match(step.events.at(-1)!.text, /^approved via emailed link — continuing \(with guidance: yes, but skip Sydney\)/);
  }));

test("rejecting fails the step and keeps the reason in the trace", () =>
  withWorkspace(async () => {
    writeRun("acme", "desk", parkedRun("run-r"));
    await decideApproval("acme", "desk", "run-r", { decision: "reject", reason: "wrong list", by: "by a human" });
    const step = readRun("acme", "desk", "run-r")!.steps[0];
    assert.equal(step.status, "failed");
    assert.equal(step.approvedAt, undefined);
    assert.equal(step.events.at(-1)!.type, "error");
    assert.equal(step.events.at(-1)!.text, "rejected by a human: wrong list");
  }));

test("a link clicked twice is a 409, not a second approval", () =>
  withWorkspace(async () => {
    writeRun("acme", "desk", parkedRun("run-t"));
    await decideApproval("acme", "desk", "run-t", { decision: "approve", by: "via emailed link" });
    await assert.rejects(
      decideApproval("acme", "desk", "run-t", { decision: "approve", by: "via emailed link" }),
      (err: Error & { status?: number }) => err.status === 409 && /nothing is awaiting approval/.test(err.message),
    );
    await assert.rejects(
      decideApproval("acme", "desk", "run-missing", { decision: "approve", by: "via emailed link" }),
      (err: Error & { status?: number }) => err.status === 404,
    );
  }));

test("a parked run is lined up again once nothing is waiting", () =>
  withWorkspace(async () => {
    writeRun("acme", "desk", parkedRun("run-p", { parkedAt: new Date().toISOString() }));
    await decideApproval("acme", "desk", "run-p", { decision: "approve", by: "via emailed link" });
    const pending = path.join(process.env.FOLDRUN_DATA!, "queue/pending");
    const jobs = fs.existsSync(pending) ? fs.readdirSync(pending).filter((f) => f.endsWith(".json")) : [];
    assert.equal(jobs.length, 1, "the worker that parked it gave its slot back; the decision must re-queue it");
    assert.equal(JSON.parse(fs.readFileSync(path.join(pending, jobs[0]), "utf8")).runId, "run-p");
  }));

// ----------------------------------------------------------- notification

/** A receiver that keeps the one body it is sent. */
async function receiver() {
  const received: { body?: string } = {};
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      received.body = body;
      res.writeHead(200).end("ok");
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  return { received, port, close: () => server.close() };
}

test("a parked run's notification carries its approve and reject links", async () => {
  const { received, port, close } = await receiver();
  try {
    await withWorkspace(
      async () => {
        process.env.FOLDRUN_PUBLIC_URL = "https://app.example.test/";
        const run = parkedRun("run-n");
        assert.equal(await sendRunNotification("acme", "desk", run), true);
        const payload = JSON.parse(received.body!);
        const token = approveToken("acme", "desk", "run-n");
        assert.equal(payload.approveUrl, `https://app.example.test/api/approve/acme/desk/run-n?token=${token}`);
        assert.equal(payload.rejectUrl, `${payload.approveUrl}&decision=reject`);
      },
      `---\nnotify:\n  url: http://127.0.0.1:${port}/hook\n  events: [failed, awaiting-approval]\n---\n`,
    );
  } finally {
    close();
  }
});

test("a failed run's notification has no links — there is nothing to decide", async () => {
  const { received, port, close } = await receiver();
  try {
    await withWorkspace(
      async () => {
        process.env.FOLDRUN_PUBLIC_URL = "https://app.example.test";
        const run = parkedRun("run-f", { status: "failed", finishedAt: new Date().toISOString() });
        run.steps[0].status = "failed";
        assert.equal(await sendRunNotification("acme", "desk", run), true);
        const payload = JSON.parse(received.body!);
        assert.equal(payload.approveUrl, undefined);
        assert.equal(payload.rejectUrl, undefined);
      },
      `---\nnotify:\n  url: http://127.0.0.1:${port}/hook\n  events: [failed, awaiting-approval]\n---\n`,
    );
  } finally {
    close();
  }
});

test("without FOLDRUN_PUBLIC_URL the notification still goes, minus the links", async () => {
  const { received, port, close } = await receiver();
  try {
    await withWorkspace(
      async () => {
        delete process.env.FOLDRUN_PUBLIC_URL;
        assert.equal(await sendRunNotification("acme", "desk", parkedRun("run-u")), true);
        const payload = JSON.parse(received.body!);
        assert.equal(payload.status, "awaiting-approval");
        assert.equal(payload.approveUrl, undefined);
      },
      `---\nnotify:\n  url: http://127.0.0.1:${port}/hook\n---\n`,
    );
  } finally {
    close();
  }
});
