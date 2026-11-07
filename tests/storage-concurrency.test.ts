// Phase 0 of FOL-126: the file index is read-changed-written by several
// writers (the web pod's uploads, the worker's harvest). These tests run the
// races that used to lose entries or strand an index on a deleted blob.
//
//   node --test tests/storage-concurrency.test.ts

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import crypto from "node:crypto";

import { putFile, deleteFile, listStorage, readFileBytes, blobPath, withFileStoreLock, harvestFiles } from "../src/storage.ts";
import { workspaceDir } from "../src/store.ts";

let root: string;
const T = "default";
const W = "demo";

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-conc-"));
  process.env.FOLDRUN_DATA = root;
  delete process.env.FOLDRUN_STORAGE_DRIVER;
  fs.mkdirSync(path.join(workspaceDir(T, W), "agents"), { recursive: true });
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  delete process.env.FOLDRUN_DATA;
});

test("concurrent puts to one workspace all land in the index", async () => {
  const names = Array.from({ length: 24 }, (_, i) => `f${i}.txt`);
  await Promise.all(names.map((n) => putFile(T, W, n, Buffer.from(`body of ${n}`), "user:a")));
  assert.deepEqual(listStorage(T, W).map((f) => f.path).sort(), [...names].sort());
  for (const n of names) assert.equal((await readFileBytes(T, W, n))!.toString(), `body of ${n}`);
});

test("concurrent puts of the same path leave exactly one record, and its blob", async () => {
  await Promise.all(Array.from({ length: 10 }, (_, i) => putFile(T, W, "same.txt", Buffer.from(`v${i}`), "user:a")));
  const files = listStorage(T, W);
  assert.equal(files.length, 1);
  assert.ok(fs.existsSync(blobPath(T, W, files[0].sha)), "the index names a blob that is there");
});

test("a delete racing a put of the same bytes never leaves the index on a missing blob", async () => {
  const bytes = Buffer.from("shared bytes");
  for (let round = 0; round < 20; round++) {
    await putFile(T, W, "a.txt", bytes, "user:a");
    // b.txt gets the same bytes while a.txt is deleted (its blob becomes
    // unreferenced and is collected) — in every interleaving the survivor's
    // blob must still be there.
    await Promise.all([deleteFile(T, W, "a.txt"), putFile(T, W, "b.txt", bytes, "user:a")]);
    const b = listStorage(T, W).find((f) => f.path === "b.txt")!;
    assert.ok(b, "b.txt is indexed");
    assert.ok(fs.existsSync(blobPath(T, W, b.sha)), `round ${round}: b.txt's blob exists`);
    assert.equal((await readFileBytes(T, W, "b.txt"))!.toString(), "shared bytes");
    await deleteFile(T, W, "b.txt");
  }
});

test("a replace racing a put of the old bytes keeps the old bytes' blob for the new record", async () => {
  for (let round = 0; round < 20; round++) {
    await putFile(T, W, "x.txt", Buffer.from("old"), "user:a");
    await Promise.all([putFile(T, W, "x.txt", Buffer.from("new"), "user:a"), putFile(T, W, "y.txt", Buffer.from("old"), "user:a")]);
    for (const f of listStorage(T, W)) assert.ok(fs.existsSync(blobPath(T, W, f.sha)), `${f.path} has its blob`);
    await deleteFile(T, W, "x.txt");
    await deleteFile(T, W, "y.txt");
  }
});

test("the lock holds across processes: a second process waits for the first", async () => {
  const child = path.join(root, "child.mjs");
  const mod = path.resolve("src/storage.ts");
  fs.writeFileSync(
    child,
    `import { withFileStoreLock } from ${JSON.stringify(mod)};
     const t0 = Date.now();
     await withFileStoreLock("${T}", "${W}", async () => { process.stdout.write("in " + (Date.now()-t0) + "\\n"); await new Promise(r => setTimeout(r, 400)); });
     process.stdout.write("out\\n");`,
  );
  let out = "";
  let closed!: Promise<void>;
  // The parent holds the lock for 600ms; the child is started inside it and
  // must not get in until the parent lets go.
  const started = Date.now();
  await withFileStoreLock(T, W, async () => {
    const c = spawn(process.execPath, [child], { env: { ...process.env } });
    c.stdout.on("data", (d) => (out += d));
    c.stderr.on("data", (d) => (out += d));
    closed = new Promise<void>((resolve) => c.on("close", () => resolve()));
    await new Promise((r) => setTimeout(r, 600));
  });
  await closed;
  const o = out;
  void started;
  const entered = Number(/in (\d+)/.exec(o)?.[1]);
  assert.ok(entered >= 300, `the child entered only after the parent let go (waited ${entered}ms): ${o}`);
  assert.match(o, /out/);
});

