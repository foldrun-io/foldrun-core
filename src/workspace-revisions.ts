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
import { currentTree, registerJournal, registerRevisionView, registerWorkspaceGone, registerWorkspaceLifecycle, type RevisionView, type RevisionFile, type RevisionSummary, type Revision as HistoryRevision } from "./history.ts";
import { workspaceDir, listTenants, listWorkspaces, readWorkspaceFile, assertEditablePath } from "./store.ts";
import { dataRoot } from "./paths.ts";
import { opsError, opsLog } from "./ops-log.ts";
import { readAll, BlobNotFound, type BlobSweeper } from "./blob-store.ts";
import { fsJournalStore, type JournalStore, type JournalRecord } from "./journal-store.ts";
import {
  blobObjectKey,
  diffManifests,
  emptyManifest,
  entryId,
  EMPTY_MANIFEST_ID,
  MODE_EXEC,
  MODE_FILE,
  sha256Hex,
  sideOf,
  type Changes,
  type Manifest,
} from "./manifest.ts";
import { headsOf, loadManifest, manifestsAt, manifestsOf, publish, restore, requestDigest, PublishError, type Deps, type Heads, type PublishResult } from "./publish.ts";
import { OpIdReused, type Revision, type WorkspaceRef } from "./revision-store.ts";
import { pruneStateRevisions, type StateRetention } from "./state-retention.ts";
import type { SweepMarks } from "./blob-sweeper.ts";

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
  /** How many `state/` checkpoints to keep, and for how long (state-retention.ts).
   *  Unset: none is ever pruned. */
  stateRetention?: () => StateRetention;
  /** How often a workspace's checkpoints are looked at after a commit (ms). */
  retentionEveryMs?: number;
  /** Where "first seen" is kept: lets the boot reconcile remove the history of
   *  workspaces whose folder is gone (cleanOrphanedHistory). Unset: it never does. */
  sweepMarks?: SweepMarks;
  /** How long a workspace must have been seen without its folder before its
   *  history is removed. Default one hour. */
  orphanGraceMs?: number;
}
let gate: { journal: () => boolean; read: () => boolean } = { journal: () => false, read: () => false };
let retention: (() => StateRetention) | null = null;
let orphanMarks: SweepMarks | null = null;
let orphanGrace = 3_600_000;
let retentionEvery = 10 * 60_000;
/** The legacy place: files on the volume. Always replayed at boot (and then
 *  empty), whatever new entries are written to. */
const legacyFiles = fsJournalStore(() => journalRoot());
let primary: JournalStore | null = null;
const journalStores = (): JournalStore[] => (primary && primary !== legacyFiles ? [primary, legacyFiles] : [legacyFiles]);
const entryStore = (): JournalStore => primary ?? legacyFiles;

