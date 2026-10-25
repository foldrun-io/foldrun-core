// Why the model supply said no.
//
// A step whose model call is refused used to leave two facts in the record:
// a status code, and a sentence written by the SDK. In the incident this
// file exists for, that was:
//
//   egress: POST api.anthropic.com/v1/messages → 401 × 4 [FOLDRUN_MODEL_KEY]
//   API Error: 402 This request would exceed your available credits
//
// Both are true and neither is the reason. The reason was that the
// subscription behind the key had its five-hour window part used and
// overage switched off for lack of credits — a state that clears by itself
// at a known minute — and the fallback provider had no balance. Working
// that out took an hour on the box, most of it spent assuming the key had
// been revoked. The key was fine.
//
// Anthropic says all of it in response headers on the very response that
// carried the refusal:
//
//   anthropic-ratelimit-unified-status: allowed | rejected
//   anthropic-ratelimit-unified-5h-status / -7d-status
//   anthropic-ratelimit-unified-5h-utilization: 0.35
//   anthropic-ratelimit-unified-overage-status: rejected
//   anthropic-ratelimit-unified-overage-disabled-reason: out_of_credits
//   anthropic-ratelimit-unified-reset / -5h-reset / -7d-reset (unix seconds)
//   retry-after (on 429)
//
// We logged none of it. This file turns that header set into one sentence
// in the step's own trace and on the step's failure line, in the step's own
// timezone, and — the distinction that cost the hour — tells a spent window
// apart from a dead credential. A refusal carrying no rate-limit headers at
// all is a credential problem; a refusal carrying them is a supply problem
// and usually a clock.
//
// Two rules hold everywhere below. Never log a credential: nothing here
// reads a request header, and the only response headers it will look at are
// the allow-listed ones named above. Never log the whole header set: a
// provider is free to put anything in one, and a trace is read by people
// who are not thinking about that.

import { localDate } from "./clock.ts";

/** The family of headers that carries the answer. */
export const UNIFIED_PREFIX = "anthropic-ratelimit-unified";

/** The only headers that are ever copied out of an upstream response.
 *  An allow-list rather than a prefix match, so a header we have not
 *  thought about cannot reach a trace by being named plausibly. */
export const REFUSAL_HEADERS: readonly string[] = [
  `${UNIFIED_PREFIX}-status`,
  `${UNIFIED_PREFIX}-reset`,
  `${UNIFIED_PREFIX}-5h-status`,
  `${UNIFIED_PREFIX}-5h-utilization`,
  `${UNIFIED_PREFIX}-5h-reset`,
  `${UNIFIED_PREFIX}-7d-status`,
  `${UNIFIED_PREFIX}-7d-utilization`,
  `${UNIFIED_PREFIX}-7d-reset`,
  `${UNIFIED_PREFIX}-overage-status`,
  `${UNIFIED_PREFIX}-overage-disabled-reason`,
  "retry-after",
];

/** The marker a refusal line carries through the egress log, the
 *  translator log and the run trace, so the runner can find the sentence
 *  again among lines it did not write. */
export const REFUSAL_MARK = "provider refusal:";

/** Anything with a `get(name)` — a `Headers`, or a plain object wrapped by
 *  `headersFrom` below. */
export interface HeaderBag {
  get(name: string): string | null | undefined;
}

/** Read a plain record as a header bag, case-insensitively. */
export function headersFrom(record: Record<string, string | string[] | undefined>): HeaderBag {
  const lower = new Map<string, string>();
  for (const [k, v] of Object.entries(record)) {
    if (v === undefined) continue;
    lower.set(k.toLowerCase(), Array.isArray(v) ? v.join(", ") : v);
  }
  return { get: (name: string) => lower.get(name.toLowerCase()) ?? null };
}

/**
 * The allow-listed headers, and nothing else, as a small record. This is
 * the whole of what any part of foldrun keeps from an upstream response's
 * headers — the proxy calls it at the boundary and passes the result on.
 */
export function captureRefusalHeaders(headers: HeaderBag): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of REFUSAL_HEADERS) {
    const value = headers.get(name);
    if (typeof value === "string" && value.trim()) out[name] = value.trim().slice(0, 120);
  }
  return out;
}

