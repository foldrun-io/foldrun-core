// gray-matter caches a failed parse as a success (src/matter.ts). On 20 Oct
// 2026 one agent.md with an unquoted colon in its description went through
// the source API's own "does it parse" check that way, and then took the
// worker down at boot for every account: listWorkspaces threw on it.
//
//   node --test tests/matter.test.ts
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import matter, { parseLenient } from "../src/matter.ts";
import { listAgents, listFlows, listWorkspaces, workspaceDir, writeWorkspaceFile } from "../src/store.ts";
import { checkFiles } from "../src/deploy.ts";

// Its own data root, whatever the caller set: these tests write workspaces.
// dataRoot() reads the environment on every call, so setting it here holds
// for every test below; the single-workspace pin would point the writes at
// a real folder, so it is cleared too. Both are restored after.
const saved = { data: process.env.FOLDRUN_DATA, ws: process.env.FOLDRUN_WORKSPACE };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-matter-"));
process.env.FOLDRUN_DATA = tmp;
delete process.env.FOLDRUN_WORKSPACE;
after(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  if (saved.data === undefined) delete process.env.FOLDRUN_DATA;
  else process.env.FOLDRUN_DATA = saved.data;
  if (saved.ws !== undefined) process.env.FOLDRUN_WORKSPACE = saved.ws;
});

const BAD = "---\nname: bad\ndescription: Probe for tools: [peers] — asks\nmodel: fast\n---\n\nYou ask.\n";

test("gray-matter itself: a failed parse is cached as a success — the upstream bug this wraps", () => {
  const gray = createRequire(import.meta.url)("gray-matter");
  const text = BAD + "\n<!-- upstream -->\n";
  assert.throws(() => gray(text));
  assert.deepEqual(gray(text).data, {}, "the second call returns the cached, unparsed entry");
});

test("matter(): every call parses — a broken frontmatter throws every time", () => {
  assert.throws(() => matter(BAD), /incomplete explicit mapping pair/);
  assert.throws(() => matter(BAD), /incomplete explicit mapping pair/, "and again, not the cached shell");
  assert.deepEqual(matter("---\nname: ok\n---\nhi\n").data, { name: "ok" });
  assert.equal(typeof matter.stringify, "function");
});

test("no file in src/ imports gray-matter but the wrapper", () => {
  const dir = path.join(import.meta.dirname, "..", "src");
  const offenders = fs
    .readdirSync(dir, { recursive: true })
    .map(String)
    .filter((f) => f.endsWith(".ts") && f !== "matter.ts")
    .filter((f) => /from ["']gray-matter["']|require\(["']gray-matter["']\)|import\(["']gray-matter["']\)/.test(fs.readFileSync(path.join(dir, f), "utf8")));
  assert.deepEqual(offenders, [], "import matter from \"./matter.ts\" instead");
});

test("one broken agent or flow is reported, never thrown out of a listing", () => {
  const ws = workspaceDir("acme", "lab");
  fs.mkdirSync(path.join(ws, "agents", "bad"), { recursive: true });
  fs.mkdirSync(path.join(ws, "agents", "good"), { recursive: true });
  fs.mkdirSync(path.join(ws, "flows"), { recursive: true });
  fs.writeFileSync(path.join(ws, "agents", "bad", "agent.md"), BAD);
  fs.writeFileSync(path.join(ws, "agents", "good", "agent.md"), "---\nname: good\ndescription: \"fine: quoted\"\n---\nhi\n");
  fs.writeFileSync(path.join(ws, "flows", "broken.md"), "---\ntrigger: schedule\nschedule: 0 9 * * *\ndescription: runs at: nine\n---\n\n1. [[good]] — say hi\n");

  const agents = listAgents("acme", "lab");
  assert.deepEqual(agents.map((a) => a.name), ["bad", "good"]);
  assert.match(agents[0].frontmatterError ?? "", /frontmatter does not parse — .*Quote a value/);
  assert.equal(agents[1].frontmatterError, undefined);
  assert.equal(agents[1].description, "fine: quoted");

  const [flow] = listFlows("acme", "lab");
  assert.ok(flow.frontProblems.some((p) => /frontmatter does not parse/.test(p)), "a flow-level problem check reports");
  assert.equal(flow.steps.length, 1, "the steps are still read");
  assert.notEqual(flow.trigger, "schedule", "with no frontmatter read the flow does not fire on a schedule");

  const [summary] = listWorkspaces("acme");
  assert.equal(summary.agents, 2);
  assert.equal(summary.flows, 1);
});

