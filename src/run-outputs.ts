// Run outputs in the blob store (FOL-126, phase 5).
//
// What a run's agents leave in outputs/ used to be copied, when the run
// finished, to runs/<id>/outputs/<agent>/ on the shared volume (runner.ts,
// archive()). Now, where a backend is registered and the operator has turned
// `runs.outputs_store` on, each agent's outputs are PUBLISHED instead:
//
//   files ──► BlobStore (content-addressed, create-only; pinned while uploading)
//         ──► one manifest per run + agent ({ v:1, kind:"run-output", files })
//         ──► one RunOutputStore record (the commit) + a permanent pin on the manifest
//
// It follows the publish protocol of publish.ts (pin → upload → manifest →
// commit) but NOT its head: a workspace head is a mutable compare-and-set
// pointer, and a run's outputs are immutable and belong to one run. So the
// commit is an idempotent upsert keyed by (tenant, workspace, run, agent), and
// the pin (holder kind "run", id outputs:<run>:<agent>:<manifest>) is what
// keeps the sweeper's hands off while the run exists. Deleting the run, its
// workspace or its account drops the record and the pin; the sweeper then
// collects the objects.
//
// Limits are a setting, not a surprise: a file over `runs.output_file_mb`, or
// outputs past `runs.output_run_mb` for the whole run, are REFUSED — not
// published, and not kept on the volume either (the volume goes away at
// cutover). Each is written on the run (RunRecord.outputsRefused) and in the
// step's trail, and shown on the run page.
//
// TEMPORARY (remove at the EFS cutover, FOL-126 phase 9): when publishing
// fails with an error (the store is down, the database refuses), the outputs
// are copied to the volume as before and the failure is logged
// (`run_outputs.fallback`). A laptop or an install with no backend always
// uses the volume: it is a local disk there, not the thing being retired.
//
// Reads (`listRunOutputs`, `openRunOutput`) ask the records first and the
// volume second, per agent, so a run archived either way stays readable
// whatever the setting is now.

import fs from "node:fs";
import { Readable } from "node:stream";
import path from "node:path";
import crypto from "node:crypto";
import { dataRoot } from "./paths.ts";
import { BlobNotFound, type BlobStore } from "./blob-store.ts";
import { PUBLISH_PIN_TTL_MS, noPins, type BlobPins, type PinHolder } from "./blob-pins.ts";
import {
  MAX_MANIFEST_FILES,
  MODE_EXEC,
  MODE_FILE,
  assertManifest,
  assertManifestPath,
  blobObjectKey,
  canonicalManifest,
  manifestId,
  manifestObjectKey,
  sha256Hex,
  type Manifest,
  type ManifestId,
} from "./manifest.ts";
import { BlobMissing, loadManifest, type Deps } from "./publish.ts";
import { opsError } from "./ops-log.ts";
import { refusalText } from "./run-output-refusal.ts";
export { refusalText };
import { listRunOutputsOnVolume, registerRunRemovedHook, runOutputPathOnVolume, type RefusedOutput, type RunOutputFile } from "./store.ts";

// ----------------------------------------------------------- the record store

/** What the commit writes down: which manifest is this agent's outputs of this run. */
export interface RunOutputRecord {
  tenant: string;
  workspace: string;
  runId: string;
  agent: string;
  manifest: ManifestId;
  files: number;
  bytes: number;
  at: string;
}

export interface RunOutputStore {
  readonly kind: "local" | "database";
  /** Upsert by (tenant, workspace, run, agent). Returns the record it replaced. */
  put(rec: RunOutputRecord): Promise<RunOutputRecord | null>;
  list(tenant: string, workspace: string, runId: string): Promise<RunOutputRecord[]>;
  /** Remove records and return them (the caller releases their pins):
   *  one run, one workspace, or (no workspace) the whole account. */
  drop(scope: { tenant: string; workspace?: string; runId?: string }): Promise<RunOutputRecord[]>;
  /** A workspace was renamed: its records follow. What `to` held is replaced. */
  move(tenant: string, from: string, to: string): Promise<void>;
  /** The bytes this workspace's runs keep in the store, for the usage statement
   *  (synchronous like the rest of that code). Unset: counted as 0. */
  bytes?(tenant: string, workspace: string): number;
}

