// The manifest vocabulary (FOL-126, phase 1): what a path may be, which side
// it is on, and that one tree has one id on every machine.
//
//   node --test tests/manifest.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  assertManifestPath, sideOf, manifestId, canonicalManifest, parseManifest, applyChanges, diffManifests,
  conflictPath, entryId, assertNoCaseCollisions, blobObjectKey, manifestObjectKey, AUTHORED_DIRS, STATE_DIRS, MODE_FILE, MODE_EXEC, sha256Hex, type Manifest,
} from "../src/manifest.ts";
import { WORKSPACE_DIRS } from "../src/store.ts";

const e = (s: string, size = 1, mode = MODE_FILE) => ({ sha: sha256Hex(s), size, mode });

test("every WORKSPACE_DIRS entry is on exactly one side; only state/ is state", () => {
  for (const d of WORKSPACE_DIRS) assert.equal(sideOf(`${d}/x.md`), d === "state" ? "state" : "authored", d);
  assert.ok(!AUTHORED_DIRS.includes("state"));
  assert.equal(sideOf("AGENTS.md"), "authored");
  assert.equal(sideOf("project.md"), "authored");
});

test("storage/, runs/, records and dot-folders belong to no manifest", () => {
  for (const p of ["storage/a.csv", "runs/r1/out.md", "secrets.json", "trigger-log.jsonl", "hook-deliveries.jsonl", ".git/config", "node_modules/x", "agents"]) {
    assert.equal(sideOf(p), null, p);
    assert.throws(() => assertManifestPath(p), /not workspace content|illegal/);
  }
});

test("paths: forward slashes only, relative, no dot segments, no control characters, bounded", () => {
  for (const bad of ["", "/agents/a.md", "agents\\a.md", "agents/../x", "agents/./a.md", "agents//a.md", "C:/x", "agents/a\u0000.md", "agents/" + "x".repeat(400)]) {
    assert.throws(() => assertManifestPath(bad), /illegal manifest path|not workspace content/, JSON.stringify(bad));
  }
  assert.equal(assertManifestPath("agents/ünï/agent.md"), "agents/ünï/agent.md");
});

test("one tree, one id — whatever order the keys were built in", () => {
  const a: Manifest = { v: 1, files: { "agents/b.md": e("b"), "agents/a.md": e("a") } };
  const b: Manifest = { v: 1, files: { "agents/a.md": e("a"), "agents/b.md": e("b") } };
  assert.equal(manifestId(a), manifestId(b));
  assert.equal(canonicalManifest(a), canonicalManifest(b));
  assert.notEqual(manifestId(a), manifestId({ v: 1, files: { "agents/a.md": e("a"), "agents/b.md": { ...e("b"), mode: MODE_EXEC } } }), "the mode is part of the tree");
});

test("a manifest read back validates its paths, hashes, sizes and modes", () => {
  const m: Manifest = { v: 1, files: { "scripts/run.sh": e("x", 1, MODE_EXEC) } };
  assert.deepEqual(parseManifest(canonicalManifest(m)), m);
  for (const bad of ['{"v":2,"files":{}}', '{"v":1}', '{"v":1,"files":{"storage/x":{"sha":"' + "a".repeat(64) + '","size":1,"mode":420}}}', '{"v":1,"files":{"agents/a.md":{"sha":"zz","size":1,"mode":420}}}', '{"v":1,"files":{"agents/a.md":{"sha":"' + "a".repeat(64) + '","size":-1,"mode":420}}}', '{"v":1,"files":{"agents/a.md":{"sha":"' + "a".repeat(64) + '","size":1,"mode":511}}}']) {
    assert.throws(() => parseManifest(bad), undefined, bad);
  }
});

