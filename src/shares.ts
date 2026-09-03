// A public link to one file a workspace produced.
//
// Everything else in this platform is reached with a credential. A share is
// the deliberate exception: an unguessable URL that anyone — or anything —
// can fetch without one. That exists because some jobs are not finished until
// something outside can *fetch the bytes*, and no amount of API politeness
// substitutes for a URL.
//
// The case that forced it: Google Business Profile will not accept image bytes
// for a post. `media:startUpload` takes the upload and returns a dataRef, and
// then creating the post with that dataRef is refused —
// `media[0].source_url is required` — so a generated header image could only
// ever reach a profile through a URL Google could GET for itself. Uploading
// worked; referencing what we uploaded did not.
//
// The design rules, and why each one:
//
//   - The token is the whole credential, so it carries the entropy of one:
//     24 random bytes, not a slug, a hash of the path, or anything derived
//     from the file. A guessable share is a public file store.
//   - Only content is shareable — `storage/`, `files/`, `outputs/`. An agent
//     that can be talked into sharing a path is then confined to what it
//     produced, and can never hand out `memory/`, an agent's prompt, or a
//     credential. The allowlist is the security boundary, not a convention.
//   - The path is re-validated on every read, not only at creation. The
//     manifest is a file on disk; if it is ever edited by hand or restored
//     from elsewhere, a bad entry must still fail closed.
//   - Shares expire by default. A link nobody remembers making is the one
//     that leaks, so the default is 7 days and forever has to be asked for.
//   - Revocation is a tombstone, never a deletion, so a revoked token can
//     never be re-issued to a different file by chance.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { dataRoot } from "./paths.ts";
import { workspaceDir } from "./store.ts";
import { publicUrl } from "./webhook.ts";

export interface Share {
  token: string;
  tenant: string;
  workspace: string;
  /** Workspace-relative, always POSIX-separated. */
  path: string;
  contentType: string;
  createdAt: string;
  /** ISO timestamp, or null for a link that never expires. */
  expiresAt: string | null;
  createdBy: string | null;
  revokedAt: string | null;
}

const sharesFile = () => path.join(dataRoot(), "shares.json");

/** How long a link lives when the caller does not say. */
export const DEFAULT_TTL_DAYS = 7;

/**
 * What may be shared. Content the workspace produced — never its definitions.
 *
 * `agents/`, `tools/`, `skills/`, `memory/`, `knowledge/` and `state/` are all
 * absent on purpose: those are how the workspace *thinks*, and a public URL to
 * an agent's prompt or a memory file is a data leak wearing a feature's
 * clothes. If sharing one of those is ever genuinely wanted, it should be a
 * separate decision with its own name, not a widened regex here.
 */
const SHAREABLE = /^(storage|files|outputs)\//;

export function assertShareablePath(rel: string): string {
  const norm = path.normalize(rel).replaceAll("\\", "/");
  if (path.isAbsolute(norm) || norm.startsWith("..") || norm.split("/").includes("..")) {
    throw new Error(`illegal path: ${rel}`);
  }
  if (!SHAREABLE.test(norm)) {
    throw new Error(
      `not a shareable path: ${rel} — only storage/, files/ and outputs/ can be given a public link`,
    );
  }
  return norm;
}

const TYPES: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".pdf": "application/pdf",
  ".csv": "text/csv; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/plain; charset=utf-8",
  ".mp4": "video/mp4",
  ".zip": "application/zip",
};

/**
 * Markdown and SVG are deliberately not served as their "real" types. An SVG
 * is a script-bearing document and this origin serves other people's files;
 * text/plain and nosniff at the route keep a shared file from becoming a
 * cross-site scripting surface on our own domain.
 */
export function contentTypeFor(rel: string): string {
  const ext = path.extname(rel).toLowerCase();
  if (ext === ".svg") return "text/plain; charset=utf-8";
  return TYPES[ext] ?? "application/octet-stream";
}

function readAll(): Share[] {
  try {
    const raw = JSON.parse(fs.readFileSync(sharesFile(), "utf8"));
    return Array.isArray(raw) ? (raw as Share[]) : [];
  } catch {
    return []; // absent or unreadable is "no shares", never a crash
  }
}

function writeAll(shares: Share[]) {
  const file = sharesFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(shares, null, 2));
  fs.renameSync(tmp, file); // atomic, so a concurrent reader never sees half a manifest
}

export interface CreateShareOptions {
  /** Days until the link stops working. `null` means never. */
  ttlDays?: number | null;
  createdBy?: string;
}

export function createShare(
  tenant: string,
  workspace: string,
  rel: string,
  opts: CreateShareOptions = {},
): Share {
  const norm = assertShareablePath(rel);
  const abs = path.join(workspaceDir(tenant, workspace), norm);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
    throw new Error(`file not found: ${rel}`);
  }

  const ttl = opts.ttlDays === undefined ? DEFAULT_TTL_DAYS : opts.ttlDays;
  const share: Share = {
    token: crypto.randomBytes(24).toString("base64url"),
    tenant,
    workspace,
    path: norm,
    contentType: contentTypeFor(norm),
    createdAt: new Date().toISOString(),
    expiresAt: ttl === null ? null : new Date(Date.now() + ttl * 86_400_000).toISOString(),
    createdBy: opts.createdBy ?? null,
    revokedAt: null,
  };

  // Re-sharing the same file mints a new token rather than reusing the old
  // one: the previous link may already be somewhere it cannot be recalled
  // from, and its expiry is its own.
  writeAll([...readAll(), share]);
  return share;
}