const SAFE = /^[A-Za-z0-9][A-Za-z0-9._@-]{0,120}$/;
function safeName(v: string, what: string): string {
  if (!SAFE.test(v)) throw new Error(`illegal ${what}: ${v}`);
  return v;
}

/** Files under <data>/.run-outputs/<tenant>/<workspace>/<run>/<agent>.json.
 *  For an install that has a blob store but no database (and for the tests):
 *  the database one is platform's run-outputs-pg.ts. */
export function localRunOutputStore(root: string = path.join(dataRoot(), ".run-outputs")): RunOutputStore {
  const dir = (t: string, w: string, r: string) => path.join(root, safeName(t, "tenant"), safeName(w, "workspace"), safeName(r, "run"));
  const readDir = (d: string): RunOutputRecord[] => {
    if (!fs.existsSync(d)) return [];
    const out: RunOutputRecord[] = [];
    for (const f of fs.readdirSync(d)) {
      if (!f.endsWith(".json")) continue;
      try {
        out.push(JSON.parse(fs.readFileSync(path.join(d, f), "utf8")) as RunOutputRecord);
      } catch {
        // a torn write is not a record
      }
    }
    return out;
  };
  const allIn = (base: string): RunOutputRecord[] => (fs.existsSync(base) ? fs.readdirSync(base).flatMap((r) => readDir(path.join(base, r))) : []);
  return {
    kind: "local",
    async put(rec) {
      const d = dir(rec.tenant, rec.workspace, rec.runId);
      fs.mkdirSync(d, { recursive: true });
      const file = path.join(d, `${safeName(rec.agent, "agent")}.json`);
      let prev: RunOutputRecord | null = null;
      try {
        prev = JSON.parse(fs.readFileSync(file, "utf8")) as RunOutputRecord;
      } catch {
        // none
      }
      const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(rec));
      fs.renameSync(tmp, file);
      return prev;
    },
    async list(t, w, r) {
      return readDir(dir(t, w, r));
    },
    async drop({ tenant, workspace, runId }) {
      safeName(tenant, "tenant");
      if (workspace && runId) {
        const d = dir(tenant, workspace, runId);
        const had = readDir(d);
        fs.rmSync(d, { recursive: true, force: true });
        return had;
      }
      const base = workspace ? path.join(root, tenant, safeName(workspace, "workspace")) : path.join(root, tenant);
      const had = workspace ? allIn(base) : fs.existsSync(base) ? fs.readdirSync(base).flatMap((w) => allIn(path.join(base, w))) : [];
      fs.rmSync(base, { recursive: true, force: true });
      return had;
    },
    bytes(t, w) {
      const base = path.join(root, safeName(t, "tenant"), safeName(w, "workspace"));
      return allIn(base).reduce((n, r) => n + r.bytes, 0);
    },
    async move(t, from, to) {
      const a = path.join(root, safeName(t, "tenant"), safeName(from, "workspace"));
      const b = path.join(root, t, safeName(to, "workspace"));
      fs.rmSync(b, { recursive: true, force: true });
      if (!fs.existsSync(a)) return;
      fs.renameSync(a, b);
      for (const rec of allIn(b)) {
        rec.workspace = to;
        const f = path.join(b, rec.runId, `${rec.agent}.json`);
        fs.writeFileSync(f, JSON.stringify(rec));
      }
    },
  };
}

// ----------------------------------------------------------------- the backend

export interface RunOutputsBackend {
  blobs: BlobStore;
  /** Unset: no sweeper to agree with (noPins). */
  pins?: BlobPins;
  store: RunOutputStore;
  /** The `runs.outputs_store` setting, read on every call. */
  enabled: () => boolean;
  /** Per file (`runs.output_file_mb`) and per run (`runs.output_run_mb`), in bytes. */
  fileMaxBytes: () => number;
  runMaxBytes: () => number;
}

let backend: RunOutputsBackend | null = null;

