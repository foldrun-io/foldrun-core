// Reading a .tar.gz, so a deploy can come from a GitHub tarball.
//
// `GET /repos/{owner}/{repo}/tarball/{sha}` is one HTTP call and needs no git
// binary, no clone, and no working copy on the server — which is the whole
// reason a markdown workspace can deploy from a webhook in a few hundred
// milliseconds. What it returns is a tar.gz, and Node has gzip but not tar.
//
// Deliberately dependency-free, for the same reason the cron parser is: tar is
// 512-byte blocks with an octal size field, and a reader is shorter than the
// argument about which library to add.

import zlib from "node:zlib";

const BLOCK = 512;

export interface TarEntry {
  path: string;
  content: Buffer;
}

const str = (b: Buffer, off: number, len: number) => {
  const raw = b.subarray(off, off + len);
  const end = raw.indexOf(0);
  return raw.subarray(0, end === -1 ? raw.length : end).toString("utf8");
};

// Sizes are octal, space- or NUL-padded. GNU also writes base-256 for large
// files, flagged by the high bit — irrelevant for markdown, but a silent
// misparse would be worse than a clear refusal.
function size(b: Buffer, off: number): number {
  if (b[off] & 0x80) throw new Error("tar: base-256 size field is not supported");
  const raw = str(b, off, 12).trim();
  return raw ? parseInt(raw, 8) : 0;
}

/**
 * Every regular file in a gzipped tarball.
 *
 * Directories, symlinks, and pax/global headers are skipped: a workspace is
 * files, and following a link out of the archive is exactly the thing a deploy
 * from an untrusted repository must not do.
 */
export function readTarGz(gz: Buffer): TarEntry[] {
  const buf = zlib.gunzipSync(gz);
  const out: TarEntry[] = [];
  let longName: string | null = null;

  for (let off = 0; off + BLOCK <= buf.length; ) {
    const header = buf.subarray(off, off + BLOCK);
    // Two consecutive zero blocks end the archive; one is enough to stop.
    if (header.every((b) => b === 0)) break;

    const name = str(header, 0, 100);
    const bytes = size(header, 124);
    const type = String.fromCharCode(header[156]) || "0";
    const prefix = str(header, 345, 155);
    off += BLOCK;

    const body = buf.subarray(off, off + bytes);
    off += Math.ceil(bytes / BLOCK) * BLOCK;

    // GNU long name: the next header's name lives in this entry's body.
    if (type === "L") {
      longName = body.toString("utf8").replace(/\0+$/, "");
      continue;
    }
    if (type !== "0" && type !== "\0") {
      longName = null;
      continue;
    }

    const full = longName ?? (prefix ? `${prefix}/${name}` : name);
    longName = null;
    if (full) out.push({ path: full, content: Buffer.from(body) });
  }

  return out;
}

/**
 * Drop the single wrapper directory an archive is rooted at.
 *
 * GitHub tarballs are rooted at `owner-repo-<sha>/`, which is not part of
 * anyone's workspace. Stripped only when *every* entry shares one first
 * segment, so an archive that is already flat is left alone.
 */
export function stripRoot(entries: TarEntry[]): TarEntry[] {
  if (entries.length === 0) return entries;
  const first = entries[0].path.split("/")[0];
  if (!entries.every((e) => e.path.split("/")[0] === first && e.path.includes("/"))) {
    return entries;
  }
  return entries.map((e) => ({ ...e, path: e.path.slice(first.length + 1) }));
}

/**
 * Read a tarball as the file list a deploy ships.
 *
 * `subdir` picks a workspace living inside a larger repository — the common
 * case, since a repo usually holds more than one thing.
 */
export function filesFromTarball(gz: Buffer, subdir = ""): { path: string; content: string }[] {
  const prefix = subdir.replace(/^\/+|\/+$/g, "");
  const out: { path: string; content: string }[] = [];

  for (const entry of stripRoot(readTarGz(gz))) {
    let rel = entry.path;
    if (prefix) {
      if (!rel.startsWith(`${prefix}/`)) continue;
      rel = rel.slice(prefix.length + 1);
    }
    // A tarball is untrusted input: an entry can name anything at all, and
    // `../` in an archive is the oldest way to write outside the destination.
    if (rel.split("/").includes("..") || rel.startsWith("/")) continue;
    // AppleDouble sidecars. macOS `tar` writes a `._name` beside every file to
    // carry metadata no other system wants; they are not part of anyone's
    // workspace, and letting one through means a deploy rejected for shipping
    // a file the author never wrote.
    if ((rel.split("/").pop() ?? "").startsWith("._")) continue;
    out.push({ path: rel, content: entry.content.toString("utf8") });
  }

  return out;
}
