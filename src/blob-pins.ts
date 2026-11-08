// Durable pins for blob GC (FOL-126, phase 2).
//
// Phase 1 left one hole open: publish confirms its blobs exist and then
// commits, and a sweeper that deletes between those two calls strands the new
// revision on a missing blob. A conditional put does not refresh an existing
// object's age, so a grace period alone cannot protect an old blob that a new
// publish reuses. The two sides have to agree on something durable.
//
// That agreement is a PIN: a row saying "this holder still needs this object".
//
//   publish   pins the blobs it is about to name (holder `publish:<opId>`,
//             with a lease) BEFORE it checks they exist, and releases the pin
//             after the commit. In between, a sweeper sees the pin.
//   revision  pins its two manifests, in the SAME transaction as the commit
//             (holder `revision:<id>`, no lease). The sweeper's mark phase
//             reads pinned manifests to learn which blobs are live. Pruning a
//             revision from history releases its pin.
//   run       pins the manifests of the base revision it was staged from
//             (holder `run:<runId>`, with a lease the worker renews), so a
//             run that is still going never loses what it reads.
//
// A sweeper deletes through `guardDelete`: it takes the pin lock for that
// object, checks no live pin exists, deletes, and releases the lock. A
// publisher pins under the same lock. So either the pin lands first and the
// sweeper skips the object, or the delete finishes first and the publisher —
// which pins BEFORE it checks — finds the blob gone and uploads it again.
//
// Leases: a pin with `expiresAt` in the past does not protect anything (a
// crashed publisher must not hold a blob forever). Pins without one (a
// revision's) last until released.
//
// This file is the interface. The Postgres implementation is
// foldrun-platform/src/blob-pins.ts; an install with no database has no
// sweeper at all yet, and `noPins` is what it gets.

import type { ManifestId } from "./manifest.ts";

export type PinKind = "blob" | "manifest";
export type HolderKind = "publish" | "run" | "revision";

export interface PinHolder {
  kind: HolderKind;
  /** publish: the op id. run: the run id. revision: the revision id. */
  id: string;
}

export interface BlobPins {
  /** Pin blobs (by sha) for a holder. Idempotent: a repeat extends the lease. */
  pinBlobs(tenant: string, shas: readonly string[], holder: PinHolder, opts?: { ttlMs?: number }): Promise<void>;
  /** Pin manifests the same way. */
  pinManifests(tenant: string, ids: readonly ManifestId[], holder: PinHolder, opts?: { ttlMs?: number }): Promise<void>;
  /** Drop every pin a holder has. Returns how many went. */
  release(tenant: string, holder: PinHolder): Promise<number>;
  /** Push a holder's leases out by ttlMs from now (a running run's heartbeat).
   *  Pins with no lease are left alone. Returns how many were renewed. */
  renew(tenant: string, holder: PinHolder, ttlMs: number): Promise<number>;
  /** Is anything holding this object right now (a live, unexpired pin)? */
  isPinned(tenant: string, kind: PinKind, ref: string): Promise<boolean>;
  /** Is a live pin on this object held by something OTHER than a revision (a
   *  run reading it, a publish in flight)? Retention asks this before it lets
   *  a revision go: the revision's own pin is the one it is about to release. */
  isPinnedBeyondRevisions(tenant: string, kind: PinKind, ref: string): Promise<boolean>;
  /** The sweeper's only way to delete: runs `del` only if no live pin names
   *  the object, with pinning of that object held off for the duration.
   *  Returns whether `del` ran. */
  guardDelete(tenant: string, kind: PinKind, ref: string, del: () => Promise<void>): Promise<boolean>;
}

/** No database, no sweeper: nothing to agree with. */
export const noPins: BlobPins = {
  async pinBlobs() {},
  async pinManifests() {},
  async release() {
    return 0;
  },
  async renew() {
    return 0;
  },
  async isPinned() {
    return false;
  },
  async isPinnedBeyondRevisions() {
    return false;
  },
  async guardDelete(_t, _k, _r, del) {
    await del();
    return true;
  },
};

/** How long a publish's blob pins live without a renewal: far longer than an
 *  upload, short enough that a crashed publisher frees its blobs the same day. */
export const PUBLISH_PIN_TTL_MS = 15 * 60_000;
