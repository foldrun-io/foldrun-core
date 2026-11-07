// Workspaces as revisions (FOL-126, phase 3 — first slice).
//
// What this is: the bridge between the writers that exist (they change the
// workspace folder and call history.ts recordRevision) and the revision store
// of phase 1 (heads, manifests, blobs, the publish protocol).
//
//   write path ──► history.recordRevision ──► journalChange ──► [journal]
//                                                                  │ flushRevisions / background drain
//                                                                  ▼
//                           publish(): upload blobs, fold onto the head, ONE commit
//
// Every writer — dashboard saves, /source PUT/PATCH/DELETE, /deploy, /import,
// /restore, the assistant, agent import, a run's copy-back — already ends in
// recordRevision, so the journal sees all of them without touching them. It
// is registered only where a backend is (setRevisionBackend: the hosted
// platform with a database, or an install that opts in), so a laptop and the
// CLI never journal anything.
//
// While the workspace FOLDER is still the working copy (phase 4 stages runs
// from a pinned revision and phase 8 retires the volume), the folder is what
// the writer just changed, so the journal commits "the head, plus this
// change": its base is whatever the head holds, not a pinned base. The first
// commit of a workspace is its whole tree (the baseline), taken from disk.
// Conflict copies arrive with phase 4's pinned bases; here there is one
// writer of the folder at a time. A journal entry that cannot commit (the
// database is down) stays queued, retried with a backoff; if the queue
// overflows the workspace is marked and reconcileWorkspace brings the head to
// the folder's content in one revision.
//
// Reads: readAtHead resolves head → manifest → blob through the BlobStore,
// with a seam for the bounded node-local cache another session is building
// (setBlobCache). History, a revision's diff, its snapshot and restore are
// answered from revisions in the shapes history.ts has always returned.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { currentTree, registerJournal, type RevisionFile, type RevisionSummary, type Revision as HistoryRevision } from "./history.ts";
import { workspaceDir } from "./store.ts";
import { opsError, opsLog } from "./ops-log.ts";
import { readAll, BlobNotFound } from "./blob-store.ts";
import {
  blobObjectKey,
  diffManifests,
  emptyManifest,
  entryId,
  MODE_EXEC,
  MODE_FILE,
  sha256Hex,
  sideOf,
  type Changes,
  type Manifest,
} from "./manifest.ts";
import { headsOf, loadManifest, manifestsAt, manifestsOf, publish, restore, requestDigest, PublishError, type Deps, type PublishResult } from "./publish.ts";
import type { Revision, WorkspaceRef } from "./revision-store.ts";

// ------------------------------------------------------------- the backend

let backend: Deps | null = null;

/** Where revisions live, or null (no journal, nothing changes). */
export function setRevisionBackend(deps: Deps | null): void {
  backend = deps;
  registerJournal(deps ? journalChange : null);
}
export const revisionBackend = (): Deps | null => backend;

/** The bounded node-local cache of blobs, keyed by sha (built elsewhere). A
 *  miss falls through to the BlobStore and fills the cache. */
export interface BlobCache {
  get(tenant: string, sha: string): Promise<Buffer | null>;
  put(tenant: string, sha: string, bytes: Buffer): Promise<void>;
}
let cache: BlobCache | null = null;
export function setBlobCache(c: BlobCache | null): void {
  cache = c;
}

// ------------------------------------------------------------- the journal

interface Entry {
  id: string;
  files: RevisionFile[];
  by: string;
  message: string;
  at: string;
}
const MAX_QUEUED = 2000;
const queues = new Map<string, Entry[]>();
const chains = new Map<string, Promise<unknown>>();
const marked = new Set<string>(); // overflowed: needs reconcileWorkspace
const retryAt = new Map<string, number>();
const key = (tenant: string, workspace: string) => `${tenant}\0${workspace}`;
const split = (k: string): [string, string] => k.split("\0") as [string, string];

/** Called by history.recordRevision for every change set. Synchronous and
 *  cheap; the commit happens in the background (flushRevisions waits for it). */
