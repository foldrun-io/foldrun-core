// The records a workspace accumulates, behind a seam (FOL-126, phase 2).
//
// Runs, the run index, the trigger log and the storage file index used to be
// files on the data volume. On a hosted install they are rows in Postgres —
// but core has no database, and its callers are synchronous (readRun is called
// from dozens of places). So this is a small SYNCHRONOUS port: the platform
// registers an implementation (foldrun-platform src/records-pg.ts, which asks
// Postgres through a thread so the caller can keep its shape) and every
// function here falls back to the files when none is registered. A laptop, the
// CLI and a self-hosted install with no database never register one, so none
// of them changes by a byte.
//
// What is NOT here: run outputs and captured calls (bytes, phase 5), the
// ledger (platform, its own table), secrets (phase 6), workspace files
// (phase 3, revisions).

import { platform } from "./platform.ts";
import type { RunRecord, RunSummary } from "./store.ts";
import type { TriggerEvent } from "./trigger-log.ts";
import type { FileRecord } from "./storage.ts";

/** The read half of the port without blocking the event loop (FOL-126 phase
 *  3b): the hot reads — one run, a workspace's run list, its live runs — asked
 *  of the database directly. Optional: a port without it is read through its
 *  synchronous twin, so a caller can always ask the async form. The rest of
 *  the port (writes, the trigger log, the storage index, counts, moves) is
 *  still synchronous: see the phase 3b report for the list. */
export interface RecordsPortAsync {
  runGet(tenant: string, workspace: string, id: string): Promise<RunRecord | null>;
  runSummaries(tenant: string, workspace: string): Promise<RunSummary[]>;
  runLive(tenant: string, workspace: string): Promise<RunRecord[]>;
}

export interface RecordsPort {
  /** Async reads (see RecordsPortAsync). */
  async?: RecordsPortAsync;
  // ---- runs: the whole record, and the row a list reads
  /** Insert or replace one run. `live`: queued, running or parked at a gate. Last write wins. */
  runPut(tenant: string, workspace: string, run: RunRecord, summary: RunSummary, live: boolean): void;
  runGet(tenant: string, workspace: string, id: string): RunRecord | null;
  /** True when a row was there. */
  runDelete(tenant: string, workspace: string, id: string): boolean;
  /** Every run's row, newest first. */
  runSummaries(tenant: string, workspace: string): RunSummary[];
  /** The live runs, whole, newest first. */
  runLive(tenant: string, workspace: string): RunRecord[];
  runCount(tenant: string, workspace: string): number;
  /** Every workspace's run count in one question (the workspace list asks it once, not once per workspace). */
  runCounts(tenant: string): Record<string, number>;
  /** Every run, whole, newest first. */
  runAll(tenant: string, workspace: string): RunRecord[];
  /** Up to `limit` of one flow's runs, whole, newest first. */
  runRecent(tenant: string, workspace: string, flow: string, limit: number): RunRecord[];
  /** Runs that started at or after `sinceMs`, whole, newest first. */
  runsSince(tenant: string, workspace: string, sinceMs: number): RunRecord[];
  /** When the row last changed, in epoch MICROseconds, or null when there is
   *  none — what a poller compares instead of a file's mtime (two writes in one
   *  millisecond still differ), and what runUpdatedMs divides by 1000 for the
   *  age checks that want milliseconds. */
  runStamp(tenant: string, workspace: string, id: string): number | null;

  // ---- the trigger log: newest 500 per workspace kept
  triggerAppend(tenant: string, workspace: string, event: TriggerEvent): void;
  /** Newest first. */
  triggerRead(tenant: string, workspace: string, limit: number): TriggerEvent[];

  // ---- the storage/ file index
  fileList(tenant: string, workspace: string): FileRecord[];
  filePut(tenant: string, workspace: string, record: FileRecord): void;
  fileDelete(tenant: string, workspace: string, path: string): boolean;

  // ---- a workspace as a whole
  /** Every record of the workspace is gone (it was deleted). Safe to repeat. */
  workspaceDrop(tenant: string, workspace: string): void;
  /** The workspace was renamed: its runs and trigger log follow. The file
   *  index does NOT — it moves with the bytes it names (fileMove), after they
   *  are copied, so a failed copy leaves index and bytes together. */
  workspaceMove(tenant: string, from: string, to: string): void;
  /** The storage file index follows the workspace's new name. */
  fileMove(tenant: string, from: string, to: string): void;

  /** True while this workspace's records are still FILES on this process: its
   *  boot import could not move them (records-import.ts), so every function
   *  answers from the files for it, and the next boot tries again. Optional:
   *  a port without it has no such workspaces. */
  onFiles?(tenant: string, workspace: string): boolean;

  /** A short named lock across processes, with stale-holder fencing: while
   *  `fn` runs, every write of this port made in its async context is refused
   *  if a newer holder took the lock over. */
  lock<T>(name: string, fn: () => Promise<T>): Promise<T>;
}

/** The registered port, or null: files, as before. With a workspace, null also
 *  when that workspace is still on files (its import is pending). */
export function records(tenant?: string, workspace?: string): RecordsPort | null {
  const port = platform.records ?? null;
  if (port && tenant !== undefined && workspace !== undefined && port.onFiles?.(tenant, workspace)) return null;
  return port;
}
