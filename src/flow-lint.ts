// Structural checks on a flow's arrangement.
//
// A flow can be perfectly valid markdown and still be guaranteed to produce
// fiction — the clearest case being a reviewer scheduled in group 1, whose
// instruction says "review both changes" while its context is empty because
// nothing has run yet. The model won't fail; it will invent a review and the
// run goes green. Work that quietly stops happening is exactly what these
// checks exist to make loud.
//
// Every check here is *structural*: it reasons about what a step can possibly
// have in context, never about whether the model did a good job. Nothing is
// blocked — flows still run, warnings are advisory.

import type { FlowInfo, FlowStep } from "./store.ts";

export interface FlowWarning {
  /** Index into flow.steps, or null for a whole-flow warning. */
  step: number | null;
  /** 1-indexed line in the flow file, when the warning is about one step. */
  line?: number;
  message: string;
  detail: string;
}

// Anaphora: phrases that only mean something if earlier output exists.
// Deliberately conservative — a false warning is worse than a missed one,
// because noisy warnings get ignored and then the real one is invisible too.
const REFERS_BACK =
  /\b(both|above|earlier|previous(ly)?|prior|the (changes|draft|research|results|findings|report|article|fixes|work)|what (they|the others?) (found|shipped|wrote|said))\b/i;

export function lintFlow(flow: FlowInfo): FlowWarning[] {
  const warnings: FlowWarning[] = [];

  // Cron's oldest trap, and an expensive one: when day-of-month AND
  // day-of-week are both restricted they are OR'd, not AND'd — the scheduler
  // does it too, correctly (`domRestricted && dowRestricted` → `domOk ||
  // dowOk`). So `0 5 1-7 * 5`, which every reader parses as "first Friday of
  // the month", fires every Friday AND every day of the first week: about
  // eleven runs where one was meant. Nothing about the expression looks wrong,
  // which is exactly why it needs saying here rather than being discovered on
  // the bill.
  if (flow.schedule) {
    const [, , dom, , dow] = flow.schedule.trim().split(/\s+/);
    if (dom && dow && dom !== "*" && dow !== "*") {
      warnings.push({
        step: null,
        message: `schedule "${flow.schedule}" restricts both day fields — cron runs it on EITHER, not both`,
        detail:
          "Day-of-month and day-of-week are OR'd when both are set, so this fires far more often " +
          "than it reads. For \"the Nth weekday of the month\" there is no cron form; use a plain " +
          "day-of-month (`0 5 3 * *`) for monthly, or a plain weekday (`0 5 * * 1`) for weekly.",
      });
    }
  }

  if (flow.steps.length === 0) return warnings;

  const firstGroup = Math.min(...flow.steps.map((s) => s.group));

  flow.steps.forEach((step, i) => {
    const inFirstGroup = step.group === firstGroup;

    // The first group starts with context = null. An instruction that points
    // at earlier output therefore points at nothing.
    if (inFirstGroup && step.instruction && REFERS_BACK.test(step.instruction)) {
      warnings.push({
        step: i,
        line: step.line,
        message: `"${step.subflow ?? step.agent}" refers to earlier work but runs first`,
        detail:
          "Steps in the first group start with no context — nothing has run yet. This agent will " +
          "invent what it was asked to review rather than fail. Move it to a later group.",
      });
    }

    // `when:` tests the previous results, which the first group doesn't have.
    if (inFirstGroup && step.when) {
      warnings.push({
        step: i,
        line: step.line,
        message: `"${step.subflow ?? step.agent}" has a when: condition but runs first`,
        detail:
          `Nothing has produced output yet, so "${step.when}" can never match and this step will ` +
          "always be skipped. Move it after the step whose output it depends on.",
      });
    }
  });

  // The same agent twice in one parallel group gets two identical contexts and
  // no way to divide the work — almost always a drag that landed wrong.
  const byGroup = new Map<number, FlowStep[]>();
  for (const s of flow.steps) byGroup.set(s.group, [...(byGroup.get(s.group) ?? []), s]);
  for (const [group, steps] of byGroup) {
    const counts = new Map<string, number>();
    for (const s of steps) {
      const key = s.subflow ? `flow:${s.subflow}` : s.agent;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    for (const [agent, n] of counts) {
      if (n > 1) {
        warnings.push({
          step: null,
          message: `"${agent}" appears ${n} times in group ${group}`,
          detail:
            "Both copies run at the same time with identical context, so they'll do the same work " +
            "twice. Put them in different groups, or give each a distinct instruction.",
        });
      }
    }
  }

  return warnings;
}
