// Open Knowledge Format — Google Cloud's vendor-neutral spec for handing
// curated context to agents (v0.1 June 2026, v0.2 July 2026, Apache 2.0,
// GoogleCloudPlatform/knowledge-catalog).
//
// Our `knowledge/` and `memory/` directories are OKF bundles. Same format,
// different write permission: knowledge is what a person gave the agent,
// memory is what the agent learned. v0.2's provenance fields make that
// distinction machine-readable rather than a folder convention —
//
//   generated: { by: human:matt }         → knowledge you verified
//   generated: { by: producer/foldrun }   → a fact an agent wrote
//
// which matters because on disk those two files used to look identical.
//
// Conformance per the spec:
//   · every non-reserved .md file has parseable frontmatter with a non-empty
//     `type`
//   · index.md carries no frontmatter, except `okf_version` at bundle root
//   · consumers must NOT reject a bundle for unknown keys, unknown `type`
//     values, missing optional fields, or broken links — so our own `name:`
//     and `description:` stay exactly where they are.

import fs from "node:fs";
import path from "node:path";
import matter from "gray-matter";

export const OKF_VERSION = "0.2";

/** This producer's actor string, in the spec's `<producer>/<version>` form. */
export const PRODUCER = "foldrun/0.1.0";

/**
 * Our stand-in when a v0.1 document carries only `timestamp`. Not an actor —
 * it says we don't know who, which is different from knowing it was a machine.
 */
export const UNKNOWN_ACTOR = "unknown (v0.1 timestamp)";

/**
 * §7 defines three actor forms, and only one of them is a person:
 *
 *   human:<id>              a person          →  human
 *   <producer>/<version>    an agent or tool  →  machine
 *   process:<id>            an automated job  →  machine
 *
 * So the test is for `human:`, not for any machine form. Testing the other way
 * round meant matching a literal "producer/" prefix — but the producer's *name*
 * is the first segment, so the spec's own `reference_agent/gemini-2.5-pro` did
 * not match, `process:` did not match, and neither did this platform's own
 * PRODUCER. The mark existed and fired for nothing real.
 */
export const isHumanActor = (actor: string) => actor.startsWith("human:");

/**
 * The spec's reserved filenames — exactly these two. A consumer treats every
 * other `.md` in the bundle as a concept and requires a `type:` on it.
 */
const OKF_RESERVED = new Set(["index.md", "log.md"]);

/**
 * Files that are bundle structure rather than concepts.
 *
 * Exactly the spec's two. There used to be a third — MEMORY.md, a curated
 * index of ours — and inventing a reserved name inside someone else's format
 * is what made a bundle we emit fail an outside validator while passing our
 * own: a consumer applies the spec's set, sees a file with no `type`, and
 * rejects the bundle over something we introduced. The lesson generalises, so
 * this set is the spec's and stays that way.
 */
const NOT_A_CONCEPT = OKF_RESERVED;

export type TrustTier = "unverified" | "machine-confirmed" | "human-reviewed";
export type OkfStatus = "draft" | "stable" | "deprecated";

export interface OkfSource {
  resource: string;
  id?: string;
  title?: string;
  author?: string;
  usageCount?: number;
  lastModified?: string;
  /** Per-entry override of the shared window, per §sources. */
  usageWindow?: { from?: string; to?: string };
}

/**
 * An `Attested Computation` contract. The spec binds a named computation to
 * typed parameters and names an attester that mechanically checks the run
 * matched the declaration — no signatures, just deterministic comparison.
 *
 * The runtime half (receipt and verdict wire formats, the lifecycle around a
 * run) is explicitly deferred to a future spec revision, so no consumer can
 * evaluate a verdict yet. What a consumer CAN do today is what the spec
 * already requires: surface an unattested computation rather than presenting
 * its output as though it had been checked.
 */
export interface OkfComputation {
  runtime: string;
  parameters: { name: string; type: string; required: boolean }[];
  computation: string | null;
  executorResource: string | null;
  receiptFields: string[];
  attesterResource: string | null;
  /** Why this contract can't be attested right now, if it can't. */
  attestationIssues: string[];
}

