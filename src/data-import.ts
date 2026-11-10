// The data importer (FOL-126 phase 8): an old-style /data folder's workspace
// content in, as revisions + blobs.
//
//   scanSource   read the folder (never writes to it) and say what is in it
//   runImport    publish every workspace's authored files and `state/` through
//                the publish protocol, each side on its own head
//   verifyImport compare every workspace's heads with the folder by path,
//                sha256 and mode, write a per-workspace pass/fail report
//
// What it is NOT: runs, the trigger log and the storage index moved into
// their tables in FOL-152 (foldrun-platform records-import.ts) and are not
// read here. Run output folders (runs/<id>/) are only counted, so the report
// says what is still on the volume; phase 5 decides where they go. Secrets
// are not opened: a secrets file is reported by name and size like any other
// file nothing maps.
//
// Why it exists beside the boot reconcile (workspace-revisions.ts): the
// reconcile records text only and never adds a binary file to a head; this
// carries binaries, executable bits and `state/`, as one verified first head
// authored `import:data-folder`.
//
// What it promises:
//   - The source folder is only ever read. No rename, no ".imported" marker:
//     a failed cutover must be able to start over from the same folder.
//   - Dry-run is the default and writes nothing. Without a destination it only
//     reads the folder; with one it also reads (never writes) the heads to say
//     what is already there.
//   - Idempotent and resumable per workspace: every publish is keyed by the
//     content of its change set, so a rerun that finds the same bytes commits
//     nothing, and one that died halfway finishes the rest. A workspace whose
//     history holds a revision NOT made by the importer (someone has used it
//     since, or the reconcile recorded it) is skipped unless `force`, so a
//     rerun after cutover cannot undo real work. Even forced, an import only
//     adds and overwrites; it deletes nothing unless `mirror`.
//   - A path that cannot be a manifest path is REPORTED, never guessed at:
//     symlinks (refused, not followed), names that are not NFC or too long,
//     top-level folders that are in neither the authored nor the state list.
//     Two names that differ only by case cannot share a manifest: the first
//     (byte order) keeps its name, the others are kept as conflict copies,
//     like a conflict anywhere else — nothing is dropped.
//   - A file is never read whole into memory unless it is small: a large one
//     is streamed to the store from disk (pinned first, as a publish pins) and
//     a deep verify streams it back to a temporary file.
//
// Imports nothing from the database: the destination is a Deps (BlobStore +
// RevisionStore), so the same code runs against the local implementations in
// a test and against Postgres + S3 on dev.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { pipeline } from "node:stream/promises";
import {
  AUTHORED_DIRS,
  MAX_MANIFEST_FILES,
  MODE_EXEC,
  MODE_FILE,
  assertManifestPath,
  blobObjectKey,
  conflictPath,
  diffManifests,
  emptyManifest,
  sha256Hex,
  sideOf,
  type Changes,
  type Manifest,
} from "./manifest.ts";
import { headsOf, manifestsAt, publish, requestDigest, type Deps } from "./publish.ts";
import { BlobNotFound, BlobSourceError, downloadToFile, fileSource } from "./blob-store.ts";
import type { Revision, WorkspaceRef } from "./revision-store.ts";
import { isPlatformPath } from "./store.ts";

// store.ts keeps this pattern private; a name that fails it is not an account or workspace.
const SAFE_NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export const IMPORT_BY = "import:data-folder";

/** Files at or under this are read whole for the publish; a larger one is
 *  streamed from disk. */
export const LARGE_FILE_BYTES = 8 * 1024 * 1024;
/** How long the importer's own pin on a streamed blob lives (a publish's is
 *  shorter); released as soon as the publish is done. */
const LARGE_PIN_TTL_MS = 30 * 60_000;

// ------------------------------------------------------------- scan

