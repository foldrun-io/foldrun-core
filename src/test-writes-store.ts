// A test run's diverted writes, kept off the pod's disk (FOL-126, the shared
// volume retired): what a test run's steps wrote to state/ and storage/ goes
// under runs/<id>/test-writes/ on the worker that ran the step, and the next
// step — on any worker, after any restart — must see it. So after each step
// the folder's files are put in the blob store (pinned by the run) and listed
// in one step-state row; before each step the files that row names and the
// folder lacks are brought back. Without a database or a blob store (a laptop,
// the CLI) nothing changes: the folder is all there is.

import fs from "node:fs";
import path from "node:path";
import { dropStepState } from "./step-state.ts";
import { records } from "./records.ts";
import { revisionBackend } from "./workspace-revisions.ts";
import { blobObjectKey, sha256Hex } from "./manifest.ts";
import { readAll } from "./blob-types.ts";
import { registerRunRemovedHook } from "./store.ts";
import { opsError } from "./ops-log.ts";
import { processState } from "./process-state.ts";

interface Listed {
  sha: string;
  size: number;
  mtimeMs: number;
}

const KIND = "test-writes" as const;
/** Per run folder on this worker: the version of each file it last brought
 *  back or saved. A local file that differs from it is a change not saved yet
 *  (another step of the run on this worker); one equal to it is a copy the
 *  rows may update. File times never decide this (Codex review). */
const KNOWN = processState("test-writes-known", () => new Map<string, Map<string, string>>());
const knownOf = (dir: string) => {
  let m = KNOWN.get(dir);
  if (!m) KNOWN.set(dir, (m = new Map()));
  return m;
};
const holderOf = (runId: string) => ({ kind: "run" as const, id: `test-writes:${runId}` });
/** A diverted file kept whole up to this; a bigger one stays on the worker
 *  that wrote it (and is named in the ops line), as before. */
const MAX_FILE = 64 * 1024 * 1024;

function walk(root: string): { rel: string; abs: string }[] {
  const out: { rel: string; abs: string }[] = [];
  if (!fs.existsSync(root)) return out;
  for (const e of fs.readdirSync(root, { recursive: true, withFileTypes: true })) {
    if (!e.isFile()) continue; // links and the rest never leave the worker
    const abs = path.join(e.parentPath, e.name);
    out.push({ rel: path.relative(root, abs).replaceAll("\\", "/"), abs });
  }
  return out;
}

/** The rows' port (null: a laptop, no records port), and whether new rows
 *  are written (`runs.step_state_store`). Rows already there are READ either
 *  way, as step state's are (Codex review). */
function rowsPort(tenant: string, workspace: string) {
  const p = records(tenant, workspace);
  if (!p?.async?.stepPut || !p.async.stepList || !p.async.stepDrop) return null;
  let on = false;
  try {
    on = p.stepStateOn?.() === true;
  } catch {
    on = false;
  }
  return { port: p.async, on };
}
/** One row per file, keyed by its path's hash: two steps of the run saving at
 *  once (a parallel group on two workers) each write their own rows, never
 *  one index over the other (Codex review). */
const refOf = (rel: string) => sha256Hex(Buffer.from(rel)).slice(0, 40);

/** After a step: the run's diverted files into the store, one row each.
 *  Throws: a step whose writes were not kept must not count as done. */
/** What the folder held when an attempt started (restoreTestWrites' answer):
 *  a save writes only what the attempt changed from it, so a file another
 *  step changed meanwhile on another worker is never written back stale
 *  (Codex review). */
export type TestWritesStart = Map<string, { sha: string; mtimeMs: number }>;

function snapshot(dir: string): TestWritesStart {
  const m: TestWritesStart = new Map();
  for (const f of walk(dir)) m.set(f.rel, { sha: sha256Hex(fs.readFileSync(f.abs)), mtimeMs: fs.statSync(f.abs).mtimeMs });
  return m;
}

