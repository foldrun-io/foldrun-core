// The journal's place is a seam (FOL-126 phase 4, item 3): files by default, a
// database where the platform gives one. Same contract for both; the journal
// writes to the one it is given, still replays what the volume holds from
// before, and a hosted journal never touches the data directory.
//
//   node --test tests/journal-store.test.ts

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { fsJournalStore, type JournalStore, type JournalRecord } from "../src/journal-store.ts";
import { workspaceDir, writeWorkspaceFile } from "../src/store.ts";
import { fsBlobStore, bounded } from "../src/blob-store.ts";
import { localRevisionStore } from "../src/revision-store.ts";
import { setRevisionBackend, resetJournalForTests, flushRevisions, recoverJournal, readAtHead, pendingRevisions, dropJournal, recordStepOutputs } from "../src/workspace-revisions.ts";
import type { Deps } from "../src/publish.ts";

/** A store in memory: what a table does, for the contract and the wiring. */
export function memoryJournalStore(): JournalStore & { rows: Map<string, { rec: JournalRecord; at: number; aside: boolean }> } {
  const rows = new Map<string, { rec: JournalRecord; at: number; aside: boolean }>();
  const id = (t: string, w: string, h: string) => `${t}\0${w}\0${h}`;
  return {
    kind: "memory",
    rows,
    put(rec) {
      if (!rows.has(id(rec.tenant, rec.workspace, rec.id))) rows.set(id(rec.tenant, rec.workspace, rec.id), { rec, at: Date.now(), aside: false });
      return rec.id;
    },
    remove: (t, w, h) => void rows.delete(id(t, w, h)),
    workspaces: () => [...new Map([...rows.values()].filter((r) => !r.aside).map((r) => [`${r.rec.tenant}\0${r.rec.workspace}`, { tenant: r.rec.tenant, workspace: r.rec.workspace }])).values()],
    entries: (t, w) => [...rows.values()].filter((r) => r.rec.tenant === t && r.rec.workspace === w && !r.aside).map((r) => ({ handle: r.rec.id, ageMs: Date.now() - r.at })),
    read(t, w, h) {
      const r = rows.get(id(t, w, h));
      if (!r) throw new Error("no such entry");
      return r.rec;
    },
    setAside(t, w, h) {
      const r = rows.get(id(t, w, h));
      if (r) r.aside = true;
    },
    sweep() {},
    drop(t, w) {
      for (const [k, r] of rows) if (r.rec.tenant === t && (w === undefined || r.rec.workspace === w)) rows.delete(k);
    },
  };
}

const T = "acme";
const W = "desk";
const rec = (idv: string, p = "memory/a.md"): JournalRecord => ({ v: 1, tenant: T, workspace: W, id: idv, files: [{ path: p, before: null, after: `body ${idv}\n` }], by: "u", message: "m", at: new Date().toISOString() });

let root: string;
let deps: Deps;
const ON = { journal: () => true, read: () => true };

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-jstore-"));
  process.env.FOLDRUN_DATA = root;
  fs.mkdirSync(path.join(workspaceDir(T, W), "memory"), { recursive: true });
  fs.writeFileSync(path.join(workspaceDir(T, W), "AGENTS.md"), "---\nname: desk\n---\n");
  deps = { blobs: bounded(fsBlobStore(path.join(root, ".objects")), { backoffMs: 1 }), revisions: localRevisionStore(path.join(root, ".revisions")) };
});
afterEach(() => {
  setRevisionBackend(null);
  resetJournalForTests();
  fs.rmSync(root, { recursive: true, force: true });
  delete process.env.FOLDRUN_DATA;
});

for (const [name, make] of [
  ["files", () => fsJournalStore(() => path.join(root, "j"))],
  ["memory (the shape of a table)", () => memoryJournalStore()],
] as const) {
  test(`${name}: put, list oldest first, read, remove, set aside, drop`, async () => {
    const s = make();
    const h1 = s.put(rec("a1"));
    await new Promise((r) => setTimeout(r, 5));
    const h2 = s.put(rec("a2"));
    assert.deepEqual(s.workspaces(), [{ tenant: T, workspace: W }]);
    assert.deepEqual(s.entries(T, W).map((e) => e.handle), [h1, h2], "oldest first");
    assert.equal(s.read(T, W, h2).id, "a2");
    assert.ok(s.entries(T, W)[0].ageMs >= 0);
    s.setAside(T, W, h1);
    assert.deepEqual(s.entries(T, W).map((e) => e.handle), [h2], "an entry set aside is never listed again");
    s.remove(T, W, h2);
    s.remove(T, W, h2); // safe to repeat
    assert.equal(s.entries(T, W).length, 0);
    s.put(rec("b1"));
    s.put({ ...rec("c1"), workspace: "other" });
    s.drop(T, W);
    assert.deepEqual(s.workspaces().map((w) => w.workspace), ["other"]);
    s.drop(T);
    assert.deepEqual(s.workspaces(), []);
  });
}