/** Where run outputs are published, or null (every run archives to the volume). */
export function setRunOutputsBackend(b: RunOutputsBackend | null): void {
  backend = b;
  registerRunRemovedHook(b ? runDeleted : null);
}
export const runOutputsBackend = (): RunOutputsBackend | null => backend;
function safeCall<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}
/** Publishing is on: a backend is registered and the operator has said so. */
export const runOutputsOn = (): boolean => !!backend && safeCall(backend.enabled, false);

const pinsOf = (b: RunOutputsBackend): BlobPins => b.pins ?? noPins;

/** The permanent pin on one record's manifest. The manifest id is part of the
 *  holder, so a re-archive (a resumed run) can pin the new manifest before it
 *  releases the old one. */
export function outputsHolder(runId: string, agent: string, manifest: ManifestId): PinHolder {
  return { kind: "run", id: `outputs:${runId}:${agent}:${manifest.slice(0, 16)}` };
}
const releaseRecords = async (b: RunOutputsBackend, recs: readonly RunOutputRecord[]): Promise<void> => {
  for (const r of recs) await pinsOf(b).release(r.tenant, outputsHolder(r.runId, r.agent, r.manifest));
};

// ------------------------------------------------------------------ publishing

/** How many files are in flight at once, and so at most this many buffered. */
const UPLOAD_CONCURRENCY = 4;
const MAX_REFUSALS_ON_RECORD = 100;

interface Candidate {
  rel: string;
  abs: string;
  size: number;
  mode: number;
}

function walk(root: string): Candidate[] {
  const out: Candidate[] = [];
  const rec = (dir: string, rel: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, e.name);
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) rec(abs, r);
      else if (e.isFile()) {
        const st = fs.lstatSync(abs);
        out.push({ rel: r, abs, size: st.size, mode: st.mode & 0o111 ? MODE_EXEC : MODE_FILE });
      }
      // symlinks, sockets and the like are not outputs (the volume copy skipped them too)
    }
  };
  rec(root, "");
  return out.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
}

export interface PublishedOutputs {
  record: RunOutputRecord | null;
  refused: RefusedOutput[];
}

/**
 * Publish one agent's outputs of one run. Returns the record (null: nothing
 * was kept — no files, or every one refused) and what was refused. Throws when
 * the store or the database fails; the caller decides what that means
 * (archiveRunOutputs: the temporary volume fallback). Idempotent: the same
 * files again are the same manifest and the same record.
 */
