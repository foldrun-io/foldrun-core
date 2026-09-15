// An emailed approval link decides one step, before a moment, once — and
// as somebody, when the flow names who may decide. The older run-bound
// link still decides, once, for a run that was already waiting.
//
//   node --test tests/approval-links.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { approveToken } from "../src/webhook.ts";
import {
  APPROVE_LINK_DEFAULT_TTL_MS,
  approveLinkPath,
  approveLinkToken,
  approveLinkTtlMs,
  checkApproveLink,
  decideApproval,
  readApproveLink,
} from "../src/approvals.ts";
import { readRun, writeRun, type RunRecord } from "../src/store.ts";

/** A tenant/workspace with one flow whose frontmatter is given. */
function withFlow(frontmatter: string, body: () => void | Promise<void>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-links-"));
  const previous = process.env.FOLDRUN_DATA;
  process.env.FOLDRUN_DATA = root;
  const done = () => {
    if (previous === undefined) delete process.env.FOLDRUN_DATA;
    else process.env.FOLDRUN_DATA = previous;
    fs.rmSync(root, { recursive: true, force: true });
  };
  try {
    const ws = path.join(root, "acme/workspaces/desk");
    fs.mkdirSync(path.join(ws, "flows"), { recursive: true });
    fs.writeFileSync(path.join(ws, "AGENTS.md"), "---\nname: desk\n---\n");
    fs.writeFileSync(path.join(ws, "flows", "publish.md"), `---\nname: publish\n${frontmatter}\n---\n\n1! [[writer]] — draft it\n2! [[sender]] — send it\n`);
    const out = body();
    if (out && typeof (out as Promise<void>).then === "function") return (out as Promise<void>).finally(done);
    done();
  } catch (err) {
    done();
    throw err;
  }
}

const step = (agent: string, status: "awaiting-approval" | "pending" | "completed") => ({
  agent,
  instruction: "do it",
  group: 1,
  optional: false,
  approve: true,
  status,
  events: [],
  result: null,
  costUsd: 0,
});

/** Two gates: the first waiting, the second not yet reached. */
const parked = (id: string, extra: Partial<RunRecord> = {}): RunRecord => ({
  id,
  flow: "publish",
  status: "awaiting-approval",
  startedAt: new Date().toISOString(),
  finishedAt: null,
  parkedAt: new Date().toISOString(),
  steps: [step("writer", "awaiting-approval"), step("sender", "pending")],
  ...extra,
});

const T = { tenant: "acme", ws: "desk" };
const soon = () => Date.now() + 60_000;

test("a step link round-trips: step, expiry, approver — and one flipped character is nothing", () =>
  withFlow("", () => {
    const token = approveLinkToken(T.tenant, T.ws, "run-1", { step: 1, expiresAt: soon(), approver: "Ops@Example.com" });
    const read = readApproveLink(T.tenant, T.ws, "run-1", token);
    assert.ok("link" in read && read.link.kind === "step");
    if ("link" in read && read.link.kind === "step") {
      assert.equal(read.link.step, 1);
      assert.equal(read.link.approver, "ops@example.com", "lower-cased, like approvers: is");
    }
    const anon = approveLinkToken(T.tenant, T.ws, "run-1", { step: 0, expiresAt: soon() });
    const readAnon = readApproveLink(T.tenant, T.ws, "run-1", anon);
    assert.ok("link" in readAnon && readAnon.link.kind === "step" && readAnon.link.approver === null);
    const flipped = token.slice(0, -1) + (token.at(-1) === "a" ? "b" : "a");
    assert.deepEqual(readApproveLink(T.tenant, T.ws, "run-1", flipped), { error: "invalid token", status: 401 });
    assert.equal(readApproveLink(T.tenant, T.ws, "run-2", token).status, 401, "bound to the run");
    assert.equal(readApproveLink(T.tenant, T.ws, "run-1", "").status, 401);
    // The step number is signed: editing it in the URL does not move the link.
    const moved = token.replace(/^1\./, "0.");
    assert.equal(readApproveLink(T.tenant, T.ws, "run-1", moved).status, 401);
    assert.match(approveLinkPath(T.tenant, T.ws, "run-1", { step: 0, expiresAt: soon() }), /^\/api\/approve\/acme\/desk\/run-1\?token=0\.\d+\.-\.[0-9a-f]{32}$/);
  }));

