// How long `state/` checkpoints are kept (FOL-126 fixes, 8 Nov 2026).
//
// Every step of every run writes `state/` and each is a revision on the state
// head; the manifests are small but the blobs are whatever the state holds
// (indexes, caches), and the ticket's 100 × 1 GB case is a state head that
// never forgets. So the state head keeps a window:
//
//   keep   the newest N checkpoints (0: no count limit)
//   days   and none older than D days (0: no age limit)
//
// A checkpoint goes when it is outside EITHER limit, except
//   - the head, always (it is the state);
//   - one whose manifest something other than a revision still holds — a run
//     staged from it (pin holder `run`), a publish in flight — checked through
//     the same pins the sweeper obeys. It is looked at again next time.
//
// Pruning removes the revision rows and releases the pins THOSE revisions held
// on their manifests; it deletes no object. The objects are the sweeper's: it
// deletes a manifest or blob only through guardDelete, and only when no pin is
// left. A manifest two checkpoints share (an unchanged state) keeps the other
// checkpoint's pin.
//
// The workspace head (authored files) is not pruned: that is the history page.

import type { Deps } from "./publish.ts";
import type { WorkspaceRef } from "./revision-store.ts";

export interface StateRetention {
  keep: number;
  days: number;
}

export interface PruneResult {
  pruned: number;
  kept: number;
  /** Outside the window but held by a run or a publish: left for next time. */
  held: number;
}

const PAGE = 500;

export async function pruneStateRevisions(
  deps: Deps,
  ws: { tenant: string; workspace: string },
  policy: StateRetention,
  now: number = Date.now(),
): Promise<PruneResult> {
  const keep = Math.max(0, Math.floor(policy.keep || 0));
  const days = Math.max(0, policy.days || 0);
  const out: PruneResult = { pruned: 0, kept: 0, held: 0 };
  if (keep === 0 && days === 0) return out;
  const sws: WorkspaceRef = { tenant: ws.tenant, workspace: ws.workspace, scope: "state" };
  const cutoff = days > 0 ? now - days * 86_400_000 : -Infinity;
  const doomed: string[] = [];
  let seen = 0;
  let before: number | undefined;
  for (;;) {
    const page = await deps.revisions.revisions(sws, { limit: PAGE, before });
    if (!page.length) break;
    for (const r of page) {
      const index = seen++;
      if (index === 0) {
        out.kept++; // the head
        continue;
      }
      const outside = (keep > 0 && index >= keep) || Date.parse(r.at) < cutoff;
      if (!outside) {
        out.kept++;
        continue;
      }
      if (deps.pins && (await deps.pins.isPinnedBeyondRevisions(ws.tenant, "manifest", r.state))) {
        out.held++;
        continue;
      }
      doomed.push(r.id);
    }
    before = page[page.length - 1].seq;
    if (page.length < PAGE) break;
  }
  // In slices: one statement per slice, never an unbounded list.
  for (let i = 0; i < doomed.length; i += 200) out.pruned += await deps.revisions.prune(sws, doomed.slice(i, i + 200));
  return out;
}
