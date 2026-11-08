// History left behind by workspaces deleted before the delete fix (FOL-126,
// 8 Nov 2026): removed at the boot reconcile, after a grace window, and never
// on thin evidence.
//
//   node --test tests/orphaned-history.test.ts

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { workspaceDir, writeWorkspaceFile } from "../src/store.ts";
import { fsBlobStore, bounded } from "../src/blob-store.ts";
import { localRevisionStore } from "../src/revision-store.ts";
import { setRevisionBackend, resetJournalForTests, flushRevisions, readAtHead, reconcileAll, cleanOrphanedHistory } from "../src/workspace-revisions.ts";
import { memorySweepMarks } from "../src/blob-sweeper.ts";
import { headsOf, type Deps } from "../src/publish.ts";

const T = "acme";
const HOUR = 3_600_000;
let root: string;
let deps: Deps;
let now = Date.parse("2026-11-08T10:00:00Z");
const clock = () => new Date(now);
let marks: ReturnType<typeof memorySweepMarks>;

async function make(w: string, tenant = T) {
  fs.mkdirSync(workspaceDir(tenant, w), { recursive: true });
  fs.writeFileSync(path.join(workspaceDir(tenant, w), "AGENTS.md"), `---\nname: ${w}\n---\n`);
  writeWorkspaceFile(tenant, w, "memory/a.md", `${w}\n`, { by: "test" });
  await flushRevisions({ tenant, workspace: w });
}
const head = async (w: string, tenant = T) => (await headsOf(deps, { tenant, workspace: w })).workspace;
/** What the old delete did: the folder is gone, the rows stay. */
const oldStyleDelete = (w: string, tenant = T) => fs.rmSync(workspaceDir(tenant, w), { recursive: true, force: true });

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-orph-"));
  process.env.FOLDRUN_DATA = root;
  now = Date.parse("2026-11-08T10:00:00Z");
  marks = memorySweepMarks(clock);
  deps = { blobs: bounded(fsBlobStore(path.join(root, ".objects")), { backoffMs: 1 }), revisions: localRevisionStore(path.join(root, ".revisions")) };
  setRevisionBackend(deps, { journal: () => true, read: () => true, sweepMarks: marks, orphanGraceMs: HOUR });
});
afterEach(() => {
  setRevisionBackend(null);
  resetJournalForTests();
  fs.rmSync(root, { recursive: true, force: true });
  delete process.env.FOLDRUN_DATA;
});

test("a workspace without a folder is recorded at the first reconcile and its history removed after the grace; a repeat is a no-op", async () => {
  await make("alive");
  await make("ghost");
  oldStyleDelete("ghost");
  assert.ok(await head("ghost"), "the old bug: rows with no folder");
  let r = await reconcileAll();
  assert.ok(await head("ghost"), "not yet: seen once");
  assert.equal(marks.table.size, 1);
  now += 30 * 60_000;
  await reconcileAll();
  assert.ok(await head("ghost"), "still inside the grace");
  now += 31 * 60_000;
  await reconcileAll();
  assert.equal(await head("ghost"), null, "removed");
  assert.ok(await head("alive"), "a workspace with a folder is never touched");
  assert.equal(marks.table.size, 0);
  r = await reconcileAll();
  assert.ok(r.checked >= 1);
  const again = await cleanOrphanedHistory(marks, { graceMs: HOUR });
  assert.deepEqual(again, { checked: 1, orphans: 0, marked: 0, dropped: 0, skipped: 0 }, "idempotent");
});

test("a new workspace given the ghost's name before the grace ends is forgotten, not removed", async () => {
  await make("ghost");
  const oldHead = (await head("ghost"))!.id;
  oldStyleDelete("ghost");
  await reconcileAll();
  await make("ghost"); // same name, new folder; its first commit builds on the ghost's head (the old bug)
  assert.ok(await head("ghost"));
  now += 2 * HOUR;
  await reconcileAll();
  assert.ok(await head("ghost"), "the folder is back: forgotten, not removed");
  assert.equal(marks.table.size, 0);
  assert.ok(oldHead);
  assert.equal((await readAtHead(T, "ghost", "memory/a.md"))?.toString(), "ghost\n");
});

test("nothing is removed when the data root is empty (a volume that is not mounted)", async () => {
  await make("ghost");
  oldStyleDelete("ghost");
  fs.rmSync(path.join(root, T), { recursive: true, force: true });
  for (const n of fs.readdirSync(root)) if (!n.startsWith(".")) fs.rmSync(path.join(root, n), { recursive: true, force: true });
  const r = await cleanOrphanedHistory(marks, { graceMs: 0 });
  assert.equal(r.dropped, 0);
  assert.ok(await head("ghost"));
});

test("an account whose folders are mostly missing is left alone and said (a partial mount looks like that)", async () => {
  for (const w of ["a", "b", "c", "d", "e", "f", "g"]) await make(w);
  for (const w of ["a", "b", "c", "d", "e"]) oldStyleDelete(w);
  now += 0;
  await cleanOrphanedHistory(marks, { graceMs: 0 });
  const r = await cleanOrphanedHistory(marks, { graceMs: 0 });
  assert.equal(r.dropped, 0);
  assert.equal(r.skipped, 5);
  assert.ok(await head("a"));
  const forced = await cleanOrphanedHistory(marks, { graceMs: 0, force: true });
  const forced2 = await cleanOrphanedHistory(marks, { graceMs: 0, force: true });
  assert.ok(forced.marked >= 0 && forced2.dropped === 5);
  assert.equal(await head("a"), null);
  assert.ok(await head("f"));
});

test("a dry run records and removes nothing", async () => {
  await make("ghost");
  oldStyleDelete("ghost");
  const r = await cleanOrphanedHistory(marks, { graceMs: 0, dryRun: true });
  assert.equal(r.orphans, 1);
  assert.equal(marks.table.size, 0);
  assert.ok(await head("ghost"));
});

test("without a marks store the boot reconcile never removes history", async () => {
  setRevisionBackend(deps, { journal: () => true, read: () => true });
  await make("ghost");
  oldStyleDelete("ghost");
  await reconcileAll();
  await reconcileAll();
  assert.ok(await head("ghost"));
});