test("a journal given a store writes there and never to the data directory", async () => {
  const mem = memoryJournalStore();
  setRevisionBackend(deps, { ...ON, journalStore: mem });
  writeWorkspaceFile(T, W, "memory/a.md", "a\n", { by: "user:a" });
  assert.equal(mem.rows.size, 1, "written down before the commit");
  assert.equal(fs.existsSync(path.join(root, ".revision-journal")), false, "nothing on the volume");
  await flushRevisions({ tenant: T, workspace: W });
  assert.equal(mem.rows.size, 0, "removed once committed");
  assert.equal((await readAtHead(T, W, "memory/a.md"))?.toString(), "a\n");
});

test("boot replays the store's entries AND what the volume held from before, oldest first", async () => {
  // entries left by the earlier (files) journal, and one left in the store (their
  // writers had written the folder before journalling, as every writer does)
  for (const f of ["old", "new"]) fs.writeFileSync(path.join(workspaceDir(T, W), "memory", `${f}.md`), `body journal${f}0001\n`);
  const legacy = fsJournalStore(() => path.join(root, ".revision-journal"));
  legacy.put(rec("journalold0001", "memory/old.md"));
  const mem = memoryJournalStore();
  mem.put(rec("journalnew0001", "memory/new.md"));
  setRevisionBackend(deps, { ...ON, journalStore: mem });
  const out = await recoverJournal({ minAgeMs: 0 });
  assert.equal(out.entries, 2);
  assert.equal((await readAtHead(T, W, "memory/old.md"))?.toString(), "body journalold0001\n");
  assert.equal((await readAtHead(T, W, "memory/new.md"))?.toString(), "body journalnew0001\n");
  assert.equal(mem.rows.size, 0);
  assert.equal(legacy.workspaces().length, 0, "the volume's journal is drained");
});

test("a torn entry in the store is set aside, not replayed, and does not stop the others", async () => {
  fs.writeFileSync(path.join(workspaceDir(T, W), "memory", "good.md"), "body journalgood001\n");
  const mem = memoryJournalStore();
  mem.put({ ...rec("journalbad0001"), v: 3 as unknown as 1 });
  mem.put(rec("journalgood001", "memory/good.md"));
  setRevisionBackend(deps, { ...ON, journalStore: mem });
  const out = await recoverJournal({ minAgeMs: 0 });
  assert.equal(out.entries, 1);
  assert.equal(mem.rows.get(`${T}\0${W}\0journalbad0001`)?.aside, true);
  assert.equal((await readAtHead(T, W, "memory/good.md"))?.toString(), "body journalgood001\n");
});

test("a binary file is written down as base64 in a version-2 entry, and a replay commits its bytes", async () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xff, 0xfe, 0x00, 0x80]);
  fs.mkdirSync(path.join(workspaceDir(T, W), "agents", "a", "outputs"), { recursive: true });
  fs.writeFileSync(path.join(workspaceDir(T, W), "agents", "a", "outputs", "pic.png"), png);
  const mem = memoryJournalStore();
  setRevisionBackend(deps, { ...ON, journalStore: mem });
  assert.equal(recordStepOutputs(T, W, [{ path: "agents/a/outputs/pic.png", base: null, after: png }, { path: "memory/t.md", base: null, after: Buffer.from("t\n") }], { runId: "run-bin", step: 1 }), 2);
  const [row] = [...mem.rows.values()];
  assert.equal(row.rec.v, 2);
  assert.deepEqual(row.rec.files.map((f) => [f.path, f.enc ?? "text", f.after]), [["agents/a/outputs/pic.png", "base64", png.toString("base64")], ["memory/t.md", "text", "t\n"]]);
  // the process dies before the commit; the next one replays the row
  resetJournalForTests();
  assert.equal((await recoverJournal({ minAgeMs: 0 })).entries, 1);
  assert.deepEqual(await readAtHead(T, W, "agents/a/outputs/pic.png"), png);
  assert.equal(mem.rows.size, 0);
});

test("a store that refuses the write leaves the change in memory (and says so); the commit still happens", async () => {
  const mem = memoryJournalStore();
  mem.put = () => {
    throw new Error("database down");
  };
  setRevisionBackend(deps, { ...ON, journalStore: mem });
  writeWorkspaceFile(T, W, "memory/a.md", "a\n", { by: "user:a" });
  assert.equal(pendingRevisions(), 1);
  await flushRevisions({ tenant: T, workspace: W });
  assert.equal((await readAtHead(T, W, "memory/a.md"))?.toString(), "a\n");
});

test("dropJournal clears the store and the volume", async () => {
  const mem = memoryJournalStore();
  const legacy = fsJournalStore(() => path.join(root, ".revision-journal"));
  legacy.put(rec("journalold0001"));
  mem.put(rec("journalnew0001"));
  setRevisionBackend(deps, { ...ON, journalStore: mem });
  dropJournal(T, W);
  assert.equal(mem.rows.size, 0);
  assert.equal(legacy.workspaces().length, 0);
});
