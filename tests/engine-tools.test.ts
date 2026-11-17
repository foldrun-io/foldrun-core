// The foldrun engine's file and shell tools (src/engine-tools.ts): what
// each promises when the model gets it wrong — no match, two matches, a file
// it never read, one that changed under it, a command that never ends.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ENGINE_TOOLS, globToRegExp, occurrences, capped, RESULT_CAP, type ToolContext } from "../src/engine-tools.ts";

function withDir(body: (dir: string, ctx: ToolContext, stop: AbortController) => Promise<void>) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-engine-tools-")));
  const stop = new AbortController();
  const ctx: ToolContext = { cwd: dir, env: { PATH: process.env.PATH }, signal: stop.signal, reads: new Map() };
  return body(dir, ctx, stop).finally(() => fs.rmSync(dir, { recursive: true, force: true }));
}
const { Read, Write, Edit, Glob, Grep, Bash } = ENGINE_TOOLS;

test("Read numbers lines, pages a long file, and refuses what is not text", () =>
  withDir(async (dir, ctx) => {
    fs.writeFileSync(path.join(dir, "a.txt"), "one\ntwo\nthree\n");
    assert.equal((await Read.run({ file_path: "a.txt" }, ctx)).text, "1\tone\n2\ttwo\n3\tthree");
    const page = await Read.run({ file_path: "a.txt", offset: 2, limit: 1 }, ctx);
    assert.match(page.text, /^2\ttwo\n\n\[lines 2–2 of 3; pass offset: 3 for more\]$/);
    assert.equal((await Read.run({ file_path: "a.txt", offset: 9 }, ctx)).isError, true);
    assert.match((await Read.run({ file_path: "missing.txt" }, ctx)).text, /does not exist/);
    assert.match((await Read.run({ file_path: "." }, ctx)).text, /is a directory/);
    fs.writeFileSync(path.join(dir, "bin"), Buffer.from([1, 0, 2]));
    assert.match((await Read.run({ file_path: "bin" }, ctx)).text, /not a text file/);
    fs.writeFileSync(path.join(dir, "empty"), "");
    assert.equal((await Read.run({ file_path: "empty" }, ctx)).text, "(the file is empty)");
  }));

test("Edit replaces exact text once, and changes nothing when it cannot", () =>
  withDir(async (dir, ctx) => {
    const file = path.join(dir, "code.js");
    const original = "const a = 1;\nconst b = 1;\nreturn a + b;\n";
    fs.writeFileSync(file, original);

    const unread = await Edit.run({ file_path: "code.js", old_string: "a + b", new_string: "a - b" }, ctx);
    assert.match(unread.text, /has not been read in this session/);
    assert.equal(fs.readFileSync(file, "utf8"), original, "an unread file is untouched");

    await Read.run({ file_path: "code.js" }, ctx);
    const none = await Edit.run({ file_path: "code.js", old_string: "a * b", new_string: "x" }, ctx);
    assert.equal(none.isError, true);
    assert.match(none.text, /was not found .* nothing was changed/);
    const twice = await Edit.run({ file_path: "code.js", old_string: "= 1;", new_string: "= 2;" }, ctx);
    assert.match(twice.text, /occurs 2 times .* nothing was changed/);
    assert.equal(fs.readFileSync(file, "utf8"), original);

    const ok = await Edit.run({ file_path: "code.js", old_string: "return a + b;", new_string: "return a - b;" }, ctx);
    assert.equal(ok.isError, undefined);
    assert.equal(fs.readFileSync(file, "utf8"), "const a = 1;\nconst b = 1;\nreturn a - b;\n");
    // Its own write keeps the file fresh: a second edit needs no re-read.
    const all = await Edit.run({ file_path: "code.js", old_string: "= 1;", new_string: "= 2;", replace_all: true }, ctx);
    assert.match(all.text, /2 replacements/);
    assert.equal(fs.readFileSync(file, "utf8"), "const a = 2;\nconst b = 2;\nreturn a - b;\n");
    assert.deepEqual(fs.readdirSync(dir), ["code.js"], "no temporary file is left behind");
  }));

test("Edit treats the replacement as text, and says when only the line endings differ", () =>
  withDir(async (dir, ctx) => {
    fs.writeFileSync(path.join(dir, "t.txt"), "price: X\n");
    await Read.run({ file_path: "t.txt" }, ctx);
    await Edit.run({ file_path: "t.txt", old_string: "X", new_string: "$& and $1" }, ctx);
    assert.equal(fs.readFileSync(path.join(dir, "t.txt"), "utf8"), "price: $& and $1\n");

    fs.writeFileSync(path.join(dir, "crlf.txt"), "a\r\nb\r\n");
    await Read.run({ file_path: "crlf.txt" }, ctx);
    const r = await Edit.run({ file_path: "crlf.txt", old_string: "a\nb", new_string: "c" }, ctx);
    assert.match(r.text, /CRLF line endings/);
    assert.equal(fs.readFileSync(path.join(dir, "crlf.txt"), "utf8"), "a\r\nb\r\n");
  }));

test("a file that changed on disk since it was read is not written over", () =>
  withDir(async (dir, ctx) => {
    const file = path.join(dir, "shared.txt");
    fs.writeFileSync(file, "mine\n");
    await Read.run({ file_path: "shared.txt" }, ctx);
    fs.writeFileSync(file, "someone else's\n");
    fs.utimesSync(file, new Date(), new Date(Date.now() + 5000));
    for (const r of [
      await Edit.run({ file_path: "shared.txt", old_string: "someone", new_string: "x" }, ctx),
      await Write.run({ file_path: "shared.txt", content: "overwrite" }, ctx),
    ]) {
      assert.equal(r.isError, true);
      assert.match(r.text, /changed on disk since it was read/);
    }
    assert.equal(fs.readFileSync(file, "utf8"), "someone else's\n");
  }));

