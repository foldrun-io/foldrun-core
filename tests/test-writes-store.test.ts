// A test run's diverted writes survive a change of worker (FOL-126): saved to
// the blob store and one step-state row after a step, brought back into
// another worker's empty run folder before the next, gone with the run.
//
//   node --test tests/test-writes-store.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { registerPlatform, resetPlatform } from "../src/platform.ts";
import type { RecordsPort } from "../src/records.ts";
import { fakeRecords } from "./fake-records.ts";
import { fsBlobStore, bounded } from "../src/blob-store.ts";
import { localRevisionStore } from "../src/revision-store.ts";
import { setRevisionBackend, resetJournalForTests } from "../src/workspace-revisions.ts";
import { saveTestWrites, restoreTestWrites } from "../src/test-writes-store.ts";

test("diverted writes saved on one worker are brought back on another, with their times; a second save stores nothing new", async (t) => {
  const shared = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-tw-shared-"));
  const a = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-tw-a-"));
  const b = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-tw-b-"));
  t.after(() => {
    setRevisionBackend(null);
    resetJournalForTests();
    resetPlatform();
    for (const d of [shared, a, b]) fs.rmSync(d, { recursive: true, force: true });
  });
  setRevisionBackend({ blobs: bounded(fsBlobStore(path.join(shared, ".objects")), { backoffMs: 1 }), revisions: localRevisionStore(path.join(shared, ".revisions")) }, { journal: () => true, read: () => true });
  registerPlatform({ records: fakeRecords() as RecordsPort });
  fs.mkdirSync(path.join(a, "state"), { recursive: true });
  fs.writeFileSync(path.join(a, "state", "report.md"), "PASS today\n");
  const when = new Date("2026-11-13T01:02:03Z");
  fs.utimesSync(path.join(a, "state", "report.md"), when, when);
  fs.mkdirSync(path.join(a, "storage", "out"), { recursive: true });
  fs.writeFileSync(path.join(a, "storage", "out", "x.bin"), Buffer.from([0, 1, 2, 255]));
  assert.equal(await saveTestWrites("acme", "desk", "run-t1", a), 2);
  assert.equal(await saveTestWrites("acme", "desk", "run-t1", a), 0, "nothing new");
  // Another worker: an empty folder.
  assert.equal((await restoreTestWrites("acme", "desk", "run-t1", b)).restored, 2);
  assert.equal(fs.readFileSync(path.join(b, "state", "report.md"), "utf8"), "PASS today\n");
  assert.deepEqual(fs.readFileSync(path.join(b, "storage", "out", "x.bin")), Buffer.from([0, 1, 2, 255]));
  assert.equal(fs.statSync(path.join(b, "state", "report.md")).mtime.toISOString(), when.toISOString(), "the time the step wrote it");
  assert.equal((await restoreTestWrites("acme", "desk", "run-t1", b)).restored, 0, "already here");
  assert.equal((await restoreTestWrites("acme", "desk", "run-other", b)).restored, 0, "another run has none");
  // Same bytes, a newer time on A: the time travels to B (Codex review).
  const later = new Date("2026-11-13T05:00:00Z");
  fs.utimesSync(path.join(a, "state", "report.md"), later, later);
  await saveTestWrites("acme", "desk", "run-t1", a);
  await restoreTestWrites("acme", "desk", "run-t1", b);
  assert.equal(fs.statSync(path.join(b, "state", "report.md")).mtime.toISOString(), later.toISOString());
  // B's save without A's storage file keeps it named.
  fs.rmSync(path.join(b, "storage"), { recursive: true, force: true });
  await saveTestWrites("acme", "desk", "run-t1", b);
  const c = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-tw-c-"));
  assert.equal((await restoreTestWrites("acme", "desk", "run-t1", c)).restored, 2);
  fs.rmSync(c, { recursive: true, force: true });
  // Two workers from the same start: B changed nothing, A rewrote the report.
  // B's save must not put the old report back (Codex review).
  const { start } = await restoreTestWrites("acme", "desk", "run-t1", b);
  fs.writeFileSync(path.join(a, "state", "report.md"), "A's newer report\n");
  await saveTestWrites("acme", "desk", "run-t1", a);
  fs.writeFileSync(path.join(b, "state", "other.md"), "B's own file\n");
  await saveTestWrites("acme", "desk", "run-t1", b, start);
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-tw-d-"));
  await restoreTestWrites("acme", "desk", "run-t1", d);
  assert.equal(fs.readFileSync(path.join(d, "state", "report.md"), "utf8"), "A's newer report\n");
  assert.equal(fs.readFileSync(path.join(d, "state", "other.md"), "utf8"), "B's own file\n");
  fs.rmSync(d, { recursive: true, force: true });
});
