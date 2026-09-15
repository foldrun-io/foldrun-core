// Deciding a run parked at an approval gate.
//
// The run record is the queue: the orchestrator polls it, so flipping a step
// from awaiting-approval to pending (approve) or failed (reject) is the whole
// decision. Nothing in memory has to survive a restart.
//
// Two doors lead here — the dashboard's approve button and the link in a
// notification email — and they must do exactly the same thing to the record,
// or a run approved from a phone would resume differently from one approved
// at a desk. So the decision lives in core and the routes only say who made
// it.

import crypto from "node:crypto";
import { readRun, writeRun, readFlow, mayApprove, type FlowInfo, type RunRecord } from "./store.ts";
import { platform } from "./platform.ts";
import { approveToken, installKey } from "./webhook.ts";

export interface ApprovalDecision {
  decision: "approve" | "reject";
  /** Guidance for the step being approved — rides the record into its prompt. */
  note?: string;
  /** Why a rejection, for the trace. Falls back to `note`, since a form has one box. */
  reason?: string;
  /** Decide only this step index; otherwise every step that is waiting. */
  step?: number;
  /** Who decided, as it reads after the verb: "by a human", "via emailed link". */
  by: string;
  /**
   * The person behind the decision, when a session made it: their email and
   * the role they hold. A link and an external event have neither, and are
   * checked by their token instead — the token IS the authority there.
   *
   * Two rules read this. `approvers:` in the flow file names who may decide
   * that flow's gates at all. And nobody approves a run they started
   * themselves: a gate exists so that a second person looks, and a flow a
   * person kicked off and then waved through is a gate that never happened.
   */
  actor?: { email?: string | null; role?: string | null } | null;
  /**
   * The emailed link's token, when a link is deciding. Read here rather
   * than trusted from the route, because what a link may decide is policy:
   * the step it was minted for, before it expires, once, and never a gate
   * whose flow names its approvers unless the link was minted for one of
   * them. See readApproveLink.
   */
  link?: string;
}

// ----------------------------------------------------------------- links

/** How long an emailed link decides for when the flow does not say. */
export const APPROVE_LINK_DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** What a link may decide: one step, until a moment, as somebody or as
 *  nobody. A `run` link is the older kind — bound to the run alone, and
 *  kept working, once, for runs that were already waiting when this
 *  changed. */
export type ApproveLink =
  | { kind: "step"; step: number; expiresAt: string; approver: string | null }
  | { kind: "run" };

/** The link's lifetime: the flow's `approve_within:` when it has one —
 *  after that the gate has expired on its own — else a week. */
export function approveLinkTtlMs(flow: Pick<FlowInfo, "approveWithin"> | null | undefined): number {
  return flow?.approveWithin ? flow.approveWithin * 1000 : APPROVE_LINK_DEFAULT_TTL_MS;
}

const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64url");
const unb64 = (s: string) => Buffer.from(s, "base64url").toString("utf8");

function signLink(tenant: string, workspace: string, runId: string, step: number, expires: number, approver: string): string {
  return crypto
    .createHmac("sha256", installKey())
    .update(`approve-link:${tenant}/${workspace}/${runId}/${step}/${expires}/${approver}`)
    .digest("hex")
    .slice(0, 32);
}

/**
 * The token an emailed link carries. Bound to one step of one run and to
 * a moment, and — when the notification went to a named approver — to
 * that person, so the link decides as them. A link that was only bound
 * to the run approved every later gate of that run for as long as it ran,
 * and a forwarded one let anyone past `approvers:`.
 *
 * `step.expires.approver.signature`; the signature covers all of it plus
 * the run's identity, under the install key, so rotating the key kills
 * every link at once, the way it kills every hook.
 */
