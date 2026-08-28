// Files: the bytes a workspace holds that are not its source.
//
// Everything else in a workspace is markdown you diff and commit — agents,
// flows, skills, memory. This is the other half: a price list somebody
// uploaded, a PDF an agent produced, a CSV it scraped. Opaque bytes, often
// large, with no frontmatter and nothing to review in a pull request.
//
// Keeping the two apart is the whole design. `saveWorkspace` already refuses
// anything outside WORKSPACE_DIRS, so a deploy cannot carry a 40MB PNG into
// the source tree; and `files/` is not in WORKSPACE_DIRS, so the file tree,
// the graph and the git export never see one. A workspace stays reviewable.
//
//   Agents never learn a storage API. A run gets `files/` materialised into
//   its workspace copy and writes there with plain Read/Write/Bash; what it
//   leaves behind is harvested back into the store afterwards, stamped with
//   the run that made it. The model's mental model is a folder, because the
//   rest of this runtime's is too.
//
// Two drivers behind one interface:
//
//   fs   the default. Blobs under data/<tenant>/files/<workspace>/blobs/.
//        No account, no credentials, no network — the CLI on a laptop gets
//        the same feature the hosted platform has.
//
//   s3   any S3-compatible endpoint; Cloudflare R2 is what the hosted
//        platform runs. Chosen over a self-hosted store for one blunt
//        reason: run pods are denied RFC1918 egress by NetworkPolicy, so an
//        in-cluster MinIO/Garage would need a hole punched in the one rule
//        that makes the sandbox true, while a public S3 endpoint is already
//        reachable and needs no credentials inside the pod — a presigned URL
//        is a URL. R2 specifically because agents and people both download,
//        and R2 does not bill egress.
//
// The index is always local, whichever driver holds the bytes. It is small,
// it is what the dashboard lists, and it is already inside the backup that
// covers data/ — paying an S3 round trip to render a table would be a worse
// version of a file read.
//
// Config (s3 driver):
//
//   FOLDRUN_FILES_DRIVER        fs | s3          default fs
//   FOLDRUN_S3_ENDPOINT         https://<account>.r2.cloudflarestorage.com
//   FOLDRUN_S3_BUCKET           bucket name
//   FOLDRUN_S3_REGION           default auto (R2's region)
//   FOLDRUN_S3_ACCESS_KEY_ID
//   FOLDRUN_S3_SECRET_ACCESS_KEY
//   FOLDRUN_S3_PATH_STYLE       default true — R2 speaks path style
//   FOLDRUN_FILES_MAX_MB        per object, default 512
//   FOLDRUN_FILES_QUOTA_MB      per workspace, default 5120

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { dataRoot, singleWorkspace } from "./paths.ts";
import { assertSafeName, workspaceDir, FILES_DIR, adoptLegacyFilesDir } from "./store.ts";

/** The directory a run sees, and the one this module mirrors into it.
 *  Declared in store.ts, where saveWorkspace also needs it; re-exported so
 *  callers of this module do not need to know that. */
export { FILES_DIR };

export interface FileRecord {
  /** Path under files/, forward-slashed. The primary key: it is also exactly
   *  what the agent typed, which is why the record is keyed by it and not by
   *  a generated id nobody could reach from inside a run. */
  path: string;
  /** Content hash. Blobs are stored under it, so re-uploading the same bytes
   *  under a second name costs nothing and a rename moves no data. */
  sha: string;
  size: number;
  mime: string;
  updatedAt: string;
  /** Provenance: `user:<email>` or `run:<runId>:<agent>`. The reason the
   *  dashboard can answer "which run produced this?" without a join table. */
  by: string;
}

interface Index {
  version: 1;
  files: FileRecord[];
}

// ---------- limits ----------

const maxBytes = () => Number(process.env.FOLDRUN_FILES_MAX_MB ?? 512) * 1024 * 1024;
const quotaBytes = () => Number(process.env.FOLDRUN_FILES_QUOTA_MB ?? 5120) * 1024 * 1024;

// ---------- paths ----------

/**
 * Hosted only. On a laptop `files/` is just a folder in the user's own
 * project — they can see it, open it, and put a PDF in it with Finder — and
 * an index plus a second hardlinked copy under data/ would be bookkeeping
 * for a problem nobody has. The store exists to give many tenants a shared
 * bucket and a provenance trail; one person with one directory has neither
 * question to answer.
 *
 * Everything public here checks this first and does nothing, so the CLI runs
 * the same driveRun the platform does and simply skips the mirror.
 */
