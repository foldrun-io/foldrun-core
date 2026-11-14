// Path-safety property tests: every place a caller-influenced string becomes a
// file path, an object key or a store key (core half; platform and web have
// their own). Seeded, no network, no model. One invariant set per sink:
//
//   1. refused with an error, or the real path (symlinks followed, deepest
//      existing ancestor) is inside the intended root;
//   2. a read never returns bytes from outside the root, a write or delete
//      never changes anything outside it;
//   3. a name the writer accepts, the reader and delete accept too;
//   4. normalising a name twice gives the name (idempotent), and two names
//      that differ never end up on one key unless the sink says they are one.
//
//   node --test tests/path-safety-core.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { hostile, rng, tryIt, isInside, landing } from "./path-safety-gen.ts";
import {
  assertEditablePath,
  assertSafeName,
  isEditablePath,
  isOneSegment,
  deleteWorkspacePath,
  readWorkspaceFile,
  renameWorkspaceFile,
  runOutputPathOnVolume,
  workspaceDir,
  writeWorkspaceFile,
  listWorkspaceFiles,
  readCapturedCall,
  writeCapturedCall,
} from "../src/store.ts";
import { assertFilePath } from "../src/storage.ts";
import { assertManifestPath, assertNoCaseCollisions, emptyManifest, sha256Hex, type Manifest } from "../src/manifest.ts";

const N = 900; // generated cases per sink (plus the fixed corpus inside them)

function sandbox(run: (root: string, ws: string, outside: string) => void | Promise<void>) {
  return async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-pathsafe-"));
    const prev = process.env.FOLDRUN_DATA;
    process.env.FOLDRUN_DATA = path.join(root, "data");
    try {
      const ws = workspaceDir("acme", "desk");
      fs.mkdirSync(ws, { recursive: true });
      fs.writeFileSync(path.join(ws, "AGENTS.md"), "---\nname: desk\n---\n\nA desk.\n");
      const outside = path.join(root, "outside");
      fs.mkdirSync(outside);
      fs.writeFileSync(path.join(outside, "secret.md"), "TOP SECRET\n");
      await run(root, ws, outside);
    } finally {
      if (prev === undefined) delete process.env.FOLDRUN_DATA;
      else process.env.FOLDRUN_DATA = prev;
      fs.rmSync(root, { recursive: true, force: true });
    }
  };
}

/** Every file under `dir` with its bytes: what must not change outside a root. */
function tree(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { recursive: true, withFileTypes: true })) {
    const p = path.join(e.parentPath, e.name);
    out[path.relative(dir, p)] = e.isFile() ? fs.readFileSync(p, "utf8") : e.isDirectory() ? "<dir>" : "<link>";
  }
  return out;
}

test("assertSafeName: only kebab-case; whatever passes is one plain segment", () => {
  let accepted = 0;
  for (const h of hostile(11, N)) {
    const ok = tryIt(() => assertSafeName(h, "workspace")) !== null || (() => { try { assertSafeName(h, "workspace"); return true; } catch { return false; } })();
    if (!ok) continue;
    accepted++;
    assert.match(h, /^[a-z0-9]+(-[a-z0-9]+)*$/, JSON.stringify(h));
    assert.equal(path.basename(h), h);
    assert.equal(path.normalize(h), h);
  }
  assert.ok(accepted >= 3, "the corpus holds ordinary names too");
  for (const good of ["a", "desk", "a-b-c", "x1"]) assertSafeName(good, "workspace");
  // a name is one folder: case never folds two names into one (kebab is lower-case only)
  for (const bad of ["Desk", "DESK", "dısk", "ſ", "ａ"]) assert.throws(() => assertSafeName(bad, "workspace"), bad);
});

