// Every change to a workspace, kept.
//
// A workspace is a few hundred kilobytes of markdown, and until now the only
// record of a change was the file after it. A save from the dashboard, a
// deploy from git, an agent writing memory — each overwrote what was there
// and nothing remembered the before. Two things were impossible as a result:
// answering "what did this look like yesterday", and attributing a change in
// an eval score to the change in a file that caused it.
//
// So every write records a REVISION: what changed, from what, to what, by
// whom, and why. A deploy from git records one revision for the whole push
// with the commit as its id; a dashboard save records one for the file with
// a local id. Observe attributes eval scores to revision ids, so the "this
// change made it worse" table works for a workspace that has never seen a
// git repository — and when one is connected later, its commits slot into
// the same series.
//
// No git binary, no working copy, no repository on the server. The platform
// image deliberately has none (deploy.ts explains why); this is a journal of
// content, which is all the questions above need. Connecting a repository
// is a separate step and pushes THIS history out, not the other way round.
//
// Storage: <data>/<tenant>/.history/<scope>/<id>.json, one file per revision,
// plus index.jsonl — one line each, newest last — so listing does not open
// every revision. Content is stored inline: the files are small, and a
// content-addressed store would be machinery in search of a problem.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { dataRoot } from "./paths.ts";

// Not store's assertSafeName: store imports this module, and a cycle between
// the two is avoidable for one regex.
function assertSafeName(v: string, what: string) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._@-]{0,120}$/.test(v)) throw new Error(`illegal ${what}: ${v}`);
}

export interface RevisionFile {
  path: string;
  /** Null when the file did not exist before. */
  before: string | null;
  /** Null when the change deleted it. */
  after: string | null;
}

export interface Revision {
  id: string;
  at: string;
  /** Who: a signed-in email, "api-key", "agent:<name>", "deploy", "system". */
  by: string;
  message: string;
  /** Set when this revision IS a git commit — a deploy from a push. */
  commit: string | null;
  files: RevisionFile[];
}

/** The index line: everything but the content. */
export interface RevisionSummary {
  id: string;
  at: string;
  by: string;
  message: string;
  commit: string | null;
  paths: string[];
}

/** Anything over this is not a document and is recorded by name only. */
const MAX_INLINE = 256 * 1024;

const historyDir = (tenant: string, scope: string) => {
  assertSafeName(tenant, "tenant");
  // "@library" for the account shelf; a workspace name otherwise.
  if (scope !== "@library") assertSafeName(scope, "workspace");
  return path.join(dataRoot(), tenant, ".history", scope);
};

/** A local revision id: sortable by time, unique enough, visibly not a sha. */
export function newRevisionId(now = new Date()): string {
  return `r-${now.getTime().toString(36)}-${crypto.randomBytes(3).toString("hex")}`;
}

/**
 * Record one change set. Called by the writers, never by hand.
 *
 * Returns null and records nothing when nothing actually changed — a save
 * of identical content is not a revision, and a history full of "no change"
 * entries is a history nobody reads.
 */
export function recordRevision(
  tenant: string,
  scope: string,
  files: RevisionFile[],
  meta: { by?: string; message?: string; id?: string; commit?: string | null } = {},
): Revision | null {
  const changed = files.filter((f) => f.before !== f.after);
  if (changed.length === 0) return null;

  const dir = historyDir(tenant, scope);
  fs.mkdirSync(dir, { recursive: true });
  const rev: Revision = {
    id: meta.id ?? meta.commit ?? newRevisionId(),
    at: new Date().toISOString(),
    by: meta.by ?? "system",
    message: meta.message ?? describe(changed),
    commit: meta.commit ?? null,
    files: changed.map((f) => ({
      path: f.path,
      before: clip(f.before),
      after: clip(f.after),
    })),
  };
  assertSafeName(rev.id, "revision id");
  fs.writeFileSync(path.join(dir, `${rev.id}.json`), JSON.stringify(rev));
  const line: RevisionSummary = {
    id: rev.id,
    at: rev.at,
    by: rev.by,
    message: rev.message,
    commit: rev.commit,
    paths: rev.files.map((f) => f.path),
  };
  fs.appendFileSync(path.join(dir, "index.jsonl"), `${JSON.stringify(line)}\n`);
  return rev;
}

const clip = (s: string | null) =>
  s === null ? null : s.length > MAX_INLINE ? `[${s.length} bytes — too large to keep inline]` : s;

/** "edited tools/x/run.py", "created 3 files", "deleted flows/old.md". */
function describe(files: RevisionFile[]): string {
  if (files.length === 1) {
    const f = files[0];
    const verb = f.before === null ? "created" : f.after === null ? "deleted" : "edited";
    return `${verb} ${f.path}`;
  }
  const created = files.filter((f) => f.before === null).length;
  const deleted = files.filter((f) => f.after === null).length;
  const edited = files.length - created - deleted;
  return [edited && `edited ${edited}`, created && `created ${created}`, deleted && `deleted ${deleted}`]
    .filter(Boolean)
    .join(", ") + ` file${files.length === 1 ? "" : "s"}`;
}

/** Newest first. `forPath` narrows to revisions that touched one file. */
export function listRevisions(
  tenant: string,
  scope: string,
  opts: { forPath?: string; limit?: number } = {},
): RevisionSummary[] {
  const file = path.join(historyDir(tenant, scope), "index.jsonl");
  if (!fs.existsSync(file)) return [];
  const all = fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .flatMap((l) => {
      try {
        return [JSON.parse(l) as RevisionSummary];
      } catch {
        return []; // a torn line from a crash mid-append loses one entry, not the file
      }
    })
    .reverse();
  const narrowed = opts.forPath ? all.filter((r) => r.paths.includes(opts.forPath!)) : all;
  return narrowed.slice(0, opts.limit ?? 200);
}

export function readRevision(tenant: string, scope: string, id: string): Revision | null {
  assertSafeName(id, "revision id");
  const file = path.join(historyDir(tenant, scope), `${id}.json`);
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, "utf8")) as Revision;
}

/** The most recent revision id for a scope — what a change is attributed
 *  to when nothing more specific (a deployed commit) is on record. */
export function latestRevisionId(tenant: string, scope: string): string | null {
  return listRevisions(tenant, scope, { limit: 1 })[0]?.id ?? null;
}

// ------------------------------------------------------------------- diff

export type DiffOp = { kind: "same" | "add" | "del"; text: string };

/**
 * A line diff, for showing a revision. Plain LCS — quadratic, and fine: the
 * files are documents, not generated code, and a diff of two 300-line files
 * is ninety thousand cells, which is nothing.
 */
export function diffLines(before: string, after: string): DiffOp[] {
  const a = before.split("\n");
  const b = after.split("\n");
  const n = a.length;
  const m = b.length;
  // lcs[i][j] = length of the LCS of a[i..] and b[j..]
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const out: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ kind: "same", text: a[i] });
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      out.push({ kind: "del", text: a[i] });
      i++;
    } else {
      out.push({ kind: "add", text: b[j] });
      j++;
    }
  }
  while (i < n) out.push({ kind: "del", text: a[i++] });
  while (j < m) out.push({ kind: "add", text: b[j++] });
  return out;
}