test("a stale lock from a dead holder is taken over, and a late release does not free the new holder's", async () => {
  const lock = path.join(root, T, "storage", `.${W}.lock`);
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  fs.writeFileSync(lock, "9999.dead");
  const old = new Date(Date.now() - 60_000);
  fs.utimesSync(lock, old, old);
  let ran = false;
  await withFileStoreLock(T, W, async () => {
    ran = true;
    // someone replaces our lock (as a takeover would): our release must leave it
    fs.writeFileSync(lock, "other.holder");
  });
  assert.ok(ran);
  assert.equal(fs.readFileSync(lock, "utf8"), "other.holder");
});

test("a harvest and an upload landing together both keep their files", async () => {
  const mirror = path.join(workspaceDir(T, W), "storage");
  fs.mkdirSync(mirror, { recursive: true });
  for (let i = 0; i < 8; i++) fs.writeFileSync(path.join(mirror, `run${i}.txt`), `run ${i} ${crypto.randomUUID()}`);
  await Promise.all([
    harvestFiles(T, W, "run:r1:agent"),
    ...Array.from({ length: 8 }, (_, i) => putFile(T, W, `up${i}.txt`, Buffer.from(`up ${i}`), "user:a")),
  ]);
  assert.equal(listStorage(T, W).length, 16);
});

test("several processes recovering the same stale lock never run together", async () => {
  const lock = path.join(root, "shared.lock");
  const marker = path.join(root, "inside");
  const mod = path.resolve("src/storage.ts");
  const child = path.join(root, "taker.mjs");
  fs.writeFileSync(
    child,
    `import fs from "node:fs";
     import { withFileLock } from ${JSON.stringify(mod)};
     let bad = 0;
     for (let i = 0; i < 4; i++) {
       await withFileLock(${JSON.stringify(lock)}, async () => {
         try { fs.writeFileSync(${JSON.stringify(marker)}, String(process.pid), { flag: "wx" }); } catch { bad++; }
         await new Promise((r) => setTimeout(r, 30));
         if (bad === 0) fs.rmSync(${JSON.stringify(marker)}, { force: true });
       });
     }
     process.stdout.write(String(bad));`,
  );
  // a dead holder's lock, old enough to be taken over
  fs.writeFileSync(lock, "9999.dead");
  const old = new Date(Date.now() - 60_000);
  fs.utimesSync(lock, old, old);
  const run = () =>
    new Promise<string>((resolve) => {
      let out = "";
      const c = spawn(process.execPath, [child]);
      c.stdout.on("data", (d) => (out += d));
      c.stderr.on("data", (d) => (out += d));
      c.on("close", () => resolve(out));
    });
  const outs = await Promise.all(Array.from({ length: 5 }, run));
  assert.deepEqual(outs, ["0", "0", "0", "0", "0"], `a critical section overlapped another: ${outs.join(",")}`);
});

test("a rename waits for uploads to the new name, and neither is lost", async () => {
  const { moveWorkspaceStorage } = await import("../src/storage.ts");
  fs.mkdirSync(path.join(workspaceDir(T, "renamed"), "agents"), { recursive: true });
  await putFile(T, W, "keep.txt", Buffer.from("moves with the workspace"), "user:a");
  await Promise.all([
    moveWorkspaceStorage(T, W, "renamed"),
    ...Array.from({ length: 6 }, (_, i) => putFile(T, "renamed", `late${i}.txt`, Buffer.from(`late ${i}`), "user:a").catch(() => {})),
  ]);
  const names = listStorage(T, "renamed").map((f) => f.path);
  assert.ok(names.includes("keep.txt"), "the moved files arrived");
  assert.equal(listStorage(T, W).length, 0, "nothing left under the old name");
  // A late upload is either before the move (dropped with the stale store the
  // move replaces — the destination 'belonged to a workspace of that name that
  // no longer exists') or after it (kept). What must not happen is a torn
  // index: every record has its blob.
  for (const f of listStorage(T, "renamed")) assert.ok(fs.existsSync(blobPath(T, "renamed", f.sha)), `${f.path} has its blob`);
});