export function approveLinkToken(
  tenant: string,
  workspace: string,
  runId: string,
  link: { step: number; expiresAt: number; approver?: string | null },
): string {
  const approver = (link.approver ?? "").trim().toLowerCase();
  const expires = Math.floor(link.expiresAt);
  return `${link.step}.${expires}.${approver ? b64(approver) : "-"}.${signLink(tenant, workspace, runId, link.step, expires, approver)}`;
}

/** The path an emailed link opens — absolute when the caller prefixes the
 *  install's public origin. `decision=reject` pre-selects; a GET never
 *  decides. */
export function approveLinkPath(
  tenant: string,
  workspace: string,
  runId: string,
  link: { step: number; expiresAt: number; approver?: string | null },
): string {
  return `/api/approve/${tenant}/${workspace}/${runId}?token=${approveLinkToken(tenant, workspace, runId, link)}`;
}

const same = (a: string, b: string) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));

/**
 * What a presented token is, or why it is nothing. 401 for a token that
 * was never minted for this run, 410 for one that was and has expired —
 * the second deserves a sentence, because the person holding it did
 * nothing wrong.
 */
export function readApproveLink(
  tenant: string,
  workspace: string,
  runId: string,
  presented: string,
  now = Date.now(),
): { link: ApproveLink } | { error: string; status: 401 | 410 } {
  const invalid = { error: "invalid token", status: 401 as const };
  if (!presented) return invalid;
  const parts = presented.split(".");
  if (parts.length === 4) {
    const [stepText, expText, approverText, sig] = parts;
    if (!/^\d+$/.test(stepText) || !/^\d+$/.test(expText)) return invalid;
    let approver = "";
    try {
      approver = approverText === "-" ? "" : unb64(approverText);
    } catch {
      return invalid;
    }
    const step = Number(stepText);
    const expires = Number(expText);
    if (!same(sig, signLink(tenant, workspace, runId, step, expires, approver))) return invalid;
    if (now >= expires) return { error: "this link has expired — open the run in the dashboard to decide it", status: 410 };
    return { link: { kind: "step", step, expiresAt: new Date(expires).toISOString(), approver: approver || null } };
  }
  if (same(presented, approveToken(tenant, workspace, runId))) return { link: { kind: "run" } };
  return invalid;
}

/** A used link is written on the run as a digest, never the token. */
const linkDigest = (token: string) => crypto.createHash("sha256").update(token).digest("hex").slice(0, 24);

/**
 * Everything a link has to pass before it decides anything, answered the
 * same way for the page that shows the gate and the POST that decides it.
 * Returns which waiting steps the link may decide and who it decides as.
 */
export function checkApproveLink(
  tenant: string,
  workspace: string,
  run: RunRecord,
  presented: string,
  now = Date.now(),
): { ok: true; link: ApproveLink; steps: number[]; approver: string | null } | { ok: false; status: number; message: string } {
  const read = readApproveLink(tenant, workspace, run.id, presented, now);
  if ("error" in read) return { ok: false, status: read.status, message: read.error };
  const { link } = read;
  if (run.approvalLinksUsed?.includes(linkDigest(presented))) {
    return { ok: false, status: 409, message: "this link was already used — a link decides once" };
  }
  // The older, run-bound link: kept for runs already waiting, but not for
  // longer than a new link would have been.
  if (link.kind === "run") {
    const since = Date.parse(run.parkedAt ?? run.startedAt);
    if (Number.isFinite(since) && now - since > APPROVE_LINK_DEFAULT_TTL_MS) {
      return { ok: false, status: 410, message: "this link has expired — open the run in the dashboard to decide it" };
    }
  }
  const waiting = run.steps
    .map((s, i) => ({ s, i }))
    .filter(({ s, i }) => s.status === "awaiting-approval" && s.waitFor !== "event" && (link.kind === "run" || i === link.step))
    .map(({ i }) => i);
  const approver = link.kind === "step" ? link.approver : null;
  // A flow that names its approvers is asking for a person; a link is a
  // possession. Only a link minted for one of the named approvers carries
  // enough of an identity to be checked against the list.
  const flow = readFlow(tenant, workspace, run.flow);
  if (flow?.approvers?.length && !approver) {
    return {
      ok: false,
      status: 403,
      message: `this flow names who may approve it (${flow.approvers.join(", ")}), and an emailed link carries no identity — sign in to the dashboard to decide it`,
    };
  }
  return { ok: true, link, steps: waiting, approver };
}

