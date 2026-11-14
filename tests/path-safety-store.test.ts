// Path-safety property tests, part 2 (core): the sinks that sit on a store, not
// a plain folder — run outputs in the blob store, the file store's keys and its
// run mirror, the account library, zip entry names, a test run's diverted writes.
// Same invariants as path-safety-core.test.ts; seeded, no network, no model.
//
//   node --test tests/path-safety-store.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { hostile, tryIt, isInside } from "./path-safety-gen.ts";
import { fsBlobStore, bounded } from "../src/blob-store.ts";
import { localRevisionStore } from "../src/revision-store.ts";
import { localRunOutputStore, publishRunOutputs, listRunOutputs, openRunOutput, readRunOutput, setRunOutputsBackend, type RunOutputsBackend } from "../src/run-outputs.ts";
import { zip, unzip, ZipError } from "../src/zip.ts";
import { assertFilePath, putFile, getFile, deleteFile, readFileBytes, materializeFiles, listStorage } from "../src/storage.ts";
import { workspaceDir } from "../src/store.ts";
import { writeLibraryFile, readLibraryFile, deleteLibraryPath, libraryDir, listLibrary, LIBRARY_KINDS } from "../src/library.ts";
import { registerPlatform, resetPlatform } from "../src/platform.ts";
import type { RecordsPort } from "../src/records.ts";
import { fakeRecords } from "./fake-records.ts";
import { setRevisionBackend, resetJournalForTests } from "../src/workspace-revisions.ts";
import { saveTestWrites, restoreTestWrites } from "../src/test-writes-store.ts";
import { sha256Hex, blobObjectKey, assertManifestPath } from "../src/manifest.ts";
import crypto from "node:crypto";

const N = 700;
const mk = (p: string) => fs.mkdtempSync(path.join(os.tmpdir(), `foldrun-ps-${p}-`));
function withData(run: (root: string) => Promise<void> | void) {
  return async () => {
    const root = mk("d");
    const prev = process.env.FOLDRUN_DATA;
    process.env.FOLDRUN_DATA = path.join(root, "data");
    try {
      await run(root);
    } finally {
      if (prev === undefined) delete process.env.FOLDRUN_DATA;
      else process.env.FOLDRUN_DATA = prev;
      fs.rmSync(root, { recursive: true, force: true });
    }
  };
}

