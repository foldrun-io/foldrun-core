// `preview:` on a gated step — what the approval box renders, declared in
// the flow so it does not depend on the previous agent naming its files.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseFlow } from "../src/store.ts";
import { resolvePreview } from "../src/runner.ts";
import { lintFlow } from "../src/flow-lint.ts";

const FLOW = `---
name: publish
---
1. [[writer]] — write it
2! [[publisher]] — push it
   preview: draft/*.mdx, ../../storage/draft/images/*.webp, notes.md
`;

test("preview: parses to storage-relative patterns", () => {
  const flow = parseFlow("publish.md", FLOW);
  assert.deepEqual(flow.steps[1].preview, ["draft/*.mdx", "draft/images/*.webp", "notes.md"]);
});

test("patterns resolve against storage/ at park time, hidden files skipped, capped", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-preview-"));
  try {
    fs.mkdirSync(path.join(root, "draft/images"), { recursive: true });
    fs.writeFileSync(path.join(root, "draft/a.mdx"), "a");
    fs.writeFileSync(path.join(root, "draft/b.mdx"), "b");
    fs.writeFileSync(path.join(root, "draft/.hidden.mdx"), "x");
    fs.writeFileSync(path.join(root, "draft/images/a-thumbnail.webp"), "img");
    fs.writeFileSync(path.join(root, "notes.md"), "n");
    assert.deepEqual(
      resolvePreview(root, ["draft/*.mdx", "draft/images/*.webp", "notes.md", "missing.md"]),
      ["draft/a.mdx", "draft/b.mdx", "draft/images/a-thumbnail.webp", "notes.md"],
    );
    assert.deepEqual(resolvePreview(root, ["**/*.webp"]), ["draft/images/a-thumbnail.webp"]);
    assert.equal(resolvePreview(root, ["draft/*"], 1).length, 1, "capped");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a gate without preview: is warned about; one with it is not", () => {
  const bare = parseFlow("p.md", "---\nname: p\n---\n1. [[a]] — go\n2! [[b]] — push\n");
  assert.ok(lintFlow(bare).some((w) => /gate with no preview/.test(w.message)));
  const declared = parseFlow("publish.md", FLOW);
  assert.ok(!lintFlow(declared).some((w) => /gate with no preview/.test(w.message)));
});
