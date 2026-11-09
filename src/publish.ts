// The publish protocol (FOL-126, phase 1). No caller uses it yet.
//
// Every write to a workspace — a run's copy-back, a dashboard save, /deploy,
// the assistant, /import, /restore — ends the same way:
//
//   1. The writer starts from a pinned base: it staged a revision, and every
//      change it makes records the sha it STARTED from (`PathChange.base`).
//   2. publish() uploads the new blobs (conditional put: identical content is
//      a no-op) — outside any transaction, so slow uploads never hold one.
//   3. It folds the changes onto the CURRENT head:
//        - the head still holds the sha the writer started from → apply;
//        - the head already holds what the writer wants → nothing to do;
//        - the head holds something else → a CONFLICT on that path: the head's
//          version stays, the writer's version is kept beside it as
//          `<stem>.conflict-<op>.<ext>`. Different paths never conflict, so
//          two runs editing different memory files both land. There is no
//          merge of text, JSON or binaries (applyContainerChanges' append
//          merge stays where it is, before the changes reach here).
//   4. It uploads the new manifests, confirms every blob the result names is
//      still in the store (a sweeper may have removed one that nothing
//      referenced yet — we hold the bytes, so we put it back), and then makes
//      ONE commit: compare-and-set the head, insert the revision, record the
//      op id. Nothing before that step changes what anyone reads.
//   5. The head moved meanwhile → stale → fold again on the new head.
//   6. The op id committed already (a retry after a lost answer) → `duplicate`
//      with the original revision. A retry never publishes twice.
//
// A crash anywhere before step 4's commit leaves orphan blobs and manifests —
// unreferenced, invisible, collected later — and the old head. A crash after
// the commit leaves the new head. Never a mix: the head moves in one step.
//
// THE GC WINDOW (closed in phase 2). A sweeper that deleted between "the blobs
// are there" and "the commit landed" would strand the new revision. Now the
// publisher pins its blobs (BlobPins, blob-pins.ts) BEFORE it checks they
// exist and releases them after the commit; a revision pins its manifests in
// the same transaction as the commit; the sweeper deletes only through
// `guardDelete`. See blob-pins.ts for the argument.
//
// TWO HEADS (decided 6 Nov 2026). Authored files move on the workspace head and
// `state/` on its own state head, so a per-step state checkpoint never makes a
// source save replay (or the reverse). One publish() call whose changes touch
// both sides is therefore two commits — workspace first, then state, with a
// derived op id — and each is idempotent on its own: a crash between them is
// finished by retrying the same call. A revision names the manifest of its own
// side and EMPTY_MANIFEST_ID for the other.
//
// Restore is a publish too: a new revision whose manifest is an old one.
// History is never rewritten; `state/` is rewound only when asked, by naming a
// state revision (`stateTo`).

import type { BlobStore } from "./blob-store.ts";
import { BlobNotFound, readAll } from "./blob-store.ts";
import { PUBLISH_PIN_TTL_MS, type BlobPins } from "./blob-pins.ts";
import {
  applyChanges,
  assertManifest,
  assertManifestPath,
  blobObjectKey,
  canonicalManifest,
  conflictPath,
  EMPTY_MANIFEST_ID,
  emptyManifest,
  entryId,
  manifestId,
  manifestObjectKey,
  parseManifest,
  sha256Hex,
  sideOf,
  MODE_EXEC,
  MODE_FILE,
  type Changes,
  type Manifest,
  type ManifestId,
  type PathChange,
  type Side,
} from "./manifest.ts";
import { assertOpId, OpIdReused, type RevisionStore, type Revision, type Scope, type WorkspaceRef } from "./revision-store.ts";

export interface Deps {
  blobs: BlobStore;
  revisions: RevisionStore;
  /** Durable pins for GC. Unset = none (an install with no database has no sweeper). */
  pins?: BlobPins;
  /** Does this workspace exist right now? Handed to every commit as its guard
   *  (revision-store.ts CommitInput.guard). Unset: commits are not guarded. */
  workspaceExists?: (ws: WorkspaceRef) => boolean | Promise<boolean>;
}

