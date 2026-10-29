// FOL-83: a symlink inside a workspace no longer leads reads and writes out.
//
// assertEditablePath and runOutputPath checked the path as written, so a link
// planted in a workspace — a file → /etc/passwd, a folder → / — passed, and
// GET /source read through it, PUT /source overwrote (or created) a file
// outside, and the run archive served it (live check, 29 Oct). Nothing on the
// hosted tiers can plant one today (copy-out skips links at both layers); this
// is the backstop for the day something can. A link that stays inside — the
// `agents/<a>/workspace` link a laptop step holds — keeps working.
//
//   node --test tests/symlink-containment.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  workspaceDir,
  readWorkspaceFile,
  writeWorkspaceFile,
  renameWorkspaceFile,
  deleteWorkspacePath,
  runOutputPath,
} from "../src/store.ts";

const TENANT = "fol83-links";
const WS = "desk";
const dir = workspaceDir(TENANT, WS);
const outside = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-outside-"));
fs.mkdirSync(path.join(dir, "knowledge"), { recursive: true });
fs.mkdirSync(path.join(dir, "skills"), { recursive: true });
fs.writeFileSync(path.join(dir, "AGENTS.md"), `---\nname: ${WS}\n---\n`);
fs.writeFileSync(path.join(outside, "secret.md"), "outside-secret\n");
fs.writeFileSync(path.join(outside, "victim.md"), "untouched\n");

const link = (target: string, at: string) => fs.symlinkSync(target, path.join(dir, at));
link(path.join(outside, "secret.md"), "knowledge/leak.md");
link(path.join(outside, "victim.md"), "skills/victim.md");
link(outside, "knowledge/out");
link(path.join(outside, "nothing-here.md"), "knowledge/dangling.md");
fs.writeFileSync(path.join(dir, "knowledge/inside.md"), "inside\n");
link(path.join(dir, "knowledge/inside.md"), "knowledge/alias.md");

const refused = /illegal path: .* leads out of the workspace through a symlink/;

test("read: a file link and a folder link out are refused; one that stays inside reads", () => {
  assert.throws(() => readWorkspaceFile(TENANT, WS, "knowledge/leak.md"), refused);
  assert.throws(() => readWorkspaceFile(TENANT, WS, "knowledge/out/secret.md"), refused);
  assert.equal(readWorkspaceFile(TENANT, WS, "knowledge/alias.md"), "inside\n");
});

test("write: overwriting through a file link is refused and the outside file is untouched", () => {
  assert.throws(() => writeWorkspaceFile(TENANT, WS, "skills/victim.md", "OVERWRITTEN"), refused);
  assert.equal(fs.readFileSync(path.join(outside, "victim.md"), "utf8"), "untouched\n");
  assert.throws(() => writeWorkspaceFile(TENANT, WS, "knowledge/dangling.md", "x"), refused, "a dangling link is not followed either");
  assert.ok(!fs.existsSync(path.join(outside, "nothing-here.md")));
});

test("write: a new file through a folder link is refused, nothing is created outside", () => {
  assert.throws(() => writeWorkspaceFile(TENANT, WS, "knowledge/out/planted.md", "PLANTED"), refused);
  assert.throws(() => writeWorkspaceFile(TENANT, WS, "knowledge/out/deeper/planted.md", "PLANTED"), refused);
  assert.deepEqual(fs.readdirSync(outside).sort(), ["secret.md", "victim.md"]);
  writeWorkspaceFile(TENANT, WS, "knowledge/fresh.md", "fine");
  assert.equal(readWorkspaceFile(TENANT, WS, "knowledge/fresh.md"), "fine\n", "an ordinary new file still writes");
});

test("rename and delete never reach through a folder link; the link itself can still be removed", () => {
  assert.throws(() => renameWorkspaceFile(TENANT, WS, "knowledge/out/secret.md", "knowledge/stolen.md"), refused);
  assert.throws(() => renameWorkspaceFile(TENANT, WS, "knowledge/inside.md", "knowledge/out/moved.md"), refused);
  assert.throws(() => deleteWorkspacePath(TENANT, WS, "knowledge/out/secret.md"), refused);
  assert.ok(fs.existsSync(path.join(outside, "secret.md")));
  deleteWorkspacePath(TENANT, WS, "knowledge/leak.md");
  assert.ok(!fs.existsSync(path.join(dir, "knowledge/leak.md")), "the link is gone");
  assert.ok(fs.existsSync(path.join(outside, "secret.md")), "what it named is not");
});

test("run archive: an output that links out is not served; a real one is", () => {
  const run = "run-fol83-links";
  const out = path.join(dir, "runs", run, "outputs", "writer");
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, "report.md"), "# report\n");
  fs.symlinkSync(path.join(outside, "secret.md"), path.join(out, "leak.md"));
  fs.symlinkSync(outside, path.join(out, "dir"));
  assert.equal(runOutputPath(TENANT, WS, run, "writer", "leak.md"), null);
  assert.equal(runOutputPath(TENANT, WS, run, "writer", "dir/secret.md"), null);
  assert.ok(runOutputPath(TENANT, WS, run, "writer", "report.md")?.endsWith("report.md"));
});

test("a first write into a workspace not made yet, under a linked data folder, is not refused", () => {
  // FOLDRUN_DATA reached through a link (macOS /tmp → /private/tmp): the
  // workspace's own folder does not exist yet, so its root is canonicalised
  // through its nearest real ancestor, as the written path is.
  const real = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-real-data-"));
  const linked = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-link-")), "data");
  fs.symlinkSync(real, linked);
  const was = process.env.FOLDRUN_DATA;
  process.env.FOLDRUN_DATA = linked;
  try {
    assert.ok(!fs.existsSync(workspaceDir(TENANT, "fresh")));
    writeWorkspaceFile(TENANT, "fresh", "AGENTS.md", "---\nname: fresh\n---\n");
    assert.ok(fs.existsSync(path.join(real, TENANT, "workspaces", "fresh", "AGENTS.md")));
  } finally {
    if (was === undefined) delete process.env.FOLDRUN_DATA;
    else process.env.FOLDRUN_DATA = was;
  }
});
