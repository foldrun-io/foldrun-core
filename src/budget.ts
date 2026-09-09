// A budget is a number and a period — what may be spent, and over what.
//
// One grammar, read in four places: an agent's `budget:` (the most that
// agent may spend in one run), a flow's (the most one run may spend), a
// workspace's and the account's (a cap over a window of time). The value
// was a bare number meaning "per month" in a workspace or account file and
// "per run" in a flow; it still is, and it can now also say which:
//
//     budget: 60            a number alone: per run in a flow or an agent,
//                           per month in a workspace or the account
//     budget: 60/day        or 60/week, 60/month
//     budget: unlimited     no cap — the same as leaving the key out
//
// Unset means no limit. That is the platform's rule, not an accident of
// parsing: a customer who has not written a cap has not asked for one, and
// nothing here invents a default they would then have to find and raise.
//
// Windows follow the account's calendar (`timezone:` in AGENTS.md), the
// same one the scheduler and "today" already use, because a daily cap that
// resets at 10am Sydney time is not a daily cap anyone meant.

export type BudgetPeriod = "run" | "day" | "week" | "month";

export interface Budget {
  usd: number;
  period: BudgetPeriod;
}

/** Words that mean "no cap", case-insensitively. */
const UNLIMITED = new Set(["unlimited", "none", "no limit", "no-limit", "off", "-", "~"]);

const PERIODS: Record<string, BudgetPeriod> = {
  run: "run",
  day: "day",
  daily: "day",
  week: "week",
  weekly: "week",
  month: "month",
  monthly: "month",
};

// `\d+(?:\.\d+)?` with an optional separator and one period word: every
// part has one way to match, so a hostile string cannot make it backtrack.
const FORM_RE = /^\$?(\d+(?:\.\d+)?)(?:\s*(?:\/|per|a|each)?\s*([a-z]+))?$/;

/**
 * The budget a frontmatter value declares, or null for "no cap".
 *
 * Lenient on purpose: a value nobody can read is treated as no cap rather
 * than as a cap of zero, because refusing every run over a typo is the worse
 * failure. `budgetProblem` is the strict reading, for lint and the editor.
 */
export function parseBudget(raw: unknown, defaultPeriod: BudgetPeriod): Budget | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw === "number") return Number.isFinite(raw) && raw > 0 ? { usd: raw, period: defaultPeriod } : null;
  if (typeof raw !== "string") return null;
  const s = raw.trim().toLowerCase();
  if (!s || UNLIMITED.has(s)) return null;
  const m = FORM_RE.exec(s);
  if (!m) return null;
  const usd = Number(m[1]);
  if (!Number.isFinite(usd) || usd <= 0) return null;
  const period = m[2] ? PERIODS[m[2]] : defaultPeriod;
  if (!period) return null;
  return { usd, period };
}

/**
 * What is wrong with a `budget:` value, in a sentence, or null when it is
 * fine. `allowed` names the periods this file may use — an agent's or a
 * flow's budget is per run and nothing else; a workspace's or the account's
 * is over time and never per run.
 */
export function budgetProblem(raw: unknown, allowed: BudgetPeriod[]): string | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw === "number") {
    if (!Number.isFinite(raw) || raw < 0) return `budget: ${String(raw)} is not an amount in USD`;
    return null;
  }
  if (typeof raw !== "string") return `budget: must be a number, "<number>/<day|week|month>", or unlimited`;
  const s = raw.trim().toLowerCase();
  if (!s || UNLIMITED.has(s)) return null;
  const m = FORM_RE.exec(s);
  if (!m) return `budget: "${raw}" is not a number, "<number>/<day|week|month>", or unlimited`;
  if (m[2]) {
    const period = PERIODS[m[2]];
    if (!period) return `budget: "${m[2]}" is not a period — day, week or month`;
    if (!allowed.includes(period)) {
      return period === "run"
        ? `budget: is per run here already — write the number alone`
        : `budget: "${period}" does not apply here — this cap is per run; a cap over time belongs in the workspace's or the account's AGENTS.md`;
    }
  }
  return null;
}

/** "$60/day", "$500/month", "$6/run". */
export function formatBudget(b: Budget): string {
  const usd = Number.isInteger(b.usd) ? String(b.usd) : b.usd.toFixed(2);
  return `$${usd}/${b.period}`;
}

/** "today", "this week", "this month" — the window a spend is measured in. */
export function windowName(period: BudgetPeriod): string {
  return period === "day" ? "today" : period === "week" ? "this week" : period === "month" ? "this month" : "this run";
}

/** What to wait for when the cap is reached. */
export function windowTurnsHint(period: BudgetPeriod): string {
  return period === "day" ? "wait for tomorrow" : period === "week" ? "wait for next week" : "wait for the new month";
}

// ------------------------------------------------------------ the window

function partsIn(timeZone: string, at: Date): { y: number; m: number; d: number; h: number; min: number; s: number; weekday: number } {
  const f = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
    weekday: "short",
  });
  const p: Record<string, string> = {};
  for (const { type, value } of f.formatToParts(at)) p[type] = value;
  const weekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  return {
    y: Number(p.year),
    m: Number(p.month),
    d: Number(p.day),
    h: Number(p.hour),
    min: Number(p.minute),
    s: Number(p.second),
    weekday: weekdays.indexOf(p.weekday),
  };
}

/** The zone's offset from UTC at an instant, in ms (positive east). */
function offsetMs(timeZone: string, atMs: number): number {
  const p = partsIn(timeZone, new Date(atMs));
  return Date.UTC(p.y, p.m - 1, p.d, p.h, p.min, p.s) - Math.floor(atMs / 1000) * 1000;
}

/** Midnight at the start of a local calendar date, as a UTC instant. */
function localMidnightMs(timeZone: string, y: number, m: number, d: number): number {
  const naive = Date.UTC(y, m - 1, d);
  let t = naive - offsetMs(timeZone, naive);
  // Once more from the answer: across a DST change the first guess can be
  // off by the shift, and the second pass lands on the real midnight.
  const again = naive - offsetMs(timeZone, t);
  if (again !== t) t = again;
  return t;
}

/**
 * When the current window began, as a UTC instant — the moment spend is
 * summed from. Today's midnight, Monday's midnight, or the first of the
 * month, all in the given calendar. A per-run budget has no window.
 */
export function windowStartMs(period: BudgetPeriod, timeZone: string, now = new Date()): number | null {
  if (period === "run") return null;
  let tz = timeZone;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
  } catch {
    tz = "UTC";
  }
  const p = partsIn(tz, now);
  if (period === "day") return localMidnightMs(tz, p.y, p.m, p.d);
  if (period === "month") return localMidnightMs(tz, p.y, p.m, 1);
  // Monday. Walk back on the naive calendar, then take that date's midnight.
  const back = (p.weekday + 6) % 7;
  const monday = new Date(Date.UTC(p.y, p.m - 1, p.d - back));
  return localMidnightMs(tz, monday.getUTCFullYear(), monday.getUTCMonth() + 1, monday.getUTCDate());
}
