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
import { currentTree, registerJournal, registerRevisionView, registerWorkspaceGone, type RevisionView, type RevisionFile, type RevisionSummary, type Revision as HistoryRevision } from "./history.ts";
import { workspaceDir, listTenants, listWorkspaces, readWorkspaceFile, assertEditablePath } from "./store.ts";
import { dataRoot } from "./paths.ts";
import { opsError, opsLog } from "./ops-log.ts";
import { readAll, BlobNotFound } from "./blob-store.ts";
import { fsJournalStore, type JournalStore, type JournalRecord } from "./journal-store.ts";
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
import { OpIdReused, type Revision, type WorkspaceRef } from "./revision-store.ts";

// ------------------------------------------------------------- the backend

let backend: Deps | null = null;

/** Two switches the host decides on every call (the settings registry's
 *  `revisions.journal` and `revisions.read`): the journal and history from
 *  revisions; reads of file content from heads. Both default to off in a host
 *  that gives no answer, so registering a backend alone changes nothing. */
export interface BackendOptions {
  journal?: () => boolean;
  read?: () => boolean;
  /** Where the journal's entries are written down (journal-store.ts). Unset:
   *  files under <data>/.revision-journal (a laptop, Compose). A hosted install
   *  gives the database, so the journal does not depend on the shared volume. */
  journalStore?: JournalStore;
}
let gate: { journal: () => boolean; read: () => boolean } = { journal: () => false, read: () => false };
/** The legacy place: files on the volume. Always replayed at boot (and then
 *  empty), whatever new entries are written to. */
const legacyFiles = fsJournalStore(() => journalRoot());
let primary: JournalStore | null = null;
const journalStores = (): JournalStore[] => (primary && primary !== legacyFiles ? [primary, legacyFiles] : [legacyFiles]);
const entryStore = (): JournalStore => primary ?? legacyFiles;

/** Where revisions live, or null (no journal, nothing changes). */
export function setRevisionBackend(deps: Deps | null, opts: BackendOptions = {}): void {
  backend = deps;
  gate = { journal: opts.journal ?? (() => false), read: opts.read ?? (() => false) };
  primary = opts.journalStore ?? null;
  registerJournal(deps ? journalChange : null);
  registerWorkspaceGone(deps ? (t, w) => dropJournal(t, w) : null);
  registerRevisionView(deps ? view : null);
}
export const revisionBackend = (): Deps | null => backend;
const journalOn = (): boolean => !!backend && safe(gate.journal);
/** Reads of content from heads (and run stage-in): its own switch, and only
 *  where the journal runs too (a head that is not kept current is not a source). */
export const revisionReadsOn = (): boolean => journalOn() && safe(gate.read);
function safe(fn: () => boolean): boolean {
  try {
    return fn();
  } catch {
    return false;
  }
}

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
//
// Durable: every change set is written to a file BEFORE it is queued, and the
// file is removed when the change is committed. A process that dies with
// changes queued leaves the files; recoverJournal (boot) replays them and
// reconcileAll repairs whatever still disagrees with the folder.
//
// Why files and not a table: an entry carries the bytes of every changed file
// (the head cannot be rebuilt from paths alone), a table would copy them into
// rows a second time, a write-ahead FILE on the volume the folder is on shares
// that volume's fate (if the volume is gone there is nothing to replay
// against), it needs no migration, and any pod can replay it — the commit is
// idempotent per entry id, so two pods replaying one file commit it once.
// Cost: while the volume is the working copy it is also where the journal is;
// when the volume is retired (phase 8) the journal moves to a table.

/** A journal file. `base` is set by a run's copy-back: the sha of what the
 *  writer STARTED from (null: the path did not exist), so the commit can tell
 *  a concurrent writer apart (same path = conflict, disjoint paths replay). A
 *  dashboard save has none: its base is whatever the head holds. */
type EntryFile = RevisionFile & { base?: string | null };
interface Entry {
  id: string;
  files: EntryFile[];
  by: string;
  message: string;
  at: string;
  /** The revision this change brings back (a restore), when it is one. */
  restoredFrom?: string;
  /** Where it was written down, and its handle there (when it was). */
  store?: JournalStore;
  handle?: string;
}
const MAX_QUEUED = 2000;
/** A journal file this old, that no queue of this process holds, was left by a
 *  process that died (a live one commits within seconds or keeps retrying). */
