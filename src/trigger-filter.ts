// `filter:` — which deliveries of an event trigger become runs.
//
// A webhook flow used to start for every POST that carried the right token:
// a GitHub hook for "pull requests" started a run for drafts, bot pushes and
// label changes alike, and the first step's only job was to say "not this
// one" — a sandbox, a model call and a run on the record, per non-event.
// A filter says it in the flow's own file, and nothing starts:
//
//   filter:
//     action: [opened, reopened]          # any of these values
//     pull_request:
//       draft: false                      # exactly this value
//       base:
//         ref: { starts_with: release/ }  # text, never a regular expression
//     sender:
//       type: { not_in: [Bot] }           # none of these
//
// What the pattern is matched against depends on the trigger: a webhook's
// JSON body; an email's { from, to, subject, text }; a chained flow's
// { run, flow, status, verdict, summary }; a storage event's { by, paths }.
//
// The rules, all of them:
//
//   · every key must match (AND); a nested object matches the nested field;
//   · a list is the values allowed (any of them); a scalar is the one value;
//   · an operator object — only the keys in, not_in, exists, starts_with,
//     ends_with, contains — says it explicitly; the last three compare text
//     (case-sensitive) and never run a regular expression, so a body a
//     sender crafts cannot make one backtrack for minutes;
//   · strings compare exactly and case-sensitively, numbers numerically
//     (1 equals 1.0), booleans and null as themselves;
//   · a field that is missing fails `in`, a value and the text operators, and passes
//     `not_in`; `exists: false` passes only when it is missing;
//   · a list in the payload: a nested pattern matches when any element
//     does; `in` matches when any element is allowed, `not_in` when none is;
//   · it fails closed — a body that is not JSON, or a pattern that cannot be
//     evaluated, never matches.
//
// Pure and browser-safe: the gate, the check, the editor and the dashboard's
// Test box all call these two functions.

export const FILTER_LIMITS = { depth: 10, leaves: 64, values: 32, textChars: 500 } as const;

const TEXT_OPERATORS = ["starts_with", "ends_with", "contains"] as const;
const TEXT_VERB = { starts_with: "start with", ends_with: "end with", contains: "contain" } as const;
const OPERATORS = new Set<string>(["in", "not_in", "exists", ...TEXT_OPERATORS]);

type Scalar = string | number | boolean | null;

const isScalar = (v: unknown): v is Scalar =>
  v === null || typeof v === "string" || typeof v === "number" || typeof v === "boolean";

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v) && !(v instanceof Date);

/** An object whose every key is an operator — `{ not_in: [Bot] }`. A pattern
 *  object mixing operators with field names is refused by the check, since
 *  it cannot be read one way. */
function isOperatorObject(v: unknown): v is Record<string, unknown> {
  if (!isPlainObject(v)) return false;
  const keys = Object.keys(v);
  return keys.length > 0 && keys.every((k) => OPERATORS.has(k));
}

/** YAML reads `2026-10-01` as a Date; a filter means the text. */
const asScalar = (v: unknown): Scalar | undefined =>
  v instanceof Date ? v.toISOString().slice(0, 10) : isScalar(v) ? v : undefined;

/** Strings exactly, numbers numerically, the rest by identity. */
function sameValue(a: Scalar, b: unknown): boolean {
  if (typeof a === "number" && typeof b === "number") return a === b;
  return a === b;
}

const show = (v: unknown) => (typeof v === "string" ? JSON.stringify(v) : JSON.stringify(v ?? null));

/**
 * What is wrong with a `filter:` as written, one sentence each — empty when
 * it can be read. `foldrun check`, the deploy and the editor report these as
 * `config/invalid-value`.
 */