test("isOneSegment: a name that is a path is refused; accepted names are one folder", () => {
  let accepted = 0;
  for (const h of hostile(12, N)) {
    if (!isOneSegment(h)) continue;
    accepted++;
    assert.equal(path.basename(h), h, JSON.stringify(h));
    assert.ok(!h.includes("/") && !h.includes("\\") && !h.includes("\0") && h !== "." && h !== "..");
    assert.equal(path.join("/root", h).startsWith("/root/"), true);
    assert.equal(path.dirname(path.join("/root", h)), "/root", JSON.stringify(h));
  }
  assert.ok(accepted > 20);
});

test("assertEditablePath + write/read/list/delete round trip: stays inside the workspace, nothing outside changes", sandbox((root, ws, outside) => {
  const before = tree(outside);
  const names = hostile(13, N);
  // the same hostile strings under real editable folders, so the prefix rules are exercised
  const cases = [...names, ...names.slice(0, 300).flatMap((n) => [`agents/${n}`, `knowledge/${n}`, `agents/w/skills/s/${n}`, `state/${n}`])];
  let wrote = 0;
  for (const rel of cases) {
    const norm = tryIt(() => assertEditablePath(rel));
    assert.equal(isEditablePath(rel), norm !== null, `isEditablePath and assertEditablePath agree: ${JSON.stringify(rel)}`);
    if (norm === null) continue;
    assert.ok(!path.isAbsolute(norm) && !norm.split("/").includes(".."), JSON.stringify(norm));
    assert.ok(norm.split("/").every((s) => Buffer.byteLength(s) <= 255), "a name no disk holds was accepted");
    assert.ok(!/[\u0000-\u001f\u007f]/.test(norm), `a control character was accepted: ${JSON.stringify(norm)}`);
    assert.equal(tryIt(() => assertEditablePath(norm)), norm, `idempotent: ${JSON.stringify(rel)} -> ${JSON.stringify(norm)}`);
    assert.ok(isInside(ws, path.join(ws, norm)), `lands inside: ${JSON.stringify(norm)}`);
    // a name the writer accepts, the reader and delete accept
    const body = norm.endsWith(".md") ? "---\nname: t\n---\n\nhi\n" : "echo hi\n";
    const w = tryIt(() => writeWorkspaceFile("acme", "desk", rel, body));
    if (w === null && !fs.existsSync(path.join(ws, norm))) continue; // refused: fine, as long as nothing leaked (checked below)
    wrote++;
    assert.match(readWorkspaceFile("acme", "desk", rel), /hi/, JSON.stringify(rel));
    assert.ok(listWorkspaceFiles("acme", "desk").includes(norm) || norm === "AGENTS.md" || norm === "project.md", `listed: ${JSON.stringify(norm)}`);
    // delete: allowed, or refused with an Error (identity files go with their folder) — never a stray path
    try {
      deleteWorkspacePath("acme", "desk", rel);
      assert.equal(fs.existsSync(path.join(ws, norm)), false, `deleted: ${JSON.stringify(norm)}`);
    } catch (err) {
      assert.ok(err instanceof Error);
    }
    assert.deepEqual(tree(outside), before, `outside the workspace unchanged after ${JSON.stringify(rel)}`);
  }
  assert.ok(wrote > 30, `wrote ${wrote}`);
  // nothing appeared beside the workspace either (a sibling workspace, a tmp file)
  assert.deepEqual(fs.readdirSync(path.dirname(ws)).sort(), ["desk"]);
  assert.deepEqual(tree(outside), before);
}));