const ORPHAN_MS = 120_000;
const queues = new Map<string, Entry[]>();
const chains = new Map<string, Promise<unknown>>();
const marked = new Set<string>(); // overflowed or dropped: needs reconcileWorkspace
const verified = new Set<string>(); // reconciled once in this process
const retryAt = new Map<string, number>();
const restoring = new Map<string, string>();
const key = (tenant: string, workspace: string) => `${tenant}\0${workspace}`;
const split = (k: string): [string, string] => k.split("\0") as [string, string];

const journalRoot = () => path.join(dataRoot(), ".revision-journal");

/** Write the entry down, atomically. A store that refuses leaves the entry in
 *  memory only (said once per failure), as the journal always was. */
function persist(tenant: string, workspace: string, e: Entry): void {
  const store = entryStore();
  try {
    e.handle = store.put({ v: 1, tenant, workspace, id: e.id, files: e.files as JournalRecord["files"], by: e.by, message: e.message, at: e.at, restoredFrom: e.restoredFrom });
    e.store = store;
  } catch (err) {
    opsError("revisions.journal_not_persisted", err, { tenant, workspace, store: store.kind }, "warn");
  }
}

function forget(tenant: string, workspace: string, e: Entry): void {
  if (!e.store || e.handle === undefined) return;
  try {
    e.store.remove(tenant, workspace, e.handle);
  } catch (err) {
    opsError("revisions.journal_not_removed", err, { tenant, workspace }, "warn");
  }
}

/** Called by history.recordRevision for every change set. Synchronous and
 *  cheap; the commit happens in the background (flushRevisions waits for it). */
function journalChange(tenant: string, scope: string, files: RevisionFile[], meta: { by: string; message: string; at: string }): void {
  if (!backend || scope === "@library") return; // the account shelf is not a workspace
  const k = key(tenant, scope);
  if (!safe(gate.journal)) {
    verified.delete(k); // a change the head will not see: reconcile before trusting it again
    return;
  }
  // Only what the head needs: the new content. The old text is the writer's
  // history record, not the journal's (it can be a quarter megabyte a file).
  const slim = files.map((f) => ({ path: f.path, before: null, after: f.after }));
  enqueue(tenant, scope, { id: crypto.randomBytes(12).toString("hex"), files: slim, by: meta.by, message: meta.message, at: meta.at, restoredFrom: restoring.get(k) });
}

function enqueue(tenant: string, scope: string, entry: Entry): void {
  const k = key(tenant, scope);
  const q = queues.get(k) ?? [];
  persist(tenant, scope, entry);
  q.push(entry);
  if (q.length > MAX_QUEUED) {
    for (const old of q.splice(0, q.length - MAX_QUEUED)) forget(tenant, scope, old);
    marked.add(k);
    opsLog("error", "revisions.journal_overflow", { tenant, workspace: scope, count: MAX_QUEUED });
  }
  queues.set(k, q);
  setImmediate(() => void drain(k));
}

/** One file a step wrote back to the workspace (run-container.ts
 *  applyContainerChanges): `base` is the sha of the folder's copy before the
 *  write (null: new file), `after` the bytes now on the folder. */
export interface StepWrite {
  path: string;
  base: string | null;
  after: Buffer;
}

/** A step's file in the journal is held to this size; a bigger one is left to
 *  the reconcile, which reads it from the folder (the journal file carries the
 *  bytes, and a state index can be tens of megabytes). */
const MAX_STEP_FILE = 1024 * 1024;
/** And one step's entry as a whole: it is written down in one go (a file, or a
 *  row through the synchronous bridge), so it is bounded. What does not fit is
 *  left to the reconcile too. */
const MAX_STEP_ENTRY = 8 * 1024 * 1024;

