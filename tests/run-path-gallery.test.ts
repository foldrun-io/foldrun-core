// A gallery tool nobody installed, run on the host. In a sandbox the gallery
// is laid down under the library, so `account/tools/<t>/…` is simply there;
// `foldrun run` on a laptop has no such merge, and an agent granting
// `web_browse` found no program to run.
//
//   node --test tests/run-path-gallery.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveRunPath } from "../src/script-tools.ts";
import { registerPlatform, resetPlatform } from "../src/platform.ts";

function tree() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "run-path-"));
  const agentDir = path.join(root, "ws", "agents", "a");
  const libScripts = path.join(root, "library", "scripts");
  const gallery = path.join(root, "gallery");
  fs.mkdirSync(agentDir, { recursive: true });
  fs.mkdirSync(libScripts, { recursive: true });
  fs.mkdirSync(path.join(gallery, "tools", "web_browse"), { recursive: true });
  fs.writeFileSync(path.join(gallery, "tools", "web_browse", "run.mjs"), "");
  return { root, agentDir, libScripts, gallery };
}

test("with no copy in the library, the gallery's program is the one that runs", () => {
  const t = tree();
  registerPlatform({ galleryDir: () => t.gallery });
  try {
    assert.equal(resolveRunPath(t.agentDir, "account/tools/web_browse/run.mjs", t.libScripts), path.join(t.gallery, "tools", "web_browse", "run.mjs"));
  } finally {
    resetPlatform();
    fs.rmSync(t.root, { recursive: true, force: true });
  }
});

test("an installed copy still wins over the gallery", () => {
  const t = tree();
  const own = path.join(t.root, "library", "tools", "web_browse", "run.mjs");
  fs.mkdirSync(path.dirname(own), { recursive: true });
  fs.writeFileSync(own, "");
  registerPlatform({ galleryDir: () => t.gallery });
  try {
    assert.equal(resolveRunPath(t.agentDir, "account/tools/web_browse/run.mjs", t.libScripts), own);
  } finally {
    resetPlatform();
    fs.rmSync(t.root, { recursive: true, force: true });
  }
});

test("with no gallery at all, the library path is answered as before", () => {
  const t = tree();
  try {
    assert.equal(resolveRunPath(t.agentDir, "account/tools/web_browse/run.mjs", t.libScripts), path.join(t.root, "library", "tools", "web_browse", "run.mjs"));
  } finally {
    fs.rmSync(t.root, { recursive: true, force: true });
  }
});
