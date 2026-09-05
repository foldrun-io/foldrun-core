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

import { readRun, writeRun, type RunRecord } from "./store.ts";
import { platform } from "./platform.ts";

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

  const waiting = run.steps
    .map((s, i) => ({ s, i }))
    .filter(({ s, i }) => s.status === "awaiting-approval" && (d.step === undefined || d.step === i));
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