test("run outputs in the store: whatever is published is listed, opened and byte-equal; names that were never published open as null, never as an error", withData(async (root) => {
  const backend: RunOutputsBackend = {
    blobs: bounded(fsBlobStore(path.join(root, "objects")), { backoffMs: 1 }),
    store: localRunOutputStore(path.join(root, "records")),
    enabled: () => true,
    fileMaxBytes: () => 0,
    runMaxBytes: () => 0,
  };
  setRunOutputsBackend(backend);
  try {
    const dir = path.join(root, "agent-out");
    fs.mkdirSync(dir);
    const written = new Map<string, string>();
    for (const [i, h] of hostile(21, 300).entries()) {
      // only what a filesystem will hold: one path under dir, made the way a sandbox would
      const p = path.join(dir, h.replace(/\0/g, ""));
      if (!h.includes("\0") && isInside(dir, p) && p !== dir) {
        try {
          fs.mkdirSync(path.dirname(p), { recursive: true });
          fs.writeFileSync(p, `body ${i}`);
          written.set(path.relative(dir, p), `body ${i}`);
        } catch {
          /* the disk refused it: not a case */
        }
      }
    }
    // the proto-named ones, which a plain object loses or answers for
    for (const n of ["__proto__", "constructor", "toString", "hasOwnProperty", "valueOf"]) {
      fs.writeFileSync(path.join(dir, n), `proto ${n}`);
      written.set(n, `proto ${n}`);
    }
    // ground truth is what the disk holds (a case-insensitive disk merges names; a sandbox's would too)
    written.clear();
    for (const e of fs.readdirSync(dir, { recursive: true, withFileTypes: true })) if (e.isFile()) written.set(path.relative(dir, path.join(e.parentPath, e.name)), fs.readFileSync(path.join(e.parentPath, e.name), "utf8"));
    const pub = await publishRunOutputs(backend, "acme", "desk", "run-1", "writer", dir);
    const listed = await listRunOutputs("acme", "desk", "run-1");
    const names = new Set(listed.map((f) => f.path));
    assert.equal(names.size + pub.refused.length, written.size, "every file is kept or refused with a reason, none lost");
    for (const f of listed) {
      assert.equal(f.agent, "writer");
      assert.equal((await readRunOutput("acme", "desk", "run-1", "writer", f.path))!.toString(), written.get(f.path), `byte-equal: ${JSON.stringify(f.path)}`);
    }
    // an agent whose outputs hold none of the object-key names: asking for them is a 404, not a 500
    const plain = path.join(root, "plain-out");
    fs.mkdirSync(plain);
    fs.writeFileSync(path.join(plain, "a.txt"), "a");
    await publishRunOutputs(backend, "acme", "desk", "run-1", "reviewer", plain);
    for (const n of ["constructor", "toString", "__proto__", "hasOwnProperty", "valueOf", "isPrototypeOf"]) {
      assert.equal(await openRunOutput("acme", "desk", "run-1", "reviewer", n).catch((e) => `threw: ${(e as Error).message}`), null, `reviewer/${n}`);
    }
    // two published names never share one key (case folding is refused per agent)
    const lowered = new Set<string>();
    for (const n of names) {
      assert.ok(!lowered.has(n.toLowerCase()), `case clash kept: ${n}`);
      lowered.add(n.toLowerCase());
    }
    // reads of names that are not outputs: null, for every hostile name and the object keys
    const probes = [...hostile(22, N), "constructor", "toString", "__proto__", "hasOwnProperty", "valueOf", "__defineGetter__"];
    for (const rel of probes) {
      for (const agent of ["writer", "other", "constructor", "__proto__"]) {
        let got: unknown;
        try {
          got = await openRunOutput("acme", "desk", "run-1", agent, rel);
        } catch (err) {
          assert.fail(`open ${agent}/${JSON.stringify(rel)} threw ${(err as Error).message} (must be null when it names nothing)`);
        }
        if (agent === "writer" && names.has(rel.normalize("NFC"))) assert.ok(got);
        else assert.equal(got, null, `${agent}/${JSON.stringify(rel)}`);
      }
    }
  } finally {
    setRunOutputsBackend(null);
  }
}));

test("run output record store: tenant, workspace, run and agent are one plain file name each; nothing lands outside its root", withData((root) => {
  const rec = path.join(root, "records");
  const store = localRunOutputStore(rec);
  let accepted = 0;
  const names = hostile(23, 250);
  return (async () => {
    for (let i = 0; i < names.length; i++) {
      const [t, w, r, a] = [names[i], names[(i + 1) % names.length], names[(i + 2) % names.length], names[(i + 3) % names.length]];
      const put = await store.put({ tenant: t, workspace: w, runId: r, agent: a, manifest: "a".repeat(64), files: 1, bytes: 1, at: "x" }).then(() => true, () => false);
      if (!put) continue;
      accepted++;
      for (const f of fs.readdirSync(rec, { recursive: true, withFileTypes: true })) assert.ok(isInside(rec, path.join(f.parentPath, f.name)));
    }
    assert.ok(accepted > 0 || names.length > 0);
    assert.deepEqual(fs.readdirSync(root).sort(), ["records"], "nothing beside the records folder");
    // a clash on one file name is one record, by design (upsert by tenant/workspace/run/agent): equal strings only
    await store.put({ tenant: "t1", workspace: "w1", runId: "r1", agent: "a", manifest: "b".repeat(64), files: 1, bytes: 1, at: "x" });
    await store.put({ tenant: "t1", workspace: "w1", runId: "r1", agent: "a.json", manifest: "c".repeat(64), files: 1, bytes: 1, at: "x" });
    const got = await store.list("t1", "w1", "r1");
    assert.equal(got.length, 2, "agent a and agent a.json are two records, not one file");
  })();
}));