function journalChange(tenant: string, scope: string, files: RevisionFile[], meta: { by: string; message: string; at: string }): void {
  if (!backend || scope === "@library") return; // the account shelf is not a workspace
  const k = key(tenant, scope);
  const q = queues.get(k) ?? [];
  q.push({ id: crypto.randomBytes(12).toString("hex"), files, by: meta.by, message: meta.message, at: meta.at });
  if (q.length > MAX_QUEUED) {
    q.splice(0, q.length - MAX_QUEUED);
    marked.add(k);
    opsLog("error", "revisions.journal_overflow", { tenant, workspace: scope, count: MAX_QUEUED });
  }
  queues.set(k, q);
  setImmediate(() => void drain(k));
}

export function pendingRevisions(): number {
  let n = 0;
  for (const q of queues.values()) n += q.length;
  return n;
}

function drain(k: string): Promise<void> {
  const next = (chains.get(k) ?? Promise.resolve()).catch(() => {}).then(() => drainOne(k));
  chains.set(k, next);
  return next;
}

async function drainOne(k: string): Promise<void> {
  const [tenant, workspace] = split(k);
  const q = queues.get(k);
  while (q && q.length && backend) {
    const entry = q[0];
    try {
      await commitEntry(backend, tenant, workspace, entry);
      q.shift();
      retryAt.delete(k);
    } catch (err) {
      if (permanent(err)) {
        // Retrying cannot change a verdict about the CONTENT (a path the
        // manifest refuses, two names differing by case): drop this entry so
        // it does not block every later one, say so, and leave the workspace
        // for a reconcile once the cause is fixed.
        opsError("revisions.entry_dropped", err, { tenant, workspace });
        q.shift();
        marked.add(k);
        continue;
      }
      opsError("revisions.commit_failed", err, { tenant, workspace });
      const attempts = (retryAt.get(k) ?? 0) + 1;
      retryAt.set(k, attempts);
      const wait = Math.min(30_000, 1_000 * 2 ** Math.min(5, attempts - 1));
      const t = setTimeout(() => void drain(k), wait);
      t.unref?.();
      return;
    }
  }
  if (q && !q.length) queues.delete(k);
}

/** An error that retrying will not cure: the manifest refused the content. */
function permanent(err: unknown): boolean {
  if (err instanceof PublishError) return err.code === "bad_change";
  const m = err instanceof Error ? err.message : "";
  return /^illegal manifest path|differ only by case|a manifest holds at most|is not workspace content/.test(m);
}

/** Wait until every queued change (of one workspace, or all) is committed.
 *  A barrier for an edge that wants "committed" before it answers. Returns
 *  what is still queued (a database that is down leaves some). */
export async function flushRevisions(only?: { tenant: string; workspace: string }): Promise<{ pending: number }> {
  const keys = only ? [key(only.tenant, only.workspace)] : [...queues.keys()];
  await Promise.all(keys.map((k) => drain(k)));
  return { pending: only ? (queues.get(key(only.tenant, only.workspace))?.length ?? 0) : pendingRevisions() };
}

/** Tests: forget every queued change and pending retry. */
export function resetJournalForTests(): void {
  queues.clear();
  chains.clear();
  marked.clear();
  retryAt.clear();
}

/** Does this workspace need a reconcile (its journal overflowed)? */
export const needsReconcile = (tenant: string, workspace: string) => marked.has(key(tenant, workspace));

// ------------------------------------------------------------- committing

function modeOf(tenant: string, workspace: string, rel: string): number {
  try {
    return fs.statSync(path.join(workspaceDir(tenant, workspace), rel)).mode & 0o111 ? MODE_EXEC : MODE_FILE;
  } catch {
    return MODE_FILE;
  }
}

const opIdOf = (prefix: string, id: string) => `${prefix}-${id}`;

/** One journal entry → one publish. The first commit of a workspace is its
 *  whole tree. */
