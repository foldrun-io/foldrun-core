// A file listed as a regular file can be swapped for a symlink (to a secret
// outside the folder) or a FIFO between the walk's lstat and the read (SYMRACE,
// FOL-126 batch 3). The walkers followed it: the secret's bytes were stored,
// copied back or served, and a FIFO blocked the worker in a synchronous read.
// Each test swaps the file at the exact moment after the walk looked, by
// wrapping the fs call the walk makes — no timing, no sleeps.
//
//   node --test tests/symlink-race.test.ts

import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { fsBlobStore, fileSource, hashRange } from "../src/blob-store.ts";
import { localRunOutputStore, publishRunOutputs, openRunOutput, setRunOutputsBackend, SMALL_OUTPUT_FILE_BYTES, type RunOutputsBackend } from "../src/run-outputs.ts";
import { hashFile } from "../src/data-import.ts";
import { applyContainerChanges } from "../src/run-container.ts";
import { workspaceDir, readWorkspaceFile, saveWorkspace } from "../src/store.ts";
import { blobObjectKey } from "../src/manifest.ts";
import { openPlain, readPlain, plainStream, copyPlain, UnsafeFileError } from "../src/safe-open.ts";

const posix = process.platform !== "win32";
const SECRET = "outside-secret-bytes\n";
const sha = (b: Buffer | string) => crypto.createHash("sha256").update(b).digest("hex");

function tmp(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-symrace-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function fifo(p: string) {
  execFileSync("mkfifo", [p]);
}

/** Run `swap` once, right after the walk's own call of `fn` on `target` returns. */
function afterCall(t: TestContext, name: "lstatSync" | "readdirSync" | "statSync" | "realpathSync", target: string, swap: () => void) {
  const real = fs[name] as (...a: unknown[]) => unknown;
  let done = false;
  t.mock.method(fs, name as "lstatSync", ((...args: unknown[]) => {
    const out = real.apply(fs, args);
    if (!done && String(args[0]) === target) {
      done = true;
      swap();
    }
    return out;
  }) as never);
}

function outputsBackend(root: string, fileMax = 0) {
  const blobs = fsBlobStore(path.join(root, "objects"));
  const backend: RunOutputsBackend = { blobs, store: localRunOutputStore(path.join(root, "records")), enabled: () => true, fileMaxBytes: () => fileMax, runMaxBytes: () => 0 };
  return { blobs, backend };
}

const toLink = (file: string, secret: string) => () => {
  fs.rmSync(file);
  fs.symlinkSync(secret, file);
};
const toFifo = (file: string) => () => {
  fs.rmSync(file);
  fifo(file);
};

// ---- the run-output lane ----

for (const [label, size] of [["small", 20], ["large (streamed)", SMALL_OUTPUT_FILE_BYTES + 4096]] as const) {
  test(`run outputs: a ${label} file swapped for a symlink after the walk is refused, never stored`, async (t) => {
    const root = tmp(t);
    const { blobs, backend } = outputsBackend(root);
    const dir = path.join(root, "out");
    fs.mkdirSync(dir);
    const secretBody = Buffer.concat([Buffer.from(SECRET), Buffer.alloc(size, 7)]);
    const secret = path.join(root, "secret.bin");
    fs.writeFileSync(secret, secretBody);
    const f = path.join(dir, "report.bin");
    fs.writeFileSync(f, crypto.randomBytes(size));
    fs.writeFileSync(path.join(dir, "ok.txt"), "fine\n");
    afterCall(t, "lstatSync", f, toLink(f, secret));
    const out = await publishRunOutputs(backend, "acme", "desk", "run-1", "writer", dir);
    assert.equal(await blobs.head(blobObjectKey("acme", sha(secretBody))), null, "the secret's bytes were stored");
    assert.deepEqual(out.refused.map((r) => [r.path, r.reason]), [["report.bin", "unsafe"]]);
    assert.equal(out.record?.files, 1, "the rest is kept");
  });
}

test("run outputs: a file swapped for a FIFO after the walk is refused and does not block", { skip: !posix, timeout: 20_000 }, async (t) => {
  const root = tmp(t);
  const { backend } = outputsBackend(root);
  const dir = path.join(root, "out");
  fs.mkdirSync(dir);
  const f = path.join(dir, "pipe.txt");
  fs.writeFileSync(f, "x");
  fs.writeFileSync(path.join(dir, "ok.txt"), "fine\n");
  afterCall(t, "lstatSync", f, toFifo(f));
  const out = await publishRunOutputs(backend, "acme", "desk", "run-2", "writer", dir);
  assert.deepEqual(out.refused.map((r) => [r.path, r.reason]), [["pipe.txt", "unsafe"]]);
  assert.equal(out.record?.files, 1);
});

test("run outputs: a folder swapped for a link to a folder outside is refused", { skip: !posix }, async (t) => {
  const root = tmp(t);
  const { blobs, backend } = outputsBackend(root);
  const dir = path.join(root, "out");
  fs.mkdirSync(path.join(dir, "sub"), { recursive: true });
  const outside = path.join(root, "outside");
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, "a.txt"), SECRET);
  fs.writeFileSync(path.join(dir, "sub", "a.txt"), "mine\n");
  fs.writeFileSync(path.join(dir, "ok.txt"), "fine\n");
  const f = path.join(dir, "sub", "a.txt");
  afterCall(t, "lstatSync", f, () => {
    fs.rmSync(path.join(dir, "sub"), { recursive: true });
    fs.symlinkSync(outside, path.join(dir, "sub"));
  });
  const out = await publishRunOutputs(backend, "acme", "desk", "run-3", "writer", dir);
  assert.equal(await blobs.head(blobObjectKey("acme", sha(SECRET))), null, "the secret was stored through the folder link");
  assert.equal(out.record?.files, 1);
});