export interface SourceFile {
  /** The manifest path (a conflict copy's path differs from `from`). */
  path: string;
  abs: string;
  sha: string;
  size: number;
  mode: number;
  side: "authored" | "state";
  /** Set when this file is kept under a conflict-copy name; the path it wanted. */
  from?: string;
}
export interface Unmapped {
  path: string;
  reason: string;
  /** Files inside (a folder), when counted. */
  files?: number;
  bytes?: number;
}
export interface WorkspaceScan {
  tenant: string;
  workspace: string;
  dir: string;
  files: SourceFile[];
  bytes: number;
  unmapped: Unmapped[];
  conflicts: { path: string; keptAs: string }[];
  /** What runs/ holds on the volume, counted and never read: record files
   *  (FOL-152 moved those to rows) and output folders (runs/<id>/). */
  runs: { recordFiles: number; outputFolders: number; outputFiles: number; outputBytes: number };
  /** Set when the workspace cannot be imported at all (reason). */
  error?: string;
}
export interface TenantScan {
  tenant: string;
  workspaces: WorkspaceScan[];
  /** Account-level folders and files nothing maps here (library/, .history/, storage/, secrets …). */
  unmapped: Unmapped[];
}
export interface SourceScan {
  source: string;
  tenants: TenantScan[];
  scannedAt: string;
}
export interface ScanOptions {
  source: string;
  /** Only these accounts / "account/workspace" pairs. */
  tenants?: string[];
  workspaces?: string[];
}

export async function hashFile(abs: string): Promise<string> {
  const h = crypto.createHash("sha256");
  await pipeline(fs.createReadStream(abs), h);
  return h.digest("hex");
}

/** Count what is under a folder without following links or reading content. */
function tally(abs: string, limit = 200_000): { files: number; bytes: number } {
  let files = 0;
  let bytes = 0;
  const stack = [abs];
  while (stack.length && files < limit) {
    const d = stack.pop()!;
    let ents: fs.Dirent[] = [];
    try {
      ents = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) stack.push(p);
      else {
        files++;
        try {
          bytes += fs.lstatSync(p).size;
        } catch {
          // gone meanwhile
        }
      }
    }
  }
  return { files, bytes };
}

const inExecBit = (st: fs.Stats) => ((st.mode & 0o111) !== 0 ? MODE_EXEC : MODE_FILE);

/**
 * Two names that differ only by case cannot share a manifest. The first in
 * byte order keeps its name; each later one is kept as a conflict copy beside
 * it (deterministic, so a rerun names the same file). `rels` must be sorted.
 * Pure, because a case-insensitive disk (a Mac) cannot hold the pair to test
 * the scanner with.
 */
export function placeCaseVariants(rels: string[], seed: string): { rel: string; from?: string }[] {
  const byLower = new Set<string>();
  return rels.map((rel) => {
    let out = rel;
    let from: string | undefined;
    if (byLower.has(rel.toLowerCase())) {
      const op = `import-case-${sha256Hex(`${seed}/${rel}`).slice(0, 16)}`;
      for (let n = 0; ; n++) {
        const c = conflictPath(rel, op, n);
        if (!byLower.has(c.toLowerCase())) {
          out = c;
          break;
        }
      }
      from = rel;
    }
    byLower.add(out.toLowerCase());
    return { rel: out, ...(from ? { from } : {}) };
  });
}

const byName = (a: fs.Dirent, b: fs.Dirent) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

/** What a workspace folder holds that is not workspace content, and why it is left. */
const PLATFORM_MARKERS: Record<string, string> = {
  "trigger-log.jsonl": "trigger log (moved into Postgres by FOL-152; not read here)",
  "trigger-log.jsonl.tmp": "trigger log temp file (not read here)",
  "hooks.json": "webhook tokens (platform file; not mapped)",
  "hook-deliveries.jsonl": "hook delivery log (not mapped)",
  ".repo.json": "platform file; not workspace content",
  once: "operation markers (the unique keys decide now; not imported)",
  ".foldrun": "platform folder; not workspace content",
  storage: "workspace-local storage folder (the storage index moved in FOL-152; not read here)",
};