export async function publishRunOutputs(
  b: RunOutputsBackend,
  tenant: string,
  workspace: string,
  runId: string,
  agent: string,
  dir: string,
): Promise<PublishedOutputs> {
  safeName(agent, "agent");
  const fileMax = b.fileMaxBytes();
  const runMax = b.runMaxBytes();
  const refused: RefusedOutput[] = [];
  // What the run's other agents already hold counts against the run's cap.
  const others = (await b.store.list(tenant, workspace, runId)).filter((r) => r.agent !== agent);
  let used = others.reduce((n, r) => n + r.bytes, 0);

  const kept: Candidate[] = [];
  const lower = new Map<string, string>();
  for (const c of walk(dir)) {
    const refuse = (reason: RefusedOutput["reason"], limit?: number) => refused.push({ agent, path: c.rel, bytes: c.size, reason, ...(limit !== undefined ? { limit } : {}) });
    try {
      assertManifestPath(c.rel, "run-output");
    } catch {
      refuse("name");
      continue;
    }
    const folded = c.rel.toLowerCase();
    if (lower.has(folded)) {
      refuse("name");
      continue;
    }
    if (kept.length >= MAX_MANIFEST_FILES) {
      refuse("count", MAX_MANIFEST_FILES);
      continue;
    }
    if (fileMax > 0 && c.size > fileMax) {
      refuse("file-cap", fileMax);
      continue;
    }
    if (runMax > 0 && used + c.size > runMax) {
      refuse("run-cap", runMax);
      continue;
    }
    lower.set(folded, c.rel);
    used += c.size;
    kept.push(c);
  }
  if (!kept.length) return { record: null, refused };

  const pins = pinsOf(b);
  const publishHolder: PinHolder = { kind: "publish", id: `outputs:${runId}:${agent}` };
  // No prototype: an output may be named anything legal, `__proto__` too
  // (review, 12 Nov 2026: a plain object dropped it silently).
  const files: Manifest["files"] = Object.create(null);
  let pinnedRun: PinHolder | null = null;
  let id: ManifestId | null = null;
  try {
    // Pin BEFORE the objects exist: a sweeper that looks now sees the pin.
    // Read each file once for its hash (a file can only be named by its
    // bytes), then upload; at most UPLOAD_CONCURRENCY buffers are live.
    let next = 0;
    const lane = async () => {
      for (;;) {
        const i = next++;
        if (i >= kept.length) return;
        const c = kept[i];
        const body = fs.readFileSync(c.abs);
        // Grew since it was measured (an agent still writing): same rule, same cap.
        if (fileMax > 0 && body.length > fileMax) {
          refused.push({ agent, path: c.rel, bytes: body.length, reason: "file-cap", limit: fileMax });
          continue;
        }
        const sha = sha256Hex(body);
        // Pin each blob before its put; a repeat extends the lease.
        await pins.pinBlobs(tenant, [sha], publishHolder, { ttlMs: PUBLISH_PIN_TTL_MS });
        await b.blobs.putIfAbsent(blobObjectKey(tenant, sha), body);
        files[c.rel] = { sha, size: body.length, mode: c.mode };
      }
    };
    await Promise.all(Array.from({ length: Math.min(UPLOAD_CONCURRENCY, kept.length) }, lane));

    if (!Object.keys(files).length) return { record: null, refused };
    const manifest: Manifest = { v: 1, kind: "run-output", files };
    assertManifest(manifest);
    id = manifestId(manifest);
    await pins.pinManifests(tenant, [id], publishHolder, { ttlMs: PUBLISH_PIN_TTL_MS });
    await b.blobs.putIfAbsent(manifestObjectKey(tenant, id), Buffer.from(canonicalManifest(manifest)));
    // The permanent pin lands before the commit: whatever happens next, a
    // record never names a manifest nothing holds.
    pinnedRun = outputsHolder(runId, agent, id);
    await pins.pinManifests(tenant, [id], pinnedRun);

    const record: RunOutputRecord = {
      tenant,
      workspace,
      runId,
      agent,
      manifest: id,
      files: Object.keys(files).length,
      bytes: Object.values(files).reduce((n, f) => n + f.size, 0),
      at: new Date().toISOString(),
    };
    const prev = await b.store.put(record);
    if (prev && prev.manifest !== id) await pins.release(tenant, outputsHolder(runId, agent, prev.manifest));
    return { record, refused };
  } catch (err) {
    // The pin was taken for a commit that did not happen: let go, unless the
    // record that stands names this very manifest (a repeat that failed late).
    if (pinnedRun && id) {
      try {
        const cur = (await b.store.list(tenant, workspace, runId)).find((r) => r.agent === agent);
        if (!cur || cur.manifest !== id) await pins.release(tenant, pinnedRun);
      } catch {
        // an unknown state keeps the pin: leaking an object is safe, losing one is not
      }
    }
    throw err;
  } finally {
    await pins.release(tenant, publishHolder).catch(() => {});
  }
}

/** The caller's note on the run: what was refused, on the record, in the
 *  step's trail. Mutates `run` (the caller saves it). */
export function noteRefused(
  run: { outputsRefused?: RefusedOutput[]; outputsRefusedCount?: number; steps: { status: string; events: { t: string; type: string; text: string }[] }[] },
  refused: readonly RefusedOutput[],
): void {
  if (!refused.length) return;
  const have = run.outputsRefused ?? [];
  const seen = new Set(have.map((r) => `${r.agent}\u0000${r.path}`));
  const fresh = refused.filter((r) => !seen.has(`${r.agent}\u0000${r.path}`));
  if (!fresh.length) return;
  run.outputsRefused = [...have, ...fresh].slice(0, MAX_REFUSALS_ON_RECORD);
  run.outputsRefusedCount = (run.outputsRefusedCount ?? have.length) + fresh.length;
  const last = run.steps.findLast((s) => s.status !== "pending") ?? run.steps[0];
  for (const r of fresh.slice(0, 20)) {
    last?.events.push({ t: new Date().toISOString(), type: "error", text: `outputs: ${refusalText(r)}` });
  }
  if (fresh.length > 20) last?.events.push({ t: new Date().toISOString(), type: "error", text: `outputs: ${fresh.length - 20} more files were not kept` });
}