// ---- the copy-back from a sandbox's folder ----

test("copy-back: a file the step swapped for a symlink after the walk is not copied", { skip: !posix }, (t) => {
  const root = tmp(t);
  const host = path.join(root, "host");
  const box = path.join(root, "box");
  fs.mkdirSync(host);
  fs.mkdirSync(box);
  fs.writeFileSync(path.join(root, "secret.txt"), SECRET);
  fs.writeFileSync(path.join(box, "notes.md"), "a\n");
  fs.writeFileSync(path.join(box, "good.md"), "b\n");
  // the walk has listed the folder (readdir) when the step swaps it
  afterCall(t, "readdirSync", box, toLink(path.join(box, "notes.md"), path.join(root, "secret.txt")));
  const applied = applyContainerChanges(host, box, {});
  assert.equal(fs.existsSync(path.join(host, "notes.md")), false, "the link's target was copied back");
  assert.ok(applied.includes("good.md"));
  assert.equal(fs.readFileSync(path.join(host, "good.md"), "utf8"), "b\n");
});

test("copy-back: a FIFO in the step's folder is skipped and does not block", { skip: !posix, timeout: 20_000 }, (t) => {
  const root = tmp(t);
  const host = path.join(root, "host");
  const box = path.join(root, "box");
  fs.mkdirSync(host);
  fs.mkdirSync(box);
  fifo(path.join(box, "pipe.md"));
  fs.writeFileSync(path.join(box, "good.md"), "b\n");
  const applied = applyContainerChanges(host, box, {});
  assert.deepEqual(applied, ["good.md"]);
});

// ---- reads served to a person ----