async function commitEntry(deps: Deps, tenant: string, workspace: string, entry: Entry): Promise<PublishResult | null> {
  const ws: WorkspaceRef = { tenant, workspace };
  const heads = await headsOf(deps, ws);
  const head = await manifestsAt(deps, tenant, heads);
  const bytes = new Map<string, Buffer>();
  const changes: Changes = {};
  const baseline: { authored: boolean; state: boolean } = { authored: !heads.workspace, state: !heads.state };

  const put = (rel: string, text: string, side: "authored" | "state") => {
    const buf = Buffer.from(text, "utf8");
    const sha = sha256Hex(buf);
    bytes.set(sha, buf);
    const was = head[side].files[rel];
    changes[rel] = { op: "put", base: was ? entryId(was) : null, sha, size: buf.length, mode: modeOf(tenant, workspace, rel) };
  };

  if (baseline.authored || baseline.state) {
    // Nothing is recorded for (part of) this workspace yet: its tree, as the
    // folder holds it now, is the first revision. That already contains this
    // entry's change, since the writer wrote before it journalled.
    for (const f of currentTree(tenant, workspace) ?? []) {
      const side = sideOf(f.path);
      if (!side || f.after === null) continue;
      if ((side === "authored" && !baseline.authored) || (side === "state" && !baseline.state)) continue;
      put(f.path, f.after, side);
    }
  }
  for (const f of entry.files) {
    const side = sideOf(f.path);
    if (!side) continue;
    if ((side === "authored" && baseline.authored) || (side === "state" && baseline.state)) continue; // in the baseline
    const was = head[side].files[f.path];
    if (f.after === null) {
      if (was) changes[f.path] = { op: "delete", base: entryId(was) };
    } else {
      put(f.path, f.after, side);
    }
  }
  if (!Object.keys(changes).length) return null;
  return publish(deps, {
    ws,
    opId: opIdOf(baseline.authored || baseline.state ? "jb" : "jr", entry.id),
    by: entry.by,
    message: entry.message,
    changes,
    bytesOf: async (sha) => {
      const b = bytes.get(sha);
      if (!b) throw new Error(`the journal lost the bytes for ${sha.slice(0, 12)}…`);
      return b;
    },
  });
}

/** Bring the heads to the folder's content in one revision: the way in for a
 *  workspace that predates the journal (the importer, phase 8), and the repair
 *  after a journal overflow. Text files only, as the tree reader lists them. */
export async function reconcileWorkspace(tenant: string, workspace: string, by = "reconcile"): Promise<PublishResult | null> {
  const deps = backend;
  if (!deps) return null;
  const ws: WorkspaceRef = { tenant, workspace };
  const tree = currentTree(tenant, workspace);
  if (!tree) return null;
  const head = await manifestsAt(deps, tenant, await headsOf(deps, ws));
  const bytes = new Map<string, Buffer>();
  const want: Manifest = emptyManifest();
  const have: Manifest = { v: 1, files: { ...head.authored.files, ...head.state.files } };
  for (const f of tree) {
    const side = sideOf(f.path);
    if (!side || f.after === null) continue;
    const buf = Buffer.from(f.after, "utf8");
    const sha = sha256Hex(buf);
    bytes.set(sha, buf);
    want.files[f.path] = { sha, size: buf.length, mode: modeOf(tenant, workspace, f.path) };
  }
  // A path the tree reader does not list but the folder still holds (a binary
  // file) is neither added nor removed here; one that is gone from the folder
  // is gone from the head.
  const dir = workspaceDir(tenant, workspace);
  for (const p of Object.keys(have.files)) {
    if (!(p in want.files) && fs.existsSync(path.join(dir, p))) want.files[p] = have.files[p];
  }
  const changes = diffManifests(have, want);
  marked.delete(key(tenant, workspace));
  if (!Object.keys(changes).length) return null;
  return publish(deps, {
    ws,
    opId: opIdOf("jx", requestDigest("reconcile", changes).slice(0, 40)),
    by,
    message: "workspace content recorded",
    changes,
    bytesOf: async (sha) => bytes.get(sha)!,
  });
}

// ------------------------------------------------------------- reading

async function blobBytes(deps: Deps, tenant: string, sha: string): Promise<Buffer | null> {
  const hit = await cache?.get(tenant, sha);
  if (hit) return hit;
  try {
    const b = await readAll(deps.blobs, blobObjectKey(tenant, sha));
    void cache?.put(tenant, sha, b).catch(() => {});
    return b;
  } catch (err) {
    if (err instanceof BlobNotFound) return null;
    throw err;
  }
}

/** One file of the workspace as its heads hold it: head → manifest → blob.
 *  Null when there is no such file (or no head yet). */
export async function readAtHead(tenant: string, workspace: string, rel: string): Promise<Buffer | null> {
  const deps = backend;
  if (!deps) return null;
  const side = sideOf(rel);
  if (!side) return null;
  const heads = await headsOf(deps, { tenant, workspace });
  const rev = side === "authored" ? heads.workspace : heads.state;
  if (!rev) return null;
  const e = (await loadManifest(deps, tenant, rev[side])).files[rel];
  return e ? blobBytes(deps, tenant, e.sha) : null;
}

