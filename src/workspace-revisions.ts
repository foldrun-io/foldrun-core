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
import { pipeline } from "node:stream/promises";
import { registerJournal, registerRevisionView, registerWorkspaceGone, registerWorkspaceLifecycle, type RevisionView, type RevisionFile, type RevisionSummary, type Revision as HistoryRevision } from "./history.ts";
import { workspaceDir, listTenants, listWorkspaces, readWorkspaceFile, assertEditablePath, isPlatformPath, notifyWorkspaceChanged } from "./store.ts";
import { dataRoot } from "./paths.ts";
import { processState } from "./process-state.ts";
import { opsError, opsLog } from "./ops-log.ts";
import { readAll, fileSource, BlobNotFound, type BlobSweeper } from "./blob-store.ts";
import { fsJournalStore, type JournalStore, type JournalRecord } from "./journal-store.ts";
import {
  AUTHORED_DIRS,
  AUTHORED_ROOT_FILES,
  STATE_DIRS,
  assertManifestPath,
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
  type ManifestEntry,
} from "./manifest.ts";
import { mirrorOn, readMirrorBase, writeMirrorBase, dropMirrorBase, mirroredWorkspaces, type MirrorBase } from "./mirror-base.ts";
import { headsOf, loadManifest, manifestsAt, manifestsOf, publish, restore, requestDigest, stateOpId, BlobMissing, PublishError, type Deps, type Heads, type PublishResult } from "./publish.ts";
import { OpIdReused, type Revision, type WorkspaceRef } from "./revision-store.ts";
import { pruneStateRevisions, type StateRetention } from "./state-retention.ts";
import type { SweepMarks } from "./blob-sweeper.ts";
import { setCallsBackend, dropWorkspaceCalls, settleCalls } from "./captured-calls.ts";
import { dropTenantOutputs, dropWorkspaceOutputs, moveWorkspaceOutputs, settleRunOutputs } from "./run-outputs.ts";

// ------------------------------------------------------------- the backend

/** Everything this module is told at boot, and every queue that goes with it,
 *  is one per PROCESS (process-state.ts), not one per copy of the module: the
 *  dashboard's route handlers are compiled apart from the boot, and until 13
 *  Nov 2026 they saw no backend — a save there was never journalled, and a read
 *  never came from a head. */
const S = processState("workspace-revisions", () => ({
  backend: null as Deps | null,
  gate: { journal: (): boolean => false, read: (): boolean => false },
  retention: null as (() => StateRetention) | null,
  orphanMarks: null as SweepMarks | null,
  orphanGrace: 3_600_000,
  retentionEvery: 10 * 60_000,
  primary: null as JournalStore | null,
  cache: null as BlobCache | null,
  legacy: null as JournalStore | null,
  queues: new Map<string, Entry[]>(),
  chains: new Map<string, Promise<unknown>>(),
  marked: new Set<string>(),
  verified: new Set<string>(),
  unjournalled: new Set<string>(),
  repairing: new Set<string>(),
  retryAt: new Map<string, number>(),
  wantPrune: new Set<string>(),
  prunedAt: new Map<string, number>(),
  frozen: new Map<string, Promise<void>>(),
  restoring: new Map<string, string>(),
  lifecycleBusy: new Set<string>(),
  background: new Set<Promise<unknown>>(),
}));

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
/** The legacy place: files on the volume. Always replayed at boot (and then
 *  empty), whatever new entries are written to. */
const legacyFiles = (S.legacy ??= fsJournalStore(() => journalRoot()));
const journalStores = (): JournalStore[] => (S.primary && S.primary !== legacyFiles ? [S.primary, legacyFiles] : [legacyFiles]);
const entryStore = (): JournalStore => S.primary ?? legacyFiles;

/** Where revisions live, or null (no journal, nothing changes). */
export function setRevisionBackend(deps: Deps | null, opts: BackendOptions = {}): void {
  // Every commit asks, inside the store's workspace lock, whether the folder is
  // still there: a delete or rename on another pod removes it under that lock.
  S.backend = deps ? { ...deps, workspaceExists: deps.workspaceExists ?? ((ws) => fs.existsSync(workspaceDir(ws.tenant, ws.workspace))) } : null;
  S.gate = { journal: opts.journal ?? (() => false), read: opts.read ?? (() => false) };
  S.primary = opts.journalStore ?? null;
  S.retention = opts.stateRetention ?? null;
  S.retentionEvery = opts.retentionEveryMs ?? 10 * 60_000;
  S.orphanMarks = opts.sweepMarks ?? null;
  S.orphanGrace = opts.orphanGraceMs ?? 3_600_000;
  setCallsBackend(deps);
  registerJournal(deps ? journalChange : null);
  registerWorkspaceGone(deps ? (t, w) => goneNow(t, w) : null);
  registerWorkspaceLifecycle(deps ? { drop: dropWorkspaceRevisions, move: moveWorkspaceRevisions, moved: movedNow } : null);
  registerRevisionView(deps ? view : null);
}
export const revisionBackend = (): Deps | null => S.backend;
const journalOn = (): boolean => !!S.backend && safe(S.gate.journal);
/** Reads of content from heads (and run stage-in): its own switch, and only
 *  where the journal runs too (a head that is not kept current is not a source). */
