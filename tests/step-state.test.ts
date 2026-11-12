// Step state (FOL-126 phase 7): what a step was handed and started from, and
// the storage index a run first saw. Rows when a records port with the step
// methods is registered and `stepStateOn` says so; the run's files otherwise.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { registerPlatform, resetPlatform } from "../src/platform.ts";
import type { RecordsPort } from "../src/records.ts";
import { writeHandedIn, readHandedIn, dropHandedIn, writeBaseRevision, readBaseRevision } from "../src/run-container.ts";
import { readStorageBaseline, writeStorageBaseline } from "../src/step-state.ts";

let root: string;
let ws: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-step-state-"));
  ws = path.join(root, "desk");
  fs.mkdirSync(ws, { recursive: true });
});
afterEach(() => {
  resetPlatform();
  fs.rmSync(root, { recursive: true, force: true });
});

/** A port with only what step state asks of it, over a Map. */
function fakePort(opts: { on?: () => boolean; onFiles?: boolean; failReads?: boolean } = {}) {
  const rows = new Map<string, unknown>();
  const key = (t: string, w: string, r: string, k: string, ref: string) => [t, w, r, k, ref].join("|");
  const port = {
    stepStateOn: opts.on ?? (() => true),
    onFiles: () => opts.onFiles === true,
    async: {
      async stepGet(t: string, w: string, r: string, k: string, ref: string) {
        if (opts.failReads) throw new Error("database is down");
        return rows.get(key(t, w, r, k, ref));
      },
      async stepPut(t: string, w: string, r: string, k: string, ref: string, data: unknown) {
        rows.set(key(t, w, r, k, ref), JSON.parse(JSON.stringify(data)));
      },
      async stepDrop(t: string, w: string, r: string, k: string, ref: string | null) {
        for (const x of [...rows.keys()]) if (x.startsWith([t, w, r, k].join("|") + "|") && (ref === null || x.endsWith("|" + ref))) rows.delete(x);
      },
    },
  };
  registerPlatform({ records: port as unknown as RecordsPort });
  return rows;
}
const runDir = (run: string) => path.join(ws, "runs", run);

test("with rows on, what a step was handed lives in the database and nothing is written under the run", async () => {
  const rows = fakePort();
  await writeHandedIn(ws, "run-1", "pod-a", { "a.md": "h1" }, "acme");
  await writeBaseRevision(ws, "run-1", "pod-a", { workspace: "w1", state: null }, "acme");
  await writeStorageBaseline(ws, "acme", "desk", "run-1", { "post.json": "s1" });
  assert.equal(rows.size, 3);
  assert.equal(fs.existsSync(runDir("run-1")), false, "no file on the volume");
  assert.deepEqual(await readHandedIn(ws, "run-1", "pod-a", "acme"), { "a.md": "h1" });
  assert.deepEqual(await readBaseRevision(ws, "run-1", "pod-a", "acme"), { workspace: "w1", state: null });
  assert.deepEqual(await readStorageBaseline(ws, "acme", "desk", "run-1"), { "post.json": "s1" });
  await dropHandedIn(ws, "run-1", "pod-a", "acme");
  assert.equal(await readHandedIn(ws, "run-1", "pod-a", "acme"), undefined);
  assert.equal(await readBaseRevision(ws, "run-1", "pod-a", "acme"), undefined, "the base goes with the hand-in record");
  assert.deepEqual(await readStorageBaseline(ws, "acme", "desk", "run-1"), { "post.json": "s1" }, "the storage baseline stays until the run is deleted");
});

test("the switch off, a workspace still on files or no tenant: files, as before", async () => {
  for (const [label, port, tenant] of [
    ["off", () => fakePort({ on: () => false }), "acme"],
    ["on files", () => fakePort({ onFiles: true }), "acme"],
    ["no tenant", () => fakePort(), undefined],
  ] as const) {
    const rows = port();
    const run = `run-${label.replace(/\W/g, "")}`;
    await writeHandedIn(ws, run, "pod-a", { x: "1" }, tenant);
    await writeStorageBaseline(ws, tenant, "desk", run, { y: "2" });
    assert.equal(rows.size, 0, label);
    assert.ok(fs.existsSync(path.join(runDir(run), "sandbox", "pod-a.json")), label);
    assert.ok(fs.existsSync(path.join(runDir(run), "storage-baseline.json")), label);
    assert.deepEqual(await readHandedIn(ws, run, "pod-a", tenant), { x: "1" }, label);
    assert.deepEqual(await readStorageBaseline(ws, tenant, "desk", run), { y: "2" }, label);
  }
});

