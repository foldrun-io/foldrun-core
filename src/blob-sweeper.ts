// The blob sweeper (FOL-126): mark and sweep, with a delay.
//
// Revisions, manifests and blobs only ever accumulate: a delete, a rename, a
// state prune and a deleted account all release PINS and ROWS and delete no
// object. This is what deletes them, and it is built so that deleting the wrong
// thing is the hard direction.
//
//  MARK   per account: the roots are every manifest a retained revision names
//         (any head, any workspace), every manifest and blob a live pin names
//         (a run's pinned base, a publish in flight, a revision's own pin), and
//         the blobs of all those manifests. Everything under `t/<tenant>/` that
//         is not reachable from them is a candidate. An object the sweeper does
//         not recognise by its key is left alone and counted.
//  DELAY  a candidate is only RECORDED the first time it is seen unreferenced
//         (`firstSeen`, the database clock). It is deleted only once it has been
//         unreferenced continuously for `delayMs` — which is also the window a
//         database can be restored to: restoring to a point inside it brings
//         back revision rows whose objects are still there. Referenced again
//         before then, the record is cleared. Objects younger than `minAgeMs`
//         are never touched (a publish uploads before it commits).
//  SWEEP  each delete goes through `pins.guardDelete` (the pin lock for that
//         object) and, INSIDE it, looks once more at what was committed since
//         the mark began, because a publish that committed and released its pin
//         after the mark would otherwise be invisible to both checks.
//
// Refusals (nothing deleted, said in the report): the store cannot list; the
// database holds no revision at all while the bucket holds objects (a wiped or
// not-yet-restored database); a retained manifest cannot be read (its blobs are
// unknown). A manifest committed DURING the sweep that cannot be read stops that
// account's sweep where it is: the objects deleted before it stay deleted (they
// were checked), nothing after it goes. `dryRun` marks and counts nothing it
// would not report: it writes no records and deletes nothing.
//
// `maxDeletes` is one budget for all accounts. It is charged from the report
// (what was deleted, or in a dry run what would be), so an account whose sweep
// fails part-way still pays for what it deleted, and a dry run stops counting
// where a real run would stop deleting.
//
// An account that was deleted needs no special case: its rows and pins are gone,
// so everything under its prefix is unreferenced, waits the delay, and goes.

import type { BlobStore, BlobSweeper } from "./blob-store.ts";
import type { BlobPins } from "./blob-pins.ts";
import type { RevisionStore } from "./revision-store.ts";
import { loadManifest, BlobMissing } from "./publish.ts";
import { opsError, opsLog } from "./ops-log.ts";

export type MarkKind = "blob" | "manifest" | "workspace";
export interface Mark {
  firstSeen: Date;
  size: number;
}

/** Where "first seen unreferenced" is kept (a table in the platform). */
export interface SweepMarks {
  /** The database's clock: every record and comparison uses it, so pods agree. */
  now(): Promise<Date>;
  load(tenant: string, kind: MarkKind): Promise<Map<string, Mark>>;
  /** Record refs not yet recorded (an existing record keeps its first time). */
  put(tenant: string, kind: MarkKind, entries: { ref: string; size: number }[], at: Date): Promise<void>;
  clear(tenant: string, kind: MarkKind, refs: string[]): Promise<void>;
  /** When the last run (real or dry) finished, for the schedule. */
  lastRunAt(): Promise<Date | null>;
  recordRun(report: SweepReport): Promise<void>;
}

export interface SweepOptions {
  dryRun: boolean;
  /** Unreferenced for this long before deletion: the restore-point window. */
  delayMs: number;
  /** Never touch an object younger than this. Default one hour. */
  minAgeMs?: number;
  /** Delete at most this many objects in one run, all accounts together. */
  maxDeletes: number;
  /** Only these accounts (tests, an operator). */
  tenants?: string[];
  /** Go ahead even when the database holds no revision (default: refuse). */
  allowEmpty?: boolean;
}

export interface SweepReport {
  dryRun: boolean;
  tenants: number;
  scanned: number;
  scannedBytes: number;
  live: number;
  /** Seen unreferenced for the first time in this run. */
  marked: number;
  markedBytes: number;
  /** Unreferenced, but not for long enough yet. */
  waiting: number;
  deleted: number;
  deletedBytes: number;
  /** A dry run: due now, and what a real run would delete. */
  wouldDelete: number;
  wouldDeleteBytes: number;
  /** Would have been deleted (dry run), or were due but a pin or a new revision held them. */
  skippedHeld: number;
  /** Not an object the sweeper owns (left alone). */
  foreign: number;
  errors: number;
  refused?: string;
}

const TENANT = /^[A-Za-z0-9][A-Za-z0-9._@-]{0,120}$/;
const HEX = /^[0-9a-f]{64}$/;
const empty = (dryRun: boolean): SweepReport => ({ dryRun, tenants: 0, scanned: 0, scannedBytes: 0, live: 0, marked: 0, markedBytes: 0, waiting: 0, deleted: 0, deletedBytes: 0, wouldDelete: 0, wouldDeleteBytes: 0, skippedHeld: 0, foreign: 0, errors: 0 });

