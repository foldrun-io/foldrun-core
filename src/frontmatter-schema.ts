// Checking frontmatter against frontmatter-fields.ts: the values, not just
// the names. Node-side (it reads store's parsers); the browser takes the
// field list alone from frontmatter-fields.ts.

import { FRONTMATTER, JOBS, type FieldType, type SchemaKind } from "./frontmatter-fields.ts";
import { jobFold } from "./matter.ts";
import { resolveEffort, parseDuration, parseInstant, parseRate, STEP_OPTION_KEYS } from "./store.ts";
import { budgetProblem } from "./budget.ts";
import { cronProblem, parseCron, cronCanFire } from "./cron.ts";
import { SECRET_NAME } from "./secrets.ts";
import { modelSecretCollision } from "./model-credential.ts";
import { resourcesProblem, computeProblem } from "./resources.ts";

export { FRONTMATTER, schemaKindOf, type FieldSpec, type FieldType, type SchemaKind } from "./frontmatter-fields.ts";

/** A value for a message: a scalar as written, anything else by its shape.
 *  Never String() of a map — its `toString` is whatever the YAML says. */
function shown(v: unknown): string {
  return typeof v === "string" || typeof v === "number" || typeof v === "boolean" ? String(v) : v instanceof Date ? v.toISOString() : Array.isArray(v) ? "a list" : "a map";
}

const DURATION = (min: number, max: number, unit = "") => (v: unknown) => {
  if (typeof v !== "string" && typeof v !== "number") return `is ${shown(v)}, not a duration — write seconds (900) or 30s, 15m, 4h, 3d`;
  const s = parseDuration(String(v));
  if (s === undefined) return `"${String(v)}" is not a duration — write seconds (900) or 30s, 15m, 4h, 3d`;
  if (s < min || s > max) return `"${String(v)}" is outside ${unit || `${min}s to ${max}s`}`;
  return null;
};

/** Why a value is wrong, or null — per kind, per field: the rules a list of
 *  values cannot say (aliases, durations, cron, budgets). */