async function scanWorkspace(tenant: string, workspace: string, dir: string): Promise<WorkspaceScan> {
  const ws: WorkspaceScan = {
    tenant, workspace, dir, files: [], bytes: 0, unmapped: [], conflicts: [],
    runs: { recordFiles: 0, outputFolders: 0, outputFiles: 0, outputBytes: 0 },
  };
  const found: { rel: string; abs: string; st: fs.Stats }[] = [];

  const walk = (rel: string) => {
    const abs = path.join(dir, ...rel.split("/"));
    let ents: fs.Dirent[];
    try {
      ents = fs.readdirSync(abs, { withFileTypes: true });
    } catch (err) {
      ws.unmapped.push({ path: rel, reason: `unreadable folder (${(err as NodeJS.ErrnoException).code ?? "error"})` });
      return;
    }
    for (const e of ents.sort(byName)) {
      const r = `${rel}/${e.name}`;
      const a = path.join(abs, e.name);
      let st: fs.Stats;
      try {
        st = fs.lstatSync(a);
      } catch {
        continue;
      }
      if (st.isSymbolicLink()) ws.unmapped.push({ path: r, reason: "symbolic link (refused, never followed)" });
      else if (st.isDirectory()) walk(r);
      else if (st.isFile()) found.push({ rel: r, abs: a, st });
      else ws.unmapped.push({ path: r, reason: "not a regular file" });
    }
  };

  let top: fs.Dirent[];
  try {
    top = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    ws.error = `workspace folder unreadable (${(err as NodeJS.ErrnoException).code ?? "error"})`;
    return ws;
  }
  for (const e of top.sort(byName)) {
    const name = e.name;
    const abs = path.join(dir, name);
    let st: fs.Stats;
    try {
      st = fs.lstatSync(abs);
    } catch {
      continue;
    }
    if (st.isSymbolicLink()) {
      ws.unmapped.push({ path: name, reason: "symbolic link (refused, never followed)" });
    } else if (st.isDirectory() && (AUTHORED_DIRS.includes(name) || name === "state")) {
      walk(name);
    } else if (st.isFile() && sideOf(name) === "authored") {
      found.push({ rel: name, abs, st });
    } else if (name === "runs" && st.isDirectory()) {
      // Counted, never read: records are rows now; output folders wait for phase 5.
      for (const r of fs.readdirSync(abs, { withFileTypes: true })) {
        if (r.isDirectory()) {
          const t = tally(path.join(abs, r.name));
          ws.runs.outputFolders++;
          ws.runs.outputFiles += t.files;
          ws.runs.outputBytes += t.bytes;
        } else ws.runs.recordFiles++;
      }
    } else if (/^secrets\.json(\.|$)/.test(name)) {
      // The vault and its lock/temp files: never opened. Named, with a size, like any unmapped file.
      ws.unmapped.push({ path: name, reason: "secrets (never opened here; they move with the vault)", files: 1, bytes: st.size });
    } else if (PLATFORM_MARKERS[name]) {
      const t = st.isDirectory() ? tally(abs) : { files: 1, bytes: st.size };
      ws.unmapped.push({ path: name, reason: PLATFORM_MARKERS[name], ...t });
    } else {
      const t = st.isDirectory() ? tally(abs) : { files: 1, bytes: st.size };
      ws.unmapped.push({ path: name, reason: "not part of a workspace manifest (in neither the authored nor the state list)", ...t });
    }
  }

  // Which of the found files can be a manifest path; case collisions.
  const mapped: { rel: string; abs: string; st: fs.Stats }[] = [];
  for (const f of found) {
    if (isPlatformPath(f.rel)) {
      ws.unmapped.push({ path: f.rel, reason: "platform or engine file, not workspace content", files: 1, bytes: f.st.size });
      continue;
    }
    try {
      assertManifestPath(f.rel);
    } catch (err) {
      ws.unmapped.push({ path: f.rel, reason: (err as Error).message.replace(`${f.rel} `, "").replace(/^illegal manifest path:? ?/, "not a valid manifest path ") || "not a valid manifest path", files: 1, bytes: f.st.size });
      continue;
    }
    mapped.push(f);
  }
  mapped.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  const placed = placeCaseVariants(mapped.map((f) => f.rel), `${tenant}/${workspace}`);
  for (const [i, f] of mapped.entries()) {
    const { rel, from } = placed[i];
    const side = sideOf(f.rel)!;
    if (from) ws.conflicts.push({ path: from, keptAs: rel });
    let sha: string;
    try {
      sha = await hashFile(f.abs);
    } catch (err) {
      ws.unmapped.push({ path: f.rel, reason: `unreadable (${(err as NodeJS.ErrnoException).code ?? "error"})`, files: 1, bytes: f.st.size });
      continue;
    }
    ws.files.push({ path: rel, abs: f.abs, sha, size: f.st.size, mode: inExecBit(f.st), side, ...(from ? { from } : {}) });
    ws.bytes += f.st.size;
  }
  for (const side of ["authored", "state"] as const) {
    if (ws.files.filter((f) => f.side === side).length > MAX_MANIFEST_FILES) ws.error = `more than ${MAX_MANIFEST_FILES} ${side} files (a manifest holds at most that many)`;
  }
  return ws;
}

