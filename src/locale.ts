// Everything a country changes that a language does not — derived, not
// declared. `region:` is the one key; from language + region the runtime
// works out the currency, the units, the calendar (and today's date in it),
// which days are the weekend, the text direction, and how dates and hours
// read. Overrides exist only where derivation can be wrong for a business:
// `currency:`, `calendar:`, `units:`. Nothing else is a key, so there is no
// eighth setting to forget.
//
// Intl does the deriving. Every accessor here has a fallback to the older
// property form (Node 20) and to "unknown", because a runtime that cannot
// say the weekend must not say Saturday.

import { normalizeLanguage } from "./language.ts";

export interface RegionChoice {
  /** ISO 3166-1 alpha-2, upper-case: AU, IR, DE. Null when nobody said and
   *  the language tag carries none. */
  region: string | null;
  from: "agent" | "flow" | "workspace" | "account" | "env" | "language" | "none";
  lines: string[];
}

export function normalizeRegion(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const m = /^[a-z]{2}$/i.exec(raw.trim());
  return m ? raw.trim().toUpperCase() : null;
}

export function regionProblem(raw: unknown): string | null {
  if (raw === undefined || raw === null || raw === "") return null;
  if (normalizeRegion(raw)) return null;
  return `region: ${JSON.stringify(raw)} is not a country code — write the two letters, like \`au\`, \`ir\` or \`de\`.`;
}

export function resolveRegion(
  levels: { level: RegionChoice["from"]; value: unknown }[],
  languageTag: string,
  env: Record<string, string | undefined> = process.env,
): RegionChoice {
  const lines: string[] = [];
  for (const { level, value } of levels) {
    if (value === undefined || value === null || value === "") continue;
    const r = normalizeRegion(value);
    if (r) return { region: r, from: level, lines };
    lines.push(`region: ${level} says ${JSON.stringify(value)}, which is not a country code — using the next level`);
  }
  const fromEnv = normalizeRegion(env.FOLDRUN_REGION);
  if (fromEnv) return { region: fromEnv, from: "env", lines };
  const tag = normalizeLanguage(languageTag);
  const fromTag = tag && tag.includes("-") ? tag.split("-")[1] : null;
  if (fromTag) return { region: fromTag, from: "language", lines };
  return { region: null, from: "none", lines };
}

// ISO 4217 by region, for the regions a business here is likely to name.
// Intl has no region→currency table; this is the smallest one that is not
// wrong. Absent means "no currency assumed", which is better than a guess.
const CURRENCY: Record<string, string> = {
  AU: "AUD", NZ: "NZD", US: "USD", CA: "CAD", GB: "GBP", IE: "EUR", DE: "EUR", FR: "EUR", IT: "EUR", ES: "EUR",
  NL: "EUR", BE: "EUR", AT: "EUR", PT: "EUR", FI: "EUR", GR: "EUR", CH: "CHF", SE: "SEK", NO: "NOK", DK: "DKK",
  PL: "PLN", CZ: "CZK", TR: "TRY", RU: "RUB", UA: "UAH", IR: "IRR", IQ: "IQD", AF: "AFN", PK: "PKR", IN: "INR",
  BD: "BDT", LK: "LKR", NP: "NPR", AE: "AED", SA: "SAR", QA: "QAR", KW: "KWD", BH: "BHD", OM: "OMR", JO: "JOD",
  IL: "ILS", EG: "EGP", MA: "MAD", ZA: "ZAR", NG: "NGN", KE: "KES", CN: "CNY", HK: "HKD", TW: "TWD", JP: "JPY",
  KR: "KRW", SG: "SGD", MY: "MYR", ID: "IDR", TH: "THB", VN: "VND", PH: "PHP", BR: "BRL", MX: "MXN", AR: "ARS",
  CL: "CLP", CO: "COP",
};
const IMPERIAL = new Set(["US", "LR", "MM"]);

export type Units = "metric" | "imperial";

export interface LocaleFacts {
  /** The BCP-47 tag Intl was asked with, e.g. fa-IR. */
  tag: string;
  language: string;
  region: string | null;
  currency: string | null;
  units: Units;
  /** The calendar in use — Intl's first for the locale, or the override. */
  calendar: string;
  /** Other calendars the locale commonly uses, e.g. gregory beside persian. */
  calendars: string[];
  /** Today in that calendar, formatted for the locale. Null when it is
   *  gregory and would only repeat FOLDRUN_DATE. */
  dateLocal: string | null;
  /** 1 = Monday … 7 = Sunday, ISO. */
  weekStart: number | null;
  weekend: number[];
  direction: "ltr" | "rtl";
  hourCycle: "h12" | "h23" | null;
  /** A sample date, so the model sees the order without being told. */
  dateSample: string;
}