export async function saveTestWrites(tenant: string, workspace: string, runId: string, dir: string, start?: TestWritesStart): Promise<number> {
  const deps = revisionBackend();
  const rp = rowsPort(tenant, workspace);
  if (!deps || !rp) return 0;
  const { port, on } = rp;
  const prior = new Map((await port.stepList!(tenant, workspace, runId, KIND)).map((r) => [(r.data as Listed & { path: string }).path, r.data as Listed]));
  let saved = 0;
  for (const f of walk(dir)) {
    const st = fs.statSync(f.abs);
    const was = prior.get(f.rel);
    if (!on) {
      // Rows switched off: the folder is the record; an old row for this file
      // goes, so it is never restored over the newer one.
      if (was && (was.size !== st.size || was.sha !== sha256Hex(fs.readFileSync(f.abs)))) await port.stepDrop!(tenant, workspace, runId, KIND, refOf(f.rel));
      continue;
    }
    if (st.size > MAX_FILE) {
      // Not kept elsewhere, so the step fails rather than let an older copy
      // come back over it on the next step (Codex review).
      throw new Error(`a test run's diverted file is over ${MAX_FILE / 1024 / 1024} MiB and cannot be kept for the next step`);
    }
    const bytes = fs.readFileSync(f.abs);
    const sha = sha256Hex(bytes);
    if (was && was.sha === sha && was.mtimeMs === st.mtimeMs) continue; // a newer time with the same bytes counts
    const atStart = start?.get(f.rel);
    // Unchanged by this attempt AND already kept: another step's newer copy
    // stays; a file never kept (the store switched on mid-run) is kept now.
    if (was && atStart && atStart.sha === sha && atStart.mtimeMs === st.mtimeMs) continue;
    if (was?.sha !== sha) {
      await deps.pins?.pinBlobs(tenant, [sha], holderOf(runId));
      await deps.blobs.putIfAbsent(blobObjectKey(tenant, sha), bytes);
    }
    await port.stepPut!(tenant, workspace, runId, KIND, refOf(f.rel), { path: f.rel, sha, size: bytes.length, mtimeMs: st.mtimeMs });
    knownOf(dir).set(f.rel, sha);
    saved++;
  }
  return saved;
}

/** Before a step: what the rows name and this worker's folder lacks (or has
 *  at another time). Throws: a step must not run without what earlier steps wrote. */
export async function restoreTestWrites(tenant: string, workspace: string, runId: string, dir: string): Promise<{ restored: number; start: TestWritesStart }> {
  const deps = revisionBackend();
  const rp = rowsPort(tenant, workspace);
  if (!deps || !rp) return { restored: 0, start: new Map() }; // nothing kept elsewhere: nothing to compare (a laptop hashes nothing)
  const { port } = rp;
  let n = 0;
  for (const row of await port.stepList!(tenant, workspace, runId, KIND)) {
    const f = row.data as Listed & { path: string };
    if (typeof f?.path !== "string" || refOf(f.path) !== row.ref) continue;
    const abs = path.resolve(dir, f.path);
    if (!abs.startsWith(path.resolve(dir) + path.sep)) continue; // names stay inside the folder
    const t = new Date(f.mtimeMs);
    const known = knownOf(dir);
    if (fs.existsSync(abs)) {
      const local = sha256Hex(fs.readFileSync(abs));
      if (local === f.sha) {
        known.set(f.path, f.sha);
        if (Math.round(fs.statSync(abs).mtimeMs) !== Math.round(f.mtimeMs)) fs.utimesSync(abs, t, t);
        continue;
      }
      // Changed here since this process last brought or saved it: another
      // step of the run wrote it and has not saved yet — kept (Codex review).
      // No record at all (a restart: no step of this process is mid-write)
      // means a stale copy, refreshed from the rows.
      const was = known.get(f.path);
      if (was !== undefined && local !== was) continue;
    }
    const bytes = await readAll(deps.blobs, blobObjectKey(tenant, f.sha));
    if (sha256Hex(bytes) !== f.sha) throw new Error("a diverted file's object does not hash to its name — refused");
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, bytes);
    fs.utimesSync(abs, t, t); // a verify that asks whether a file is fresh answers for the step that wrote it
    known.set(f.path, f.sha);
    n++;
  }
  return { restored: n, start: snapshot(dir) };
}

/** A run deleted: its diverted files' pins and row go. */
registerRunRemovedHook((tenant, workspace, runId) => {
  for (const dir of [...KNOWN.keys()]) if (dir.includes(`${path.sep}runs${path.sep}${runId}${path.sep}`)) KNOWN.delete(dir);
  const deps = revisionBackend();
  void (async () => {
    await deps?.pins?.release(tenant, holderOf(runId));
    await dropStepState(tenant, workspace, runId, KIND, null);
  })().catch((err) => opsError("test_writes.release_failed", err, { tenant, workspace, runId }, "warn"));
}, "test-writes");