export async function scanSource(opts: ScanOptions): Promise<SourceScan> {
  const source = path.resolve(opts.source);
  if (!fs.existsSync(source) || !fs.statSync(source).isDirectory()) throw new Error(`source is not a folder: ${source}`);
  const tenants: TenantScan[] = [];
  const names = fs.readdirSync(source).filter((n) => SAFE_NAME.test(n)).sort();
  for (const tenant of names) {
    const troot = path.join(source, tenant);
    let st: fs.Stats;
    try {
      st = fs.lstatSync(troot);
    } catch {
      continue;
    }
    if (!st.isDirectory() || st.isSymbolicLink()) continue;
    if ((opts.tenants?.length || opts.workspaces?.length) && !opts.tenants?.includes(tenant) && !opts.workspaces?.some((w) => w.startsWith(`${tenant}/`))) continue;
    const t: TenantScan = { tenant, workspaces: [], unmapped: [] };
    // The legacy home first: a workspace in both is the projects/ one, the
    // copy workspaceDir (store.ts) resolves and the platform actually uses.
    const homes = ["projects", "workspaces"].map((n) => path.join(troot, n));
    const seen = new Set<string>();
    for (const home of homes) {
      let wsNames: string[] = [];
      try {
        wsNames = fs.readdirSync(home).filter((n) => SAFE_NAME.test(n)).sort();
      } catch {
        continue;
      }
      for (const w of wsNames) {
        // A workspace under the legacy name wins, as workspaceDir resolves it.
        if (seen.has(w)) continue;
        const dir = path.join(home, w);
        let wst: fs.Stats;
        try {
          wst = fs.lstatSync(dir);
        } catch {
          continue;
        }
        if (!wst.isDirectory() || wst.isSymbolicLink()) continue;
        if (opts.workspaces?.length && !opts.workspaces.includes(`${tenant}/${w}`) && !opts.tenants?.includes(tenant)) continue;
        seen.add(w);
        t.workspaces.push(await scanWorkspace(tenant, w, dir));
      }
    }
    for (const e of fs.readdirSync(troot, { withFileTypes: true }).sort(byName)) {
      if (e.name === "workspaces" || e.name === "projects") continue;
      const p = path.join(troot, e.name);
      const tl = e.isDirectory() ? tally(p) : { files: 1, bytes: fs.lstatSync(p).size };
      const reason = e.name === ".history" ? "old history snapshots (revisions start from the imported tree)"
        : /^secrets\.json(\.|$)/.test(e.name) ? "account secrets (never opened here; they move with the vault)"
        : e.name === "storage" || e.name === "files" ? "the storage index and its blobs (moved in FOL-152; not read here)"
        : "account-level, nothing maps it here";
      t.unmapped.push({ path: e.name, reason, ...tl });
    }
    tenants.push(t);
  }
  return { source, tenants, scannedAt: new Date().toISOString() };
}

// ------------------------------------------------------------- import

