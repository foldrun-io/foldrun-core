// Two things the gallery's docs/video tools and skills needed (13 Nov 2026):
// a script tool that names the sites its program reaches (`network:` in its
// tool.md), and skills the platform ships to every account — offered to an
// agent only when its `skills:` names one.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { toolSites, toolSiteProblems, resolveNetwork } from "../src/network.ts";
import { parseScripts } from "../src/script-tools.ts";
import { applicableSkills, skillsInScope } from "../src/runner.ts";
import { checkPaths, gallerySkillFile } from "../src/confine.ts";
import { frontmatterProblems } from "../src/frontmatter-schema.ts";
import { registerPlatform, resetPlatform } from "../src/platform.ts";

test("a tool's network: is a list of sites, normalised; anything else is a finding", () => {
  assert.deepEqual(toolSites(["Context7.com", "*.example.com", "api.x.io:443"]), ["context7.com", "*.example.com", "api.x.io"]);
  assert.deepEqual(toolSites("a.com, b.com"), ["a.com", "b.com"]);
  assert.deepEqual(toolSites(undefined), []);
  assert.deepEqual(toolSiteProblems(["context7.com"]), []);
  assert.match(toolSiteProblems(["https://context7.com/api"])[0]!, /not a site/);
  assert.match(toolSiteProblems(["open"])[0]!, /not a level/);
  assert.match(toolSiteProblems({ allow: ["x.com"] })[0]!, /list of sites/);
});

test("check reads a tool's network: through the schema", () => {
  const near = () => null;
  assert.deepEqual(frontmatterProblems("tool", { name: "docs", run: "run.mjs", network: ["context7.com"] }, near), []);
  const bad = frontmatterProblems("tool", { name: "docs", run: "run.mjs", network: ["https://context7.com"] }, near);
  assert.equal(bad[0]?.rule, "config/invalid-value");
});

test("a granted script tool's sites join the step's trusted list", () => {
  const [spec] = parseScripts([{ name: "docs", run: "run.mjs", network: ["context7.com"] }]);
  assert.deepEqual(spec.network, ["context7.com"]);
  const policy = resolveNetwork({ readsWeb: false, implied: spec.network });
  assert.equal(policy.level, "trusted");
  assert.ok(policy.hosts.includes("context7.com"));
  assert.deepEqual(parseScripts([{ name: "plain", run: "run.mjs" }])[0].network, undefined, "no network: adds nothing");
});

const skill = (dir: string, name: string) => {
  fs.mkdirSync(path.join(dir, name, "references"), { recursive: true });
  fs.writeFileSync(path.join(dir, name, "SKILL.md"), `---\nname: ${name}\ndescription: ${name} things\n---\n\nDo it.\n`);
  fs.writeFileSync(path.join(dir, name, "references", "more.md"), "more\n");
};