/**
 * runner.ts archive() for one agent: publish when it is on, else (or when it
 * fails) say "volume" and the caller copies the folder as before.
 */
export async function archiveRunOutputs(
  tenant: string,
  workspace: string,
  runId: string,
  agent: string,
  dir: string,
): Promise<{ where: "store"; refused: RefusedOutput[] } | { where: "volume" }> {
  const b = backend;
  if (!b || !runOutputsOn()) return { where: "volume" };
  try {
    const r = await publishRunOutputs(b, tenant, workspace, runId, agent, dir);
    return { where: "store", refused: r.refused };
  } catch (err) {
    // TEMPORARY (EFS cutover, FOL-126 phase 9): an error publishing is not a
    // reason to lose the run's outputs while the volume still exists. Remove
    // this branch with the volume; then a failed publish fails the archive.
    opsError("run_outputs.fallback", err, { tenant, workspace, run: runId, agent });
    return { where: "volume" };
  }
}

// --------------------------------------------------------------------- reading

/** loadManifest reads blobs only; there is no revision store behind a run's outputs. */
const readDeps = (b: RunOutputsBackend): Deps => ({ blobs: b.blobs, revisions: undefined as unknown as Deps["revisions"] });

async function recordsOf(tenant: string, workspace: string, runId: string): Promise<RunOutputRecord[]> {
  if (!backend) return [];
  try {
    return await backend.store.list(tenant, workspace, runId);
  } catch (err) {
    opsError("run_outputs.list_failed", err, { tenant, workspace, run: runId });
    throw err;
  }
}

/** What a run archived, from the store and from the volume (an agent the store
 *  has wins). Sorted by agent, then path. */
export async function listRunOutputs(tenant: string, workspace: string, runId: string): Promise<RunOutputFile[]> {
  const recs = await recordsOf(tenant, workspace, runId);
  const out: RunOutputFile[] = [];
  for (const r of recs) {
    const m = await loadManifest(readDeps(backend!), tenant, r.manifest);
    for (const [p, e] of Object.entries(m.files)) out.push({ agent: r.agent, path: p, bytes: e.size });
  }
  const mine = new Set(recs.map((r) => r.agent));
  for (const f of listRunOutputsOnVolume(tenant, workspace, runId)) if (!mine.has(f.agent)) out.push(f);
  return out.sort((a, b) => a.agent.localeCompare(b.agent) || a.path.localeCompare(b.path));
}

export interface OpenedOutput {
  size: number;
  /** The bytes, or one inclusive range of them. */
  read(range?: { start: number; end: number }): ReadableStream<Uint8Array>;
}

/** One archived output, or null when the name escapes the archive or names
 *  nothing — the API serves only what this returns. */
export async function openRunOutput(tenant: string, workspace: string, runId: string, agent: string, rel: string): Promise<OpenedOutput | null> {
  if (!agent || !rel || agent.includes("/") || agent.includes("\\") || agent.startsWith(".")) return null;
  const rec = (await recordsOf(tenant, workspace, runId)).find((r) => r.agent === agent);
  if (rec && backend) {
    const m = await loadManifest(readDeps(backend), tenant, rec.manifest);
    const e = m.files[rel.normalize("NFC")];
    if (!e) return null;
    const key = blobObjectKey(tenant, e.sha);
    const blobs = backend.blobs;
    // A blob that is gone is an explicit failure (never an empty file); heading
    // here makes it one error before any byte is sent.
    if (!(await blobs.head(key))) throw new BlobMissing(`${agent}/${rel}`, e.sha);
    return {
      size: e.size,
      // Pull-driven: a chunk is fetched only when the reader asks for one,
      // and a cancelled download stops the blob read (review, 12 Nov 2026:
      // the eager loop buffered whole files for slow or gone clients).
      read: (range) => {
        let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
        return new ReadableStream<Uint8Array>({
          async pull(c) {
            try {
              reader ??= (await blobs.get(key, range ? { range } : undefined)).getReader();
              const { done, value } = await reader.read();
              if (done) c.close();
              else c.enqueue(value);
            } catch (err) {
              c.error(err instanceof BlobNotFound ? new BlobMissing(`${agent}/${rel}`, e.sha) : err);
            }
          },
          async cancel(reason) {
            await reader?.cancel(reason).catch(() => {});
          },
        });
      },
    };
  }
  const file = runOutputPathOnVolume(tenant, workspace, runId, agent, rel);
  if (!file) return null;
  const size = fs.statSync(file).size;
  return {
    size,
    // Node's own bridge keeps the file stream paused until the reader pulls.
    read: (range) => Readable.toWeb(fs.createReadStream(file, range ? { start: range.start, end: range.end } : undefined)) as ReadableStream<Uint8Array>,
  };
}

