// "Move to shared" in one call (moveToLibrary, 5 Nov 2026). Done by the
// client, a skill's other files were lost (one copied, the folder deleted)
// and a folder tool's path was flattened. Everything is checked before
// anything is written; then the whole unit moves.
//
//   node --test tests/library-move.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-libmove-"));
process.env.FOLDRUN_DATA = root;
delete process.env.FOLDRUN_WORKSPACE;
const { moveToLibrary } = await import("../src/library.ts");

const ws = path.join(root, "acme", "workspaces", "desk");
const lib = path.join(root, "acme", "library");
const put = (rel: string, text: string) => {
  fs.mkdirSync(path.dirname(path.join(ws, rel)), { recursive: true });
  fs.writeFileSync(path.join(ws, rel), text);
};
fs.mkdirSync(ws, { recursive: true });
fs.writeFileSync(path.join(ws, "AGENTS.md"), "---\nname: desk\n---\n");

test("a skill moves whole: every file of its folder, then the folder is gone", () => {
  put("skills/house-style/SKILL.md", "---\nname: house-style\ndescription: x\n---\nWrite plainly.\n");
  put("skills/house-style/examples.md", "# examples\n");
  put("skills/house-style/scripts/check.py", "print(1)\n");
  const r = moveToLibrary("acme", "desk", "skills/house-style/SKILL.md", { by: "ana@acme.test" });
  assert.equal(r.moved, true);
  assert.equal(r.unit, "skills/house-style");
  assert.deepEqual(r.files.map((f) => f.to), ["house-style/SKILL.md", "house-style/examples.md", "house-style/scripts/check.py"]);
  assert.equal(fs.readFileSync(path.join(lib, "skills/house-style/examples.md"), "utf8"), "# examples\n");
  assert.ok(fs.existsSync(path.join(lib, "skills/house-style/scripts/check.py")));
  assert.equal(fs.existsSync(path.join(ws, "skills/house-style")), false);
});

test("a folder tool keeps its folder, not a flattened tool.md", () => {
  put("tools/fetcher/tool.md", "---\nname: fetcher\nrun: run.mjs\n---\nbody\n");
  put("tools/fetcher/run.mjs", "console.log(1)\n");
  const r = moveToLibrary("acme", "desk", "tools/fetcher/tool.md");
  assert.deepEqual(r.files.map((f) => f.to), ["fetcher/run.mjs", "fetcher/tool.md"]);
  assert.ok(fs.existsSync(path.join(lib, "tools/fetcher/tool.md")));
  assert.equal(fs.existsSync(path.join(lib, "tools/tool.md")), false);
  assert.equal(fs.existsSync(path.join(ws, "tools/fetcher")), false);
});

test("a folder holding a file the library cannot hold moves nothing", () => {
  put("skills/diagrams/SKILL.md", "---\nname: diagrams\ndescription: x\n---\nDraw.\n");
  put("skills/diagrams/logo.png", "\x89PNG");
  assert.throws(() => moveToLibrary("acme", "desk", "skills/diagrams"), (e: Error & { status?: number }) => e.status === 409 && /logo\.png/.test(e.message));
  assert.ok(fs.existsSync(path.join(ws, "skills/diagrams/logo.png")), "the original is untouched");
  assert.equal(fs.existsSync(path.join(lib, "skills/diagrams")), false, "nothing reached the library");
});

test("a library file already there refuses the move unless overwrite; a dry run writes nothing", () => {
  put("knowledge/faq.md", "# new faq\n");
  fs.mkdirSync(path.join(lib, "knowledge"), { recursive: true });
  fs.writeFileSync(path.join(lib, "knowledge/faq.md"), "# old faq\n");
  const dry = moveToLibrary("acme", "desk", "knowledge/faq.md", { dryRun: true });
  assert.equal(dry.moved, false);
  assert.equal(dry.files[0].replaces, true);
  assert.throws(() => moveToLibrary("acme", "desk", "knowledge/faq.md"), (e: Error & { status?: number }) => e.status === 409);
  assert.equal(fs.readFileSync(path.join(lib, "knowledge/faq.md"), "utf8"), "# old faq\n");
  moveToLibrary("acme", "desk", "knowledge/faq.md", { overwrite: true });
  assert.equal(fs.readFileSync(path.join(lib, "knowledge/faq.md"), "utf8"), "# new faq\n");
  assert.equal(fs.existsSync(path.join(ws, "knowledge/faq.md")), false);
});