/** An error the HTTP layer can map straight to a status — see errorResponse. */
class ApprovalError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

/**
 * Apply a decision to every step the run is waiting on, and line the run up
 * again if a worker had parked it. Returns the record as written and which
 * step indexes were decided.
 *
 * Throws with `status` 404 when the run does not exist and 409 when nothing
 * is waiting — an emailed link is clicked twice, or after someone else
 * already answered, and the second click must not be reported as success.
 */
export async function decideApproval(
  tenant: string,
  workspace: string,
  runId: string,
  d: ApprovalDecision,
): Promise<{ run: RunRecord; steps: number[] }> {
  const run = readRun(tenant, workspace, runId);
  if (!run) throw new ApprovalError("run not found", 404);

  // A link decides what it was minted for, as whom it was minted for.
  let allowed: number[] | null = null;
  if (d.link !== undefined) {
    const check = checkApproveLink(tenant, workspace, run, d.link);
    if (!check.ok) throw new ApprovalError(check.message, check.status);
    allowed = check.steps;
    d = { ...d, actor: check.approver ? { email: check.approver, role: null } : null };
  }
  assertMayDecide(tenant, workspace, run, d);

  const waiting = run.steps
    .map((s, i) => ({ s, i }))
    .filter(({ s, i }) => s.status === "awaiting-approval" && (d.step === undefined || d.step === i) && (allowed === null || allowed.includes(i)));
  if (waiting.length === 0) throw new ApprovalError("nothing is awaiting approval", 409);

  const note = typeof d.note === "string" ? d.note.trim() : "";
  const reason = (typeof d.reason === "string" ? d.reason.trim() : "") || note;
  const now = new Date().toISOString();

  for (const { s } of waiting) {
    s.status = d.decision === "approve" ? "pending" : "failed";
    // Record the decision itself, not just its effect on status. `pending`
    // is also what a step looks like before anyone was asked, so without
    // this a run that was approved and then interrupted comes back asking
    // the same person the same question.
    if (d.decision === "approve") {
      s.approvedAt = now;
      // An approval can carry guidance — it rides the step record into the
      // prompt (see runner.ts), so "yes, but…" is one gesture, not a yes
      // followed by a chase.
      if (note) s.approvalNote = note.slice(0, 4000);
    }
    s.events.push({
      t: now,
      type: d.decision === "approve" ? "info" : "error",
      text:
        d.decision === "approve"
          ? `approved ${d.by} — continuing${note ? ` (with guidance: ${note.slice(0, 200)})` : ""}`
          : `rejected ${d.by}${reason ? `: ${reason.slice(0, 200)}` : ""}`,
    });
  }
  // The deadline belonged to the gate that just closed. Leaving it on the
  // record would hand a later gate in the same run a deadline that has
  // already passed.
  if (run.steps.every((s) => s.status !== "awaiting-approval")) run.approveBy = null;
  // A link decides once. Written as a digest on the record, so a step that
  // parks again — a loop, a rerun from the gate — is not decided by the
  // same forwarded mail.
  if (d.link !== undefined) {
    run.approvalLinksUsed = [...(run.approvalLinksUsed ?? []), linkDigest(d.link)].slice(-50);
  }
  writeRun(tenant, workspace, run);

  // A parked run has no process polling for this decision — the worker
  // that was driving it gave its slot back at the gate. Line it up again.
  // Runs without the marker still have their starter polling the file, and
  // enqueueing those too would put two drivers on one record.
  if (run.parkedAt && run.steps.every((s) => s.status !== "awaiting-approval")) {
    await platform.enqueueResume(tenant, workspace, run.id);
  }

  return { run, steps: waiting.map(({ i }) => i) };
}

