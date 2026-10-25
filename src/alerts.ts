// `alerts:` — the thresholds a workspace wants to hear about (FOL-72 step 7):
//
//   alerts:
//     failure_rate: 30%     # of its runs that finished in the last 24 hours
//     min_runs: 5           # …once at least this many have (default 5)
//     credits_day: 2000     # credits charged in the last 24 hours
//     run_minutes: 45       # a run still going after this long
//     stale_days: 30        # an agent that has not run in this many days
//     cost_spike: 3         # a run that cost this many times its flow's 7-day average
//     runs_per_hour: 20     # one flow started this many times in an hour
//     new_host: true        # an agent reached a site it never reached before
//
// In AGENTS.md (the workspace's, else the account's). The watchdog evaluates
// them on its tick and tells `notify:` once per rule a day (a slow run once
// per run), as event `alert`. Pure: `foldrun check` and the watchdog read the
// same parse.

import type { Outcome } from "./outcome.ts";

export interface AlertConfig {
  failureRate?: number;
  minRuns: number;
  creditsDay?: number;
  runMinutes?: number;
  staleDays?: number;
  costSpike?: number;
  runsPerHour?: number;
  /** Told after a run (platform host-watch.ts), not on the watchdog's tick. */
  newHost?: boolean;
}

const KEYS = ["failure_rate", "min_runs", "credits_day", "run_minutes", "stale_days", "cost_spike", "runs_per_hour", "new_host"];

const num = (v: unknown): number | null => {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() && Number.isFinite(Number(v.trim()))) return Number(v.trim());
  return null;
};

/** The config, and what is wrong with it in words (for `foldrun check`). */
export function parseAlerts(raw: unknown): { config: AlertConfig | null; problems: string[] } {
  if (raw === undefined || raw === null) return { config: null, problems: [] };
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return { config: null, problems: ["alerts: is a block — failure_rate, min_runs, credits_day, run_minutes, stale_days, cost_spike, runs_per_hour, new_host"] };
  }
  const o = raw as Record<string, unknown>;
  const problems: string[] = [];
  for (const k of Object.keys(o)) if (!KEYS.includes(k)) problems.push(`alerts: ${k} — not a threshold; the keys are ${KEYS.join(", ")}`);
  const cfg: AlertConfig = { minRuns: 5 };
  if (o.failure_rate !== undefined) {
    const s = String(o.failure_rate).trim();
    const pct = /^(\d+(?:\.\d+)?)\s*%$/.exec(s);
    const v = pct ? Number(pct[1]) / 100 : num(o.failure_rate);
    if (v === null || v <= 0 || v > 1) problems.push(`alerts: failure_rate ${s} — a share of runs, like 30% or 0.3`);
    else cfg.failureRate = v;
  }
  for (const [key, field, min] of [["min_runs", "minRuns", 1], ["credits_day", "creditsDay", 1], ["run_minutes", "runMinutes", 1], ["stale_days", "staleDays", 1], ["cost_spike", "costSpike", 1.5], ["runs_per_hour", "runsPerHour", 2]] as const) {
    if (o[key] === undefined) continue;
    const v = num(o[key]);
    if (v === null || v < min) problems.push(`alerts: ${key} ${String(o[key])} — a number, at least ${min}`);
    else (cfg as unknown as Record<string, number>)[field] = v;
  }
  if (o.new_host !== undefined) {
    if (typeof o.new_host !== "boolean") problems.push(`alerts: new_host ${String(o.new_host)} — true or false`);
    else if (o.new_host) cfg.newHost = true;
  }
  const any = cfg.newHost === true || cfg.failureRate !== undefined || cfg.creditsDay !== undefined || cfg.runMinutes !== undefined || cfg.staleDays !== undefined || cfg.costSpike !== undefined || cfg.runsPerHour !== undefined;
  return { config: any ? cfg : null, problems };
}

export interface AlertFacts {
  /** Outcomes of the runs started in the last 24 hours. */
  outcomes: Outcome[];
  /** Credits are cents: USD charged in the last 24 hours. */
  chargedUsd: number;
  /** Runs still going. */
  live: { id: string; flow: string; startedAt: string }[];
  /** For stale_days: each agent, when it last ran (null: not in the runs
   *  kept), and since when it has existed — an agent added yesterday is not
   *  stale for never having run. */
  agents?: { name: string; lastRunAt: string | null; since: string }[];
  /** For cost_spike and runs_per_hour: the runs of the last seven days,
   *  test runs left out. costUsd is what its steps cost. */
  runs?: { id: string; flow: string; startedAt: string; finishedAt: string | null; costUsd: number }[];
}

/** How few earlier runs a flow needs before its average means anything. */
const SPIKE_MIN_RUNS = 3;

export interface Alert {
  /** What the once-a-day memory is keyed by: the rule, or the rule and run. */
  key: string;
  headline: string;
  detail: string;
  runId?: string;
  flow?: string;
  /** Said once for this key, however long it stays true (a slow run, an
   *  idle spell); the watchdog's notice memory is pruned after a week, so
   *  a condition that lasts is said again weekly at most. */
  once?: boolean;
}