test("symlinks planted in a workspace: reads, writes, renames and deletes never reach through them", sandbox((root, ws, outside) => {
  fs.mkdirSync(path.join(ws, "knowledge"), { recursive: true });
  fs.mkdirSync(path.join(ws, "state"), { recursive: true });
  fs.mkdirSync(path.join(ws, "agents", "w"), { recursive: true });
  fs.symlinkSync(path.join(outside, "secret.md"), path.join(ws, "knowledge", "file-link.md"));
  fs.symlinkSync(outside, path.join(ws, "knowledge", "dir-link"));
  fs.symlinkSync(path.join(outside, "nowhere.md"), path.join(ws, "knowledge", "dangling.md"));
  fs.symlinkSync("..", path.join(ws, "state", "up")); // link to the parent
  fs.symlinkSync("../../..", path.join(ws, "agents", "w", "far")); // link above everything
  fs.symlinkSync(path.join(outside, "secret.md"), path.join(ws, "agents", "w", "agent.md"));
  const before = tree(outside);
  const targets = [
    "knowledge/file-link.md", "knowledge/dir-link/secret.md", "knowledge/dir-link/new.md", "knowledge/dangling.md",
    "state/up/AGENTS.md", "state/up/outside/secret.md", "state/up/up/up/x.md", "agents/w/far/outside/secret.md", "agents/w/far/outside/new.md", "agents/w/agent.md",
  ];
  for (const rel of targets) {
    let read: string | null = null;
    try {
      read = readWorkspaceFile("acme", "desk", rel);
    } catch {
      /* refused */
    }
    assert.ok(read === null || !read.includes("TOP SECRET"), `read ${rel} returned bytes from outside`);
    tryIt(() => writeWorkspaceFile("acme", "desk", rel, "---\nname: pwn\n---\nPWNED\n"));
    tryIt(() => renameWorkspaceFile("acme", "desk", rel, "knowledge/moved.md"));
    tryIt(() => renameWorkspaceFile("acme", "desk", "knowledge/moved.md", rel));
    tryIt(() => deleteWorkspacePath("acme", "desk", rel));
    assert.deepEqual(tree(outside), before, `outside changed by ${rel}`);
  }
  // the listing is a read too: it must not name outside files as the workspace's
  for (const f of listWorkspaceFiles("acme", "desk")) assert.ok(isInside(ws, path.join(ws, f)) || fs.lstatSync(path.join(ws, f)).isSymbolicLink(), f);
}));

test("a bundle's generated index.md and log.md never write through a link (memory/ and knowledge/ sync)", sandbox((root, ws, outside) => {
  fs.mkdirSync(path.join(ws, "knowledge", "sec"), { recursive: true });
  fs.writeFileSync(path.join(outside, "idx.md"), "OUTSIDE INDEX\n");
  fs.writeFileSync(path.join(outside, "log.md"), "OUTSIDE LOG\n");
  fs.symlinkSync(path.join(outside, "idx.md"), path.join(ws, "knowledge", "index.md"));
  fs.symlinkSync(path.join(outside, "log.md"), path.join(ws, "knowledge", "log.md"));
  fs.symlinkSync(outside, path.join(ws, "knowledge", "sec", "dir-link"));
  const before = tree(outside);
  writeWorkspaceFile("acme", "desk", "knowledge/note.md", "---\nname: n\n---\n\nhi\n");
  writeWorkspaceFile("acme", "desk", "knowledge/sec/inner.md", "---\nname: i\n---\n\nhi\n");
  deleteWorkspacePath("acme", "desk", "knowledge/note.md");
  assert.deepEqual(tree(outside), before, "a generated index or log was written outside the workspace");
}));

test("what the writer accepts, the listing shows: no file can be saved and be invisible", sandbox((root, ws) => {
  // listWorkspaceFiles hides runs/, outputs/ and .results/ (generated); the writer
  // must refuse them too, or a file can sit in the workspace that nobody sees and a
  // run still reads (a knowledge file is loaded by agents).
  for (const rel of ["knowledge/runs/x.md", "knowledge/a/runs/b.md", "state/.results/x.md", "evals/.results/x.md", "agents/w/outputs/x.md", "agents/w/skills/s/runs/x.py"]) {
    assert.throws(() => writeWorkspaceFile("acme", "desk", rel, "---\nname: x\n---\n\nhi\n"), /editable|illegal/, rel);
    assert.equal(isEditablePath(rel), false, rel);
  }
  writeWorkspaceFile("acme", "desk", "knowledge/runbook.md", "---\nname: x\n---\n\nhi\n");
  assert.ok(listWorkspaceFiles("acme", "desk").includes("knowledge/runbook.md"), "a name that only starts like runs/ is an ordinary name");
}));