/**
 * The two rules a person's decision has to pass. A token-bearing door — the
 * emailed link, an external event — carries no actor and is not checked
 * here: possession of a token derived from the run is its own authority,
 * and the link was mailed to whoever the account told us to ask.
 *
 * Throws 403, which the routes surface verbatim: a refusal that does not say
 * which rule refused sends someone to the wrong settings page.
 */
function assertMayDecide(tenant: string, workspace: string, run: RunRecord, d: ApprovalDecision): void {
  if (!d.actor) return;
  const email = (d.actor.email ?? "").trim().toLowerCase();
  // Rejecting your own run is always allowed: stopping something you started
  // needs no second opinion, and the gate's whole purpose is that it does
  // not proceed. Only approval needs someone else.
  if (d.decision === "approve" && email && run.startedBy && run.startedBy === email) {
    throw new ApprovalError(
      "you started this run — an approval gate asks a second person, so someone else has to answer it",
      403,
    );
  }
  const flow = readFlow(tenant, workspace, run.flow);
  if (!mayApprove(flow, d.actor)) {
    throw new ApprovalError(
      `this flow's approvers: list does not include you (${flow?.approvers?.join(", ")})`,
      403,
    );
  }
}

/**
 * A gate that ran out of time. `approve_within:` in the flow file stamps a
 * deadline when the run parks; past it, the gate is rejected and the run
 * fails, exactly as if a person had said no.
 *
 * Rejection, not approval, is the only safe way for a clock to answer a
 * question a person was asked. The whole reason the step is parked is that
 * someone wanted to look at it first.
 *
 * Returns whether it acted. Called from the same sweep that closes abandoned
 * runs, so an expiry needs nothing running of its own.
 */
export async function expireStaleGate(
  tenant: string,
  workspace: string,
  run: RunRecord,
  now = Date.now(),
): Promise<boolean> {
  if (run.status !== "awaiting-approval" || !run.approveBy) return false;
  if (now < new Date(run.approveBy).getTime()) return false;
  // A step waiting on `wait: event` is not waiting on a person and is not
  // this deadline's business.
  if (!run.steps.some((s) => s.status === "awaiting-approval" && s.waitFor !== "event")) return false;
  await decideApproval(tenant, workspace, run.id, {
    decision: "reject",
    by: "automatically — nobody answered in time",
    reason: `no decision within the flow's approve_within: (due ${run.approveBy})`,
  });
  return true;
}

/**
 * Release a run parked on `wait: event` with what arrived. The payload is
 * stored on the step — not as an approval note, which is a person's
 * guidance and capped as such — and the release itself is an approval
 * "by an external event", so the record reads the same way whichever door
 * a park was opened through.
 *
 * Only steps waiting on an event are released: a run that is also asking a
 * person a question keeps asking.
 */
export async function deliverEvent(
  tenant: string,
  workspace: string,
  runId: string,
  payload: string,
): Promise<{ run: RunRecord; steps: number[] }> {
  const run = readRun(tenant, workspace, runId);
  if (!run) throw new ApprovalError("run not found", 404);
  const waiting = run.steps
    .map((s, i) => ({ s, i }))
    .filter(({ s }) => s.status === "awaiting-approval" && s.waitFor === "event");
  if (waiting.length === 0) throw new ApprovalError("this run is not waiting for an event", 409);
  for (const { s } of waiting) s.eventPayload = payload.slice(0, 20_000);
  writeRun(tenant, workspace, run);
  let decided: number[] = [];
  for (const { i } of waiting) {
    const out = await decideApproval(tenant, workspace, runId, { decision: "approve", step: i, by: "by an external event" });
    decided = decided.concat(out.steps);
  }
  return { run: readRun(tenant, workspace, runId) ?? run, steps: decided };
}
