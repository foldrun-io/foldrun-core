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
import { timezoneProblem } from "./clock.ts";

export interface FlowWarning {
  /** Index into flow.steps, or null for a whole-flow warning. */
  step: number | null;
  /** 1-indexed line in the flow file, when the warning is about one step. */
  line?: number;
  message: string;
  detail: string;
  /** "error" for a value the parser could not read — `timeout: abc` — which
   *  `foldrun check` must fail on rather than note. Absent means advisory,
   *  which every structural warning in this file is. */
  level?: "error" | "warn";
}

// Anaphora: phrases that only mean something if earlier output exists.
// Deliberately conservative — a false warning is worse than a missed one,
// because noisy warnings get ignored and then the real one is invisible too.
const REFERS_BACK =
  /\b(both|above|earlier|previous(ly)?|prior|the (changes|draft|research|results|findings|report|article|fixes|work)|what (they|the others?) (found|shipped|wrote|said))\b/i;

/** What exists in the workspace, when the caller knows. Optional: the lint
 *  is useful without it, and a caller that has the lists gets the reference
 *  checks too. */
export interface KnownNames {
  agents: string[];
  /** Agents that hold a tool declaring `outward: true` — one that sends,
   *  posts, buys or publishes. The caller resolves the grants; this file only
   *  needs the answer. Absent means the caller did not look, and the outward
   *  rule is skipped rather than guessed at. */
  outwardAgents?: string[];
}

/** One @, something either side, a dot in the domain, no whitespace. Written
 *  as string checks rather than a regex: the obvious pattern backtracks
 *  polynomially on a domain full of dots, and a lint that can be made slow
 *  by a flow file is a lint someone will turn off. */
function looksLikeAddress(a: string): boolean {
  const at = a.indexOf("@");
  if (at < 1 || at !== a.lastIndexOf("@") || /\s/.test(a)) return false;
  const domain = a.slice(at + 1);
  const dot = domain.indexOf(".");
  return dot > 0 && dot < domain.length - 1;
}