test("a gallery skill is in scope under the library's path, but only an agent that names it gets it", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gallery-skills-"));
  const gallery = path.join(root, "gallery");
  skill(path.join(gallery, "skills"), "modern-website");
  registerPlatform({ galleryDir: () => gallery });
  const prev = process.env.FOLDRUN_DATA;
  process.env.FOLDRUN_DATA = path.join(root, "data");
  try {
    const ws = path.join(root, "data", "default", "workspaces", "w");
    const agentDir = path.join(ws, "agents", "builder");
    fs.mkdirSync(agentDir, { recursive: true });
    skill(path.join(ws, "skills"), "house-style");
    const all = skillsInScope(agentDir, "default");
    const g = all.find((s) => s.name === "modern-website")!;
    assert.equal(g.gallery, true);
    assert.equal(g.path, "../../../../library/skills/modern-website/SKILL.md");
    assert.equal(g.hasReferences, true);

    assert.deepEqual(applicableSkills(all, [], []).map((s) => s.name), ["house-style"], "unnamed: the account's own only");
    assert.deepEqual(applicableSkills(all, ["modern-website"], []).map((s) => s.name), ["modern-website"]);
  } finally {
    if (prev === undefined) delete process.env.FOLDRUN_DATA; else process.env.FOLDRUN_DATA = prev;
    resetPlatform();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("the account's own copy of a gallery skill wins", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gallery-skills-own-"));
  const gallery = path.join(root, "gallery");
  skill(path.join(gallery, "skills"), "modern-website");
  registerPlatform({ galleryDir: () => gallery });
  const prev = process.env.FOLDRUN_DATA;
  process.env.FOLDRUN_DATA = path.join(root, "data");
  try {
    const libSkills = path.join(root, "data", "default", "library", "skills");
    skill(libSkills, "modern-website");
    const agentDir = path.join(root, "data", "default", "workspaces", "w", "agents", "a");
    fs.mkdirSync(agentDir, { recursive: true });
    const hits = skillsInScope(agentDir, "default").filter((s) => s.name === "modern-website");
    assert.equal(hits.length, 1);
    assert.equal(hits[0].gallery, undefined, "the library's copy, not the shelf's");
  } finally {
    if (prev === undefined) delete process.env.FOLDRUN_DATA; else process.env.FOLDRUN_DATA = prev;
    resetPlatform();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("with no sandbox, a read of a gallery skill under the library is served from the shelf — reads only", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gallery-skills-read-"));
  const gallery = path.join(root, "gallery");
  skill(path.join(gallery, "skills"), "modern-website");
  registerPlatform({ galleryDir: () => gallery });
  try {
    const library = path.join(root, "acct", "library");
    const ws = path.join(root, "acct", "workspaces", "w");
    const agentDir = path.join(ws, "agents", "a");
    fs.mkdirSync(agentDir, { recursive: true });
    fs.mkdirSync(library, { recursive: true });
    const roots = { agentDir, workspaceRoot: ws, libraryRoot: library };
    const asked = "../../../../library/skills/modern-website/references/more.md";

    const read = checkPaths("Read", { file_path: asked }, roots);
    assert.equal(read.ok, true);
    assert.equal(fs.realpathSync((read as { updatedInput: { file_path: string } }).updatedInput.file_path), fs.realpathSync(path.join(gallery, "skills/modern-website/references/more.md")));

    assert.equal(gallerySkillFile(path.join(library, "skills/modern-website/../../../gallery/skills/modern-website/SKILL.md"), library), null, "nothing outside library/skills");
    assert.equal(gallerySkillFile(path.join(library, "skills/nope/SKILL.md"), library), null, "not on the shelf");

    // Once the account has its own copy, that is what is read.
    skill(path.join(library, "skills"), "modern-website");
    const own = checkPaths("Read", { file_path: asked }, roots);
    assert.equal(own.ok, true);
    assert.equal((own as { updatedInput?: unknown }).updatedInput, undefined);
  } finally {
    resetPlatform();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("in a flat single-workspace folder a gallery skill is announced at that folder's library", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gallery-skills-flat-"));
  const gallery = path.join(root, "gallery");
  skill(path.join(gallery, "skills"), "modern-website");
  registerPlatform({ galleryDir: () => gallery });
  const prev = { ws: process.env.FOLDRUN_WORKSPACE, acct: process.env.FOLDRUN_ACCOUNT };
  const desk = path.join(root, "projects", "desk");
  const agentDir = path.join(desk, "agents", "a");
  fs.mkdirSync(agentDir, { recursive: true });
  process.env.FOLDRUN_WORKSPACE = desk;
  process.env.FOLDRUN_ACCOUNT = path.join(root, "projects");
  try {
    const g = skillsInScope(agentDir, "default").find((s) => s.name === "modern-website")!;
    assert.equal(g.path, "../../../library/skills/modern-website/SKILL.md");
    // …and that path is served from the shelf with no sandbox.
    const library = path.join(root, "projects", "library");
    const read = checkPaths("Read", { file_path: g.path }, { agentDir, workspaceRoot: desk, libraryRoot: library });
    assert.equal(read.ok, true);
    assert.match(String((read as { updatedInput?: { file_path?: string } }).updatedInput?.file_path), /gallery\/skills\/modern-website\/SKILL\.md$/);
  } finally {
    for (const [k, v] of [["FOLDRUN_WORKSPACE", prev.ws], ["FOLDRUN_ACCOUNT", prev.acct]] as const) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    resetPlatform();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
