// The clock an agent works to.
//
// A step used to run on whatever the pod's clock said, which is UTC, while
// the flow that fired it was scheduled in Australia/Sydney. A run at 08:00
// Sydney on the 16th wrote files stamped the 15th and the next step, looking
// for today's files, found none. The schedule and the work disagreed about
// what day it was.
//
// So the calendar is resolvable at every level, nearest wins:
//
//   agent frontmatter → flow frontmatter → workspace AGENTS.md →
//   account AGENTS.md → FOLDRUN_TIMEZONE → UTC
//
// Leaving `timezone:` out inherits the next level up; setting it anywhere
// wins for that level and everything under it. A value nothing can read
// never fails a step — it falls through to the next level and says so once.

/** A zone the runtime can actually use: the name Intl understands, and the
 *  value to put in `TZ` for the shell and Node inside the sandbox. They are
 *  the same for an IANA name and differ for a fixed offset. */
export interface Zone {
  /** What `Intl.DateTimeFormat({ timeZone })` is given. */
  name: string;
  /** What `TZ` is set to. */
  tz: string;
}

/** `UTC+10`, `GMT-3:30`, `+10:00`, `-0530`, or a bare `UTC`/`GMT`. */
const OFFSET_RE = /^(?:UTC|GMT)?\s*(?:([+-])\s*(\d{1,2})(?::?(\d{2}))?)?$/i;

/**
 * Read a written timezone into something usable, or null if nothing can be.
 *
 * Two shapes are accepted, because both are what people type: an IANA name
 * (`Australia/Sydney`) and a plain fixed offset (`UTC+10`, `+10:00`,
 * `-05:30`, `GMT+5`, or `UTC` on its own).
 */
export function normalizeZone(raw: unknown): Zone | null {
  const text = typeof raw === "string" ? raw.trim() : "";
  if (!text) return null;

  const offset = text.match(OFFSET_RE);
  if (offset) {
    const [, sign, hh, mm] = offset;
    // A bare UTC/GMT, or the empty match — no offset at all.
    if (!sign) return { name: "UTC", tz: "UTC" };
    const hours = Number(hh);
    const minutes = Number(mm ?? "0");
    // The real range of civil offsets. `UTC+99` is a typo, not a zone.
    if (hours > 14 || minutes > 59) return null;
    if (hours === 14 && minutes > 0) return null;
    const total = hours * 60 + minutes;
    if (total === 0) return { name: "UTC", tz: "UTC" };
    const pad = (n: number) => String(n).padStart(2, "0");
    const name = `${sign}${pad(hours)}:${pad(minutes)}`; // Intl reads this form
    if (minutes === 0) {
      // Etc/GMT zones have their sign INVERTED — POSIX counts degrees west of
      // Greenwich as positive, so Etc/GMT-10 is ten hours AHEAD of UTC. It is
      // worth the confusion: `Etc/GMT-10` is understood by ICU (so Node in
      // the sandbox honours it) and by the shell's date, which the offset
      // form `+10:00` is not.
      return { name, tz: `Etc/GMT${sign === "+" ? "-" : "+"}${hours}` };
    }
    // No Etc zone exists for a half-hour offset, so `TZ` gets the POSIX
    // spec — which the shell reads, and whose sign is inverted for the same
    // reason. FOLDRUN_DATE is computed from `name` either way, so the date
    // an agent is told is right whatever TZ a program makes of it.
    const posix = `${sign === "+" ? "-" : "+"}${pad(hours)}:${pad(minutes)}`;
    return { name, tz: `<${sign}${pad(hours)}${pad(minutes)}>${posix}` };
  }

  // Not an offset: an IANA name, if the platform knows it.
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: text });
    return { name: text, tz: text };
  } catch {
    return null;
  }
}

/** Is this a value `timezone:` may carry? Used by the lint, so `foldrun
 *  check` refuses `Sydney/Australia` and `UTC+99` before a run does. */
export function isTimezone(raw: unknown): boolean {
  return normalizeZone(raw) !== null;
}

/** The lint's sentence for a `timezone:` nobody can read. */
export function timezoneProblem(raw: unknown): string | null {
  if (raw === undefined || raw === null || raw === "") return null;
  if (isTimezone(raw)) return null;
  return (
    `timezone: ${String(raw)} — not a zone; use an IANA name (Australia/Sydney) ` +
    `or a fixed offset (UTC+10, +10:00, -05:30)`
  );
}

/** One level of the cascade: where the value was written, and what it said. */
export interface ZoneLevel {
  /** The word the trace uses: "agent", "flow", "workspace", "account". */
  level: string;
  value: unknown;
}

export interface ClockChoice {
  /** The zone, ready for Intl. */
  timezone: string;
  /** The value for `TZ`. */
  tz: string;
  /** Which level set it — or "FOLDRUN_TIMEZONE", or "default". */
  source: string;
  /** One sentence per unusable value found on the way down. Reported as a
   *  step event; never thrown, because a mistyped zone must not stop work. */
  problems: string[];
}

/**
 * Walk the levels, nearest first, and take the first zone that works.
 *
 * `FOLDRUN_TIMEZONE` is appended by the caller's level list or read here as
 * the last written level; UTC is what remains when nothing said anything —
 * the clock the pods actually run on.
 */
export function resolveClock(levels: ZoneLevel[], env = process.env.FOLDRUN_TIMEZONE): ClockChoice {
  const problems: string[] = [];
  const bad: string[] = [];
  const all = [...levels, { level: "FOLDRUN_TIMEZONE", value: env }];
  for (const { level, value } of all) {
    const written = typeof value === "string" ? value.trim() : "";
    if (!written) continue;
    const zone = normalizeZone(written);
    if (zone) {
      for (const b of bad) problems.push(`${b} — using ${zone.name} (${level}) instead`);
      return { timezone: zone.name, tz: zone.tz, source: level, problems };
    }
    bad.push(`timezone: "${written}" (${level}) is not a zone this runtime knows`);
  }
  for (const b of bad) problems.push(`${b} — using UTC instead`);
  return { timezone: "UTC", tz: "UTC", source: "default", problems };
}

/** YYYY-MM-DD in a timezone — the date the step believes it is. */
export function localDate(timeZone: string, now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}