export function checkFilter(filter: unknown): string[] {
  const problems: string[] = [];
  if (filter === undefined || filter === null) return problems;
  if (!isPlainObject(filter) || Object.keys(filter).length === 0) {
    return ["filter: is a map of field names to the values they must have — e.g. `action: [opened]`"];
  }
  let leaves = 0;
  const walk = (node: Record<string, unknown>, where: string, depth: number) => {
    if (depth > FILTER_LIMITS.depth) {
      problems.push(`filter: nests deeper than ${FILTER_LIMITS.depth} levels at ${where}`);
      return;
    }
    for (const [key, value] of Object.entries(node)) {
      const at = where ? `${where}.${key}` : key;
      if (OPERATORS.has(key)) {
        problems.push(`filter: ${at} — ${key} is an operator; write it under a field name, e.g. \`sender: { ${key}: … }\``);
        continue;
      }
      if (isPlainObject(value) && Object.keys(value).some((k) => OPERATORS.has(k))) {
        if (!isOperatorObject(value)) {
          problems.push(`filter: ${at} mixes operators (${[...OPERATORS].join(", ")}) with field names — split them`);
          continue;
        }
        leaves++;
        problems.push(...checkOperators(value, at));
        continue;
      }
      if (isPlainObject(value)) {
        if (Object.keys(value).length === 0) problems.push(`filter: ${at} is an empty map, which says nothing`);
        else walk(value, at, depth + 1);
        continue;
      }
      leaves++;
      if (Array.isArray(value)) problems.push(...checkValues(value, at, "the list"));
      else if (asScalar(value) === undefined) problems.push(`filter: ${at} — a value, a list of values, a map, or { in, not_in, exists, starts_with, ends_with, contains }`);
    }
  };
  walk(filter, "", 1);
  if (leaves > FILTER_LIMITS.leaves) problems.push(`filter: has ${leaves} conditions — at most ${FILTER_LIMITS.leaves}`);
  return problems;
}

function checkValues(list: unknown[], at: string, what: string): string[] {
  const out: string[] = [];
  if (list.length === 0) out.push(`filter: ${at} — ${what} is empty, so nothing could ever match`);
  if (list.length > FILTER_LIMITS.values) out.push(`filter: ${at} — ${what} has ${list.length} values, at most ${FILTER_LIMITS.values}`);
  if (list.some((v) => asScalar(v) === undefined)) out.push(`filter: ${at} — ${what} holds only plain values (text, numbers, true/false, null)`);
  return out;
}

function checkOperators(op: Record<string, unknown>, at: string): string[] {
  const out: string[] = [];
  const list = (k: "in" | "not_in") => {
    const v = op[k];
    if (v === undefined) return null;
    const arr = Array.isArray(v) ? v : [v];
    out.push(...checkValues(arr, at, k));
    return arr.map(asScalar).filter((x): x is Scalar => x !== undefined);
  };
  const inList = list("in");
  const notIn = list("not_in");
  if (inList && notIn) {
    const both = inList.filter((v) => notIn.some((w) => sameValue(v, w)));
    if (both.length) out.push(`filter: ${at} lists ${both.map(show).join(", ")} in both in and not_in`);
  }
  if (op.exists !== undefined && typeof op.exists !== "boolean") out.push(`filter: ${at} — exists: is true or false`);
  const texts = TEXT_OPERATORS.filter((k) => op[k] !== undefined);
  if (op.exists === false && (inList?.length || texts.length)) {
    out.push(`filter: ${at} — exists: false cannot also require a value`);
  }
  for (const k of texts) {
    const v = op[k];
    if (typeof v !== "string" || !v) out.push(`filter: ${at} — ${k}: is text, e.g. \`${k}: "refs/heads/"\``);
    else if (v.length > FILTER_LIMITS.textChars) out.push(`filter: ${at} — ${k}: is longer than ${FILTER_LIMITS.textChars} characters`);
  }
  return out;
}

export interface FilterVerdict {
  match: boolean;
  /** Why, in one sentence: the first condition that failed, or "matched". */
  reason: string;
}

const MISSING = Symbol("missing");