/** A revision (or a publish) names a blob the store does not have. Explicit,
 *  never an empty file: the caller decides whether this is a repair or a
 *  refusal. */
export class BlobMissing extends Error {
  readonly path: string;
  readonly sha: string;
  constructor(path: string, sha: string) {
    super(`${path}: its content (${sha.slice(0, 12)}…) is missing from the store`);
    this.name = "BlobMissing";
    this.path = path;
    this.sha = sha;
  }
}

export class PublishError extends Error {
  readonly code: "too_many_replays" | "bad_change" | "gone";
  constructor(message: string, code: "too_many_replays" | "bad_change" | "gone") {
    super(message);
    this.name = "PublishError";
    this.code = code;
  }
}

export interface PublishInput {
  ws: WorkspaceRef;
  /** Idempotency key for THIS logical publish; the same on every retry. */
  opId: string;
  by: string;
  message: string;
  /** Per path, as the writer saw it. */
  changes: Changes;
  /** The bytes behind every `put` (by sha). Called only for blobs that must be
   *  uploaded or re-uploaded; may read a staged file lazily. */
  bytesOf: (sha: string) => Promise<Uint8Array>;
  /** Replay attempts before giving up under sustained contention. Default 8. */
  maxReplays?: number;
  /** This publish carries a restore: the revision whose content the changes
   *  bring back (the workspace head only; the history shows the link). */
  restoredFrom?: string;
}

export interface Conflict {
  path: string;
  /** Where the writer's version was kept; null when the writer deleted the
   *  path and the head's newer version simply stayed. */
  keptAs: string | null;
}

export type PublishResult =
  | { status: "committed"; revision: Revision; conflicts: Conflict[]; stateRevision?: Revision | null }
  | { status: "duplicate"; revision: Revision; conflicts: Conflict[]; stateRevision?: Revision | null }
  /** The head already holds all of it; no revision was made. */
  | { status: "unchanged"; revision: Revision | null; conflicts: Conflict[]; stateRevision?: Revision | null };

/** Both heads of a workspace, read together. */
export interface Heads {
  workspace: Revision | null;
  state: Revision | null;
}

export async function headsOf(deps: Deps, ws: WorkspaceRef): Promise<Heads> {
  const [workspace, state] = await Promise.all([deps.revisions.head({ ...ws, scope: "workspace" }), deps.revisions.head({ ...ws, scope: "state" })]);
  return { workspace, state };
}

/** The revision that owns a path: the state head for `state/…`, the workspace
 *  head for everything else. null when the path is on neither side. */
export function revisionFor(heads: Heads, rel: string): Revision | null {
  const side = sideOf(rel);
  return side === "state" ? heads.state : side === "authored" ? heads.workspace : null;
}

/** The two manifests as the pair of heads defines them. */
export async function manifestsAt(deps: Deps, tenant: string, heads: Heads): Promise<{ authored: Manifest; state: Manifest }> {
  const [authored, state] = await Promise.all([
    heads.workspace ? loadManifest(deps, tenant, heads.workspace.authored) : emptyManifest(),
    heads.state ? loadManifest(deps, tenant, heads.state.state) : emptyManifest(),
  ]);
  return { authored, state };
}

// ---------- reading ----------

export async function loadManifest(deps: Deps, tenant: string, id: ManifestId): Promise<Manifest> {
  if (id === EMPTY_MANIFEST_ID) return emptyManifest();
  let bytes: Buffer;
  try {
    bytes = await readAll(deps.blobs, manifestObjectKey(tenant, id));
  } catch (err) {
    if (err instanceof BlobNotFound) throw new BlobMissing(`manifest ${id.slice(0, 12)}…`, id);
    throw err;
  }
  // An object is named by its content; one that is not that content is
  // corruption (or an overwrite), and every revision pointing at it is wrong.
  if (sha256Hex(bytes) !== id) throw new Error(`manifest ${id.slice(0, 12)}… does not hash to its name — the stored object is corrupt`);
  return parseManifest(bytes.toString("utf8"));
}

/** The two manifests a revision names (one of them is empty: a revision lives
 *  on one head; see manifestsAt for the workspace as a whole). */