export interface ImportOptions {
  deps: Deps;
  /** Delete head paths the folder does not have. Default off: an import never
   *  removes anything from the destination. */
  mirror?: boolean;
  /** Import a workspace whose history has revisions the importer did not make. */
  force?: boolean;
  by?: string;
}

export type WorkspaceStatus = "imported" | "unchanged" | "skipped" | "failed" | "empty";
export interface WorkspaceResult {
  tenant: string;
  workspace: string;
  status: WorkspaceStatus;
  reason?: string;
  revisions: string[];
  conflictsKept: number;
  filesPublished: number;
  /** Files streamed from disk (over LARGE_FILE_BYTES) rather than read whole. */
  filesStreamed: number;
}
export interface ImportReport {
  startedAt: string;
  finishedAt: string;
  results: WorkspaceResult[];
}

const wsRef = (w: Pick<WorkspaceScan, "tenant" | "workspace">): WorkspaceRef => ({ tenant: w.tenant, workspace: w.workspace });

async function foreignRevisions(deps: Deps, ref: WorkspaceRef): Promise<Revision[]> {
  const out: Revision[] = [];
  for (const scope of ["workspace", "state"] as const) {
    const revs = await deps.revisions.revisions({ ...ref, scope }, { limit: 200 });
    out.push(...revs.filter((r) => !r.by.startsWith("import")));
  }
  return out;
}

function wantManifest(scan: WorkspaceScan): Manifest {
  const m = emptyManifest();
  for (const f of scan.files) m.files[f.path] = { sha: f.sha, size: f.size, mode: f.mode };
  return m;
}

export async function importWorkspace(scan: WorkspaceScan, opts: ImportOptions): Promise<WorkspaceResult> {
  const { deps } = opts;
  const ref = wsRef(scan);
  const res: WorkspaceResult = { tenant: scan.tenant, workspace: scan.workspace, status: "imported", revisions: [], conflictsKept: scan.conflicts.length, filesPublished: 0, filesStreamed: 0 };
  if (scan.error) return { ...res, status: "failed", reason: scan.error };
  let holder: { kind: "publish"; id: string } | null = null;
  try {
    if (!opts.force) {
      const foreign = await foreignRevisions(deps, ref);
      if (foreign.length) return { ...res, status: "skipped", reason: `${foreign.length} revision(s) were made after the import (latest by ${foreign[0].by}); rerun with force to import over them` };
    }
    const heads = await headsOf(deps, ref);
    const have = await manifestsAt(deps, scan.tenant, heads);
    const haveAll: Manifest = { v: 1, files: { ...have.authored.files, ...have.state.files } };
    const want = wantManifest(scan);
    let changes: Changes = diffManifests(haveAll, want);
    if (!opts.mirror) changes = Object.fromEntries(Object.entries(changes).filter(([, c]) => c.op === "put"));
    if (!Object.keys(changes).length) return { ...res, status: scan.files.length ? "unchanged" : "empty" };

    // The heads it starts from are part of the operation: the same changes
    // from a different head (A → B, back to A, then A → B again) are a new
    // import, not a retry of the first — which publish would replay, leaving
    // A in place and reporting success (Codex review). A real retry starts
    // from the same heads and still finds its operation.
    const opId = `import-${requestDigest("import", { changes, heads: [heads.workspace?.id ?? null, heads.state?.id ?? null] }).slice(0, 32)}`;
    const bySha = new Map(scan.files.map((f) => [f.sha, f]));

    // A large file goes up from disk, pinned first (as a publish pins what it
    // uploads), so it is never held whole in memory; the publish then finds it
    // in the store and does not ask for its bytes.
    const large = [...new Set(Object.values(changes).filter((c) => c.op === "put" && c.size > LARGE_FILE_BYTES).map((c) => (c.op === "put" ? c.sha : "")))];
    if (large.length) {
      holder = { kind: "publish", id: `${opId}-large` };
      await deps.pins?.pinBlobs(scan.tenant, large, holder, { ttlMs: LARGE_PIN_TTL_MS });
      for (const sha of large) {
        const f = bySha.get(sha);
        if (!f) throw new Error(`no source file for ${sha.slice(0, 12)}…`);
        if (await hashFile(f.abs) !== sha) throw new Error(`${f.path} changed while it was being imported`);
        await deps.blobs.putSourceIfAbsent(blobObjectKey(scan.tenant, sha), fileSource(f.abs), { sha256: sha });
        res.filesStreamed++;
      }
    }

    const out = await publish(deps, {
      ws: ref,
      opId,
      by: opts.by ?? IMPORT_BY,
      message: "imported from a data folder",
      changes,
      bytesOf: async (sha) => {
        const f = bySha.get(sha);
        if (!f) throw new Error(`no source file for ${sha.slice(0, 12)}…`);
        const b = fs.readFileSync(f.abs);
        if (sha256Hex(b) !== sha) throw new Error(`${f.path} changed while it was being imported`);
        return b;
      },
    });
    res.filesPublished = Object.values(changes).filter((c) => c.op === "put").length;
    if (out.status !== "unchanged" && out.revision) res.revisions.push(out.revision.id);
    if (out.stateRevision) res.revisions.push(out.stateRevision.id);
    res.conflictsKept += out.conflicts.length;
    return res;
  } catch (err) {
    return { ...res, status: "failed", reason: (err as Error).message };
  } finally {
    if (holder) await deps.pins?.release(scan.tenant, holder).catch(() => {});
  }
}

