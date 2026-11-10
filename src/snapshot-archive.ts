// Snapshot archives (Part B3, 10 Nov 2026): a folder from the user's machine,
// as one gzipped tar, for an agent on foldrun to work on.
//
// One writer and one strict reader, here, so the CLI (which packs) and the
// platform (which unpacks what a stranger sent) hold the same rules:
//
//   - only regular files and directories — no links, devices, FIFOs, sparse
//     files, PAX or GNU long-name headers (each a way to make a path mean
//     something other than it says);
//   - every path relative, `/`-separated, no `.`/`..`/empty segment, no
//     backslash, NUL or control character, ≤ 255 bytes and ≤ 32 levels;
//   - no path twice, also when only its case differs, and no file where a
//     directory is (`a` and `a/b`);
//   - limits on file count, one file's size and the whole, enforced while
//     reading — before a byte past them is held;
//   - header checksums verified; nothing after the end-of-archive blocks;
//   - modes are 0644 or 0755 (the owner's exec bit), nothing else kept.
//
// The writer is deterministic: entries sorted, mtime 0, uid/gid 0, no names
// — the same folder is the same bytes, so a snapshot is known by its hash.

import crypto from "node:crypto";
import zlib from "node:zlib";

export interface SnapshotEntry {
  /** Relative, `/`-separated. */
  path: string;
  /** 0o644 or 0o755. */
  mode: number;
  content: Buffer;
}

export interface SnapshotLimits {
  maxFiles: number;
  maxFileBytes: number;
  maxTotalBytes: number;
  maxCompressedBytes: number;
}

export const SNAPSHOT_LIMITS: SnapshotLimits = {
  maxFiles: 20_000,
  maxFileBytes: 10 * 1024 * 1024,
  maxTotalBytes: 200 * 1024 * 1024,
  maxCompressedBytes: 50 * 1024 * 1024,
};

const MAX_PATH = 255;
const MAX_DEPTH = 32;

/** Why an archive was refused, in words a person can act on. */
export class SnapshotRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SnapshotRefused";
  }
}

/** The path rules, for the packer to check before it packs, and the reader after. */
export function snapshotPathProblem(p: string): string | null {
  if (!p) return "an empty path";
  if (Buffer.byteLength(p) > MAX_PATH) return `a path longer than ${MAX_PATH} bytes`;
  if (p.startsWith("/")) return "an absolute path";
  if (/[\u0000-\u001f\u007f\\]/.test(p)) return "a backslash or control character in a path";
  const parts = p.split("/");
  if (parts.length > MAX_DEPTH) return `a path deeper than ${MAX_DEPTH} folders`;
  if (parts.some((s) => s === "" || s === "." || s === "..")) return "an empty, `.` or `..` segment";
  return null;
}

/**
 * The set of paths in one archive, with every clash rule in one place for the
 * writer and the reader alike (Codex: the writer packed what the reader then
 * refused). Case-insensitive throughout: `A` and `a/b` cannot both exist on
 * a case-insensitive filesystem, so neither may be here.
 */
class PathSet {
  private kinds = new Map<string, "file" | "dir">();
  private parents = new Set<string>();
  add(p: string, isDir: boolean): void {
    const key = p.toLowerCase();
    if (this.kinds.has(key)) throw new SnapshotRefused(`${p}: there twice (paths may not differ only by case)`);
    const segs = key.split("/");
    for (let i = 1; i < segs.length; i++) {
      const parent = segs.slice(0, i).join("/");
      if (this.kinds.get(parent) === "file") throw new SnapshotRefused(`${p}: inside ${p.split("/").slice(0, i).join("/")}, which is a file`);
    }
    if (!isDir && this.parents.has(key)) throw new SnapshotRefused(`${p}: a file where another entry makes it a folder`);
    this.kinds.set(key, isDir ? "dir" : "file");
    for (let i = 1; i < segs.length; i++) this.parents.add(segs.slice(0, i).join("/"));
  }
}

// ------------------------------------------------------------------ writer

function octal(n: number, width: number): string {
  return n.toString(8).padStart(width - 1, "0") + "\0";
}