test("Write creates a file and its folders, and keeps an existing file's mode", () =>
  withDir(async (dir, ctx) => {
    const made = await Write.run({ file_path: "deep/er/new.txt", content: "hello" }, ctx);
    assert.match(made.text, /^Created /);
    assert.equal(fs.readFileSync(path.join(dir, "deep/er/new.txt"), "utf8"), "hello");
    const script = path.join(dir, "run.sh");
    fs.writeFileSync(script, "#!/bin/sh\n", { mode: 0o755 });
    assert.match((await Write.run({ file_path: "run.sh", content: "x" }, ctx)).text, /has not been read/);
    await Read.run({ file_path: "run.sh" }, ctx);
    assert.match((await Write.run({ file_path: "run.sh", content: "#!/bin/sh\necho hi\n" }, ctx)).text, /^Wrote /);
    assert.equal(fs.statSync(script).mode & 0o777, 0o755);
  }));

test("Glob and Grep find files, skip dependencies, and bound what they return", () =>
  withDir(async (dir, ctx) => {
    for (const [f, text] of Object.entries({
      "src/a.ts": "export const alpha = 1;\n",
      "src/deep/b.ts": "export const beta = 2;\n// alpha again\n",
      "src/c.md": "alpha in prose\n",
      "node_modules/x/index.ts": "alpha in a dependency\n",
      ".git/config": "alpha in git\n",
    })) {
      fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
      fs.writeFileSync(path.join(dir, f), text);
    }
    const ts = (await Glob.run({ pattern: "**/*.ts" }, ctx)).text.split("\n").map((p) => path.relative(dir, p)).sort();
    assert.deepEqual(ts, ["src/a.ts", "src/deep/b.ts"]);
    assert.equal((await Glob.run({ pattern: "*.md" }, ctx)).text, path.join(dir, "src/c.md"), "a bare name matches at any depth");
    assert.match((await Glob.run({ pattern: "*.py" }, ctx)).text, /^No files match/);

    const files = (await Grep.run({ pattern: "alpha" }, ctx)).text.split("\n").map((p) => path.relative(dir, p));
    assert.deepEqual(files, ["src/a.ts", "src/c.md", "src/deep/b.ts"]);
    const lines = (await Grep.run({ pattern: "ALPHA", "-i": true, glob: "*.ts", output_mode: "content" }, ctx)).text;
    assert.equal(lines, `${path.join(dir, "src/a.ts")}:1:export const alpha = 1;\n${path.join(dir, "src/deep/b.ts")}:2:// alpha again`);
    assert.equal((await Grep.run({ pattern: "alpha", path: "src/a.ts", output_mode: "count" }, ctx)).text, `${path.join(dir, "src/a.ts")}:1`);
    assert.match((await Grep.run({ pattern: "(" }, ctx)).text, /not a valid regular expression/);
    assert.match((await Grep.run({ pattern: "alpha", head_limit: 1 }, ctx)).text, /\[2 more not shown/);
  }));

test("globs and counting", () => {
  assert.ok(globToRegExp("src/**/*.test.{ts,js}").test("src/a/b/x.test.js"));
  assert.ok(globToRegExp("src/**/*.ts").test("src/x.ts"));
  assert.ok(!globToRegExp("src/*.ts").test("src/a/x.ts"));
  assert.ok(!globToRegExp("a.b").test("aXb"));
  assert.equal(occurrences("aaaa", "aa"), 2);
  const long = capped("x".repeat(RESULT_CAP + 100));
  assert.ok(long.length < RESULT_CAP + 100 && /\[… 100 characters cut …\]/.test(long));
});

test("Bash returns output and exit code, in the working directory, with the step's environment", () =>
  withDir(async (dir, ctx) => {
    ctx.env = { ...ctx.env, GREETING: "hi" };
    assert.equal((await Bash.run({ command: "echo $GREETING; pwd" }, ctx)).text, `hi\n${dir}`);
    const failed = await Bash.run({ command: "echo out; echo err >&2; exit 3" }, ctx);
    assert.equal(failed.isError, true);
    assert.equal(failed.text, "out\nerr\n[exit code 3]");
    assert.equal((await Bash.run({ command: "true" }, ctx)).text, "(no output)");
  }));

test("a command past its timeout, or running when the step stops, is ended with what it started", () =>
  withDir(async (dir, ctx, stop) => {
    const started = Date.now();
    const slow = await Bash.run({ command: "echo begun; sleep 30", timeout: 1000 }, ctx);
    assert.equal(slow.isError, true);
    assert.match(slow.text, /^begun\n\[stopped after 1000 ms/);
    assert.ok(Date.now() - started < 8000, "it did not wait for the sleep");

    // A child the command left behind dies with it: the marker is never written.
    const marker = path.join(dir, "survivor");
    const running = Bash.run({ command: `(sleep 2; touch ${marker}) & sleep 30` }, ctx);
    setTimeout(() => stop.abort(), 300);
    const stopped = await running;
    assert.match(stopped.text, /\[stopped with the step\]/);
    await new Promise((r) => setTimeout(r, 2500));
    assert.equal(fs.existsSync(marker), false, "the background child was killed with its group");
  }));