/**
 * FOL-126 phase 4. A step's copy-back lands as ONE revision (one journal
 * entry, one publish): the paths it wrote on the workspace head and the ones
 * under state/ on the state head (two commits, each idempotent, as decided on
 * 6 Nov). Never a half-written tree: the entry is on disk before anything is
 * queued, and a commit is all of the step's paths or none.
 *
 * Pinned base: each path carries the sha the folder held before the write, so
 * a head that moved since (another run, a person) is a CONFLICT on that path —
 * the head's version stays, the step's is kept beside it as
 * `<stem>.conflict-<op>.<ext>` — while paths nobody else touched go through.
 * The id is derived from the run and step, so a step whose copy-back is
 * applied twice (a resumed driver) publishes once.
 *
 * The rule for a failed step, written down: applyContainerChanges runs after a
 * failure too (a failed step's partial outputs are usually the interesting
 * ones), so they are committed as well, as today's folder gets them. A step
 * whose copy-out itself failed wrote nothing and commits nothing. A test run's
 * diverted state/ and storage/ writes never reach the folder and never here.
 *
 * Text only: a binary file is not versioned yet (see phase 3). Returns the
 * number of paths queued.
 */
export function recordStepOutputs(
  tenant: string,
  workspace: string,
  writes: StepWrite[],
  meta: { runId?: string; step?: string | number; by?: string },
): number {
  if (!backend || workspace === "@library") return 0;
  const k = key(tenant, workspace);
  if (!safe(gate.journal)) {
    verified.delete(k); // the head will not see this: reconcile before trusting it again
    return 0;
  }
  const files: EntryFile[] = [];
  let total = 0;
  for (const w of writes) {
    if (!sideOf(w.path)) continue; // not workspace content (runs/, .foldrun/ …)
    const text = w.after.toString("utf8");
    if (!Buffer.from(text, "utf8").equals(w.after)) continue; // binary: not versioned
    if (w.after.length > MAX_STEP_FILE) {
      marked.add(k); // the folder has it; the reconcile records it
      continue;
    }
    if (total + w.after.length > MAX_STEP_ENTRY) {
      marked.add(k);
      continue;
    }
    total += w.after.length;
    files.push({ path: w.path, before: null, after: text, base: w.base });
  }
  if (!files.length) return 0;
  const idSource = meta.runId ? `${meta.runId}\0${meta.step ?? ""}` : crypto.randomBytes(12).toString("hex");
  enqueue(tenant, workspace, {
    id: `st${sha256Hex(Buffer.from(idSource)).slice(0, 22)}`,
    files,
    by: meta.by ?? (meta.runId ? `run:${meta.runId}` : "run"),
    message: meta.runId ? `run ${meta.runId}${meta.step !== undefined ? ` step ${meta.step}` : ""}` : "run output",
    at: new Date().toISOString(),
  });
  return files.length;
}

/** Run `fn` (a synchronous writer) so that the change it records is committed
 *  as a restore of `revisionId` — the history then says "restored from". */
