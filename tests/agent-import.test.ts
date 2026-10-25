// Blank workspaces, and bringing an agent you already have into one.
//
//   node --test tests/agent-import.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { saveWorkspace, workspaceDir, blankTemplateFiles, listAgents, readWorkspaceFile } from "../src/store.ts";
import { blankWorkspaceFiles } from "../src/starter.ts";
import { importAgent, AgentImportError } from "../src/agent-import.ts";

function withData(body: () => void) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-import-"));
  const previous = process.env.FOLDRUN_DATA;
  process.env.FOLDRUN_DATA = root;
  try {
    body();
  } finally {
    if (previous === undefined) delete process.env.FOLDRUN_DATA;
    else process.env.FOLDRUN_DATA = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const AGENT = "---\nname: reviewer\ndescription: Reviews drafts.\ntools: [read, write, nosuch_tool]\nskills: [house-style]\nsecrets: [GITHUB_TOKEN]\n---\n\nReview it.\n";

function desks() {
  saveWorkspace("acme", "blog", [
    { path: "AGENTS.md", content: "---\nname: blog\n---\n" },
    { path: "agents/reviewer/agent.md", content: AGENT },
    { path: "agents/reviewer/skills/house-style/SKILL.md", content: "---\nname: house-style\ndescription: How we write.\n---\n\nShort.\n" },
    { path: "agents/reviewer/memory/lesson.md", content: "---\ntype: Fact\n---\n\nAbout the blog.\n" },
  ]);
  saveWorkspace("acme", "fresh", blankTemplateFiles("fresh"));
}

test("a blank workspace has no agents, flows or example knowledge", () => {
  const paths = blankWorkspaceFiles("x").map((f) => f.path).sort();
  assert.deepEqual(paths, [".gitignore", "AGENTS.md", "CLAUDE.md"]);
  assert.deepEqual(blankTemplateFiles("x").map((f) => f.path), ["AGENTS.md"]);
  assert.match(blankTemplateFiles("x")[0].content, /import one from another workspace/);
});

test("an agent is copied with its own skills, without its memory", () => {
  withData(() => {
    desks();
    const r = importAgent("acme", "blog", "reviewer", "fresh", { by: "test" });
    assert.equal(r.name, "reviewer");
    assert.deepEqual(r.files.sort(), ["agents/reviewer/agent.md", "agents/reviewer/skills/house-style/SKILL.md"]);
    assert.equal(fs.existsSync(path.join(workspaceDir("acme", "fresh"), "agents/reviewer/memory")), false);
    assert.deepEqual(listAgents("acme", "fresh").map((a) => a.name), ["reviewer"]);
    // What the copy names that the target lacks, said — not refused.
    assert.ok(r.warnings.some((w) => /nosuch_tool/.test(w)), r.warnings.join("\n"));
    assert.ok(r.warnings.some((w) => /GITHUB_TOKEN/.test(w)), r.warnings.join("\n"));
    assert.ok(!r.warnings.some((w) => /house-style/.test(w)), "its own skill came with it");
  });
});

test("a name clash is refused unless the copy is renamed, and the rename reaches name:", () => {
  withData(() => {
    desks();
    importAgent("acme", "blog", "reviewer", "fresh");
    assert.throws(() => importAgent("acme", "blog", "reviewer", "fresh"), (e: unknown) => e instanceof AgentImportError && e.status === 409);
    const r = importAgent("acme", "blog", "reviewer", "fresh", { as: "editor" });
    assert.equal(r.name, "editor");
    assert.match(readWorkspaceFile("acme", "fresh", "agents/editor/agent.md"), /^---\nname: editor\n/);
  });
});

test("an unknown agent or workspace is a 404", () => {
  withData(() => {
    desks();
    assert.throws(() => importAgent("acme", "blog", "ghost", "fresh"), (e: unknown) => e instanceof AgentImportError && e.status === 404);
    assert.throws(() => importAgent("acme", "nowhere", "reviewer", "fresh"), (e: unknown) => e instanceof AgentImportError && e.status === 404);
  });
});