export function fileStoreEnabled(): boolean {
  return singleWorkspace() === null;
}

function storeDir(tenant: string, workspace: string) {
  if (!fileStoreEnabled()) {
    throw new Error("the file store is not used in single-workspace mode — files/ is a plain folder");
  }
  assertSafeName(tenant, "tenant");
  assertSafeName(workspace, "workspace");
  // Upgrade an install that predates the rename, the first time the store is
  // resolved. data/<tenant>/files/ becomes data/<tenant>/storage/.
  adoptLegacyFilesDir(path.join(dataRoot(), tenant));
  return path.join(dataRoot(), tenant, FILES_DIR, workspace);
}

function indexPath(tenant: string, workspace: string) {
  return path.join(storeDir(tenant, workspace), "index.json");
}

/** The object key. Tenant-first so a bucket policy can be written per tenant,
 *  and content-addressed so objects are immutable — no cache invalidation,
 *  no partially-overwritten object, and a repeated upload is a no-op. */
export function blobKey(tenant: string, workspace: string, sha: string) {
  return `t/${tenant}/w/${workspace}/blobs/${sha}`;
}

/**
 * Reject anything that isn't a plain relative path under files/.
 *
 * This runs on names that came from an upload form *and* on paths harvested
 * out of a container, so it is the boundary for both directions. `..` is the
 * obvious one; a leading slash and a Windows drive letter are the two that
 * path.normalize alone will happily keep.
 */
export function assertFilePath(rel: string): string {
  const norm = rel.replaceAll("\\", "/").replace(/^\.\//, "");
  if (!norm || norm.length > 400) throw new Error(`illegal file path: ${rel}`);
  if (path.isAbsolute(norm) || /^[a-zA-Z]:/.test(norm)) throw new Error(`illegal file path: ${rel}`);
  if (norm.split("/").some((s) => s === "" || s === "." || s === "..")) {
    throw new Error(`illegal file path: ${rel}`);
  }
  // Control characters survive a normalize and break every header they touch.
  if (/[\u0000-\u001f\u007f]/.test(norm)) throw new Error(`illegal file path: ${rel}`);
  return norm;
}

// ---------- mime ----------

const MIME: Record<string, string> = {
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".csv": "text/csv",
  ".json": "application/json",
  ".md": "text/markdown",
  ".txt": "text/plain",
  ".html": "text/html",
  ".xml": "application/xml",
  ".yaml": "text/yaml",
  ".yml": "text/yaml",
  ".zip": "application/zip",
  ".gz": "application/gzip",
  ".tar": "application/x-tar",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".mp3": "audio/mpeg",
  ".mp4": "video/mp4",
  ".wav": "audio/wav",
};

export function mimeFor(rel: string): string {
  return MIME[path.extname(rel).toLowerCase()] ?? "application/octet-stream";
}

// ---------- the index ----------

export function readIndex(tenant: string, workspace: string): Index {
  if (!fileStoreEnabled()) return { version: 1, files: [] };
  try {
    const raw = JSON.parse(fs.readFileSync(indexPath(tenant, workspace), "utf8")) as Index;
    if (!Array.isArray(raw?.files)) return { version: 1, files: [] };
    return { version: 1, files: raw.files };
  } catch {
    return { version: 1, files: [] };
  }
}

/** Write-and-rename. A half-written index is a workspace that has lost every
 *  file it owns, which is not a state worth risking to save a syscall. */
function writeIndex(tenant: string, workspace: string, index: Index) {
  const file = indexPath(tenant, workspace);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(index, null, 2));
  fs.renameSync(tmp, file);
}

