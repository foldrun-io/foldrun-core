// Snapshot archives (Part B3): the deterministic writer, and the strict
// reader against archives built by hand to break each of its rules.
//
//   node --test tests/snapshot-archive.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import zlib from "node:zlib";

const { packSnapshot, unpackSnapshot, SnapshotRefused, SNAPSHOT_LIMITS } = await import("../src/snapshot-archive.ts");

/** A tar entry built with no checks at all — for the attacks. */
function raw(name: string, opts: { type?: string; content?: Buffer; mode?: number; prefix?: string; size?: number; magic?: string; badSum?: boolean } = {}): Buffer {
  const content = opts.content ?? Buffer.alloc(0);
  const h = Buffer.alloc(512, 0);
  h.write(name, 0, 100, "utf8");
  h.write((opts.mode ?? 0o644).toString(8).padStart(7, "0") + "\0", 100, 8, "ascii");
  h.write("0000000\0", 108, 8, "ascii");
  h.write("0000000\0", 116, 8, "ascii");
  h.write((opts.size ?? content.length).toString(8).padStart(11, "0") + "\0", 124, 12, "ascii");
  h.write("00000000000\0", 136, 12, "ascii");
  h.write("        ", 148, 8, "ascii");
  h.write(opts.type ?? "0", 156, 1, "ascii");
  h.write(opts.magic ?? "ustar\u000000", 257, 8, "ascii");
  if (opts.prefix) h.write(opts.prefix, 345, 155, "utf8");
  let sum = 0;
  for (const b of h) sum += b;
  h.write((sum + (opts.badSum ? 1 : 0)).toString(8).padStart(6, "0") + "\0 ", 148, 8, "ascii");
  const pad = Buffer.alloc((512 - (content.length % 512)) % 512, 0);
  return Buffer.concat([h, content, pad]);
}
const archive = (...parts: Buffer[]) => zlib.gzipSync(Buffer.concat([...parts, Buffer.alloc(1024, 0)]));
const refused = (buf: Buffer, re: RegExp, limits = SNAPSHOT_LIMITS) =>
  assert.throws(() => unpackSnapshot(buf, limits), (e: unknown) => e instanceof SnapshotRefused && re.test((e as Error).message), String(re));

const f = (path: string, text: string, mode = 0o644) => ({ path, mode, content: Buffer.from(text) });

test("what is packed unpacks the same: paths, contents, the exec bit, a long path through the prefix", () => {
  const long = `${"deep/".repeat(25)}file.txt`;
  const packed = packSnapshot([f("src/b.ts", "b"), f("src/a.ts", "a"), f("bin/run.sh", "#!/bin/sh\necho hi\n", 0o755), f(long, "x"), f("empty.txt", "")]);
  const out = unpackSnapshot(packed.archive);
  assert.deepEqual(out.entries.map((e) => e.path), ["bin/run.sh", long, "empty.txt", "src/a.ts", "src/b.ts"], "sorted");
  assert.equal(out.entries.find((e) => e.path === "bin/run.sh")!.mode, 0o755);
  assert.equal(out.entries.find((e) => e.path === "src/a.ts")!.mode, 0o644);
  assert.equal(out.entries.find((e) => e.path === long)!.content.toString(), "x");
  assert.equal(out.sha256, packed.sha256);
  assert.equal(packed.files, 5);
});

test("the same folder is the same bytes: order in, time and owner do not change the hash", () => {
  const a = packSnapshot([f("x.txt", "1"), f("y/z.txt", "2")]);
  const b = packSnapshot([f("y/z.txt", "2"), f("x.txt", "1")]);
  assert.equal(a.sha256, b.sha256);
  assert.notEqual(a.sha256, packSnapshot([f("x.txt", "1"), f("y/z.txt", "3")]).sha256);
});

test("links, devices, FIFOs, sparse files and extended headers are refused", () => {
  refused(archive(raw("link", { type: "2" })), /symbolic link/);
  refused(archive(raw("hard", { type: "1" })), /hard link/);
  refused(archive(raw("dev", { type: "3" })), /character device/);
  refused(archive(raw("blk", { type: "4" })), /block device/);
  refused(archive(raw("fifo", { type: "6" })), /FIFO/);
  refused(archive(raw("pax", { type: "x", content: Buffer.from("27 path=../../etc/passwd\n") })), /PAX/);
  refused(archive(raw("././@LongLink", { type: "L", content: Buffer.from("../../x") })), /GNU long name/);
  refused(archive(raw("sparse", { type: "S" })), /sparse/);
});

test("paths that escape, hide or confuse are refused", () => {
  refused(archive(raw("/etc/passwd", { content: Buffer.from("x") })), /absolute/);
  refused(archive(raw("../up.txt", { content: Buffer.from("x") })), /`\.\.`/);
  refused(archive(raw("a/../../up.txt", { content: Buffer.from("x") })), /`\.\.`/);
  refused(archive(raw("a/./b.txt", { content: Buffer.from("x") })), /`\.`/);
  refused(archive(raw("a//b.txt", { content: Buffer.from("x") })), /empty/);
  refused(archive(raw("win\\path.txt", { content: Buffer.from("x") })), /backslash/);
  refused(archive(raw("ctl\u0007.txt", { content: Buffer.from("x") })), /control/);
  refused(archive(raw("x".repeat(90), { prefix: "/abs", content: Buffer.from("x") })), /absolute/);
  refused(archive(raw(`${"d/".repeat(33)}f`.slice(0, 99), { content: Buffer.from("x") })), /deeper/);
});

