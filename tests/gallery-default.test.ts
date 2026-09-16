// The platform's built-in tools are a shelf every account reads without
// installing anything — beneath the account's own library, which wins by
// name. On a laptop there is no such shelf and nothing changes.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { registerPlatform, resetPlatform } from "../src/platform.ts";
import { libraryTools, writeLibraryFile } from "../src/library.ts";

const TOOL = (desc: string) => `---\ntransport: script\nname: web_search\nrun: run.mjs\ndescription: ${desc}\nargs:\n  query: what\n---\nbody\n`;

test("a gallery tool is granted by name in an account that never installed it", () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-gd-")); const prev = process.env.FOLDRUN_DATA;
  process.env.FOLDRUN_DATA = data;
  const gallery = path.join(data, "gallery");
  fs.mkdirSync(path.join(gallery, "tools", "web_search"), { recursive: true });
  fs.writeFileSync(path.join(gallery, "tools", "web_search", "tool.md"), TOOL("from the gallery"));
  fs.writeFileSync(path.join(gallery, "tools", "web_search", "run.mjs"), "console.log(1)\n");
  fs.mkdirSync(path.join(data, "acme"), { recursive: true });
  try {
    // No platform: a laptop. Nothing is granted that the account does not own.
    assert.equal(libraryTools("acme").web_search, undefined, "without a gallery there is nothing to find");

    registerPlatform({ galleryDir: () => gallery });
    const got = libraryTools("acme").web_search;
    assert.ok(got, "the gallery tool is on the account's shelf");
    assert.equal(got.kind, "script");
    // Read at account scope, so the sandbox path is /library/tools/web_search/run.mjs —
    // the same place the staging step puts the gallery copy.
    assert.equal((got.spec as { run?: string }).run, "account/tools/web_search/run.mjs");

    // The account installs (copies) its own: the copy shadows the gallery.
    writeLibraryFile("acme", "tools", "web_search/tool.md", TOOL("the account's own copy"));
    assert.match(JSON.stringify(libraryTools("acme").web_search), /account's own copy/, "the account's copy shadows the gallery's");
  } finally {
    resetPlatform();
    if (prev === undefined) delete process.env.FOLDRUN_DATA; else process.env.FOLDRUN_DATA = prev;
    fs.rmSync(data, { recursive: true, force: true });
  }
});
