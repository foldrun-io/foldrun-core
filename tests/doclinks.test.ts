// [[name]] → the path the model can actually open.
//
//   node --test tests/doclinks.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveDocLinks } from "../packages/core/src/runner.ts";

function withWorkspace(body: (root: string) => void) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-links-"));
  try {
    fs.mkdirSync(path.join(root, "knowledge"), { recursive: true });
    fs.mkdirSync(path.join(root, "memory"), { recursive: true });
    fs.mkdirSync(path.join(root, "storage"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "knowledge", "sources-of-conveyancers.md"),
      "---\ntype: Reference\ntitle: Sources for conveyancer leads\n---\n\ndirectories…\n",
    );
    fs.writeFileSync(
      path.join(root, "memory", "known-duds.md"),
      "---\ntype: Fact\nname: numbers that never answer\n---\n\n…\n",
    );
    fs.writeFileSync(path.join(root, "storage", "leads.csv"), "email\na@b.c\n");
    body(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test("filenames, titles and storage/ paths all resolve — spelling-blind", () =>
  withWorkspace((root) => {
    const out = resolveDocLinks(
      "Read [[sources-of-conveyancers]] first, honour [[Sources for conveyancer leads]], " +
        "check [[known_duds]] and write to [[storage/leads.csv]].",
      root,
    );
    assert.match(out, /`\.\.\/\.\.\/knowledge\/sources-of-conveyancers\.md` first/);
    assert.match(out, /honour `\.\.\/\.\.\/knowledge\/sources-of-conveyancers\.md`/, "title matches too");
    assert.match(out, /check `\.\.\/\.\.\/memory\/known-duds\.md`/, "underscores and hyphens compare equal");
    assert.match(
      resolveDocLinks("Avoid [[numbers that never answer]].", root),
      /`\.\.\/\.\.\/memory\/known-duds\.md`/,
      "the older `name:` frontmatter matches like title",
    );
    assert.match(out, /write to `\.\.\/\.\.\/storage\/leads\.csv`/);
  }));

test("a folder is a reference too — [[storage/]] and [[state]] resolve", () =>
  withWorkspace((root) => {
    const out = resolveDocLinks("Read what your instruction names in [[storage/]]; ledgers live in [[knowledge]].", root);
    assert.match(out, /in `\.\.\/\.\.\/storage\/`/, "trailing slash form");
    assert.match(out, /in `\.\.\/\.\.\/knowledge\/`/, "bare folder name");
    // A folder that does not exist stays prose, like any other miss.
    assert.match(resolveDocLinks("see [[outputs]]", root), /see \[\[outputs\]\]/);
  }));

test("a document beats a folder of the same name", () =>
  withWorkspace((root) => {
    fs.writeFileSync(path.join(root, "knowledge", "files.md"), "---\ntype: Reference\n---\n\nx\n");
    assert.match(
      resolveDocLinks("[[files]]", root),
      /`\.\.\/\.\.\/knowledge\/files\.md`/,
      "the more specific reference wins",
    );
  }));

test("what doesn't match passes through untouched — sugar, never a gate", () =>
  withWorkspace((root) => {
    const text = "Consult [[enricher]] about [[something we never wrote down]].";
    assert.equal(resolveDocLinks(text, root), text);
  }));

test("no brackets, no work", () =>
  withWorkspace((root) => {
    const text = "Plain prose with `knowledge/x.md` stays plain.";
    assert.equal(resolveDocLinks(text, root), text);
  }));

test("state/ files resolve individually, not just the folder", () =>
  withWorkspace((root) => {
    fs.mkdirSync(path.join(root, "state"), { recursive: true });
    fs.writeFileSync(path.join(root, "state", "index-cursor.md"), "position: 0\n");
    fs.writeFileSync(path.join(root, "state", "dead-ends.csv"), "firm,reason\n");

    // The one directory a recurring flow reads from most. The folder always
    // resolved; the files in it did not, so every desk hand-wrote ../../state/.
    const out = resolveDocLinks(
      "Read [[index-cursor]], then [[state/dead-ends.csv]], and the rest of [[state]].",
      root,
    );
    assert.match(out, /Read `\.\.\/\.\.\/state\/index-cursor\.md`/);
    assert.match(out, /then `\.\.\/\.\.\/state\/dead-ends\.csv`/);
    assert.match(out, /rest of `\.\.\/\.\.\/state\/`/, "the folder still resolves");
    assert.doesNotMatch(out, /\[\[/);
  }));

test("a state file matches hyphen- and case-blind, like every other link", () =>
  withWorkspace((root) => {
    fs.mkdirSync(path.join(root, "state"), { recursive: true });
    fs.writeFileSync(path.join(root, "state", "index-cursor.md"), "position: 0\n");
    assert.match(
      resolveDocLinks("Read [[Index_Cursor]].", root),
      /`\.\.\/\.\.\/state\/index-cursor\.md`/,
    );
  }));