export interface RefusalContext {
  /** The upstream status. */
  status: number;
  /** What `captureRefusalHeaders` kept. Empty is meaningful: it is how a
   *  dead credential is told from a spent window. */
  headers?: Record<string, string>;
  /** The step's own zone, from the clock cascade. */
  timezone?: string;
  /** Where the step stands on a second supply. Said out loud on every
   *  refusal, because "no fallback" is becoming the normal state and must
   *  read as a decision rather than as something that went missing. Left
   *  out by a caller that cannot know — the egress proxy sees a response,
   *  not a flow — and added by the runner, which can. */
  supply?: SupplyState;
  /** How the endpoint is named in the trace: `api.anthropic.com`. */
  provider?: string;
  /** For tests, and for a reset that has already passed. */
  now?: Date;
}

/** Which of the two windows refused, when either did. */
function rejectedWindow(h: Record<string, string>): "5h" | "7d" | null {
  for (const w of ["5h", "7d"] as const) {
    if ((h[`${UNIFIED_PREFIX}-${w}-status`] ?? "").toLowerCase() === "rejected") return w;
  }
  return null;
}

/** The busiest window we were told about, when none of them said
 *  "rejected" outright but the request was refused anyway. */
function busiestWindow(h: Record<string, string>): "5h" | "7d" | null {
  let best: "5h" | "7d" | null = null;
  let high = -1;
  for (const w of ["5h", "7d"] as const) {
    const raw = h[`${UNIFIED_PREFIX}-${w}-utilization`];
    const n = raw === undefined ? NaN : Number(raw);
    if (Number.isFinite(n) && n > high) {
      high = n;
      best = w;
    }
  }
  return best;
}

const WINDOW_WORD: Record<"5h" | "7d", string> = { "5h": "5-hour", "7d": "7-day" };

/** `0.35` → `35%`. Null for anything that is not a number we can show. */
function percent(raw: string | undefined): string | null {
  const n = raw === undefined ? NaN : Number(raw);
  if (!Number.isFinite(n) || n < 0) return null;
  // Providers have sent both a fraction and a percentage. Over 1 can only
  // be the latter; a run should not be told it is 3500% through a window.
  const fraction = n > 1 ? n / 100 : n;
  return `${Math.round(fraction * 100)}%`;
}

/** The short name a person uses for a zone: `Australia/Sydney` → Sydney,
 *  `UTC` → UTC, `+10:00` → UTC+10:00. */
export function zoneWord(timezone: string): string {
  if (!timezone) return "UTC";
  if (/^[+-]/.test(timezone)) return `UTC${timezone}`;
  const last = timezone.split("/").pop() ?? timezone;
  return last.replace(/_/g, " ");
}

/**
 * A unix-second reset as a person in that zone reads it: `14:00 Sydney`,
 * with the date when it is not today there. Null for a stamp that is not
 * one, so a garbled header costs a clause rather than the sentence.
 */
export function resetWhen(raw: string | undefined, timezone: string, now = new Date()): string | null {
  const secs = raw === undefined ? NaN : Number(raw);
  if (!Number.isFinite(secs) || secs <= 0) return null;
  // Seconds, or milliseconds from a provider that forgot which it promised.
  const at = new Date(secs > 1e11 ? secs : secs * 1000);
  if (Number.isNaN(at.getTime())) return null;
  let time: string;
  try {
    time = new Intl.DateTimeFormat("en-GB", {
      timeZone: timezone,
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(at);
  } catch {
    return null;
  }
  const sameDay = localDate(timezone, at) === localDate(timezone, now);
  if (sameDay) return `${time} ${zoneWord(timezone)}`;
  const day = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    weekday: "short",
    day: "numeric",
    month: "short",
  }).format(at);
  return `${time} ${zoneWord(timezone)} on ${day}`;
}

/** `retry-after: 90` → `90s`; `180` → `3m`. */
function waitWord(raw: string | undefined): string | null {
  const n = raw === undefined ? NaN : Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    // A provider may send an HTTP date instead of a delta.
    const at = raw ? Date.parse(raw) : NaN;
    if (!Number.isFinite(at)) return null;
    const secs = Math.round((at - Date.now()) / 1000);
    return secs > 0 ? waitWord(String(secs)) : null;
  }
  if (n < 90) return `${Math.round(n)}s`;
  if (n < 5400) return `${Math.round(n / 60)}m`;
  return `${(n / 3600).toFixed(1).replace(/\.0$/, "")}h`;
}

/** What the provider said it is out of. `out_of_credits` reads as prose. */
function reasonWord(raw: string | undefined): string | null {
  if (!raw) return null;
  return raw.replace(/[_-]+/g, " ").trim().toLowerCase() || null;
}

/** Where a step stands on a second supply: none configured, one about to
 *  be tried, or one that has been tried and refused as well. */
export type SupplyState = "none" | "trying" | "exhausted";

