// What a step was handed and started from, kept beside its run (FOL-126 phase 7).
//
// Three small records, all platform-owned and never staged into a sandbox:
//   handed-in  the hash of every file a driver put in the pod (copy-back diff)
//   base       the revisions the stage-in started from (RunBase)
//   storage    the storage/ index as it was when the run first materialized it
//              (its existence is "this run has been here before" — a worker
//              that picks a run up again stores what it changed first)
//
// With a database and `runs.step_state_store` on they are rows (records port,
// table run_step_state), deleted with the run, the workspace and the account.
// Otherwise they are files under runs/<id>/, as before. Reads look at rows
// first whatever the switch says, then at the file, so turning it off — or on —
// mid-run loses nothing; a write with the switch off removes the key's row
// first, so the file written is the one read. A row that cannot be read is an error, not "none":
// "none" means "start again from scratch", and that is not what a database
// that is down means.

import fs from "node:fs";
import path from "node:path";
import { records } from "./records.ts";

export type StepStateKind = "handed-in" | "base" | "storage" | "test-writes";

const SAFE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/;
const okIds = (runId: string, ref: string) => SAFE.test(runId) && (ref === "" || SAFE.test(ref));

/** The rows' port for this run, or null: it is files (no database, the workspace
 *  not moved yet, no tenant known). */
function port(tenant: string | undefined, workspace: string) {
  if (!tenant) return null;
  const p = records(tenant, workspace);
  return p?.async?.stepGet ? p : null;
}

/** Stored as a row? False: the caller writes the file. */
export async function putStepState(tenant: string | undefined, workspace: string, runId: string, kind: StepStateKind, ref: string, data: unknown): Promise<boolean> {
  const p = port(tenant, workspace);
  if (!p || !tenant || !p.async?.stepPut || !okIds(runId, ref)) return false;
  if (!safeOn(p)) {
    // Switched off with a row already there: reads look at rows first, so
    // the old row would shadow the file the caller is about to write (a
    // resumed run's storage baseline is rewritten each time — review, 12 Nov
    // 2026). The row goes; a failure here is an error, not a quiet stale read.
    await p.async.stepDrop?.(tenant, workspace, runId, kind, ref);
    return false;
  }
  await p.async.stepPut(tenant, workspace, runId, kind, ref, data);
  return true;
}
const safeOn = (p: { stepStateOn?(): boolean }): boolean => {
  try {
    return p.stepStateOn?.() === true;
  } catch {
    return false;
  }
};

/** The row, or undefined (look at the file). */
export async function getStepState(tenant: string | undefined, workspace: string, runId: string, kind: StepStateKind, ref: string): Promise<unknown | undefined> {
  const p = port(tenant, workspace);
  if (!p || !tenant || !p.async?.stepGet || !okIds(runId, ref)) return undefined;
  return p.async.stepGet(tenant, workspace, runId, kind, ref);
}

/** Forget rows (a step's copy-out is done). Files are the caller's. */
export async function dropStepState(tenant: string | undefined, workspace: string, runId: string, kind: StepStateKind, ref: string | null): Promise<void> {
  const p = port(tenant, workspace);
  if (!p || !tenant || !p.async?.stepDrop || !okIds(runId, ref ?? "")) return;
  await p.async.stepDrop(tenant, workspace, runId, kind, ref);
}

// ------------------------------------------------------------ storage baseline

const baselineFile = (workspaceRoot: string, runId: string): string => path.join(workspaceRoot, "runs", runId, "storage-baseline.json");

const asHashes = (v: unknown): Record<string, string> | undefined => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, string>) : undefined);

/** The storage index this run first materialized, or undefined: it has not been here. */
export async function readStorageBaseline(workspaceRoot: string, tenant: string | undefined, workspace: string, runId: string): Promise<Record<string, string> | undefined> {
  const row = asHashes(await getStepState(tenant, workspace, runId, "storage", ""));
  if (row) return row;
  const file = baselineFile(workspaceRoot, runId);
  if (!fs.existsSync(file)) return undefined;
  try {
    return asHashes(JSON.parse(fs.readFileSync(file, "utf8")));
  } catch {
    return undefined;
  }
}

export async function writeStorageBaseline(workspaceRoot: string, tenant: string | undefined, workspace: string, runId: string, hashes: Record<string, string>): Promise<void> {
  if (await putStepState(tenant, workspace, runId, "storage", "", hashes)) return;
  const file = baselineFile(workspaceRoot, runId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(hashes));
}
