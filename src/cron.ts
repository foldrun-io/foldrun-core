// Cron: the one reading of a flow's `schedule:`.
//
// Moved here from the platform's scheduler so `foldrun check`, the deploy and
// the scheduler ask the same function whether a schedule is one — a cron the
// scheduler cannot parse used to be skipped silently, and nothing earlier
// said so. The scheduler imports this; the expansion is unchanged.


export const NAMED: Record<string, string> = {
  "@hourly": "0 * * * *",
  "@daily": "0 0 * * *",
  "@midnight": "0 0 * * *",
  "@weekly": "0 0 * * 0",
  "@monthly": "0 0 1 * *",
};

export const DOW_NAMES = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const MONTH_NAMES = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

// Expand one cron field ("*", "*/15", "1-5", "mon,fri", "3") to a value set.
function expandField(field: string, min: number, max: number, names?: string[]): Set<number> | null {
  const out = new Set<number>();
  for (const part of field.split(",")) {
    const [rangePart, stepPart] = part.split("/");
    const step = stepPart ? Number(stepPart) : 1;
    if (!Number.isInteger(step) || step < 1) return null;

    let lo = min;
    let hi = max;
    if (rangePart !== "*") {
      const bounds = rangePart.split("-");
      const parse = (raw: string): number | null => {
        const token = raw.trim().toLowerCase();
        if (names) {
          // A name counts from the field's own minimum: SUN is 0 on the
          // weekday field, JAN is 1 on the month field. Indexed from zero,
          // JAN read as 0 (refused — the flow never fired) and FEB…DEC as
          // the month before.
          const idx = names.indexOf(token);
          if (idx !== -1) return min + idx;
        }
        const n = Number(token);
        return Number.isInteger(n) ? n : null;
      };
      const a = parse(bounds[0]);
      if (a === null) return null;
      lo = a;
      if (bounds.length > 1) {
        const b = parse(bounds[1]);
        if (b === null) return null;
        hi = b;
      } else {
        hi = stepPart ? max : a; // "5" → just 5; "5/10" → 5,15,25...
      }
    }
    if (lo < min || hi > max || lo > hi) return null;
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return out;
}

export interface Cron {
  minute: Set<number>;
  hour: Set<number>;
  dom: Set<number>;
  month: Set<number>;
  dow: Set<number>;
  domRestricted: boolean;
  dowRestricted: boolean;
  /** Neither minute nor hour is a wildcard: a job at a time of day, which
   *  is what the DST rules in cronMatches apply to (as in Vixie cron). */
  fixedTime: boolean;
}

/** `@daily` → its five fields; anything else as written. An own-property
 *  lookup, so `schedule: constructor` is a bad cron, not a crash. */
function expand(expr: string): string {
  const key = expr.trim().toLowerCase();
  return (Object.hasOwn(NAMED, key) ? NAMED[key]! : expr).trim();
}

export function parseCron(expr: string): Cron | null {
  if (typeof expr !== "string") return null;
  const normalized = expand(expr);
  const fields = normalized.split(/\s+/);
  if (fields.length !== 5) return null;
  const [mi, ho, dm, mo, dw] = fields;

  const minute = expandField(mi, 0, 59);
  const hour = expandField(ho, 0, 23);
  const dom = expandField(dm, 1, 31);
  const month = expandField(mo, 1, 12, MONTH_NAMES);
  const dowRaw = expandField(dw, 0, 7, DOW_NAMES);
  if (!minute || !hour || !dom || !month || !dowRaw) return null;

  // cron allows both 0 and 7 for Sunday.
  const dowSet = new Set([...dowRaw].map((d) => (d === 7 ? 0 : d)));

  return {
    minute,
    hour,
    dom,
    month,
    dow: dowSet,
    domRestricted: dm.trim() !== "*",
    dowRestricted: dw.trim() !== "*",
    fixedTime: !mi.startsWith("*") && !ho.startsWith("*"),
  };
}


/** Why `schedule:` is not a cron the scheduler can run, or null when it is. */
export function cronProblem(expr: unknown): string | null {
  if (typeof expr !== "string" || !expr.trim()) return "schedule: is a cron expression — five fields, or @hourly, @daily, @weekly, @monthly";
  if (parseCron(expr)) return null;
  const fields = expand(expr).split(/\s+/).length;
  return fields !== 5
    ? `schedule: "${expr}" has ${fields} field${fields === 1 ? "" : "s"}; cron has five — minute hour day-of-month month day-of-week ("0 9 * * MON"), or @hourly, @daily, @weekly, @monthly. As written the flow never fires`
    : `schedule: "${expr}" is not a cron the scheduler can read — a field is out of range or not a number (minute 0-59, hour 0-23, day 1-31, month 1-12, weekday 0-7 or sun-sat). As written the flow never fires`;
}

/** Days in each month, February at its leap-year 29: a cron naming the 29th
 *  of February does fire, every fourth year. */
const MONTH_DAYS = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/**
 * Whether the calendar has any day this cron names (30 Oct 2026). `0 0 30 2 *`
 * parses — every field is in range — yet no February has a 30th, so a search
 * for its next fire walked the whole window every time it was asked (the
 * schedule page did, 57,600 minutes per flow per request). Answered from the
 * fields alone: only a day of the month with no weekday beside it can miss,
 * since with a weekday either may match and every month has every weekday.
 */
export function cronCanFire(cron: Cron): boolean {
  if (!cron.domRestricted || cron.dowRestricted) return true;
  const firstDay = Math.min(...cron.dom);
  for (const m of cron.month) if (firstDay <= MONTH_DAYS[m - 1]!) return true;
  return false;
}