export interface OkfDoc {
  /** Path within the bundle — the spec makes the path the identity, so a
   *  nested concept is `tables/orders.md`, not `orders.md`. */
  file: string;
  type: string;
  title: string;
  description: string;
  tags: string[];
  status: OkfStatus;
  staleAfter: string | null;
  stale: boolean;
  generatedBy: string | null;
  /** When it was produced, from `generated.at`. */
  generatedAt: string | null;
  /** Every `verified` entry, with its timestamp where one was given. */
  verified: OkfActor[];
  /** Just the actors — what the trust tier is computed from. */
  verifiedBy: string[];
  /** The most recent verification, or null if nobody dated theirs. */
  verifiedAt: string | null;
  trust: TrustTier;
  /** Recommended v0.1 fields. */
  resource: string | null;
  timestamp: string | null;
  sources: OkfSource[];
  /** Present only on `type: Attested Computation` concepts. */
  computation: OkfComputation | null;
}

function parseComputation(data: Record<string, unknown>): OkfComputation | null {
  const isAttested = String(data.type ?? "").toLowerCase() === "attested computation";
  if (!isAttested && !data.attester && !data.executor) return null;

  const obj = (v: unknown) => (v && typeof v === "object" ? (v as Record<string, unknown>) : {});
  const executor = obj(data.executor);
  const attester = obj(data.attester);

  const parameters = Array.isArray(data.parameters)
    ? data.parameters
        .filter((x): x is Record<string, unknown> => !!x && typeof x === "object")
        .map((x) => ({
          name: String(x.name ?? ""),
          type: String(x.type ?? "string"),
          required: x.required !== false,
        }))
        .filter((x) => x.name)
    : [];

  const issues: string[] = [];
  if (!data.runtime) issues.push("no `runtime:` — nothing says how to execute it");
  if (!data.computation && !String(data.type)) issues.push("no computation declared");
  if (!attester.resource) issues.push("no `attester.resource` — nothing can check the run");
  // The decisive one, and it is the spec's own limitation rather than a
  // defect in the bundle.
  issues.push(
    "no verdict available — OKF defers the receipt and verdict wire formats to a future revision, " +
      "so this computation cannot be attested by any consumer yet",
  );

  return {
    runtime: String(data.runtime ?? ""),
    parameters,
    computation: typeof data.computation === "string" ? data.computation : null,
    executorResource: executor.resource ? String(executor.resource) : null,
    receiptFields: Array.isArray(executor.receipt) ? executor.receipt.map(String) : [],
    attesterResource: attester.resource ? String(attester.resource) : null,
    attestationIssues: issues,
  };
}

/**
 * The signals that decide whether a concept is worth opening: who produced it,
 * and whether anyone has confirmed it.
 *
 * v0.2's argument for putting these in frontmatter is that most interactions
 * with a concept never reach its body — a consumer first has to judge relevance
 * and trustworthiness, and should be able to do that without paying for prose.
 * That only works if the signals actually reach the index. `generated` was
 * parsed and stored here and then surfaced nowhere, so on disk an agent's
 * invention and a person's verified note were distinguishable and at the moment
 * of choosing between them they were not — which is the problem the field was
 * added to solve.
 *
 * Only the machine case is named. A person writing is the default assumption,
 * and a mark on every line costs tokens on the one thing whose whole job is to
 * be cheap to scan.
 *
 * One definition, used by both index builders. They render different prose
 * around it on purpose — the memory index speaks to a model mid-run — but they
 * must not disagree about what the signals *are*.
 */
export function provenanceMarks(
  doc: Pick<OkfDoc, "generatedBy" | "trust"> & { verifiedAt?: string | null },
): string[] {
  const marks: string[] = [];
  // "machine", not "agent": `process:` is neither a person nor an agent, and
  // the decision it drives is the same one — a person did not write this.
  if (doc.generatedBy && doc.generatedBy !== UNKNOWN_ACTOR && !isHumanActor(doc.generatedBy)) {
    marks.push("machine-written");
  }
  // Always stated, including the positive tiers. Marking only the bad case
  // meant a human-reviewed fact and an unreviewed one were both rendered by
  // saying nothing, so trust could not be filtered on — only its absence.
  //
  // Dated where the bundle dated it, because "reviewed" answers a weaker
  // question than it looks like it answers: a fact checked in 2019 and one
  // checked last week are not the same claim, and the tier alone conflates
  // them. The day is enough — the hour never changes a decision here.
  marks.push(doc.verifiedAt ? `${doc.trust} ${doc.verifiedAt.slice(0, 10)}` : doc.trust);
  return marks;
}

