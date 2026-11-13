// RevisionStore: the pointers (FOL-126, phase 1).
//
// The BlobStore holds bytes and never changes them. This holds the small
// transactional facts around them: which revision is a workspace's head, the
// history that led to it, which operation ids already happened, and the file
// index for storage/.
//
// One commit is one atomic step:
//
//   commit(ws, { base, authored, state, opId, ... })
//     - the head must still be `base` (compare-and-set), else `stale` and
//       nothing is written;
//     - an `opId` that already committed answers `duplicate` with the
//       revision it made, and writes nothing — a retry whose first attempt's
//       answer was lost cannot publish twice;
//     - otherwise the revision row exists and the head points at it, together
//       or not at all.
//
// Two implementations behind this one interface, proven by ONE contract suite
// (tests/revision-contract.ts):
//
//   pg     hosted. One transaction: CAS the head row, insert the revision,
//          record the op id. Lives in foldrun-platform (core has no database).
//   local  one host, no FOLDRUN_DATABASE_URL: self-host Compose, which has no
//          Postgres. Files under the data root, serialised by a cross-process
//          lock; the revision file is created exclusively and IS the
//          compare-and-set. Below.
//
// `db.ts` stays optional by design; nothing here makes Postgres required.
//
// Not in this interface yet, on purpose: runs, run events and logs. They move
// in phase 2 with their own shapes; sketching them now would be a guess.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { dataRoot } from "./paths.ts";
import { assertSafeName } from "./store.ts";
import { assertFilePath, withFileLock } from "./storage.ts";
import type { ManifestId } from "./manifest.ts";

/** The two heads of a workspace (decided 6 Nov 2026): source and everything
 *  else authored move on the `workspace` head; `state/` moves on its own
 *  `state` head. A per-step state checkpoint therefore never makes a source
 *  save, or another run's checkpoint of different state, replay. */
export type Scope = "workspace" | "state";

export interface WorkspaceRef {
  tenant: string;
  workspace: string;
  /** Which head. Unset = the workspace head. */
  scope?: Scope;
}

export const scopeOf = (ws: WorkspaceRef): Scope => ws.scope ?? "workspace";

export interface Revision {
  /** Opaque, unique. */
  id: string;
  /** Which head this revision belongs to. */
  scope: Scope;
  /** 1, 2, 3… per workspace. Display and ordering only: never compare it for
   *  "is this the head" — the id is what compare-and-set uses. */
  seq: number;
  parent: string | null;
  /** The authored manifest and the state manifest this revision points at. */
  authored: ManifestId;
  state: ManifestId;
  /** `user:<email>`, `run:<runId>:<agent>`, `assistant`, `deploy`… */
  by: string;
  message: string;
  at: string;
  /** The idempotency key the publisher chose. Unique per workspace. */
  opId: string;
  /** Set when this revision is a restore: the revision whose content it
   *  re-points at. The history keeps both; nothing is rewritten. */
  restoredFrom?: string;
  /** Paths whose competing version was kept as a conflict copy by this
   *  revision's replay. Informational (the dashboard shows it). */
  conflicts?: string[];
}

/** What an operation id did. Recorded for EVERY finished operation, including
 *  one that turned out to change nothing: a retry after a lost answer must get
 *  the original outcome even if the head has moved on since. */
export interface OperationRecord {
  opId: string;
  /** Digest of the request (the caller's choice of bytes: publish uses a hash
   *  of the canonical changes, restore of its target and options). Reusing an
   *  op id with a different digest is a caller bug, never a retry. */
  digest: string;
  outcome: "committed" | "unchanged";
  /** committed: the revision it made. unchanged: the head it found. */
  revision: Revision | null;
}

/** An operation id was used before for a DIFFERENT request. */
export class OpIdReused extends Error {
  readonly opId: string;
  constructor(opId: string) {
    super(`operation id ${opId} was already used for a different request`);
    this.name = "OpIdReused";
    this.opId = opId;
  }
}

export interface CommitInput {
  /** The head the writer built on: the revision id, or null for the first. */
  base: string | null;
  authored: ManifestId;
  state: ManifestId;
  opId: string;
  /** See OperationRecord.digest. */
  digest: string;
  by: string;
  message: string;
  restoredFrom?: string;
  conflicts?: string[];
  /** Asked INSIDE the store's own exclusion (the workspace lock), right before
   *  the head moves: does the workspace still exist? A delete or rename on
   *  another pod holds that lock while it removes the history and the folder,
   *  so a commit that gets the lock afterwards finds the folder gone and is
   *  refused ("gone"), rather than recreating rows under a name that has
   *  none. Unset: no check (the contract tests, a laptop). */
  guard?: () => boolean | Promise<boolean>;
}

