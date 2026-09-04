// Archiving a run's outputs.
//
// The bug this guards: archiving used fs.cpSync, whose clone/copy_file_range
// path can report success and leave a zero-length file on bind-mounted and
// network volumes — which is exactly where a hosted install keeps its data.
// Every archived output was empty and nothing said so, which is the worst
// shape a bug can take. Found by running the product, not by a test, so the
// test exists now.
//
//   node --test tests/archive.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { copyTreeBytes } from "../packages/core/src/runner.ts";

function withTmp(body: (dir: string) => void) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-archive-"));
  try {
    body(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("the bytes arrive, at every depth", () => {
  withTmp((dir) => {
    const from = path.join(dir, "outputs");
    fs.mkdirSync(path.join(from, "nested/deeper"), { recursive: true });
    fs.writeFileSync(path.join(from, "note.md"), "ALIVE\n");
    fs.writeFileSync(path.join(from, "nested/deep.md"), "also here\n");
    fs.writeFileSync(path.join(from, "nested/deeper/deepest.md"), "and here\n");

    const to = path.join(dir, "archive");
    copyTreeBytes(from, to);

    assert.equal(fs.readFileSync(path.join(to, "note.md"), "utf8"), "ALIVE\n");
    assert.equal(fs.readFileSync(path.join(to, "nested/deep.md"), "utf8"), "also here\n");
    assert.equal(fs.readFileSync(path.join(to, "nested/deeper/deepest.md"), "utf8"), "and here\n");
  });
});

test("the archive is readable whatever mode the container left behind", () => {
  withTmp((dir) => {
    const from = path.join(dir, "outputs");
    fs.mkdirSync(from, { recursive: true });
    const src = path.join(from, "note.md");
    fs.writeFileSync(src, "written by a stranger's umask\n");
    // Owner-only, as a container's umask leaves things — the platform still
    // has to be able to serve this back to the dashboard afterwards.
    fs.chmodSync(src, 0o600);

    const to = path.join(dir, "archive");
    copyTreeBytes(from, to);

    const archived = path.join(to, "note.md");
    assert.equal(fs.readFileSync(archived, "utf8"), "written by a stranger's umask\n");
    assert.equal(fs.statSync(archived).mode & 0o044, 0o044, "not owner-only any more");
  });
});

test("an empty tree copies to an empty tree, not to an error", () => {
  withTmp((dir) => {
    const from = path.join(dir, "outputs");
    fs.mkdirSync(from, { recursive: true });
    const to = path.join(dir, "archive");
    copyTreeBytes(from, to);
    assert.deepEqual(fs.readdirSync(to), []);
  });
});
