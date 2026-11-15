/**
 * Reading a file a sandbox, an agent or a customer's upload could have
 * touched — without following a link it swapped in after we looked.
 *
 * The walkers (run outputs, copy-back, folder scan, import) list a tree with
 * lstat, which is honest at that moment. The read comes later, by path, and a
 * path is looked up again: a regular file replaced by a symlink to /proc/self/environ
 * or another tenant's file in between was followed and its bytes stored or
 * served; one replaced by a FIFO blocked the whole worker in a synchronous
 * read. So the read opens with O_NOFOLLOW (a link at the last step is ELOOP)
 * and O_NONBLOCK (a FIFO opens at once instead of waiting for a writer), asks
 * the OPEN file what it is (fstat: a regular file, within the size cap, the
 * same device and inode the walk saw, when it knows them) and reads from that
 * descriptor, so what was checked is what is read.
 *
 * `root`: a directory ON THE WAY can also be swapped for a link (the open only
 * refuses a link at the last step). With a root given, after the open the
 * file's real path must be inside the real root and be the very inode that was
 * opened. That narrows the window to an attacker who flips a directory link
 * back and forth across two syscalls; it does not close it (Node has no
 * openat2 / RESOLVE_NO_SYMLINKS). Callers that need no link anywhere on the way
 * must keep the directory off the sandbox's reach, as the live archive does.
 *
 * Windows has no O_NOFOLLOW: there the check stays what it was (lstat, then
 * open, then fstat) — no weaker than before, with the same small window.
 */
import fs from "node:fs";
import path from "node:path";

const C = fs.constants;
// Missing on Windows: 0 there.
const NOFOLLOW = C.O_NOFOLLOW ?? 0;
const NONBLOCK = C.O_NONBLOCK ?? 0;
const NOCTTY = C.O_NOCTTY ?? 0;

export class UnsafeFileError extends Error {
  readonly code = "EUNSAFEFILE";
  constructor(file: string, why: string) {
    super(`${path.basename(file)}: ${why}`);
  }
}

export interface PlainOpts {
  /** Refuse a file bigger than this (checked on the open file, not on a stat before). */
  maxBytes?: number;
  /** The inode the walk saw: a different one was swapped in since. */
  dev?: number | bigint;
  ino?: number | bigint;
  /** A real (symlink-free) directory the file must really be inside. */
  root?: string;
}

/** Open a regular file for reading without following a link at its last step
 *  or waiting on a FIFO. The caller closes `fd`. Throws UnsafeFileError. */
export function openPlain(file: string, opts: PlainOpts = {}): { fd: number; st: fs.Stats } {
  if (!NOFOLLOW) {
    // No O_NOFOLLOW here: look first, as every caller did before.
    if (fs.lstatSync(file).isSymbolicLink()) throw new UnsafeFileError(file, "a symbolic link (refused, never followed)");
  }
  let fd: number;
  try {
    fd = fs.openSync(file, C.O_RDONLY | NOFOLLOW | NONBLOCK | NOCTTY);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ELOOP") throw new UnsafeFileError(file, "a symbolic link (refused, never followed)");
    if (code === "ENXIO") throw new UnsafeFileError(file, "not a regular file");
    throw err;
  }
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile()) throw new UnsafeFileError(file, "not a regular file");
    if (opts.ino !== undefined && (st.ino !== opts.ino || (opts.dev !== undefined && st.dev !== opts.dev))) {
      throw new UnsafeFileError(file, "changed while it was being read (another file took its place)");
    }
    if (opts.maxBytes !== undefined && st.size > opts.maxBytes) throw new UnsafeFileError(file, `larger than ${opts.maxBytes} bytes`);
    if (opts.root !== undefined) {
      const real = fs.realpathSync(file);
      const root = fs.realpathSync(opts.root);
      if (!(real === root || real.startsWith(root + path.sep))) throw new UnsafeFileError(file, "leads out of its folder through a symbolic link");
      const there = fs.lstatSync(real);
      if (there.ino !== st.ino || there.dev !== st.dev) throw new UnsafeFileError(file, "changed while it was being read (another file took its place)");
    }
    return { fd, st };
  } catch (err) {
    fs.closeSync(fd);
    throw err;
  }
}

/** The whole file as bytes, from the checked descriptor. */
export function readPlain(file: string, opts: PlainOpts = {}): Buffer {
  const { fd, st } = openPlain(file, opts);
  try {
    // Never trust the size past the cap: a file growing under the read stops there.
    if (opts.maxBytes === undefined) return fs.readFileSync(fd);
    const buf = Buffer.alloc(Math.min(st.size, opts.maxBytes) + 1);
    let n = 0;
    for (;;) {
      const got = fs.readSync(fd, buf, n, buf.length - n, null);
      if (!got) break;
      n += got;
      if (n >= buf.length) throw new UnsafeFileError(file, `larger than ${opts.maxBytes} bytes`);
    }
    return buf.subarray(0, n);
  } finally {
    fs.closeSync(fd);
  }
}

export function readPlainText(file: string, opts: PlainOpts = {}): string {
  return readPlain(file, opts).toString("utf8");
}

/** What the file is right now (size, device, inode), without following a link. */
export function statPlain(file: string, opts: PlainOpts = {}): fs.Stats {
  const { fd, st } = openPlain(file, opts);
  fs.closeSync(fd);
  return st;
}

/** A read stream over the checked descriptor (a byte range is inclusive, as
 *  createReadStream's). The descriptor is closed with the stream. */
export function plainStream(
  file: string,
  opts: PlainOpts & { start?: number; end?: number; highWaterMark?: number; signal?: AbortSignal } = {},
): fs.ReadStream {
  const { fd } = openPlain(file, opts);
  // O_NONBLOCK was for the open; a regular file reads the same either way.
  return fs.createReadStream(file, { fd, start: opts.start, end: opts.end, highWaterMark: opts.highWaterMark, signal: opts.signal, autoClose: true });
}

/** The whole file as bytes, read off the event loop from the checked descriptor. */
export async function readPlainAsync(file: string, opts: PlainOpts = {}): Promise<Buffer> {
  const { fd } = openPlain(file, opts);
  try {
    return await new Promise<Buffer>((resolve, reject) => fs.readFile(fd, (err, data) => (err ? reject(err) : resolve(data))));
  } finally {
    fs.closeSync(fd);
  }
}

/** copyFileSync, but from a checked descriptor: a link or a pipe swapped in
 *  since the caller's lstat is refused, not followed or waited on. The copy
 *  keeps the file's permission bits and is streamed (1 MiB at a time). */
export function copyPlain(from: string, to: string, opts: PlainOpts = {}): void {
  const { fd, st } = openPlain(from, opts);
  try {
    const out = fs.openSync(to, C.O_WRONLY | C.O_CREAT | C.O_TRUNC, st.mode & 0o777);
    try {
      const buf = Buffer.allocUnsafe(1 << 20);
      for (;;) {
        const n = fs.readSync(fd, buf, 0, buf.length, null);
        if (!n) break;
        let at = 0;
        while (at < n) at += fs.writeSync(out, buf, at, n - at);
      }
      fs.fchmodSync(out, st.mode & 0o777);
    } finally {
      fs.closeSync(out);
    }
  } finally {
    fs.closeSync(fd);
  }
}