/** Derived, never stored — the spec is explicit that consumers compute this. */
export function trustTier(verifiedBy: string[]): TrustTier {
  if (verifiedBy.length === 0) return "unverified";
  return verifiedBy.some(isHumanActor) ? "human-reviewed" : "machine-confirmed";
}

/**
 * A date from frontmatter, as `YYYY-MM-DD`.
 *
 * YAML parses an unquoted `2026-12-31` into a Date, not a string — which is
 * how the spec's own examples are written. Every date field here tested for
 * `typeof === "string"`, so the canonical spelling was silently discarded:
 * `stale_after: 2026-12-31` set no expiry at all, and nothing reported that a
 * declared one had been dropped. Quoting it happened to work, which is why it
 * survived: the tests wrote `"2026-12-31"` and the spec does not.
 */
/**
 * The spec's date shapes: `YYYY-MM-DD` for a day, ISO 8601 for an instant.
 * Anything else is not a date this platform will compare.
 */
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/;

/**
 * A date from frontmatter, normalised, or null if it is not one.
 *
 * Null rather than the raw string, because every use of these values compares
 * them: `stale` is `today >= stale_after`, and `latestAt` picks the most recent
 * verification with `>`. Both are string comparisons that are only meaningful
 * on ISO. Keeping whatever was written meant `at: yesterday` sorted above every
 * real timestamp — lowercase letters beat digits — so one sloppy value silently
 * made "most recently verified" return the wrong entry, and the index rendered
 * "human-reviewed yesterday".
 *
 * A dropped value is reported by dateIssues(), never swallowed.
 */
function isoDay(value: unknown): string | null {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  const s = typeof value === "string" ? value.trim() : "";
  if (!s) return null;
  if (ISO_DAY.test(s)) return s;
  // A full instant where a day was expected is the author being more precise
  // than asked, not an error.
  if (ISO_INSTANT.test(s)) return s.slice(0, 10);
  return null;
}

/** As isoDay, but keeps the time when one was given — `timestamp` is an instant. */
function isoInstant(value: unknown): string | null {
  if (value instanceof Date) return value.toISOString();
  const s = typeof value === "string" ? value.trim() : "";
  if (!s) return null;
  if (ISO_INSTANT.test(s)) {
    const t = Date.parse(s);
    return Number.isNaN(t) ? null : new Date(t).toISOString();
  }
  // A bare day is a valid instant — midnight UTC, which is what YAML's own
  // unquoted date form produces.
  if (ISO_DAY.test(s)) return `${s}T00:00:00.000Z`;
  return null;
}

/** Was something written here that isoDay/isoInstant refused? */
const isUnusableDate = (value: unknown): boolean =>
  value !== undefined &&
  value !== null &&
  value !== "" &&
  !(value instanceof Date) &&
  isoInstant(value) === null;

/**
 * An actor and when it acted — `{ by: human:kliu@acme, at: 2026-07-01T16:00Z }`.
 *
 * `at` is the difference between a fact somebody checked last week and one
 * somebody checked in 2019. Both used to read as "human-reviewed", which makes
 * the tier answer a weaker question than it appears to: not "can I rely on
 * this" but "did anyone ever look".
 */
export interface OkfActor {
  by: string;
  at: string | null;
}

/**
 * A `{ from, to }` date range, or undefined.
 *
 * Through isoDay for the same reason every other date here is: YAML hands back
 * a Date for the unquoted form the spec writes, and String() on one produces
 * "Mon Jun 15 2026 10:00:00 GMT+1000" — a value nothing can compare or sort.
 */
function usageWindow(value: unknown): { from?: string; to?: string } | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  const from = isoDay(raw.from) ?? undefined;
  const to = isoDay(raw.to) ?? undefined;
  return from || to ? { from, to } : undefined;
}