test("diff then apply round-trips, and a diff carries the base shas", () => {
  const from: Manifest = { v: 1, files: { "agents/a.md": e("1"), "agents/gone.md": e("g") } };
  const to: Manifest = { v: 1, files: { "agents/a.md": e("2"), "agents/new.md": e("n") } };
  const d = diffManifests(from, to);
  assert.deepEqual(d["agents/a.md"], { op: "put", base: entryId(e("1")), ...e("2") });
  assert.deepEqual(d["agents/new.md"], { op: "put", base: null, ...e("n") });
  assert.deepEqual(d["agents/gone.md"], { op: "delete", base: entryId(e("g")) });
  assert.equal(manifestId(applyChanges(from, d)), manifestId(to));
});

test("a conflict copy is named beside the original, the same every time for one op", () => {
  assert.equal(conflictPath("memory/log.md", "op-1"), conflictPath("memory/log.md", "op-1"));
  assert.notEqual(conflictPath("memory/log.md", "op-1"), conflictPath("memory/log.md", "op-2"));
  assert.match(conflictPath("memory/log.md", "op-1"), /^memory\/log\.conflict-[0-9a-f]{12}\.md$/);
  assert.match(conflictPath("AGENTS.md", "op-1"), /^AGENTS\.conflict-[0-9a-f]{12}\.md$/);
  assert.match(conflictPath("tools/Makefile", "op-1"), /^tools\/Makefile\.conflict-[0-9a-f]{12}$/);
});

test("object keys are tenant-first and refuse anything that is not a hash or a safe tenant", () => {
  const sha = "a".repeat(64);
  assert.equal(blobObjectKey("acme", sha), `t/acme/blobs/${sha}`);
  assert.equal(manifestObjectKey("acme", sha), `t/acme/manifests/${sha}.json`);
  assert.throws(() => blobObjectKey("../x", sha));
  assert.throws(() => blobObjectKey("acme", "../../etc"));
});

test("manifest v1's roots are frozen: if WORKSPACE_DIRS changes, this fails and someone decides", () => {
  assert.deepEqual([...AUTHORED_DIRS, ...STATE_DIRS].sort(), [...WORKSPACE_DIRS].sort());
});

test("a mode-only change is a change: the identity is sha AND mode", () => {
  const from: Manifest = { v: 1, files: { "scripts/run.sh": e("x", 1, MODE_FILE) } };
  const to: Manifest = { v: 1, files: { "scripts/run.sh": e("x", 1, MODE_EXEC) } };
  assert.notEqual(entryId(from.files["scripts/run.sh"]), entryId(to.files["scripts/run.sh"]));
  assert.equal(Object.keys(diffManifests(from, to)).length, 1);
  assert.notEqual(manifestId(from), manifestId(to));
});

test("a root file's conflict copy is a legal root path; other root files are not", () => {
  const kept = conflictPath("AGENTS.md", "op-1");
  assert.equal(sideOf(kept), "authored");
  assert.equal(assertManifestPath(kept), kept);
  assert.equal(assertManifestPath(conflictPath("AGENTS.md", "op-1", 2)), conflictPath("AGENTS.md", "op-1", 2));
  assert.equal(sideOf("other.md"), null);
  assert.equal(sideOf("AGENTS.conflict-zzzz.md"), null);
});

test("paths are NFC, and names that differ only by case cannot share a manifest", () => {
  const decomposed = "memory/cafe\u0301.md";
  assert.throws(() => assertManifestPath(decomposed), /NFC/);
  assert.equal(assertManifestPath(decomposed.normalize("NFC")), decomposed.normalize("NFC"));
  assert.throws(() => assertNoCaseCollisions({ v: 1, files: { "memory/Notes.md": e("a"), "memory/notes.md": e("b") } }), /differ only by case/);
  assert.doesNotThrow(() => assertNoCaseCollisions({ v: 1, files: { "memory/Notes.md": e("a"), "memory/Other.md": e("b") } }));
  assert.throws(() => assertManifestPath("memory/" + "é".repeat(250)), /illegal manifest path/, "400 BYTES, not 400 characters");
});