export function isLive(share: Share, now = Date.now()): boolean {
  if (share.revokedAt) return false;
  if (share.expiresAt && Date.parse(share.expiresAt) <= now) return false;
  return true;
}

/**
 * Turn a token into bytes on disk, or null. Null covers every reason equally —
 * unknown, expired, revoked, since-deleted, or a manifest entry that no longer
 * passes the path rule — because the caller is an unauthenticated request and
 * telling it *which* is telling it something it has not earned.
 */
export function resolveShare(token: string): { share: Share; file: string } | null {
  if (!token) return null;
  const share = readAll().find((s) => s.token === token);
  if (!share || !isLive(share)) return null;

  let norm: string;
  try {
    norm = assertShareablePath(share.path); // defence in depth: the manifest is just a file
  } catch {
    return null;
  }
  const file = path.join(workspaceDir(share.tenant, share.workspace), norm);
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return null;
  return { share, file };
}

export function listShares(tenant: string, workspace?: string): Share[] {
  return readAll()
    .filter((s) => s.tenant === tenant && (!workspace || s.workspace === workspace))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** True if this call revoked it; false if it was already revoked or not theirs. */
export function revokeShare(tenant: string, token: string): boolean {
  const shares = readAll();
  const hit = shares.find((s) => s.token === token && s.tenant === tenant);
  if (!hit || hit.revokedAt) return false;
  hit.revokedAt = new Date().toISOString();
  writeAll(shares);
  return true;
}

/**
 * Drop entries that expired long enough ago to be beyond argument. Kept well
 * past expiry so that "why did this link stop working" stays answerable.
 */
export function pruneShares(olderThanDays = 30): number {
  const cutoff = Date.now() - olderThanDays * 86_400_000;
  const shares = readAll();
  const keep = shares.filter((s) => {
    const dead = s.revokedAt ?? s.expiresAt;
    return !dead || Date.parse(dead) > cutoff;
  });
  if (keep.length !== shares.length) writeAll(keep);
  return shares.length - keep.length;
}

/** Anything here is published. The directory name is the whole contract. */
export const PUBLIC_DIR = "storage/public";

/**
 * Where the URLs are written back, deliberately OUTSIDE `storage/public/` so
 * the index of what is public is not itself public.
 */
export const PUBLIC_URLS_FILE = "storage/public-urls.json";

/**
 * Give every file under `storage/public/` a link, and write the map where the
 * next step can read it.
 *
 * This exists because the agent cannot mint its own. A run's sandbox is denied
 * every private network range on purpose — it may reach the internet, never
 * this platform's API — so an agent that needed a public URL had no way to ask
 * for one, and handing sandboxes an API key to fix that would give every step
 * editor rights over the whole account.
 *
 * So the platform does it, at the one moment it can: after a step's files have
 * been copied back to the host, before the next step's sandbox is filled from
 * them. A step writes an image to `storage/public/`, the step ends, and the
 * step after it reads the URL out of a plain JSON file with no network at all.
 *
 * Auto-shares do not expire. A directory called `public` is a deliberate
 * publish, and an asset URL that dies in a week — inside a live Google post,
 * an email, a client's browser tab — is a silent breakage nobody connects back
 * to this. Revocation stays available and is the intended way to take one
 * down.
 */
export function syncPublicShares(
  tenant: string,
  workspace: string,
): { added: string[]; urls: Record<string, string> } {
  const root = workspaceDir(tenant, workspace);
  const dir = path.join(root, PUBLIC_DIR);
  if (!fs.existsSync(dir)) return { added: [], urls: {} };
  // No public origin means no honest URL to write. Say nothing and change
  // nothing rather than filling the manifest with links that resolve nowhere.
  if (!publicUrl()) return { added: [], urls: {} };

  const files: string[] = [];
  const walk = (abs: string) => {
    for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
      const child = path.join(abs, entry.name);
      if (entry.isDirectory()) walk(child);
      else if (entry.isFile()) {
        files.push(path.relative(root, child).replaceAll("\\", "/"));
      }
    }
  };
  walk(dir);

  const live = listShares(tenant, workspace).filter((s) => isLive(s));
  const byPath = new Map(live.map((s) => [s.path, s]));
  const added: string[] = [];
  const urls: Record<string, string> = {};

  for (const rel of files.sort()) {
    let share = byPath.get(rel);
    if (!share) {
      try {
        share = createShare(tenant, workspace, rel, { ttlDays: null, createdBy: "storage/public" });
        added.push(rel);
      } catch {
        continue; // a name the path rule refuses is skipped, never fatal
      }
    }
    urls[rel] = shareUrl(share.token);
  }

  const manifest = path.join(root, PUBLIC_URLS_FILE);
  const next = JSON.stringify(urls, null, 2) + "\n";
  const before = fs.existsSync(manifest) ? fs.readFileSync(manifest, "utf8") : "";
  if (before !== next) {
    fs.mkdirSync(path.dirname(manifest), { recursive: true });
    fs.writeFileSync(manifest, next);
  }
  return { added, urls };
}

/**
 * The absolute URL for a token. `FOLDRUN_PUBLIC_URL` is the origin the outside
 * world reaches this install on — and if it is unset there is no honest answer,
 * so this throws rather than handing back a localhost URL that will be pasted
 * somewhere and quietly fail for everyone but us.
 */
export function shareUrl(token: string): string {
  const base = publicUrl();
  if (!base) {
    throw new Error(
      "FOLDRUN_PUBLIC_URL is not set — a share link needs the origin this install is reachable at from outside",
    );
  }
  return `${base}/s/${token}`;
}