test("readWorkspaceFile: a file swapped for a symlink after the containment check is refused", { skip: !posix }, (t) => {
  const tenant = "symrace-rw";
  const dir = workspaceDir(tenant, "desk");
  fs.mkdirSync(path.join(dir, "knowledge"), { recursive: true });
  fs.writeFileSync(path.join(dir, "AGENTS.md"), "---\nname: desk\n---\n");
  const p = path.join(dir, "knowledge", "note.md");
  fs.writeFileSync(p, "mine\n");
  const root = tmp(t);
  fs.writeFileSync(path.join(root, "secret.md"), SECRET);
  afterCall(t, "realpathSync", p, toLink(p, path.join(root, "secret.md")));
  assert.throws(() => readWorkspaceFile(tenant, "desk", "knowledge/note.md"), /symbolic link|leads out/);
});

test("a volume run output swapped for a symlink after the stat is not served", { skip: !posix }, async (t) => {
  const tenant = "symrace-vol";
  setRunOutputsBackend(null);
  const base = path.join(workspaceDir(tenant, "desk"), "runs", "run-9", "outputs", "writer");
  fs.mkdirSync(base, { recursive: true });
  const f = path.join(base, "r.txt");
  fs.writeFileSync(f, "mine\n");
  const root = tmp(t);
  fs.writeFileSync(path.join(root, "secret.txt"), SECRET);
  // after the containment check (its last realpath), before the file is opened
  afterCall(t, "realpathSync", f, toLink(f, path.join(root, "secret.txt")));
  let body = "";
  {
    try {
      const o = await openRunOutput(tenant, "desk", "run-9", "writer", "r.txt");
      if (!o) throw new Error("none");
      for await (const c of o.read() as unknown as AsyncIterable<Uint8Array>) body += Buffer.from(c).toString();
    } catch {
      /* refused while reading is fine */
    }
  }
  assert.ok(!body.includes("outside-secret"), "the secret was served");
});

// ---- the helper itself ----

test("fileSource: a file replaced after it was measured is refused on read", { skip: !posix }, async (t) => {
  const root = tmp(t);
  const f = path.join(root, "a.bin");
  fs.writeFileSync(f, Buffer.alloc(4096, 1));
  fs.writeFileSync(path.join(root, "secret.bin"), Buffer.alloc(4096, 9));
  const src = fileSource(f);
  toLink(f, path.join(root, "secret.bin"))();
  await assert.rejects(hashRange(src, 0, src.size), /symbolic link|another file|changed/);
});

test("openPlain: refuses a link, a FIFO, a directory, another inode, an oversize file; passes a regular one", { skip: !posix, timeout: 20_000 }, (t) => {
  const root = tmp(t);
  fs.writeFileSync(path.join(root, "f"), "12345");
  fs.symlinkSync(path.join(root, "f"), path.join(root, "l"));
  fifo(path.join(root, "p"));
  fs.mkdirSync(path.join(root, "d"));
  assert.throws(() => openPlain(path.join(root, "l")), UnsafeFileError);
  assert.throws(() => openPlain(path.join(root, "p")), UnsafeFileError);
  assert.throws(() => openPlain(path.join(root, "d")), UnsafeFileError);
  assert.throws(() => openPlain(path.join(root, "f"), { maxBytes: 4 }), /larger/);
  const st = fs.statSync(path.join(root, "f"));
  assert.throws(() => openPlain(path.join(root, "f"), { dev: st.dev, ino: st.ino + 1 }), /another file/);
  assert.equal(readPlain(path.join(root, "f"), { dev: st.dev, ino: st.ino, maxBytes: 5 }).toString(), "12345");
});

test("openPlain with a root: a folder on the way that is a link out is refused", { skip: !posix }, (t) => {
  const root = tmp(t);
  fs.mkdirSync(path.join(root, "in"));
  fs.mkdirSync(path.join(root, "out"));
  fs.writeFileSync(path.join(root, "out", "s"), SECRET);
  fs.symlinkSync(path.join(root, "out"), path.join(root, "in", "sub"));
  assert.throws(() => readPlain(path.join(root, "in", "sub", "s"), { root: path.join(root, "in") }), /leads out/);
  fs.writeFileSync(path.join(root, "in", "ok"), "ok");
  assert.equal(readPlain(path.join(root, "in", "ok"), { root: path.join(root, "in") }).toString(), "ok");
});

