// The manifest: what a workspace revision is made of (FOL-126, phase 1).
//
// A revision does not hold files. It points at two manifests — one for what
// people author, one for state — and a manifest maps each path to an
// immutable blob:
//
//   { v: 1, files: { "agents/writer/agent.md": { sha, size, mode } } }
//
// Content-addressed twice over: a blob is named by the hash of its bytes, and
// a manifest by the hash of its canonical JSON. Equal content is the same
// object, so a re-publish of an unchanged tree uploads nothing and a restore
// is just a new pointer at old objects.
//
// What a manifest cannot say (by decision, phase 1):
//   symlinks      not representable. A scanner that meets one must REFUSE it
//                 (lstat, never follow), not store its target's bytes: following
//                 a link out of the workspace is how a file outside it gets
//                 published. (The laptop's agents/<a>/workspace link is a CLI
//                 thing; the hosted copy-back already skips symlinks.)
//   empty folders not representable; a folder exists while it holds a file.
//   rename        there is no rename entry: a move is a delete plus a put, so a
//                 concurrent edit to the old path survives beside the new one.
//   owner/times   not kept.
//   case          two names that differ only by case cannot share a manifest;
//                 paths must be NFC. Both are enforced on write and on read.
//   size          at most MAX_MANIFEST_FILES per manifest; a manifest is read
//                 and rewritten whole on every publish, so very large trees
//                 want a sharded manifest (open, phase 3/4).
//
// Nothing here touches a disk or a network. It is the vocabulary the
// BlobStore, the RevisionStore and the publish protocol share.

import crypto from "node:crypto";

export interface ManifestEntry {
  /** sha256 of the bytes, lower-case hex. The blob's name. */
  sha: string;
  size: number;
  /** 0o644, or 0o755 when the file is executable (store.ts marks scripts so).
   *  Stored as the number, so JSON carries 420 or 493. Nothing else is kept:
   *  owner, times and extended attributes are not part of a workspace. */
  mode: number;
}

export interface Manifest {
  v: 1;
  /** Absent: a workspace manifest (paths under the authored/state roots).
   *  "run-output": what one agent of one run left in outputs/ (FOL-126 phase 5):
   *  any legal relative path, never a head, never restored. Part of the
   *  canonical form, so the two kinds can never share an id. */
  kind?: "run-output";
  /** Forward-slashed paths, relative to the workspace root. */
  files: Record<string, ManifestEntry>;
}

export const MODE_FILE = 0o644;
export const MODE_EXEC = 0o755;

/** A manifest id: the sha256 of its canonical JSON. */
export type ManifestId = string;

// ---------- which top-level names are what ----------
//
// The two manifests split a workspace by lifetime, not by file type:
//
//   authored  what a person (or a deploy, or the assistant) wrote on purpose.
//             Reviewed, diffed, restored. Everything in WORKSPACE_DIRS except
//             state/, plus the two root files.
//   state     what runs accumulate: state/. Checkpointed per step, restorable
//             separately and only on request (restoring source must not
//             rewind a week of an agent's memory-of-work).
//
// Everything else a workspace directory holds is somebody else's record and is
// refused here on purpose, because it already has an owner:
//
//   storage/   its own file index (uploads; FileRecord, not a manifest)
//   runs/      run records and outputs (Postgres + S3 in phase 2/5)
//   secrets    the vault (phase 6), outside every manifest and every restore
//   once/, trigger-log.jsonl, hook-deliveries.jsonl, history*   records
//   .git, node_modules, .venv    never workspace content
//
// A path that is in none of these lists is refused rather than guessed at: a
// new top-level folder is a decision (add it here and say which side it is
// on), not an accident that silently starts being versioned.

// FROZEN for manifest v1. These are literals, not derived from WORKSPACE_DIRS:
// a manifest already written must keep meaning what it meant, so adding a
// folder to store.ts later must not silently change which old paths are valid.
// tests/manifest.test.ts compares this list with WORKSPACE_DIRS and fails when
// they differ — the failure is the prompt to decide which side the new folder
// is on, and whether that needs manifest v2.
export const AUTHORED_DIRS: readonly string[] = ["agents", "flows", "evals", "skills", "memory", "knowledge", "tools", "scripts", "hooks"];
export const STATE_DIRS: readonly string[] = ["state"];
export const AUTHORED_ROOT_FILES: readonly string[] = ["AGENTS.md", "project.md"];
/** A conflict copy of a root file (conflictPath) is a root file too. */
const ROOT_CONFLICT = /^(AGENTS|project)\.conflict-[0-9a-f]{12}(-\d+)?\.md$/;

export type Side = "authored" | "state";