export async function manifestsOf(deps: Deps, tenant: string, rev: Revision | null): Promise<{ authored: Manifest; state: Manifest }> {
  if (!rev) return { authored: emptyManifest(), state: emptyManifest() };
  const [authored, state] = await Promise.all([loadManifest(deps, tenant, rev.authored), loadManifest(deps, tenant, rev.state)]);
  return { authored, state };
}

/** One file of a revision, as a stream. Pass the revision of the head that
 *  owns the path (revisionFor); a path on the other side is simply absent. */
export async function openPath(deps: Deps, tenant: string, rev: Revision, rel: string): Promise<{ size: number; body: ReadableStream<Uint8Array> } | null> {
  const side = sideOf(rel);
  if (!side) return null;
  const m = await loadManifest(deps, tenant, rev[side]);
  const e = m.files[rel];
  if (!e) return null;
  try {
    return { size: e.size, body: await deps.blobs.get(blobObjectKey(tenant, e.sha)) };
  } catch (err) {
    if (err instanceof BlobNotFound) throw new BlobMissing(rel, e.sha);
    throw err;
  }
}

/** Every blob a revision names, checked present. Returns the missing ones. */
export async function missingBlobs(
  deps: Deps,
  tenant: string,
  rev: Revision,
  opts: { state?: boolean; authored?: boolean; parallel?: number } = {},
): Promise<{ path: string; sha: string }[]> {
  const parallel = opts.parallel ?? 8;
  const authored = opts.authored === false ? emptyManifest() : await loadManifest(deps, tenant, rev.authored);
  const state = opts.state === false ? emptyManifest() : await loadManifest(deps, tenant, rev.state);
  const entries = [...Object.entries(authored.files), ...Object.entries(state.files)];
  const missing: { path: string; sha: string }[] = [];
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(parallel, entries.length) }, async () => {
      while (next < entries.length) {
        const [p, e] = entries[next++];
        if (!(await deps.blobs.head(blobObjectKey(tenant, e.sha)))) missing.push({ path: p, sha: e.sha });
      }
    }),
  );
  return missing.sort((a, b) => a.path.localeCompare(b.path));
}

// ---------- publishing ----------

const ENTRY_ID = /^[0-9a-f]{64}:\d+$/;

function validate(changes: Changes) {
  for (const [p, c] of Object.entries(changes)) {
    assertManifestPath(p);
    if (c.base !== null && !(typeof c.base === "string" && ENTRY_ID.test(c.base))) throw new PublishError(`change for ${p} has a malformed base`, "bad_change");
    if (c.op === "put") {
      if (!/^[0-9a-f]{64}$/.test(c.sha) || !Number.isSafeInteger(c.size) || c.size < 0 || (c.mode !== MODE_FILE && c.mode !== MODE_EXEC)) {
        throw new PublishError(`change for ${p} is malformed`, "bad_change");
      }
    } else if (c.op === "delete") {
      if (c.base === null) throw new PublishError(`delete of ${p} names no base`, "bad_change");
    } else {
      throw new PublishError(`change for ${p} has no operation`, "bad_change");
    }
  }
}

/** The request's identity, for the operation record. Same changes, author and
 *  message → same digest; the op id alone does not say "this is a retry". */
export function requestDigest(kind: string, parts: unknown): string {
  const canon = (v: unknown): unknown =>
    Array.isArray(v) ? v.map(canon) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon((v as Record<string, unknown>)[k])])) : v;
  return sha256Hex(JSON.stringify([kind, canon(parts)]));
}

