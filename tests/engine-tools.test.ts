// The foldrun engine's file and shell tools (src/engine-tools.ts): what
// each promises when the model gets it wrong — no match, two matches, a file
// it never read, one that changed under it, a command that never ends.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ENGINE_TOOLS, imageMediaType, READ_IMAGE_BYTES, globToRegExp, killGroups, occurrences, capped, RESULT_CAP, matchInWorker, globMatcher, type ToolContext } from "../src/engine-tools.ts";

function withDir(body: (dir: string, ctx: ToolContext, stop: AbortController) => Promise<void>) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-engine-tools-")));
  const stop = new AbortController();
  const ctx: ToolContext = { cwd: dir, env: { PATH: process.env.PATH }, signal: stop.signal, reads: new Map(), groups: new Set() };
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

test("a costly Grep pattern is ended at its time limit or a stop, and never freezes the process", () =>
  withDir(async (dir, ctx, stop) => {
    const file = path.join(dir, "evil.txt");
    fs.writeFileSync(file, `${"a".repeat(40)}!\n`);
    const job = { pattern: "^(a+)+$", flags: "", files: [file], mode: "files_with_matches", limit: 10, maxBytes: 1 << 20 };
    let ticks = 0;
    const clock = setInterval(() => ticks++, 20);
    const started = Date.now();
    const r = await matchInWorker(job, ctx.signal, 300);
    clearInterval(clock);
    assert.deepEqual(r, { timedOut: true });
    assert.ok(Date.now() - started < 5000, "ended near its limit");
    assert.ok(ticks >= 5, "the event loop kept running while the pattern did");

    setTimeout(() => stop.abort(), 100);
    assert.deepEqual(await matchInWorker(job, ctx.signal, 60_000), { stopped: true });
    assert.deepEqual(await matchInWorker({ ...job, pattern: "a" }, ctx.signal, 60_000), { stopped: true }, "already stopped: no worker");
    // A glob that backtracks for ages as a regular expression is matched
    // in bounded time.
    fs.writeFileSync(path.join(dir, `${"a".repeat(200)}.txt`), "x\n");
    const wild = `${"*a".repeat(30)}*b`;
    const live = { ...ctx, signal: new AbortController().signal };
    const t0 = Date.now();
    assert.match((await ENGINE_TOOLS.Glob.run({ pattern: wild }, live)).text, /^No files match/);
    assert.match((await ENGINE_TOOLS.Grep.run({ pattern: "x", glob: wild }, live)).text, /^No matches/);
    assert.ok(Date.now() - t0 < 2000, `took ${Date.now() - t0} ms`);
    const braces = "{a,b,c}{d,e,f}{g,h,i}{j,k,l}";
    assert.match((await ENGINE_TOOLS.Glob.run({ pattern: braces }, live)).text, /more than 64 patterns/);
  }));

test("globMatcher agrees with globToRegExp", () => {
  const globs = ["*.ts", "src/**/*.ts", "src/**/*.test.{ts,js}", "**/x", "a?c", "**", "*", "src/*/b.md", "**/*.{md,mdx}", "a.b", "x+y(1)", "**/"];
  const paths = ["a.ts", "src/a.ts", "src/x/y/a.ts", "src/a/b/x.test.js", "x", "d/x", "d/e/x", "abc", "a/c", "src/q/b.md", "src/q/r/b.md", "docs/a.mdx", "a.b", "axb", "x+y(1)", "src/", "", "dir/", "a\nb.ts", "d/a\r.md"];
  for (const g of globs) for (const p of paths) assert.equal(globMatcher(g)(p), globToRegExp(g).test(p), `${g} vs ${p}`);
});

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

test("a link is edited through to its target, and stays a link", () =>
  withDir(async (dir, ctx) => {
    fs.writeFileSync(path.join(dir, "real.txt"), "old\n");
    fs.symlinkSync("real.txt", path.join(dir, "link.txt"));
    await Read.run({ file_path: "link.txt" }, ctx);
    const r = await Edit.run({ file_path: "link.txt", old_string: "old", new_string: "new" }, ctx);
    assert.equal(r.isError, undefined, r.text);
    assert.equal(fs.readFileSync(path.join(dir, "real.txt"), "utf8"), "new\n");
    assert.equal(fs.lstatSync(path.join(dir, "link.txt")).isSymbolicLink(), true);
  }));