/** One field's value against one leaf of the pattern. */
function leafMatches(value: unknown, cond: unknown, at: string): FilterVerdict {
  // An operator object.
  if (isOperatorObject(cond)) {
    if (cond.exists !== undefined) {
      const present = value !== MISSING;
      if (cond.exists === true && !present) return { match: false, reason: `${at} is missing (exists: true)` };
      if (cond.exists === false && present) return { match: false, reason: `${at} is present (exists: false)` };
    }
    const values = Array.isArray(value) ? value : value === MISSING ? [] : [value];
    if (cond.in !== undefined) {
      const allowed = (Array.isArray(cond.in) ? cond.in : [cond.in]).map(asScalar).filter((x): x is Scalar => x !== undefined);
      if (value === MISSING) return { match: false, reason: `${at} is missing` };
      if (!values.some((v) => allowed.some((a) => sameValue(a, v)))) return { match: false, reason: `${at} is ${show(value)}, not one of ${allowed.map(show).join(", ")}` };
    }
    if (cond.not_in !== undefined) {
      const refused = (Array.isArray(cond.not_in) ? cond.not_in : [cond.not_in]).map(asScalar).filter((x): x is Scalar => x !== undefined);
      const hit = values.find((v) => refused.some((a) => sameValue(a, v)));
      if (hit !== undefined) return { match: false, reason: `${at} is ${show(hit)}, which not_in refuses` };
    }
    for (const k of TEXT_OPERATORS) {
      const want = cond[k];
      if (want === undefined) continue;
      if (value === MISSING) return { match: false, reason: `${at} is missing` };
      const w = String(want);
      const texts = values.filter((v) => typeof v === "string" || typeof v === "number").map(String);
      const hit = texts.some((t) => (k === "starts_with" ? t.startsWith(w) : k === "ends_with" ? t.endsWith(w) : t.includes(w)));
      if (!hit) return { match: false, reason: `${at} is ${show(value)}, which does not ${TEXT_VERB[k]} ${show(w)}` };
    }
    return { match: true, reason: "matched" };
  }

  // A list of allowed values, or one value.
  const allowed = (Array.isArray(cond) ? cond : [cond]).map(asScalar);
  if (allowed.some((a) => a === undefined)) return { match: false, reason: `${at}: the filter's value cannot be compared` };
  if (value === MISSING) return { match: false, reason: `${at} is missing` };
  const values = Array.isArray(value) ? value : [value];
  if (values.some((v) => allowed.some((a) => sameValue(a as Scalar, v)))) return { match: true, reason: "matched" };
  return {
    match: false,
    reason: allowed.length === 1 ? `${at} is ${show(value)}, not ${show(allowed[0])}` : `${at} is ${show(value)}, not one of ${allowed.map(show).join(", ")}`,
  };
}

function nodeMatches(payload: unknown, pattern: Record<string, unknown>, where: string, depth: number): FilterVerdict {
  if (depth > FILTER_LIMITS.depth) return { match: false, reason: `the filter nests deeper than ${FILTER_LIMITS.depth} levels` };
  for (const [key, cond] of Object.entries(pattern)) {
    const at = where ? `${where}.${key}` : key;
    const value = isPlainObject(payload) && Object.prototype.hasOwnProperty.call(payload, key) ? payload[key] : MISSING;
    if (isPlainObject(cond) && !isOperatorObject(cond)) {
      // A nested pattern: the field must be an object that matches it, or a
      // list holding one that does.
      if (value === MISSING) return { match: false, reason: `${at} is missing` };
      // A nested pattern needs an object (or a list of them) to look inside:
      // a scalar or null there is not "every field missing", which would let
      // not_in and exists: false pass on a malformed delivery.
      if (!Array.isArray(value) && !isPlainObject(value)) return { match: false, reason: `${at} is ${show(value)}, not an object` };
      if (Array.isArray(value)) {
        const objects = value.filter(isPlainObject);
        if (objects.some((o) => nodeMatches(o, cond, at, depth + 1).match)) continue;
        return { match: false, reason: `no item of ${at} matches` };
      }
      const inner = nodeMatches(value, cond, at, depth + 1);
      if (!inner.match) return inner;
      continue;
    }
    const leaf = leafMatches(value, cond, at);
    if (!leaf.match) return leaf;
  }
  return { match: true, reason: "matched" };
}

/**
 * Does this payload pass this filter? No filter passes everything. A filter
 * the check would refuse never matches — it fails closed, so a typo holds
 * deliveries back instead of letting all of them through.
 */
export function matchFilter(filter: unknown, payload: unknown): FilterVerdict {
  if (filter === undefined || filter === null) return { match: true, reason: "no filter" };
  const problems = checkFilter(filter);
  if (problems.length) return { match: false, reason: `the filter cannot be read: ${problems[0].replace(/^filter: /, "")}` };
  if (!isPlainObject(payload)) return { match: false, reason: "the delivery is not a JSON object, so no field can match" };
  return nodeMatches(payload, filter as Record<string, unknown>, "", 1);
}

/** A webhook body as the filter reads it: its JSON, or null when it is not
 *  JSON (which no filter matches). */
export function webhookFilterPayload(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** The triggers a filter means something for. */
export const FILTERABLE_TRIGGERS = ["webhook", "email", "flow", "storage"] as const;