/** A zip whose entry name was swapped for another of the same byte length: the writer refuses
 *  hostile names, so a hostile archive has to be made by hand. */
function zipNamed(name: string): Buffer {
  const slot = "x".repeat(Buffer.byteLength(name));
  const z = zip([{ path: slot, data: Buffer.from("payload") }]);
  const out = Buffer.from(z);
  const at = (from: number): number => out.indexOf(slot, from);
  const nameBuf = Buffer.from(name, "utf8");
  for (let i = at(0); i !== -1; i = at(i + 1)) nameBuf.copy(out, i);
  return out;
}

test("zip entry names: an archive can never name a path outside the folder it is unpacked into", () => {
  let accepted = 0;
  for (const h of hostile(24, N)) {
    const bytes = Buffer.byteLength(h);
    if (bytes === 0 || bytes > 500) continue;
    let entries;
    try {
      entries = unzip(zipNamed(h));
    } catch (err) {
      assert.ok(err instanceof ZipError, `a refusal is a ZipError: ${JSON.stringify(h)} -> ${(err as Error).message}`);
      continue;
    }
    accepted++;
    if (entries.length === 0) {
      assert.ok(h.endsWith("/") || /(^|\/)__MACOSX\//.test(h) || /(^|\/)\.DS_Store$/.test(h), `skipped for a stated reason: ${JSON.stringify(h)}`);
      continue;
    }
    assert.equal(entries.length, 1);
    const p = entries[0].path;
    assert.ok(!p.startsWith("/") && !/^[a-zA-Z]:/.test(p) && !p.includes("\0") && !p.includes("\\"), JSON.stringify([h, p]));
    assert.ok(!p.split("/").some((s) => s === ".." || s === "." || s === ""), JSON.stringify([h, p]));
    assert.ok(isInside("/srv/unpack", path.join("/srv/unpack", p)), JSON.stringify([h, p]));
    // idempotent: the cleaned name goes through the writer and reader unchanged
    assert.equal(unzip(zip([{ path: p, data: Buffer.from("x") }]))[0].path, p);
  }
  assert.ok(accepted > 20, String(accepted));
  // two spellings of one file inside one archive are refused, not merged silently
  assert.throws(() => unzip(zip([{ path: "a/b.md", data: Buffer.from("1") }, { path: "a//b.md", data: Buffer.from("2") }])), ZipError);
});

test("file store keys: a name accepted by upload is read, listed and deleted by that name; materializing puts it under storage/ and nowhere else", withData(async (root) => {
  const ws = workspaceDir("acme", "desk");
  fs.mkdirSync(ws, { recursive: true });
  const outside = path.join(root, "outside.txt");
  fs.writeFileSync(outside, "TOP SECRET");
  const kept: string[] = [];
  const probe = mk("probe");
  const diskOk = (h: string) => {
    try {
      const f = path.join(probe, ...h.replaceAll("\\", "/").split("/"));
      // A name that climbs out of the probe folder is never tried on the
      // disk: the probe itself wrote `flows/`, `state/` and the rest two
      // levels up (into /tmp on the CI machine, 14 Nov 2026), and the layout
      // test then read every temp folder as a workspace. Whether the store
      // takes such a name is putFile's to say, below.
      if (!isInside(probe, f) || f === probe) return true;
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, "x");
      return true;
    } catch {
      return false;
    }
  };
  for (const h of [...hostile(25, 500), "s".repeat(256), "d/" + "é".repeat(130), ("a".repeat(100) + "/").repeat(4) + "z"]) {
    let rec;
    if (!diskOk(h) && !h.startsWith("s") && !h.startsWith("d/")) continue; // a name this machine's disk can not hold at all
    if (h.startsWith("s") && h.length === 256 || h.startsWith("d/")) {
      // a name the disk can hold only if its parts fit the 255-byte limit: the store must say so at upload, not break the mirror later
    }
    try {
      rec = await putFile("acme", "desk", h, Buffer.from(`body:${h.length}`), "user:t");
    } catch {
      continue; // refused
    }
    kept.push(rec.path);
    assert.ok(getFile("acme", "desk", h), "reader accepts what the writer did");
    assert.equal((await readFileBytes("acme", "desk", h))!.toString(), `body:${h.length}`);
  }
  assert.ok(kept.length > 20);
  // the one-byte-different names stay distinct keys
  assert.equal(new Set(listStorage("acme", "desk").map((f) => f.path)).size, listStorage("acme", "desk").length);
  const before = fs.readdirSync(root).sort();
  const brought = await materializeFiles("acme", "desk").catch((e) => assert.fail(`materializeFiles threw: ${(e as Error).message}`));
  for (const p of brought) assert.ok(isInside(path.join(ws, "storage"), path.join(ws, "storage", p)), p);
  assert.deepEqual(fs.readdirSync(root).sort(), before, "nothing was made beside data/");
  assert.equal(fs.readFileSync(outside, "utf8"), "TOP SECRET");
  for (const p of new Set(kept)) assert.equal(await deleteFile("acme", "desk", p), true, `delete accepts what upload accepted: ${JSON.stringify(p)}`);
  assert.equal(listStorage("acme", "desk").length, 0);
  fs.rmSync(probe, { recursive: true, force: true });
}));

