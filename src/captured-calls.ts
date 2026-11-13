// Captured tool calls in the blob store (FOL-126 phase 7, step 2).
//
// A call's masked input and output used to be a file beside its run
// (runs/<run>/calls/<call>.json — store.ts writeCapturedCall), merged in place
// when the output arrived. With a database, a blob store and the setting
// `runs.calls_store` on, each call is ONE blob, written once when the call
// completes (the input waits in memory for its output: no read-merge-write),
// pinned by a run holder (`calls:<run>`, no lease — it lives until the run is
// deleted) before the upload, and indexed by a step-state row (kind "call",
// ref = the call id → {sha, size}). Masking is capture.ts's and is done before
// anything gets here; a part over the cap was cut and flagged there.
//
// Reads look at the row first, then at the file, so every run stays readable
// whichever way the switch is set. A row whose blob cannot be read is an error
// (CapturedCallUnavailable), never "nothing recorded".
//
// TEMPORARY, remove at cutover (phase 9): a write that fails with an error
// (store down, database refuses) falls back to the volume file and logs
// `captured_calls.fallback`. At cutover that branch becomes "the call is not
// recorded, and the event says so".

import { records } from "./records.ts";
import { blobObjectKey, sha256Hex } from "./manifest.ts";
import { opsError } from "./ops-log.ts";
import { BlobNotFound, readAll } from "./blob-store.ts";
import type { Deps } from "./publish.ts";
import { writeCapturedCall, readCapturedCall, registerRunRemovedHook, type CapturedCall } from "./store.ts";
import { processState } from "./process-state.ts";

const KIND = "call";
const SAFE = /^[A-Za-z0-9_.-]{1,128}$/;
const holderOf = (runId: string) => ({ kind: "run" as const, id: `calls:${runId}` });

/** One per process (process-state.ts): the store the boot registered and the
 *  clean-ups in flight, whichever copy of this module a route handler holds. */
const CALLS = processState("captured-calls", () => ({ backend: null as Deps | null, background: new Set<Promise<unknown>>() }));

/** Registered with the revision backend (workspace-revisions.ts): the blob store and the pins. */
export function setCallsBackend(deps: Deps | null): void {
  CALLS.backend = deps;
  registerRunRemovedHook(deps ? runGone : null, "captured-calls");
}

/** The call could not be read back from where it was recorded. */
export class CapturedCallUnavailable extends Error {
  constructor(callId: string, cause?: unknown) {
    super(`captured call unavailable: the recorded content of call "${callId}" could not be read from storage`);
    this.name = "CapturedCallUnavailable";
    if (cause !== undefined) this.cause = cause;
  }
}

const portFor = (tenant: string, workspace: string) => {
  const p = records(tenant, workspace);
  // stepRuns too: without it a deleted workspace's calls could never be
  // found again to release their pins (Codex review, 13 Nov 2026).
  return p?.async?.stepPut && p.async.stepGet && p.async.stepRuns ? p : null;
};
const switchedOn = (p: { callsStoreOn?(): boolean }): boolean => {
  try {
    return p.callsStoreOn?.() === true;
  } catch {
    return false;
  }
};
/** Where a new call goes: the store (deps + port), or null (the volume). */
function active(tenant: string, workspace: string) {
  const deps = CALLS.backend;
  const port = portFor(tenant, workspace);
  return deps && port && switchedOn(port) ? { deps, port } : null;
}

const merge = (prev: CapturedCall | undefined, part: CapturedCall): CapturedCall => {
  const next: CapturedCall = { ...prev, ...part, truncated: Boolean(prev?.truncated || part.truncated) || undefined };
  if (!next.truncated) delete next.truncated;
  return next;
};

interface Ctx {
  tenant: string;
  workspace: string;
  runId: string;
  workspaceRoot: string;
}
interface Session {
  ctx: Ctx;
  /** Inputs waiting for their output. */
  pending: Map<string, CapturedCall>;
  writes: Set<Promise<void>>;
}
const sessions = new WeakMap<object, Session>();

/** One blob per call: pin, upload, then the row that names it. */
async function storeCall(ctx: Ctx, call: CapturedCall): Promise<void> {
  const a = active(ctx.tenant, ctx.workspace);
  const fall = (err: unknown) => {
    // TEMPORARY (see the header): the volume copy, so the call is not lost.
    opsError("captured_calls.fallback", err, { tenant: ctx.tenant, workspace: ctx.workspace, runId: ctx.runId, callId: call.id });
    try {
      writeCapturedCall(ctx.workspaceRoot, ctx.runId, call);
    } catch (e) {
      opsError("capture.write_failed", e, { runId: ctx.runId });
    }
  };
  if (!a) return fall(new Error("the call store went away before the call was written"));
  try {
    const bytes = Buffer.from(JSON.stringify(call));
    const sha = sha256Hex(bytes);
    await a.deps.pins?.pinBlobs(ctx.tenant, [sha], holderOf(ctx.runId));
    await a.deps.blobs.putIfAbsent(blobObjectKey(ctx.tenant, sha), bytes, { contentType: "application/json" });
    await a.port.async!.stepPut!(ctx.tenant, ctx.workspace, ctx.runId, KIND, call.id, { sha, size: bytes.length });
  } catch (err) {
    fall(err);
  }
}

/**
 * The runner's place to put a call's part (input on the call, output on its
 * completion). Returns whether it was taken (the event says `captured`).
 * `owner` is the step: flushCalls(owner) settles what it left.
 */
