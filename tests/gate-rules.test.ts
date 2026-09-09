// Who may answer a gate, and what happens when nobody does.
//
//   node --test tests/gate-rules.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { decideApproval, expireStaleGate } from "../src/approvals.ts";
import { resetPlatform } from "../src/platform.ts";
import { readRun, writeRun, type RunRecord } from "../src/store.ts";

/** A workspace on disk holding one flow file, core pointed at it. */
function withFlow(frontmatter: string, body: () => Promise<void> | void): Promise<void> | void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-gate-"));
  const previous = process.env.FOLDRUN_DATA;
  process.env.FOLDRUN_DATA = root;
  const done = () => {
    if (previous === undefined) delete process.env.FOLDRUN_DATA;
    else process.env.FOLDRUN_DATA = previous;
    resetPlatform();
    fs.rmSync(root, { recursive: true, force: true });
  };
  try {
    const ws = path.join(root, "acme/workspaces/desk");
    fs.mkdirSync(path.join(ws, "flows"), { recursive: true });
    fs.mkdirSync(path.join(ws, "runs"), { recursive: true });
    fs.writeFileSync(path.join(ws, "AGENTS.md"), "---\nname: desk\n---\n");
    fs.writeFileSync(
      path.join(ws, "flows", "publish.md"),
      `---\nname: publish\n${frontmatter}\n---\n\n1! [[writer]] — draft it\n`,
    );
    const out = body();
    if (out && typeof (out as Promise<void>).then === "function") return (out as Promise<void>).finally(done);
    done();
  } catch (err) {
    done();
    throw err;
  }
}

function park(extra: Partial<RunRecord> = {}): RunRecord {
  const run: RunRecord = {
    id: "run-1",
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
        status: "awaiting-approval",
        events: [],
        result: null,
        costUsd: 0,
      },
    ],
    ...extra,
  };
  writeRun("acme", "desk", run);
  return run;
}

const rejects = async (fn: () => Promise<unknown>, match: RegExp) => {
  await assert.rejects(fn, (err: Error & { status?: number }) => {
    assert.equal(err.status, 403, "a refusal a person can act on is a 403, not a 500");
    assert.match(err.message, match);
    return true;
  });
};

// ------------------------------------------------------- self-approval

test("nobody approves the run they started", () =>
  withFlow("description: plain", async () => {
    park({ startedBy: "matt@example.com" });
    await rejects(
      () =>
        decideApproval("acme", "desk", "run-1", {
          decision: "approve",
          by: "by a human",
          actor: { email: "matt@example.com", role: "owner" },
        }),
      /you started this run/,
    );
  }));

test("someone else approves it fine", () =>
  withFlow("description: plain", async () => {
    park({ startedBy: "matt@example.com" });
    const { steps } = await decideApproval("acme", "desk", "run-1", {
      decision: "approve",
      by: "by a human",
      actor: { email: "sam@example.com", role: "editor" },
    });
    assert.deepEqual(steps, [0]);
    assert.equal(readRun("acme", "desk", "run-1")!.steps[0].status, "pending");
  }));

test("rejecting your own run is always allowed — stopping needs no second opinion", () =>
  withFlow("description: plain", async () => {
    park({ startedBy: "matt@example.com" });
    const { steps } = await decideApproval("acme", "desk", "run-1", {
      decision: "reject",
      by: "by a human",
      actor: { email: "matt@example.com", role: "owner" },
    });
    assert.deepEqual(steps, [0]);
    assert.equal(readRun("acme", "desk", "run-1")!.steps[0].status, "failed");
  }));

test("a run nobody started — a schedule's — is approvable by anyone", () =>
  withFlow("description: plain", async () => {
    park();
    const { steps } = await decideApproval("acme", "desk", "run-1", {
      decision: "approve",
      by: "by a human",
      actor: { email: "matt@example.com", role: "owner" },
    });
    assert.deepEqual(steps, [0]);
  }));

// ---------------------------------------------------------- approvers:

test("approvers: refuses someone not on the list, and says who is", () =>
  withFlow("approvers: [ops@example.com]", async () => {
    park();
    await rejects(
      () =>
        decideApproval("acme", "desk", "run-1", {
          decision: "approve",
          by: "by a human",
          actor: { email: "someone@else.com", role: "owner" },
        }),
      /approvers: list does not include you \(ops@example\.com\)/,
    );
  }));

test("a token-bearing door carries no actor and is not checked against the list", () =>
  withFlow("approvers: [ops@example.com]", async () => {
    // The emailed link and an external event have no session. The token is
    // the authority there, and it was mailed to whoever the account said.
    park({ startedBy: "matt@example.com" });
    const { steps } = await decideApproval("acme", "desk", "run-1", {
      decision: "approve",
      by: "via emailed link",
    });
    assert.deepEqual(steps, [0]);
  }));

// ------------------------------------------------------ approve_within:

test("a gate past its deadline is rejected, not approved", () =>
  withFlow("approve_within: 1d", async () => {
    const run = park({ approveBy: new Date(Date.now() - 60_000).toISOString() });
    assert.equal(await expireStaleGate("acme", "desk", run), true);
    const after = readRun("acme", "desk", "run-1")!;
    assert.equal(after.steps[0].status, "failed", "a clock may only ever answer no");
    assert.match(after.steps[0].events.at(-1)!.text, /nobody answered in time/);
  }));

test("a gate inside its deadline is left alone", () =>
  withFlow("approve_within: 1d", async () => {
    const run = park({ approveBy: new Date(Date.now() + 3600_000).toISOString() });
    assert.equal(await expireStaleGate("acme", "desk", run), false);
    assert.equal(readRun("acme", "desk", "run-1")!.steps[0].status, "awaiting-approval");
  }));

test("a gate with no deadline waits forever, which stays the default", () =>
  withFlow("description: plain", async () => {
    const run = park();
    assert.equal(await expireStaleGate("acme", "desk", run), false);
  }));

test("a step waiting on an external event is not a person's deadline to miss", () =>
  withFlow("approve_within: 1d", async () => {
    const run = park({ approveBy: new Date(Date.now() - 60_000).toISOString() });
    run.steps[0].waitFor = "event";
    writeRun("acme", "desk", run);
    assert.equal(await expireStaleGate("acme", "desk", run), false);
  }));

test("a decided gate leaves no deadline behind for the next one", () =>
  withFlow("approve_within: 1d", async () => {
    park({ approveBy: new Date(Date.now() + 3600_000).toISOString() });
    await decideApproval("acme", "desk", "run-1", { decision: "approve", by: "by a human" });
    assert.equal(readRun("acme", "desk", "run-1")!.approveBy, null);
  }));