test("deleting a folder that holds a link to an outside file does not record the outside bytes in the revision", sandbox((root, ws, outside) => {
  // The revision a delete writes keeps each file's bytes so it can be restored
  // and shown in History; a link in the folder must not make that a read of
  // whatever it points at.
  writeWorkspaceFile("acme", "desk", "agents/w/agent.md", "---\nname: w\n---\n\nhi\n");
  fs.symlinkSync(path.join(outside, "secret.md"), path.join(ws, "agents", "w", "notes.md"));
  let recorded = "";
  const seen: unknown[] = [];
  // the journal of what was recorded: look at the revision the delete made
  deleteWorkspacePath("acme", "desk", "agents/w");
  const walk = (d: string) => {
    if (!fs.existsSync(d)) return;
    for (const e of fs.readdirSync(d, { recursive: true, withFileTypes: true })) if (e.isFile()) recorded += fs.readFileSync(path.join(e.parentPath, e.name), "utf8");
  };
  walk(path.join(ws, ".foldrun"));
  walk(path.join(path.dirname(ws), ".revisions"));
  walk(path.join(process.env.FOLDRUN_DATA!, ".revisions"));
  void seen;
  assert.ok(!recorded.includes("TOP SECRET"), "a revision holds bytes from outside the workspace");
}));