export function callSink(owner: object, ctx: Ctx): (part: CapturedCall) => boolean {
  const s: Session = { ctx, pending: new Map(), writes: new Set() };
  sessions.set(owner, s);
  return (part) => {
    if (!SAFE.test(part.id) || !SAFE.test(ctx.runId)) return false;
    const live = active(ctx.tenant, ctx.workspace);
    const waiting = s.pending.get(part.id);
    if (live && part.output === undefined) {
      s.pending.set(part.id, merge(waiting, part));
      return true;
    }
    s.pending.delete(part.id);
    // A call whose input went to the volume before the switch flipped, or on another worker.
    const prev = waiting ?? (live ? readCapturedCall(ctx.tenant, ctx.workspace, ctx.runId, part.id) ?? undefined : undefined);
    const whole = merge(prev, part);
    if (!live) {
      writeCapturedCall(ctx.workspaceRoot, ctx.runId, whole);
      return true;
    }
    const w: Promise<void> = storeCall(ctx, whole).finally(() => s.writes.delete(w));
    s.writes.add(w);
    return true;
  };
}

/** The step ended: write the inputs that never got an output, wait for every write. Never throws. */
export async function flushCalls(owner: object): Promise<void> {
  const s = sessions.get(owner);
  if (!s) return;
  sessions.delete(owner);
  for (const call of s.pending.values()) {
    if (active(s.ctx.tenant, s.ctx.workspace)) s.writes.add(storeCall(s.ctx, call));
    else {
      try {
        writeCapturedCall(s.ctx.workspaceRoot, s.ctx.runId, call);
      } catch (err) {
        opsError("capture.write_failed", err, { runId: s.ctx.runId });
      }
    }
  }
  s.pending.clear();
  await Promise.allSettled([...s.writes]);
}

/** One recorded call, or null (not recorded). The row first, then the file. */
export async function readCapturedCallAsync(tenant: string, workspace: string, runId: string, callId: string): Promise<CapturedCall | null> {
  if (!SAFE.test(runId) || !SAFE.test(callId) || callId.startsWith(".") || runId.startsWith(".")) return null;
  const port = portFor(tenant, workspace);
  if (port) {
    let row: { sha?: string } | undefined;
    try {
      row = (await port.async!.stepGet!(tenant, workspace, runId, KIND, callId)) as { sha?: string } | undefined;
    } catch (err) {
      throw new CapturedCallUnavailable(callId, err);
    }
    if (row) {
      try {
        if (!CALLS.backend || typeof row.sha !== "string") throw new Error("the call store is not available here");
        const call = JSON.parse((await readAll(CALLS.backend.blobs, blobObjectKey(tenant, row.sha))).toString("utf8")) as CapturedCall;
        if (!call || typeof call !== "object" || call.id !== callId) throw new Error("the stored object is not this call");
        return call;
      } catch (err) {
        if (!(err instanceof BlobNotFound)) opsError("captured_calls.read_failed", err, { tenant, workspace, runId, callId });
        throw new CapturedCallUnavailable(callId, err);
      }
    }
  }
  return readCapturedCall(tenant, workspace, runId, callId);
}

/**
 * One call from a run's folder into the store, whatever the switch says
 * (FOL-126: the one-time copy of the runs written before calls went to the
 * store, before the shared volume goes). "stored", "present" (already in the
 * store), or "unavailable": the store is not set up here — never mistaken for
 * present (Codex review).
 */
export async function backfillCall(tenant: string, workspace: string, runId: string, call: CapturedCall, opts: { dryRun?: boolean } = {}): Promise<"stored" | "present" | "unavailable"> {
  const deps = CALLS.backend;
  const port = portFor(tenant, workspace);
  if (!deps || !port) return "unavailable";
  if (!SAFE.test(runId) || !SAFE.test(call.id)) throw new Error(`not a call id: ${call.id}`);
  if (await port.async!.stepGet!(tenant, workspace, runId, KIND, call.id)) return "present";
  if (opts.dryRun) return "stored"; // would be
  const bytes = Buffer.from(JSON.stringify(call));
  const sha = sha256Hex(bytes);
  await deps.pins?.pinBlobs(tenant, [sha], holderOf(runId));
  await deps.blobs.putIfAbsent(blobObjectKey(tenant, sha), bytes, { contentType: "application/json" });
  await port.async!.stepPut!(tenant, workspace, runId, KIND, call.id, { sha, size: bytes.length });
  return "stored";
}

// ---------------------------------------------------------------- lifecycle

/** What the run-delete hook started and has not finished (tests, a process that is ending). */
export async function settleCalls(): Promise<void> {
  while (CALLS.background.size) await Promise.allSettled([...CALLS.background]);
}

/** A run was deleted: its calls' pin goes (the rows went with it; the sweeper takes the blobs). */
function runGone(tenant: string, _workspace: string, runId: string): void {
  const deps = CALLS.backend;
  if (!deps?.pins || !SAFE.test(runId)) return;
  const p = (async () => {
    for (let attempt = 0; ; attempt++) {
      try {
        await deps.pins!.release(tenant, holderOf(runId));
        return;
      } catch (err) {
        // A pin that cannot be released is kept: a leak is safe, a loss is not.
        if (attempt >= 4) return opsError("captured_calls.drop_failed", err, { tenant, runId });
        await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
      }
    }
  })();
  const q = p.finally(() => CALLS.background.delete(q));
  CALLS.background.add(q);
}

/** A workspace is being deleted (its rows still there): release the pin of every run that has calls
 *  in the store. Throws when the pins cannot be reached, so the delete can be retried. */
export async function dropWorkspaceCalls(tenant: string, workspace: string): Promise<void> {
  const deps = CALLS.backend;
  const port = records(tenant, workspace);
  if (!deps?.pins || !port?.async?.stepRuns) return;
  for (const runId of await port.async.stepRuns(tenant, workspace, KIND)) await deps.pins.release(tenant, holderOf(runId));
}
