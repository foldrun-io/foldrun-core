// Run outputs are hashed and uploaded from disk, not read whole into memory
// (FOL-126, review M6): a multi-GiB file must not be able to OOM the worker.

import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { fsBlobStore } from "../src/blob-store.ts";
import { HARD_OUTPUT_FILE_BYTES, SMALL_OUTPUT_FILE_BYTES, localRunOutputStore, publishRunOutputs, readRunOutput, setRunOutputsBackend, type RunOutputsBackend } from "../src/run-outputs.ts";
import { blobObjectKey } from "../src/manifest.ts";

function setup(fileMax = 0) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-ros-"));
  const blobs = fsBlobStore(path.join(root, "objects"));
  const backend: RunOutputsBackend = { blobs, store: localRunOutputStore(path.join(root, "records")), enabled: () => true, fileMaxBytes: () => fileMax, runMaxBytes: () => 0 };
  const dir = path.join(root, "out");
  fs.mkdirSync(dir, { recursive: true });
  return { root, blobs, backend, dir };
}

test("a file past the small-file size is hashed and uploaded from disk, never read whole", async (t) => {
  const { root, blobs, backend, dir } = setup();
  setRunOutputsBackend(backend);
  t.after(() => {
    setRunOutputsBackend(null);
    fs.rmSync(root, { recursive: true, force: true });
  });
  const big = path.join(dir, "big.bin");
  const body = crypto.randomBytes(SMALL_OUTPUT_FILE_BYTES + 1234);
  fs.writeFileSync(big, body);
  fs.writeFileSync(path.join(dir, "small.txt"), "hi\n");
  const read = t.mock.method(fs, "readFileSync");
  const out = await publishRunOutputs(backend, "acme", "desk", "run-1", "writer", dir);
  read.mock.restore();
  assert.deepEqual(out.refused, []);
  assert.equal(read.mock.calls.filter((c) => String(c.arguments[0]) === big).length, 0, "the big file was read whole");
  const sha = crypto.createHash("sha256").update(body).digest("hex");
  assert.ok(await blobs.head(blobObjectKey("acme", sha)), "stored under its own hash");
  assert.deepEqual(await readRunOutput("acme", "desk", "run-1", "writer", "big.bin"), body);
  assert.equal((await readRunOutput("acme", "desk", "run-1", "writer", "small.txt"))?.toString(), "hi\n");
});

test("a file over the hard cap is refused as file-cap even when no cap is set, and never read", async (t) => {
  const { root, backend, dir } = setup(0);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const huge = path.join(dir, "huge.bin");
  fs.closeSync(fs.openSync(huge, "w"));
  fs.truncateSync(huge, HARD_OUTPUT_FILE_BYTES + 1); // sparse: no disk used
  fs.writeFileSync(path.join(dir, "ok.txt"), "ok\n");
  const out = await publishRunOutputs(backend, "acme", "desk", "run-2", "writer", dir);
  assert.deepEqual(out.refused.map((r) => [r.path, r.reason, r.limit]), [["huge.bin", "file-cap", HARD_OUTPUT_FILE_BYTES]]);
  assert.equal(out.record?.files, 1, "the rest is kept");
});
