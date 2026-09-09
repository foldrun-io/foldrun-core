// Why nothing happened.
//
// A run that exists can be read. A run that does not exist leaves no record
// anywhere, and "the hook fired but nothing ran" is the hardest question the
// platform gets asked — because every honest answer to it is a thing that
// deliberately did NOT happen:
//
//   the delivery was a duplicate          idempotency:
//   the burst is still being waited out   debounce:
//   it arrived inside the window          throttle:
//   the flow is switched off              disable_after:
//   yesterday's run is still going        overlap: skip
//   the platform was down at 05:00        catchup: none
//
// Six different reasons, all of them correct behaviour, none of them visible.
// Before this they were console lines on a box nobody reads.
//
// This is deliberately NOT the hook delivery log next door. That one answers
// "did the request reach us and was it authentic" — a bad token, a failed
// signature. This one answers "did an event become a run". A delivery can be
// perfectly authentic and still not start anything, which is exactly the
// case that needed writing down.
//
// One bounded JSONL per workspace, the same shape and the same compaction as
// the delivery log: this is diagnostics, not an audit trail, and it must
// never become a disk-full incident with a delay.

import fs from "node:fs";
import path from "node:path";
import { workspaceDir } from "./store.ts";

/** What became of one trigger firing. `started` is here too: without it the
 *  log answers "why did nothing run" and not "how often does anything",
 *  and the ratio is the whole point of the page. */
export type TriggerOutcome =
  | "started"
  | "duplicate"
  | "throttled"
  | "debounced"
  | "quarantined"
  | "overlap-skipped"
  | "missed"
  | "failed";

export interface TriggerEvent {
  t: string;
  flow: string;
  /** The flow's `trigger:` — schedule, webhook, storage, watch, flow, email. */
  trigger: string;
  outcome: TriggerOutcome;
  /** The sentence a person reads. Always says which key decided, so the fix
   *  is one search away in their own flow file. */
  detail?: string;
  runId?: string;
}

function logFile(tenant: string, workspace: string) {
  return path.join(workspaceDir(tenant, workspace), "trigger-log.jsonl");
}

const KEEP = 500;

/** Never throws. A diagnostic that can break a trigger is worse than no
 *  diagnostic: the whole point is to be reading it on the bad morning. */
export function recordTriggerEvent(tenant: string, workspace: string, event: TriggerEvent): void {
  try {
    const file = logFile(tenant, workspace);
    if (!fs.existsSync(path.dirname(file))) return;
    fs.appendFileSync(file, JSON.stringify(event) + "\n");
    const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
    if (lines.length > KEEP * 2) {
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, lines.slice(-KEEP).join("\n") + "\n");
      fs.renameSync(tmp, file);
    }
  } catch {
    // best effort, always
  }
}

export function readTriggerEvents(tenant: string, workspace: string, limit = 200): TriggerEvent[] {
  let lines: string[];
  try {
    lines = fs.readFileSync(logFile(tenant, workspace), "utf8").split("\n").filter(Boolean);
  } catch {
    return [];
  }
  // One line at a time: a torn line — an append racing a compaction from
  // another pod — must lose that line, not the whole log, on exactly the
  // morning the log exists for.
  const out: TriggerEvent[] = [];
  for (const line of lines.slice(-limit).reverse()) {
    try {
      const e = JSON.parse(line) as TriggerEvent;
      if (e && typeof e.t === "string") out.push(e);
    } catch {
      // skip the torn line
    }
  }
  return out;
}

export interface FlowTriggerSummary {
  flow: string;
  trigger: string;
  fired: number;
  started: number;
  /** Every outcome that was not a start, by reason, biggest first. */
  dropped: { outcome: TriggerOutcome; count: number; detail: string }[];
  lastFiredAt: string | null;
  lastStartedAt: string | null;
}

/**
 * One row per flow: how often it fired, how often that became a run, and
 * what happened to the difference.
 *
 * The gap between `fired` and `started` is the number someone is looking
 * for. A flow with forty fires and two runs is either working exactly as
 * configured or badly misconfigured, and the reasons column is what tells
 * those apart without opening the flow file.
 */
export function summariseTriggers(
  tenant: string,
  workspace: string,
  sinceMs: number | null = null,
): FlowTriggerSummary[] {
  const rows = new Map<string, FlowTriggerSummary>();
  const reasons = new Map<string, Map<TriggerOutcome, { count: number; detail: string }>>();
  for (const e of readTriggerEvents(tenant, workspace, 500)) {
    if (sinceMs !== null && new Date(e.t).getTime() < sinceMs) continue;
    let row = rows.get(e.flow);
    if (!row) {
      row = { flow: e.flow, trigger: e.trigger, fired: 0, started: 0, dropped: [], lastFiredAt: null, lastStartedAt: null };
      rows.set(e.flow, row);
      reasons.set(e.flow, new Map());
    }
    row.fired++;
    // Events come back newest first, so the first of each is the latest.
    row.lastFiredAt ??= e.t;
    if (e.outcome === "started") {
      row.started++;
      row.lastStartedAt ??= e.t;
    } else {
      const byReason = reasons.get(e.flow)!;
      const seen = byReason.get(e.outcome);
      // Keep the newest detail: "the last run started 4 minutes ago" is more
      // use than the same sentence from Tuesday.
      if (seen) seen.count++;
      else byReason.set(e.outcome, { count: 1, detail: e.detail ?? "" });
    }
  }
  for (const [flow, byReason] of reasons) {
    rows.get(flow)!.dropped = [...byReason.entries()]
      .map(([outcome, v]) => ({ outcome, ...v }))
      .sort((a, b) => b.count - a.count);
  }
  return [...rows.values()].sort((a, b) => b.fired - a.fired || a.flow.localeCompare(b.flow));
}