/** Where revisions live, or null (no journal, nothing changes). */
export function setRevisionBackend(deps: Deps | null, opts: BackendOptions = {}): void {
  // Every commit asks, inside the store's workspace lock, whether the folder is
  // still there: a delete or rename on another pod removes it under that lock.
  backend = deps ? { ...deps, workspaceExists: deps.workspaceExists ?? ((ws) => fs.existsSync(workspaceDir(ws.tenant, ws.workspace))) } : null;
  gate = { journal: opts.journal ?? (() => false), read: opts.read ?? (() => false) };
  primary = opts.journalStore ?? null;
  retention = opts.stateRetention ?? null;
  retentionEvery = opts.retentionEveryMs ?? 10 * 60_000;
  orphanMarks = opts.sweepMarks ?? null;
  orphanGrace = opts.orphanGraceMs ?? 3_600_000;
  registerJournal(deps ? journalChange : null);
  registerWorkspaceGone(deps ? (t, w) => goneNow(t, w) : null);
  registerWorkspaceLifecycle(deps ? { drop: dropWorkspaceRevisions, move: moveWorkspaceRevisions, moved: movedNow } : null);
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
type EntryFile = RevisionFile & { base?: string | null; handed?: string | null };
interface Entry {
  id: string;
  files: EntryFile[];
  by: string;
  message: string;
  at: string;
  /** The revision this change brings back (a restore), when it is one. */
  restoredFrom?: string;
  /** A run's copy-back: the revisions its stage-in started from (pinRunBase). */
  baseRev?: RunBase;
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
const wantPrune = new Set<string>(); // a state checkpoint was committed since the last look
const prunedAt = new Map<string, number>();
/** Workspaces whose commits are held while a delete or rename runs. */
const frozen = new Map<string, Promise<void>>();
const restoring = new Map<string, string>();
const key = (tenant: string, workspace: string) => `${tenant}\0${workspace}`;
const split = (k: string): [string, string] => k.split("\0") as [string, string];

const journalRoot = () => path.join(dataRoot(), ".revision-journal");

/** Write the entry down, atomically. A store that refuses leaves the entry in
 *  memory only (said once per failure), as the journal always was. */
function persist(tenant: string, workspace: string, e: Entry): void {
  const store = entryStore();
  try {
    e.handle = store.put({ v: 1, tenant, workspace, id: e.id, files: e.files as JournalRecord["files"], by: e.by, message: e.message, at: e.at, restoredFrom: e.restoredFrom, baseRev: e.baseRev });
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
  /** The sha of what the step was HANDED (null: no such file; undefined: not
   *  known, or the folder was merged with another writer's change). The head is
   *  held to the pinned revision's copy of the path only where the two agree. */
  handed?: string | null;
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
  meta: { runId?: string; step?: string | number; by?: string; base?: RunBase | null },
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
    files.push({ path: w.path, before: null, after: text, base: w.base, ...(w.handed !== undefined ? { handed: w.handed } : {}) });
  }
  if (!files.length) return 0;
  const idSource = meta.runId ? `${meta.runId}\0${meta.step ?? ""}` : crypto.randomBytes(12).toString("hex");
  enqueue(tenant, workspace, {
    id: `st${sha256Hex(Buffer.from(idSource)).slice(0, 22)}`,
    files,
    by: meta.by ?? (meta.runId ? `run:${meta.runId}` : "run"),
    message: meta.runId ? `run ${meta.runId}${meta.step !== undefined ? ` step ${meta.step}` : ""}` : "run output",
    at: new Date().toISOString(),
    baseRev: meta.base ?? undefined,
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
  // A delete or a rename of this workspace is in progress: nothing commits
  // until it is done (the gate is read now, so a drain started BEFORE it is
  // never behind it — that is what lets the lifecycle wait for those).
  const gate = frozen.get(k);
  const next = (chains.get(k) ?? Promise.resolve())
    .catch(() => {})
    .then(() => gate)
    .then(() => drainOne(k));
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
      const res = await commitEntry(backend, tenant, workspace, entry);
      if (res?.status === "committed" && res.stateRevision) wantPrune.add(k);
      q.shift();
      forget(tenant, workspace, entry);
      retryAt.delete(k);
    } catch (err) {
      if (err instanceof PublishError && err.code === "gone") {
        // The folder is gone (deleted or renamed, here or on another pod): the
        // change has nowhere to go, and nothing should be recorded under the name.
        q.shift();
        forget(tenant, workspace, entry);
        continue;
      }
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
  if (wantPrune.delete(k)) await pruneIfDue(tenant, workspace);
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
  wantPrune.clear();
  prunedAt.clear();
  frozen.clear();
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

// ------------------------------------------------------------- delete and rename
//
// A workspace is named by its folder, and the history is kept under that name.
// Until 8 Nov 2026 a delete left the heads and revisions where they were and a
// rename left them under the old name: a NEW workspace given either name then
// started on the old one's head — its history, and through a restore or a
// read from the head, its files. Now both follow the folder.

/** Hold the commits of these workspaces until the returned function is called.
 *  Waits for an earlier hold on the same workspace first. */
async function freeze(keys: string[]): Promise<() => void> {
  for (const k of keys) while (frozen.has(k)) await frozen.get(k)!.catch(() => {});
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  for (const k of keys) frozen.set(k, gate);
  return () => {
    for (const k of keys) if (frozen.get(k) === gate) frozen.delete(k);
    release();
    for (const k of keys) if (queues.get(k)?.length) void drain(k);
  };
}

const lifecycleBusy = new Set<string>(); // keys a lifecycle call is handling (the sync hooks stay out of its way)

/** What the sync hooks started and has not finished (tests, and a process that is ending). */
const background = new Set<Promise<unknown>>();
export async function settleLifecycle(): Promise<void> {
  while (background.size) await Promise.allSettled([...background]);
}
function inBackground(p: Promise<unknown>): void {
  const q = p.finally(() => background.delete(q));
  background.add(q);
}
/** Try again a few times, then say so: the folder is gone and cannot be asked. */
async function persistently(fn: () => Promise<void>, giveUp: (err: unknown) => void): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= 4) return giveUp(err);
      await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
    }
  }
}

/** The sync hook: a folder was removed by a caller that did not wait for us. */
function goneNow(tenant: string, workspace: string): void {
  dropJournal(tenant, workspace);
  if (lifecycleBusy.has(key(tenant, workspace))) return;
  inBackground(
    persistently(
      () => dropWorkspaceRevisions(tenant, workspace, () => {}),
      (err) => opsError("revisions.drop_failed", err, { tenant, workspace }),
    ),
  );
}

/**
 * A workspace is being deleted: its queued changes, its journal entries and
 * its history (both heads, every revision, the operations, the pins on their
 * manifests) go, so that nothing of it can be seen by, or committed under, the
 * next workspace of that name. `remove` is the folder's own removal. Order:
 * hold the commits; drop; remove the folder; drop again for whatever slipped
 * in between. A store that cannot be reached throws BEFORE `remove` runs.
 */
export async function dropWorkspaceRevisions(tenant: string, workspace: string, remove?: () => void): Promise<void> {
  const deps = backend;
  if (!deps || workspace === "@library") {
    remove?.();
    return;
  }
  const k = key(tenant, workspace);
  lifecycleBusy.add(k);
  const before = chains.get(k);
  const release = await freeze([k]);
  try {
    dropJournal(tenant, workspace);
    await before?.catch(() => {});
    try {
      await deps.revisions.drop({ tenant, workspace });
    } catch (err) {
      // Nothing was removed and the workspace stays: whatever was queued is lost to the queue, so it is reconciled from the folder.
      marked.add(k);
      verified.delete(k);
      throw err;
    }
    remove?.();
    dropJournal(tenant, workspace);
    await deps.revisions.drop({ tenant, workspace });
    marked.delete(k);
    verified.delete(k);
  } finally {
    lifecycleBusy.delete(k);
    release();
  }
}

/** An account is gone: its journal, its history and the blobs under its name.
 *  Throws when the store cannot be reached (the caller says so; nothing of the
 *  rest depends on it). */
export async function dropTenantRevisions(tenant: string): Promise<void> {
  dropJournal(tenant);
  const deps = backend;
  if (!deps) return;
  const mine = [...chains.keys()].filter((k) => split(k)[0] === tenant);
  await Promise.all(mine.map((k) => chains.get(k)!.catch(() => {})));
  for (const k of mine) {
    chains.delete(k);
    marked.delete(k);
    verified.delete(k);
  }
  await deps.revisions.drop({ tenant });
  await (deps.blobs as Partial<BlobSweeper>).purgeTenant?.(tenant);
}

/** The sync hook: a folder was renamed by a caller that did not wait for us. */
function movedNow(tenant: string, from: string, to: string): void {
  if (lifecycleBusy.has(key(tenant, from)) || lifecycleBusy.has(key(tenant, to))) return;
  inBackground(moveWorkspaceRevisions(tenant, from, to).catch((err) => opsError("revisions.move_failed", err, { tenant, workspace: from, to })));
}

/**
 * A workspace is being renamed: its queued changes wait, its history is
 * re-keyed to the new name (whatever the new name held belonged to a workspace
 * that no longer exists), `rename` moves the folder, and the queue and the
 * journal entries follow. If the folder cannot move, the history goes back. A
 * store that cannot be reached throws BEFORE `rename` runs.
 */
export async function moveWorkspaceRevisions(tenant: string, from: string, to: string, rename?: () => void): Promise<void> {
  const deps = backend;
  if (!deps || from === "@library" || to === "@library") {
    rename?.();
    return;
  }
  const ka = key(tenant, from);
  const kb = key(tenant, to);
  lifecycleBusy.add(ka);
  lifecycleBusy.add(kb);
  const befores = [chains.get(ka), chains.get(kb)];
  const release = await freeze([ka, kb].sort());
  try {
    await Promise.all(befores.map((b) => b?.catch(() => {})));
    // Nothing is queued for the new name (no folder has it); what a dead
    // process left for it is stale.
    dropJournal(tenant, to);
    await deps.revisions.move(tenant, from, to);
    if (rename) {
      try {
        rename();
      } catch (err) {
        await deps.revisions.move(tenant, to, from).catch((e) => opsError("revisions.move_back_failed", e, { tenant, workspace: from, to }));
        throw err;
      }
    }
    rekeyQueue(tenant, from, to);
    if (rename) {
      // A commit on another pod that passed its guard between the move and the
      // folder rename left rows under the OLD name; its content is in the
      // folder now, so the old name's rows go and the new name is reconciled.
      await deps.revisions.drop({ tenant, workspace: from });
      marked.add(kb);
    }
  } finally {
    lifecycleBusy.delete(ka);
    lifecycleBusy.delete(kb);
    release();
  }
  if (rename) void drain(kb); // the reconcile marked above
}

/** Queued changes and journal entries of `from` become `to`'s. */
function rekeyQueue(tenant: string, from: string, to: string): void {
  const ka = key(tenant, from);
  const kb = key(tenant, to);
  const q = queues.get(ka) ?? [];
  for (const e of q) forget(tenant, from, e); // the old handles
  for (const st of journalStores()) {
    try {
      st.move(tenant, from, to); // entries no live queue holds (a dead process's)
    } catch (err) {
      opsError("revisions.journal_not_moved", err, { tenant, workspace: from, to, store: st.kind }, "warn");
    }
  }
  const moved = q.map((e) => ({ ...e, store: undefined, handle: undefined }));
  for (const e of moved) persist(tenant, to, e);
  q.length = 0; // a drain that holds the old array has nothing left
  queues.delete(ka);
  if (moved.length) queues.set(kb, moved);
  if (marked.delete(ka)) marked.add(kb);
  verified.delete(ka);
  verified.delete(kb);
  retryAt.delete(ka);
  retryAt.delete(kb);
}

// ------------------------------------------------------------- a run's pinned base

/** The revisions a run's stage-in started from, one per head (null: that head
 *  had no revision yet). */
export interface RunBase {
  workspace: string | null;
  state: string | null;
}
/** A run's pin on the manifests of its base lasts this long without a renewal. */
const RUN_PIN_TTL_MS = 2 * 60 * 60_000;

/**
 * FOL-126 fixes (8 Nov). At stage-in: record which revisions the run starts
 * from and pin their manifests (holder kind `run`, a lease renewed while the
 * step lives), so retention and the sweeper leave them alone. The copy-back is
 * then published against THIS base: a path the head changed since is a
 * conflict, not an overwrite, whatever the folder holds by then.
 *
 * The queue is flushed first, so the head is not behind a save made a moment
 * ago (a head behind the folder would make every such path look conflicting).
 * Null — and the caller carries on as before, with the folder as the base —
 * when revisions are off, there is no head yet (the baseline will hold the
 * whole tree), changes are still queued (the store is down), or the pin cannot
 * be taken.
 */
export async function pinRunBase(tenant: string, workspace: string, holder: string): Promise<{ base: RunBase; release(): Promise<void> } | null> {
  const deps = backend;
  if (!deps || !journalOn() || workspace === "@library") return null;
  try {
    const { pending } = await flushRevisions({ tenant, workspace });
    if (pending) return null;
    const heads = await headsOf(deps, { tenant, workspace });
    if (!heads.workspace && !heads.state) return null;
    return await holdRunBase(deps, tenant, { workspace: heads.workspace?.id ?? null, state: heads.state?.id ?? null }, heads, holder);
  } catch (err) {
    opsError("revisions.run_base_failed", err, { tenant, workspace }, "warn");
    return null;
  }
}

/** The same pin for a base that was recorded earlier (a driver that took over a
 *  step): null when either revision is gone. */
export async function repinRunBase(tenant: string, workspace: string, base: RunBase, holder: string): Promise<{ base: RunBase; release(): Promise<void> } | null> {
  const deps = backend;
  if (!deps || !journalOn()) return null;
  try {
    const w = base.workspace ? await deps.revisions.revision({ tenant, workspace, scope: "workspace" }, base.workspace) : null;
    const s = base.state ? await deps.revisions.revision({ tenant, workspace, scope: "state" }, base.state) : null;
    if ((base.workspace && !w) || (base.state && !s)) return null;
    return await holdRunBase(deps, tenant, base, { workspace: w, state: s }, holder);
  } catch (err) {
    opsError("revisions.run_base_failed", err, { tenant, workspace }, "warn");
    return null;
  }
}

async function holdRunBase(deps: Deps, tenant: string, base: RunBase, revs: Heads, holder: string): Promise<{ base: RunBase; release(): Promise<void> } | null> {
  const pins = deps.pins;
  const pinHolder = { kind: "run" as const, id: holder.slice(0, 200) };
  let timer: ReturnType<typeof setInterval> | null = null;
  if (pins) {
    const ids = [revs.workspace?.authored, revs.state?.state].filter((m): m is string => !!m && m !== EMPTY_MANIFEST_ID);
    await pins.pinManifests(tenant, ids, pinHolder, { ttlMs: RUN_PIN_TTL_MS });
    timer = setInterval(() => void pins.renew(tenant, pinHolder, RUN_PIN_TTL_MS).catch(() => {}), RUN_PIN_TTL_MS / 4);
    timer.unref?.();
  }
  let released = false;
  return {
    base,
    async release() {
      if (released) return;
      released = true;
      if (timer) clearInterval(timer);
      await pins?.release(tenant, pinHolder).catch((err) => opsError("revisions.run_pin_not_released", err, { tenant }, "warn"));
    },
  };
}

// ------------------------------------------------------------- state retention

/** Look at one workspace's `state/` checkpoints now (the host's window). */
export async function pruneStateNow(tenant: string, workspace: string): Promise<{ pruned: number; kept: number; held: number } | null> {
  const deps = backend;
  if (!deps || !retention || !journalOn()) return null;
  const policy = safe2(retention);
  if (!policy) return null;
  try {
    const res = await pruneStateRevisions(deps, { tenant, workspace }, policy);
    prunedAt.set(key(tenant, workspace), Date.now());
    if (res.pruned) opsLog("info", "revisions.state_pruned", { tenant, workspace, pruned: res.pruned, kept: res.kept, held: res.held });
    return res;
  } catch (err) {
    opsError("revisions.state_prune_failed", err, { tenant, workspace }, "warn");
    return null;
  }
}
const safe2 = (fn: () => StateRetention): StateRetention | null => {
  try {
    return fn();
  } catch {
    return null;
  }
};

/** After a state commit: look, but not on every one (a checkpoint per step). */
async function pruneIfDue(tenant: string, workspace: string): Promise<void> {
  const last = prunedAt.get(key(tenant, workspace)) ?? 0;
  if (Date.now() - last < retentionEvery) return;
  await pruneStateNow(tenant, workspace);
}

// ------------------------------------------------------------- history without a workspace

/**
 * FOL-126 fixes (8 Nov 2026), once and idempotent: before the delete took the
 * history with it, the heads and revisions of a deleted workspace stayed, and a
 * new workspace of that name started on them. Any workspace the store has
 * rows for and the volume has no folder for is such a leftover.
 *
 * Removing history is not undone, so it is done carefully: a workspace is
 * RECORDED the first time it is seen without a folder and removed only when it
 * has been seen without one for `graceMs` (a volume that is briefly not
 * mounted, or a listing that came back short, passes); an account whose
 * folders are mostly missing is left alone and said (a partial mount looks
 * exactly like that); nothing is done when the data root itself is empty or
 * absent. A workspace whose folder is back is forgotten. Each removal takes the
 * same lock as a delete (dropWorkspaceRevisions).
 */
export async function cleanOrphanedHistory(
  marks: SweepMarks,
  opts: { graceMs: number; force?: boolean; dryRun?: boolean },
): Promise<{ checked: number; orphans: number; marked: number; dropped: number; skipped: number }> {
  const out = { checked: 0, orphans: 0, marked: 0, dropped: 0, skipped: 0 };
  const deps = backend;
  if (!deps) return out;
  const root = dataRoot();
  let rootEntries = 0;
  try {
    rootEntries = fs.readdirSync(root).filter((n) => !n.startsWith(".")).length;
  } catch {
    // not there
  }
  if (!rootEntries) {
    opsLog("warn", "revisions.orphans_skipped", { reason: "data_root_empty" });
    return out;
  }
  const byTenant = new Map<string, string[]>();
  for (const w of await deps.revisions.workspaces()) {
    if (w.workspace === "@library") continue;
    byTenant.set(w.tenant, [...(byTenant.get(w.tenant) ?? []), w.workspace]);
  }
  const exists = (t: string, w: string) => fs.existsSync(workspaceDir(t, w));
  for (const [tenant, list] of byTenant) {
    out.checked += list.length;
    const missing = list.filter((w) => !exists(tenant, w));
    const known = await marks.load(tenant, "workspace");
    const back = [...known.keys()].filter((w) => !missing.includes(w));
    if (back.length && !opts.dryRun) await marks.clear(tenant, "workspace", back);
    if (!missing.length) continue;
    out.orphans += missing.length;
    if (!opts.force && list.length > 5 && missing.length > list.length / 2) {
      out.skipped += missing.length;
      opsLog("warn", "revisions.orphans_skipped", { tenant, reason: "most_folders_missing", missing: missing.length, total: list.length });
      continue;
    }
    const at = await marks.now();
    const fresh = missing.filter((w) => !known.has(w));
    if (fresh.length && !opts.dryRun) await marks.put(tenant, "workspace", fresh.map((ref) => ({ ref, size: 0 })), at);
    out.marked += fresh.length;
    for (const w of missing) {
      const m = known.get(w);
      if (!m || at.getTime() - m.firstSeen.getTime() < opts.graceMs || opts.dryRun) continue;
      if (exists(tenant, w)) continue; // came back while we looked
      try {
        await dropWorkspaceRevisions(tenant, w);
        await marks.clear(tenant, "workspace", [w]);
        out.dropped++;
      } catch (err) {
        out.skipped++;
        opsError("revisions.orphan_not_dropped", err, { tenant, workspace: w }, "warn");
      }
    }
  }
  if (out.orphans) opsLog("info", "revisions.orphans", { ...out });
  return out;
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
          found.push({ id: e.id, files: e.files, by: e.by, message: e.message, at: e.at, restoredFrom: e.restoredFrom, baseRev: e.baseRev, store, handle });
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
  // First, the history of workspaces that were deleted before the delete took
  // it with them (8 Nov 2026): it must not be reconciled, or found by a new
  // workspace of the same name.
  if (orphanMarks) await cleanOrphanedHistory(orphanMarks, { graceMs: orphanGrace }).catch((err) => opsError("revisions.orphans_failed", err, {}, "warn"));
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
        await pruneStateNow(tenant, w.name);
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

/** The manifests a run's stage-in started from, per side; a side whose revision
 *  is gone (or that had no head) is absent and the caller falls back. */
async function baseManifests(deps: Deps, tenant: string, workspace: string, base?: RunBase): Promise<{ authored?: Manifest; state?: Manifest }> {
  const out: { authored?: Manifest; state?: Manifest } = {};
  if (!base) return out;
  try {
    if (base.workspace) {
      const r = await deps.revisions.revision({ tenant, workspace, scope: "workspace" }, base.workspace);
      if (r) out.authored = await loadManifest(deps, tenant, r.authored);
    }
    if (base.state) {
      const r = await deps.revisions.revision({ tenant, workspace, scope: "state" }, base.state);
      if (r) out.state = await loadManifest(deps, tenant, r.state);
    }
  } catch (err) {
    opsError("revisions.base_unreadable", err, { tenant, workspace }, "warn");
    return {};
  }
  return out;
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

  // A run's copy-back is pinned to the revisions its stage-in started from: a
  // path's base is what THAT revision held, so a head that moved since (another
  // run, a person) is a conflict on the path, and disjoint paths replay. Where
  // the revision cannot be read any more, the folder's sha stands in.
  const fromRev = await baseManifests(deps, tenant, workspace, entry.baseRev);

  const put = (rel: string, text: string, side: "authored" | "state", pinned?: string | null, handed?: string | null) => {
    const buf = Buffer.from(text, "utf8");
    const sha = sha256Hex(buf);
    bytes.set(sha, buf);
    const was = head[side].files[rel];
    const mode = modeOf(tenant, workspace, rel);
    if (was && was.sha === sha && was.mode === mode) return; // the head already holds it
    // The pinned revision's copy of the path is the base only if it is what the
    // step was handed; otherwise (handed from the folder, which was ahead of or
    // different from the head) the folder's sha is the honest base.
    const atRev = fromRev[side]?.files[rel];
    const usable = fromRev[side] !== undefined && handed !== undefined && handed === (atRev ? atRev.sha : null);
    const pinnedTo = pinned === undefined ? undefined : usable ? (atRev ? entryId(atRev) : null) : pinnedBase(pinned, was);
    changes[rel] = { op: "put", base: pinned === undefined ? (was ? entryId(was) : null) : pinnedTo!, sha, size: buf.length, mode };
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
      put(f.path, f.after, side, f.base, f.handed);
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
  const k = key(tenant, workspace);
  // The mark goes BEFORE the folder is read, so one set after the read (a run
  // writing a file too big to journal while this publishes) asks for another
  // repair; a repair that fails puts it back for the next one.
  const wasMarked = marked.delete(k);
  try {
    // The heads first, then the folder: a folder read older than the heads
    // would diff a stale copy against a newer head, and with that head as each
    // path's base the publish would undo the newer write without a conflict.
    const heads = await headsOf(deps, ws);
    const tree = currentTree(tenant, workspace);
    if (!tree) return null;
    const head = await manifestsAt(deps, tenant, heads);
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
    if (!Object.keys(changes).length) return null;
    return await publish(deps, {
      ws,
      // The heads it was diffed against are part of the id: the same changes
      // over a different head (the head was restored since) are a new repair,
      // not a retry of the earlier one.
      opId: opIdOf("jx", requestDigest("reconcile", { changes, heads: [heads.workspace?.id ?? null, heads.state?.id ?? null] }).slice(0, 40)),
      by,
      message: "workspace content recorded",
      changes,
      bytesOf: async (sha) => bytes.get(sha)!,
    });
  } catch (err) {
    if (wasMarked) marked.add(k);
    throw err;
  }
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