function actorList(value: unknown): OkfActor[] {
  const list = Array.isArray(value) ? value : value ? [value] : [];
  return list.flatMap((v): OkfActor[] => {
    // The spec's form is a mapping; a bare string is accepted too, since a
    // producer that only knows who — not when — should not be unreadable.
    if (v && typeof v === "object") {
      const by = (v as { by?: unknown }).by;
      return typeof by === "string" && by
        ? [{ by, at: isoInstant((v as { at?: unknown }).at) }]
        : [];
    }
    return typeof v === "string" && v ? [{ by: v, at: null }] : [];
  });
}

/** The most recent `at` among these actors, or null if none carried one. */
export function latestAt(list: OkfActor[]): string | null {
  return list.reduce<string | null>((best, a) => (a.at && (!best || a.at > best) ? a.at : best), null);
}

export function readDoc(dir: string, file: string, today = new Date()): OkfDoc | null {
  try {
    const { data } = matter(fs.readFileSync(path.join(dir, file), "utf8"));
    const staleAfter = isoDay(data.stale_after);
    const verified = actorList(data.verified);
    const verifiedBy = verified.map((a) => a.by);
    const generated = data.generated && typeof data.generated === "object" ? data.generated : null;
    const status: OkfStatus = ["draft", "stable", "deprecated"].includes(String(data.status))
      ? (data.status as OkfStatus)
      : "stable"; // the spec's default when absent
    return {
      file,
      type: typeof data.type === "string" ? data.type.trim() : "",
      // OKF names it `title`; we've always used `name`. Both are read, so a
      // bundle from either world works untouched.
      title: String(data.title ?? data.name ?? file.replace(/\.md$/, "")),
      description: String(data.description ?? ""),
      tags: Array.isArray(data.tags) ? data.tags.map(String) : [],
      status,
      staleAfter,
      stale: staleAfter ? today.toISOString().slice(0, 10) >= staleAfter : false,
      // A v0.1 document has no `generated`; the spec allows falling back to the
      // legacy `timestamp` so an older bundle still reports when it was made.
      generatedBy: generated
        ? String((generated as { by?: unknown }).by ?? "") || null
        : isoInstant(data.timestamp)
          ? UNKNOWN_ACTOR
          : null,
      // A v0.1 document has no `generated.at`, but its `timestamp` said the
      // same thing, so an older bundle still reports when it was made.
      generatedAt: generated
        ? isoInstant((generated as { at?: unknown }).at)
        : isoInstant(data.timestamp),
      verified,
      verifiedBy,
      verifiedAt: latestAt(verified),
      trust: trustTier(verifiedBy),
      resource: typeof data.resource === "string" ? data.resource : null,
      timestamp: isoInstant(data.timestamp),
      computation: parseComputation(data),
      sources: Array.isArray(data.sources)
        ? data.sources
            .filter((s): s is Record<string, unknown> => !!s && typeof s === "object")
            .map((s) => ({
              resource: String(s.resource ?? ""),
              id: s.id ? String(s.id) : undefined,
              title: s.title ? String(s.title) : undefined,
              author: s.author ? String(s.author) : undefined,
              usageCount: typeof s.usage_count === "number" ? s.usage_count : undefined,
              lastModified: isoDay(s.last_modified) ?? undefined,
              // Per the spec, an entry's own window overrides the document's,
              // and an entry without one inherits it. Reading only the entry's
              // meant a shared window declared once at the top applied to
              // nothing, so every usage_count it framed was left unframed.
              usageWindow: usageWindow(s.usage_window) ?? usageWindow(data.usage_window),
            }))
            .filter((s) => s.resource)
        : [],
    };
  } catch {
    return null;
  }
}

/**
 * Every concept in a bundle, including nested directories — Google's own
 * example is a tree (`sales/tables/orders.md`), and the path is the identity.
 * @param depth guards against a pathological tree; bundles are documentation,
 *              not filesystems.
 */
export function readBundle(dir: string, today = new Date(), prefix = "", depth = 0): OkfDoc[] {
  if (!fs.existsSync(dir) || depth > 6) return [];
  const out: OkfDoc[] = [];
  for (const entry of fs.readdirSync(dir).sort()) {
    const full = path.join(dir, entry);
    let stat;
    try {
      stat = fs.statSync(full);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      out.push(...readBundle(full, today, `${prefix}${entry}/`, depth + 1));
    } else if (entry.endsWith(".md") && !NOT_A_CONCEPT.has(entry)) {
      const doc = readDoc(dir, entry, today);
      if (doc) out.push({ ...doc, file: `${prefix}${entry}` });
    }
  }
  return out;
}