export async function runImport(scan: SourceScan, opts: ImportOptions): Promise<ImportReport> {
  const startedAt = new Date().toISOString();
  const results: WorkspaceResult[] = [];
  for (const t of scan.tenants) for (const w of t.workspaces) results.push(await importWorkspace(w, opts));
  return { startedAt, finishedAt: new Date().toISOString(), results };
}

// ------------------------------------------------------------- dry-run

export interface PlanWorkspace {
  tenant: string;
  workspace: string;
  files: number;
  bytes: number;
  authoredFiles: number;
  stateFiles: number;
  revisionsToMake: number | "unknown";
  alreadyThere: "yes" | "partly" | "no" | "unknown";
  note?: string;
}

/** What an import would do, per workspace. Reads the destination's heads when
 *  given a Deps (never writes); without one, "unknown". */
export async function planImport(scan: SourceScan, deps?: Deps): Promise<PlanWorkspace[]> {
  const out: PlanWorkspace[] = [];
  for (const t of scan.tenants) {
    for (const w of t.workspaces) {
      const p: PlanWorkspace = {
        tenant: w.tenant, workspace: w.workspace, files: w.files.length, bytes: w.bytes,
        authoredFiles: w.files.filter((f) => f.side === "authored").length, stateFiles: w.files.filter((f) => f.side === "state").length,
        revisionsToMake: "unknown", alreadyThere: "unknown",
      };
      if (w.error) p.note = `cannot import: ${w.error}`;
      else if (deps) {
        try {
          const have = await manifestsAt(deps, w.tenant, await headsOf(deps, wsRef(w)));
          const all = { ...have.authored.files, ...have.state.files };
          const want = wantManifest(w).files;
          const same = Object.keys(want).filter((k) => all[k]?.sha === want[k].sha && all[k]?.mode === want[k].mode).length;
          p.alreadyThere = !Object.keys(want).length ? "yes" : same === Object.keys(want).length ? "yes" : same ? "partly" : "no";
          const sides = new Set(Object.keys(want).filter((k) => !(all[k]?.sha === want[k].sha && all[k]?.mode === want[k].mode)).map((k) => w.files.find((f) => f.path === k)!.side));
          p.revisionsToMake = sides.size;
          const foreign = await foreignRevisions(deps, wsRef(w));
          if (foreign.length) p.note = `${foreign.length} revision(s) by someone else (latest by ${foreign[0].by}): an import skips this workspace unless --force`;
        } catch (err) {
          p.note = `could not read the destination: ${(err as Error).message}`;
        }
      }
      out.push(p);
    }
  }
  return out;
}

const kb = (n: number) => (n >= 1 << 20 ? `${(n / (1 << 20)).toFixed(1)} MiB` : n >= 1024 ? `${(n / 1024).toFixed(1)} KiB` : `${n} B`);