const MAX_INLINE = 256 * 1024;
const clip = (s: string | null) => (s === null ? null : s.length > MAX_INLINE ? s.slice(0, MAX_INLINE) : s);

async function parentManifest(deps: Deps, tenant: string, workspace: string, rev: Revision): Promise<Manifest> {
  if (!rev.parent) return emptyManifest();
  const parent = await deps.revisions.revision({ tenant, workspace }, rev.parent);
  return parent ? (await manifestsOf(deps, tenant, parent)).authored : emptyManifest();
}

/** The history page's rows, newest first: the workspace head's revisions in
 *  history.ts's summary shape. `commit` is null (a deploy's commit id rides in
 *  the message); the id is the revision's. */
export async function listRevisionSummaries(tenant: string, workspace: string, opts: { limit?: number; forPath?: string } = {}): Promise<RevisionSummary[]> {
  const deps = backend;
  if (!deps) return [];
  const revs = await deps.revisions.revisions({ tenant, workspace }, { limit: opts.forPath ? 500 : (opts.limit ?? 200) });
  const out: RevisionSummary[] = [];
  for (const r of revs) {
    const [mine, before] = await Promise.all([loadManifest(deps, tenant, r.authored), parentManifest(deps, tenant, workspace, r)]);
    const paths = Object.keys(diffManifests(before, mine)).sort();
    if (opts.forPath && !paths.includes(opts.forPath)) continue;
    out.push({ id: r.id, at: r.at, by: r.by, message: r.message, commit: null, paths });
    if (out.length >= (opts.limit ?? 200)) break;
  }
  return out;
}

/** One revision with what changed, in history.ts's Revision shape (text
 *  before/after, clipped). */
export async function readRevisionDetail(tenant: string, workspace: string, id: string, forPath?: string): Promise<HistoryRevision | null> {
  const deps = backend;
  if (!deps) return null;
  const r = await deps.revisions.revision({ tenant, workspace }, id);
  if (!r) return null;
  const [mine, before] = await Promise.all([loadManifest(deps, tenant, r.authored), parentManifest(deps, tenant, workspace, r)]);
  const changes = diffManifests(before, mine);
  const files: HistoryRevision["files"] = [];
  for (const [p, c] of Object.entries(changes).sort(([a], [b]) => a.localeCompare(b))) {
    if (forPath && p !== forPath) continue;
    const was = before.files[p];
    const now = mine.files[p];
    const text = async (e: typeof was) => (e ? (await blobBytes(deps, tenant, e.sha))?.toString("utf8") ?? null : null);
    files.push({ path: p, before: clip(await text(was)), after: c.op === "delete" ? null : clip(await text(now)) });
  }
  return { id: r.id, at: r.at, by: r.by, message: r.message, commit: null, files };
}

/** The whole tree at a revision (the files a restore would bring back), text. */
export async function snapshotFiles(tenant: string, workspace: string, id: string): Promise<{ path: string; content: string }[] | null> {
  const deps = backend;
  if (!deps) return null;
  const r = await deps.revisions.revision({ tenant, workspace }, id);
  if (!r) return null;
  const m = await loadManifest(deps, tenant, r.authored);
  const out: { path: string; content: string }[] = [];
  for (const [p, e] of Object.entries(m.files).sort(([a], [b]) => a.localeCompare(b))) {
    const b = await blobBytes(deps, tenant, e.sha);
    if (b) out.push({ path: p, content: b.toString("utf8") });
  }
  return out;
}

/** Restore = a NEW revision pointing at an old one's blobs. History is kept;
 *  `state/` is rewound only when `stateTo` names a state revision. The caller
 *  then writes the files to the folder (snapshotFiles) as the restore route
 *  always did; the journal sees that write as a no-op because the head already
 *  holds the content. */
export async function restoreRevision(tenant: string, workspace: string, to: string, opts: { by: string; opId: string; message?: string; stateTo?: string }): Promise<PublishResult | null> {
  const deps = backend;
  if (!deps) return null;
  return restore(deps, { ws: { tenant, workspace }, to, opId: opts.opId, by: opts.by, message: opts.message, stateTo: opts.stateTo });
}
