// Captured calls in the blob store (FOL-126 phase 7, step 2): one blob per call, written once
// at completion, pinned by the run, read back through the row; the volume when the setting is off.
//
//   node --test tests/captured-calls.test.ts
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { registerPlatform, resetPlatform } from "../src/platform.ts";
import { fsBlobStore, bounded } from "../src/blob-store.ts";
import { localRevisionStore } from "../src/revision-store.ts";
import type { BlobPins, PinHolder, PinKind } from "../src/blob-pins.ts";
import { setRevisionBackend, resetJournalForTests, dropWorkspaceRevisions, settleLifecycle } from "../src/workspace-revisions.ts";
import { callSink, flushCalls, readCapturedCallAsync, CapturedCallUnavailable } from "../src/captured-calls.ts";
import { recordCallIo } from "../src/capture.ts";
import { readCapturedCall, deleteRun, workspaceDir, type RunRecord } from "../src/store.ts";
import { blobObjectKey } from "../src/manifest.ts";
import { fakeRecords } from "./fake-records.ts";
import { setLocalDiskGate } from "../src/mirror-base.ts";
import { localRunOutputStore, archiveRunOutputs, setRunOutputsBackend, settleRunOutputs } from "../src/run-outputs.ts";

const T = "acme";
const W = "desk";
let root: string;
let ws: string;
let on = true;
const held: { kind: PinKind; ref: string; holder: PinHolder }[] = [];
const pins: BlobPins = {
  async pinBlobs(_t, shas, h) {
    for (const r of shas) if (!held.some((x) => x.ref === r && x.holder.id === h.id)) held.push({ kind: "blob", ref: r, holder: h });
  },
  async pinManifests() {},
  async release(_t, h) {
    const n = held.filter((x) => x.holder.kind === h.kind && x.holder.id === h.id).length;
    for (let i = held.length - 1; i >= 0; i--) if (held[i]!.holder.id === h.id && held[i]!.holder.kind === h.kind) held.splice(i, 1);
    return n;
  },
  async renew() {
    return 0;
  },
  async isPinned(_t, kind, ref) {
    return held.some((x) => x.kind === kind && x.ref === ref);
  },
  async isPinnedBeyondRevisions() {
    return false;
  },
  async live() {
    return { manifests: [], blobs: held.map((x) => x.ref) };
  },
  async guardDelete(_t, _k, _r, del) {
    await del();
    return true;
  },
};
let blobs: ReturnType<typeof bounded>;
let rows: ReturnType<typeof fakeRecords>;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-calls-"));
  process.env.FOLDRUN_DATA = root;
  ws = workspaceDir(T, W);
  fs.mkdirSync(path.join(ws, "runs"), { recursive: true });
  fs.writeFileSync(path.join(ws, "AGENTS.md"), "---\nname: desk\n---\n");
  held.length = 0;
  on = true;
  rows = fakeRecords({ callsOn: () => on });
  registerPlatform({ records: rows });
  blobs = bounded(fsBlobStore(path.join(root, ".objects")), { backoffMs: 1 });
  setRevisionBackend({ blobs, revisions: localRevisionStore(path.join(root, ".revisions")), pins }, { journal: () => false, read: () => false });
});
afterEach(() => {
  setRevisionBackend(null);
  resetJournalForTests();
  resetPlatform();
  fs.rmSync(root, { recursive: true, force: true });
  delete process.env.FOLDRUN_DATA;
});

const run = (id: string): RunRecord => ({ id, flow: "f", status: "completed", startedAt: new Date().toISOString(), steps: [] }) as unknown as RunRecord;
const redact = (s: string) => s.replace(/hunter2hunter2/g, "[redacted:KEY]");
const callsDir = (runId: string) => path.join(ws, "runs", runId, "calls");
function sink(owner: object, runId: string) {
  return callSink(owner, { tenant: T, workspace: W, runId, workspaceRoot: ws });
}

test("a call is one blob, written when its output arrives, and the volume is untouched", async () => {
  const step = {};
  const s = sink(step, "run-1");
  assert.ok(recordCallIo(ws, "run-1", "c1", "Bash", { input: "ls hunter2hunter2" }, redact, s));
  await flushCallsLater(); // nothing yet: the input waits for its output
  assert.equal([...held].length, 0, "no pin and no blob before the call completes");
  assert.ok(recordCallIo(ws, "run-1", "c1", "Bash", { output: "a.txt" }, redact, s));
  await flushCalls(step);
  assert.equal(fs.existsSync(callsDir("run-1")), false, "nothing under the run's folder");
  assert.equal(held.length, 1);
  assert.deepEqual(held[0]!.holder, { kind: "run", id: "calls:run-1" });
  const call = await readCapturedCallAsync(T, W, "run-1", "c1");
  assert.equal(call!.input, "ls [redacted:KEY]", "masked as before");
  assert.equal(call!.output, "a.txt");
  assert.equal(await blobs.head(blobObjectKey(T, held[0]!.ref)).then((h) => h?.size), JSON.stringify(call).length);
  assert.equal(readCapturedCall(T, W, "run-1", "c1"), null);
});
const flushCallsLater = async () => new Promise((r) => setTimeout(r, 5));