export function asRestoreOf<T>(tenant: string, workspace: string, revisionId: string | null | undefined, fn: () => T): T {
  const k = key(tenant, workspace);
  if (!revisionId || !journalOn()) return fn();
  restoring.set(k, revisionId);
  try {
    return fn();
  } finally {
    restoring.delete(k);
  }
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
    // The workspace was deleted while this waited (or retried): nothing to
    // publish, and nothing for a later boot to replay.
    if (!fs.existsSync(workspaceDir(tenant, workspace))) {
      q.shift();
      forget(tenant, workspace, entry);
      continue;
    }
    try {
      await commitEntry(backend, tenant, workspace, entry);
      q.shift();
      forget(tenant, workspace, entry);
      retryAt.delete(k);
    } catch (err) {
      if (permanent(err)) {
        // Retrying cannot change a verdict about the CONTENT (a path the
        // manifest refuses, two names differing by case): drop this entry so
        // it does not block every later one, say so, and leave the workspace
        // for a reconcile once the cause is fixed.
        opsError("revisions.entry_dropped", err, { tenant, workspace });
        q.shift();
        forget(tenant, workspace, entry);
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
  // Once per process per workspace, with nothing queued: the folder is the
  // truth, so a head that disagrees with it (a crash lost an entry, the
  // journal was off for a while, a run wrote the folder directly) is brought
  // to it. After the entries, never before: replaying an older change over a
  // reconciled head would write it backwards.
  if (backend && (!q || !q.length) && (!verified.has(k) || marked.has(k)) && fs.existsSync(workspaceDir(tenant, workspace))) {
    verified.add(k);
    try {
      await reconcileWorkspace(tenant, workspace, "reconcile");
    } catch (err) {
      verified.delete(k);
      opsError("revisions.reconcile_failed", err, { tenant, workspace }, "warn");
    }
  }
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

/** Tests: forget every queued change and pending retry (journal FILES stay:
 *  that is what a crash leaves). */
export function resetJournalForTests(): void {
  queues.clear();
  chains.clear();
  marked.clear();
  verified.clear();
  retryAt.clear();
  restoring.clear();
}

/** An account is gone (or one workspace is): forget its queued changes and
 *  remove its journal files, so nothing of it is replayed or committed later
 *  and no workspace text outlives it outside the folder. Safe to repeat. */
export function dropJournal(tenant: string, workspace?: string): void {
  for (const k of [...queues.keys()]) {
    const [t, w] = split(k);
    if (t === tenant && (workspace === undefined || w === workspace)) {
      // A drain already running holds this array: empty it, or it commits the rest.
      if (queues.get(k)) queues.get(k)!.length = 0;
      queues.delete(k);
      marked.delete(k);
      verified.delete(k);
      retryAt.delete(k);
    }
  }
  for (const st of journalStores()) {
    try {
      st.drop(tenant, workspace);
    } catch (err) {
      opsError("revisions.journal_not_dropped", err, { tenant, workspace, store: st.kind }, "warn");
    }
  }
}

/** Does this workspace need a reconcile (its journal overflowed)? */
export const needsReconcile = (tenant: string, workspace: string) => marked.has(key(tenant, workspace));

/** Boot: replay what a dead process left in the journal directory, oldest
 *  first, then wait for it to commit. Entries of a workspace that no longer
 *  exists are discarded. `minAgeMs` keeps clear of a live process's files. */
export async function recoverJournal(opts: { minAgeMs?: number } = {}): Promise<{ entries: number; workspaces: number }> {
  if (!journalOn()) return { entries: 0, workspaces: 0 };
  const minAge = opts.minAgeMs ?? ORPHAN_MS;
  let entries = 0;
  const touched = new Set<string>();
  for (const store of journalStores()) {
    let list: { tenant: string; workspace: string }[] = [];
    try {
      list = store.workspaces();
    } catch (err) {
      opsError("revisions.journal_unavailable", err, { store: store.kind }, "warn");
      continue;
    }
    for (const { tenant, workspace } of list) {
      const k = key(tenant, workspace);
      const q = queues.get(k) ?? [];
      const held = new Set(q.filter((e) => e.store === store).map((e) => e.handle));
      const gone = !fs.existsSync(workspaceDir(tenant, workspace));
      const found: Entry[] = [];
      let names: { handle: string; ageMs: number }[] = [];
      try {
        store.sweep(tenant, workspace, minAge);
        names = store.entries(tenant, workspace);
      } catch (err) {
        opsError("revisions.journal_unavailable", err, { tenant, workspace, store: store.kind }, "warn");
        continue;
      }
      for (const { handle, ageMs } of names) {
        if (held.has(handle)) continue;
        try {
          if (gone) {
            store.remove(tenant, workspace, handle);
            continue;
          }
          if (minAge > 0 && ageMs < minAge) continue;
          const e = store.read(tenant, workspace, handle);
          if (e.v !== 1 || !Array.isArray(e.files)) throw new Error("not a journal entry");
          found.push({ id: e.id, files: e.files, by: e.by, message: e.message, at: e.at, restoredFrom: e.restoredFrom, store, handle });
        } catch (err) {
          // a torn or foreign entry: set it aside, never replay it
          opsError("revisions.journal_file_unreadable", err, { tenant, workspace }, "warn");
          try {
            store.setAside(tenant, workspace, handle);
          } catch {
            // leave it
          }
        }
      }
      if (!found.length) continue;
      queues.set(k, [...found, ...q]);
      entries += found.length;
      touched.add(k);
    }
  }
  await Promise.all([...touched].map((k) => drain(k)));
  return { entries, workspaces: touched.size };
}

/** Boot: bring every workspace's heads to its folder (reconcile each, one at
 *  a time, yielding between). A workspace with changes still queued is left
 *  to its queue. Returns how many were checked and how many needed repair. */
export async function reconcileAll(opts: { by?: string; tenants?: string[] } = {}): Promise<{ checked: number; repaired: number; failed: number }> {
  const out = { checked: 0, repaired: 0, failed: 0 };
  if (!journalOn()) return out;
  for (const tenant of opts.tenants ?? listTenants()) {
    for (const w of listWorkspaces(tenant)) {
      const k = key(tenant, w.name);
      try {
        verified.add(k); // reconciled explicitly below, and counted
        await drain(k);
        if (queues.get(k)?.length) {
          verified.delete(k);
          continue; // the store is not taking writes: leave it
        }
        const next = (chains.get(k) ?? Promise.resolve()).catch(() => {}).then(() => reconcileWorkspace(tenant, w.name, opts.by ?? "reconcile"));
        chains.set(k, next);
        const res = await next;
        verified.add(k);
        out.checked++;
        if (res && res.status === "committed") out.repaired++;
      } catch (err) {
        out.failed++;
        opsError("revisions.reconcile_failed", err, { tenant, workspace: w.name }, "warn");
      }
      await new Promise<void>((r) => setImmediate(r));
    }
  }
  opsLog("info", "revisions.reconciled", out);
  return out;
}

// ------------------------------------------------------------- committing

function modeOf(tenant: string, workspace: string, rel: string): number {
  try {
    return fs.statSync(path.join(workspaceDir(tenant, workspace), rel)).mode & 0o111 ? MODE_EXEC : MODE_FILE;
  } catch {
    return MODE_FILE;
  }
}

const opIdOf = (prefix: string, id: string) => `${prefix}-${id}`;

/** The change's base for a writer that started from `sha`: the head's own
 *  entry when it still holds that content (so the change applies), else an id
 *  the head cannot hold (so the path is a conflict, not an overwrite). */
function pinnedBase(sha: string | null, was: { sha: string; mode: number } | undefined): string | null {
  if (sha === null) return was ? entryId({ sha: "0".repeat(64), mode: MODE_FILE }) : null; // started from "no file", the head has one now (a sha nothing hashes to)
  if (was && was.sha === sha) return entryId(was);
  return entryId({ sha, mode: MODE_FILE });
}

/** One journal entry → one publish. The first commit of a workspace is its
 *  whole tree. */
async function commitEntry(deps: Deps, tenant: string, workspace: string, entry: Entry): Promise<PublishResult | null> {
  const ws: WorkspaceRef = { tenant, workspace };
  const heads = await headsOf(deps, ws);
  const head = await manifestsAt(deps, tenant, heads);
  const bytes = new Map<string, Buffer>();
  const changes: Changes = {};
  const baseline: { authored: boolean; state: boolean } = { authored: !heads.workspace, state: !heads.state };

  const put = (rel: string, text: string, side: "authored" | "state", pinned?: string | null) => {
    const buf = Buffer.from(text, "utf8");
    const sha = sha256Hex(buf);
    bytes.set(sha, buf);
    const was = head[side].files[rel];
    const mode = modeOf(tenant, workspace, rel);
    if (was && was.sha === sha && was.mode === mode) return; // the head already holds it
    changes[rel] = { op: "put", base: pinned === undefined ? (was ? entryId(was) : null) : pinnedBase(pinned, was), sha, size: buf.length, mode };
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
      put(f.path, f.after, side, f.base);
    }
  }
  if (!Object.keys(changes).length) return null;
  // A restore tag only counts when that revision is in the store.
  const restoredFrom = entry.restoredFrom && (await deps.revisions.revision(ws, entry.restoredFrom)) ? entry.restoredFrom : undefined;
  try {
    return await publish(deps, {
    ws,
    opId: opIdOf(baseline.authored || baseline.state ? "jb" : "jr", entry.id),
    by: entry.by,
    message: entry.message,
    changes,
    restoredFrom,
    bytesOf: async (sha) => {
      const b = bytes.get(sha);
      if (!b) throw new Error(`the journal lost the bytes for ${sha.slice(0, 12)}…`);
      return b;
    },
    });
  } catch (err) {
    // This entry's id was used before for a different set of changes: an
    // earlier attempt committed it (its answer was lost) and the head has
    // moved on, so the changes computed now differ. It is done.
    if (err instanceof OpIdReused) return null;
    throw err;
  }
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
  const want = opts.limit ?? 200;
  // Eight at a time: each revision is two manifest reads, and a history page
  // asks for hundreds.
  for (let i = 0; i < revs.length && out.length < want; i += 8) {
    const rows = await Promise.all(
      revs.slice(i, i + 8).map(async (r) => {
        const [mine, before] = await Promise.all([loadManifest(deps, tenant, r.authored), parentManifest(deps, tenant, workspace, r)]);
        return { id: r.id, at: r.at, by: r.by, message: r.message, commit: null, paths: Object.keys(diffManifests(before, mine)).sort() } as RevisionSummary;
      }),
    );
    for (const row of rows) {
      if (opts.forPath && !row.paths.includes(opts.forPath)) continue;
      if (out.length < want) out.push(row);
    }
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

// ------------------------------------------------------------- history view

/** What history.ts asks for, answered from revisions where the journal runs.
 *  A store that errors answers null (the local history is used) and says so. */
async function guarded<T>(what: string, tenant: string, workspace: string, fn: () => Promise<T>): Promise<T | null> {
  if (!journalOn()) return null;
  try {
    return await fn();
  } catch (err) {
    opsError("revisions.history_unavailable", err, { tenant, workspace, what }, "warn");
    return null;
  }
}
const view: RevisionView = {
  list: (t, w, o) => guarded("list", t, w, () => listRevisionSummaries(t, w, o)),
  read: (t, w, id, p) => guarded("read", t, w, () => readRevisionDetail(t, w, id, p)),
  snapshot: (t, w, id) => guarded("snapshot", t, w, () => snapshotFiles(t, w, id)),
};

// ------------------------------------------------------------- reads through heads

/** One workspace file, from its head when reads through revisions are on and
 *  the head has it; null otherwise, and the caller reads the folder (the
 *  fallback is the point: a head behind the folder, a missing blob, a store
 *  that is down, a binary file the tree reader never recorded). */
export async function readHeadText(tenant: string, workspace: string, rel: string): Promise<string | null> {
  if (!revisionReadsOn()) return null;
  try {
    const b = await readAtHead(tenant, workspace, rel);
    return b ? b.toString("utf8") : null;
  } catch (err) {
    opsError("revisions.read_failed", err, { tenant, workspace }, "warn");
    return null;
  }
}

/** Every file of the workspace head with its bytes and mode (both heads), for
 *  a stage-in; null when reads through revisions are off, there is no head,
 *  or any blob could not be had (the caller then stages from the folder). */
export async function readHeadTree(tenant: string, workspace: string): Promise<{ path: string; bytes: Buffer; mode: number }[] | null> {
  const deps = backend;
  if (!deps || !revisionReadsOn()) return null;
  try {
    const heads = await headsOf(deps, { tenant, workspace });
    if (!heads.workspace) return null;
    const m = await manifestsAt(deps, tenant, heads);
    const out: { path: string; bytes: Buffer; mode: number }[] = [];
    for (const side of ["authored", "state"] as const) {
      for (const [p, e] of Object.entries(m[side].files)) {
        const b = await blobBytes(deps, tenant, e.sha);
        if (!b) return null;
        out.push({ path: p, bytes: b, mode: e.mode });
      }
    }
    return out;
  } catch (err) {
    opsError("revisions.read_failed", err, { tenant, workspace }, "warn");
    return null;
  }
}

/** The dashboard's and the API's read of one editable file: the head's bytes
 *  when reads through revisions are on and the head has the file, otherwise
 *  the folder exactly as readWorkspaceFile answers (same path rules, same
 *  "file not found"). */
export async function readWorkspaceFileVia(tenant: string, workspace: string, rel: string): Promise<string> {
  const p = assertEditablePath(rel);
  const head = await readHeadText(tenant, workspace, p);
  return head !== null ? head : readWorkspaceFile(tenant, workspace, rel);
}