/** Immediate children of one level, for that level's own index.md. */
function levelDocs(dir: string, today = new Date()): OkfDoc[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".md") && !NOT_A_CONCEPT.has(f))
    .sort()
    .map((f) => readDoc(dir, f, today))
    .filter((d): d is OkfDoc => d !== null);
}

/**
 * Files that would fail somebody else's conformance check, with the reason.
 *
 * Deliberately walks the directory rather than readBundle(): readBundle answers
 * "what should this platform show", and the two questions differ by exactly the
 * files we chose not to display. A validator that isn't ours applies the spec's
 * reserved set, so this one has to as well — otherwise the check agrees with us
 * about a bundle a consumer will reject.
 */
export function conformanceIssues(
  dir: string,
  prefix = "",
  depth = 0,
): { file: string; issue: string }[] {
  if (!fs.existsSync(dir) || depth > 6) return [];
  const out: { file: string; issue: string }[] = [];

  for (const entry of fs.readdirSync(dir).sort()) {
    const full = path.join(dir, entry);
    let stat;
    try {
      stat = fs.statSync(full);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      out.push(...conformanceIssues(full, `${prefix}${entry}/`, depth + 1));
      continue;
    }
    if (!entry.endsWith(".md") || OKF_RESERVED.has(entry)) continue;

    const file = `${prefix}${entry}`;
    let data: Record<string, unknown>;
    try {
      ({ data } = matter(fs.readFileSync(full, "utf8")) as { data: Record<string, unknown> });
    } catch {
      out.push({ file, issue: "frontmatter is not parseable YAML — OKF requires it to parse" });
      continue;
    }
    const type = typeof data.type === "string" ? data.type.trim() : "";
    if (!type) {
      out.push({
        file,
        issue: "missing `type:` — OKF requires a non-empty type on every concept",
      });
    }
  }
  return out;
}

/**
 * The bundle's index.md. Progressive disclosure, per the spec: headings and
 * bulleted links with descriptions, and no frontmatter — except `okf_version`
 * at a bundle root, which is the only place the spec permits it.
 */
export function buildIndex(
  docs: OkfDoc[],
  title: string,
  isRoot: boolean,
  children: string[] = [],
): string {
  const head = isRoot ? `---\nokf_version: "${OKF_VERSION}"\n---\n\n` : "";
  const sub = children.length
    ? `\n\n## Sections\n\n${children.map((c) => `- [${c}](${c}/index.md)`).join("\n")}`
    : "";
  if (docs.length === 0) return `${head}# ${title}${sub || "\n\nNothing here yet."}\n`;

  // Group by type — that's what makes the index useful to skim.
  const byType = new Map<string, OkfDoc[]>();
  for (const d of docs) byType.set(d.type || "Untyped", [...(byType.get(d.type || "Untyped") ?? []), d]);

  const sections = [...byType.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([type, list]) => {
      const lines = list.map((d) => {
        const marks = [
          d.status !== "stable" ? d.status : null,
          d.stale ? `stale since ${d.staleAfter}` : null,
          ...provenanceMarks(d),
          d.computation ? "UNATTESTED — output not checked against the contract" : null,
        ].filter(Boolean);
        return `- [${d.title}](${d.file})${d.description ? ` — ${d.description}` : ""}${
          marks.length ? ` _(${marks.join(", ")})_` : ""
        }`;
      });
      return `## ${type}\n\n${lines.join("\n")}`;
    });

  return `${head}# ${title}\n\n${sections.join("\n\n")}${sub}\n`;
}

/**
 * Write index.md for a bundle and for every directory inside it. The spec puts
 * an index at each level, so a nested bundle is navigable without a full walk.
 */
export function syncIndex(dir: string, title: string, isRoot = false, depth = 0) {
  if (!fs.existsSync(dir) || depth > 6) return;

  const here = levelDocs(dir);
  const children = fs
    .readdirSync(dir)
    .filter((e) => {
      try {
        return fs.statSync(path.join(dir, e)).isDirectory();
      } catch {
        return false;
      }
    })
    .sort();

  fs.writeFileSync(path.join(dir, "index.md"), buildIndex(here, title, isRoot, children));
  for (const child of children) {
    syncIndex(path.join(dir, child), child, false, depth + 1);
  }
}

