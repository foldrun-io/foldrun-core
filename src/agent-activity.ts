// When each agent last did anything — the question an account with hundreds
// of agents has to be able to answer before it can retire the ones nobody
// uses. Read from the run index (listRunSummaries), so it covers what the
// install keeps: runs older than its retention are gone, and an agent whose
// last run was pruned reads as never run.

import type { RunSummary } from "./store.ts";

/** A step that started counts; one that was skipped or never reached does not. */
const RAN = new Set(["running", "completed", "failed", "awaiting-approval"]);

/** Agent name → the ISO time of its latest step that ran. */
export function agentLastRuns(runs: RunSummary[]): Map<string, string> {
  const last = new Map<string, string>();
  for (const run of runs) {
    for (const step of run.steps ?? []) {
      if (!step.agent || !RAN.has(step.status)) continue;
      const at = step.startedAt ?? run.startedAt;
      if (!at) continue;
      const prev = last.get(step.agent);
      if (!prev || at > prev) last.set(step.agent, at);
    }
  }
  return last;
}

/** Whole days since `iso`, or null for never. */
export function daysSince(iso: string | null | undefined, now = Date.now()): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? Math.floor((now - t) / 86_400_000) : null;
}