test("Glob looks inside the folders a pattern names, through a link; Grep tests a named file by its own name", () =>
  withDir(async (dir, ctx) => {
    const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-engine-ws-")));
    try {
      fs.mkdirSync(path.join(outside, "storage"));
      fs.writeFileSync(path.join(outside, "storage", "report.md"), "total: 3\n");
      fs.symlinkSync(outside, path.join(dir, "workspace"));
      assert.equal((await Glob.run({ pattern: "workspace/storage/*.md" }, ctx)).text, path.join(outside, "storage", "report.md"));
      assert.match((await Glob.run({ pattern: "workspace/nowhere/*.md" }, ctx)).text, /^No files match/);
      const hit = await Grep.run({ pattern: "total", path: "workspace/storage/report.md", glob: "*.md" }, ctx);
      assert.equal(hit.text, path.join(outside, "storage", "report.md"));
      assert.match((await Grep.run({ pattern: "total", path: "workspace/storage/report.md", glob: "*.ts" }, ctx)).text, /^No matches/);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  }));

test("what a command left in the background is ended when the session ends", () =>
  withDir(async (dir, ctx) => {
    const marker = path.join(dir, "late");
    const r = await Bash.run({ command: `(sleep 2; touch ${marker}) >/dev/null 2>&1 & echo started` }, ctx);
    assert.equal(r.text, "started", "the command itself returned at once");
    assert.equal(ctx.groups.size, 1);
    killGroups(ctx);
    await new Promise((done) => setTimeout(done, 2500));
    assert.equal(fs.existsSync(marker), false, "the background job did not outlive the session");
  }));

test("a background job that keeps the output open does not hold the command: it returns when the shell ends, and says so (FOL-273)", () =>
  withDir(async (dir, ctx) => {
    const started = Date.now();
    const r = await Bash.run({ command: "sleep 30 & echo started" }, ctx);
    assert.ok(Date.now() - started < 5000, `returned in ${Date.now() - started} ms, not at the timeout`);
    assert.match(r.text, /^started\n\[it left something running in the background/);
    assert.equal(r.isError, undefined);
    killGroups(ctx);
    // The job is not killed by the call returning: a later write still lands (Codex).
    const marker = path.join(dir, "wrote-later");
    const r2 = await Bash.run({ command: `(sleep 1; echo late; touch ${marker}) & echo begun` }, ctx);
    assert.match(r2.text, /^begun\n\[it left something running/);
    await new Promise((done) => setTimeout(done, 1800));
    assert.equal(fs.existsSync(marker), true, "the job went on after its first write");
    // A job that prints without pause does not hold the call.
    const t0 = Date.now();
    const r3 = await Bash.run({ command: "(while true; do echo tick; sleep 0.05; done) & echo looping" }, ctx);
    assert.ok(Date.now() - t0 < 4000, `returned in ${Date.now() - t0} ms`);
    // The job may print before the shell does: the shell's line is there, in any order (it failed CI, 25 Nov).
    assert.match(r3.text, /(^|\n)looping(\n|$)/);
    assert.equal(r3.isError, undefined, "the shell succeeded: no timeout for what it left");
    killGroups(ctx);
    const r4 = await Bash.run({ command: "(while true; do echo tick; sleep 0.05; done) & echo short", timeout: 1000 }, ctx);
    assert.equal(r4.isError, undefined, `a 1 s timeout does not fire while a job's output drains: ${r4.text.slice(-120)}`);
    killGroups(ctx);
    // And a plain command's output still arrives whole.
    const big = await Bash.run({ command: "seq 1 20000 | tail -1" }, ctx);
    assert.equal(big.text, "20000");
  }));

test("Read shows an image as an image, known by its bytes; too large is refused with what to do; a renamed binary stays refused (FOL-295)", () =>
  withDir(async (dir, ctx) => {
    const ihdr = Buffer.alloc(16);
    ihdr.writeUInt32BE(13, 0);
    ihdr.write("IHDR", 4, "latin1");
    ihdr.writeUInt32BE(640, 8);
    ihdr.writeUInt32BE(480, 12);
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), ihdr, Buffer.alloc(100, 1)]);
    fs.writeFileSync(path.join(dir, "shot.dat"), png);
    const r = await Read.run({ file_path: "shot.dat" }, ctx);
    assert.equal(r.isError, undefined);
    assert.match(r.text, /shot\.dat: PNG image, 640×480 px, 1 KB$/);
    fs.writeFileSync(path.join(dir, "broken.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]));
    assert.match((await Read.run({ file_path: "broken.png" }, ctx)).text, /header cannot be read/);
    assert.equal(r.parts?.length, 2);
    assert.deepEqual(r.parts?.[1], { type: "image", data: png.toString("base64"), mediaType: "image/png" });
    // Read counts as read: Write may then replace it.
    assert.equal((await Write.run({ file_path: "shot.dat", content: "x" }, ctx)).isError, undefined);
    assert.equal(imageMediaType(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), "image/jpeg");
    assert.equal(imageMediaType(Buffer.from("GIF89a....")), "image/gif");
    assert.equal(imageMediaType(Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBP")])), "image/webp");
    fs.writeFileSync(path.join(dir, "fake.png"), Buffer.from([0, 1, 2, 3, 0, 0, 9]));
    assert.match((await Read.run({ file_path: "fake.png" }, ctx)).text, /not a text file/, "a name is not enough");
    fs.writeFileSync(path.join(dir, "big.png"), Buffer.concat([png, Buffer.alloc(READ_IMAGE_BYTES)]));
    const big = await Read.run({ file_path: "big.png" }, ctx);
    assert.equal(big.isError, true);
    assert.match(big.text, /larger than a model is shown \(3\.75 MB\); make a smaller copy/);
  }));

test("the person's images go with the prompt, after its text, as image blocks (FOL-268)", async () => {
  const { readOptions } = await import("../src/engine-common.ts");
  const o = readOptions({ model: "m", images: [{ data: "AAAA", mediaType: "image/png" }, { data: "x", mediaType: "text/html" }, null] });
  assert.deepEqual(o.images, [{ data: "AAAA", mediaType: "image/png" }], "only well-formed images");
  assert.equal(readOptions({ model: "m" }).images, undefined);
  assert.throws(() => readOptions({ model: "m", images: [{ data: "not base64!", mediaType: "image/png" }] }), /not base64/);
  assert.throws(() => readOptions({ model: "m", images: [{ data: "A".repeat(6_000_000), mediaType: "image/png" }] }), /at most 3\.75 MB/);
});

test("Bash run_in_background: a job id at once, its new output on each read, stdin, wait, stop, and an end with the step (FOL-293)", () =>
  withDir(async (dir, ctx) => {
    const started = await Bash.run({ command: "echo ready; while read l; do echo \"got $l\"; [ \"$l\" = bye ] && exit 3; done", run_in_background: true }, ctx);
    assert.match(started.text, /^job b1 is running .* — started in the background/);
    assert.match(started.text, /\nready$/);
    assert.equal(started.isError, undefined);
    // Nothing new since: said plainly, not the old lines again.
    assert.match((await Bash.run({ job: "b1" }, ctx)).text, /is running[\s\S]*\(no new output\)$/);
    await Bash.run({ job: "b1", stdin: "one\n" }, ctx);
    const one = await Bash.run({ job: "b1", wait: 300 }, ctx);
    assert.match(one.text, /got one$/);
    assert.doesNotMatch(one.text, /ready/);
    // stdin, then wait for the end: the exit code is the job's own.
    const end = await Bash.run({ job: "b1", stdin: "bye\n", wait: 5000 }, ctx);
    assert.match(end.text, /^job b1 has ended — exit code 3\ngot bye$/);
    assert.equal(end.isError, true);
    assert.match((await Bash.run({ job: "b1", stdin: "x\n" }, ctx)).text, /its input is closed/);
    // A server that never ends: stop takes it and what it started.
    const srv = await Bash.run({ command: "sleep 60 & sleep 60; echo never", run_in_background: true }, ctx);
    assert.match(srv.text, /^job b2 is running/);
    const pid = ctx.jobs!.get("b2")!.pid!;
    const stopped = await Bash.run({ job: "b2", stop: true }, ctx);
    assert.match(stopped.text, /b2/);
    assert.throws(() => process.kill(-pid, 0), "the whole group is gone");
    assert.match((await Bash.run({ job: "b2" }, ctx)).text, /no background job b2 in this step \(there are: b1\)/);
    // The wrong shapes say what goes with what.
    assert.match((await Bash.run({ stdin: "x" }, ctx)).text, /stdin goes with job/);
    assert.match((await Bash.run({ job: "b1", command: "ls" }, ctx)).text, /either command .* or job/);
    // What is left running ends with the step.
    // An id is never given twice: the next job is b3, so a stale b2 names nothing.
    assert.match((await Bash.run({ command: "sleep 60", run_in_background: true }, ctx)).text, /^job b3 is running/);
    const left = ctx.jobs!.get("b3")!.pid!;
    killGroups(ctx);
    await new Promise((r) => setTimeout(r, 200));
    assert.throws(() => process.kill(-left, 0));
    void dir;
  }));

test("checkBashInput: text written into a background job is checked as a command is (FOL-293)", async () => {
  const { checkBashInput } = await import("../src/confine.ts");
  assert.equal(checkBashInput({ job: "b1", stdin: "cat ~/.ssh/id_rsa\n" }).ok, false);
  assert.equal(checkBashInput({ job: "b1", stdin: "npm test\n" }).ok, true);
  assert.equal(checkBashInput({ command: "ls" }).ok, true);
  // Whole lines only, so a line cannot be built from pieces each of which passes.
  assert.equal(checkBashInput({ job: "b1", stdin: "cat ~" }).ok, false);
  assert.equal(checkBashInput({ job: "b1", stdin: "cat \\\n" }).ok, false);
  assert.equal(checkBashInput({ job: "b1", stdin: "echo 'a\n" }).ok, false);
  assert.equal(checkBashInput({ job: "b1", stdin: "echo \"it's\"\n" }).ok, false, "conservative: a lone quote in a line is refused");
  assert.equal(checkBashInput({ job: "b1", stdin: "echo 'ok'\n" }).ok, true);
});

test("Bash job: stop ends what an exited shell left running; a job that never reads its input does not hold the call (FOL-293)", () =>
  withDir(async (_dir, ctx) => {
    await Bash.run({ command: "sleep 60 & echo left", run_in_background: true }, ctx);
    const pid = ctx.jobs!.get("b1")!.pid!;
    await Bash.run({ job: "b1", wait: 2000 }, ctx);
    assert.ok(ctx.jobs!.get("b1")!.exit, "the shell itself exited");
    assert.doesNotThrow(() => process.kill(-pid, 0), "its sleep is still there");
    await Bash.run({ job: "b1", stop: true }, ctx);
    await new Promise((r) => setTimeout(r, 300));
    assert.throws(() => process.kill(-pid, 0), "stop ended the group anyway");
    await Bash.run({ command: "sleep 60", run_in_background: true }, ctx);
    const t0 = Date.now();
    const big = await Bash.run({ job: "b2", stdin: "x".repeat(4 * 1024 * 1024) }, ctx);
    assert.match(big.text, /has not read its input for 5 s/);
    assert.ok(Date.now() - t0 < 8000);
    killGroups(ctx);
  }));

test("Edit edits: one change across files, all or nothing (FOL-294)", () =>
  withDir(async (dir, ctx) => {
    fs.writeFileSync(path.join(dir, "a.ts"), "export function oldName() { return 1; }\n");
    fs.writeFileSync(path.join(dir, "b.ts"), "import { oldName } from './a';\noldName();\noldName();\n");
    for (const f of ["a.ts", "b.ts"]) await Read.run({ file_path: f }, ctx);
    const ok = await Edit.run({ edits: [
      { file_path: "a.ts", old_string: "oldName", new_string: "newName" },
      { file_path: "b.ts", old_string: "oldName", new_string: "newName", replace_all: true },
    ] }, ctx);
    assert.equal(ok.isError, undefined, ok.text);
    assert.match(ok.text, /^Edited 2 files \(4 replacements\)/);
    assert.equal(fs.readFileSync(path.join(dir, "b.ts"), "utf8"), "import { newName } from './a';\nnewName();\nnewName();\n");
    // One change that does not match: no file is touched, and the answer names which.
    const before = { a: fs.readFileSync(path.join(dir, "a.ts"), "utf8"), b: fs.readFileSync(path.join(dir, "b.ts"), "utf8") };
    const no = await Edit.run({ edits: [
      { file_path: "a.ts", old_string: "newName", new_string: "third" },
      { file_path: "b.ts", old_string: "not there", new_string: "x" },
    ] }, ctx);
    assert.match(no.text, /^nothing was changed: .*b\.ts, change 1: old_string was not found/);
    assert.equal(fs.readFileSync(path.join(dir, "a.ts"), "utf8"), before.a);
    // Changes to one file apply in order, each against the text the one before left.
    const chain = await Edit.run({ edits: [
      { file_path: "a.ts", old_string: "newName", new_string: "mid" },
      { file_path: "a.ts", old_string: "mid()", new_string: "last()" },
    ] }, ctx);
    assert.match(chain.text, /^Edited 1 file \(2 replacements\)/);
    assert.match(fs.readFileSync(path.join(dir, "a.ts"), "utf8"), /function last\(\)/);
    // A file not Read first, a syntax break, the same file by two paths, or mixed shapes: refused, nothing written.
    fs.writeFileSync(path.join(dir, "c.ts"), "const c = 1;\n");
    assert.match((await Edit.run({ edits: [{ file_path: "c.ts", old_string: "1", new_string: "2" }] }, ctx)).text, /^nothing was changed: .*Read/);
    await Read.run({ file_path: "c.ts" }, ctx);
    fs.symlinkSync(path.join(dir, "c.ts"), path.join(dir, "c-link.ts"));
    await Read.run({ file_path: "c-link.ts" }, ctx);
    // The same file by a link is one file: its changes apply in order, written once.
    assert.match((await Edit.run({ edits: [{ file_path: "c.ts", old_string: "1", new_string: "2" }, { file_path: "c-link.ts", old_string: "const", new_string: "let" }] }, ctx)).text, /^Edited 1 file \(2 replacements\)/);
    assert.equal(fs.readFileSync(path.join(dir, "c.ts"), "utf8"), "let c = 2;\n");
    fs.writeFileSync(path.join(dir, "d.json"), '{"a": 1, "b": 2}\n');
    await Read.run({ file_path: "d.json" }, ctx);
    assert.match((await Edit.run({ edits: [{ file_path: "a.ts", old_string: "last", new_string: "x2" }, { file_path: "d.json", old_string: '1, "b"', new_string: '1 "b"' }] }, ctx)).text, /^nothing was changed: .*would stop parsing/);
    assert.match(fs.readFileSync(path.join(dir, "a.ts"), "utf8"), /function last\(\)/, "the good file was not written either");
    assert.match((await Edit.run({ file_path: "c.ts", edits: [{ file_path: "c.ts", old_string: "1", new_string: "2" }] }, ctx)).text, /either edits or file_path/);
  }));

test("checkPaths: every file in Edit's edits is held to the workspace (FOL-294)", async () => {
  const { checkPaths } = await import("../src/confine.ts");
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-confine-")));
  const agentDir = path.join(root, "agents", "a");
  fs.mkdirSync(agentDir, { recursive: true });
  fs.mkdirSync(path.join(root, "knowledge"), { recursive: true });
  const roots = { agentDir, workspaceRoot: root, libraryRoot: path.join(root, "..", "library-x") };
  assert.equal(checkPaths("Edit", { edits: [{ file_path: "x.md", old_string: "a", new_string: "b" }] }, roots).ok, true);
  assert.equal(checkPaths("Edit", { edits: [{ file_path: "x.md", old_string: "a", new_string: "b" }, { file_path: "/etc/hosts", old_string: "a", new_string: "b" }] }, roots).ok, false);
  assert.equal(checkPaths("Edit", { edits: [{ file_path: "workspace/knowledge/p.md", old_string: "a", new_string: "b" }] }, roots).ok, false);
  const v = checkPaths("Edit", { edits: [{ file_path: "workspace/storage/r.md", old_string: "a", new_string: "b" }] }, roots);
  assert.equal(v.ok, true);
  assert.equal((v.updatedInput as any)?.edits?.[0]?.file_path, path.join(root, "storage", "r.md"), "spelled out as one Edit's would be");
  fs.rmSync(root, { recursive: true, force: true });
});