/** Fold `changes` onto `head`'s manifests. Pure. */
export function fold(head: { authored: Manifest; state: Manifest }, changes: Changes, opId: string): { authored: Manifest; state: Manifest; conflicts: Conflict[]; applied: Changes } {
  const apply: Record<"authored" | "state", Changes> = { authored: {}, state: {} };
  const conflicts: Conflict[] = [];
  for (const [p, c] of Object.entries(changes)) {
    const side = sideOf(p)!;
    const here = head[side].files[p];
    const cur = here ? entryId(here) : null;
    const want = c.op === "put" ? entryId(c) : null;
    if (cur === want) continue; // the head already holds exactly that (bytes and mode)
    if (cur === c.base) {
      apply[side][p] = c as PathChange;
      continue;
    }
    // The head holds something the writer did not start from, and not what it
    // wants: keep the head's, and keep the writer's put beside it — under a
    // name that is free (never over something else), and the same name on a
    // retry.
    if (c.op === "put") {
      let keptAs = "";
      for (let attempt = 0; ; attempt++) {
        keptAs = conflictPath(p, opId, attempt);
        const taken = apply[side][keptAs] ?? null;
        const occupant = head[side].files[keptAs];
        if (!occupant && !taken) break;
        if (occupant && entryId(occupant) === entryId(c)) break; // this very copy is already there
        if (attempt > 20) throw new PublishError(`no free name for the conflict copy of ${p}`, "bad_change");
      }
      const occupant = head[side].files[keptAs];
      apply[side][keptAs] = { op: "put", base: occupant ? entryId(occupant) : null, sha: c.sha, size: c.size, mode: c.mode };
      conflicts.push({ path: p, keptAs });
    } else {
      conflicts.push({ path: p, keptAs: null });
    }
  }
  return {
    authored: applyChanges(head.authored, apply.authored),
    state: applyChanges(head.state, apply.state),
    conflicts,
    applied: { ...apply.authored, ...apply.state },
  };
}

async function putManifest(deps: Deps, tenant: string, m: Manifest): Promise<ManifestId> {
  const id = manifestId(m);
  await deps.blobs.putIfAbsent(manifestObjectKey(tenant, id), Buffer.from(canonicalManifest(m)), { contentType: "application/json" });
  return id;
}

/** Make sure every sha in `applied` is in the store, uploading from `bytesOf`
 *  any that are not. Cheap when they are (one head each). */
async function ensureBlobs(deps: Deps, tenant: string, applied: Changes, bytesOf: PublishInput["bytesOf"], parallel = 8): Promise<void> {
  const want = new Map<string, number>(); // sha → the size the changes declare
  for (const c of Object.values(applied)) {
    if (c.op !== "put") continue;
    if (want.has(c.sha) && want.get(c.sha) !== c.size) throw new PublishError(`two changes declare different sizes for ${c.sha.slice(0, 12)}…`, "bad_change");
    want.set(c.sha, c.size);
  }
  const list = [...want];
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(parallel, list.length) }, async () => {
      while (next < list.length) {
        const [sha, size] = list[next++];
        const key = blobObjectKey(tenant, sha);
        const there = await deps.blobs.head(key);
        if (there) {
          if (there.size !== size) throw new PublishError(`${sha.slice(0, 12)}… is stored with ${there.size} bytes but the change says ${size}`, "bad_change");
          continue;
        }
        const bytes = await bytesOf(sha);
        if (sha256Hex(bytes) !== sha) throw new PublishError(`the bytes for ${sha.slice(0, 12)}… do not hash to it`, "bad_change");
        if (bytes.length !== size) throw new PublishError(`the bytes for ${sha.slice(0, 12)}… are ${bytes.length} long but the change says ${size}`, "bad_change");
        await deps.blobs.putIfAbsent(key, bytes);
      }
    }),
  );
}

function replay(op: { outcome: "committed" | "unchanged"; revision: Revision | null }): PublishResult {
  // The conflict list is not stored beyond the paths (revision.conflicts);
  // the duplicate answer says which revision was made, not how it got there.
  return op.outcome === "committed" && op.revision
    ? { status: "duplicate", revision: op.revision, conflicts: [] }
    : { status: "unchanged", revision: op.revision, conflicts: [] };
}

/** The op id of the state half of a publish/restore: derived, so a retry
 *  makes the same one, and kept within the op-id length limit. */
export function stateOpId(opId: string): string {
  return `${opId.slice(0, 120)}+state+${sha256Hex(opId).slice(0, 16)}`;
}

const RANK = { committed: 2, duplicate: 1, unchanged: 0 } as const;

const guardOf = (deps: Deps, ws: WorkspaceRef) => (deps.workspaceExists ? { guard: () => deps.workspaceExists!({ tenant: ws.tenant, workspace: ws.workspace }) } : {});