/** What crosses its threshold now. */
export function evaluateAlerts(cfg: AlertConfig, facts: AlertFacts, workspace: string, now: number): Alert[] {
  const out: Alert[] = [];
  if (cfg.failureRate !== undefined) {
    const finished = facts.outcomes.filter((o) => o === "failed" || o === "good" || o === "done" || o === "quiet" || o === "blocked" || o === "bad");
    const failed = finished.filter((o) => o === "failed").length;
    if (finished.length >= cfg.minRuns && failed / finished.length >= cfg.failureRate) {
      out.push({
        key: "failure_rate",
        headline: `⚠ ${workspace}: ${failed} of its last ${finished.length} runs failed`,
        detail: `${Math.round((100 * failed) / finished.length)}% in the last 24 hours, over the ${Math.round(cfg.failureRate * 100)}% in alerts: failure_rate. Its Issues show what broke.`,
      });
    }
  }
  if (cfg.creditsDay !== undefined) {
    const credits = Math.round(facts.chargedUsd * 100);
    if (credits >= cfg.creditsDay) {
      out.push({
        key: "credits_day",
        headline: `⚠ ${workspace} was charged ${credits.toLocaleString("en")} credits in a day`,
        detail: `Over the ${cfg.creditsDay.toLocaleString("en")} in alerts: credits_day, in the last 24 hours. Observe shows which flows and agents.`,
      });
    }
  }
  if (cfg.runMinutes !== undefined) {
    for (const r of facts.live) {
      const mins = (now - Date.parse(r.startedAt)) / 60_000;
      if (mins >= cfg.runMinutes) {
        out.push({
          key: `run_minutes/${r.id}`,
          runId: r.id,
          flow: r.flow,
          headline: `⚠ ${workspace}: ${r.flow} has been running ${Math.round(mins)} minutes`,
          detail: `Run ${r.id} is past the ${cfg.runMinutes} minutes in alerts: run_minutes — still going, maybe stuck. Stop it from its page if it is.`,
        });
      }
    }
  }
  if (cfg.costSpike !== undefined && facts.runs) {
    // A run that finished in the last day, against the runs of its flow that
    // finished before it in the week: once per run.
    const done = facts.runs.filter((r) => r.finishedAt).sort((a, b) => a.finishedAt!.localeCompare(b.finishedAt!));
    for (const r of done) {
      if (now - Date.parse(r.finishedAt!) > 86_400_000) continue;
      const before = done.filter((o) => o.flow === r.flow && o.id !== r.id && o.finishedAt! < r.finishedAt!);
      if (before.length < SPIKE_MIN_RUNS) continue;
      const mean = before.reduce((n, o) => n + o.costUsd, 0) / before.length;
      if (mean <= 0 || r.costUsd < cfg.costSpike * mean) continue;
      out.push({
        key: `cost_spike/${r.id}`,
        runId: r.id,
        flow: r.flow,
        headline: `${workspace}: a ${r.flow} run cost ${(r.costUsd / mean).toFixed(1)}× its usual`,
        detail: `Run ${r.id} cost $${r.costUsd.toFixed(2)} against an average of $${mean.toFixed(2)} over its last ${before.length} runs this week — past the ${cfg.costSpike}× in alerts: cost_spike. Its page shows which step spent it.`,
      });
    }
  }
  if (cfg.runsPerHour !== undefined && facts.runs) {
    const hour = facts.runs.filter((r) => now - Date.parse(r.startedAt) <= 3_600_000);
    const byFlow = new Map<string, number>();
    for (const r of hour) byFlow.set(r.flow, (byFlow.get(r.flow) ?? 0) + 1);
    for (const [flow, n] of byFlow) {
      if (n < cfg.runsPerHour) continue;
      out.push({
        key: `runs_per_hour/${flow}`,
        flow,
        headline: `${workspace}: ${flow} started ${n} times in an hour`,
        detail: `Past the ${cfg.runsPerHour} in alerts: runs_per_hour — a loop, a webhook sender retrying, or a schedule written wrong. Its Triggers page shows what started each; throttle: or debounce: caps it, and Settings → Pause stops it now.`,
      });
    }
  }
  if (cfg.staleDays !== undefined) {
    for (const a of facts.agents ?? []) {
      const from = Date.parse(a.lastRunAt ?? a.since);
      if (!Number.isFinite(from)) continue;
      const days = Math.floor((now - from) / 86_400_000);
      if (days < cfg.staleDays) continue;
      out.push({
        // Keyed by the run it last made, so a run and a new idle spell are news again.
        key: `stale_days/${a.name}/${a.lastRunAt ?? "never"}`,
        once: true,
        headline: `${workspace}: agent ${a.name} has not run in ${days} days`,
        detail: `${a.lastRunAt ? `Its last step started ${a.lastRunAt.slice(0, 10)}` : "No run kept on record has used it"} — past the ${cfg.staleDays} days in alerts: stale_days. If nothing needs it any more, retire it: delete agents/${a.name}/ and redeploy, so it holds no tools or secrets nobody watches.`,
      });
    }
  }
  return out;
}