export const revisionReadsOn = (): boolean => journalOn() && safe(S.gate.read);
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
export function setBlobCache(c: BlobCache | null): void {
  S.cache = c;
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
type EntryFile = RevisionFile & {
  base?: string | null;
  handed?: string | null;
  /** `after` is the file's bytes in base64: a file that is not UTF-8 text (an
   *  image, a database). Such an entry is written down as version 2, which a
   *  release from before 13 Nov 2026 sets aside instead of committing the
   *  base64 as the file's text. */
  enc?: "base64";
};
const bytesOfEntry = (f: EntryFile): Buffer => Buffer.from(f.after ?? "", f.enc === "base64" ? "base64" : "utf8");
/** Is this exactly the UTF-8 of some text? (What a history page can show.) */
const isText = (b: Buffer): boolean => Buffer.from(b.toString("utf8"), "utf8").equals(b);
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
const queues = S.queues;
const chains = S.chains;
const marked = S.marked; // overflowed or dropped: needs reconcileWorkspace
const verified = S.verified; // reconciled once in this process
const unjournalled = S.unjournalled; // changed here while the journal was off: the head has not seen it
const repairing = S.repairing; // a reconcile is publishing: the head is about to change
const retryAt = S.retryAt;
const wantPrune = S.wantPrune; // a state checkpoint was committed since the last look
const prunedAt = S.prunedAt;
/** Workspaces whose commits are held while a delete or rename runs. */
const frozen = S.frozen;
const restoring = S.restoring;
const key = (tenant: string, workspace: string) => `${tenant}\0${workspace}`;
const split = (k: string): [string, string] => k.split("\0") as [string, string];

const journalRoot = () => path.join(dataRoot(), ".revision-journal");

/** Write the entry down, atomically. A store that refuses leaves the entry in
 *  memory only (said once per failure), as the journal always was. */
function persist(tenant: string, workspace: string, e: Entry): void {
  const store = entryStore();
  try {
    e.handle = store.put({ v: e.files.some((f) => f.enc) ? 2 : 1, tenant, workspace, id: e.id, files: e.files as JournalRecord["files"], by: e.by, message: e.message, at: e.at, restoredFrom: e.restoredFrom, baseRev: e.baseRev });
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
  if (!S.backend || scope === "@library") return; // the account shelf is not a workspace
  const k = key(tenant, scope);
  if (!safe(S.gate.journal)) {
    verified.delete(k); // a change the head will not see: reconcile before trusting it again
    unjournalled.add(k);
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
 * Every file, whatever it holds: one that is not text rides as base64 (13 Nov
 * 2026; until then a binary file was left out, and the head went stale against
 * the folder). Returns the number of paths queued.
 */
export function recordStepOutputs(
  tenant: string,
  workspace: string,
  writes: StepWrite[],
  meta: { runId?: string; step?: string | number; by?: string; base?: RunBase | null },
): number {
  if (!S.backend || workspace === "@library") return 0;
  const k = key(tenant, workspace);
  if (!safe(S.gate.journal)) {
    verified.delete(k); // the head will not see this: reconcile before trusting it again
    unjournalled.add(k);
    return 0;
  }
  const files: EntryFile[] = [];
  let total = 0;
  for (const w of writes) {
    if (!sideOf(w.path)) continue; // not workspace content (runs/, .foldrun/ …)
    if (isPlatformPath(w.path)) continue; // the engine's own files: never content
    if (w.after.length > MAX_STEP_FILE) {
      marked.add(k); // the folder has it; the reconcile records it
      continue;
    }
    if (total + w.after.length > MAX_STEP_ENTRY) {
      marked.add(k);
      continue;
    }
    total += w.after.length;
    // Bytes that are not text (an image, a database) ride as base64.
    const body = isText(w.after) ? { after: w.after.toString("utf8") } : { after: w.after.toString("base64"), enc: "base64" as const };
    files.push({ path: w.path, before: null, ...body, base: w.base, ...(w.handed !== undefined ? { handed: w.handed } : {}) });
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
  while (q && q.length && S.backend) {
    const entry = q[0];
    // The workspace was deleted while this waited (or retried): nothing to
    // publish, and nothing for a later boot to replay.
    if (!fs.existsSync(workspaceDir(tenant, workspace))) {
      q.shift();
      forget(tenant, workspace, entry);
      continue;
    }
    try {
      const res = await commitEntry(S.backend, tenant, workspace, entry);
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
  if (S.backend && (!q || !q.length) && (!verified.has(k) || marked.has(k)) && fs.existsSync(workspaceDir(tenant, workspace))) {
    verified.add(k);
    try {
      await reconcileNow(tenant, workspace, "reconcile");
    } catch (err) {
      verified.delete(k);
      opsError("revisions.reconcile_failed", err, { tenant, workspace }, "warn");
    }
  }
}

/** An error that retrying will not cure: the manifest refused the content. */
function permanent(err: unknown): boolean {
  if (err instanceof PublishError) return err.code === "bad_change";
  if (err instanceof OpIdReused) return true; // commitEntry asked again and it still is: see there
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
  unjournalled.clear();
  repairing.clear();
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
      unjournalled.delete(k);
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

const lifecycleBusy = S.lifecycleBusy; // keys a lifecycle call is handling (the sync hooks stay out of its way)

/** What the sync hooks started and has not finished (tests, and a process that is ending). */
const background = S.background;
export async function settleLifecycle(): Promise<void> {
  while (background.size) await Promise.allSettled([...background]);
  await settleRunOutputs();
  await settleCalls();
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
  const deps = S.backend;
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
      // Its captured calls' pins, while the rows that name the runs are still there.
      await dropWorkspaceCalls(tenant, workspace);
      await deps.revisions.drop({ tenant, workspace });
      // The run outputs published to the blob store (run-outputs.ts) are this workspace's too.
      await dropWorkspaceOutputs(tenant, workspace);
    } catch (err) {
      // Nothing was removed and the workspace stays: whatever was queued is lost to the queue, so it is reconciled from the folder.
      marked.add(k);
      verified.delete(k);
      throw err;
    }
    remove?.();
    dropJournal(tenant, workspace);
    await dropWorkspaceCalls(tenant, workspace);
    await deps.revisions.drop({ tenant, workspace });
    await dropWorkspaceOutputs(tenant, workspace);
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
  const deps = S.backend;
  if (!deps) return;
  const mine = [...chains.keys()].filter((k) => split(k)[0] === tenant);
  await Promise.all(mine.map((k) => chains.get(k)!.catch(() => {})));
  for (const k of mine) {
    chains.delete(k);
    marked.delete(k);
    verified.delete(k);
  }
  await deps.revisions.drop({ tenant });
  await dropTenantOutputs(tenant);
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
  const deps = S.backend;
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
    await moveWorkspaceOutputs(tenant, from, to).catch(async (err) => {
      await deps.revisions.move(tenant, to, from).catch((e) => opsError("revisions.move_back_failed", e, { tenant, workspace: from, to }));
      throw err;
    });
    if (rename) {
      try {
        rename();
      } catch (err) {
        await deps.revisions.move(tenant, to, from).catch((e) => opsError("revisions.move_back_failed", e, { tenant, workspace: from, to }));
        await moveWorkspaceOutputs(tenant, to, from).catch((e) => opsError("run_outputs.move_back_failed", e, { tenant, workspace: from, to }));
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
  const deps = S.backend;
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
  const deps = S.backend;
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
  const deps = S.backend;
  if (!deps || !S.retention || !journalOn()) return null;
  const policy = safe2(S.retention);
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
  if (Date.now() - last < S.retentionEvery) return;
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
  const deps = S.backend;
  if (!deps) return out;
  // Folders are a copy of the heads (revisions.mirror): a missing one says
  // nothing about the workspace, so nothing is taken for orphaned.
  if (mirrorOn()) return out;
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
          if ((e.v !== 1 && e.v !== 2) || !Array.isArray(e.files)) throw new Error("not a journal entry");
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
  if (S.orphanMarks) await cleanOrphanedHistory(S.orphanMarks, { graceMs: S.orphanGrace }).catch((err) => opsError("revisions.orphans_failed", err, {}, "warn"));
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
        const next = (chains.get(k) ?? Promise.resolve()).catch(() => {}).then(() => reconcileNow(tenant, w.name, opts.by ?? "reconcile"));
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

/** A file this big is sent to the store from disk, never read whole. */
const LARGE_FILE = 8 * 1024 * 1024;
const LARGE_PIN_TTL_MS = 30 * 60_000;

interface FolderFile {
  abs: string;
  sha: string;
  size: number;
  mode: number;
}

async function hashOf(abs: string, size: number): Promise<string> {
  // Read off the event loop: a dashboard process runs this too, and a desk can
  // hold thousands of files.
  if (size <= LARGE_FILE) return sha256Hex(await fs.promises.readFile(abs));
  const h = crypto.createHash("sha256");
  await pipeline(fs.createReadStream(abs), h);
  return h.digest("hex");
}

/**
 * The workspace's content as the folder holds it now: every regular file on
 * one of the two sides (manifest.ts sideOf), whatever its bytes — the rule
 * the data importer has (data-import.ts scanWorkspace) and what a run's
 * stage-in copies, so a head made from it is the folder. Left out, and listed
 * in `left` when the folder holds them: a symbolic link (never followed), the
 * platform's and the engine's own files (isPlatformPath), a name a manifest
 * refuses, the later of two names that differ only by case, a file that could
 * not be read. Null when the folder is not there.
 */
async function scanFolder(tenant: string, workspace: string): Promise<{ files: Map<string, FolderFile>; left: Set<string> } | null> {
  const dir = workspaceDir(tenant, workspace);
  if (!fs.existsSync(dir)) return null;
  const found: { rel: string; abs: string; st: fs.Stats }[] = [];
  const left = new Set<string>();
  const walk = (rel: string) => {
    // A folder that cannot be listed (gone since its parent was read aside)
    // ends the scan: skipped, everything under it would read as deleted.
    let names: string[];
    try {
      names = fs.readdirSync(path.join(dir, rel)).sort();
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
      throw err;
    }
    for (const name of names) {
      const r = `${rel}/${name}`;
      const abs = path.join(dir, r);
      let st: fs.Stats;
      try {
        st = fs.lstatSync(abs);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") continue; // deleted meanwhile
        throw err;
      }
      if (st.isDirectory()) walk(r);
      else if (st.isFile()) found.push({ rel: r, abs, st });
      else left.add(r);
    }
  };
  let top: string[];
  try {
    top = fs.readdirSync(dir).sort();
  } catch {
    return null;
  }
  for (const name of top) {
    const abs = path.join(dir, name);
    let st: fs.Stats;
    try {
      st = fs.lstatSync(abs);
    } catch {
      continue;
    }
    if (st.isDirectory() && (AUTHORED_DIRS.includes(name) || STATE_DIRS.includes(name))) walk(name);
    else if (st.isFile() && sideOf(name) === "authored") found.push({ rel: name, abs, st });
    else if (AUTHORED_ROOT_FILES.includes(name)) left.add(name);
  }
  const files = new Map<string, FolderFile>();
  const lower = new Set<string>();
  for (const f of found.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0))) {
    if (isPlatformPath(f.rel)) continue;
    const fold = f.rel.toLowerCase();
    try {
      assertManifestPath(f.rel);
      if (lower.has(fold)) throw new Error("differs only by case");
      files.set(f.rel, { abs: f.abs, sha: await hashOf(f.abs, f.st.size), size: f.st.size, mode: f.st.mode & 0o111 ? MODE_EXEC : MODE_FILE });
      lower.add(fold);
    } catch {
      left.add(f.rel);
    }
  }
  return { files, left };
}

/** Send the large files among `changes` to the store from disk, pinned first
 *  (as a publish pins what it uploads), so none is held whole in memory; the
 *  publish then finds each in the store and does not ask for its bytes. */
async function uploadLarge(deps: Deps, tenant: string, changes: Changes, onDisk: Map<string, string>, opId: string): Promise<() => Promise<void>> {
  const large = [...new Set(Object.values(changes).flatMap((c) => (c.op === "put" && c.size > LARGE_FILE && onDisk.has(c.sha) ? [c.sha] : [])))];
  if (!large.length) return async () => {};
  const holder = { kind: "publish" as const, id: `${opId}-large` };
  // The pin is held until the caller's publish is over (it returns the release).
  const release = async () => void (await deps.pins?.release(tenant, holder).catch(() => {}));
  await deps.pins?.pinBlobs(tenant, large, holder, { ttlMs: LARGE_PIN_TTL_MS });
  try {
    for (const sha of large) await deps.blobs.putSourceIfAbsent(blobObjectKey(tenant, sha), fileSource(onDisk.get(sha)!), { sha256: sha });
  } catch (err) {
    await release();
    throw err;
  }
  return release;
}

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
  const onDisk = new Map<string, string>(); // sha → a file of the folder that holds it
  let releaseLarge: () => Promise<void> = async () => {};
  const changes: Changes = {};
  const baseline: { authored: boolean; state: boolean } = { authored: !heads.workspace, state: !heads.state };

  // A run's copy-back is pinned to the revisions its stage-in started from: a
  // path's base is what THAT revision held, so a head that moved since (another
  // run, a person) is a conflict on the path, and disjoint paths replay. Where
  // the revision cannot be read any more, the folder's sha stands in.
  const fromRev = await baseManifests(deps, tenant, workspace, entry.baseRev);
  // A pod whose folder is a copy of the heads (revisions.mirror): a change
  // written here was made against the version this pod last synced — its
  // base, so one made meanwhile on another pod is a conflict (both kept),
  // never overwritten (Codex review). Syncs wait while entries are queued, so
  // the record still says what the writer saw.
  const synced = mirrorOn() ? readMirrorBase(tenant, workspace) : null;
  const plainBase = (rel: string, was: ManifestEntry | undefined): string | null =>
    synced ? (synced.files[rel] ? entryId(synced.files[rel]) : null) : was ? entryId(was) : null;

  const put = (rel: string, buf: Buffer, side: "authored" | "state", pinned?: string | null, handed?: string | null) => {
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
    changes[rel] = { op: "put", base: pinned === undefined ? plainBase(rel, was) : pinnedTo!, sha, size: buf.length, mode };
  };

  if (baseline.authored || baseline.state) {
    // Nothing is recorded for (part of) this workspace yet: its tree, as the
    // folder holds it now, is the first revision. That already contains this
    // entry's change, since the writer wrote before it journalled.
    // Every file, as scanFolder lists them (binaries too); each one's bytes are
    // read when the publish asks for them, never all at once.
    for (const [rel, f] of (await scanFolder(tenant, workspace))?.files ?? []) {
      const side = sideOf(rel)!;
      if ((side === "authored" && !baseline.authored) || (side === "state" && !baseline.state)) continue;
      onDisk.set(f.sha, f.abs);
      changes[rel] = { op: "put", base: null, sha: f.sha, size: f.size, mode: f.mode };
    }
    releaseLarge = await uploadLarge(deps, tenant, changes, onDisk, `jb-${entry.id}`);
  }
  for (const f of entry.files) {
    const side = sideOf(f.path);
    if (!side) continue;
    if ((side === "authored" && baseline.authored) || (side === "state" && baseline.state)) continue; // in the baseline
    const was = head[side].files[f.path];
    if (f.after === null) {
      // A delete of a file this pod never synced deletes nothing elsewhere.
      if (was && (!synced || synced.files[f.path])) changes[f.path] = { op: "delete", base: plainBase(f.path, was) ?? entryId(was) };
    } else {
      put(f.path, bytesOfEntry(f), side, f.base, f.handed);
    }
  }
  if (!Object.keys(changes).length) return null;
  // A restore tag only counts when that revision is in the store.
  const restoredFrom = entry.restoredFrom && (await deps.revisions.revision(ws, entry.restoredFrom)) ? entry.restoredFrom : undefined;
  const prefix = baseline.authored || baseline.state ? "jb" : "jr";
  // An entry is two commits (workspace head, then state head), each with its
  // own op id. A retry after only the first landed must still make the second:
  // so a side whose op id has finished is left out, rather than recomputed —
  // recomputed, its changes differ (what landed now matches the head and drops
  // out, a conflict does not), the op id would be "reused", and until 9 Nov
  // 2026 that was taken as the whole entry being done and the state half was
  // never committed (FOL-152). Asked again after an OpIdReused: another pod
  // replaying the same entry may finish a side between the look and the publish.
  try {
    for (let attempt = 0; ; attempt++) {
      const done = await sidesDone(deps, ws, entry.id);
      const todo: Changes = {};
      for (const [p, c] of Object.entries(changes)) if (!done[sideOf(p)!]) todo[p] = c;
      if (!Object.keys(todo).length) return null;
      try {
        return await afterPublish(deps, ws, todo, await publish(deps, {
          ws,
          // The op id of a side that finished, when one did, so the other side's
          // conflict copies are named the way the first attempt would have.
          opId: done.opId ?? opIdOf(prefix, entry.id),
          by: entry.by,
          message: entry.message,
          changes: todo,
          restoredFrom: done.authored ? undefined : restoredFrom,
          bytesOf: async (sha) => {
            const b = bytes.get(sha) ?? (onDisk.has(sha) ? fs.readFileSync(onDisk.get(sha)!) : null);
            if (!b) throw new Error(`the journal lost the bytes for ${sha.slice(0, 12)}…`);
            return b;
          },
        }));
      } catch (err) {
        // Never "done" by itself: a side that finished is found by sidesDone on
        // the next look. One that keeps answering OpIdReused without having
        // finished is a bug, and permanent(): the entry is dropped and the
        // workspace reconciled from the folder, so nothing is lost silently.
        if (!(err instanceof OpIdReused) || attempt >= 2) throw err;
      }
    }
  } finally {
    await releaseLarge();
  }
}

/** Which halves of a journal entry finished in an earlier attempt (an
 *  operation is recorded for each, committed or unchanged). Both prefixes are
 *  asked: an entry that was a baseline when it first ran is not one on retry. */
async function sidesDone(deps: Deps, ws: WorkspaceRef, id: string): Promise<{ authored: boolean; state: boolean; opId?: string }> {
  const out: { authored: boolean; state: boolean; opId?: string } = { authored: false, state: false };
  const ids = ["jb", "jr"].map((prefix) => opIdOf(prefix, id));
  const found = await Promise.all(
    ids.map((opId) => Promise.all([deps.revisions.operation({ ...ws, scope: "workspace" }, opId), deps.revisions.operation({ ...ws, scope: "state" }, stateOpId(opId))])),
  );
  found.forEach(([a, s], i) => {
    if (a) out.authored = true;
    if (s) out.state = true;
    if ((a || s) && !out.opId) out.opId = ids[i];
  });
  return out;
}

/** Bring the heads to the folder's content in one revision: the way in for a
 *  workspace that predates the journal (the importer, phase 8), and the repair
 *  after a journal overflow. Every file scanFolder lists, whatever it holds
 *  (until 13 Nov 2026: only the text files the editor lists, so a binary file
 *  never reached a head and one the importer had put there was never updated
 *  or removed — a run staged from the head was handed files deleted days ago). */
/** Bring the heads to this pod's folder (see reconcileNow), in turn with
 *  everything else that commits this workspace here: two at once would diff
 *  the same folder against the same head and race each other's publish. */
export function reconcileWorkspace(tenant: string, workspace: string, by = "reconcile"): Promise<PublishResult | null> {
  const k = key(tenant, workspace);
  const next = (chains.get(k) ?? Promise.resolve()).catch(() => {}).then(() => reconcileNow(tenant, workspace, by));
  chains.set(k, next);
  return next;
}

async function reconcileNow(tenant: string, workspace: string, by = "reconcile"): Promise<PublishResult | null> {
  const deps = S.backend;
  if (!deps) return null;
  // A copy this pod has not synced yet is not the truth about anything: an
  // empty disk at start would otherwise publish every file as deleted. Its
  // own writes reach the head through the journal; the reconcile waits for a
  // sync to say what "changed here" means.
  if (mirrorOn() && !readMirrorBase(tenant, workspace)) return null;
  const ws: WorkspaceRef = { tenant, workspace };
  const k = key(tenant, workspace);
  // The mark goes BEFORE the folder is read, so one set after the read (a run
  // writing a file too big to journal while this publishes) asks for another
  // repair; a repair that fails puts it back for the next one.
  const wasMarked = marked.delete(k);
  const wasUnjournalled = unjournalled.delete(k);
  repairing.add(k);
  try {
    // The heads first, then the folder: a folder read older than the heads
    // would diff a stale copy against a newer head, and with that head as each
    // path's base the publish would undo the newer write without a conflict.
    const heads = await headsOf(deps, ws);
    const scan = await scanFolder(tenant, workspace);
    if (!scan) return null;
    const head = await manifestsAt(deps, tenant, heads);
    const onDisk = new Map<string, string>();
    let want: Manifest = emptyManifest();
    let have: Manifest = { v: 1, files: { ...head.authored.files, ...head.state.files } };
    for (const [rel, f] of scan.files) {
      onDisk.set(f.sha, f.abs);
      want.files[rel] = { sha: f.sha, size: f.size, mode: f.mode };
    }
    // A pod whose folder is a copy of the heads (revisions.mirror): only what
    // differs from the last sync is this pod's change. A difference from the
    // head alone is someone else's change not copied here yet, never undone.
    const base = mirrorOn() ? readMirrorBase(tenant, workspace) : null;
    if (base) ({ have, want } = threeWay(have, scan, base, workspaceDir(tenant, workspace)));
    // A path the scan could not take (unreadable now, a name the manifest
    // refuses) but the folder still holds is neither added nor removed here;
    // one that is gone from the folder is gone from the head.
    // Never beside a name that differs from it only by case (a manifest holds
    // one of the two): the folder's first, as the scan chose, is the one kept.
    const taken = new Set(Object.keys(want.files).map((p) => p.toLowerCase()));
    for (const p of Object.keys(have.files)) {
      if (!(p in want.files) && scan.left.has(p) && !taken.has(p.toLowerCase())) want.files[p] = have.files[p];
    }
    const changes = diffManifests(have, want);
    if (!Object.keys(changes).length) return null;
    // The heads it was diffed against are part of the id: the same changes
    // over a different head (the head was restored since) are a new repair,
    // not a retry of the earlier one.
    const opId = opIdOf("jx", requestDigest("reconcile", { changes, heads: [heads.workspace?.id ?? null, heads.state?.id ?? null] }).slice(0, 40));
    const release = await uploadLarge(deps, tenant, changes, onDisk, opId);
    try {
      return await afterPublish(deps, ws, changes, await publish(deps, {
      ws,
      opId,
      by,
      message: "workspace content recorded",
      changes,
      // Read when asked, one file at a time; publish checks the bytes against
      // the sha, so a file that changed since the scan fails this repair (the
      // mark is put back and the next one sees the new bytes).
        bytesOf: async (sha) => fs.promises.readFile(onDisk.get(sha)!),
      }));
    } finally {
      await release();
    }
  } catch (err) {
    if (wasMarked) marked.add(k);
    if (wasUnjournalled) unjournalled.add(k);
    throw err;
  } finally {
    repairing.delete(k);
  }
}

/** After this pod published changes of its own (revisions.mirror): what it
 *  published is now what the heads hold, so its copy is synced for those
 *  paths. A path that conflicted kept the head's version (this pod's is the
 *  conflict copy beside it), so this pod takes the head's version too — unless
 *  the file changed here again since. Returns the result unchanged. */
async function afterPublish(deps: Deps, ws: WorkspaceRef, changes: Changes, r: PublishResult): Promise<PublishResult> {
  if (!mirrorOn()) return r;
  try {
    const { tenant, workspace } = ws;
    const base: MirrorBase = readMirrorBase(tenant, workspace) ?? { workspaceHead: null, stateHead: null, files: {}, at: new Date().toISOString() };
    const conflicted = new Set(r.conflicts.map((c) => c.path));
    const dir = workspaceDir(tenant, workspace);
    let head: Record<string, ManifestEntry> | null = null;
    for (const [p, c] of Object.entries(changes)) {
      if (!conflicted.has(p)) {
        if (c.op === "delete") delete base.files[p];
        else base.files[p] = { sha: c.sha, mode: c.mode };
        continue;
      }
      head ??= await (async () => {
        const m = await manifestsAt(deps, tenant, await headsOf(deps, ws));
        return { ...m.authored.files, ...m.state.files };
      })();
      const winner = head[p];
      const abs = path.join(dir, p);
      // Never through a link, on any branch below (Codex review).
      if (throughLink(dir, p) || (fs.existsSync(abs) && fs.lstatSync(abs).isSymbolicLink())) continue;
      const local = fs.existsSync(abs) ? sha256Hex(fs.readFileSync(abs)) : null;
      // Only while the file is still what this pod published (or gone, for a delete).
      if (c.op === "delete" ? local !== null : local !== c.sha) continue;
      if (winner) {
        const b = await blobBytes(deps, tenant, winner.sha);
        if (!b) continue;
        // Again after the download: an edit made meanwhile is kept, and never
        // through a link — the file or a folder on its way (Codex review).
        if (throughLink(dir, p) || (fs.existsSync(abs) && fs.lstatSync(abs).isSymbolicLink())) continue;
        if ((fs.existsSync(abs) ? sha256Hex(fs.readFileSync(abs)) : null) !== local) continue;
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        // A new file renamed over the old one: replaces it, follows nothing.
        const tmp = `${abs}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.mirror-tmp`;
        fs.writeFileSync(tmp, b, { mode: winner.mode === MODE_EXEC ? 0o755 : 0o644 });
        fs.chmodSync(tmp, winner.mode === MODE_EXEC ? 0o755 : 0o644);
        fs.renameSync(tmp, abs);
        base.files[p] = { sha: winner.sha, mode: winner.mode };
      } else {
        // The head deleted it; this pod's version is the conflict copy. The
        // original goes too, or the next reconcile would bring it back.
        fs.rmSync(abs, { force: true });
        delete base.files[p];
      }
    }
    writeMirrorBase(tenant, workspace, { ...base, at: new Date().toISOString() });
  } catch (err) {
    opsError("revisions.mirror_note_failed", err, { tenant: ws.tenant, workspace: ws.workspace }, "warn");
  }
  return r;
}

/** The reconcile's diff for a mirrored folder: the head, with this pod's own
 *  changes since its last sync on top — each path's base the version it was
 *  synced at, so one someone else changed meanwhile is a conflict (both kept),
 *  never a silent overwrite. */
function threeWay(headM: Manifest, scan: { files: Map<string, FolderFile>; left: Set<string> }, base: MirrorBase, dir: string): { have: Manifest; want: Manifest } {
  const have: Manifest = { v: 1, files: { ...headM.files } };
  const want: Manifest = { v: 1, files: { ...headM.files } };
  const same = (a: { sha: string; mode: number } | undefined, b: { sha: string; mode: number } | undefined) => !!a && !!b && a.sha === b.sha && a.mode === b.mode;
  for (const [p, f] of scan.files) {
    const synced = base.files[p];
    if (same(f, synced) || same(f, headM.files[p])) continue; // not changed here, or already the head's
    if (synced) have.files[p] = { sha: synced.sha, mode: synced.mode, size: headM.files[p]?.size ?? 0 };
    else delete have.files[p];
    want.files[p] = { sha: f.sha, size: f.size, mode: f.mode };
  }
  for (const [p, synced] of Object.entries(base.files)) {
    if (scan.files.has(p) || scan.left.has(p)) continue;
    if (throughLink(dir, p)) continue; // out of reach under a link, not deleted
    // Deleted here since the sync: gone from the head too, from the version
    // this pod had (a newer one elsewhere makes it a conflict).
    if (!headM.files[p]) continue;
    have.files[p] = { sha: synced.sha, mode: synced.mode, size: headM.files[p].size };
    delete want.files[p];
  }
  return { have, want };
}

/**
 * Bring this pod's copy of a workspace to its heads (FOL-126, the shared
 * volume retired; revisions.mirror). What changed in the heads since the last
 * sync is written or removed; what changed HERE since then is left as it is
 * and handed to the reconcile, which publishes it against the version it was
 * synced at. Never while this pod has changes of its own still to publish.
 * A workspace whose heads are gone (deleted, renamed away) is removed here
 * only if this pod's copy came from them.
 */
export function syncFromHeads(tenant: string, workspace: string): Promise<"unchanged" | "synced" | "skipped" | "removed" | "absent"> {
  // In turn with this workspace's commits and reconciles here (the same
  // chain): a reconcile must never scan a folder a sync is half way through,
  // or the files it already brought would read as this pod's changes (Codex
  // review).
  if (!S.backend || !mirrorOn()) return Promise.resolve("skipped");
  const k = key(tenant, workspace);
  const next = (chains.get(k) ?? Promise.resolve()).catch(() => {}).then(() => syncNow(tenant, workspace));
  chains.set(k, next);
  return next;
}

async function syncNow(tenant: string, workspace: string): Promise<"unchanged" | "synced" | "skipped" | "removed" | "absent"> {
  const deps = S.backend;
  if (!deps || !mirrorOn()) return "skipped";
  const k = key(tenant, workspace);
  const busy = () => (queues.get(k)?.length ?? 0) > 0 || repairing.has(k) || frozen.has(k);
  if (busy()) return "skipped";
  const dir = workspaceDir(tenant, workspace);
  // A copy whose folder is gone (the disk was cleared, a hand rm) starts again
  // from the heads: with the old record kept, every file would read as deleted
  // here and the reconcile would publish those deletes (Codex review).
  let base = readMirrorBase(tenant, workspace);
  if (base && !fs.existsSync(dir)) {
    dropMirrorBase(tenant, workspace);
    base = null;
  }
  const heads = await headsOf(deps, { tenant, workspace });
  if (!heads.workspace && !heads.state) {
    if (!base) return "absent";
    if (busy()) return "skipped";
    fs.rmSync(dir, { recursive: true, force: true });
    dropMirrorBase(tenant, workspace);
    notifyWorkspaceChanged(tenant, workspace, "delete");
    return "removed";
  }
  const ids = { workspaceHead: heads.workspace?.id ?? null, stateHead: heads.state?.id ?? null };
  if (base && base.workspaceHead === ids.workspaceHead && base.stateHead === ids.stateHead && fs.existsSync(dir)) return "unchanged";
  const m = await manifestsAt(deps, tenant, heads);
  const target: Record<string, ManifestEntry> = { ...m.authored.files, ...m.state.files };
  fs.mkdirSync(dir, { recursive: true });
  const scan = (await scanFolder(tenant, workspace)) ?? { files: new Map<string, FolderFile>(), left: new Set<string>() };
  const synced = base?.files ?? {};
  const next: MirrorBase["files"] = {};
  // What this pass has done so far, over the old base: kept if it stops early
  // (a download fails, a write lands), so what it wrote is not later taken for
  // this pod's own change. The head ids stay the old ones, so the next pass
  // runs again (Codex review).
  const progress: MirrorBase["files"] = { ...synced };
  let finished = false;
  let touched = false;
  let blocked = false; // a head file could not be put in place: not counted as synced
  try {
  let ownChanges = false;
  let wrote = 0;
  // A file here that differs from what the last sync brought is this pod's
  // own: one the sync never brought (or the first sync of a folder that
  // already had files) counts as made here — kept, never overwritten.
  const mine = (p: string, f: FolderFile) => {
    const s = synced[p];
    return !s || f.sha !== s.sha || f.mode !== s.mode;
  };
  for (const [p, f] of scan.files) {
    if (p in target) continue;
    const s = synced[p];
    if (s && s.sha === f.sha && s.mode === f.mode) {
      if (busy()) return "skipped";
      // Still untouched right now (a tool may have written it since the scan,
      // and such a write queues nothing): only then removed (Codex review).
      if (throughLink(dir, p) || (fs.existsSync(f.abs) && fs.lstatSync(f.abs).isSymbolicLink())) {
        blocked = true; // a link appeared on the way since the scan: never followed (Codex review)
        next[p] = s;
        continue;
      }
      if (fs.existsSync(f.abs) && (sha256Hex(fs.readFileSync(f.abs)) !== f.sha || modeOfFile(f.abs) !== f.mode)) {
        ownChanges = true;
        next[p] = s;
        continue;
      }
      fs.rmSync(f.abs, { force: true }); // removed in the heads, untouched here
      delete progress[p];
      touched = true;
      wrote++;
    } else {
      // Made or changed here: the reconcile publishes it — against the version
      // it was synced at, so a delete elsewhere stays a conflict (Codex review).
      ownChanges = true;
      if (s) next[p] = s;
    }
  }
  for (const [p, e] of Object.entries(target)) {
    const f = scan.files.get(p);
    if (f && f.sha === e.sha && f.mode === e.mode) {
      next[p] = { sha: e.sha, mode: e.mode };
      continue;
    }
    // Under a folder that is now a link here, a file is out of reach — not
    // deleted: left, and retried, never published as gone (Codex review).
    if (!f && throughLink(dir, p)) {
      blocked = true;
      if (synced[p]) next[p] = synced[p];
      continue;
    }
    if (scan.left.has(p) || (f ? mine(p, f) : !!synced[p])) {
      // This pod's own change (or a path the scan could not take): kept, and
      // its base stays what it was synced at. A path the scan could not take
      // (a link at the file itself) is retried next pass, like one under a
      // linked folder (Codex review).
      ownChanges = true;
      if (scan.left.has(p)) blocked = true;
      if (synced[p]) next[p] = synced[p];
      continue;
    }
    if (busy()) return "skipped"; // a write landed meanwhile: next round
    const bytes = await blobBytes(deps, tenant, e.sha);
    if (!bytes) throw new Error(`revisions: blob ${e.sha.slice(0, 12)} of ${tenant}/${workspace}/${p} is missing`);
    const abs = path.join(dir, p);
    // Never through a link: a folder on the way that is a symlink could lead
    // outside the workspace (Codex review). Such a path is left as it is.
    if (throughLink(dir, p)) {
      blocked = true; // tried again next pass: the heads are not counted as reached
      if (synced[p]) next[p] = synced[p];
      continue;
    }
    // A folder where the file goes (the heads turned a folder into a file):
    // its files were removed above if they were the heads'; an empty one goes.
    if (fs.existsSync(abs) && fs.lstatSync(abs).isDirectory()) {
      if (fs.readdirSync(abs, { recursive: true }).some((n) => !fs.statSync(path.join(abs, String(n))).isDirectory())) {
        ownChanges = true;
        blocked = true;
        continue;
      }
      fs.rmSync(abs, { recursive: true, force: true });
    }
    // Again after the download: a writer may have queued a change or touched
    // this very file while it ran (Codex review). The file must still be what
    // the scan saw, or it is this pod's change now and is left alone.
    if (busy()) return "skipped";
    const nowSha = fs.existsSync(abs) ? sha256Hex(fs.readFileSync(abs)) : null;
    if (nowSha !== (f?.sha ?? null) || (f && modeOfFile(abs) !== f.mode)) {
      ownChanges = true;
      if (synced[p]) next[p] = synced[p];
      continue;
    }
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    const tmp = `${abs}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.mirror-tmp`;
    fs.writeFileSync(tmp, bytes, { mode: e.mode === MODE_EXEC ? 0o755 : 0o644 });
    fs.chmodSync(tmp, e.mode === MODE_EXEC ? 0o755 : 0o644);
    fs.renameSync(tmp, abs);
    next[p] = { sha: e.sha, mode: e.mode };
    progress[p] = next[p];
    touched = true;
    wrote++;
  }
  // A file the heads have that could not be put in place (a link, a folder in
  // the way) keeps the old head ids, so every pass looks again rather than
  // answering "unchanged" until the next commit (Codex review).
  writeMirrorBase(tenant, workspace, { ...(blocked ? { workspaceHead: base?.workspaceHead ?? null, stateHead: base?.stateHead ?? null } : ids), files: next, at: new Date().toISOString() });
  finished = true;
  if (ownChanges) requestReconcile(tenant, workspace);
  if (wrote) notifyWorkspaceChanged(tenant, workspace, "write");
  return "synced";
  } finally {
    if (!finished && touched) writeMirrorBase(tenant, workspace, { workspaceHead: base?.workspaceHead ?? null, stateHead: base?.stateHead ?? null, files: progress, at: new Date().toISOString() });
  }
}

/** A file's mode as a manifest holds it. */
function modeOfFile(abs: string): number {
  return fs.statSync(abs).mode & 0o111 ? MODE_EXEC : MODE_FILE;
}

/** Does any folder on the way to `rel` (inside `dir`) exist as a symlink? */
function throughLink(dir: string, rel: string): boolean {
  const parts = rel.split("/").slice(0, -1);
  let at = dir;
  for (const part of parts) {
    at = path.join(at, part);
    let st: fs.Stats;
    try {
      st = fs.lstatSync(at);
    } catch {
      return false; // not there yet: made below, as a real folder
    }
    if (st.isSymbolicLink()) return true;
    if (!st.isDirectory()) return false; // a file in the way: removed above or reported
  }
  return false;
}

/** Every workspace with heads, and every copy here whose heads are gone. One
 *  failure does not stop the rest. */
export async function syncAllFromHeads(): Promise<{ synced: number; removed: number; failed: number }> {
  const deps = S.backend;
  const out = { synced: 0, removed: 0, failed: 0 };
  if (!deps?.revisions.allHeads || !mirrorOn()) return out;
  const all = await deps.revisions.allHeads();
  const seen = new Set(all.map((h) => key(h.tenant, h.workspace)));
  const todo = [...all.map((h) => ({ tenant: h.tenant, workspace: h.workspace })), ...mirroredWorkspaces().filter((w) => !seen.has(key(w.tenant, w.workspace)))];
  for (const w of todo) {
    try {
      const r = await syncFromHeads(w.tenant, w.workspace);
      if (r === "synced") out.synced++;
      else if (r === "removed") out.removed++;
    } catch (err) {
      out.failed++;
      opsError("revisions.mirror_sync_failed", err, { tenant: w.tenant, workspace: w.workspace }, "warn");
    }
  }
  return out;
}

// ------------------------------------------------------------- reading

async function blobBytes(deps: Deps, tenant: string, sha: string): Promise<Buffer | null> {
  const hit = await S.cache?.get(tenant, sha);
  if (hit) return hit;
  try {
    const b = await readAll(deps.blobs, blobObjectKey(tenant, sha));
    void S.cache?.put(tenant, sha, b).catch(() => {});
    return b;
  } catch (err) {
    if (err instanceof BlobNotFound) return null;
    throw err;
  }
}

/** One file of the workspace as its heads hold it: head → manifest → blob.
 *  Null when there is no such file (or no head yet). */
export async function readAtHead(tenant: string, workspace: string, rel: string): Promise<Buffer | null> {
  const deps = S.backend;
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
export async function listRevisionSummaries(tenant: string, workspace: string, opts: { limit?: number; forPath?: string; paths?: boolean } = {}): Promise<RevisionSummary[]> {
  const deps = S.backend;
  if (!deps) return [];
  const want = opts.limit ?? 200;
  // `paths: false` (resolving a restore point) needs only who, when and why:
  // no manifest is read, and every row says paths [].
  const withPaths = opts.paths !== false || !!opts.forPath;
  // Page by page: the store answers at most PAGE revisions a call, and until
  // 9 Nov 2026 that first page was taken as the whole history, so a revision
  // older than the 500th could not be listed or resolved (FOL-152). A search
  // for one path still looks at no more than FOR_PATH_SCAN of them: each is two
  // manifest reads.
  const scanUpTo = opts.forPath ? FOR_PATH_SCAN : Infinity;
  const out: RevisionSummary[] = [];
  let before: number | undefined;
  for (let scanned = 0; out.length < want && scanned < scanUpTo; ) {
    const ask = opts.forPath ? Math.min(PAGE, scanUpTo - scanned) : Math.min(PAGE, want - out.length);
    const revs = await deps.revisions.revisions({ tenant, workspace }, { limit: ask, ...(before !== undefined ? { before } : {}) });
    if (!revs.length) break;
    scanned += revs.length;
    // Eight at a time: each revision is two manifest reads, and a history page
    // asks for hundreds.
    for (let i = 0; i < revs.length && out.length < want; i += 8) {
      const rows = await Promise.all(
        revs.slice(i, i + 8).map(async (r) => {
          if (!withPaths) return { id: r.id, at: r.at, by: r.by, message: r.message, commit: null, paths: [] } as RevisionSummary;
          const [mine, parent] = await Promise.all([loadManifest(deps, tenant, r.authored), parentManifest(deps, tenant, workspace, r)]);
          return { id: r.id, at: r.at, by: r.by, message: r.message, commit: null, paths: Object.keys(diffManifests(parent, mine)).sort() } as RevisionSummary;
        }),
      );
      for (const row of rows) {
        if (opts.forPath && !row.paths.includes(opts.forPath)) continue;
        if (out.length < want) out.push(row);
      }
    }
    before = revs[revs.length - 1].seq;
    if (before <= 1) break; // that was the first revision: nothing older to ask for
  }
  return out;
}
/** The most revisions the store answers in one call (revision-store.ts). */
const PAGE = 500;
const FOR_PATH_SCAN = 500;

/** One revision of the workspace head, by id, without listing: the history's
 *  "is this a restore point" and "which revision is that id". */
export async function revisionSummary(tenant: string, workspace: string, id: string): Promise<RevisionSummary | null> {
  const deps = S.backend;
  if (!deps) return null;
  const r = await deps.revisions.revision({ tenant, workspace }, id);
  return r ? { id: r.id, at: r.at, by: r.by, message: r.message, commit: null, paths: [] } : null;
}

/** One revision with what changed, in history.ts's Revision shape (text
 *  before/after, clipped). */
export async function readRevisionDetail(tenant: string, workspace: string, id: string, forPath?: string): Promise<HistoryRevision | null> {
  const deps = S.backend;
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
    const text = async (e: typeof was) => {
      const b = e ? await blobBytes(deps, tenant, e.sha) : null;
      // A file that is not text has nothing to diff: say what it is.
      return b ? (isText(b) ? b.toString("utf8") : `(binary file, ${b.length} bytes, sha256 ${e!.sha.slice(0, 12)})`) : null;
    };
    files.push({ path: p, before: clip(await text(was)), after: c.op === "delete" ? null : clip(await text(now)) });
  }
  return { id: r.id, at: r.at, by: r.by, message: r.message, commit: null, files };
}

/** The whole tree at a revision (the files a restore would bring back), text.
 *  All of it or an error: a file whose blob cannot be had throws BlobMissing.
 *  Until 9 Nov 2026 such a file was left out, and a tree that lacks a file is
 *  indistinguishable from one where it was deleted — a restore from it would
 *  have removed the file from the folder (FOL-152). Through history.ts the
 *  error answers "no snapshot", and the restore refuses. */
export async function snapshotFiles(tenant: string, workspace: string, id: string): Promise<{ path: string; content: string }[] | null> {
  const deps = S.backend;
  if (!deps) return null;
  const r = await deps.revisions.revision({ tenant, workspace }, id);
  if (!r) return null;
  const m = await loadManifest(deps, tenant, r.authored);
  const out: { path: string; content: string }[] = [];
  for (const [p, e] of Object.entries(m.files).sort(([a], [b]) => a.localeCompare(b))) {
    const b = await blobBytes(deps, tenant, e.sha);
    if (!b) throw new BlobMissing(p, e.sha);
    // Text only: this is what a restore writes back through a deploy, as text.
    // A binary file is left where it is, as files outside history always were
    // (13 Nov 2026: until then its bytes were decoded as text here, and a
    // restore would have written the damaged copy over the file).
    if (!isText(b)) continue;
    out.push({ path: p, content: b.toString("utf8") });
  }
  return out;
}

/** Restore = a NEW revision pointing at an old one's blobs. History is kept;
 *  `state/` is rewound only when `stateTo` names a state revision. The caller
 *  then writes the files to the folder (snapshotFiles) as the restore route
 *  always did; the journal sees that write as a no-op because the head already
 *  holds the content. */
export async function restoreRevision(tenant: string, workspace: string, to: string, opts: { by: string; opId: string; message?: string; stateTo?: string }): Promise<PublishResult | null> {
  const deps = S.backend;
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
  get: (t, w, id) => guarded("get", t, w, () => revisionSummary(t, w, id)),
};

// ------------------------------------------------------------- reads through heads

/** One workspace file, from its head when reads through revisions are on and
 *  the head has it; null otherwise, and the caller reads the folder (the
 *  fallback is the point: a head behind the folder, a missing blob, a store
 *  that is down, a binary file the tree reader never recorded). */
export async function readHeadText(tenant: string, workspace: string, rel: string): Promise<string | null> {
  if (!revisionReadsOn() || headBehind(tenant, workspace, rel)) return null;
  try {
    const b = await readAtHead(tenant, workspace, rel);
    return b ? b.toString("utf8") : null;
  } catch (err) {
    opsError("revisions.read_failed", err, { tenant, workspace }, "warn");
    return null;
  }
}

/** The folder and the head were seen to disagree (a run's stage-in compares
 *  them): bring the head to the folder, in the background. */
export function requestReconcile(tenant: string, workspace: string): void {
  if (!journalOn()) return;
  const k = key(tenant, workspace);
  if (marked.has(k)) return;
  marked.add(k);
  setImmediate(() => void drain(k));
}

/** Is the head known, in this process, not to hold the folder's copy of `rel`?
 *  A change to it is queued (its commit failed or has not run yet), the
 *  workspace is marked for a repair or being repaired, or it was written while
 *  the journal was off. The folder is the working copy and what a save's
 *  `ifMatch` is checked against, so a read that answered the older head there
 *  would tell the client a hash its next save can never match (FOL-152).
 *  In-memory only, so it costs nothing per read; a change another process
 *  has queued is not seen here. */
function headBehind(tenant: string, workspace: string, rel: string): boolean {
  const k = key(tenant, workspace);
  if (marked.has(k) || unjournalled.has(k) || repairing.has(k)) return true;
  return !!queues.get(k)?.some((e) => e.files.some((f) => f.path === rel));
}

/** Every file of the workspace head with its bytes and mode (both heads), for
 *  a stage-in; null when reads through revisions are off, there is no head,
 *  or any blob could not be had (the caller then stages from the folder). */
export async function readHeadTree(tenant: string, workspace: string): Promise<{ path: string; bytes: Buffer; mode: number }[] | null> {
  const deps = S.backend;
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
 *  when reads through revisions are on, the head has the file and nothing in
 *  this process says the head is behind the folder for it (headBehind), otherwise
 *  the folder exactly as readWorkspaceFile answers (same path rules, same
 *  "file not found"). */
export async function readWorkspaceFileVia(tenant: string, workspace: string, rel: string): Promise<string> {
  const p = assertEditablePath(rel);
  const head = await readHeadText(tenant, workspace, p);
  return head !== null ? head : readWorkspaceFile(tenant, workspace, rel);
}
