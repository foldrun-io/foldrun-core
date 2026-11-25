// The syntax guard on Edit and Write (FOL-292): a change that would make a file that parses stop parsing is refused.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { ENGINE_TOOLS, type ToolContext } from "../src/engine-tools.ts";
import { checkText, guardChange, jsMode, systemPython, checkerFor } from "../src/edit-check.ts";

function setup(extra: Partial<ToolContext> = {}) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-editcheck-")));
  const stop = new AbortController();
  const ctx: ToolContext = { cwd: dir, env: { PATH: process.env.PATH }, signal: stop.signal, reads: new Map(), groups: new Set(), ...extra };
  return { dir, ctx, stop, done: () => fs.rmSync(dir, { recursive: true, force: true }) };
}
const read = (ctx: ToolContext, file: string) => ENGINE_TOOLS.Read!.run({ file_path: file }, ctx);
const edit = (ctx: ToolContext, i: Record<string, unknown>) => ENGINE_TOOLS.Edit!.run(i, ctx);
const write = (ctx: ToolContext, i: Record<string, unknown>) => ENGINE_TOOLS.Write!.run(i, ctx);

test("an edit that would break a JSON file that parses is refused; the file and what was read are unchanged", async () => {
  const { dir, ctx, done } = setup();
  try {
    const f = path.join(dir, "data.json");
    fs.writeFileSync(f, '{"a": 1, "b": 2}\n');
    await read(ctx, f);
    const seen = ctx.reads.get(f);
    const r = await edit(ctx, { file_path: f, old_string: '"b": 2', new_string: '"b": 2,' });
    assert.equal(r.isError, true);
    assert.match(r.text, /not applied — .*data\.json would stop parsing/);
    assert.match(r.text, /allow_syntax_errors/);
    assert.equal(fs.readFileSync(f, "utf8"), '{"a": 1, "b": 2}\n', "bytes unchanged");
    assert.equal(ctx.reads.get(f), seen, "read state unchanged");
    // A good edit goes through, with nothing added.
    const ok = await edit(ctx, { file_path: f, old_string: '"b": 2', new_string: '"b": 3' });
    assert.equal(ok.isError, undefined);
    assert.equal(ok.text.split("\n").length, 1);
  } finally {
    done();
  }
});

test("a file that already does not parse may be repaired step by step", async () => {
  const { dir, ctx, done } = setup();
  try {
    const f = path.join(dir, "bad.json");
    fs.writeFileSync(f, '{"a": 1,, "b": [1 2]}');
    await read(ctx, f);
    const r = await edit(ctx, { file_path: f, old_string: "1,,", new_string: "1," });
    assert.equal(r.isError, undefined, r.text);
    assert.match(r.text, /still does not parse/);
    assert.equal(fs.readFileSync(f, "utf8"), '{"a": 1, "b": [1 2]}');
  } finally {
    done();
  }
});

test("a new file that does not parse is not created, unless it is meant to be (allow_syntax_errors)", async () => {
  const { dir, ctx, done } = setup();
  try {
    const f = path.join(dir, "fixture.json");
    const r = await write(ctx, { file_path: f, content: "{broken" });
    assert.equal(r.isError, true);
    assert.match(r.text, /not written — .* would not parse.*not created/);
    assert.equal(fs.existsSync(f), false);
    const ok = await write(ctx, { file_path: f, content: "{broken", allow_syntax_errors: true });
    assert.equal(ok.isError, undefined, ok.text);
    assert.equal(fs.readFileSync(f, "utf8"), "{broken");
  } finally {
    done();
  }
});