test("a save of broken frontmatter is refused — the second time as well as the first", () => {
  fs.mkdirSync(workspaceDir("acme", "save"), { recursive: true });
  assert.throws(() => writeWorkspaceFile("acme", "save", "agents/x/agent.md", BAD));
  assert.throws(() => writeWorkspaceFile("acme", "save", "agents/x/agent.md", BAD), undefined, "the cache no longer lets it through");
  assert.equal(fs.existsSync(path.join(workspaceDir("acme", "save"), "agents", "x", "agent.md")), false);
});

test("the server's check names the broken file", () => {
  const files = [
    { path: "AGENTS.md", content: "---\nname: lab\n---\n" },
    { path: "agents/bad/agent.md", content: BAD },
    // Not definitions: a skill (read leniently) and a reference beside it
    // that opens with a horizontal rule. Neither is refused.
    { path: "skills/demo/SKILL.md", content: "---\nname: demo\ndescription: Use when: a colon\n---\nsteps\n" },
    { path: "skills/demo/references/guide.md", content: "---\nA rule, then prose: not YAML.\n---\n" },
  ];
  const once = checkFiles(files as never);
  const twice = checkFiles(files as never);
  for (const findings of [once, twice]) {
    assert.ok(
      findings.some((f) => f.level === "error" && /agents\/bad\/agent\.md/.test(f.file ?? "")),
      `an error on the broken file: ${JSON.stringify(findings.map((f) => [f.level, f.rule, f.file]))}`,
    );
    assert.ok(!findings.some((f) => f.level === "error" && /^skills\//.test(f.file ?? "")), "skills and their references are not refused");
    // The skill is warned about (the editor and source API would refuse to
    // save it); the reference beside it is prose and is not.
    assert.ok(findings.some((f) => f.rule === "config/invalid-frontmatter" && f.level === "warn" && f.file === "skills/demo/SKILL.md"), "the skill's YAML is a warning");
    assert.ok(!findings.some((f) => f.file === "skills/demo/references/guide.md" && f.rule === "config/invalid-frontmatter"), "a reference is not checked as frontmatter");
  }
});

// A customer's desk, 2026-10-21: a skill whose description held `::: directives`
// deployed clean, ran, and was then refused by PUT /source on its next save.
const VAZA_SKILL =
  "---\nname: house-style\ndescription: The blog post standard — the file format (Markdown, frontmatter, ::: directives), the answer-first opening, linking, images, dates, and the rules that fail silently. Load before outlining, drafting, reviewing or publishing any post for vaza.ai.\n---\n\n# vaza.ai house style\n";

test("a skill whose YAML only parses leniently is a check warning, at its line, in the workspace and the library", () => {
  for (const p of ["skills/house-style/SKILL.md", "library/skills/house-style/SKILL.md", "skills/house-style.md", ".agents/skills/house-style/SKILL.md"]) {
    const f = checkFiles([{ path: "AGENTS.md", content: "---\nname: lab\n---\n" }, { path: p, content: VAZA_SKILL }] as never).find((x) => x.rule === "config/invalid-frontmatter");
    assert.ok(f, `reported for ${p}`);
    assert.equal(f.level, "warn");
    assert.equal(f.file, p);
    assert.equal(f.line, 3, "the description's line");
    assert.match(f.message, /frontmatter does not parse — .*line 3, column 81\. Quote a value/);
    assert.match(f.message, /reads this skill anyway by quoting/);
  }
  // The runtime still reads it, so the warning does not lie about that.
  assert.equal(parseLenient(VAZA_SKILL).data.name, "house-style");
  assert.equal(parseLenient(VAZA_SKILL).lenient, true);
});

test("a skill even the lenient read cannot parse says it is never loaded", () => {
  const f = checkFiles([{ path: "skills/x/SKILL.md", content: "---\nname: x\ndescription: [unclosed\n---\n" }] as never).find((x) => x.rule === "config/invalid-frontmatter");
  assert.ok(f);
  assert.match(f.message, /never loaded/);
});

test("a library agent, tool or hook with broken YAML is reported; the workspace's own is the deploy's error, said once", () => {
  for (const p of ["library/tools/x/tool.md", "library/tools/x.md", "library/hooks/h/hook.md"]) {
    const found = checkFiles([{ path: p, content: BAD }] as never).filter((x) => x.rule === "config/invalid-frontmatter");
    assert.equal(found.length, 1, `reported for ${p}`);
  }
  const own = checkFiles([{ path: "agents/bad/agent.md", content: BAD }] as never);
  assert.ok(own.some((f) => f.level === "error" && f.file === "agents/bad/agent.md"), "still refused by the deploy");
  assert.ok(!own.some((f) => f.rule === "config/invalid-frontmatter"), "not reported twice");
});