export function lintFlow(flow: FlowInfo, known?: KnownNames): FlowWarning[] {
  const warnings: FlowWarning[] = [];
  const agentNames = known ? new Set(known.agents) : null;

  // Cron's oldest trap, and an expensive one: when day-of-month AND
  // day-of-week are both restricted they are OR'd, not AND'd — the scheduler
  // does it too, correctly (`domRestricted && dowRestricted` → `domOk ||
  // dowOk`). So `0 5 1-7 * 5`, which every reader parses as "first Friday of
  // the month", fires every Friday AND every day of the first week: about
  // eleven runs where one was meant. Nothing about the expression looks wrong,
  // which is exactly why it needs saying here rather than being discovered on
  // the bill.
  // An approvers list only one word can satisfy. `approvers: [editors]` is
  // a role that is not `admins` and not an address; mayApprove would then
  // refuse every person, and the gate could only ever be answered by an
  // emailed link. Said here rather than discovered at the gate.
  const odd = (flow.approvers ?? []).filter((a) => a !== "admins" && !looksLikeAddress(a));
  if (odd.length) {
    warnings.push({
      step: null,
      message: `approvers: ${odd.join(", ")} — not an email address, and the only role word is admins`,
      detail: "Each entry is an address that may answer this flow's gates, or the word `admins`. Anything else matches nobody, and a list nobody matches locks every gate.",
    });
  }
  // A flow with an approvers list and no gate at all is a rule the author
  // believes is in force and which does nothing — the worst kind of safety
  // control.
  if (flow.approvers?.length && !flow.steps.some((s) => s.approve || s.ask)) {
    warnings.push({
      step: null,
      message: "approvers: is set but no step in this flow is a gate",
      detail:
        "Nothing here waits for a person, so the list has no effect. Mark the step that needs " +
        "a second pair of eyes with `!` (or `approve: true`), or drop the approvers: line.",
    });
  }
  // A zone nobody can read is two faults at once: the cron fires at the
  // wrong hour, and every step's calendar quietly falls through to the level
  // above. Both are invisible in a green run, so `foldrun check` refuses it.
  const zoneProblem = timezoneProblem(flow.timezone);
  if (zoneProblem) {
    warnings.push({
      step: null,
      level: "error",
      message: zoneProblem,
      detail:
        "This is the zone the schedule fires in AND the calendar every step in this flow works " +
        "to. Unreadable, the schedule falls back to UTC and each step inherits the workspace's " +
        "zone instead of this one.",
    });
  }
  // A deadline on a gate that does not exist reads as a safety net and is not
  // one. Same reasoning, said separately because the fix is different.
  if (flow.approveWithin && !flow.steps.some((s) => s.approve || s.ask)) {
    warnings.push({
      step: null,
      message: "approve_within: is set but no step in this flow is a gate",
      detail: "Nothing waits for a person, so nothing can expire. Mark a step with `!`, or drop the line.",
    });
  }
  // A throttle no schedule can ever trip: the flow cannot run more often
  // than its cron fires, so a floor below that interval never fires either.
  // Cheap to write, silently pointless, and a reader will believe it.
  if (flow.throttle && flow.trigger === "schedule" && flow.schedule) {
    warnings.push({
      step: null,
      message: `throttle: on a scheduled flow — check it is shorter than the schedule, or it will drop runs you meant to happen`,
      detail:
        "A schedule already decides how often this runs. A throttle longer than the gap between " +
        "fires silently skips them; if that is what you want, say it in the cron instead.",
    });
  }
  // `idempotency:` only has a delivery to read on a trigger that receives
  // one. On a schedule or a chained flow there is no request and no field,
  // so the key is inert.
  if (flow.idempotency && flow.trigger !== "webhook" && flow.trigger !== "email") {
    warnings.push({
      step: null,
      message: `idempotency: has nothing to read on trigger: ${flow.trigger}`,
      detail:
        "A delivery id comes off an incoming request, so this only does something for " +
        "trigger: webhook or trigger: email. On any other trigger it is ignored.",
    });
  }
  // `catchup:` is about a fire that was missed, which only a clock can miss.
  if (flow.catchup && flow.trigger !== "schedule") {
    warnings.push({
      step: null,
      message: `catchup: has no effect on trigger: ${flow.trigger}`,
      detail: "Only a schedule can miss a fire. Every other trigger happens when it happens.",
    });
  }
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

  // Trigger shapes that can never fire, said at check time rather than
  // discovered as a flow that "never runs".
  if (flow.budgetProblem) {
    warnings.push({ step: null, message: flow.budgetProblem, detail: "A flow's `budget:` is the most one run may spend — a number in USD, or `unlimited`. A cap over a day, week or month belongs in the workspace's or the account's AGENTS.md, where it means every run put together." });
  }
  if (flow.trigger === "once" && !flow.at) {
    warnings.push({ step: null, message: "trigger: once needs an `at:` instant", detail: "Write `at: 2026-09-05T09:00:00+10:00` (ISO 8601). Without a readable instant this flow never fires." });
  }
  if (flow.trigger === "watch" && !/^https?:\/\//.test(flow.url ?? "")) {
    warnings.push({ step: null, message: "trigger: watch needs an http(s) `url:`", detail: "The scheduler polls that URL and starts the flow when its content changes." });
  }
  if (flow.trigger === "flow") {
    if (!flow.after) warnings.push({ step: null, message: "trigger: flow needs `after: <flow>`", detail: "Name the flow of this workspace whose finishing starts this one." });
    else if (flow.after === flow.name) warnings.push({ step: null, message: "trigger: flow — a flow cannot chain on itself", detail: "That is a loop with no bound. Chain on the flow that produces what this one needs." });
  }
  if (flow.signature && !flow.signingSecret) {
    warnings.push({ step: null, message: `signature: ${flow.signature} needs \`signing_secret: \${NAME}\``, detail: "Every delivery will be refused until the secret is named and set in Settings → Secrets." });
  }
  if (flow.signature && flow.trigger !== "webhook") {
    warnings.push({ step: null, message: "signature: only applies to trigger: webhook", detail: "Inbox and other triggers do not carry a provider signature; the line does nothing here." });
  }

  if (flow.steps.length === 0) return warnings;

  const firstGroup = Math.min(...flow.steps.map((s) => s.group));

  flow.steps.forEach((step, i) => {
    const inFirstGroup = step.group === firstGroup;

    // A value the parser refused. Not advisory: the run would go ahead on
    // a number the author never wrote — `timeout: 15m` ran as one second
    // for as long as this was a coercion — so the check fails instead.
    for (const problem of step.problems ?? []) {
      warnings.push({
        step: i,
        line: step.line,
        level: "error",
        message: problem,
        detail:
          "The option is written but its value cannot be read, and a run would not do what the " +
          "line says. Durations are seconds or 90s / 30m / 4h / 3d; counts are whole numbers " +
          "within the key's cap (retry and loop at most 5, max at most 20).",
      });
    }

    // An instruction written over more than one line. It is read in full
    // now, but the parser had to decide where it stopped, and the line
    // below a wrapped instruction is one edit away from being prose. Said
    // out loud so an author who meant to wrap can see it, and one who did
    // not can see what got joined on.
    if (step.wrapped) {
      warnings.push({
        step: i,
        line: step.line,
        message: `"${step.subflow ?? step.agent}" has an instruction spread over more than one line`,
        detail:
          "A step's instruction ends where the step ends: the indented lines directly under it " +
          "are joined on, and the first blank line, option, heading, bullet or unindented line " +
          "finishes it. Put the whole instruction on the step's own line — one line, however " +
          "long — so what the agent is told does not depend on where the paragraph below begins.",
      });
    }

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

    // A gate with no `preview:` shows only the previous step's reply and
    // whatever files that reply happens to name. The person deciding sees a
    // summary, not the thing — unless the agent remembered.
    if ((step.approve || step.ask) && !step.preview?.length) {
      warnings.push({
        step: i,
        line: step.line,
        message: `"${step.subflow ?? step.agent}" is a gate with no preview:`,
        detail:
          "The approval box shows the previous step's reply and any storage/ file it names. " +
          "Declare what to show — `preview: draft/*.mdx, draft/images/*.webp` — so the approver " +
          "always sees the document, not a pointer, even when the agent forgets to name it.",
      });
    }

    // A step that can act on the outside world, with nothing to say whether
    // it did. The two answers are a check the runtime can fail on, or a
    // person; either is fine, neither is not. This is the one lint here that
    // is an error: every other structural warning costs a reread, and this
    // one costs a send nobody can take back.
    if (known?.outwardAgents?.includes(step.agent ?? "") && !step.verify && !step.approve && !step.ask) {
      warnings.push({
        step: step.group,
        line: step.line,
        level: "error",
        message: `[[${step.agent}]] can act outside this workspace and this step has no verify: and no gate`,
        detail:
          "A step that sends, posts, buys or publishes needs one of two things: a `verify:` the " +
          "runtime can fail the step on — a receipt file, a ledger row, the reply's own verdict " +
          "line — or a person, with `!` or `ask:`. Without either, a step that sent nothing and a " +
          "step that sent everything end the same way: reported as done.",
      });
    }

    // `each: items` fans out over DATA, and only an `output: json` step in
    // an earlier group produces any. Without one the step expands to
    // nothing every time, quietly — the exact failure this file exists for.
    if (step.each === "items") {
      const feeder = flow.steps.some((s) => s.group < step.group && s.output === "json");
      if (!feeder) {
        warnings.push({
          step: i,
          line: step.line,
          message: `"${step.subflow ?? step.agent}" fans out with each: items but no earlier step returns data`,
          detail:
            "each: items reads the JSON array an `output: json` step returned. No step before this " +
            "one declares output: json, so there are never any items and this step is always skipped. " +
            "Add `output: json` to the step that produces the list.",
        });
      }
    }

    // Two options that read another option to mean anything.
    if (step.parallel && !step.each) {
      warnings.push({
        step: i,
        line: step.line,
        message: `"${step.subflow ?? step.agent}" has parallel: but no each:`,
        detail: "parallel: caps how many instances of a fan-out run at once. Without each: there is one instance, and the line does nothing.",
      });
    }
    if ((step.schema !== undefined || step.schemaPath) && step.output !== "json") {
      warnings.push({
        step: i,
        line: step.line,
        message: `"${step.subflow ?? step.agent}" has schema: but no output: json`,
        detail: "schema: describes the JSON value an output: json step returns. Without output: json nothing is parsed, so nothing is checked. Add `output: json`.",
      });
    }

    // A step's OTHER agent references — the ones no parser validates,
    // because they are options rather than the step's target. Both fail
    // silently and at the worst possible moment: a misspelled `delegate:`
    // name is simply never chosen (the runner filters picks to the declared
    // set), and a misspelled `on-fail:` is discovered only once something
    // has already gone wrong.
    if (agentNames) {
      for (const name of step.delegate ?? []) {
        if (!agentNames.has(name)) {
          warnings.push({
            step: i,
            line: step.line,
            message: `delegate: "${name}" is not an agent in this workspace`,
            detail:
              "The runner only accepts picks from the declared set, so this name can never be " +
              "chosen — the step silently has one fewer colleague to call on. Fix the spelling, " +
              "or drop the name.",
          });
        }
      }
      if (step.onFail && !agentNames.has(step.onFail)) {
        warnings.push({
          step: i,
          line: step.line,
          message: `on-fail: "${step.onFail}" is not an agent in this workspace`,
          detail:
            "The recovery path is the one you cannot test by running the flow successfully. As " +
            "written, a failure here has nowhere to go and the step just fails.",
        });
      }
    }
    if (step.onFail && step.onFail === step.agent && !step.subflow) {
      warnings.push({
        step: i,
        line: step.line,
        message: `on-fail: "${step.onFail}" is the agent that just failed`,
        detail:
          "The same agent is handed the same instruction with its own failure as context. That is " +
          "`retry:` with extra steps — name a different agent, or use retry:.",
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
