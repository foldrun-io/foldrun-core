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