const CHECKS: Partial<Record<SchemaKind, Record<string, (value: unknown) => string | null>>> = {
  "agent": {
    effort: (v) => (resolveEffort(v) ? null : `"${String(v)}" is not an effort — low, medium, high, xhigh or max; the step runs at the model's default`),
    apis: apisProblem,
    budget: (v) => budgetProblem(v, ["run"]),
    ask: (v) => askProblem(v),
    resources: resourcesProblem,
    secrets: modelSecretCollision,
  },
  "agents-md": {
    budget: (v) => budgetProblem(v, ["day", "week", "month"]),
    concurrency: (v) => (Number.isInteger(Number(v)) && Number(v) > 0 ? null : `${String(v)} is not a whole number of runs, 1 or more`),
    compute: computeProblem,
  },
  "flow": {
    schedule: cronProblem,
    effort: (v) => (resolveEffort(v) ? null : `"${String(v)}" is not an effort — low, medium, high, xhigh or max`),
    at: (v) => (parseInstant(v) ? null : `"${String(v)}" is not an ISO 8601 instant — a once flow with it never fires`),
    url: (v) => (/^https?:\/\//i.test(String(v)) ? null : `"${String(v)}" is not an http(s) URL`),
    every: DURATION(1, 30 * 86400, "1s to 30 days"),
    debounce: DURATION(1, 30 * 86400, "1s to 30 days"),
    throttle: DURATION(1, 30 * 86400, "1s to 30 days"),
    sla: DURATION(1, 30 * 86400, "1s to 30 days"),
    approve_within: DURATION(1, 30 * 86400, "1s to 30 days"),
    disable_after: (v) => (Number(v) > 0 && Number(v) <= 100 ? null : `${String(v)} is not a count from 1 to 100; it is ignored`),
    pause_when: (v) => (String(v).length <= 60 ? null : "is longer than 60 characters"),
    budget: (v) => budgetProblem(v, ["run"]),
    compute: computeProblem,
  },
  "tool": {
    transport: (v) => (["http", "script", "mcp"].includes(String(v).toLowerCase()) ? null : `"${String(v)}" is not a transport — http, script or mcp`),
    methods: methodsProblem,
    rate: (v) => (parseRate(v) ? null : `"${shown(v)}" is not a rate — N/s, N/minute, N/hour, or a number per second, above 0`),
    secrets: modelSecretCollision,
  },
  "eval": {
    effort: (v) => (resolveEffort(v) ? null : `"${String(v)}" is not an effort — low, medium, high, xhigh or max; the judge runs at none`),
  },
};

export interface FieldProblem {
  key: string;
  rule: "config/unknown-field" | "config/wrong-type" | "config/invalid-value" | "config/missing-field" | "config/conflict" | "config/misplaced" | "config/cron-never-fires" | "secret/signing-secret-value";
  level: "error" | "warn" | "info";
  message: string;
}

// YAML reads an unquoted 2026-11-01T09:00:00Z as a Date; the runtime takes
// it as the string it was written as, so it is one here too.
const typeOf = (v: unknown): FieldType | "null" =>
  v === null || v === undefined ? "null" : v instanceof Date ? "string" : Array.isArray(v) ? "list" : typeof v === "object" ? "object" : (typeof v as FieldType);

/** Where a key that is not read in this kind of file IS read, for a message
 *  that says where it belongs. */
function belongsIn(key: string, kind: SchemaKind): string | null {
  const where: [SchemaKind, string][] = [["agent", "an agent"], ["agents-md", "AGENTS.md"], ["flow", "a flow"], ["tool", "a tool"]];
  const homes = where.filter(([k]) => k !== kind && FRONTMATTER[k].some((f) => f.key === key && !f.legacy)).map(([, label]) => label);
  return homes.length ? homes.join(" or ") : null;
}

/**
 * What is wrong with one file's frontmatter, by its schema: a key nothing
 * reads (a near-miss names the field it meant), a value of the wrong type,
 * a value outside the ones that do something, a required field missing.
 * `near` is the typo matcher; scan.ts passes its own.
 */
export function frontmatterProblems(
  kind: SchemaKind,
  data: Record<string, unknown>,
  near: (key: string, known: readonly string[]) => string | null,
): FieldProblem[] {
  const fields = FRONTMATTER[kind];
  const known = fields.map((f) => f.key);
  const out: FieldProblem[] = [];
  // The four job blocks (matter.ts folds them): a key set both ways, and a
  // key left in a block that does not hold it.
  const fold = jobFold(data);
  for (const [key, job] of fold?.conflicts ?? []) {
    out.push({ key, rule: "config/conflict", level: "error", message: `\`${key}:\` is set twice — at the top and inside \`${job}:\`. Only the top one would be read; keep one` });
  }
  for (const { name: job } of JOBS) {
    const block = data[job];
    if (!block || typeof block !== "object" || Array.isArray(block)) continue;
    for (const inner of Object.keys(block as Record<string, unknown>)) {
      const spec = fields.find((f) => f.key === inner);
      const message = spec?.job
        ? `\`${inner}:\` is a ${spec.job} field, not a ${job} one — move it into \`${spec.job}:\` or to the top. Inside \`${job}:\` it is not read`
        : spec
          ? `\`${inner}:\` belongs to none of the four jobs — write it at the top. Inside \`${job}:\` it is not read`
          : `\`${inner}:\` inside \`${job}:\` is not a field foldrun reads${belongsIn(inner, kind) ? ` here — it is read in ${belongsIn(inner, kind)}` : ""}; it is ignored`;
      // A real setting in the wrong block is a setting silently not applied
      // — a guardrail written under governance: guards nothing — so it is an
      // error (Codex debate). A word foldrun does not read at all is a note.
      out.push({ key: inner, rule: "config/misplaced", level: spec ? "error" : "info", message });
    }
  }
  for (const [key, value] of Object.entries(data)) {
    // A block holding only misplaced keys is reported above, key by key.
    if (JOBS.some((j) => j.name === key) && value && typeof value === "object" && !Array.isArray(value)) continue;
    const spec = fields.find((f) => f.key === key);
    const check = CHECKS[kind]?.[key];
    if (!spec) {
      const meant = near(key, known);
      const home = belongsIn(key, kind);
      if (meant && meant !== key) {
        out.push({ key, rule: "config/unknown-field", level: "warn", message: `\`${key}:\` is not a field foldrun reads — did you mean \`${meant}:\`? As written it is ignored` });
      } else if (kind === "agent" && STEP_OPTION_KEYS.has(key)) {
        // `timeout: 3600` on an agent reads like a setting and is not one:
        // it is an option of a flow's step.
        out.push({ key, rule: "config/unknown-field", level: "warn", message: `\`${key}:\` is not read on an agent — it is a step option: indent it under the step in the flow (\`   ${key}: ${shown(value)}\`). Here it is ignored` });
      } else if (home) {
        const where = fold?.folded.get(key);
        out.push({ key, rule: "config/unknown-field", level: "warn", message: `\`${key}:\`${where ? ` (inside \`${where}:\`)` : ""} is read in ${home}, not in ${kind === "agents-md" ? "AGENTS.md" : kind === "eval" ? "an eval" : `a ${kind}`} — here it is ignored` });
      } else {
        out.push({ key, rule: "config/unknown-field", level: "info", message: `\`${key}:\` is not a field foldrun reads; it is ignored` });
      }
      continue;
    }
    if (spec.validated || value === null || value === undefined) continue;
    const want = Array.isArray(spec.type) ? spec.type : [spec.type];
    const got = typeOf(value);
    // A string where a list is wanted is a one-item list wherever the
    // runtime splits it, and the list types above say so.
    if (!want.includes(got as FieldType)) {
      out.push({ key, rule: "config/wrong-type", level: "warn", message: `\`${key}:\` should be ${want.map((t) => (t === "list" ? "a list" : t === "object" ? "a map of keys" : `a ${t}`)).join(" or ")}, not ${got === "list" ? "a list" : got === "object" ? "a map" : `a ${got}`} — as written it is not read` });
      continue;
    }
    // A field's own check knows its aliases (`effort: quick` is low), so it
    // decides alone; `values` alone is for a closed set with none.
    // A check reads customer YAML: a value shaped to break it (a map whose
    // `toString` is a string) is a finding, never a crash of the whole scan.
    let checked: string | null = null;
    try {
      checked = check ? check(value) : null;
    } catch {
      checked = "holds a value that cannot be read";
    }
    const why = check
      ? checked
      : spec.values && typeof value === "string" && !spec.values.includes(value.trim())
        ? `"${value}" is not one of ${spec.values.join(", ")} — as written it is ignored`
        : null;
    if (why) out.push({ key, rule: "config/invalid-value", level: "warn", message: `\`${key}:\` ${why.replace(/^\w+: /, "")}` });
  }
  // A cron every field of which is in range, on a day no month has —
  // `0 0 30 2 *`. The scheduler's own cronCanFire decides (30 Oct 2026), so
  // check and the scheduler say the same about it: it never fires.
  if (kind === "flow" && typeof data.schedule === "string") {
    const cron = parseCron(data.schedule);
    if (cron && !cronCanFire(cron)) {
      out.push({ key: "schedule", rule: "config/cron-never-fires", level: "warn", message: `\`schedule: "${data.schedule}"\` names a day no month it allows has — the flow never fires. Pick a day every named month has, or add a weekday` });
    }
  }
  // A signing secret is the NAME of a vault entry (30 Oct 2026): a flow's
  // `signing_secret:` and notify's `signing_secret:` are looked up with
  // getSecret, so a literal value there is a secret written into a
  // versioned, deployed file — and never matches anything in the vault.
  // The message never repeats the value.
  if (kind === "flow" && data.signing_secret !== undefined) {
    const why = signingSecretProblem(data.signing_secret);
    if (why) out.push({ key: "signing_secret", rule: "secret/signing-secret-value", level: "warn", message: `\`signing_secret:\` ${why}` });
  }
  if (kind === "agents-md" && data.notify && typeof data.notify === "object" && !Array.isArray(data.notify)) {
    const raw = (data.notify as { signing_secret?: unknown }).signing_secret;
    const why = raw === undefined ? null : signingSecretProblem(raw);
    if (why) out.push({ key: "notify", rule: "secret/signing-secret-value", level: "warn", message: `\`notify: signing_secret:\` ${why}` });
  }
  if (kind === "skill" && !(typeof data.description === "string" && data.description.trim())) {
    out.push({ key: "description", rule: "config/missing-field", level: "warn", message: "no `description:` — a skill without one is never loaded; the model chooses a skill by it" });
  }
  return out;
}

/** Why a `signing_secret:` value is not a vault secret's name, or null. The
 *  runtime reads `NAME` and `${NAME}` alike (notify.ts, store.ts). Never
 *  says what the value is: it may be the secret itself. */
export function signingSecretProblem(v: unknown): string | null {
  if (typeof v !== "string") return null; // config/wrong-type says so
  const name = v.trim().replace(/^\$\{|\}$/g, "");
  if (!name) return null;
  return SECRET_NAME.test(name)
    ? null
    : "holds something that is not a secret's name (UPPER_SNAKE_CASE, like WEBHOOK_SIGNING_KEY) — it is looked up in the vault by name, so a value written here is never found, and is deployed and versioned in plain text. Put the value in the vault (`foldrun secrets set NAME`), write the name here, and rotate it";
}

function askProblem(v: unknown): string | null {
  const t = (v as { timeout?: unknown } | null)?.timeout;
  return t === undefined ? null : DURATION(30, 86400, "30s to 24h")(t);
}

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"];
function methodsProblem(v: unknown): string | null {
  const list = Array.isArray(v) ? v.map(String) : String(v).split(",");
  const bad = list.map((m) => m.trim()).filter((m) => m && !METHODS.includes(m.toUpperCase()));
  return bad.length ? `${bad.join(", ")} — not a method; it is dropped. GET, POST, PUT, PATCH or DELETE` : null;
}
function apisProblem(v: unknown): string | null {
  for (const api of Array.isArray(v) ? v : []) {
    if (!api || typeof api !== "object") return "each entry is {name, base, …}";
    const m = (api as { methods?: unknown }).methods;
    const p = m === undefined ? null : methodsProblem(m);
    if (p) return `${String((api as { name?: unknown }).name ?? "an api")}: methods: ${p}`;
  }
  return null;
}
