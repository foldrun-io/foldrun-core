// A folder entry must report the files it is made of, or a pull copies the
// manifest and leaves the program behind. Regression for 2026-09-16: the
// library listing is a catalogue of tools, and `foldrun pull` was reading it
// as a manifest of files — every script tool in the account library came
// down as tool.md alone.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

test("a folder tool lists its code beside its manifest", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-lib-"));
  const prev = process.env.FOLDRUN_WORKSPACE;
  try {
    fs.mkdirSync(path.join(root, "workspace"), { recursive: true });
    const tools = path.join(root, "library", "tools");
    fs.mkdirSync(path.join(tools, "web_browse"), { recursive: true });
    fs.writeFileSync(path.join(tools, "web_browse", "tool.md"), "---\nname: web_browse\nrun: run.mjs\n---\nbody\n");
    fs.writeFileSync(path.join(tools, "web_browse", "run.mjs"), "console.log(1)\n");
    // A flat tool is already whole: it should not grow a files list.
    fs.writeFileSync(path.join(tools, "email.md"), "---\nname: email\n---\nbody\n");

    process.env.FOLDRUN_WORKSPACE = path.join(root, "workspace");
    const { listLibrary } = await import("../src/library.ts?folderfiles");
    const entries = listLibrary("acme", "tools");

    const folder = entries.find((e) => e.path === "web_browse/tool.md");
    assert.ok(folder, "the folder tool is listed");
    assert.deepEqual(
      folder.files?.slice().sort(),
      ["web_browse/run.mjs", "web_browse/tool.md"],
      "its code comes with it, or a pull loses the program",
    );

    const flat = entries.find((e) => e.path === "email.md");
    assert.ok(flat, "the flat tool is listed");
    assert.equal(flat.files, undefined, "a single file is already its own whole");

    assert.equal(entries.length, 2, "the shelf still has two rows, not three — run.mjs is not a tool");
  } finally {
    if (prev === undefined) delete process.env.FOLDRUN_WORKSPACE;
    else process.env.FOLDRUN_WORKSPACE = prev;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