test("plainStream reads a byte range from the checked descriptor", async (t) => {
  const root = tmp(t);
  fs.writeFileSync(path.join(root, "f"), "0123456789");
  let s = "";
  for await (const c of plainStream(path.join(root, "f"), { start: 2, end: 5 })) s += c;
  assert.equal(s, "2345");
});

// ---- a deploy that keeps the agents' own files ----

for (const kind of ["symlink", "FIFO"] as const) {
  test(`deploy keepUntracked: a file swapped for a ${kind} after the walk is not copied into the workspace`, { skip: !posix, timeout: 20_000 }, (t) => {
    const tenant = `symrace-keep-${kind.toLowerCase()}`;
    const AGENTS = "---\nname: desk\n---\n";
    saveWorkspace(tenant, "desk", [{ path: "AGENTS.md", content: AGENTS }]);
    const dir = workspaceDir(tenant, "desk");
    fs.mkdirSync(path.join(dir, "agents", "a"), { recursive: true });
    const f = path.join(dir, "agents", "a", "notes.pdf");
    fs.writeFileSync(f, "mine");
    const root = tmp(t);
    fs.writeFileSync(path.join(root, "secret.txt"), SECRET);
    // the deploy has just checked the file (lstat) and makes the snapshot folder it copies into
    const swap = kind === "FIFO" ? toFifo(f) : toLink(f, path.join(root, "secret.txt"));
    const mk = fs.mkdirSync;
    let done = false;
    t.mock.method(fs, "mkdirSync", ((...a: Parameters<typeof fs.mkdirSync>) => {
      const out = mk.apply(fs, a);
      if (!done && String(a[0]).includes(`${path.sep}.keep-`)) {
        done = true;
        swap();
      }
      return out;
    }) as typeof fs.mkdirSync);
    saveWorkspace(tenant, "desk", [{ path: "AGENTS.md", content: AGENTS }], { commit: null, by: "restore", keepUntracked: true });
    assert.equal(fs.existsSync(f), false, "the swapped-in file was carried across the deploy");
  });
}

test("copyPlain copies a regular file with its mode and refuses a link", { skip: !posix }, (t) => {
  const root = tmp(t);
  fs.writeFileSync(path.join(root, "f"), "body");
  fs.chmodSync(path.join(root, "f"), 0o750);
  copyPlain(path.join(root, "f"), path.join(root, "g"));
  assert.equal(fs.readFileSync(path.join(root, "g"), "utf8"), "body");
  assert.equal(fs.statSync(path.join(root, "g")).mode & 0o777, 0o750);
  fs.symlinkSync(path.join(root, "f"), path.join(root, "l"));
  assert.throws(() => copyPlain(path.join(root, "l"), path.join(root, "h")), UnsafeFileError);
});

test("data import hashFile refuses a link and a file that is not the one the scan listed", { skip: !posix }, async (t) => {
  const root = tmp(t);
  fs.writeFileSync(path.join(root, "f"), "body");
  fs.symlinkSync(path.join(root, "f"), path.join(root, "l"));
  assert.equal(await hashFile(path.join(root, "f")), sha("body"));
  await assert.rejects(hashFile(path.join(root, "l")), /symbolic link/);
  const st = fs.statSync(path.join(root, "f"));
  await assert.rejects(hashFile(path.join(root, "f"), { dev: st.dev, ino: st.ino + 1 }), /another file/);
});

test("run outputs: an outputs folder that is itself a link keeps nothing", { skip: !posix }, async (t) => {
  const root = tmp(t);
  const { backend } = outputsBackend(root);
  const outside = path.join(root, "outside");
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, "secret.txt"), SECRET);
  const dir = path.join(root, "out");
  fs.symlinkSync(outside, dir);
  const out = await publishRunOutputs(backend, "acme", "desk", "run-4", "writer", dir);
  assert.equal(out.record, null);
});