export interface SweepDeps {
  blobs: BlobStore & BlobSweeper;
  revisions: RevisionStore;
  pins?: BlobPins;
}

export async function sweepBlobs(deps: SweepDeps, marks: SweepMarks, opts: SweepOptions): Promise<SweepReport> {
  const rep = empty(opts.dryRun);
  const { blobs } = deps;
  if (!blobs.list || !blobs.tenants || !blobs.delete) return refuse(rep, "the object store cannot list and delete");
  let tenants: string[];
  try {
    tenants = opts.tenants ?? (await blobs.tenants());
  } catch (err) {
    opsError("blobs.sweep_failed", err, { stage: "tenants" });
    rep.errors++;
    return refuse(rep, "the object store could not be listed");
  }
  if (!opts.allowEmpty && tenants.length && !(await deps.revisions.anyRevisions())) {
    return refuse(rep, "the database holds no revision but the store holds objects: not deleting on that evidence");
  }
  for (const tenant of tenants) {
    if (!TENANT.test(tenant)) {
      rep.foreign++;
      continue;
    }
    rep.tenants++;
    // Read from the report, not from what sweepTenant returns: a tenant that
    // throws after deleting never returns, and its deletions must still count.
    const budget = Math.max(0, opts.maxDeletes - rep.deleted - rep.wouldDelete);
    try {
      await sweepTenant(deps, marks, opts, tenant, rep, budget);
    } catch (err) {
      rep.errors++;
      opsError("blobs.sweep_failed", err, { tenant });
    }
  }
  opsLog("info", "blobs.sweep", { ...rep });
  await marks.recordRun(rep).catch((err) => opsError("blobs.sweep_not_recorded", err, {}));
  return rep;
}

function refuse(rep: SweepReport, why: string): SweepReport {
  rep.refused = why;
  opsLog("warn", "blobs.sweep_refused", { reason: why, dryRun: rep.dryRun });
  return rep;
}

/** Adds what it did to `rep` as it goes, so a throw part-way leaves the report
 *  (and with it the shared budget) true to what was deleted. */