/** The clause that says whether there is anywhere else to go. Always on a
 *  refusal the runner finalises: the absence of a fallback is a state to
 *  state, not a silence to notice. */
export function supplyNote(state: SupplyState | undefined): string {
  if (state === "none") return " — no second supply is configured";
  if (state === "trying") return " — trying the second supply";
  if (state === "exhausted") return " — the second supply refused it too";
  return "";
}

/**
 * The sentence. One line, this project's voice, safe to put in a trace and
 * on a failure line.
 *
 * Three shapes, in the order they are told apart:
 *
 *   1. rate-limit headers present → a supply problem. Which window, how
 *      used, whether overage could have covered it and why it did not, and
 *      when it clears in the step's own zone.
 *   2. no rate-limit headers and a 401/403 → a credential problem. Said
 *      explicitly, including that this is NOT quota, because assuming the
 *      opposite is what cost an hour.
 *   3. anything else → the status, plainly, plus whatever the provider
 *      asked us to wait.
 */
export function explainRefusal(ctx: RefusalContext): string {
  const h = ctx.headers ?? {};
  const zone = ctx.timezone || "UTC";
  const now = ctx.now ?? new Date();
  const where = ctx.provider ? ` at ${ctx.provider}` : "";
  const supply = supplyNote(ctx.supply);
  const hasLimits = Object.keys(h).some((k) => k.startsWith(UNIFIED_PREFIX));

  if (hasLimits) {
    const window = rejectedWindow(h) ?? busiestWindow(h);
    const used = window ? percent(h[`${UNIFIED_PREFIX}-${window}-utilization`]) : null;
    const reset =
      resetWhen(window ? h[`${UNIFIED_PREFIX}-${window}-reset`] : undefined, zone, now) ??
      resetWhen(h[`${UNIFIED_PREFIX}-reset`], zone, now);
    const overage = (h[`${UNIFIED_PREFIX}-overage-status`] ?? "").toLowerCase();
    const why = reasonWord(h[`${UNIFIED_PREFIX}-overage-disabled-reason`]);

    const parts: string[] = [];
    if (window) {
      parts.push(used ? `the ${WINDOW_WORD[window]} window is ${used} used` : `the ${WINDOW_WORD[window]} window is spent`);
    }
    if (overage === "rejected" || overage === "disabled" || why) {
      parts.push(why ? `overage is off (${why})` : "overage is off");
    } else if (overage === "allowed") {
      parts.push("overage is on but did not cover it");
    }
    // "used BUT overage is off" — the two clauses are in tension, and that
    // tension is the finding: there was room left and no way to buy it.
    const wait = waitWord(h["retry-after"]);
    const tail = reset ? `it resets at ${reset}` : wait ? `it asked us to wait ${wait}` : "";
    const body = parts.length ? parts.join(" but ") : `HTTP ${ctx.status}`;
    return `the subscription${where} refused this burst — ${body}${tail ? `; ${tail}` : ""}${supply}`;
  }

  if (ctx.status === 401 || ctx.status === 403) {
    return (
      `the credential${where} was refused (HTTP ${ctx.status}) and the response carried no rate-limit headers, ` +
      `so this is the key itself — invalid, revoked, or wrong for this endpoint — not a spent window${supply}`
    );
  }

  if (ctx.status === 429) {
    const wait = waitWord(h["retry-after"]);
    return wait
      ? `the provider${where} is rate limiting this step (HTTP 429) and asked us to wait ${wait}${supply}`
      : `the provider${where} is rate limiting this step (HTTP 429) and named no wait${supply}`;
  }

  if (ctx.status === 402) {
    return `the account${where} is out of credit (HTTP 402) and the response said nothing about windows${supply}`;
  }

  return `the model supply${where} refused this step (HTTP ${ctx.status})${supply}`;
}

/** The same sentence, marked, for a log line the runner reads back. */
export function refusalLine(ctx: RefusalContext): string {
  return `${REFUSAL_MARK} ${explainRefusal(ctx)}`;
}

/** Is this status one we explain? The set the runner already treats as a
 *  provider refusal, plus 402 which is what started all this. */
export function isRefusalStatus(status: number): boolean {
  return status === 401 || status === 402 || status === 403 || status === 429;
}

/** Pull the sentence back out of a trace line that carries the mark,
 *  wherever in the line it sits — the translator's lines are prefixed on
 *  their way into the record, and the egress proxy's are not. */
export function refusalFromLine(text: string): string | null {
  const at = text.indexOf(REFUSAL_MARK);
  if (at < 0) return null;
  const said = text.slice(at + REFUSAL_MARK.length).trim();
  return said || null;
}
