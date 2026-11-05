// Where a step's start-up went, phase by phase (FOL-29), read the same way
// by every surface that shows it: the platform's Observe report (and through
// its API the CLI's `foldrun observe`) and the run page's start-up chip.
//
// Pure and import-free, so the dashboard can load it in the browser.

/**
 * The start-up of one step, in the order it happens. Each is the moment the
 * phase ENDED, in ms since the executor began the step (seconds on the step
 * record), so the gap between two neighbours is what the later one cost
 * (FOL-29: "pod ready" was the only number, and the six seconds after it had
 * no names).
 *
 * The executor marks its own: `services` (the account's search/browser pods
 * up), `room` (room on the cluster to start — platform pod-room.ts),
 * `applied` (pod created), `ready`, `files` (the workspace copied in),
 * `go` (the step released). The sandbox marks the rest as `{"e":"mark"}`
 * lines: `shim` (the shim saw go), `system` (system packages restored),
 * `driver` (node up), `imports` (core loaded), `tools` (runtime and tools
 * built, the SDK about to start) and `model` (the model's first text or tool
 * call). A worker that predates a mark ignores the line — parseDriverLine
 * answers null for an `e` it does not know.
 *
 * `services` is the one phase that may not be in line: since FOL-46 the
 * account's search and browser pods boot ALONGSIDE the step pod, and `go`
 * waits for both. See startupBreakdown.
 */
export const STARTUP_PHASES = [
  "services", "room", "applied", "ready", "files", "go",
  "shim", "system", "driver", "imports", "tools", "model",
] as const;
export type StartupPhase = (typeof STARTUP_PHASES)[number];
export type StartupPhases = Partial<Record<StartupPhase, number>>;

/** One phase of one step's start-up, placed on its lane. */
export interface StartupSpan {
  phase: StartupPhase;
  /** When the phase could begin, counted from the step's start. */
  from: number;
  /** When it ended — the mark itself. */
  at: number;
  /** Its own share: `at − from`, never negative. */
  took: number;
  /** It ran alongside the step pod's own phases rather than before them —
   *  `services` on a run whose search or browser pod was still booting
   *  when the step pod was up (FOL-46). */
  parallel: boolean;
  /** How long this phase sat ready to start but held back by a parallel
   *  lane — `go` behind a `services` that was still booting. 0 otherwise. */
  waited: number;
}

/**
 * A step's start-up marks as spans, overlap-aware (FOL-74).
 *
 * Every phase but `services` runs in line: each starts when the one marked
 * before it ended. `services` either comes first — no services, or ones
 * awaited before the step pod was asked for, and its mark lands before the
 * pod's first — or, when it was marked after the pod's first phase, it ran in
 * parallel from the step's start: its span is 0 → its mark, the pod's lane
 * starts at 0 as well, and `go` (which the gate holds until every service is
 * up) starts at the later of the two lanes, the difference being `waited`.
 * (The executor re-marks `services` at the gate and keeps no earlier mark,
 * so on such a run the staging before the pod is asked for falls in the
 * pod lane's first phase, usually `room`, rather than in `services`.)
 *
 * Subtracting neighbours in STARTUP_PHASES order instead gave the overlapped
 * run's `services` the pod's boot as well, and every phase it overlapped
 * +0.00s. Missing and non-finite marks are skipped; a later mark that reads
 * earlier than the one before it (two clocks) takes 0, never a negative.
 */
export function startupBreakdown(marks: Record<string, unknown> | null | undefined): StartupSpan[] {
  if (!marks || typeof marks !== "object") return [];
  const at = (p: StartupPhase): number | null => {
    const v = marks[p];
    return typeof v === "number" && Number.isFinite(v) ? v : null;
  };
  const services = at("services");
  const firstInLine = STARTUP_PHASES.find((p) => p !== "services" && at(p) !== null);
  const parallel = services !== null && firstInLine !== undefined && services > at(firstInLine)!;

  const spans: StartupSpan[] = [];
  // Where the step pod's lane has got to. A services phase in line is the
  // first thing on it; one in parallel leaves it at the step's start.
  let lane = 0;
  for (const phase of STARTUP_PHASES) {
    const end = at(phase);
    if (end === null) continue;
    if (phase === "services") {
      spans.push({ phase, from: 0, at: end, took: Math.max(0, end), parallel, waited: 0 });
      if (!parallel) lane = Math.max(lane, end);
      continue;
    }
    let from = lane;
    let waited = 0;
    // `go` is released only once every service is up: on an overlapped run
    // it starts when the later of the two lanes did.
    if (phase === "go" && parallel && services! > lane) {
      waited = services! - lane;
      from = services!;
    }
    spans.push({ phase, from, at: end, took: Math.max(0, end - from), parallel: false, waited });
    lane = Math.max(from, end);
  }
  return spans;
}