test("JavaScript is checked in the grammar it loads in: export refused in a CommonJS package, allowed in a module one", async () => {
  const { dir, ctx, done } = setup();
  try {
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ type: "commonjs" }));
    const f = path.join(dir, "a.js");
    const r = await write(ctx, { file_path: f, content: "export const x = 1;\n" });
    assert.equal(r.isError, true, r.text);
    assert.match(r.text, /SyntaxError/);
    fs.mkdirSync(path.join(dir, "esm"));
    fs.writeFileSync(path.join(dir, "esm", "package.json"), JSON.stringify({ type: "module" }));
    const g = await write(ctx, { file_path: path.join(dir, "esm", "a.js"), content: "export const x = await Promise.resolve(1);\n" });
    assert.equal(g.isError, undefined, g.text);
    assert.equal(jsMode(path.join(dir, "esm", "b.cjs")), "commonjs");
    // No "type": node detects either grammar, so either is accepted (Codex).
    fs.mkdirSync(path.join(dir, "plain"));
    fs.writeFileSync(path.join(dir, "plain", "package.json"), JSON.stringify({ name: "p" }));
    const e = await write(ctx, { file_path: path.join(dir, "plain", "a.js"), content: "export const a = 1;\n" });
    assert.equal(e.isError, undefined, e.text);
    assert.equal(jsMode(path.join(dir, "plain", "a.js")), "either");
    const eb = await write(ctx, { file_path: path.join(dir, "plain", "b.js"), content: "export const = 1;\n" });
    assert.equal(eb.isError, true, "broken in both grammars is still refused");
    // A package.json that is not a plain file, or that the walls deny, decides nothing.
    assert.equal(jsMode(path.join(dir, "plain", "a.js"), () => false), "either");
    fs.mkdirSync(path.join(dir, "pipe"));
    if (spawnSync("mkfifo", [path.join(dir, "pipe", "package.json")]).status === 0) assert.equal(jsMode(path.join(dir, "pipe", "a.js")), "either", "a pipe is never opened");
    assert.equal(jsMode(path.join(dir, "b.mjs")), "module");
    // A real error, with its line.
    const m = await write(ctx, { file_path: path.join(dir, "c.js"), content: "const a = 1;\nif (a) {\n" });
    assert.match(m.text, /line \d+: SyntaxError/);
    // A shebang and a top-level return are fine for node.
    const s = await write(ctx, { file_path: path.join(dir, "bin.js"), content: "#!/usr/bin/env node\nconst a = 1;\n" });
    assert.equal(s.isError, undefined, s.text);
  } finally {
    done();
  }
});

test("an edit that empties a JSON file is refused; Edit does not bring back a file removed while it was checked", async () => {
  const { dir, ctx, done } = setup();
  try {
    const f = path.join(dir, "e.json");
    fs.writeFileSync(f, "{}\n");
    await read(ctx, f);
    const r = await edit(ctx, { file_path: f, old_string: "{}", new_string: "  " });
    assert.equal(r.isError, true, r.text);
    const g = path.join(dir, "g.js");
    fs.writeFileSync(g, "const a = 1;\n");
    await read(ctx, g);
    ctx.checkWith = {
      runNode: async () => {
        fs.rmSync(g);
        return { code: 0, out: "", timedOut: false };
      },
    };
    const d = await edit(ctx, { file_path: g, old_string: "1", new_string: "2" });
    assert.equal(d.isError, true);
    assert.match(d.text, /removed while the change was checked/);
    assert.equal(fs.existsSync(g), false);
  } finally {
    done();
  }
});

test("Write reads the file it replaces only when the new content does not parse, and not past the size checked", async () => {
  const { dir, ctx, done } = setup();
  try {
    const f = path.join(dir, "big.json");
    fs.writeFileSync(f, "[" + "1,".repeat(600_000) + "1]");
    await read(ctx, f);
    const r = await write(ctx, { file_path: f, content: "{oops" });
    assert.equal(r.isError, undefined, r.text);
    assert.match(r.text, /not checked against the file as it was/);
  } finally {
    done();
  }
});

test("a check that runs out of time lets the change through, said not checked", async () => {
  const slow = async () => ({ code: null, out: "", timedOut: true });
  const g = await guardChange("x.js", "a", "b", { programs: false, runNode: slow });
  assert.deepEqual(g, { note: "syntax not checked: the check took too long" });
  const failing = async () => ({ code: 2, out: "weird", timedOut: false });
  assert.deepEqual(await guardChange("x.js", "a", "b", { programs: false, runNode: failing }), { note: "syntax not checked: the checker failed" });
  assert.equal((await checkText("x.json", "{", { programs: false, ms: 0 })).kind, "unchecked", "no time left: unchecked, never refused");
});

