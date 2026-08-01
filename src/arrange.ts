// Rearranging a flow's steps into groups.
//
// Pure functions, extracted from the drag-and-drop board so they can be
// tested: when a drag produces an order you didn't expect, the first question
// is whether the rule is wrong or the target was — and that should be
// answerable without a browser.
//
// A `Groups` value is the arrangement: an array of groups, each holding
// indices into the flow's parsed steps. Steps sharing a group run in parallel.

export type Groups = number[][];

function removeStep(groups: Groups, step: number) {
  const next = groups.map((g) => g.filter((i) => i !== step));
  const emptiedAt = next.findIndex((g) => g.length === 0);
  return { next: next.filter((g) => g.length > 0), emptiedAt };
}

/** Move `step` into the group that currently contains `anchor` — run in parallel. */
export function joinGroup(groups: Groups, step: number, anchor: number): Groups {
  if (step === anchor) return groups;
  const { next } = removeStep(groups, step);
  const target = next.findIndex((g) => g.includes(anchor));
  if (target === -1) return groups;
  next[target] = [...next[target], step];
  return next;
}

/**
 * Move `step` out on its own at rail position `rail` — run sequentially.
 * Rail 0 is above every group; rail N is below group N-1.
 */
export function splitToRail(groups: Groups, step: number, rail: number): Groups {
  const { next, emptiedAt } = removeStep(groups, step);
  // Removing the step may have collapsed a group above the target, which
  // shifts every rail below it up by one.
  let at = rail;
  if (emptiedAt !== -1 && emptiedAt < rail) at -= 1;
  at = Math.max(0, Math.min(next.length, at));
  next.splice(at, 0, [step]);
  return next;
}