test("hooks, other folders, paths outside and missing files are refused", () => {
  assert.throws(() => moveToLibrary("acme", "desk", "hooks/x"), /hook add/);
  assert.throws(() => moveToLibrary("acme", "desk", "agents/writer/agent.md"), /not under/);
  assert.throws(() => moveToLibrary("acme", "desk", "../other/skills/x"), /illegal path/);
  assert.throws(() => moveToLibrary("acme", "desk", "skills/nope"), (e: Error & { status?: number }) => e.status === 404);
  put("knowledge/sub/a.md", "a\n");
  assert.throws(() => moveToLibrary("acme", "desk", "knowledge/sub"), /name a file in it/);
});

test("a file the workspace cannot delete on its own is refused before the library is touched", () => {
  put("knowledge/index.md", "# index\n");
  assert.throws(() => moveToLibrary("acme", "desk", "knowledge/index.md"), (e: Error & { status?: number }) => e.status === 409 && /nothing was moved/.test(e.message));
  // The library keeps its own index; ours did not replace it.
  const libIndex = path.join(lib, "knowledge/index.md");
  assert.notEqual(fs.existsSync(libIndex) ? fs.readFileSync(libIndex, "utf8") : null, "# index\n");
  assert.ok(fs.existsSync(path.join(ws, "knowledge/index.md")));
});

test("a text extension holding bytes that are not UTF-8 is not moved (reading it as text would change it)", () => {
  fs.mkdirSync(path.join(ws, "knowledge"), { recursive: true });
  fs.writeFileSync(path.join(ws, "knowledge/latin1.txt"), Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]));
  assert.throws(() => moveToLibrary("acme", "desk", "knowledge/latin1.txt"), (e: Error & { status?: number }) => e.status === 409);
  assert.equal(fs.existsSync(path.join(lib, "knowledge/latin1.txt")), false);
  assert.ok(fs.existsSync(path.join(ws, "knowledge/latin1.txt")));
});

test("a library file where the move needs a folder refuses it before anything is written", () => {
  put("skills/clash/SKILL.md", "---\nname: clash\ndescription: x\n---\nx\n");
  put("skills/clash/scripts/run.py", "print(1)\n");
  fs.mkdirSync(path.join(lib, "skills/clash"), { recursive: true });
  fs.writeFileSync(path.join(lib, "skills/clash/scripts"), "a file, not a folder\n");
  assert.throws(() => moveToLibrary("acme", "desk", "skills/clash", { overwrite: true }), (e: Error & { status?: number }) => e.status === 409 && /needs a folder/.test(e.message));
  assert.equal(fs.existsSync(path.join(lib, "skills/clash/SKILL.md")), false, "nothing half-published");
  assert.ok(fs.existsSync(path.join(ws, "skills/clash/SKILL.md")));
});

test("a link on the library side is refused: the copy must not land back in the workspace", () => {
  put("skills/loop/SKILL.md", "---\nname: loop\ndescription: x\n---\nx\n");
  fs.mkdirSync(path.join(lib, "skills"), { recursive: true });
  fs.symlinkSync(path.join(ws, "skills/loop"), path.join(lib, "skills/loop"));
  assert.throws(() => moveToLibrary("acme", "desk", "skills/loop", { overwrite: true }), (e: Error & { status?: number }) => e.status === 409 && /link/.test(e.message));
  assert.ok(fs.existsSync(path.join(ws, "skills/loop/SKILL.md")), "the original is untouched");
});