test("a link expires: a week by default, the flow's approve_within: when it has one", () =>
  withFlow("", () => {
    assert.equal(approveLinkTtlMs(null), APPROVE_LINK_DEFAULT_TTL_MS);
    assert.equal(approveLinkTtlMs({ approveWithin: 3600 }), 3_600_000);
    const at = Date.now() + 1000;
    const token = approveLinkToken(T.tenant, T.ws, "run-1", { step: 0, expiresAt: at });
    assert.ok("link" in readApproveLink(T.tenant, T.ws, "run-1", token, at - 1));
    const dead = readApproveLink(T.tenant, T.ws, "run-1", token, at);
    assert.equal(dead.status, 410);
    assert.match(dead.error ?? "", /expired/);
  }));

test("a step link decides its step and no other, and dies with it", () =>
  withFlow("", async () => {
    writeRun(T.tenant, T.ws, parked("run-s"));
    const forSecond = approveLinkToken(T.tenant, T.ws, "run-s", { step: 1, expiresAt: soon() });
    // The second gate is not waiting yet: its link decides nothing today.
    await assert.rejects(
      decideApproval(T.tenant, T.ws, "run-s", { decision: "approve", by: "via emailed link", link: forSecond }),
      (err: Error & { status?: number }) => err.status === 409,
    );
    const forFirst = approveLinkToken(T.tenant, T.ws, "run-s", { step: 0, expiresAt: soon() });
    const { steps } = await decideApproval(T.tenant, T.ws, "run-s", { decision: "approve", by: "via emailed link", link: forFirst });
    assert.deepEqual(steps, [0]);
    // Now the second gate opens. The first link — forwarded, bookmarked —
    // does not open it: not its step, and used besides.
    const run = readRun(T.tenant, T.ws, "run-s")!;
    run.steps[0].status = "completed";
    run.steps[1].status = "awaiting-approval";
    writeRun(T.tenant, T.ws, run);
    await assert.rejects(
      decideApproval(T.tenant, T.ws, "run-s", { decision: "approve", by: "via emailed link", link: forFirst }),
      (err: Error & { status?: number }) => err.status === 409 && /already used/.test(err.message),
    );
    const again = await decideApproval(T.tenant, T.ws, "run-s", { decision: "approve", by: "via emailed link", link: forSecond });
    assert.deepEqual(again.steps, [1]);
  }));

test("a link is single-use even when its step parks again", () =>
  withFlow("", async () => {
    writeRun(T.tenant, T.ws, parked("run-once"));
    const token = approveLinkToken(T.tenant, T.ws, "run-once", { step: 0, expiresAt: soon() });
    await decideApproval(T.tenant, T.ws, "run-once", { decision: "approve", by: "via emailed link", link: token });
    const run = readRun(T.tenant, T.ws, "run-once")!;
    run.steps[0].status = "awaiting-approval"; // a loop brought the gate back
    writeRun(T.tenant, T.ws, run);
    const check = checkApproveLink(T.tenant, T.ws, readRun(T.tenant, T.ws, "run-once")!, token);
    assert.ok(!check.ok && check.status === 409);
    // The record carries a digest, never the token.
    const raw = fs.readFileSync(path.join(process.env.FOLDRUN_DATA!, "acme/workspaces/desk/runs/run-once.json"), "utf8");
    assert.ok(!raw.includes(token));
    assert.ok(raw.includes("approvalLinksUsed"));
  }));