test("a path twice (also by case) and a file where a folder is are refused", () => {
  refused(archive(raw("a.txt", { content: Buffer.from("1") }), raw("a.txt", { content: Buffer.from("2") })), /twice/);
  refused(archive(raw("README.md", { content: Buffer.from("1") }), raw("readme.md", { content: Buffer.from("2") })), /twice/);
  refused(archive(raw("a", { content: Buffer.from("1") }), raw("a/b", { content: Buffer.from("2") })), /inside a, which is a file/);
  refused(archive(raw("a/b", { content: Buffer.from("1") }), raw("a", { content: Buffer.from("2") })), /a file where another entry makes it a folder/);
});

test("limits hold while reading: files, one file, the whole, the compressed size, a gzip bomb", () => {
  const small = { maxFiles: 3, maxFileBytes: 100, maxTotalBytes: 250, maxCompressedBytes: 10_000 };
  refused(archive(raw("1", { content: Buffer.from("x") }), raw("2", { content: Buffer.from("x") }), raw("3", { content: Buffer.from("x") }), raw("4", { content: Buffer.from("x") })), /more than 3 (files|entries)/, small);
  refused(archive(raw("big", { content: Buffer.alloc(101, 65) })), /most for one file/, small);
  refused(archive(raw("a", { content: Buffer.alloc(100, 65) }), raw("b", { content: Buffer.alloc(100, 65) }), raw("c", { content: Buffer.alloc(100, 65) })), /in all/, small);
  refused(Buffer.alloc(10_001, 1), /compressed/, small);
  // 1 GB of zeros, a few MB gzipped: refused before it is all held.
  const bomb = zlib.gzipSync(Buffer.alloc(64 * 1024 * 1024, 0));
  refused(bomb, /unpacks past/, { ...SNAPSHOT_LIMITS, maxTotalBytes: 1024 * 1024, maxFiles: 10 });
  assert.throws(() => packSnapshot([f("1", "a"), f("2", "b"), f("3", "c"), f("4", "d")], small), /4 files/);
});

test("a broken archive is refused, not half-read: not gzip, a bad checksum, not ustar, cut short, no end, data after the end", () => {
  refused(Buffer.from("not gzip at all"), /not a gzip/);
  refused(archive(raw("a", { content: Buffer.from("x"), badSum: true })), /checksum/);
  refused(archive(raw("a", { content: Buffer.from("x"), magic: "notus\u000000" })), /ustar/);
  refused(zlib.gzipSync(raw("a", { content: Buffer.from("x"), size: 5000 })), /cut short/);
  refused(zlib.gzipSync(raw("a", { content: Buffer.from("x") })), /end-of-archive/);
  refused(zlib.gzipSync(Buffer.concat([raw("a", { content: Buffer.from("x") }), Buffer.alloc(1024, 0), Buffer.from("trailing")])), /after the end/);
});

test("20,000 files unpack in well under a second (the clash check is not quadratic)", () => {
  const many = Array.from({ length: 20_000 }, (_, i) => ({ path: `d${i % 50}/f${i}.txt`, mode: 0o644, content: Buffer.from("x") }));
  const packed = packSnapshot(many);
  const t0 = performance.now();
  const out = unpackSnapshot(packed.archive);
  const ms = performance.now() - t0;
  assert.equal(out.entries.length, 20_000);
  assert.ok(ms < 1500, `${Math.round(ms)} ms`);
});

test("clashes are found whatever the case, and the writer refuses what the reader would (Codex)", () => {
  refused(archive(raw("A", { content: Buffer.from("1") }), raw("a/b", { content: Buffer.from("2") })), /inside a, which is a file/i);
  refused(archive(raw("a/b", { content: Buffer.from("1") }), raw("A", { content: Buffer.from("2") })), /a file where another entry makes it a folder/);
  refused(archive(raw("Dir/x", { content: Buffer.from("1") }), raw("dir/X", { content: Buffer.from("2") })), /twice/);
  assert.throws(() => packSnapshot([f("a", "1"), f("a/b", "2")]), /inside a, which is a file/);
  assert.throws(() => packSnapshot([f("A", "1"), f("a/b", "2")]), /which is a file|another entry/);
  assert.throws(() => packSnapshot([f("x.txt", "1"), f("X.txt", "2")]), /twice/);
});

test("folder entries count against the limit too: an archive of folders alone cannot fill memory (Codex)", () => {
  const dirs = Array.from({ length: 50 }, (_, i) => raw(`d${i}/`, { type: "5" }));
  refused(archive(...dirs), /more than 10 entries/, { ...SNAPSHOT_LIMITS, maxFiles: 10 });
  const ok = unpackSnapshot(archive(raw("a/", { type: "5" }), raw("a/b.txt", { content: Buffer.from("x") })));
  assert.deepEqual(ok.entries.map((e) => e.path), ["a/b.txt"], "a folder entry is allowed, and implied by its files");
});