export type CommitResult =
  | { status: "committed"; revision: Revision }
  /** This opId committed before (maybe by an earlier attempt whose answer was
   *  lost). `revision` is what that attempt made. */
  | { status: "duplicate"; revision: Revision }
  /** The head is no longer `base`. `head` is what it is now. Nothing written. */
  | { status: "stale"; head: Revision | null }
  /** The guard said the workspace does not exist (any more). Nothing written. */
  | { status: "gone" };

/** A row of the storage/ file index. */
export interface IndexedFile {
  path: string;
  sha: string;
  size: number;
  mime: string;
  updatedAt: string;
  by: string;
}

/** One workspace's head ids (RevisionStore.allHeads). */
export interface HeadIds {
  tenant: string;
  workspace: string;
  /** The workspace head's revision id; null when only the state head exists. */
  workspaceHead: string | null;
  stateHead: string | null;
}

export interface RevisionStore {
  readonly kind: "pg" | "local";
  head(ws: WorkspaceRef): Promise<Revision | null>;
  /** Every workspace that has a head, with the ids of its two heads — what a
   *  pod whose folders are a copy of the heads compares itself with
   *  (workspace-mirror.ts). Optional: a store without it has no mirror. */
  allHeads?(): Promise<HeadIds[]>;
  revision(ws: WorkspaceRef, id: string): Promise<Revision | null>;
  /** Newest first. `before` is a seq: pass the last page's lowest seq. */
  revisions(ws: WorkspaceRef, opts?: { limit?: number; before?: number }): Promise<Revision[]>;
  commit(ws: WorkspaceRef, input: CommitInput): Promise<CommitResult>;
  /** What an op id did, or null if it never finished. */
  operation(ws: WorkspaceRef, opId: string): Promise<OperationRecord | null>;
  /** Record that an operation finished without changing anything. Idempotent
   *  for the same digest; OpIdReused for another. */
  recordNoop(ws: WorkspaceRef, opId: string, digest: string): Promise<OperationRecord>;

  // The file index for storage/. Rows, not a document: two writers of
  // different paths never touch each other's row, which is what the phase 0
  // lock was standing in for.
  files(ws: WorkspaceRef): Promise<IndexedFile[]>;
  /** Upsert one row. `expectSha`: undefined = unconditional; null = only if
   *  the path has no row; a sha = only if the row still has it. Returns false
   *  when the expectation failed (nothing written). */
  putFile(ws: WorkspaceRef, file: IndexedFile, expectSha?: string | null): Promise<boolean>;
  /** Delete one row; same expectation rule. Returns whether a row went. */
  deleteFile(ws: WorkspaceRef, path: string, expectSha?: string | null): Promise<boolean>;

  // The lifecycle of a workspace's history (FOL-126 fixes, 8 Nov). A workspace
  // is named by its folder, so what the store keeps under that name has to
  // follow the folder: a delete takes it, a rename carries it.

  /** Remove every head, revision and operation of one workspace (both heads),
   *  or of the whole account when `workspace` is omitted, with the pins its
   *  revisions held (so the objects can be collected). The next workspace of
   *  that name starts empty. Safe to repeat; returns how many revisions went. */
  drop(target: { tenant: string; workspace?: string }): Promise<number>;
  /** Re-key a workspace's heads, revisions and operations (both heads) from one
   *  name to another, in one step. Whatever the new name already holds belonged
   *  to a workspace that no longer exists and is removed first. Revision ids
   *  do not change. A name with nothing under it moves nothing. */
  move(tenant: string, from: string, to: string): Promise<void>;
  /** Remove these revisions of one head (and the pins they held on their
   *  manifests; the objects themselves are the sweeper's). The head itself is
   *  never removed. Returns how many went. */
  prune(ws: WorkspaceRef, ids: readonly string[]): Promise<number>;

  // What the sweeper and the orphan cleanup ask (blob-sweeper.ts).

  /** Every manifest id a revision of this account names (both heads, all
   *  workspaces), or only those of revisions made at or after `since` (the
   *  sweeper's last look before a delete: what a publish committed meanwhile). */
  manifestIds(tenant: string, opts?: { since?: Date }): Promise<string[]>;
  /** Does the store hold any revision at all? A sweeper that finds none, with
   *  objects in the bucket, suspects a wiped database and refuses. */
  anyRevisions(): Promise<boolean>;
  /** Every workspace that has a head or a revision, any account. */
  workspaces(): Promise<{ tenant: string; workspace: string }[]>;
}

