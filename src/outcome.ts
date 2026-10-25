// A run's outcome, and the one way every surface counts outcomes (FOL-54).
//
// A run is read on three separate lines, never folded into one "success":
//   · execution — did it run to the end without failing? (completed, failed,
//     stopped by a person, or still live)
//   · result    — what the work concluded: GOOD, QUIET, BLOCKED, BAD, or
//     nothing said (done)
//   · action    — does a person need to do something? (an approval or a
//     question waiting, a failure, a BLOCKED, a BAD finding)
//
// Before this, five surfaces computed five different "success rates" (one
// counted BAD as success, one counted stopped runs as failures, …), so the
// same desk read four different percentages. Every page, the API and the
// CLI now read `tally()`. Pure: no node imports, so the browser can use it.

export type Outcome = "running" | "queued" | "waiting" | "good" | "done" | "quiet" | "blocked" | "bad" | "failed" | "stopped";

export const OUTCOMES: readonly Outcome[] = ["running", "queued", "waiting", "good", "done", "quiet", "blocked", "bad", "failed", "stopped"];

/** From the display status (store.runDisplayStatus) and the verdict (store.runVerdict). */
export function outcomeOf(status: string, verdict: string | null | undefined): Outcome {
  if (status === "running") return "running";
  if (status === "queued") return "queued";
  if (status === "awaiting-approval") return "waiting";
  if (status === "stopped") return "stopped";
  if (status === "failed") return "failed";
  switch (verdict) {
    case "GOOD": return "good";
    case "QUIET": return "quiet";
    case "BLOCKED": return "blocked";
    case "BAD": return "bad";
    default: return "done";
  }
}

/** Still going: not an outcome yet. */
export const isLive = (o: Outcome) => o === "running" || o === "queued" || o === "waiting";
/** Ran to the end without failing — whatever it found. */
export const isCompleted = (o: Outcome) => o === "good" || o === "done" || o === "quiet" || o === "blocked" || o === "bad";
/** Over and countable for a rate: completed or failed. A run a person stopped is left out. */
export const isFinished = (o: Outcome) => isCompleted(o) || o === "failed";
/** Went wrong or found something wrong: failed, BAD, BLOCKED. */
export const needsAttention = (o: Outcome) => o === "failed" || o === "bad" || o === "blocked";
/** A person has something to do: what needsAttention says, and a run
 *  waiting on an approval or an answer (Codex review). */
export const needsAction = (o: Outcome) => needsAttention(o) || o === "waiting";
/** Completed and reported nothing wrong (GOOD, QUIET, or nothing said). */
export const isSuccess = (o: Outcome) => o === "good" || o === "done" || o === "quiet";

export interface Tally {
  /** Every run counted, live ones included. */
  runs: number;
  /** Running, queued, or waiting on a person. */
  live: number;
  /** Waiting on an approval or an answer. */
  waiting: number;
  stopped: number;
  /** Completed + failed: the runs a rate is taken over. */
  finished: number;
  /** Ran to the end without failing. */
  completed: number;
  failed: number;
  /** What the completed runs found. */
  ok: number;
  quiet: number;
  blocked: number;
  bad: number;
  /** completed / finished, as a whole percent; null with nothing finished. */
  completedPct: number | null;
}

/** The one count of a set of outcomes that every surface shows. */
export function tally(outcomes: Iterable<Outcome>): Tally {
  const t: Tally = { runs: 0, live: 0, waiting: 0, stopped: 0, finished: 0, completed: 0, failed: 0, ok: 0, quiet: 0, blocked: 0, bad: 0, completedPct: null };
  for (const o of outcomes) {
    t.runs++;
    if (isLive(o)) t.live++;
    if (o === "waiting") t.waiting++;
    if (o === "stopped") t.stopped++;
    if (isFinished(o)) t.finished++;
    if (isCompleted(o)) t.completed++;
    if (o === "failed") t.failed++;
    if (o === "good" || o === "done") t.ok++;
    if (o === "quiet") t.quiet++;
    if (o === "blocked") t.blocked++;
    if (o === "bad") t.bad++;
  }
  t.completedPct = t.finished ? Math.round((100 * t.completed) / t.finished) : null;
  return t;
}
