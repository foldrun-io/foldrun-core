// A small zip reader and writer — enough for an export package, no dependency.
//
// What a person downloads from "Export" has to open with a double-click on
// any machine, which is a zip, not a tarball. The format here is the plain
// one: deflate or stored entries, a central directory, no zip64, no
// encryption. The reader refuses anything outside that rather than guessing,
// and it is written to be handed untrusted bytes: every offset is bounds
// checked, sizes are capped before anything is inflated, and a path that
// climbs out (`..`, absolute, a drive letter) is an error, not a skip.

import zlib from "node:zlib";

export interface ZipEntry {
  path: string;
  data: Buffer;
}

export class ZipError extends Error {}

export interface UnzipLimits {
  /** Most entries the archive may hold. */
  maxEntries?: number;
  /** Largest one file, uncompressed. */
  maxFileBytes?: number;
  /** All files together, uncompressed. */
  maxTotalBytes?: number;
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** DOS date and time for the entry headers. */
function dosTime(d: Date): { time: number; date: number } {
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: (Math.max(0, d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

export function zip(entries: ZipEntry[], now = new Date()): Buffer {
  const { time, date } = dosTime(now);
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  const seen = new Set<string>();
  for (const e of entries) {
    const name = safeEntryPath(e.path);
    if (seen.has(name)) throw new ZipError(`duplicate entry: ${name}`);
    seen.add(name);
    const nameBuf = Buffer.from(name, "utf8");
    const deflated = zlib.deflateRawSync(e.data);
    const stored = deflated.length >= e.data.length;
    const body = stored ? e.data : deflated;
    const crc = crc32(e.data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(stored ? 0 : 8, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(e.data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, nameBuf, body);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x0314, 4); // made by: unix, 2.0
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(stored ? 0 : 8, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(e.data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE((0o100644 << 16) >>> 0, 38); // a regular file, rw-r--r--
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);

    offset += local.length + nameBuf.length + body.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

export function unzip(buf: Buffer, limits: UnzipLimits = {}): ZipEntry[] {
  const maxEntries = limits.maxEntries ?? 2000;
  const maxFile = limits.maxFileBytes ?? 1024 * 1024;
  const maxTotal = limits.maxTotalBytes ?? 50 * 1024 * 1024;

  // The end-of-central-directory record: within the last 22 + 65535 bytes.
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new ZipError("not a zip file");
  const count = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || cdOffset === 0xffffffff) throw new ZipError("zip64 archives are not supported");
  if (count > maxEntries) throw new ZipError(`too many files: ${count} (at most ${maxEntries})`);
  if (cdOffset + cdSize > eocd) throw new ZipError("corrupt zip: central directory out of range");

  const out: ZipEntry[] = [];
  const seen = new Set<string>();
  let total = 0;
  let p = cdOffset;
  for (let n = 0; n < count; n++) {
    if (p + 46 > eocd || buf.readUInt32LE(p) !== 0x02014b50) throw new ZipError("corrupt zip: bad central directory entry");
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const csize = buf.readUInt32LE(p + 20);
    const usize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localAt = buf.readUInt32LE(p + 42);
    if (p + 46 + nameLen > eocd) throw new ZipError("corrupt zip: name out of range");
    const rawName = buf.subarray(p + 46, p + 46 + nameLen).toString("utf8");
    p += 46 + nameLen + extraLen + commentLen;

    if (rawName.endsWith("/")) continue; // a directory entry
    // macOS "Compress" adds these beside every file; they are not content.
    if (/(^|\/)__MACOSX\//.test(rawName) || /(^|\/)\.DS_Store$/.test(rawName)) continue;
    if (flags & 0x1) throw new ZipError(`${rawName}: encrypted entries are not supported`);
    if (method !== 0 && method !== 8) throw new ZipError(`${rawName}: compression method ${method} is not supported`);
    const name = safeEntryPath(rawName);
    if (seen.has(name)) throw new ZipError(`duplicate entry: ${name}`);
    seen.add(name);
    if (usize > maxFile) throw new ZipError(`${name} is too large (${usize} bytes, at most ${maxFile})`);
    total += usize;
    if (total > maxTotal) throw new ZipError(`the files are too large together (more than ${maxTotal} bytes)`);

    if (localAt + 30 > buf.length || buf.readUInt32LE(localAt) !== 0x04034b50) throw new ZipError(`${name}: corrupt local header`);
    const start = localAt + 30 + buf.readUInt16LE(localAt + 26) + buf.readUInt16LE(localAt + 28);
    if (start + csize > buf.length) throw new ZipError(`${name}: data out of range`);
    const raw = buf.subarray(start, start + csize);
    let data: Buffer;
    try {
      // maxOutputLength: the header's size is the attacker's to choose, so the
      // inflate itself is capped too — a bomb stops here, not in memory.
      data = method === 0 ? Buffer.from(raw) : zlib.inflateRawSync(raw, { maxOutputLength: maxFile + 1 });
    } catch {
      throw new ZipError(`${name}: could not be decompressed`);
    }
    if (data.length !== usize) throw new ZipError(`${name}: size does not match its header`);
    if (crc32(data) !== crc) throw new ZipError(`${name}: checksum mismatch`);
    out.push({ path: name, data });
  }
  return out;
}

/** A relative, forward-slash path that stays inside the archive's root. */
function safeEntryPath(raw: string): string {
  const p = raw.replaceAll("\\", "/");
  if (p.startsWith("/") || /^[a-zA-Z]:/.test(p) || p.includes("\0")) throw new ZipError(`unsafe path: ${raw}`);
  const parts = p.split("/").filter((s) => s !== "" && s !== ".");
  if (parts.length === 0 || parts.some((s) => s === "..")) throw new ZipError(`unsafe path: ${raw}`);
  return parts.join("/");
}
