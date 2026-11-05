// FOL-124: deleting a run — a person's, or the retention window's prune.
// Both take the record and its folder (archived outputs, captured calls) and
// note the index; only a person's writes the ledger's "run deleted" note,
// and a delete that failed halfway can be finished.
//
//   node --test tests/run-delete.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.FOLDRUN_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-run-delete-"));
const { deleteRun, writeRun, readRun, listRunSummaries, workspaceDir, registerRunDeletionListener } = await import("../src/store.ts");

const noted: string[] = [];
registerRunDeletionListener((_t, _w, id) => void noted.push(id));
fs.mkdirSync(path.join(process.env.FOLDRUN_DATA!, "acme/workspaces/desk"), { recursive: true });
fs.writeFileSync(path.join(process.env.FOLDRUN_DATA!, "acme/workspaces/desk/AGENTS.md"), "---\nname: desk\n---\n");

function run(id: string) {
  writeRun("acme", "desk", { id, flow: "daily", status: "completed", startedAt: "2026-11-01T00:00:00Z", finishedAt: "2026-11-01T00:01:00Z", steps: [] } as never);
  const dir = path.join(workspaceDir("acme", "desk"), "runs", id, "outputs", "writer");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "out.md"), "content");
}

test("a person's delete and the prune both take record and folder; only a person's notes the ledger", () => {
  run("run-person");
  run("run-pruned");
  assert.equal(deleteRun("acme", "desk", "run-person"), true);
  assert.equal(deleteRun("acme", "desk", "run-pruned", { pruned: true }), true);
  for (const id of ["run-person", "run-pruned"]) {
    assert.equal(readRun("acme", "desk", id), null);
    assert.ok(!fs.existsSync(path.join(workspaceDir("acme", "desk"), "runs", id)));
    assert.ok(!listRunSummaries("acme", "desk").some((r) => r.id === id));
  }
  assert.deepEqual(noted, ["run-person"], "the window's prune is policy: no per-run ledger note");
});

test("a delete that failed between the folder and the record is finished by the next one", () => {
  run("run-half");
  fs.rmSync(path.join(workspaceDir("acme", "desk"), "runs", "run-half.json"));
  assert.equal(deleteRun("acme", "desk", "run-half"), true);
  assert.ok(!fs.existsSync(path.join(workspaceDir("acme", "desk"), "runs", "run-half")));
  assert.equal(deleteRun("acme", "desk", "run-half"), false);
  assert.ok(!noted.includes("run-half"), "no record, no charge to explain");
});