function header(path: string, size: number, mode: number, type: "0" | "5"): Buffer {
  const h = Buffer.alloc(512, 0);
  // ustar: name (100) and prefix (155); split at a "/" when it is long.
  let name = path;
  let prefix = "";
  if (Buffer.byteLength(name) > 100) {
    const cut = path.lastIndexOf("/", path.length - 1);
    let at = -1;
    for (let i = cut; i > 0; i = path.lastIndexOf("/", i - 1)) {
      if (Buffer.byteLength(path.slice(i + 1)) <= 100 && Buffer.byteLength(path.slice(0, i)) <= 155) {
        at = i;
        break;
      }
    }
    if (at < 0) throw new SnapshotRefused(`${path}: too long to store`);
    prefix = path.slice(0, at);
    name = path.slice(at + 1);
  }
  h.write(name, 0, 100, "utf8");
  h.write(octal(mode, 8), 100, 8, "ascii");
  h.write(octal(0, 8), 108, 8, "ascii"); // uid
  h.write(octal(0, 8), 116, 8, "ascii"); // gid
  h.write(octal(size, 12), 124, 12, "ascii");
  h.write(octal(0, 12), 136, 12, "ascii"); // mtime
  h.write("        ", 148, 8, "ascii"); // checksum placeholder
  h.write(type, 156, 1, "ascii");
  h.write("ustar\u000000", 257, 8, "ascii");
  h.write(prefix, 345, 155, "utf8");
  let sum = 0;
  for (const b of h) sum += b;
  h.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, 8, "ascii");
  return h;
}

/** A deterministic gzipped tar of these files (directories are implied). */
export function packSnapshot(entries: SnapshotEntry[], limits: SnapshotLimits = SNAPSHOT_LIMITS): { archive: Buffer; sha256: string; files: number; bytes: number } {
  if (entries.length > limits.maxFiles) throw new SnapshotRefused(`${entries.length} files — the most is ${limits.maxFiles}`);
  const sorted = [...entries].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const parts: Buffer[] = [];
  let total = 0;
  const paths = new PathSet();
  for (const e of sorted) {
    const problem = snapshotPathProblem(e.path);
    if (problem) throw new SnapshotRefused(`${e.path}: ${problem}`);
    paths.add(e.path, false);
    if (e.content.length > limits.maxFileBytes) throw new SnapshotRefused(`${e.path}: ${e.content.length} bytes — the most for one file is ${limits.maxFileBytes}`);
    total += e.content.length;
    if (total > limits.maxTotalBytes) throw new SnapshotRefused(`more than ${limits.maxTotalBytes} bytes in all`);
    parts.push(header(e.path, e.content.length, e.mode === 0o755 ? 0o755 : 0o644, "0"));
    parts.push(e.content);
    const pad = (512 - (e.content.length % 512)) % 512;
    if (pad) parts.push(Buffer.alloc(pad, 0));
  }
  parts.push(Buffer.alloc(1024, 0));
  const archive = zlib.gzipSync(Buffer.concat(parts), { level: 9, mtime: 0 } as zlib.ZlibOptions);
  // gzip's header carries an mtime and an OS byte; both fixed, so the bytes are the folder's alone.
  archive.writeUInt32LE(0, 4);
  archive[9] = 255;
  if (archive.length > limits.maxCompressedBytes) throw new SnapshotRefused(`${archive.length} bytes compressed — the most is ${limits.maxCompressedBytes}`);
  return { archive, sha256: crypto.createHash("sha256").update(archive).digest("hex"), files: sorted.length, bytes: total };
}

// ------------------------------------------------------------------ reader

function readString(b: Buffer, start: number, len: number): string {
  const s = b.subarray(start, start + len);
  const nul = s.indexOf(0);
  return s.subarray(0, nul < 0 ? len : nul).toString("utf8");
}

function readOctal(b: Buffer, start: number, len: number, what: string): number {
  const raw = readString(b, start, len).trim();
  if (raw === "") return 0;
  if (!/^[0-7]+$/.test(raw)) throw new SnapshotRefused(`a header's ${what} is not a number`);
  const n = parseInt(raw, 8);
  if (!Number.isSafeInteger(n)) throw new SnapshotRefused(`a header's ${what} is out of range`);
  return n;
}

/**
 * Unpack an archive a stranger sent, under every rule above. Throws
 * SnapshotRefused naming the first thing wrong; nothing is written anywhere —
 * the caller gets the entries to store.
 */