async function sweepTenant(deps: SweepDeps, marks: SweepMarks, opts: SweepOptions, tenant: string, rep: SweepReport, budget: number): Promise<void> {
  const { blobs, revisions, pins } = deps;
  const started = await marks.now();

  // ---- mark: the roots
  const retained = new Set(await revisions.manifestIds(tenant));
  const pinned = pins ? await pins.live(tenant) : { manifests: [], blobs: [] };
  const liveBlobs = new Set<string>(pinned.blobs);
  const liveManifests = new Set<string>([...retained, ...pinned.manifests]);
  for (const id of liveManifests) {
    try {
      const m = await loadManifest({ blobs, revisions }, tenant, id);
      for (const f of Object.values(m.files)) liveBlobs.add(f.sha);
    } catch (err) {
      // A manifest a revision names that cannot be read means its blobs are
      // unknown: nothing of this account may be deleted this run. A pinned
      // manifest that is not there yet (a publish still uploading) is fine.
      if (err instanceof BlobMissing && !retained.has(id)) continue;
      throw err;
    }
  }

  // ---- what is there
  type Obj = { key: string; kind: "blob" | "manifest"; ref: string; size: number; modifiedAt: Date };
  const candidates = new Map<string, Obj>(); // `${kind}:${ref}`
  const prefix = `t/${tenant}/`;
  let live = 0;
  for await (const o of blobs.list!(prefix)) {
    rep.scanned++;
    rep.scannedBytes += o.size;
    const rest = o.key.startsWith(prefix) ? o.key.slice(prefix.length) : "";
    let kind: "blob" | "manifest" | null = null;
    let ref = "";
    if (rest.startsWith("blobs/") && HEX.test(rest.slice(6))) (kind = "blob"), (ref = rest.slice(6));
    else if (rest.startsWith("manifests/") && rest.endsWith(".json") && HEX.test(rest.slice(10, -5))) (kind = "manifest"), (ref = rest.slice(10, -5));
    if (!kind) {
      rep.foreign++;
      continue;
    }
    if ((kind === "blob" ? liveBlobs : liveManifests).has(ref)) {
      live++;
      continue;
    }
    candidates.set(`${kind}:${ref}`, { key: o.key, kind, ref, size: o.size, modifiedAt: o.modifiedAt });
  }
  rep.live += live;

  // ---- delay: first seen, and how long ago
  const minAge = opts.minAgeMs ?? 3_600_000;
  const have = { blob: await marks.load(tenant, "blob"), manifest: await marks.load(tenant, "manifest") };
  const stale: Record<"blob" | "manifest", string[]> = { blob: [], manifest: [] };
  const fresh: Record<"blob" | "manifest", { ref: string; size: number }[]> = { blob: [], manifest: [] };
  const due: Obj[] = [];
  for (const kind of ["blob", "manifest"] as const) {
    for (const ref of have[kind].keys()) if (!candidates.has(`${kind}:${ref}`)) stale[kind].push(ref); // referenced again, or gone
  }
  for (const o of candidates.values()) {
    const m = have[o.kind].get(o.ref);
    if (!m) {
      rep.marked++;
      rep.markedBytes += o.size;
      fresh[o.kind].push({ ref: o.ref, size: o.size });
      continue;
    }
    const old = started.getTime() - m.firstSeen.getTime() >= opts.delayMs && started.getTime() - o.modifiedAt.getTime() >= minAge;
    if (old) due.push(o);
    else rep.waiting++;
  }
  if (!opts.dryRun) {
    for (const kind of ["blob", "manifest"] as const) {
      if (stale[kind].length) await marks.clear(tenant, kind, stale[kind]);
      if (fresh[kind].length) await marks.put(tenant, kind, fresh[kind], started);
    }
  }

  // ---- sweep
  due.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === "blob" ? -1 : 1)); // blobs before manifests
  if (opts.dryRun) {
    // The same objects, in the same order, a real run would take with this
    // budget; adding to the report is what charges the shared budget.
    rep.wouldDelete += Math.min(due.length, budget);
    rep.wouldDeleteBytes += due.slice(0, budget).reduce((a, o) => a + o.size, 0);
    return;
  }
  let did = 0;
  const since = new Date(started.getTime() - 60_000);
  const newlyLive = new Map<string, Set<string>>(); // manifest id → its blobs, for revisions made since the mark began
  const gone: Record<"blob" | "manifest", string[]> = { blob: [], manifest: [] };
  const clearGone = async () => {
    for (const kind of ["blob", "manifest"] as const) if (gone[kind].length) await marks.clear(tenant, kind, gone[kind]);
  };
  try {
    for (const o of due) {
      if (did >= budget) break;
      const ran = await (pins ?? NO_GUARD).guardDelete(tenant, o.kind === "blob" ? "blob" : "manifest", o.ref, async () => {
        // Inside the pin lock: whatever was committed since the mark began.
        const recent = await revisions.manifestIds(tenant, { since });
        if (o.kind === "manifest" && recent.includes(o.ref)) return void rep.skippedHeld++;
        if (o.kind === "blob") {
          for (const id of recent) {
            let set = newlyLive.get(id);
            if (!set) {
              // A new revision's manifest that cannot be read leaves its blobs
              // unknown, for this candidate and every one after it. Caching
              // anything here would let a later candidate it names be deleted,
              // so the account's sweep stops instead (the caller counts it).
              let m;
              try {
                m = await loadManifest({ blobs, revisions }, tenant, id);
              } catch (err) {
                throw new Error(`a revision committed during the sweep names manifest ${id.slice(0, 12)}…, which cannot be read: stopping this account's sweep`, { cause: err });
              }
              set = new Set(Object.values(m.files).map((f) => f.sha));
              newlyLive.set(id, set);
            }
            if (set.has(o.ref)) return void rep.skippedHeld++;
          }
        }
        await blobs.delete(o.key);
        rep.deleted++;
        rep.deletedBytes += o.size;
        did++;
        gone[o.kind].push(o.ref);
      });
      if (!ran) rep.skippedHeld++; // a live pin
    }
  } catch (err) {
    // What was deleted before the failure is gone; its records go too, best
    // effort (one left behind is stale next run, since its object is not
    // listed, and is cleared then).
    await clearGone().catch((e) => opsError("blobs.sweep_marks_not_cleared", e, { tenant }));
    throw err;
  }
  await clearGone();
}

const NO_GUARD = {
  async guardDelete(_t: string, _k: string, _r: string, del: () => Promise<void>) {
    await del();
    return true;
  },
};

// ------------------------------------------------------------- an in-memory SweepMarks

/** For tests and a host without a database table (the clock is injectable). */
export function memorySweepMarks(clock: () => Date = () => new Date()): SweepMarks & { runs: SweepReport[]; table: Map<string, Mark> } {
  const table = new Map<string, Mark>();
  const runs: SweepReport[] = [];
  const k = (t: string, kind: string, ref: string) => `${t}\0${kind}\0${ref}`;
  return {
    runs,
    table,
    async now() {
      return clock();
    },
    async load(tenant, kind) {
      const out = new Map<string, Mark>();
      for (const [key, v] of table) {
        const [t, kd, ref] = key.split("\0");
        if (t === tenant && kd === kind) out.set(ref, v);
      }
      return out;
    },
    async put(tenant, kind, entries, at) {
      for (const e of entries) if (!table.has(k(tenant, kind, e.ref))) table.set(k(tenant, kind, e.ref), { firstSeen: at, size: e.size });
    },
    async clear(tenant, kind, refs) {
      for (const r of refs) table.delete(k(tenant, kind, r));
    },
    async lastRunAt() {
      return runs.length ? clock() : null;
    },
    async recordRun(report) {
      runs.push(report);
    },
  };
}