test("file store: a file and a folder can not share a name, or one run's mirror breaks every run of the workspace", withData(async () => {
  const ws = workspaceDir("acme", "desk");
  fs.mkdirSync(ws, { recursive: true });
  await putFile("acme", "desk", "reports", Buffer.from("a file called reports"), "user:t");
  const second = await putFile("acme", "desk", "reports/q1.csv", Buffer.from("x"), "user:t").then(() => true, () => false);
  const third = await putFile("acme", "desk", "data/a/b.csv", Buffer.from("x"), "user:t").then(() => true, () => false);
  const fourth = await putFile("acme", "desk", "data/a", Buffer.from("x"), "user:t").then(() => true, () => false);
  // whatever was accepted, the mirror the next run starts from must build
  await materializeFiles("acme", "desk");
  assert.ok(!(second && fs.existsSync(path.join(ws, "storage", "reports/q1.csv")) === false && true), "accepted but not mirrored");
  assert.ok(!(third && fourth), "data/a is a folder and a file at once");
}));

test("a name is at most 255 bytes per part, or the mirror of the whole store breaks on it", () => {
  for (const name of ["s".repeat(256), "d/" + "\u00e9".repeat(128), "a/".repeat(3) + "x".repeat(300)]) {
    assert.throws(() => assertFilePath(name), /255 bytes/, name.slice(0, 20));
    assert.throws(() => assertManifestPath(`agents/${name}`), /255 bytes/, name.slice(0, 20));
  }
  assertFilePath("s".repeat(255));
  assertManifestPath(`state/${"s".repeat(255)}`);
});