/** One head's half of a publish. */
async function publishScope(deps: Deps, input: PublishInput, scope: Scope, changes: Changes, opId: string): Promise<PublishResult> {
  const ws: WorkspaceRef = { ...input.ws, scope };
  const side: Side = scope === "workspace" ? "authored" : "state";
  const digest = requestDigest("publish", { by: input.by, message: input.message, changes });
  const earlier = await deps.revisions.operation(ws, opId);
  if (earlier) {
    if (earlier.digest !== digest) throw new OpIdReused(opId);
    return replay(earlier);
  }

  // Upload first, outside any transaction. ensureBlobs inside the loop repeats
  // the existence check right before each commit; the pins (taken by publish())
  // are what make a sweep between here and there harmless.
  await ensureBlobs(deps, ws.tenant, changes, input.bytesOf);

  const max = input.maxReplays ?? 8;
  for (let attempt = 0; attempt <= max; attempt++) {
    const head = await deps.revisions.head(ws);
    const current = head ? await loadManifest(deps, ws.tenant, head[side]) : emptyManifest();
    const next = fold(side === "authored" ? { authored: current, state: emptyManifest() } : { authored: emptyManifest(), state: current }, changes, opId);
    const nextManifest = next[side];
    // Never write a manifest we could not read back.
    assertManifest(nextManifest);
    const id = manifestId(nextManifest);
    if (head && id === head[side]) {
      await deps.revisions.recordNoop(ws, opId, digest);
      return { status: "unchanged", revision: head, conflicts: next.conflicts };
    }
    await ensureBlobs(deps, ws.tenant, next.applied, input.bytesOf);
    if (id !== head?.[side]) await putManifest(deps, ws.tenant, nextManifest);

    const res = await deps.revisions.commit(ws, {
      base: head?.id ?? null,
      authored: side === "authored" ? id : EMPTY_MANIFEST_ID,
      state: side === "state" ? id : EMPTY_MANIFEST_ID,
      opId,
      digest,
      by: input.by,
      message: input.message,
      conflicts: next.conflicts.map((c) => c.path),
      ...(input.restoredFrom && side === "authored" ? { restoredFrom: input.restoredFrom } : {}),
      ...guardOf(deps, input.ws),
    });
    if (res.status === "gone") throw new PublishError(`${input.ws.workspace} does not exist (any more)`, "gone");
    if (res.status === "committed") return { status: "committed", revision: res.revision, conflicts: next.conflicts };
    if (res.status === "duplicate") return { status: "duplicate", revision: res.revision, conflicts: [] };
    // stale: the head moved. Fold again onto it.
  }
  throw new PublishError("the workspace changed too often while publishing; try again", "too_many_replays");
}

/** Combine the two heads' answers: the workspace revision is `revision`, the
 *  state one `stateRevision`; the status is the strongest of the two. */
function combine(ws: PublishResult | null, st: PublishResult | null): PublishResult {
  const parts = [ws, st].filter((x): x is PublishResult => x !== null);
  const strongest = parts.reduce((a, b) => (RANK[b.status] > RANK[a.status] ? b : a));
  return {
    status: strongest.status,
    revision: (ws ?? st)!.revision,
    conflicts: parts.flatMap((x) => x.conflicts),
    ...(st ? { stateRevision: st.revision } : {}),
  } as PublishResult;
}

export async function publish(deps: Deps, input: PublishInput): Promise<PublishResult> {
  assertOpId(input.opId);
  validate(input.changes);
  const split: Record<Side, Changes> = { authored: {}, state: {} };
  for (const [p, c] of Object.entries(input.changes)) split[sideOf(p)!][p] = c;
  const hasAuthored = Object.keys(split.authored).length > 0;
  const hasState = Object.keys(split.state).length > 0;

  // Pin every blob this publish may name BEFORE anything checks that it exists.
  const shas = [...new Set(Object.values(input.changes).flatMap((c) => (c.op === "put" ? [c.sha] : [])))];
  const holder = { kind: "publish" as const, id: input.opId };
  if (shas.length) await deps.pins?.pinBlobs(input.ws.tenant, shas, holder, { ttlMs: PUBLISH_PIN_TTL_MS });
  try {
    // A call with no changes at all is the (empty) first publish of a workspace.
    const ws = hasAuthored || !hasState ? await publishScope(deps, input, "workspace", split.authored, input.opId) : null;
    const st = hasState ? await publishScope(deps, input, "state", split.state, stateOpId(input.opId)) : null;
    return combine(ws, st);
  } finally {
    // Committed: the revision's own manifest pin protects the blobs now.
    // Failed: nothing references them, and the lease would have expired anyway.
    if (shas.length) await deps.pins?.release(input.ws.tenant, holder).catch(() => {});
  }
}