export function unpackSnapshot(archive: Buffer, limits: SnapshotLimits = SNAPSHOT_LIMITS): { entries: SnapshotEntry[]; sha256: string; bytes: number } {
  if (archive.length > limits.maxCompressedBytes) throw new SnapshotRefused(`${archive.length} bytes compressed — the most is ${limits.maxCompressedBytes}`);
  let tar: Buffer;
  try {
    // The tar is at most the files, their headers and padding: past that, a bomb.
    const ceiling = limits.maxTotalBytes + (limits.maxFiles + 2) * 1024 + 1024;
    tar = zlib.gunzipSync(archive, { maxOutputLength: ceiling });
  } catch (err) {
    const code = (err as { code?: string }).code;
    throw new SnapshotRefused(code === "ERR_BUFFER_TOO_LARGE" || /larger than/i.test(String((err as Error).message)) ? `it unpacks past ${limits.maxTotalBytes} bytes` : "it is not a gzip archive");
  }
  const entries: SnapshotEntry[] = [];
  const paths = new PathSet();
  // Every entry counts against maxFiles, folders too, before its path is
  // recorded: an archive of folders alone would otherwise pass every limit
  // and fill memory with paths (Codex). Our writer emits no folder entries.
  let count = 0;
  let total = 0;
  let off = 0;
  let ended = false;
  while (off + 512 <= tar.length) {
    const h = tar.subarray(off, off + 512);
    if (h.every((x) => x === 0)) {
      const next = tar.subarray(off + 512, off + 1024);
      if (next.length === 512 && next.every((x) => x === 0)) {
        ended = true;
        off += 1024;
        break;
      }
      throw new SnapshotRefused("a lone empty block before the end");
    }
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : h[i]!;
    if (readOctal(h, 148, 8, "checksum") !== sum) throw new SnapshotRefused("a header's checksum is wrong");
    if (readString(h, 257, 6) !== "ustar") throw new SnapshotRefused("not a ustar archive");
    const type = String.fromCharCode(h[156]!);
    const name = readString(h, 0, 100);
    const prefix = readString(h, 345, 155);
    const p0 = prefix ? `${prefix}/${name}` : name;
    const isDir = type === "5";
    const p = isDir ? p0.replace(/\/+$/, "") : p0;
    if (type !== "0" && type !== "\0" && !isDir) {
      const what = { "1": "a hard link", "2": "a symbolic link", "3": "a character device", "4": "a block device", "6": "a FIFO", x: "an extended (PAX) header", g: "a global PAX header", L: "a GNU long name", K: "a GNU long link", S: "a sparse file" }[type] ?? `an entry of type ${JSON.stringify(type)}`;
      throw new SnapshotRefused(`${p || "(unnamed)"}: ${what} — only plain files and folders`);
    }
    const problem = snapshotPathProblem(p);
    if (problem) throw new SnapshotRefused(`${p}: ${problem}`);
    const size = readOctal(h, 124, 12, "size");
    if (isDir && size !== 0) throw new SnapshotRefused(`${p}: a folder with a size`);
    if (size > limits.maxFileBytes) throw new SnapshotRefused(`${p}: ${size} bytes — the most for one file is ${limits.maxFileBytes}`);
    if (++count > limits.maxFiles) throw new SnapshotRefused(`more than ${limits.maxFiles} entries`);
    paths.add(p, isDir);
    off += 512;
    if (!isDir) {
      if (off + size > tar.length) throw new SnapshotRefused(`${p}: cut short`);
      total += size;
      if (total > limits.maxTotalBytes) throw new SnapshotRefused(`more than ${limits.maxTotalBytes} bytes in all`);
      if (entries.length + 1 > limits.maxFiles) throw new SnapshotRefused(`more than ${limits.maxFiles} files`);
      const mode = readOctal(h, 100, 8, "mode");
      entries.push({ path: p, mode: mode & 0o100 ? 0o755 : 0o644, content: Buffer.from(tar.subarray(off, off + size)) });
      off += size + ((512 - (size % 512)) % 512);
    }
  }
  if (!ended) throw new SnapshotRefused("no end-of-archive marker");
  if (tar.subarray(off).some((x) => x !== 0)) throw new SnapshotRefused("data after the end of the archive");
  return { entries, sha256: crypto.createHash("sha256").update(archive).digest("hex"), bytes: total };
}