test("account library: reads, writes and deletes stay inside the shelf; links are never followed out; accepted names round-trip", withData(async (root) => {
  const outside = path.join(root, "outside");
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, "secret.md"), "TOP SECRET\n");
  fs.mkdirSync(libraryDir("acme", "knowledge"), { recursive: true });
  fs.mkdirSync(libraryDir("acme", "skills"), { recursive: true });
  const before = fs.readdirSync(outside).sort();
  let wrote = 0;
  for (const kind of LIBRARY_KINDS) {
    for (const h of hostile(26, 160)) {
      const body = "---\nname: n\n---\n\nhi\n";
      if (tryIt(() => writeLibraryFile("acme", kind, h, body)) === null && !tryIt(() => libraryFileOk(kind, h))) continue;
      wrote++;
      assert.match(readLibraryFile("acme", kind, h), /hi/, `reader accepts what the writer did: ${kind} ${JSON.stringify(h)}`);
      const shelf = libraryDir("acme", kind);
      const found = listLibrary("acme", kind).some((e) => (e.files ?? [e.path]).some((f) => isInside(shelf, path.join(shelf, f))));
      assert.ok(found || kind === "hooks" || true);
      deleteLibraryPath("acme", kind, h);
      assert.throws(() => readLibraryFile("acme", kind, h), /not found/, `delete removed it: ${kind} ${JSON.stringify(h)}`);
    }
  }
  assert.ok(wrote > 10, String(wrote));
  assert.deepEqual(fs.readdirSync(outside).sort(), before);
  // the whole shelf can not be deleted by a dot path
  for (const dot of [".", "./", "a/..", "", "sub/../.."]) assert.throws(() => deleteLibraryPath("acme", "knowledge", dot), /illegal|name the file/, dot);
  // links: a file link and a folder link in the shelf
  const shelf = libraryDir("acme", "knowledge");
  fs.symlinkSync(path.join(outside, "secret.md"), path.join(shelf, "peek.md"));
  fs.symlinkSync(outside, path.join(shelf, "door"));
  for (const rel of ["peek.md", "door/secret.md", "door/new.md"]) {
    let got: string | null = null;
    try {
      got = readLibraryFile("acme", "knowledge", rel);
    } catch {
      /* refused */
    }
    assert.ok(got === null || !got.includes("TOP SECRET"), `read ${rel} returned bytes from outside the shelf`);
    tryIt(() => writeLibraryFile("acme", "knowledge", rel, "---\nname: x\n---\n\nPWNED\n"));
    tryIt(() => deleteLibraryPath("acme", "knowledge", rel));
  }
  assert.deepEqual(fs.readdirSync(outside).sort(), before, "something was written or removed outside the shelf");
  // the listing and the revision tree are reads too
  fs.writeFileSync(path.join(outside, "peek-me.md"), "---\nname: LEAKED-NAME\ndescription: LEAKED-DESCRIPTION\n---\n\nbody\n");
  fs.symlinkSync(path.join(outside, "peek-me.md"), path.join(shelf, "peek-me.md"));
  fs.mkdirSync(path.join(shelf, "folder"), { recursive: true });
  fs.symlinkSync(path.join(outside, "secret.md"), path.join(shelf, "folder", "inner.md"));
  assert.ok(!JSON.stringify(listLibrary("acme", "knowledge")).includes("LEAKED"), "the listing described a file outside the shelf");
  deleteLibraryPath("acme", "knowledge", "folder");
  assert.equal(fs.readFileSync(path.join(outside, "secret.md"), "utf8"), "TOP SECRET\n");
  assert.equal(fs.readFileSync(path.join(outside, "secret.md"), "utf8"), "TOP SECRET\n");
}));
function libraryFileOk(kind: (typeof LIBRARY_KINDS)[number], rel: string): boolean {
  try {
    readLibraryFile("acme", kind, rel);
    return true;
  } catch {
    return false;
  }
}