/**
 * Dates the platform had to drop, with where they were.
 *
 * Deliberately not part of conformanceIssues. That function answers one
 * question — would an outside validator accept this bundle — and the spec's
 * three rules say nothing about the *shape* of a date, so a bad one is
 * conformant and still unusable here. Two questions, two functions, and the
 * conformance answer stays exactly the spec's.
 */
export function dateIssues(
  dir: string,
  prefix = "",
  depth = 0,
): { file: string; field: string; value: string }[] {
  if (!fs.existsSync(dir) || depth > 6) return [];
  const out: { file: string; field: string; value: string }[] = [];

  for (const entry of fs.readdirSync(dir).sort()) {
    const full = path.join(dir, entry);
    let stat;
    try {
      stat = fs.statSync(full);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      out.push(...dateIssues(full, `${prefix}${entry}/`, depth + 1));
      continue;
    }
    if (!entry.endsWith(".md") || OKF_RESERVED.has(entry)) continue;

    let data: Record<string, unknown>;
    try {
      ({ data } = matter(fs.readFileSync(full, "utf8")) as { data: Record<string, unknown> });
    } catch {
      continue; // unparseable frontmatter is conformanceIssues' to report
    }

    const file = `${prefix}${entry}`;
    const check = (field: string, value: unknown) => {
      if (isUnusableDate(value)) out.push({ file, field, value: String(value) });
    };
    const obj = (v: unknown) => (v && typeof v === "object" ? (v as Record<string, unknown>) : {});
    const list = (v: unknown) => (Array.isArray(v) ? v : v ? [v] : []);

    check("stale_after", data.stale_after);
    check("timestamp", data.timestamp);
    check("generated.at", obj(data.generated).at);
    check("usage_window.from", obj(data.usage_window).from);
    check("usage_window.to", obj(data.usage_window).to);

    list(data.verified).forEach((v, i) => check(`verified[${i}].at`, obj(v).at));
    list(data.sources).forEach((s, i) => {
      check(`sources[${i}].last_modified`, obj(s).last_modified);
      check(`sources[${i}].usage_window.from`, obj(obj(s).usage_window).from);
      check(`sources[${i}].usage_window.to`, obj(obj(s).usage_window).to);
    });
  }
  return out;
}

/**
 * Stamp provenance on every concept in a bundle an agent has just written to.
 *
 * Recursive, and it skips the spec's reserved names. Doing this by hand with a
 * flat readdir and an `!== "index.md"` filter missed every concept in a nested
 * section, and — worse — stamped `log.md`, writing a concept's frontmatter onto
 * a reserved file that §9 gives its own structure. Nothing reported that,
 * because a conformance check skips reserved names by definition: the file
 * ends up malformed in a way only its readers notice.
 *
 * Returns the bundle-relative paths it stamped, so the caller can record each
 * one in the log. Returning a bare boolean meant the caller had nothing to
 * name, so it re-synced the index and wrote no log entry at all — and a run
 * that taught the agent something left no trace in the one file whose job is
 * to say what changed and when.
 */
export function stampBundle(
  dir: string,
  agent: string | null,
  at = new Date(),
  prefix = "",
  depth = 0,
): string[] {
  if (!fs.existsSync(dir) || depth > 6) return [];
  const stamped: string[] = [];

  for (const entry of fs.readdirSync(dir).sort()) {
    const full = path.join(dir, entry);
    let stat;
    try {
      stat = fs.statSync(full);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      stamped.push(...stampBundle(full, agent, at, `${prefix}${entry}/`, depth + 1));
      continue;
    }
    if (!entry.endsWith(".md") || OKF_RESERVED.has(entry)) continue;
    if (stampGenerated(full, agent, at)) stamped.push(`${prefix}${entry}`);
  }
  return stamped;
}

/**
 * Make every OKF bundle in a workspace a bundle.
 *
 * A concept file with a `type` is conformant on its own, but a *bundle* is
 * only self-describing once its root index.md exists to carry `okf_version`.
 * Both scaffold paths wrote their starter files straight to disk, so a new
 * workspace's knowledge/ was a directory of valid concepts and nothing that
 * said which version of the format they were written against — the one thing
 * a consumer reads first.
 *
 * An agent's own pair is nested rather than a root, so it gets an index
 * without a version, which is what the spec permits.
 */