export function listFiles(tenant: string, workspace: string): FileRecord[] {
  return readIndex(tenant, workspace).files.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function getFile(tenant: string, workspace: string, rel: string): FileRecord | null {
  const norm = assertFilePath(rel);
  return readIndex(tenant, workspace).files.find((f) => f.path === norm) ?? null;
}

export function usedBytes(tenant: string, workspace: string): number {
  // Distinct blobs, not records: two names for identical bytes occupy one
  // object, and billing the tenant twice for it would be a lie.
  const seen = new Map<string, number>();
  for (const f of readIndex(tenant, workspace).files) seen.set(f.sha, f.size);
  return [...seen.values()].reduce((a, b) => a + b, 0);
}

// ---------- the driver interface ----------

export interface Driver {
  kind: "fs" | "s3";
  put(key: string, body: Buffer, mime: string): Promise<void>;
  get(key: string): Promise<Buffer>;
  has(key: string): Promise<boolean>;
  remove(key: string): Promise<void>;
  /** A URL a browser can GET directly, or null when the driver has no such
   *  thing (fs) and the route must stream the bytes itself. */
  presignGet(key: string, filename: string, mime: string, ttlSec?: number): Promise<string | null>;
  /** A URL a browser can PUT directly to, so upload bytes never transit the
   *  dashboard process. Null on fs, where the route takes the body. */
  presignPut(key: string, mime: string, ttlSec?: number): Promise<string | null>;
}

// ---------- fs driver ----------

/** Where the fs driver keeps a blob. Exported because the run mirror
 *  hardlinks straight to it rather than reading and rewriting the bytes. */
export function blobPath(tenant: string, workspace: string, sha: string) {
  return path.join(storeDir(tenant, workspace), "blobs", sha);
}

function fsDriver(tenant: string, workspace: string): Driver {
  const blobs = path.join(storeDir(tenant, workspace), "blobs");
  const at = (key: string) => path.join(blobs, key.split("/").pop()!);
  return {
    kind: "fs",
    async put(key, body) {
      fs.mkdirSync(blobs, { recursive: true });
      const target = at(key);
      // Content-addressed: identical bytes are already there. Skipping the
      // write also keeps mtime stable, which the hardlink mirror relies on.
      if (fs.existsSync(target)) return;
      const tmp = `${target}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, body);
      fs.renameSync(tmp, target);
    },
    async get(key) {
      return fs.readFileSync(at(key));
    },
    async has(key) {
      return fs.existsSync(at(key));
    },
    async remove(key) {
      fs.rmSync(at(key), { force: true });
    },
    async presignGet() {
      return null;
    },
    async presignPut() {
      return null;
    },
  };
}

// ---------- s3 driver ----------

interface S3Config {
  endpoint: string;
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  pathStyle: boolean;
}

export function s3Config(): S3Config | null {
  const endpoint = process.env.FOLDRUN_S3_ENDPOINT;
  const bucket = process.env.FOLDRUN_S3_BUCKET;
  const accessKeyId = process.env.FOLDRUN_S3_ACCESS_KEY_ID;
  const secretAccessKey = process.env.FOLDRUN_S3_SECRET_ACCESS_KEY;
  if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) return null;
  return {
    endpoint: endpoint.replace(/\/+$/, ""),
    bucket,
    // R2 has one region and calls it `auto`. AWS callers set their own.
    region: process.env.FOLDRUN_S3_REGION ?? "auto",
    accessKeyId,
    secretAccessKey,
    pathStyle: process.env.FOLDRUN_S3_PATH_STYLE !== "false",
  };
}

const sha256 = (b: crypto.BinaryLike) => crypto.createHash("sha256").update(b).digest("hex");
const hmac = (key: crypto.BinaryLike, data: string) =>
  crypto.createHmac("sha256", key).update(data, "utf8").digest();

/** RFC 3986. encodeURIComponent leaves !'()* alone and SigV4 does not. */
function uriEncode(s: string, keepSlash = false) {
  const out = encodeURIComponent(s).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return keepSlash ? out.replaceAll("%2F", "/") : out;
}

function stamps(now: Date) {
  const amzDate = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  return { amzDate, dateStamp: amzDate.slice(0, 8) };
}

function signingKey(cfg: S3Config, dateStamp: string) {
  const kDate = hmac(`AWS4${cfg.secretAccessKey}`, dateStamp);
  const kRegion = hmac(kDate, cfg.region);
  const kService = hmac(kRegion, "s3");
  return hmac(kService, "aws4_request");
}

/** Where a key lives, split into the host and the canonical path SigV4 signs. */
function target(cfg: S3Config, key: string) {
  const url = new URL(cfg.endpoint);
  const encoded = uriEncode(key, true);
  if (cfg.pathStyle) {
    return { host: url.host, origin: url.origin, canonicalUri: `/${cfg.bucket}/${encoded}` };
  }
  const host = `${cfg.bucket}.${url.host}`;
  return { host, origin: `${url.protocol}//${host}`, canonicalUri: `/${encoded}` };
}

/**
 * A presigned URL — SigV4 in the query string, so the browser (or a run pod)
 * needs no credentials and no SDK, just the link.
 *
 * `extraQuery` carries the response-header overrides. That is where the one
 * security property that matters here comes from: every download is signed
 * with `response-content-disposition: attachment`, so an HTML file an agent
 * wrote can never render as a page on any origin. Without it, "the agent
 * produced a report.html" and "stored XSS" are the same event.
 */
function presign(
  cfg: S3Config,
  method: "GET" | "PUT",
  key: string,
  ttlSec: number,
  extraQuery: Record<string, string> = {},
  now = new Date(),
): string {
  const { host, origin, canonicalUri } = target(cfg, key);
  const { amzDate, dateStamp } = stamps(now);
  const scope = `${dateStamp}/${cfg.region}/s3/aws4_request`;

  const query: Record<string, string> = {
    ...extraQuery,
    "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
    "X-Amz-Credential": `${cfg.accessKeyId}/${scope}`,
    "X-Amz-Date": amzDate,
    "X-Amz-Expires": String(ttlSec),
    "X-Amz-SignedHeaders": "host",
  };
  const canonicalQuery = Object.keys(query)
    .sort()
    .map((k) => `${uriEncode(k)}=${uriEncode(query[k])}`)
    .join("&");

  const canonicalRequest = [
    method,
    canonicalUri,
    canonicalQuery,
    `host:${host}\n`,
    "host",
    "UNSIGNED-PAYLOAD",
  ].join("\n");

  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    scope,
    sha256(canonicalRequest),
  ].join("\n");

  const signature = hmac(signingKey(cfg, dateStamp), stringToSign).toString("hex");
  return `${origin}${canonicalUri}?${canonicalQuery}&X-Amz-Signature=${signature}`;
}

/** The header-signed form, for the calls the platform itself makes. */
async function s3Request(
  cfg: S3Config,
  method: "GET" | "PUT" | "DELETE" | "HEAD",
  key: string,
  body?: Buffer,
  mime?: string,
): Promise<Response> {
  const { host, origin, canonicalUri } = target(cfg, key);
  const { amzDate, dateStamp } = stamps(new Date());
  const scope = `${dateStamp}/${cfg.region}/s3/aws4_request`;
  const payloadHash = sha256(body ?? Buffer.alloc(0));

  const headers: Record<string, string> = {
    host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
    ...(mime ? { "content-type": mime } : {}),
  };
  const signed = Object.keys(headers).sort();
  const canonicalHeaders = signed.map((h) => `${h}:${headers[h].trim()}\n`).join("");
  const signedHeaders = signed.join(";");

  const canonicalRequest = [
    method,
    canonicalUri,
    "",
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");

  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256(canonicalRequest)].join("\n");
  const signature = hmac(signingKey(cfg, dateStamp), stringToSign).toString("hex");

  const res = await fetch(`${origin}${canonicalUri}`, {
    method,
    body: body as BodyInit | undefined,
    headers: {
      ...headers,
      Authorization:
        `AWS4-HMAC-SHA256 Credential=${cfg.accessKeyId}/${scope}, ` +
        `SignedHeaders=${signedHeaders}, Signature=${signature}`,
    },
  });
  return res;
}

function s3Driver(cfg: S3Config): Driver {
  const fail = async (res: Response, what: string) => {
    throw new Error(`s3 ${what} failed: ${res.status} ${(await res.text()).slice(0, 300)}`);
  };
  return {
    kind: "s3",
    async put(key, body, mime) {
      const res = await s3Request(cfg, "PUT", key, body, mime);
      if (!res.ok) await fail(res, "put");
    },
    async get(key) {
      const res = await s3Request(cfg, "GET", key);
      if (!res.ok) await fail(res, "get");
      return Buffer.from(await res.arrayBuffer());
    },
    async has(key) {
      const res = await s3Request(cfg, "HEAD", key);
      return res.ok;
    },
    async remove(key) {
      const res = await s3Request(cfg, "DELETE", key);
      // 404 on delete is the desired end state, not an error.
      if (!res.ok && res.status !== 404) await fail(res, "delete");
    },
    async presignGet(key, filename, mime, ttlSec = 300) {
      return presign(cfg, "GET", key, ttlSec, {
        // Never inline. See presign()'s note — this is the XSS boundary.
        "response-content-disposition": `attachment; filename="${filename.replace(/["\\]/g, "")}"`,
        "response-content-type": mime,
      });
    },
    async presignPut(key, _mime, ttlSec = 600) {
      return presign(cfg, "PUT", key, ttlSec);
    },
  };
}

/**
 * The driver in force. `fs` unless S3 is both selected and configured —
 * a half-set environment falls back rather than failing at the first upload,
 * because a dashboard that boots and stores locally beats one that 500s.
 */
export function driverFor(tenant: string, workspace: string): Driver {
  if (process.env.FOLDRUN_FILES_DRIVER === "s3") {
    const cfg = s3Config();
    if (cfg) return s3Driver(cfg);
  }
  return fsDriver(tenant, workspace);
}

// ---------- the store ----------

/**
 * Record bytes the platform already holds. Used by the upload route on the fs
 * driver and by the run harvest on both.
 */
export async function putFile(
  tenant: string,
  workspace: string,
  rel: string,
  body: Buffer,
  by: string,
): Promise<FileRecord> {
  const norm = assertFilePath(rel);
  if (body.length > maxBytes()) {
    throw new Error(`${norm} is ${Math.round(body.length / 1e6)}MB — the limit is ${maxBytes() / 1e6}MB`);
  }
  const sha = sha256(body);
  const index = readIndex(tenant, workspace);
  const previous = index.files.find((f) => f.path === norm);
  if (previous?.sha === sha) return previous; // same bytes, same name: nothing happened

  const projected = usedBytes(tenant, workspace) - (previous?.size ?? 0) + body.length;
  if (projected > quotaBytes()) {
    throw new Error(`workspace file quota exceeded (${quotaBytes() / 1e6}MB)`);
  }

  const driver = driverFor(tenant, workspace);
  await driver.put(blobKey(tenant, workspace, sha), body, mimeFor(norm));

  const record: FileRecord = {
    path: norm,
    sha,
    size: body.length,
    mime: mimeFor(norm),
    updatedAt: new Date().toISOString(),
    by,
  };
  writeIndex(tenant, workspace, {
    version: 1,
    files: [...index.files.filter((f) => f.path !== norm), record],
  });
  if (previous) await collect(tenant, workspace, previous.sha);
  return record;
}

/** Register bytes a browser PUT straight to the bucket. Same bookkeeping as
 *  putFile, minus the bytes — the platform never saw them. */
export async function registerUpload(
  tenant: string,
  workspace: string,
  rel: string,
  sha: string,
  size: number,
  by: string,
): Promise<FileRecord> {
  const norm = assertFilePath(rel);
  if (!/^[0-9a-f]{64}$/.test(sha)) throw new Error("expected a sha256");
  const driver = driverFor(tenant, workspace);
  // Trust nothing the browser said about whether the PUT landed.
  if (!(await driver.has(blobKey(tenant, workspace, sha)))) {
    throw new Error("no object at that key — the upload did not complete");
  }
  const index = readIndex(tenant, workspace);
  const previous = index.files.find((f) => f.path === norm);
  const record: FileRecord = {
    path: norm,
    sha,
    size,
    mime: mimeFor(norm),
    updatedAt: new Date().toISOString(),
    by,
  };
  writeIndex(tenant, workspace, {
    version: 1,
    files: [...index.files.filter((f) => f.path !== norm), record],
  });
  if (previous && previous.sha !== sha) await collect(tenant, workspace, previous.sha);
  return record;
}

export async function readFileBytes(
  tenant: string,
  workspace: string,
  rel: string,
): Promise<Buffer | null> {
  const record = getFile(tenant, workspace, rel);
  if (!record) return null;
  return driverFor(tenant, workspace).get(blobKey(tenant, workspace, record.sha));
}

export async function deleteFile(tenant: string, workspace: string, rel: string): Promise<boolean> {
  const norm = assertFilePath(rel);
  const index = readIndex(tenant, workspace);
  const record = index.files.find((f) => f.path === norm);
  if (!record) return false;
  writeIndex(tenant, workspace, { version: 1, files: index.files.filter((f) => f.path !== norm) });
  await collect(tenant, workspace, record.sha);
  // The run mirror is a cache of the index, so it follows the index.
  fs.rmSync(path.join(workspaceDir(tenant, workspace), FILES_DIR, norm), { force: true });
  return true;
}

/** Drop a blob once the last record naming it is gone. */
async function collect(tenant: string, workspace: string, sha: string) {
  if (readIndex(tenant, workspace).files.some((f) => f.sha === sha)) return;
  try {
    await driverFor(tenant, workspace).remove(blobKey(tenant, workspace, sha));
  } catch {
    // A leaked blob costs storage; a delete that throws mid-request costs the
    // user their action. The index is already correct, so this is the safe
    // side to fail on.
  }
}

/** A link the browser can follow, or null when the route must stream it. */
export async function downloadUrl(
  tenant: string,
  workspace: string,
  record: FileRecord,
): Promise<string | null> {
  return driverFor(tenant, workspace).presignGet(
    blobKey(tenant, workspace, record.sha),
    path.basename(record.path),
    record.mime,
  );
}

/** A link the browser can PUT to, plus the key it will land at. Null on fs. */
export async function uploadUrl(
  tenant: string,
  workspace: string,
  rel: string,
  sha: string,
): Promise<string | null> {
  assertFilePath(rel);
  if (!/^[0-9a-f]{64}$/.test(sha)) throw new Error("expected a sha256");
  return driverFor(tenant, workspace).presignPut(blobKey(tenant, workspace, sha), mimeFor(rel));
}

// ---------- the run mirror ----------

/**
 * Put the workspace's files on disk under `<workspace>/files/`, where a run
 * copies them into its container like any other directory.
 *
 * On the fs driver this is a hardlink: the blob and the mirror are the same
 * inode, so a 2GB corpus costs 2GB once, not twice. On s3 it is a download,
 * and the mirror is a cache — a second run over the same files fetches
 * nothing.
 *
 * Not pruned. A workspace that churns hundreds of large files will hold a
 * copy of each on the PVC until someone deletes the record, and the quota is
 * what stops that becoming a full disk. Pruning wants an LRU that knows no
 * run is currently reading the file it is about to remove, and that bookkeeping
 * is worth writing when a workspace actually outgrows its quota, not before.
 */
export async function materializeFiles(tenant: string, workspace: string): Promise<string[]> {
  if (!fileStoreEnabled()) return [];
  adoptLegacyFilesDir(workspaceDir(tenant, workspace));
  const root = path.join(workspaceDir(tenant, workspace), FILES_DIR);
  const driver = driverFor(tenant, workspace);
  const brought: string[] = [];

  for (const record of readIndex(tenant, workspace).files) {
    const target = path.join(root, record.path);
    try {
      const stat = fs.statSync(target);
      if (stat.size === record.size) continue; // already mirrored
    } catch {
      // not there yet
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    if (driver.kind === "fs") {
      const blob = blobPath(tenant, workspace, record.sha);
      fs.rmSync(target, { force: true });
      try {
        fs.linkSync(blob, target);
      } catch {
        fs.copyFileSync(blob, target); // different filesystem, or a hardlink limit
      }
    } else {
      fs.writeFileSync(target, await driver.get(blobKey(tenant, workspace, record.sha)));
    }
    brought.push(record.path);
  }
  fs.mkdirSync(root, { recursive: true });
  return brought;
}

/**
 * Take what the run left in `files/` back into the store, stamped with the
 * run that wrote it.
 *
 * Compares against the index rather than a pre-run snapshot: the mirror is
 * derived from the index, so anything on disk that the index does not already
 * describe with the same size and hash is, by construction, new work.
 */
export async function harvestFiles(
  tenant: string,
  workspace: string,
  by: string,
): Promise<{ saved: string[]; errors: string[] }> {
  if (!fileStoreEnabled()) return { saved: [], errors: [] };
  adoptLegacyFilesDir(workspaceDir(tenant, workspace));
  const root = path.join(workspaceDir(tenant, workspace), FILES_DIR);
  if (!fs.existsSync(root)) return { saved: [], errors: [] };

  const known = new Map(readIndex(tenant, workspace).files.map((f) => [f.path, f]));
  const saved: string[] = [];
  const errors: string[] = [];

  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(abs);
        continue;
      }
      if (!entry.isFile()) continue; // a symlink out of the tree is not a file
      out.push(abs);
    }
  };
  walk(root);

  for (const abs of out) {
    const rel = path.relative(root, abs).replaceAll("\\", "/");
    try {
      const norm = assertFilePath(rel);
      const stat = fs.statSync(abs);
      const previous = known.get(norm);
      if (previous && previous.size === stat.size) {
        // Same size is not proof, so confirm by hash before skipping a write.
        if (sha256(fs.readFileSync(abs)) === previous.sha) continue;
      }
      await putFile(tenant, workspace, norm, fs.readFileSync(abs), by);
      saved.push(norm);
    } catch (err) {
      errors.push(`${rel}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { saved, errors };
}