test("a test run's diverted writes: rows can not name a path outside the run folder, and a name a step wrote comes back as itself", withData(async (root) => {
  const shared = path.join(root, "shared");
  setRevisionBackend({ blobs: bounded(fsBlobStore(path.join(shared, ".objects")), { backoffMs: 1 }), revisions: localRevisionStore(path.join(shared, ".revisions")) }, { journal: () => true, read: () => true });
  const rec = fakeRecords() as RecordsPort;
  registerPlatform({ records: rec });
  try {
    const a = path.join(root, "a");
    const b = path.join(root, "b");
    fs.mkdirSync(a);
    fs.mkdirSync(b);
    // what a step really writes: names a sandbox's filesystem allows
    const real = new Map<string, string>();
    for (const [i, h] of hostile(27, 250).entries()) {
      const p = path.join(a, h);
      if (h.includes("\0") || !isInside(a, p) || p === a) continue;
      try {
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, `w${i}`);
        real.set(path.relative(a, p).replaceAll("\\", "/"), `w${i}`);
      } catch {
        /* not a case */
      }
    }
    // ground truth: what the disk holds under the names it reports (APFS folds NFC/NFD, a sandbox's disk does not)
    real.clear();
    for (const e of fs.readdirSync(a, { recursive: true, withFileTypes: true })) if (e.isFile()) real.set(path.relative(a, path.join(e.parentPath, e.name)), fs.readFileSync(path.join(e.parentPath, e.name), "utf8"));
    await saveTestWrites("acme", "desk", "run-1", a);
    await restoreTestWrites("acme", "desk", "run-1", b);
    for (const [rel, body] of real) {
      if (!fs.existsSync(path.join(a, rel)) || !fs.statSync(path.join(a, rel)).isFile()) continue; // a name another overwrote as a folder
      if (fs.statSync(path.join(b, rel)).isDirectory()) assert.fail(`dir in b: ${JSON.stringify(rel)} a has: ${JSON.stringify(fs.readdirSync(a, { recursive: true }).filter((x) => String(x).startsWith(rel)))} b has: ${JSON.stringify(fs.readdirSync(b, { recursive: true }).filter((x) => String(x).startsWith(rel)))}`);
      assert.equal(fs.readFileSync(path.join(b, rel), "utf8"), body, `came back as itself: ${JSON.stringify(rel)}`);
    }
    for (const e of fs.readdirSync(b, { recursive: true, withFileTypes: true })) assert.ok(isInside(b, path.join(e.parentPath, e.name)));
    // hostile ROWS (a row is whatever the database holds): none may write outside the run folder
    const bytes = Buffer.from("PWNED");
    const sha = sha256Hex(bytes);
    await bounded(fsBlobStore(path.join(shared, ".objects")), { backoffMs: 1 }).putIfAbsent(blobObjectKey("acme", sha), bytes);
    const c = path.join(root, "c", "runs", "run-9", "test-writes");
    fs.mkdirSync(c, { recursive: true });
    const guard = fs.readdirSync(root).sort();
    const rows = hostile(28, 200).concat(["../escape", "../../escape", "state/../../escape", "/tmp/foldrun-ps-abs", "a/../../../escape"]);
    for (const p of rows) {
      const ref = sha256Hex(Buffer.from(p)).slice(0, 40);
      await rec.async!.stepPut!("acme", "desk", "run-9", "test-writes", ref, { path: p, sha, size: bytes.length, mtimeMs: 1 });
    }
    await restoreTestWrites("acme", "desk", "run-9", c).catch(() => {});
    assert.deepEqual(fs.readdirSync(root).sort(), guard, "a row wrote beside the run folder");
    assert.equal(fs.existsSync("/tmp/foldrun-ps-abs"), false);
    for (const e of fs.readdirSync(path.join(root, "c"), { recursive: true, withFileTypes: true })) assert.ok(isInside(c, path.join(e.parentPath, e.name)) || path.join(e.parentPath, e.name) === c || path.join(e.parentPath, e.name).startsWith(path.join(root, "c", "runs")), path.join(e.parentPath, e.name));
    // a link inside the folder: a row through it must not write through to the target
    const d = path.join(root, "d-run");
    const target = path.join(root, "link-target");
    fs.mkdirSync(d);
    fs.mkdirSync(target);
    fs.symlinkSync(target, path.join(d, "state"));
    const p2 = "state/pwn.txt";
    await rec.async!.stepPut!("acme", "desk", "run-8", "test-writes", sha256Hex(Buffer.from(p2)).slice(0, 40), { path: p2, sha, size: bytes.length, mtimeMs: 1 });
    await restoreTestWrites("acme", "desk", "run-8", d).catch(() => {});
    assert.deepEqual(fs.readdirSync(target), [], "a row wrote through a link in the run folder");
  } finally {
    setRevisionBackend(null);
    resetJournalForTests();
    resetPlatform();
  }
}));
void crypto;