const OP_ID = /^[A-Za-z0-9._:@=+-]{8,200}$/;
export function assertOpId(opId: string): string {
  if (!OP_ID.test(opId)) throw new Error("an operation id is 8–200 characters of letters, digits and . _ : @ = + -");
  return opId;
}

export function newRevisionId(): string {
  return `rev_${crypto.randomBytes(12).toString("hex")}`;
}

// ---------- local ----------
//
// Layout, under <root>/<tenant>/<workspace>/ :
//
//   revs/<seq, 10 digits>.json    one revision each, created EXCLUSIVELY
//                                 (link of a finished temp file): the create
//                                 is the compare-and-set — two writers
//                                 racing for seq N, one gets EEXIST.
//   ops/<sha256(opId)>.json       { opId, seq } — written BEFORE the revision.
//                                 A crash between the two leaves a pointer to
//                                 a revision that does not exist; it is
//                                 checked on read and then overwritten.
//   files.json                    the storage/ index, replaced atomically
//
// The head is the highest seq in revs/. There is no separate head file to get
// out of step with the history. A directory listing per call is fine for one
// host; the pg implementation is the one built for scale.
//
// Everything runs inside withFileLock (cross-process, fenced, renewed), so two
// processes on one host serialise; the exclusive create is the second line of
// defence if the lock is ever taken over.