/** Which manifest a path belongs in, or null when it belongs in neither. */
export function sideOf(rel: string): Side | null {
  if (AUTHORED_ROOT_FILES.includes(rel) || ROOT_CONFLICT.test(rel)) return "authored";
  const top = rel.split("/")[0];
  if (rel.includes("/") && AUTHORED_DIRS.includes(top)) return "authored";
  if (rel.includes("/") && STATE_DIRS.includes(top)) return "state";
  return null;
}

/**
 * A manifest path: relative, forward-slashed, no empty / `.` / `..` segment,
 * no control characters, at most 400 characters (the same bounds as a storage
 * path), and on one of the two sides. Throws; returns the path unchanged when
 * it is fine. Backslashes are REFUSED rather than converted: a manifest must
 * round-trip byte for byte, and `a\b` on one machine is a different name from
 * `a/b` on another.
 */
export const MAX_PATH_BYTES = 400;
/** Files per manifest (authored and state each). A manifest is read and
 *  rewritten whole on every publish; this bounds that cost until manifests
 *  are sharded. 50k files is ~5 MB of canonical JSON. */
export const MAX_MANIFEST_FILES = 50_000;

export function assertManifestPath(rel: string, kind?: Manifest["kind"]): string {
  if (typeof rel !== "string" || !rel || Buffer.byteLength(rel) > MAX_PATH_BYTES) throw new Error(`illegal manifest path: ${String(rel).slice(0, 80)}`);
  if (rel.includes("\\") || rel.startsWith("/") || /^[a-zA-Z]:/.test(rel)) throw new Error(`illegal manifest path: ${rel}`);
  if (rel.split("/").some((s) => s === "" || s === "." || s === "..")) throw new Error(`illegal manifest path: ${rel}`);
  if (/[\u0000-\u001f\u007f]/.test(rel)) throw new Error(`illegal manifest path: ${rel}`);
  // NFC only: "é" typed as one character and as e + a combining accent are one
  // name on a Mac and two on Linux. A manifest holds the composed form, so it
  // extracts the same everywhere. (Case is handled per manifest, below.)
  if (rel !== rel.normalize("NFC")) throw new Error(`illegal manifest path (not NFC-normalised): ${rel}`);
  if (kind !== "run-output" && sideOf(rel) === null) throw new Error(`${rel} is not workspace content (authored: ${[...AUTHORED_DIRS, ...AUTHORED_ROOT_FILES].join(", ")}; state: state/)`);
  return rel;
}

/** Two paths that differ only by case cannot both be extracted on a
 *  case-insensitive disk (macOS and Windows laptops, Docker Desktop volumes).
 *  Display casing is kept; a collision inside one manifest is refused. */
export function assertNoCaseCollisions(m: Manifest): void {
  const seen = new Map<string, string>();
  for (const p of Object.keys(m.files)) {
    const k = p.toLowerCase();
    const was = seen.get(k);
    if (was !== undefined && was !== p) throw new Error(`${p} and ${was} differ only by case`);
    seen.set(k, p);
  }
  if (seen.size > MAX_MANIFEST_FILES) throw new Error(`a manifest holds at most ${MAX_MANIFEST_FILES} files`);
}

export const sha256Hex = (b: string | Uint8Array) => crypto.createHash("sha256").update(b).digest("hex");

/** What "the same entry" means: bytes AND mode. A chmod +x is a change even
 *  though the sha is the same. Changes record this as their `base`. */
export const entryId = (e: Pick<ManifestEntry, "sha" | "mode">) => `${e.sha}:${e.mode.toString(8)}`;

export function assertEntry(p: string, e: ManifestEntry): void {
  if (!/^[0-9a-f]{64}$/.test(e?.sha) || !Number.isSafeInteger(e.size) || e.size < 0 || (e.mode !== MODE_FILE && e.mode !== MODE_EXEC)) {
    throw new Error(`manifest entry for ${p} is malformed`);
  }
}

/** Everything parseManifest would refuse, checked on a manifest we are about
 *  to WRITE — a revision must never point at a manifest it cannot read back. */
export function assertManifest(m: Manifest): void {
  for (const [p, e] of Object.entries(m.files)) {
    assertManifestPath(p, m.kind);
    assertEntry(p, e);
  }
  assertNoCaseCollisions(m);
}

export function emptyManifest(): Manifest {
  return { v: 1, files: {} };
}

/** Bytes → the mode a manifest records: executable stays executable. */
export function modeFor(executable: boolean): number {
  return executable ? MODE_EXEC : MODE_FILE;
}

/** Sorted keys at every level, no whitespace: one tree, one byte string, one
 *  id — whichever machine wrote it. */