test("stopped, or the file changed, while the change was checked: nothing is written", async () => {
  const { dir, ctx, stop, done } = setup();
  try {
    const f = path.join(dir, "a.js");
    fs.writeFileSync(f, "const a = 1;\n");
    await read(ctx, f);
    ctx.checkWith = {
      runNode: async () => {
        fs.writeFileSync(f, "const a = 2; // someone else\n");
        fs.utimesSync(f, new Date(), new Date(Date.now() + 5000));
        return { code: 0, out: "", timedOut: false };
      },
    };
    const r = await edit(ctx, { file_path: f, old_string: "1", new_string: "3" });
    assert.equal(r.isError, true);
    assert.match(r.text, /changed on disk since it was read/);
    assert.equal(fs.readFileSync(f, "utf8"), "const a = 2; // someone else\n");
    // Stopped mid-check.
    await read(ctx, f);
    ctx.checkWith = {
      runNode: async () => {
        stop.abort();
        return { code: 0, out: "", timedOut: false };
      },
    };
    const s = await edit(ctx, { file_path: f, old_string: "2", new_string: "4" });
    assert.equal(s.isError, true);
    assert.match(s.text, /the step was stopped/);
    assert.match(fs.readFileSync(f, "utf8"), /a = 2/);
    // A new file that appeared while it was checked.
    const ctx2: ToolContext = { ...ctx, signal: new AbortController().signal };
    const n = path.join(dir, "n.js");
    ctx2.checkWith = {
      runNode: async () => {
        fs.writeFileSync(n, "// theirs\n");
        return { code: 0, out: "", timedOut: false };
      },
    };
    const w = await write(ctx2, { file_path: n, content: "const mine = 1;\n" });
    assert.equal(w.isError, true);
    assert.match(w.text, /appeared while the change was checked/);
    assert.equal(fs.readFileSync(n, "utf8"), "// theirs\n");
  } finally {
    done();
  }
});

test("Python is checked only where programs run unasked, with a system python3, and compile errors count", async (t) => {
  const py = systemPython();
  if (!py) return t.skip("no system python3 here");
  const { dir, ctx, done } = setup({ programs: true });
  try {
    const f = path.join(dir, "m.py");
    fs.writeFileSync(f, "def f():\n    return 1\n");
    await read(ctx, f);
    const r = await edit(ctx, { file_path: f, old_string: "def f():\n    return 1\n", new_string: "return 1\n" });
    assert.equal(r.isError, true, r.text);
    assert.match(r.text, /'return' outside function/);
    const ok = await edit(ctx, { file_path: f, old_string: "return 1", new_string: "return 2" });
    assert.equal(ok.isError, undefined, ok.text);
    // Without that permission: not checked, and nothing said about it.
    const { dir: d2, ctx: c2, done: done2 } = setup();
    try {
      const g = await write(c2, { file_path: path.join(d2, "x.py"), content: "def (:\n" });
      assert.equal(g.isError, undefined);
      assert.equal(g.text.split("\n").length, 1);
    } finally {
      done2();
    }
  } finally {
    done();
  }
});

test("files that allow comments are not held to strict JSON; others have no checker", () => {
  for (const f of ["tsconfig.json", "app/tsconfig.build.json", ".vscode/settings.json", "x.jsonc", ".devcontainer/devcontainer.json", ".eslintrc.json"]) assert.equal(checkerFor(f), null, f);
  assert.equal(checkerFor("package.json"), "json");
  assert.equal(checkerFor("a.ts"), null, "TypeScript waits for the language-server layer (FOL-297)");
  assert.equal(systemPython("darwin", (p) => p === "/usr/bin/python3"), null, "macOS /usr/bin/python3 without the command line tools would open a dialog");
  assert.equal(systemPython("darwin", (p) => p === "/usr/bin/python3" || p === "/Library/Developer/CommandLineTools/usr/bin/python3"), "/usr/bin/python3");
});