test("a call that never completes is written when the step ends", async () => {
  const step = {};
  const s = sink(step, "run-1");
  recordCallIo(ws, "run-1", "c1", "Bash", { input: "sleep 999" }, redact, s);
  await flushCalls(step);
  assert.equal((await readCapturedCallAsync(T, W, "run-1", "c1"))!.input, "sleep 999");
});

test("a part over the cap is cut and flagged, in the blob as on the volume", async () => {
  const step = {};
  const s = sink(step, "run-1");
  recordCallIo(ws, "run-1", "c1", "Read", { input: "x", output: "y".repeat(70_000), outputChars: 70_000 }, redact, s);
  await flushCalls(step);
  const call = (await readCapturedCallAsync(T, W, "run-1", "c1"))!;
  assert.equal(call.output!.length, 64 * 1024);
  assert.equal(call.outputCut, true);
  assert.equal(call.truncated, true);
});

test("off: files, as before; a call stored while on stays readable after it is turned off", async () => {
  on = false;
  const a = {};
  recordCallIo(ws, "run-1", "c1", "Bash", { input: "i", output: "o" }, redact, sink(a, "run-1"));
  await flushCalls(a);
  assert.equal(readCapturedCall(T, W, "run-1", "c1")!.output, "o");
  assert.equal(held.length, 0);
  on = true;
  const b = {};
  recordCallIo(ws, "run-2", "c2", "Bash", { input: "i", output: "o2" }, redact, sink(b, "run-2"));
  await flushCalls(b);
  on = false;
  assert.equal((await readCapturedCallAsync(T, W, "run-2", "c2"))!.output, "o2");
  assert.equal((await readCapturedCallAsync(T, W, "run-1", "c1"))!.output, "o", "the older one, from its file");
});

test("switched on between the input and the output: the file's input is kept", async () => {
  on = false;
  const a = {};
  recordCallIo(ws, "run-1", "c1", "Bash", { input: "the input" }, redact, sink(a, "run-1"));
  on = true;
  const b = {};
  recordCallIo(ws, "run-1", "c1", "Bash", { output: "the output" }, redact, sink(b, "run-1"));
  await flushCalls(b);
  const call = (await readCapturedCallAsync(T, W, "run-1", "c1"))!;
  assert.equal(call.input, "the input");
  assert.equal(call.output, "the output");
});

test("a lost blob is an error, never an empty answer; an unknown call is null", async () => {
  const step = {};
  recordCallIo(ws, "run-1", "c1", "Bash", { input: "i", output: "o" }, redact, sink(step, "run-1"));
  await flushCalls(step);
  fs.rmSync(path.join(root, ".objects"), { recursive: true, force: true });
  await assert.rejects(() => readCapturedCallAsync(T, W, "run-1", "c1"), (e: Error) => e instanceof CapturedCallUnavailable && /captured call unavailable/.test(e.message));
  assert.equal(await readCapturedCallAsync(T, W, "run-1", "nope"), null);
  assert.equal(await readCapturedCallAsync(T, W, "run-1", "../x"), null);
});

test("TEMPORARY: a store that refuses the write falls back to the volume", async () => {
  const bad = { ...blobs, putIfAbsent: async () => { throw new Error("the store is down"); } } as unknown as typeof blobs;
  setRevisionBackend({ blobs: bad, revisions: localRevisionStore(path.join(root, ".revisions")), pins }, { journal: () => false, read: () => false });
  const step = {};
  recordCallIo(ws, "run-1", "c1", "Bash", { input: "i", output: "o" }, redact, sink(step, "run-1"));
  await flushCalls(step);
  assert.equal(readCapturedCall(T, W, "run-1", "c1")!.output, "o");
  assert.equal((await readCapturedCallAsync(T, W, "run-1", "c1"))!.output, "o");
});

test("on a pod's own disk (localDisk) a store that refuses the write does NOT fall back to the volume; the call is not recorded", async () => {
  const bad = { ...blobs, putIfAbsent: async () => { throw new Error("the store is down"); } } as unknown as typeof blobs;
  setRevisionBackend({ blobs: bad, revisions: localRevisionStore(path.join(root, ".revisions")), pins }, { journal: () => false, read: () => false });
  setLocalDiskGate(() => true);
  try {
    const step = {};
    recordCallIo(ws, "run-1", "c1", "Bash", { input: "i", output: "o" }, redact, sink(step, "run-1"));
    await flushCalls(step);
    assert.equal(readCapturedCall(T, W, "run-1", "c1"), null, "nothing on the volume");
    assert.equal(await readCapturedCallAsync(T, W, "run-1", "c1"), null);
  } finally {
    setLocalDiskGate(null);
  }
});

