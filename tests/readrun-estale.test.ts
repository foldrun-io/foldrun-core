// readRun rides out EFS/NFS ESTALE. writeRun (store.ts) replaces the run
// file by rename, so a concurrent open()+read() on NFS can land on the
// just-unlinked inode and fail ESTALE (errno -116, Node's "Unknown system
// error -116", syscall read). On dev-aws this surfaced as a CLI `--wait`
// call returning HTTP 500 — waitForRun polls readRun every 250ms while the
// worker rewrites the record on each step — even though the run completed.
// readRun re-opens by path a few times on ESTALE, and rethrows anything else.
//
//   node --test tests/readrun-estale.test.ts

import { test, mock } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { readRun } from "../src/store.ts";

const estale = () =>
  Object.assign(new Error("ESTALE: stale file handle, read"), { code: "ESTALE", errno: -116, syscall: "read" });

test("readRun retries past ESTALE and returns the record", () => {
  const record = { id: "run-estale-1", status: "completed" };
  mock.method(fs, "existsSync", () => true);
  let calls = 0;
  mock.method(fs, "readFileSync", () => {
    calls++;
    if (calls <= 2) throw estale();
    return JSON.stringify(record);
  });
  try {
    const run = readRun("test", "home", "run-estale-1");
    assert.equal(calls, 3, "two ESTALE then success → three reads");
    assert.deepEqual(run, record);
  } finally {
    mock.restoreAll();
  }
});

test("readRun rethrows a non-ESTALE error without retrying", () => {
  const denied = Object.assign(new Error("EACCES: permission denied, read"), { code: "EACCES", errno: -13 });
  mock.method(fs, "existsSync", () => true);
  let calls = 0;
  mock.method(fs, "readFileSync", () => {
    calls++;
    throw denied;
  });
  try {
    assert.throws(() => readRun("test", "home", "run-estale-2"), /EACCES/);
    assert.equal(calls, 1, "a non-ESTALE error must not be retried");
  } finally {
    mock.restoreAll();
  }
});
