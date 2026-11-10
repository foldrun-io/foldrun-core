// The data importer against the local implementations (fs blobs + local
// revisions); the Postgres pairing runs in foldrun-platform.
//
//   node --test tests/data-import.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { fsBlobStore, bounded } from "../src/blob-store.ts";
import { localRevisionStore } from "../src/revision-store.ts";
import { blobObjectKey } from "../src/manifest.ts";
import { placeCaseVariants, runImport, scanSource, verifyImport } from "../src/data-import.ts";
import { dataImportSuite } from "./data-import-suite.ts";
import { buildSource, BIG } from "./data-import-fixture.ts";
import { sha256Hex } from "../src/manifest.ts";

const harness = async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-imp-dest-"));
  return {
    root,
    deps: { blobs: bounded(fsBlobStore(path.join(root, "objects")), { backoffMs: 1 }), revisions: localRevisionStore(path.join(root, "revs")) },
    cleanup: async () => fs.rmSync(root, { recursive: true, force: true }),
  };
};

dataImportSuite("fs + local", harness);

test("a deep verify catches a blob whose bytes were changed in place; the shallow one cannot", async () => {
  const h = await harness();
  const src = buildSource();
  try {
    const scan = await scanSource({ source: src, workspaces: ["acme/desk"] });
    await runImport(scan, { deps: h.deps });
    // same size, other bytes, on the object the large file lives in
    const sha = sha256Hex(BIG);
    const obj = path.join(h.root, "objects", ...blobObjectKey("acme", sha).split("/"));
    const bytes = fs.readFileSync(obj);
    bytes[bytes.length - 1] ^= 0xff;
    fs.writeFileSync(obj, bytes);
    assert.equal((await verifyImport(scan, { deps: h.deps })).pass, true, "the size still matches");
    const deep = await verifyImport(scan, { deps: h.deps, deep: true });
    assert.equal(deep.pass, false);
    assert.deepEqual(deep.workspaces[0].badBlobs, ["knowledge/big.bin"]);
    assert.deepEqual(fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith("foldrun-verify-")), [], "its temporary files are gone");
  } finally {
    await h.cleanup();
    fs.rmSync(src, { recursive: true, force: true });
  }
});

test("case-colliding names: the first in byte order keeps its name, the rest are conflict copies, deterministically", () => {
  const rels = ["memory/Notes.md", "memory/notes.md", "memory/NOTES.md", "agents/a/AGENTS.md"].sort();
  const a = placeCaseVariants(rels, "acme/desk");
  const b = placeCaseVariants(rels, "acme/desk");
  assert.deepEqual(a, b, "a rerun names the same copies");
  assert.equal(a[0].rel, "agents/a/AGENTS.md");
  const kept = a.filter((x) => !x.from).map((x) => x.rel);
  const copies = a.filter((x) => x.from);
  assert.equal(copies.length, 2);
  assert.ok(kept.includes("memory/NOTES.md"), "byte order: NOTES < Notes < notes");
  for (const c of copies) assert.match(c.rel, /^memory\/(Notes|notes)\.conflict-[0-9a-f]{12}\.md$/);
  assert.equal(new Set(a.map((x) => x.rel.toLowerCase())).size, a.length, "no two share a name once case is ignored");
});

test("scanning a missing source says so; an empty one has no accounts", async () => {
  await assert.rejects(() => scanSource({ source: "/definitely/not/here" }), /not a folder/);
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-imp-empty-"));
  try {
    assert.deepEqual((await scanSource({ source: empty })).tenants, []);
  } finally {
    fs.rmSync(empty, { recursive: true, force: true });
  }
});

test("--tenant / --workspace select what is scanned", async () => {
  const src = buildSource();
  try {
    assert.deepEqual((await scanSource({ source: src, tenants: ["beta"] })).tenants.map((t) => t.tenant), ["beta"]);
    const one = await scanSource({ source: src, workspaces: ["acme/desk2"] });
    assert.deepEqual(one.tenants.map((t) => `${t.tenant}:${t.workspaces.map((w) => w.workspace)}`), ["acme:desk2"]);
  } finally {
    fs.rmSync(src, { recursive: true, force: true });
  }
});

