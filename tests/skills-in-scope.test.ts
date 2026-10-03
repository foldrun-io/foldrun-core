// Where an agent is told a skill is. The workspace's were announced as
// `../../skills/…`; on the hello template the model resolved that one level
// too far and was refused. `workspace/skills/…` is the one spelling, and the
// file tools expand it to the workspace root.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { skillsInScope } from "../src/runner.ts";
import { expandVirtual } from "../src/confine.ts";

const skill = (dir: string, name: string) => {
  fs.mkdirSync(path.join(dir, name), { recursive: true });
  fs.writeFileSync(path.join(dir, name, "SKILL.md"), `---\nname: ${name}\ndescription: ${name} things\n---\n\nDo it.\n`);
};

test("a workspace skill is announced at workspace/skills/…, and that path opens the real file", () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "skills-scope-"));
  try {
    const agentDir = path.join(ws, "agents/notetaker");
    fs.mkdirSync(agentDir, { recursive: true });
    skill(path.join(ws, "skills"), "plain-english");
    skill(path.join(ws, ".agents/skills"), "cross-client");
    skill(path.join(agentDir, "skills"), "own");

    const got = Object.fromEntries(skillsInScope(agentDir, "default").map((s) => [s.name, s]));
    assert.equal(got["plain-english"].path, "workspace/skills/plain-english/SKILL.md");
    assert.equal(got["plain-english"].dir, "workspace/skills/plain-english");
    assert.equal(got["cross-client"].path, "workspace/.agents/skills/cross-client/SKILL.md");
    assert.equal(got.own.path, "skills/own/SKILL.md");

    const opened = expandVirtual(got["plain-english"].path, { agentDir, workspaceRoot: ws, libraryRoot: path.join(ws, "no-library") });
    assert.equal(opened?.abs, path.join(ws, "skills/plain-english/SKILL.md"));
    assert.ok(fs.existsSync(opened!.abs));
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test("the nearest definition of a name wins: the agent's own over the workspace's", () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "skills-scope-"));
  try {
    const agentDir = path.join(ws, "agents/a");
    skill(path.join(agentDir, "skills"), "style");
    skill(path.join(ws, "skills"), "style");
    const got = skillsInScope(agentDir, "default").filter((s) => s.name === "style");
    assert.equal(got.length, 1);
    assert.equal(got[0].path, "skills/style/SKILL.md");
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});