export function renderPlan(scan: SourceScan, plan: PlanWorkspace[]): string {
  const L: string[] = [`DRY RUN — nothing was written. Source: ${scan.source}`, ""];
  let files = 0;
  let bytes = 0;
  for (const t of scan.tenants) {
    L.push(`account ${t.tenant}  (${t.workspaces.length} workspace(s))`);
    for (const u of t.unmapped) L.push(`  can't map  ${u.path}: ${u.reason} (${u.files ?? 0} files, ${kb(u.bytes ?? 0)})`);
    for (const w of t.workspaces) {
      const p = plan.find((x) => x.tenant === w.tenant && x.workspace === w.workspace)!;
      files += w.files.length;
      bytes += w.bytes;
      L.push(`  ${w.workspace}: ${w.files.length} files, ${kb(w.bytes)} (${p.authoredFiles} authored, ${p.stateFiles} state) → revisions to make: ${p.revisionsToMake}; already in destination: ${p.alreadyThere}`);
      if (p.note) L.push(`    ! ${p.note}`);
      L.push(`    runs/ on the volume: ${w.runs.recordFiles} record file(s) (rows since FOL-152); output folders (not imported here): ${w.runs.outputFolders} (${w.runs.outputFiles} files, ${kb(w.runs.outputBytes)})`);
      for (const c of w.conflicts) L.push(`    conflict    ${c.path} collides by case with another name; kept as ${c.keptAs}`);
      for (const u of w.unmapped) L.push(`    can't map  ${u.path}: ${u.reason}${u.files ? ` (${u.files} files, ${kb(u.bytes ?? 0)})` : ""}`);
    }
  }
  L.push("", `Total: ${files} workspace files, ${kb(bytes)}.`);
  return L.join("\n") + "\n";
}

// ------------------------------------------------------------- verify

export interface VerifyWorkspace {
  tenant: string;
  workspace: string;
  pass: boolean;
  expected: number;
  inHead: number;
  matched: number;
  missing: string[];
  mismatched: string[];
  extra: string[];
  /** Absent from the store, the wrong size, or (deep) bytes that do not hash to their name. */
  badBlobs: string[];
  notes: string[];
}
export interface VerifyReport {
  verifiedAt: string;
  source: string;
  pass: boolean;
  workspaces: VerifyWorkspace[];
}
export interface VerifyOptions {
  deps: Deps;
  /** Stream every blob back and hash it (default: confirm each exists with the right size). */
  deep?: boolean;
  /** Paths in the head that the folder does not have are fine. */
  allowExtra?: boolean;
}

/** Compare every workspace's heads with the folder, by path, sha256 and mode —
 *  the folder's hashes are taken again now, not trusted from the scan. */