test("switching mid-run loses nothing: rows are read whatever the switch says, then the file", async () => {
  let on = true;
  const rows = fakePort({ on: () => on });
  await writeHandedIn(ws, "run-2", "pod-a", { a: "1" }, "acme"); // a row
  on = false;
  await writeHandedIn(ws, "run-2", "pod-b", { b: "2" }, "acme"); // a file
  assert.equal(rows.size, 1);
  assert.deepEqual(await readHandedIn(ws, "run-2", "pod-a", "acme"), { a: "1" }, "the row, with the switch off");
  assert.deepEqual(await readHandedIn(ws, "run-2", "pod-b", "acme"), { b: "2" }, "the file, with the switch off");
  on = true;
  assert.deepEqual(await readHandedIn(ws, "run-2", "pod-b", "acme"), { b: "2" }, "the file, with the switch on");
  await dropHandedIn(ws, "run-2", "pod-b", "acme");
  assert.equal(fs.existsSync(path.join(runDir("run-2"), "sandbox", "pod-b.json")), false);
});

test("a database that cannot be read is an error, not 'this run was never here'", async () => {
  fakePort({ failReads: true });
  await assert.rejects(() => readStorageBaseline(ws, "acme", "desk", "run-3"), /database is down/);
  await assert.rejects(() => readHandedIn(ws, "run-3", "pod-a", "acme"), /database is down/);
  // …but a drop that cannot reach it never fails the step whose copy-out succeeded
  registerPlatform({
    records: {
      stepStateOn: () => true,
      onFiles: () => false,
      async: { stepGet: async () => undefined, stepPut: async () => {}, stepDrop: async () => { throw new Error("down"); } },
    } as unknown as RecordsPort,
  });
  await dropHandedIn(ws, "run-3", "pod-a", "acme");
});

test("names that could leave the run's folder are never stored or read as rows", async () => {
  const rows = fakePort();
  await writeHandedIn(ws, "../x", "pod-a", { a: "1" }, "acme");
  await writeHandedIn(ws, "run-4", "../../AGENTS", { a: "1" }, "acme");
  assert.equal(rows.size, 0);
  assert.equal(fs.existsSync(path.join(root, "x")), false);
  assert.equal(await readHandedIn(ws, "run-4", "../../AGENTS", "acme"), undefined);
});

test("a file written before the switch is still read by a run that was in flight", async () => {
  await writeStorageBaseline(ws, "acme", "desk", "run-5", { post: "6 Oct" }); // no port yet: file
  fakePort();
  assert.deepEqual(await readStorageBaseline(ws, "acme", "desk", "run-5"), { post: "6 Oct" });
});

test("switched off with a row already there: the next write removes the row, so the file written is the one read", async () => {
  let on = true;
  const rows = fakePort({ on: () => on });
  await writeStorageBaseline(ws, "acme", "desk", "run-9", { "post.json": "old" });
  assert.equal(rows.size, 1);
  on = false;
  await writeStorageBaseline(ws, "acme", "desk", "run-9", { "post.json": "new" });
  assert.equal(rows.size, 0, "the stale row is gone");
  assert.deepEqual(await readStorageBaseline(ws, "acme", "desk", "run-9"), { "post.json": "new" }, "not the old row's hashes");
});

test("the runner does not read a failed baseline as 'first visit'", () => {
  // Source-level: the call must not swallow the error (the overwrite it guards
  // against needs a worker crash plus a database fault to stage in a test).
  const src = fs.readFileSync(new URL("../src/runner.ts", import.meta.url), "utf8");
  assert.match(src, /const changedFrom = await readStorageBaseline\(runRoot, tenant, workspace, run\.id\);/);
  assert.doesNotMatch(src, /readStorageBaseline\([^)]*\)\.catch\(/);
});
