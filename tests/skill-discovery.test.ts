// Agent Skills conformance: where skills are discovered and what loads.
//
// The Agent Skills standard (agentskills.io) defines the SKILL.md folder but
// leaves the parent directory to the client. `.agents/skills/` has become the
// cross-client convention, so foldrun scans it alongside its native skills/.
// These guard that a skill dropped in the portable location is found, that a
// skill with no description is skipped (it cannot be disclosed), and that a
// value with an unquoted colon still loads rather than dropping the skill.
//
//   node --test tests/skill-discovery.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { discoverSkills } from "../packages/core/src/runner.ts";

function fixture(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-skills-"));
  const write = (rel: string, body: string) => {
    const f = path.join(root, rel);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, body);
  };
  write("skills/native/SKILL.md", "---\nname: native\ndescription: A native skill.\n---\nBody.");
  write(".agents/skills/portable/SKILL.md", "---\nname: portable\ndescription: A portable skill.\n---\nBody.");
  write("skills/no-desc/SKILL.md", "---\nname: no-desc\n---\nBody.");
  write("skills/colon/SKILL.md", "---\nname: colon\ndescription: Use when: the user mentions colons\n---\nBody.");
  // A broken-YAML value (colon) that ALSO contains $ replacement patterns.
  write("skills/dollar/SKILL.md", "---\nname: dollar\ndescription: Cost: A$&B and $$ per item\n---\nBody.");
  return root;
}

test("the native skills/ directory is scanned", () => {
  const root = fixture();
  const names = discoverSkills(root, "skills").map((s) => s.name);
  assert.ok(names.includes("native"), "native skill should be found");
});

test(".agents/skills/ — the cross-client convention — is scanned", () => {
  const root = fixture();
  const found = discoverSkills(root, ".agents/skills");
  assert.deepEqual(
    found.map((s) => s.name),
    ["portable"],
    "a skill placed in .agents/skills must be discovered",
  );
  assert.equal(found[0].path, ".agents/skills/portable/SKILL.md");
});

test("a skill with no description is skipped — it cannot be disclosed", () => {
  const root = fixture();
  const names = discoverSkills(root, "skills").map((s) => s.name);
  assert.ok(!names.includes("no-desc"), "an empty-description skill must not load");
});

test("a description with an unquoted colon still loads (lenient YAML)", () => {
  const root = fixture();
  const colon = discoverSkills(root, "skills").find((s) => s.name === "colon");
  assert.ok(colon, "the colon skill should load rather than drop");
  assert.match(colon!.description, /colons/);
});

test("a broken-YAML description with $ patterns is not corrupted", () => {
  const root = fixture();
  const dollar = discoverSkills(root, "skills").find((s) => s.name === "dollar");
  assert.ok(dollar, "the skill should load");
  assert.equal(dollar!.description, "Cost: A$&B and $$ per item", "the $ sequences survive verbatim");
});