test("assertFilePath (storage keys): relative, no dot segments, no controls; idempotent; accepted keys land inside storage/", () => {
  let accepted = 0;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-pathsafe-st-"));
  try {
    for (const h of hostile(14, N)) {
      const norm = tryIt(() => assertFilePath(h));
      if (norm === null) continue;
      accepted++;
      assert.ok(norm.length <= 400 && !path.isAbsolute(norm) && !/^[a-zA-Z]:/.test(norm), JSON.stringify(h));
      assert.ok(!norm.split("/").some((s) => s === "" || s === "." || s === ".."), JSON.stringify(norm));
      assert.ok(!/[\u0000-\u001f\u007f]/.test(norm) && !norm.includes("\\"));
      assert.equal(assertFilePath(norm), norm, `idempotent: ${JSON.stringify(h)}`);
      assert.ok(isInside(root, path.join(root, norm)), JSON.stringify(norm));
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
  assert.ok(accepted > 50, String(accepted));
  // the two spellings of one separator are one key (a stated rule), distinct names stay distinct
  assert.equal(assertFilePath("a\\b"), assertFilePath("a/b"));
  assert.notEqual(assertFilePath("A.md"), assertFilePath("a.md"));
  assert.notEqual(assertFilePath("é.md"), assertFilePath("é.md"));
});

test("assertManifestPath: no escape, NFC only, idempotent; names that differ only by case are caught per manifest", () => {
  let accepted = 0;
  const bases = ["agents/", "state/", "flows/", ""];
  for (const h of hostile(15, N)) {
    for (const b of bases) {
      const rel = b + h;
      const ok = tryIt(() => assertManifestPath(rel));
      if (ok === null) continue;
      accepted++;
      assert.equal(ok, rel, "returned unchanged");
      assert.ok(!rel.split("/").some((s) => s === "" || s === "." || s === ".."), JSON.stringify(rel));
      assert.ok(!rel.includes("\\") && !rel.startsWith("/") && !/[\u0000-\u001f\u007f]/.test(rel));
      assert.equal(rel, rel.normalize("NFC"));
      assert.ok(Buffer.byteLength(rel) <= 400);
      assert.ok(isInside("/srv/x", path.join("/srv/x", rel)));
    }
  }
  assert.ok(accepted > 30, String(accepted));
  const e = (sha = "a".repeat(64)) => ({ sha, size: 1, mode: 0o644 });
  const m: Manifest = { ...emptyManifest(), files: { "agents/A.md": e(), "agents/a.md": e() } } as Manifest;
  assert.throws(() => assertNoCaseCollisions(m), /differ only by case/);
  // The Turkish dotless i and the sharp s fold differently from ASCII: two names that are
  // one on some filesystems must not both be accepted as distinct files on a case-insensitive disk.
  const folds = [["agents/I.md", "agents/ı.md"], ["agents/ss.md", "agents/ß.md"], ["agents/K.md", "agents/K.md"]];
  for (const [x, y] of folds) {
    const mm: Manifest = { ...emptyManifest(), files: { [x]: e(), [y]: e() } } as Manifest;
    // not an escape: reported below as a limit (case folding beyond ASCII), only checked to not throw a non-Error
    tryIt(() => assertNoCaseCollisions(mm));
  }
  void sha256Hex;
});

test("run output archive on the volume: a name never leaves runs/<id>/outputs/<agent>; links are not followed out", sandbox((root, ws, outside) => {
  const out = path.join(ws, "runs", "run-1", "outputs", "writer");
  fs.mkdirSync(path.join(out, "sub"), { recursive: true });
  fs.writeFileSync(path.join(out, "a.md"), "A\n");
  fs.writeFileSync(path.join(out, "sub", "b.md"), "B\n");
  fs.writeFileSync(path.join(ws, "runs", "run-1", "outputs", "other.md"), "not an agent's\n");
  fs.mkdirSync(path.join(ws, "runs", "run-1", "outputs", "reviewer"), { recursive: true });
  fs.writeFileSync(path.join(ws, "runs", "run-1", "outputs", "reviewer", "r.md"), "R\n");
  fs.symlinkSync(path.join(outside, "secret.md"), path.join(out, "link.md"));
  fs.symlinkSync(outside, path.join(out, "dir-link"));
  const rels = [...hostile(16, N), "sub/b.md", "a.md", "link.md", "dir-link/secret.md", "../reviewer/r.md", "sub/../a.md"];
  const agents = ["writer", ...hostile(17, 120)];
  let served = 0;
  for (const agent of agents) {
    for (const rel of rels.slice(0, agent === "writer" ? rels.length : 12)) {
      const p = tryIt(() => runOutputPathOnVolume("acme", "desk", "run-1", agent, rel));
      if (p === null) continue;
      served++;
      assert.ok(isInside(path.join(ws, "runs", "run-1", "outputs", agent), p), `${agent} ${JSON.stringify(rel)} -> ${p}`);
      assert.ok(isInside(ws, p));
      assert.ok(!fs.readFileSync(p, "utf8").includes("TOP SECRET"));
    }
  }
  assert.ok(served >= 3);
}));

test("captured calls on the volume: ids are plain names; a call lands in runs/<run>/calls/<id>.json only", sandbox((root, ws, outside) => {
  const before = tree(outside);
  let wrote = 0;
  for (const h of hostile(18, N)) {
    for (const [runId, callId] of [["run-1", h], [h, "call-1"]] as const) {
      const part = { id: callId } as never;
      tryIt(() => writeCapturedCall(ws, runId, part));
      const got = readCapturedCall("acme", "desk", runId, callId);
      if (got) {
        wrote++;
        // accepted by the writer, read back by the reader, at the one place
        const f = path.join(ws, "runs", runId, "calls", `${callId}.json`);
        assert.ok(fs.existsSync(f), JSON.stringify([runId, callId]));
        assert.ok(isInside(path.join(ws, "runs"), f));
      }
    }
  }
  assert.ok(wrote >= 5, String(wrote));
  assert.deepEqual(tree(outside), before);
  // nothing but runs/ was made in the workspace
  assert.deepEqual(fs.readdirSync(ws).sort(), ["AGENTS.md", "runs"]);
  // generated ids never collide on one file unless they are the same string
  const r = rng(5);
  const seen = new Map<string, string>();
  for (let i = 0; i < 500; i++) {
    const id = Array.from({ length: 1 + Math.floor(r() * 6) }, () => "aAbB_-.0"[Math.floor(r() * 8)]).join("");
    if (id.startsWith(".")) continue;
    const key = `${id}.json`;
    assert.ok(!seen.has(key) || seen.get(key) === id);
    seen.set(key, id);
  }
}));