/** The whole file as bytes (a small one: a test, a preview). */
export async function readRunOutput(tenant: string, workspace: string, runId: string, agent: string, rel: string): Promise<Buffer | null> {
  const o = await openRunOutput(tenant, workspace, runId, agent, rel);
  if (!o) return null;
  const chunks: Buffer[] = [];
  const reader = o.read().getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

// ------------------------------------------------------------------- lifecycle

/** A run is deleted: its records and their pins go. Throws when the store
 *  cannot be reached (deleteRun's caller retries in the background). */
export async function dropRunOutputs(tenant: string, workspace: string, runId: string): Promise<void> {
  const b = backend;
  if (!b) return;
  await releaseRecords(b, await b.store.drop({ tenant, workspace, runId }));
}

/** A workspace is deleted: every run's records of it. */
export async function dropWorkspaceOutputs(tenant: string, workspace: string): Promise<void> {
  const b = backend;
  if (!b) return;
  await releaseRecords(b, await b.store.drop({ tenant, workspace }));
}

/** An account is deleted. Its pins are released by dropTenantRevisions (all pins
 *  of the account); the records go here. */
export async function dropTenantOutputs(tenant: string): Promise<void> {
  await backend?.store.drop({ tenant });
}

/** A workspace was renamed: the records follow (the pins are not keyed by
 *  it). What the new name held belonged to a workspace that no longer
 *  exists: those records go first, and their pins with them (the database
 *  store does both in its move too; the file store did not — review, 12 Nov
 *  2026). */
export async function moveWorkspaceOutputs(tenant: string, from: string, to: string): Promise<void> {
  const b = backend;
  if (!b) return;
  await releaseRecords(b, await b.store.drop({ tenant, workspace: to }));
  await b.store.move(tenant, from, to);
}

/** What a workspace's runs hold in the store, in bytes: counted with the run
 *  history on the usage statement, where the volume's `runs/` folder was. A
 *  store that cannot say, or cannot be reached, counts 0 (a statement must not fail). */
export function runOutputBytes(tenant: string, workspace: string): number {
  try {
    return backend?.store.bytes?.(tenant, workspace) ?? 0;
  } catch (err) {
    opsError("run_outputs.bytes_failed", err, { tenant, workspace }, "warn");
    return 0;
  }
}

const background = new Set<Promise<unknown>>();
/** Wait for the retries a sync caller started (tests, process end). */
export async function settleRunOutputs(): Promise<void> {
  while (background.size) await Promise.allSettled([...background]);
}

/** deleteRun cannot wait: do it now, and on a failure try again 1, 2, 4, 8 s
 *  later, then say so (`run_outputs.drop_failed`; the blobs stay until a human looks). */
export function runDeleted(tenant: string, workspace: string, runId: string): void {
  if (!backend) return;
  const b = backend;
  // The records dropped are kept across the retries: a release that fails
  // after the drop must not leave the next try with nothing to release
  // (review, 12 Nov 2026).
  let dropped: RunOutputRecord[] | null = null;
  const p = (async () => {
    for (let attempt = 0; ; attempt++) {
      try {
        dropped ??= await b.store.drop({ tenant, workspace, runId });
        return await releaseRecords(b, dropped);
      } catch (err) {
        if (attempt >= 4) return opsError("run_outputs.drop_failed", err, { tenant, workspace, run: runId });
        await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
      }
    }
  })();
  const q = p.finally(() => background.delete(q));
  background.add(q);
}