test("approvers: refuses an anonymous link and accepts one minted for a named approver", () =>
  withFlow("approvers: [ops@example.com]", async () => {
    writeRun(T.tenant, T.ws, parked("run-a"));
    const anon = approveLinkToken(T.tenant, T.ws, "run-a", { step: 0, expiresAt: soon() });
    const refused = checkApproveLink(T.tenant, T.ws, readRun(T.tenant, T.ws, "run-a")!, anon);
    assert.ok(!refused.ok && refused.status === 403 && /carries no identity/.test(refused.message));
    await assert.rejects(
      decideApproval(T.tenant, T.ws, "run-a", { decision: "approve", by: "via emailed link", link: anon }),
      (err: Error & { status?: number }) => err.status === 403,
    );
    const stranger = approveLinkToken(T.tenant, T.ws, "run-a", { step: 0, expiresAt: soon(), approver: "someone@else.test" });
    await assert.rejects(
      decideApproval(T.tenant, T.ws, "run-a", { decision: "approve", by: "via emailed link", link: stranger }),
      (err: Error & { status?: number }) => err.status === 403 && /approvers: list does not include you/.test(err.message),
    );
    const ops = approveLinkToken(T.tenant, T.ws, "run-a", { step: 0, expiresAt: soon(), approver: "ops@example.com" });
    const { steps } = await decideApproval(T.tenant, T.ws, "run-a", { decision: "approve", by: "via emailed link (ops@example.com)", link: ops });
    assert.deepEqual(steps, [0]);
    assert.equal(readRun(T.tenant, T.ws, "run-a")!.steps[0].status, "pending");
  }));

test("a named approver's link still cannot approve the run they started", () =>
  withFlow("approvers: [ops@example.com]", async () => {
    writeRun(T.tenant, T.ws, parked("run-self", { startedBy: "ops@example.com" }));
    const ops = approveLinkToken(T.tenant, T.ws, "run-self", { step: 0, expiresAt: soon(), approver: "ops@example.com" });
    await assert.rejects(
      decideApproval(T.tenant, T.ws, "run-self", { decision: "approve", by: "via emailed link", link: ops }),
      (err: Error & { status?: number }) => err.status === 403 && /you started this run/.test(err.message),
    );
    // Rejecting your own run needs no second person.
    const { steps } = await decideApproval(T.tenant, T.ws, "run-self", { decision: "reject", by: "via emailed link", link: ops });
    assert.deepEqual(steps, [0]);
  }));

test("the older run-bound link still decides a waiting run — once, and not after a week", () =>
  withFlow("", async () => {
    writeRun(T.tenant, T.ws, parked("run-old"));
    const legacy = approveToken(T.tenant, T.ws, "run-old");
    const read = readApproveLink(T.tenant, T.ws, "run-old", legacy);
    assert.ok("link" in read && read.link.kind === "run");
    const { steps } = await decideApproval(T.tenant, T.ws, "run-old", { decision: "approve", by: "via emailed link", link: legacy });
    assert.deepEqual(steps, [0]);
    // The second gate opens; the same mail must not open it.
    const run = readRun(T.tenant, T.ws, "run-old")!;
    run.steps[0].status = "completed";
    run.steps[1].status = "awaiting-approval";
    writeRun(T.tenant, T.ws, run);
    await assert.rejects(
      decideApproval(T.tenant, T.ws, "run-old", { decision: "approve", by: "via emailed link", link: legacy }),
      (err: Error & { status?: number }) => err.status === 409 && /already used/.test(err.message),
    );
    // And a run that has been waiting longer than a week: the link is dead.
    const stale = new Date(Date.now() - APPROVE_LINK_DEFAULT_TTL_MS - 1000).toISOString();
    writeRun(T.tenant, T.ws, parked("run-stale", { startedAt: stale, parkedAt: stale }));
    const check = checkApproveLink(T.tenant, T.ws, readRun(T.tenant, T.ws, "run-stale")!, approveToken(T.tenant, T.ws, "run-stale"));
    assert.ok(!check.ok && check.status === 410);
  }));

test("the older link is refused where approvers: are named — it carries no identity", () =>
  withFlow("approvers: [ops@example.com]", async () => {
    writeRun(T.tenant, T.ws, parked("run-named"));
    await assert.rejects(
      decideApproval(T.tenant, T.ws, "run-named", { decision: "approve", by: "via emailed link", link: approveToken(T.tenant, T.ws, "run-named") }),
      (err: Error & { status?: number }) => err.status === 403,
    );
  }));

test("a link never releases a wait: event step", () =>
  withFlow("", () => {
    const run = parked("run-ev");
    run.steps[0] = { ...run.steps[0], waitFor: "event" } as RunRecord["steps"][number];
    writeRun(T.tenant, T.ws, run);
    const check = checkApproveLink(T.tenant, T.ws, readRun(T.tenant, T.ws, "run-ev")!, approveLinkToken(T.tenant, T.ws, "run-ev", { step: 0, expiresAt: soon() }));
    assert.ok(check.ok && check.steps.length === 0);
  }));