export function canonicalManifest(m: Manifest): string {
  const files: Record<string, ManifestEntry> = {};
  for (const p of Object.keys(m.files).sort()) {
    const e = m.files[p];
    files[p] = { sha: e.sha, size: e.size, mode: e.mode };
  }
  return JSON.stringify(m.kind ? { v: 1, kind: m.kind, files } : { v: 1, files });
}

export function manifestId(m: Manifest): ManifestId {
  return sha256Hex(canonicalManifest(m));
}

/** The id of a manifest with no files. A revision on one head names this for
 *  the side that head does not own (the workspace head carries no state, the
 *  state head carries no authored files); it is never stored, loadManifest
 *  answers it. */
export const EMPTY_MANIFEST_ID: ManifestId = sha256Hex(JSON.stringify({ v: 1, files: {} }));

/** Parse and validate a manifest read from a store. A manifest that does not
 *  say so cleanly is a broken revision, not an empty one. */
export function parseManifest(text: string): Manifest {
  const raw = JSON.parse(text) as Manifest;
  if (raw?.v !== 1 || typeof raw.files !== "object" || raw.files === null || Array.isArray(raw.files)) {
    throw new Error("not a manifest (v1)");
  }
  if (raw.kind !== undefined && raw.kind !== "run-output") throw new Error("not a manifest (unknown kind)");
  assertManifest(raw);
  return raw;
}

// ---------- object keys ----------
//
// Tenant-first, so a bucket policy can be written per tenant, and nothing in a
// key depends on the workspace's name: renaming a workspace moves no object.

const SEG = /^[A-Za-z0-9._-]{1,128}$/;
function seg(v: string, what: string): string {
  if (!SEG.test(v) || v === "." || v === "..") throw new Error(`illegal ${what} in an object key`);
  return v;
}
export const blobObjectKey = (tenant: string, sha: string) => {
  if (!/^[0-9a-f]{64}$/.test(sha)) throw new Error("expected a sha256");
  return `t/${seg(tenant, "tenant")}/blobs/${sha}`;
};
export const manifestObjectKey = (tenant: string, id: ManifestId) => {
  if (!/^[0-9a-f]{64}$/.test(id)) throw new Error("expected a manifest id");
  return `t/${seg(tenant, "tenant")}/manifests/${id}.json`;
};

// ---------- change sets ----------

/** One path's change, as a writer saw it. `base` is the entryId (sha + mode)
 *  the writer STARTED from (null: the path did not exist) — the fact that makes "disjoint paths
 *  replay, the same path conflicts" decidable without a merge. */
export type PathChange =
  | { op: "put"; base: string | null; sha: string; size: number; mode: number }
  | { op: "delete"; base: string };

export type Changes = Record<string, PathChange>;

/** Apply changes to a manifest, ignoring `base` (the caller decided). */
export function applyChanges(m: Manifest, changes: Changes): Manifest {
  const files = { ...m.files };
  for (const [p, c] of Object.entries(changes)) {
    if (c.op === "delete") delete files[p];
    else files[p] = { sha: c.sha, size: c.size, mode: c.mode };
  }
  return { v: 1, files };
}

/** The changes that turn `from` into `to`, with `from`'s shas as the bases. */
export function diffManifests(from: Manifest, to: Manifest): Changes {
  const out: Changes = {};
  for (const [p, e] of Object.entries(to.files)) {
    const was = from.files[p];
    if (!was) out[p] = { op: "put", base: null, ...e };
    else if (entryId(was) !== entryId(e)) out[p] = { op: "put", base: entryId(was), ...e };
  }
  for (const [p, e] of Object.entries(from.files)) if (!to.files[p]) out[p] = { op: "delete", base: entryId(e) };
  return out;
}

/** The copy a conflicting writer's version is kept as. Deterministic in the
 *  operation id — a retried publish names the same file, so a retry cannot
 *  leave two copies — and next to the original, like today's
 *  `.conflict-<stamp>` copy in applyContainerChanges. 48 bits of the op id's
 *  hash; `attempt` > 0 is the caller stepping aside when that name is already
 *  taken by something else (publish never overwrites an occupied name). */
export function conflictPath(rel: string, opId: string, attempt = 0): string {
  const slash = rel.lastIndexOf("/");
  const dir = slash >= 0 ? rel.slice(0, slash + 1) : "";
  const name = slash >= 0 ? rel.slice(slash + 1) : rel;
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  return `${dir}${stem}.conflict-${sha256Hex(opId).slice(0, 12)}${attempt ? `-${attempt}` : ""}${ext}`;
}