test("deleting a run releases its pin and its rows; the other run keeps its own", async () => {
  for (const id of ["run-1", "run-2"]) {
    rows.runPut(T, W, run(id), { id } as never, false);
    const step = {};
    recordCallIo(ws, id, "c1", "Bash", { input: "i", output: `o ${id}` }, redact, sink(step, id));
    await flushCalls(step);
  }
  assert.equal(held.length, 2);
  assert.ok(deleteRun(T, W, "run-1"));
  await settleLifecycle();
  assert.deepEqual(held.map((x) => x.holder.id), ["calls:run-2"]);
  assert.equal(await readCapturedCallAsync(T, W, "run-1", "c1"), null);
  assert.equal((await readCapturedCallAsync(T, W, "run-2", "c1"))!.output, "o run-2");
});

test("deleting a workspace releases the pin of every run that has calls, before anything is removed", async () => {
  for (const id of ["run-1", "run-2"]) {
    const step = {};
    recordCallIo(ws, id, "c1", "Bash", { input: "i", output: "o" }, redact, sink(step, id));
    await flushCalls(step);
  }
  assert.equal(held.length, 2);
  await dropWorkspaceRevisions(T, W, () => assert.equal(held.length, 0, "released before the folder is removed"));
  assert.equal(held.length, 0);
});

// Outputs and calls both register on the run-removed hook; neither may replace the other, in either order.
for (const order of ["calls first", "outputs first"] as const) {
  test(`both outputs and calls are cleaned when both are registered (${order})`, async () => {
    const outputs = { blobs, pins, store: localRunOutputStore(path.join(root, ".run-outputs")), enabled: () => true, fileMaxBytes: () => 1 << 20, runMaxBytes: () => 4 << 20 };
    if (order === "calls first") setRunOutputsBackend(outputs); // the calls backend was set in beforeEach
    else {
      setRunOutputsBackend(null);
      setRevisionBackend(null);
      setRunOutputsBackend(outputs);
      setRevisionBackend({ blobs, revisions: localRevisionStore(path.join(root, ".revisions")), pins }, { journal: () => false, read: () => false });
    }
    try {
      for (const id of ["run-1", "run-2"]) {
        rows.runPut(T, W, run(id), { id } as never, false);
        const step = {};
        recordCallIo(ws, id, "c1", "Bash", { input: "i", output: `o ${id}` }, redact, sink(step, id));
        await flushCalls(step);
        const dir = path.join(root, `out-${id}`);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, "report.md"), `# ${id}`);
        assert.equal((await archiveRunOutputs(T, W, id, "writer", dir)).where, "store");
      }
      assert.equal(held.filter((x) => x.holder.id.startsWith("calls:")).length, 2);
      assert.equal((await outputs.store.list(T, W, "run-1")).length, 1);

      assert.ok(deleteRun(T, W, "run-1"));
      await settleLifecycle();
      await settleRunOutputs();
      assert.deepEqual(held.map((x) => x.holder.id).filter((id) => id.startsWith("calls:")), ["calls:run-2"], "the calls pin of the deleted run is gone");
      assert.deepEqual(await outputs.store.list(T, W, "run-1"), [], "its outputs are gone");
      assert.equal((await outputs.store.list(T, W, "run-2")).length, 1, "the other run keeps its outputs");

      // Clearing one registration leaves the other.
      setRunOutputsBackend(null);
      assert.ok(deleteRun(T, W, "run-2"));
      await settleLifecycle();
      assert.equal(held.filter((x) => x.holder.id.startsWith("calls:")).length, 0, "calls still cleaned with outputs unregistered");

      // A workspace delete takes both.
      rows.runPut(T, W, run("run-3"), { id: "run-3" } as never, false);
      setRunOutputsBackend(outputs);
      const step = {};
      recordCallIo(ws, "run-3", "c1", "Bash", { input: "i", output: "o" }, redact, sink(step, "run-3"));
      await flushCalls(step);
      const dir = path.join(root, "out-run-3");
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "r.md"), "x");
      await archiveRunOutputs(T, W, "run-3", "writer", dir);
      await dropWorkspaceRevisions(T, W);
      assert.equal(held.filter((x) => x.holder.id.startsWith("calls:")).length, 0);
      assert.deepEqual(await outputs.store.list(T, W, "run-3"), []);
    } finally {
      await settleRunOutputs();
      setRunOutputsBackend(null);
    }
  });
}

test("a hook that throws does not stop the next one", async () => {
  const { registerRunRemovedHook } = await import("../src/store.ts");
  rows.runPut(T, W, run("run-1"), { id: "run-1" } as never, false);
  const step = {};
  recordCallIo(ws, "run-1", "c1", "Bash", { input: "i", output: "o" }, redact, sink(step, "run-1"));
  await flushCalls(step);
  registerRunRemovedHook(() => {
    throw new Error("boom");
  }, "aaa-first");
  try {
    assert.ok(deleteRun(T, W, "run-1"));
    await settleLifecycle();
    assert.equal(held.length, 0, "the calls hook still ran");
  } finally {
    registerRunRemovedHook(null, "aaa-first");
  }
});