// Codex review of PR #80 (11 Nov 2026), each finding reproduced first.
const tinySource = (files: Record<string, string>, home = "workspaces") => {
  const src = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-imp-tiny-"));
  for (const [rel, text] of Object.entries(files)) {
    const abs = path.join(src, "acme", home, "desk", rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, text);
  }
  return src;
};

test("A → B → A → B: the second A → B is a new import, not a replay of the first", async () => {
  const h = await harness();
  const src = tinySource({ "AGENTS.md": "---\nname: desk\n---\n", "knowledge/x.md": "A\n" });
  const x = path.join(src, "acme/workspaces/desk/knowledge/x.md");
  try {
    for (const text of ["A\n", "B\n", "A\n", "B\n"]) {
      fs.writeFileSync(x, text);
      const scan = await scanSource({ source: src });
      const out = await runImport(scan, { deps: h.deps });
      assert.ok(out.results.every((w) => w.status !== "failed"), JSON.stringify(out.results));
      const v = await verifyImport(scan, { deps: h.deps });
      assert.equal(v.pass, true, `after importing ${JSON.stringify(text)}: ${JSON.stringify(v.workspaces[0])}`);
    }
  } finally {
    await h.cleanup();
    fs.rmSync(src, { recursive: true, force: true });
  }
});

test("a workspace in both projects/ and workspaces/ is imported from projects/, as workspaceDir resolves it", async () => {
  const src = tinySource({ "AGENTS.md": "---\nname: desk\n---\nthe one in use\n" }, "projects");
  const stale = path.join(src, "acme/workspaces/desk/AGENTS.md");
  fs.mkdirSync(path.dirname(stale), { recursive: true });
  fs.writeFileSync(stale, "---\nname: desk\n---\nstale copy\n");
  try {
    const scan = await scanSource({ source: src });
    const ws = scan.tenants[0]!.workspaces;
    assert.equal(ws.length, 1);
    assert.match(ws[0]!.dir, /[/\\]projects[/\\]desk$/);
  } finally {
    fs.rmSync(src, { recursive: true, force: true });
  }
});

test("verify reads the folder as it is now: a file added or an exec bit changed since the scan fails it", async () => {
  const h = await harness();
  const src = tinySource({ "AGENTS.md": "---\nname: desk\n---\n", "scripts/run.sh": "#!/bin/sh\n" });
  const dir = path.join(src, "acme/workspaces/desk");
  try {
    const scan = await scanSource({ source: src });
    await runImport(scan, { deps: h.deps });
    assert.equal((await verifyImport(scan, { deps: h.deps })).pass, true);
    fs.mkdirSync(path.join(dir, "knowledge"), { recursive: true });
    fs.writeFileSync(path.join(dir, "knowledge/new.md"), "added after the scan\n");
    const added = await verifyImport(scan, { deps: h.deps });
    assert.equal(added.pass, false);
    assert.deepEqual(added.workspaces[0]!.missing, ["knowledge/new.md"]);
    fs.rmSync(path.join(dir, "knowledge/new.md"));
    fs.chmodSync(path.join(dir, "scripts/run.sh"), 0o755);
    const moded = await verifyImport(scan, { deps: h.deps });
    assert.equal(moded.pass, false, "the exec bit is part of the file");
    assert.deepEqual(moded.workspaces[0]!.mismatched, ["scripts/run.sh"]);
    fs.chmodSync(path.join(dir, "scripts/run.sh"), 0o644);
    fs.rmSync(path.join(dir, "scripts/run.sh"));
    const gone = await verifyImport(scan, { deps: h.deps, allowExtra: true });
    assert.equal(gone.pass, false, "a file the import had and the folder no longer gives is a failure, extras allowed or not");
    assert.deepEqual(gone.workspaces[0]!.mismatched, ["scripts/run.sh"]);
  } finally {
    await h.cleanup();
    fs.rmSync(src, { recursive: true, force: true });
  }
});
