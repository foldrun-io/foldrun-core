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
// No git. This is a journal of content plus a snapshot of the whole tree at
// every revision — the platform's own deploy history, the way Vercel and
// Cloudflare keep theirs: rollback and restore point back to a snapshot and
// never need a repository. A customer's code history belongs in their own
// GitHub or GitLab, connected later, and is a separate thing. (Until 17 Oct
// 2026 this preferred a bare git repository per workspace whenever a git
// binary existed; that git is gone, and history started fresh from a
// baseline snapshot.)
//
// Storage, under <data>/<tenant>/.history/<scope>/:
//   <id>.json      one revision: what changed, from what, to what (inline,
//                  clipped at 256 KB — what the history page diffs)
//   index.jsonl    one line per revision, newest last, so listing opens none
//   trees/<id>.json  the whole tree right after it: { path: sha256 }
//   blobs/<aa>/<sha256>  each version of a file, once — content-addressed,
//                  because a snapshot per save is mostly files that did not
//                  change, and storing them again would be the whole tree
//                  per save.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { dataRoot } from "./paths.ts";

/**
 * The current tree of a scope, so the first commit can be a full import.
 *
 * Registered by the modules that know how to list a workspace or the library
 * (store.ts, library.ts), because this module cannot import them — they
 * import it. A revision recorded before any commit exists imports the whole
 * tree rather than committing one file into an empty repository, so a clone
 * made a minute later has everything.
 */
type TreeReader = (tenant: string, scope: string) => RevisionFile[] | null;
let readTree: TreeReader = () => null;
export function registerTreeReader(fn: TreeReader) {
  const prev = readTree;
  readTree = (tenant, scope) => fn(tenant, scope) ?? prev(tenant, scope);
}

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
  // The tree as it stands now (the writer has already written), so this
  // revision can be restored to exactly — including files a save rewrote
  // outside this call, such as a bundle's generated index.
  snapshot(tenant, scope, rev.id);
  fs.appendFileSync(path.join(dir, "index.jsonl"), `${JSON.stringify(line)}\n`);
  return rev;
}

// ----------------------------------------------------------------- snapshots

const sha256 = (s: string) => crypto.createHash("sha256").update(s).digest("hex");
const treePath = (tenant: string, scope: string, id: string) => path.join(historyDir(tenant, scope), "trees", `${id}.json`);
const blobPath = (tenant: string, scope: string, sha: string) => path.join(historyDir(tenant, scope), "blobs", sha.slice(0, 2), sha);

/** Write the scope's whole tree as revision `id`'s snapshot. False when there
 *  is no tree to read (a workspace being deleted).
 *
 *  What a snapshot is: the tree as it stood just after this revision was
 *  written — point in time, which is what a restore wants. A revision's
 *  diff names only its own change; its snapshot is everything on disk at
 *  that moment, including another writer's change that landed in between,
 *  part of one if it was mid-write (saves are not transactional across
 *  files, and never were). Reviewed with Codex, 17 Oct 2026. */