// ---------- restore ----------

export interface RestoreInput {
  ws: WorkspaceRef;
  /** The workspace-head revision whose content to bring back. */
  to: string;
  opId: string;
  by: string;
  message?: string;
  /** Rewind state/ too, to this state-head revision. Unset: state stays —
   *  restoring source must not erase what agents have accumulated. */
  stateTo?: string;
  maxReplays?: number;
}

async function restoreScope(deps: Deps, input: RestoreInput, scope: Scope, toId: string, opId: string): Promise<PublishResult> {
  const ws: WorkspaceRef = { ...input.ws, scope };
  const side: Side = scope === "workspace" ? "authored" : "state";
  const digest = requestDigest("restore", { to: toId, scope, by: input.by, message: input.message ?? null });
  const earlier = await deps.revisions.operation(ws, opId);
  if (earlier) {
    if (earlier.digest !== digest) throw new OpIdReused(opId);
    return replay(earlier);
  }
  const target = await deps.revisions.revision(ws, toId);
  if (!target) throw new PublishError(`no ${scope} revision ${toId}`, "bad_change");
  // Check exactly what the new revision will point at, and nothing else:
  // missing history it never references must not block it.
  const missing = await missingBlobs(deps, ws.tenant, target, side === "authored" ? { state: false } : { authored: false });
  if (missing.length) throw new BlobMissing(missing[0].path, missing[0].sha);

  const max = input.maxReplays ?? 8;
  for (let attempt = 0; attempt <= max; attempt++) {
    const head = await deps.revisions.head(ws);
    if (head && head[side] === target[side]) {
      await deps.revisions.recordNoop(ws, opId, digest);
      return { status: "unchanged", revision: head, conflicts: [] };
    }
    const res = await deps.revisions.commit(ws, {
      base: head?.id ?? null,
      authored: side === "authored" ? target.authored : EMPTY_MANIFEST_ID,
      state: side === "state" ? target.state : EMPTY_MANIFEST_ID,
      opId,
      digest,
      by: input.by,
      message: input.message ?? `restore ${target.id}`,
      restoredFrom: target.id,
      ...guardOf(deps, input.ws),
    });
    if (res.status === "gone") throw new PublishError(`${input.ws.workspace} does not exist (any more)`, "gone");
    if (res.status === "committed") return { status: "committed", revision: res.revision, conflicts: [] };
    if (res.status === "duplicate") return { status: "duplicate", revision: res.revision, conflicts: [] };
  }
  throw new PublishError("the workspace changed too often while restoring; try again", "too_many_replays");
}

/** A new revision with an old one's content. History is untouched. Refuses,
 *  before committing anything, when a blob the old revision names is gone. */
export async function restore(deps: Deps, input: RestoreInput): Promise<PublishResult> {
  assertOpId(input.opId);
  // Both targets are checked before either head moves: a bad state target must
  // not leave the source half restored.
  if (input.stateTo) {
    const st = await deps.revisions.revision({ ...input.ws, scope: "state" }, input.stateTo);
    if (!st) throw new PublishError(`no state revision ${input.stateTo}`, "bad_change");
    const missing = await missingBlobs(deps, input.ws.tenant, st, { authored: false });
    if (missing.length) throw new BlobMissing(missing[0].path, missing[0].sha);
  }
  const ws = await restoreScope(deps, input, "workspace", input.to, input.opId);
  const st = input.stateTo ? await restoreScope(deps, input, "state", input.stateTo, stateOpId(input.opId)) : null;
  return combine(ws, st);
}