export async function verifyImport(scan: SourceScan, opts: VerifyOptions): Promise<VerifyReport> {
  const { deps } = opts;
  const workspaces: VerifyWorkspace[] = [];
  const tmp = opts.deep ? fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-verify-")) : null;
  try {
    for (const t of scan.tenants) {
      for (const w of t.workspaces) {
        const v: VerifyWorkspace = { tenant: w.tenant, workspace: w.workspace, pass: true, expected: w.files.length, inHead: 0, matched: 0, missing: [], mismatched: [], extra: [], badBlobs: [], notes: [] };
        try {
          if (w.error) throw new Error(w.error);
          // The folder as it is NOW — its paths and modes, not the scan's:
          // a file added, or an exec bit changed, since the scan must fail
          // the check, not pass it on stale data (Codex review).
          const current = await scanWorkspace(w.tenant, w.workspace, w.dir);
          if (current.error) throw new Error(current.error);
          v.expected = current.files.length;
          const have = await manifestsAt(deps, w.tenant, await headsOf(deps, wsRef(w)));
          const all = { ...have.authored.files, ...have.state.files };
          v.inHead = Object.keys(all).length;
          const checked = new Set<string>();
          // A file the import had that the folder no longer gives back — gone,
          // or now unreadable (the scan lists those apart, not as files) —
          // is a mismatch, as before the rescan; never a quietly smaller set.
          const nowThere = new Set(current.files.map((f) => f.path));
          for (const f of w.files) {
            if (nowThere.has(f.path)) continue;
            v.notes.push(`${f.path}: the source file can no longer be read`);
            v.mismatched.push(f.path);
          }
          for (const f of current.files) {
            let now: string;
            try {
              now = await hashFile(f.abs);
            } catch {
              v.notes.push(`${f.path}: the source file can no longer be read`);
              v.mismatched.push(f.path);
              continue;
            }
            const e = all[f.path];
            if (!e) v.missing.push(f.path);
            else if (e.sha !== now || e.mode !== f.mode) v.mismatched.push(f.path);
            else {
              v.matched++;
              try {
                const key = blobObjectKey(w.tenant, e.sha);
                const h = await deps.blobs.head(key);
                if (!h || h.size !== e.size) v.badBlobs.push(f.path);
                else if (tmp && !checked.has(e.sha)) {
                  checked.add(e.sha);
                  const dest = path.join(tmp, e.sha);
                  try {
                    await downloadToFile(deps.blobs, key, dest, { sha256: e.sha });
                  } finally {
                    fs.rmSync(dest, { force: true });
                    fs.rmSync(`${dest}.part`, { force: true });
                  }
                }
              } catch (err) {
                if (err instanceof BlobNotFound || err instanceof BlobSourceError) v.badBlobs.push(f.path);
                else throw err;
              }
            }
          }
          const wanted = new Set(current.files.map((f) => f.path));
          v.extra = Object.keys(all).filter((p) => !wanted.has(p)).sort();
          v.pass = !v.missing.length && !v.mismatched.length && !v.badBlobs.length && (opts.allowExtra || !v.extra.length);
          if (!opts.allowExtra && v.extra.length) v.notes.push(`${v.extra.length} path(s) in the head are not in the source (work done after the import, or --mirror was not used)`);
        } catch (err) {
          v.pass = false;
          v.notes.push((err as Error).message);
        }
        workspaces.push(v);
      }
    }
  } finally {
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  }
  return { verifiedAt: new Date().toISOString(), source: scan.source, pass: workspaces.every((x) => x.pass), workspaces };
}

export function renderVerify(r: VerifyReport): string {
  const L = [`Import verification ${r.pass ? "PASSED" : "FAILED"} — ${r.verifiedAt}`, `Source: ${r.source}`, ""];
  for (const w of r.workspaces) {
    L.push(`${w.pass ? "PASS" : "FAIL"}  ${w.tenant}/${w.workspace}: ${w.matched}/${w.expected} files match (head holds ${w.inHead})`);
    const list = (label: string, xs: string[]) => xs.length && L.push(`      ${label}: ${xs.slice(0, 10).join(", ")}${xs.length > 10 ? ` … +${xs.length - 10}` : ""}`);
    list("missing from head", w.missing);
    list("different sha256 or mode", w.mismatched);
    list("blob missing or wrong in the store", w.badBlobs);
    list("extra in head", w.extra);
    for (const n of w.notes) L.push(`      note: ${n}`);
  }
  L.push("", `${r.workspaces.filter((w) => w.pass).length} of ${r.workspaces.length} workspace(s) passed.`);
  return L.join("\n") + "\n";
}

/** Write import-verify.json and import-verify.txt. Refuses a folder inside the source. */
export function writeVerifyReport(dir: string, source: string, r: VerifyReport): { json: string; txt: string } {
  const out = path.resolve(dir);
  const src = path.resolve(source);
  if (out === src || out.startsWith(src + path.sep)) throw new Error("the report folder must be outside the source folder");
  fs.mkdirSync(out, { recursive: true });
  const json = path.join(out, "import-verify.json");
  const txt = path.join(out, "import-verify.txt");
  fs.writeFileSync(json, JSON.stringify(r, null, 2) + "\n");
  fs.writeFileSync(txt, renderVerify(r));
  return { json, txt };
}
