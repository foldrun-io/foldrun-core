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
//   generated: { by: producer/mdagent }   → a fact an agent wrote
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
export const PRODUCER = "mdagent/0.1.0";

/** Reserved filenames the spec gives structure to, not concepts. */
const RESERVED = new Set(["index.md", "log.md", "MEMORY.md"]);

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
  verifiedBy: string[];
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

/** Derived, never stored — the spec is explicit that consumers compute this. */
export function trustTier(verifiedBy: string[]): TrustTier {
  if (verifiedBy.length === 0) return "unverified";
  return verifiedBy.some((a) => a.startsWith("human:")) ? "human-reviewed" : "machine-confirmed";
}

function actors(value: unknown): string[] {
  const list = Array.isArray(value) ? value : value ? [value] : [];
  return list
    .map((v) => (v && typeof v === "object" ? (v as { by?: unknown }).by : v))
    .filter((v): v is string => typeof v === "string" && v.length > 0);
}

export function readDoc(dir: string, file: string, today = new Date()): OkfDoc | null {
  try {
    const { data } = matter(fs.readFileSync(path.join(dir, file), "utf8"));
    const staleAfter = typeof data.stale_after === "string" ? data.stale_after : null;
    const verifiedBy = actors(data.verified);
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
      generatedBy:
        data.generated && typeof data.generated === "object"
          ? String((data.generated as { by?: unknown }).by ?? "") || null
          : typeof data.timestamp === "string"
            ? "unknown (v0.1 timestamp)"
            : null,
      verifiedBy,
      trust: trustTier(verifiedBy),
      resource: typeof data.resource === "string" ? data.resource : null,
      timestamp: typeof data.timestamp === "string" ? data.timestamp : null,
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
              lastModified: s.last_modified ? String(s.last_modified) : undefined,
              usageWindow:
                s.usage_window && typeof s.usage_window === "object"
                  ? {
                      from: (s.usage_window as Record<string, unknown>).from
                        ? String((s.usage_window as Record<string, unknown>).from)
                        : undefined,
                      to: (s.usage_window as Record<string, unknown>).to
                        ? String((s.usage_window as Record<string, unknown>).to)
                        : undefined,
                    }
                  : undefined,
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
    } else if (entry.endsWith(".md") && !RESERVED.has(entry)) {
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
    .filter((f) => f.endsWith(".md") && !RESERVED.has(f))
    .sort()
    .map((f) => readDoc(dir, f, today))
    .filter((d): d is OkfDoc => d !== null);
}

/** Files that would fail a conformance check, with the reason. */
export function conformanceIssues(dir: string): { file: string; issue: string }[] {
  return readBundle(dir)
    .filter((d) => !d.type)
    .map((d) => ({
      file: d.file,
      issue: "missing `type:` — OKF requires a non-empty type on every concept",
    }));
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
          d.trust === "unverified" ? "unverified" : null,
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
export function stampGenerated(file: string, agent: string, at = new Date()): boolean {
  try {
    const raw = fs.readFileSync(file, "utf8");
    const parsed = matter(raw);
    if (parsed.data.generated) return false; // never overwrite a real claim
    // `by` follows the spec's actor convention; which agent wrote it is kept
    // as an extension key, which the spec explicitly permits.
    parsed.data.generated = { by: PRODUCER, at: at.toISOString(), agent };
    if (!parsed.data.type) parsed.data.type = "Memory";
    fs.writeFileSync(file, matter.stringify(parsed.content, parsed.data));
    return true;
  } catch {
    return false;
  }
}