function snapshot(tenant: string, scope: string, id: string): boolean {
  const tree = readTree(tenant, scope);
  if (!tree) return false;
  const files: Record<string, string> = {};
  for (const f of tree) {
    if (f.after === null) continue;
    const sha = sha256(f.after);
    const blob = blobPath(tenant, scope, sha);
    if (!fs.existsSync(blob)) {
      fs.mkdirSync(path.dirname(blob), { recursive: true });
      const tmp = `${blob}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, f.after);
      fs.renameSync(tmp, blob);
    }
    files[f.path] = sha;
  }
  const file = treePath(tenant, scope, id);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ v: 1, files }));
  fs.renameSync(tmp, file);
  return true;
}

/** Whether a revision can be restored to: it has a snapshot. */
export function hasSnapshot(tenant: string, scope: string, id: string): boolean {
  assertSafeName(id, "revision id");
  return fs.existsSync(treePath(tenant, scope, id));
}

/** The whole tree at revision `id`, or null when it has no snapshot. */
export function snapshotAt(tenant: string, scope: string, id: string): { path: string; content: string }[] | null {
  assertSafeName(id, "revision id");
  let manifest: { v: number; files: Record<string, string> };
  try {
    manifest = JSON.parse(fs.readFileSync(treePath(tenant, scope, id), "utf8"));
  } catch {
    return null;
  }
  return Object.entries(manifest.files ?? {})
    .map(([p, sha]) => ({ path: p, content: fs.readFileSync(blobPath(tenant, scope, sha), "utf8") }))
    .sort((a, b) => a.path.localeCompare(b.path));
}

/** Every revision of the scope that has a snapshot — one listing, rather
 *  than a stat per revision. */
function snapshotIds(tenant: string, scope: string): Set<string> {
  try {
    return new Set(fs.readdirSync(path.join(historyDir(tenant, scope), "trees")).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5)));
  } catch {
    return new Set();
  }
}

/** The newest revision that can be restored to — what "now" is in history. */
export function headRevision(tenant: string, scope: string): RevisionSummary | null {
  const have = snapshotIds(tenant, scope);
  return journalRevisions(tenant, scope, { limit: Infinity }).find((r) => have.has(r.id)) ?? null;
}

/**
 * A scope with no snapshot yet gets one: its tree as it stands, recorded as
 * a revision of its own — where its history starts. Every workspace that
 * existed when history moved off git starts here, and so does one created
 * by a path that never recorded a change. Returns the head's id, or null
 * when there is nothing to snapshot.
 */
export function ensureBaseline(tenant: string, scope: string, by = "foldrun"): string | null {
  const head = headRevision(tenant, scope);
  if (head) return head.id;
  const tree = readTree(tenant, scope);
  if (!tree || tree.length === 0) return null;
  const dir = historyDir(tenant, scope);
  fs.mkdirSync(dir, { recursive: true });
  const id = newRevisionId();
  // One baseline even when the web tier and the worker both find none at
  // once: whoever creates the marker first writes it, the other reads it.
  const marker = path.join(dir, ".baseline");
  try {
    fs.writeFileSync(marker, id, { flag: "wx" });
  } catch {
    const held = headRevision(tenant, scope)?.id ?? null;
    // A marker with no baseline behind it, minutes old, is a process that
    // died writing one: clear it, and the next call writes the baseline.
    try {
      if (!held && Date.now() - fs.statSync(marker).mtimeMs > 5 * 60_000) fs.rmSync(marker, { force: true });
    } catch {
      // gone already
    }
    return held;
  }
  const rev: Revision = {
    id,
    at: new Date().toISOString(),
    by,
    message: "history starts here",
    commit: null,
    files: [],
  };
  fs.writeFileSync(path.join(dir, `${rev.id}.json`), JSON.stringify(rev));
  if (!snapshot(tenant, scope, rev.id)) return null;
  const line: RevisionSummary = { id: rev.id, at: rev.at, by: rev.by, message: rev.message, commit: null, paths: [] };
  fs.appendFileSync(path.join(dir, "index.jsonl"), `${JSON.stringify(line)}\n`);
  return rev.id;
}

/**
 * The revision a restore means: an id (or the commit a deploy recorded), a
 * date (`2026-10-17`, `2026-10-17T09:00Z`) or a span back from now (`90m`,
 * `12h`, `3d`, `2w`) — the newest revision with a snapshot at or before that
 * moment. Null when history holds nothing that old. Throws (status 400) on
 * something that is none of those.
 */
export function resolveRevision(
  tenant: string,
  scope: string,
  to: string,
  now = Date.now(),
): { id: string; at: string; by: string; message: string } | null {
  const t = to.trim();
  if (!t || t.startsWith("-")) throw Object.assign(new Error(`not a revision or a time: ${to}`), { status: 400 });
  const have = snapshotIds(tenant, scope);
  const all = journalRevisions(tenant, scope, { limit: Infinity }).filter((r) => have.has(r.id));
  const rel = /^(\d+)\s*(m|h|d|w)$/.exec(t);
  const moment = rel
    ? now - Number(rel[1]) * { m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 }[rel[2] as "m" | "h" | "d" | "w"]
    : /^\d{4}-\d{2}-\d{2}/.test(t)
      ? Date.parse(t)
      : null;
  let hit: RevisionSummary | undefined;
  if (moment !== null) {
    if (Number.isNaN(moment)) throw Object.assign(new Error(`not a date: ${to}`), { status: 400 });
    hit = all.find((r) => Date.parse(r.at) <= moment);
  } else {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/.test(t)) throw Object.assign(new Error(`not a revision or a time: ${to}`), { status: 400 });
    hit = all.find((r) => r.id === t || r.commit === t || (t.length >= 7 && r.commit?.startsWith(t)));
  }
  return hit ? { id: hit.id, at: hit.at, by: hit.by, message: hit.message } : null;
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
  return journalRevisions(tenant, scope, opts);
}

function journalRevisions(
  tenant: string,
  scope: string,
  opts: { forPath?: string; limit?: number } = {},
): RevisionSummary[] {
  const dir = historyDir(tenant, scope);
  const file = path.join(dir, "index.jsonl");
  if (!fs.existsSync(dir)) return [];
  let all = fs.existsSync(file)
    ? fs
        .readFileSync(file, "utf8")
        .split("\n")
        .filter(Boolean)
        .flatMap((l) => {
          try {
            return [JSON.parse(l) as RevisionSummary];
          } catch {
            return []; // a torn line — the rebuild below brings it back
          }
        })
        .reverse()
    : [];
  // The revision files are the record; index.jsonl is a cache of them. An
  // append from two processes on NFS is not atomic across clients, and a
  // process can die between a revision's file and its line — so when the
  // two disagree, the index is rebuilt from the files.
  const recorded = fs.readdirSync(dir).filter((f) => f.endsWith(".json")).length;
  if (recorded !== new Set(all.map((r) => r.id)).size) all = rebuildIndex(dir);
  // A line appended just after a rebuild wrote it too: once each.
  const seen = new Set<string>();
  all = all.filter((r) => !seen.has(r.id) && seen.add(r.id));
  const narrowed = opts.forPath ? all.filter((r) => r.paths.includes(opts.forPath!)) : all;
  return narrowed.slice(0, opts.limit ?? 200);
}

/** index.jsonl again, from the revision files themselves, newest first. */
function rebuildIndex(dir: string): RevisionSummary[] {
  const rows: (RevisionSummary & { written: number })[] = [];
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith(".json")) continue;
    try {
      const file = path.join(dir, f);
      const rev = JSON.parse(fs.readFileSync(file, "utf8")) as Revision;
      rows.push({ id: rev.id, at: rev.at, by: rev.by, message: rev.message, commit: rev.commit, paths: rev.files.map((x) => x.path), written: fs.statSync(file).mtimeMs });
    } catch {
      // a revision half-written by a process that died: not one
    }
  }
  // Two saves in one millisecond share an `at`; the order they were written
  // in breaks the tie (an id's suffix is random, so it cannot).
  rows.sort((a, b) => a.at.localeCompare(b.at) || a.written - b.written || a.id.localeCompare(b.id));
  try {
    const tmp = path.join(dir, `index.jsonl.${process.pid}.tmp`);
    fs.writeFileSync(tmp, rows.map(({ written: _w, ...r }) => JSON.stringify(r) + "\n").join(""));
    fs.renameSync(tmp, path.join(dir, "index.jsonl"));
  } catch {
    // a read-only volume still gets the answer
  }
  return rows.map(({ written: _w, ...r }) => r).reverse();
}

export function readRevision(tenant: string, scope: string, id: string, forPath?: string): Revision | null {
  assertSafeName(id, "revision id");
  const file = path.join(historyDir(tenant, scope), `${id}.json`);
  if (!fs.existsSync(file)) return null;
  const rev = JSON.parse(fs.readFileSync(file, "utf8")) as Revision;
  return forPath ? { ...rev, files: rev.files.filter((f) => f.path === forPath) } : rev;
}

/** The files changed after revision `from` up to and including `to`, in a
 *  scope — what differs between the versions two runs ran (FOL-72). Null
 *  when either is unknown or `to` is not after `from`. */
export function changedPathsBetween(tenant: string, scope: string, from: string | null, to: string | null): string[] | null {
  if (!from || !to) return null;
  if (from === to) return [];
  const revs = listRevisions(tenant, scope, { limit: 500 }); // newest first
  const ti = revs.findIndex((r) => r.id === to || r.commit === to);
  const fi = revs.findIndex((r) => r.id === from || r.commit === from);
  if (ti < 0 || fi < 0 || ti > fi) return null;
  return [...new Set(revs.slice(ti, fi).flatMap((r) => r.paths))].sort();
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