export function localRevisionStore(root: string = path.join(dataRoot(), ".revisions")): RevisionStore {
  const dirOf = (ws: WorkspaceRef) => {
    assertSafeName(ws.tenant, "tenant");
    assertSafeName(ws.workspace, "workspace");
    // The state head is a separate history in a subfolder of its own; the
    // workspace head's folder never lists it (seqs reads revs/ only).
    return scopeOf(ws) === "state" ? path.join(root, ws.tenant, ws.workspace, "state-head") : path.join(root, ws.tenant, ws.workspace);
  };
  const lockOf = (ws: WorkspaceRef) => path.join(root, ws.tenant, `.${ws.workspace}${scopeOf(ws) === "state" ? ".state" : ""}.lock`);
  const seqName = (n: number) => `${String(n).padStart(10, "0")}.json`;
  const opFile = (ws: WorkspaceRef, opId: string) =>
    path.join(dirOf(ws), "ops", `${crypto.createHash("sha256").update(opId).digest("hex")}.json`);

  const readJson = <T>(file: string): T | null => {
    try {
      return JSON.parse(fs.readFileSync(file, "utf8")) as T;
    } catch {
      return null;
    }
  };
  const writeAtomic = (file: string, data: unknown) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data));
    fs.renameSync(tmp, file);
  };
  const seqs = (ws: WorkspaceRef): number[] => {
    try {
      return fs
        .readdirSync(path.join(dirOf(ws), "revs"))
        .filter((n) => /^\d{10}\.json$/.test(n))
        .map((n) => Number(n.slice(0, 10)))
        .sort((a, b) => a - b);
    } catch {
      return [];
    }
  };
  const bySeq = (ws: WorkspaceRef, seq: number) => readJson<Revision>(path.join(dirOf(ws), "revs", seqName(seq)));
  const headOf = (ws: WorkspaceRef) => {
    const all = seqs(ws);
    return all.length ? bySeq(ws, all[all.length - 1]) : null;
  };
  type OpFile = { opId: string; digest: string; outcome: "committed" | "unchanged"; seq: number | null; headId: string | null };
  const operationOf = (ws: WorkspaceRef, opId: string): OperationRecord | null => {
    const op = readJson<OpFile>(opFile(ws, opId));
    if (!op || op.opId !== opId) return null;
    if (op.outcome === "unchanged") {
      const head = op.seq ? bySeq(ws, op.seq) : null;
      return { opId, digest: op.digest, outcome: "unchanged", revision: head };
    }
    const rev = op.seq ? bySeq(ws, op.seq) : null;
    // A pointer whose revision never landed (a crash between the two writes)
    // is not an operation.
    return rev && rev.opId === opId ? { opId, digest: op.digest, outcome: "committed", revision: rev } : null;
  };
  const locked = <T>(ws: WorkspaceRef, fn: () => Promise<T>) => withFileLock(lockOf(ws), fn);

  return {
    kind: "local",
    async head(ws) {
      return headOf(ws);
    },
    async allHeads() {
      const out: HeadIds[] = [];
      let tenants: string[] = [];
      try {
        tenants = fs.readdirSync(root).filter((n) => !n.startsWith("."));
      } catch {
        return out;
      }
      for (const tenant of tenants.sort()) {
        let names: string[] = [];
        try {
          names = fs.readdirSync(path.join(root, tenant)).filter((n) => !n.startsWith("."));
        } catch {
          continue;
        }
        for (const workspace of names.sort()) {
          const ws = { tenant, workspace };
          const w = headOf(ws);
          const st = headOf({ ...ws, scope: "state" } as WorkspaceRef);
          if (w || st) out.push({ tenant, workspace, workspaceHead: w?.id ?? null, stateHead: st?.id ?? null });
        }
      }
      return out;
    },
    async revision(ws, id) {
      for (const seq of seqs(ws).reverse()) {
        const r = bySeq(ws, seq);
        if (r?.id === id) return r;
      }
      return null;
    },
    async revisions(ws, opts = {}) {
      const limit = Math.min(Math.max(opts.limit ?? 50, 1), 500);
      const out: Revision[] = [];
      for (const seq of seqs(ws).reverse()) {
        if (opts.before !== undefined && seq >= opts.before) continue;
        const r = bySeq(ws, seq);
        if (r) out.push(r);
        if (out.length >= limit) break;
      }
      return out;
    },
    async operation(ws, opId) {
      assertOpId(opId);
      return operationOf(ws, opId);
    },
    async recordNoop(ws, opId, digest) {
      assertOpId(opId);
      return locked(ws, async () => {
        const done = operationOf(ws, opId);
        if (done) {
          if (done.digest !== digest) throw new OpIdReused(opId);
          return done;
        }
        const head = headOf(ws);
        writeAtomic(opFile(ws, opId), { opId, digest, outcome: "unchanged", seq: head?.seq ?? null, headId: head?.id ?? null } satisfies OpFile);
        return { opId, digest, outcome: "unchanged", revision: head } satisfies OperationRecord;
      });
    },
    async commit(ws, input) {
      assertOpId(input.opId);
      return locked(ws, async () => {
        if (input.guard && !(await input.guard())) return { status: "gone" };
        const done = operationOf(ws, input.opId);
        if (done) {
          if (done.digest !== input.digest) throw new OpIdReused(input.opId);
          if (done.revision && done.outcome === "committed") return { status: "duplicate", revision: done.revision };
          throw new OpIdReused(input.opId); // it finished as "unchanged"; a commit is a different outcome
        }
        const head = headOf(ws);
        if ((head?.id ?? null) !== input.base) return { status: "stale", head };
        const seq = (head?.seq ?? 0) + 1;
        const revision: Revision = {
          id: newRevisionId(),
          scope: scopeOf(ws),
          seq,
          parent: head?.id ?? null,
          authored: input.authored,
          state: input.state,
          by: input.by,
          message: input.message,
          at: new Date().toISOString(),
          opId: input.opId,
          ...(input.restoredFrom ? { restoredFrom: input.restoredFrom } : {}),
          ...(input.conflicts?.length ? { conflicts: input.conflicts } : {}),
        };
        // Op pointer first, then the revision: see the layout note.
        writeAtomic(opFile(ws, input.opId), { opId: input.opId, digest: input.digest, outcome: "committed", seq, headId: null } satisfies OpFile);
        const target = path.join(dirOf(ws), "revs", seqName(seq));
        fs.mkdirSync(path.dirname(target), { recursive: true });
        const tmp = `${target}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(revision));
        try {
          fs.linkSync(tmp, target); // EEXIST = someone else took this seq: stale
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === "EEXIST") return { status: "stale", head: headOf(ws) };
          throw err;
        } finally {
          fs.rmSync(tmp, { force: true });
        }
        return { status: "committed", revision };
      });
    },
    async files(ws) {
      return readJson<IndexedFile[]>(path.join(dirOf(ws), "files.json")) ?? [];
    },
    async putFile(ws, file, expectSha) {
      assertFilePath(file.path);
      return locked(ws, async () => {
        const all = readJson<IndexedFile[]>(path.join(dirOf(ws), "files.json")) ?? [];
        const was = all.find((f) => f.path === file.path);
        if (expectSha !== undefined && (was?.sha ?? null) !== expectSha) return false;
        writeAtomic(path.join(dirOf(ws), "files.json"), [...all.filter((f) => f.path !== file.path), file]);
        return true;
      });
    },
    async deleteFile(ws, rel, expectSha) {
      return locked(ws, async () => {
        const all = readJson<IndexedFile[]>(path.join(dirOf(ws), "files.json")) ?? [];
        const was = all.find((f) => f.path === rel);
        if (!was) return false;
        if (expectSha !== undefined && was.sha !== expectSha) return false;
        writeAtomic(path.join(dirOf(ws), "files.json"), all.filter((f) => f.path !== rel));
        return true;
      });
    },
    async drop(target) {
      assertSafeName(target.tenant, "tenant");
      if (target.workspace === undefined) {
        const dir = path.join(root, target.tenant);
        const n = countRevs(dir);
        fs.rmSync(dir, { recursive: true, force: true });
        return n;
      }
      const ws = { tenant: target.tenant, workspace: target.workspace };
      return locked(ws, () => locked({ ...ws, scope: "state" }, async () => {
        const n = seqs(ws).length + seqs({ ...ws, scope: "state" }).length;
        fs.rmSync(dirOf(ws), { recursive: true, force: true }); // the state head's folder is inside it
        return n;
      }));
    },
    async move(tenant, from, to) {
      const a = { tenant, workspace: from };
      const b = { tenant, workspace: to };
      // Both names, in a fixed order, so two crossing renames cannot wait on each other.
      const [first, second] = from < to ? [a, b] : [b, a];
      return locked(first, () => locked(second, async () => {
        const src = dirOf(a);
        const dest = dirOf(b);
        fs.rmSync(dest, { recursive: true, force: true }); // stale: that name has no workspace
        if (fs.existsSync(src)) fs.renameSync(src, dest);
      }));
    },
    async manifestIds(tenant, opts = {}) {
      assertSafeName(tenant, "tenant");
      const out = new Set<string>();
      const since = opts.since?.getTime() ?? -Infinity;
      eachRevision(root, tenant, (_t, _w, r) => {
        if (Date.parse(r.at) < since) return;
        out.add(r.authored);
        out.add(r.state);
      });
      return [...out];
    },
    async anyRevisions() {
      let any = false;
      eachRevision(root, null, () => (any = true));
      return any;
    },
    async workspaces() {
      const out = new Map<string, { tenant: string; workspace: string }>();
      eachRevision(root, null, (tenant, workspace) => out.set(`${tenant}\0${workspace}`, { tenant, workspace }));
      return [...out.values()];
    },
    async prune(ws, ids) {
      if (!ids.length) return 0;
      return locked(ws, async () => {
        const head = headOf(ws);
        const want = new Set(ids);
        let n = 0;
        for (const seq of seqs(ws)) {
          const r = bySeq(ws, seq);
          if (!r || !want.has(r.id) || r.id === head?.id) continue;
          fs.rmSync(path.join(dirOf(ws), "revs", seqName(seq)), { force: true });
          n++;
        }
        return n;
      });
    },
  };
}

function eachRevision(root: string, tenant: string | null, fn: (tenant: string, workspace: string, rev: Revision) => void): void {
  const tenants = tenant ? [tenant] : safeDirs(root);
  for (const t of tenants) {
    for (const w of safeDirs(path.join(root, t))) {
      for (const d of [path.join(root, t, w, "revs"), path.join(root, t, w, "state-head", "revs")]) {
        let names: string[] = [];
        try {
          names = fs.readdirSync(d).filter((x) => /^\d{10}\.json$/.test(x));
        } catch {
          continue;
        }
        for (const n of names) {
          try {
            fn(t, w, JSON.parse(fs.readFileSync(path.join(d, n), "utf8")) as Revision);
          } catch {
            // torn: not a revision
          }
        }
      }
    }
  }
}
function safeDirs(dir: string): string[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith(".")).map((e) => e.name);
  } catch {
    return [];
  }
}

function countRevs(dir: string): number {
  let n = 0;
  try {
    for (const w of fs.readdirSync(dir)) {
      if (w.startsWith(".")) continue;
      for (const d of [path.join(dir, w, "revs"), path.join(dir, w, "state-head", "revs")]) {
        try {
          n += fs.readdirSync(d).filter((x) => /^\d{10}\.json$/.test(x)).length;
        } catch {
          // none
        }
      }
    }
  } catch {
    // none
  }
  return n;
}