export function syncWorkspaceBundles(root: string): void {
  const sync = (dir: string, kind: "knowledge" | "memory", isRoot: boolean) => {
    if (!fs.existsSync(dir)) return;
    // An index for a bundle holding nothing is a file whose entire content is
    // "nothing here yet" — true, and noise in a repository. index.md is
    // optional in the spec, so there is no reason to write one before there is
    // something to list. An agent's empty memory/ is the common case, and it
    // put three of these into the examples before anyone looked.
    if (readBundle(dir).length === 0) return;
    syncIndex(dir, kind === "memory" ? "Memory" : "Knowledge", isRoot);
  };

  for (const kind of ["knowledge", "memory"] as const) {
    sync(path.join(root, kind), kind, true);
  }

  const agentsDir = path.join(root, "agents");
  if (!fs.existsSync(agentsDir)) return;
  for (const agent of fs.readdirSync(agentsDir)) {
    for (const kind of ["knowledge", "memory"] as const) {
      sync(path.join(agentsDir, agent, kind), kind, false);
    }
  }
}

/**
 * log.md — the bundle's change history. The spec asks for date-grouped
 * entries, newest first, ISO 8601 headings, with the **Creation** / **Update**
 * convention. Appending here means the history is a real artifact rather than
 * something you reconstruct from git.
 */
export function appendLog(dir: string, file: string, kind: "Creation" | "Update", at = new Date()) {
  if (!fs.existsSync(dir)) return;
  const day = at.toISOString().slice(0, 10);
  const entry = `- **${kind}** [${file.replace(/\.md$/, "")}](${file})`;
  const logFile = path.join(dir, "log.md");

  let body = fs.existsSync(logFile) ? fs.readFileSync(logFile, "utf8") : "# Log\n";
  if (body.includes(`## ${day}`)) {
    // Same day: add the line under today's heading, skipping exact repeats.
    const lines = body.split("\n");
    const at_ = lines.indexOf(`## ${day}`);
    const next = lines.findIndex((l, i) => i > at_ && l.startsWith("## "));
    const end = next === -1 ? lines.length : next;
    if (!lines.slice(at_, end).includes(entry)) lines.splice(at_ + 2, 0, entry);
    body = lines.join("\n");
  } else {
    // A new day goes directly under the title — newest first.
    const [title, ...rest] = body.split("\n");
    body = [title, "", `## ${day}`, "", entry, ...rest].join("\n");
  }
  fs.writeFileSync(logFile, body.replace(/\n{3,}/g, "\n\n"));
}

/**
 * Stamp provenance on a file that doesn't declare it. Used after a run so a
 * memory an agent wrote is attributable — without this, a fact the model
 * invented and a fact a person verified are indistinguishable on disk.
 */
export function stampGenerated(
  file: string,
  agent: string | null,
  at = new Date(),
): boolean {
  try {
    const raw = fs.readFileSync(file, "utf8");
    const parsed = matter(raw);
    if (parsed.data.generated) return false; // never overwrite a real claim
    // `by` follows the spec's actor convention; which agent wrote it is kept
    // as an extension key, which the spec explicitly permits.
    //
    // Null where a run had several agents and the file is at workspace scope:
    // any one of them could have written it, and naming a guess is worse than
    // saying only what is known — that a machine produced it.
    parsed.data.generated = {
      by: PRODUCER,
      at: at.toISOString(),
      ...(agent ? { agent } : {}),
    };

    // Agents write `name:` whether or not you ask them to — a real run did it
    // one line after being told to add no frontmatter at all. It reads fine
    // here, because readDoc falls back to it, and reads as a slug to anyone
    // else, because OKF has no such field. A bundle carries the format's
    // vocabulary, so the key is moved rather than left to mean nothing.
    if (!parsed.data.title && typeof parsed.data.name === "string") {
      parsed.data.title = parsed.data.name;
      delete parsed.data.name;
    }
    if (!parsed.data.type) parsed.data.type = "Memory";
    fs.writeFileSync(file, matter.stringify(parsed.content, parsed.data));
    return true;
  } catch {
    return false;
  }
}
