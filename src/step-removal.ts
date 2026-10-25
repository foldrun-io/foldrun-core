// What deleting one step from a flow changes, in words — for the confirm
// dialog on the canvas and the CLI's `flow rm-step`. Pure over parsed steps
// and free of the parser and the filesystem, so the browser can import it.
// The edit itself is flow-patterns.ts removeStep.

import type { FlowStep } from "./store.ts";

export interface RemovalImpact {
  /** "step 4 · watchdog" — the step as a person names it. */
  label: string;
  /** One sentence per consequence. */
  notes: string[];
}

function groupsOf(steps: FlowStep[]): number[][] {
  const map = new Map<number, number[]>();
  steps.forEach((s, i) => map.set(s.group, [...(map.get(s.group) ?? []), i]));
  return [...map.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v);
}

/** A step as a person names it: its group number and its target. */
export function stepLabel(steps: FlowStep[], index: number): string {
  const s = steps[index];
  const column = groupsOf(steps).findIndex((g) => g.includes(index));
  return `step ${column + 1} · ${s.subflow ? `flow:${s.subflow}` : s.agent}`;
}

/**
 * What else changes when step `index` goes — said before it goes, in the
 * words a confirm dialog or a terminal prints. Nothing here refuses; it
 * describes. removeStep refuses.
 */
export function removalImpact(steps: FlowStep[], index: number): RemovalImpact {
  const s = steps[index];
  if (!s) throw new Error(`no step ${index + 1}`);
  const groups = groupsOf(steps);
  const column = groups.findIndex((g) => g.includes(index));
  const alone = groups[column].length === 1;
  const notes: string[] = [];
  if (steps.length === 1) notes.push("It is the flow's only step — the flow will have nothing to run.");
  const next = groups[column + 1]?.map((i) => steps[i]) ?? [];
  const routed = next.filter((t) => t.case !== undefined || t.else || t.when !== undefined);
  if (alone && routed.length) {
    const before = groups[column - 1];
    const on = before ? `step ${column}'s result (${before.map((i) => steps[i].subflow ? `flow:${steps[i].subflow}` : steps[i].agent).join(", ")})` : "nothing — they would come first";
    notes.push(
      `${routed.length === 1 ? "The case:/when: step" : `The ${routed.length} case:/when: steps`} after it (${routed.map((t) => t.subflow ?? t.agent).join(", ")}) will route on ${on}.`,
    );
  }
  if (s.case !== undefined || s.else) notes.push(`It is a branch (${s.case !== undefined ? `case: ${s.case}` : "else"}) — that route is gone.`);
  if (alone && column < groups.length - 1) {
    const from = column + 2, to = groups.length;
    notes.push(from === to ? `Group ${from} after it renumbers to ${from - 1}.` : `The groups after it renumber: ${from}–${to} become ${from - 1}–${to - 1}.`);
  }
  if (!alone) notes.push(`The ${groups[column].length - 1} other step${groups[column].length === 2 ? "" : "s"} in group ${column + 1} still run${groups[column].length === 2 ? "s" : ""}.`);
  if (!s.subflow) notes.push(`agents/${s.agent}/agent.md is not touched.`);
  return { label: stepLabel(steps, index), notes };
}