const DAY = ["", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
export const dayName = (n: number) => DAY[n] ?? String(n);

export function localeProblems(front: Record<string, unknown>): string[] {
  const out: string[] = [];
  const r = regionProblem(front.region);
  if (r) out.push(r);
  if (front.currency !== undefined && front.currency !== null && front.currency !== "") {
    if (!/^[A-Za-z]{3}$/.test(String(front.currency))) out.push(`currency: ${JSON.stringify(front.currency)} is not a currency code — three letters, like \`AUD\`, \`IRR\` or \`EUR\`.`);
  }
  if (front.units !== undefined && front.units !== null && front.units !== "") {
    if (!["metric", "imperial"].includes(String(front.units).toLowerCase())) out.push(`units: ${JSON.stringify(front.units)} — write \`metric\` or \`imperial\`.`);
  }
  if (front.calendar !== undefined && front.calendar !== null && front.calendar !== "") {
    const known = supportedCalendars();
    if (known.length && !known.includes(String(front.calendar).toLowerCase())) {
      out.push(`calendar: ${JSON.stringify(front.calendar)} is not a calendar this runtime knows — one of ${known.join(", ")}.`);
    }
  }
  return out;
}

function supportedCalendars(): string[] {
  try {
    const f = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf;
    return f ? f("calendar") : [];
  } catch {
    return [];
  }
}

function localeInfo(tag: string): { weekStart: number | null; weekend: number[]; direction: "ltr" | "rtl"; calendars: string[]; hourCycle: "h12" | "h23" | null } {
  try {
    const L = new Intl.Locale(tag) as unknown as Record<string, unknown>;
    const call = <T,>(m: string, p: string): T | undefined => {
      const fn = L[m];
      if (typeof fn === "function") return (fn as () => T).call(L);
      return L[p] as T | undefined;
    };
    const wk = call<{ firstDay?: number; weekend?: number[] }>("getWeekInfo", "weekInfo");
    const ti = call<{ direction?: string }>("getTextInfo", "textInfo");
    const cals = call<string[]>("getCalendars", "calendars") ?? [];
    const hc = call<string[]>("getHourCycles", "hourCycles")?.[0];
    return {
      weekStart: wk?.firstDay ?? null,
      weekend: wk?.weekend ?? [],
      direction: ti?.direction === "rtl" ? "rtl" : "ltr",
      calendars: cals,
      hourCycle: hc === "h12" || hc === "h23" ? hc : null,
    };
  } catch {
    return { weekStart: null, weekend: [], direction: "ltr", calendars: [], hourCycle: null };
  }
}

export function deriveLocale(
  language: string,
  region: string | null,
  overrides: { currency?: unknown; calendar?: unknown; units?: unknown } = {},
  timeZone = "UTC",
  now: Date = new Date(),
): LocaleFacts {
  const lang = normalizeLanguage(language) ?? "en";
  const base = lang.split("-")[0];
  const tag = region ? `${base}-${region}` : lang;
  const info = localeInfo(tag);
  const calendar =
    typeof overrides.calendar === "string" && overrides.calendar ? overrides.calendar.toLowerCase() : info.calendars[0] ?? "gregory";
  const currency =
    typeof overrides.currency === "string" && overrides.currency ? overrides.currency.toUpperCase() : region ? CURRENCY[region] ?? null : null;
  const units: Units =
    typeof overrides.units === "string" && ["metric", "imperial"].includes(overrides.units.toLowerCase())
      ? (overrides.units.toLowerCase() as Units)
      : region && IMPERIAL.has(region) ? "imperial" : "metric";
  const fmt = (opts: Intl.DateTimeFormatOptions, cal = calendar) => {
    try {
      return new Intl.DateTimeFormat(`${tag}-u-ca-${cal}`, { ...opts, timeZone }).format(now);
    } catch {
      return new Intl.DateTimeFormat("en", { ...opts, timeZone }).format(now);
    }
  };
  return {
    tag,
    language: lang,
    region,
    currency,
    units,
    calendar,
    calendars: info.calendars.filter((c) => c !== calendar),
    dateLocal: calendar === "gregory" ? null : fmt({ dateStyle: "long" }),
    weekStart: info.weekStart,
    weekend: info.weekend,
    direction: info.direction,
    hourCycle: info.hourCycle,
    dateSample: fmt({ dateStyle: "medium" }, "gregory"),
  };
}

/** The sentence block the prompt carries. Only what is true for this
 *  locale; nothing hedged, nothing the model has to guess at. */
export function localeProse(f: LocaleFacts, languageName: string, regionName: string | null): string {
  const parts: string[] = [];
  parts.push(`Language: ${languageName} (\`${f.language}\`)${regionName ? `. Region: ${regionName} (\`${f.region}\`)` : ""}.`);
  if (f.currency) parts.push(`Currency: ${f.currency}.`);
  parts.push(`Units: ${f.units}.`);
  if (f.calendar !== "gregory") {
    parts.push(`Calendar: ${f.calendar}${f.dateLocal ? ` — today is ${f.dateLocal}` : ""}${f.calendars.length ? ` (also ${f.calendars.join(", ")})` : ""}.`);
  }
  if (f.weekStart) {
    parts.push(`Week starts ${dayName(f.weekStart)}; weekend ${f.weekend.map(dayName).join(" and ") || "unknown"}.`);
  }
  parts.push(`Dates read like ${f.dateSample}${f.hourCycle ? `; ${f.hourCycle === "h23" ? "24-hour" : "12-hour"} time` : ""}.`);
  if (f.direction === "rtl") parts.push(`Text runs right to left: anything you render — HTML, email, PDF — needs dir="rtl".`);
  return parts.join(" ");
}

export function regionName(code: string | null): string | null {
  if (!code) return null;
  try {
    return new Intl.DisplayNames(["en"], { type: "region" }).of(code) ?? code;
  } catch {
    return code;
  }
}
