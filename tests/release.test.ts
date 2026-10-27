// The version rules: scripts/release.mjs and scripts/surface.mjs.
//
//   PATCH  a bug fix, nothing new           1.0.0 → 1.0.1
//   MINOR  a feature, nothing old broken    1.0.0 → 1.1.0
//   MAJOR  a break: something old is gone,  1.0.0 → 2.0.0
//          or works differently
//
// The surface parser is held to what Node really exports from every public
// entry point; the release script is run for real in a throwaway repository.
//
//   node --test tests/release.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
// @ts-expect-error — a plain .mjs script, no declarations
import { surface, exportsOf, requiredCount, statements } from "../scripts/surface.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const readHere = (p: string) => {
  try {
    return fs.readFileSync(path.join(root, p), "utf8");
  } catch {
    return null;
  }
};

test("the public API is declared, and every entry in it resolves to a source file", () => {
  const pkg = JSON.parse(readHere("package.json")!);
  const api: string[] = pkg.foldrun.publicApi;
  assert.ok(api.includes("."), "the root is public");
  const s = surface(readHere);
  for (const entry of api) assert.ok(s[`entry ${entry}`], `${entry} resolves to a file`);
});

test("the parser finds exactly the values Node exports from each public entry point", async () => {
  const pkg = JSON.parse(readHere("package.json")!);
  for (const entry of pkg.foldrun.publicApi as string[]) {
    const file = entry === "." ? "index.ts" : `src/${entry.slice(2)}.ts`;
    const runtime = Object.keys(await import(path.join(root, file))).sort();
    const parsed = [...(exportsOf(file, readHere, new Set()) as Map<string, { kind: string }>)]
      .filter(([, d]) => d.kind !== "interface" && d.kind !== "type")
      .map(([n]) => n)
      .sort();
    assert.deepEqual(parsed, runtime, `${entry}: parsed exports = runtime exports`);
  }
});

test("a function's required arguments never exceed what Node counts", async () => {
  const mod = await import(path.join(root, "index.ts"));
  for (const [name, d] of exportsOf("index.ts", readHere, new Set()) as Map<string, { kind: string; required?: number }>) {
    if (d.kind !== "function" || typeof mod[name] !== "function") continue;
    assert.ok(d.required! <= mod[name].length, `${name}: ${d.required} required, Node counts ${mod[name].length}`);
  }
});

test("required arguments: optional, defaulted, destructured and rest parameters", () => {
  assert.equal(requiredCount(""), 0);
  assert.equal(requiredCount("a: string, b: number"), 2);
  assert.equal(requiredCount("a: string, b?: number"), 1);
  assert.equal(requiredCount("a: string, b = 3"), 1);
  assert.equal(requiredCount("a: string, b: Map<string, number> = new Map()"), 1);
  assert.equal(requiredCount("a: (x: number) => void, b: string"), 2);
  assert.equal(requiredCount("{ a, b }: Opts = {}"), 0);
  assert.equal(requiredCount("{ a, b }: Opts, c?: string"), 1);
  assert.equal(requiredCount("a: string, ...rest: string[]"), 1);
  assert.equal(requiredCount('a = "x,y", b: string'), 0);
});

test("a doc comment with @deprecated marks the declaration under it, and only that one", () => {
  const src = [
    "/** Old.",
    " * @deprecated use b */",
    "export function a() {}",
    "",
    "/** New. */",
    "export function b() {}",
    "// @deprecated, the line kind",
    "export const c = 1;",
  ].join("\n");
  const st = statements(src) as { text: string; deprecated: boolean }[];
  assert.deepEqual(
    st.map((s) => [s.text.split("\n")[0], s.deprecated]),
    [
      ["export function a() {}", true],
      ["export function b() {}", false],
      ["export const c = 1;", true],
    ],
  );
});

// ------------------------------------------------------------- the release script

/** A repository with this package's release tooling, released at `version`. */
function repo(version: string, index: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-release-"));
  fs.mkdirSync(path.join(dir, "scripts"));
  for (const f of ["release.mjs", "surface.mjs", "surface-change.mjs"]) fs.copyFileSync(path.join(root, "scripts", f), path.join(dir, "scripts", f));
  fs.writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({ name: "@foldrun/core", version, engines: { node: ">=22" }, foldrun: { publicApi: ["."] } }, null, 2) + "\n",
  );
  fs.writeFileSync(path.join(dir, "CHANGELOG.md"), "# Changelog\n\n<!-- releases -->\n");
  fs.writeFileSync(path.join(dir, "index.ts"), index);
  const g = (...a: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "core.hooksPath=/dev/null", ...a], { cwd: dir, encoding: "utf8" });
  g("init", "-q", "-b", "main");
  g("add", ".");
  g("commit", "-qm", "first");
  g("tag", "-a", `v${version}`, "-m", version);
  const commit = (message: string, files: Record<string, string>) => {
    for (const [f, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, f), text);
    g("add", ".");
    g("commit", "-qm", message);
  };
  const release = (...args: string[]) => {
    const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
    const r = spawnSync(process.execPath, ["scripts/release.mjs", ...args], { cwd: dir, encoding: "utf8", env });
    return { code: r.status, out: r.stdout + r.stderr, next: (r.stdout.match(/→ (\S+)/) ?? [])[1] };
  };
  return { dir, g, commit, release };
}

const BASE = "export function a(x: string) {}\nexport function b() {}\n";

test("PATCH: fixes only, nothing new", () => {
  const r = repo("1.0.0", BASE);
  r.commit("fix: a handles an empty string", { "index.ts": BASE + "// fixed\n" });
  assert.equal(r.release().next, "1.0.1");
});

test("PATCH: Dependabot's build(deps) bumps are dependency changes, not features", () => {
  const r = repo("1.0.0", BASE);
  r.commit("build(deps): bump zod from 4.4.3 to 4.4.4", { "index.ts": BASE + "// bumped\n" });
  r.commit("build(deps-dev): bump typescript from 6.0.3 to 6.0.4", { "index.ts": BASE + "// bumped again\n" });
  assert.equal(r.release().next, "1.0.1");
});

test("MINOR: a new export is a feature, even when every commit says fix", () => {
  const r = repo("1.0.0", BASE);
  r.commit("fix: a small thing", { "index.ts": BASE + "export function c() {}\n" });
  const out = r.release();
  assert.equal(out.next, "1.1.0");
  assert.match(out.out, /### New in the public API\n\n- `c` from `@foldrun\/core`/);
});

test("MINOR: a commit that is not a fix is a feature", () => {
  const r = repo("1.0.0", BASE);
  r.commit("runs: a new way to rerun", { "index.ts": BASE + "// feature inside\n" });
  assert.equal(r.release().next, "1.1.0");
});

test("MAJOR: a removed export is a break nobody had to label", () => {
  const r = repo("1.0.0", BASE);
  r.commit("tidy: one function fewer", { "index.ts": "export function a(x: string) {}\n" });
  const out = r.release();
  assert.equal(out.next, "2.0.0");
  assert.match(out.out, /### Breaking changes\n\n- `b` from `@foldrun\/core` is gone \(it was never deprecated\)/);
});

test("MAJOR: a function that now needs more arguments is a break; an optional one is not", () => {
  const r = repo("1.0.0", BASE);
  r.commit("runs: b takes an option", { "index.ts": "export function a(x: string, y?: number) {}\nexport function b() {}\n" });
  assert.equal(r.release().next, "1.1.0");
  r.commit("runs: a needs y", { "index.ts": "export function a(x: string, y: number) {}\nexport function b() {}\n" });
  const out = r.release();
  assert.equal(out.next, "2.0.0");
  assert.match(out.out, /`a` from `@foldrun\/core` now needs 2 arguments, was 1/);
});

// 27 Oct 2026: releases merge themselves, so a changed declaration is
// judged by the rule (surface-change.mjs), not left for a person.
test("an interface that only gains an optional member is a minor; a required one, or a retype, is a major", () => {
  const I = (body: string) => `export interface Run { id: string;${body} }\n`;
  const r = repo("1.0.0", I(""));
  r.commit("fix: note", { "index.ts": I(" note?: string;") });
  const minor = r.release();
  assert.equal(minor.next, "1.1.0", "widened, even under a fix: commit");
  assert.match(minor.out, /### Widened in the public API\n[\s\S]*- `Run` from `@foldrun\/core`/);
  r.commit("fix: owner", { "index.ts": I(" note?: string; owner: string;") });
  const major = r.release();
  assert.equal(major.next, "2.0.0");
  assert.match(major.out, /`Run` from `@foldrun\/core` — owner is new and required/);
  const r2 = repo("1.0.0", I(" n: number;"));
  r2.commit("fix: wider n", { "index.ts": I(" n: number | string;") });
  assert.equal(r2.release().next, "2.0.0", "a retyped member");
});

test("MAJOR: a behaviour change marked with ! or a BREAKING CHANGE footer; a mention is not a mark", () => {
  const r = repo("1.0.0", BASE);
  r.commit("runs: tidy\n\nThis is not a breaking change.", { "index.ts": BASE + "//1\n" });
  assert.equal(r.release().next, "1.1.0", "a body that only mentions breaking");
  r.commit("runs!: a stopped run now keeps its sandbox", { "index.ts": BASE + "//2\n" });
  const out = r.release();
  assert.equal(out.next, "2.0.0");
  assert.match(out.out, /### Breaking changes\n\n- a stopped run now keeps its sandbox/);
  const r2 = repo("1.0.0", BASE);
  r2.commit("runs: retries\n\nBREAKING CHANGE: retry: now counts the first attempt.", { "index.ts": BASE + "//3\n" });
  assert.match(r2.release().out, /2\.0\.0[\s\S]*- retry: now counts the first attempt\./);
});

test("MAJOR: requiring a newer Node.js is a break", () => {
  const r = repo("1.0.0", BASE);
  const pkg = JSON.parse(fs.readFileSync(path.join(r.dir, "package.json"), "utf8"));
  pkg.engines.node = ">=24";
  r.commit("deps: node 24", { "package.json": JSON.stringify(pkg, null, 2) + "\n" });
  const out = r.release();
  assert.equal(out.next, "2.0.0");
  assert.match(out.out, /Node\.js it runs on \(>=24\) — was >=22/);
});

test("deprecating is a minor; removing it later is a major that does not complain", () => {
  const r = repo("1.0.0", BASE);
  r.commit("runs: b is on its way out", { "index.ts": "export function a(x: string) {}\n/** @deprecated use a */\nexport function b() {}\n" });
  const out = r.release("--yes", "--no-tag");
  assert.equal(out.next, "1.1.0");
  assert.match(out.out, /### Deprecated[\s\S]*- `b` from `@foldrun\/core`/);
  r.g("tag", "-a", "v1.1.0", "-m", "1.1.0");
  r.commit("runs: b is gone", { "index.ts": "export function a(x: string) {}\n" });
  const gone = r.release();
  assert.equal(gone.next, "2.0.0");
  assert.match(gone.out, /- `b` from `@foldrun\/core` is gone\n/);
});

test("a bump flag may raise the version, never lower it below a break", () => {
  const r = repo("1.0.0", BASE);
  r.commit("fix: small", { "index.ts": BASE + "//x\n" });
  assert.equal(r.release("--minor").next, "1.1.0");
  r.commit("tidy: drop b", { "index.ts": "export function a(x: string) {}\n" });
  const out = r.release("--minor");
  assert.equal(out.code, 1);
  assert.match(out.out, /--minor is below what this release is: a major/);
});

test("pre-releases count up, sort before the release, and the release follows from the stable tag", () => {
  const r = repo("1.0.0", BASE);
  r.commit("runs: something new", { "index.ts": BASE + "export function c() {}\n" });
  const rc1 = r.release("--pre", "rc", "--yes");
  assert.equal(rc1.next, "1.1.0-rc.1");
  assert.ok(r.g("tag", "--list").includes("v1.1.0-rc.1"));
  r.commit("fix: c in the rc", { "index.ts": BASE + "export function c() { return 1; }\n" });
  assert.equal(r.release("--pre", "rc").next, "1.1.0-rc.2");
  // The release: everything since v1.0.0, the rc's own release commit left out.
  const stable = r.release();
  assert.equal(stable.next, "1.1.0");
  assert.match(stable.out, /since v1\.0\.0/);
  assert.doesNotMatch(stable.out, /release 1\.1\.0-rc\.1/);
  // After an rc of a minor, the release is that minor even when the
  // changes alone would only make a patch — never 1.0.1 after 1.1.0-rc.1.
  const r2 = repo("1.0.0", BASE);
  r2.commit("fix: small", { "index.ts": BASE + "//x\n" });
  assert.equal(r2.release("--pre", "rc", "--minor", "--yes").next, "1.1.0-rc.1");
  assert.equal(r2.release().next, "1.1.0");
  assert.equal(r2.release("--pre", "1").code, 1, "a number is not a pre-release name");
});

test("the first release under these rules leaves 0.x for 1.0.0", () => {
  const r = repo("0.7.0", BASE);
  r.commit("fix: small", { "index.ts": BASE + "//x\n" });
  const out = r.release();
  assert.equal(out.next, "1.0.0");
  assert.match(out.out, /0\.x → 1\.0\.0/);
});

test("the release that first declares the public API lists no additions, and says so", () => {
  const r = repo("0.7.0", BASE);
  // The base had no foldrun.publicApi: nothing public to compare with.
  const pkg = JSON.parse(fs.readFileSync(path.join(r.dir, "package.json"), "utf8"));
  delete pkg.foldrun;
  fs.writeFileSync(path.join(r.dir, "package.json"), JSON.stringify(pkg, null, 2) + "\n");
  r.g("add", ".");
  r.g("commit", "-qm", "before the API was declared");
  r.g("tag", "-d", "v0.7.0");
  r.g("tag", "-a", "v0.7.0", "-m", "0.7.0");
  pkg.foldrun = { publicApi: ["."] };
  r.commit("release: declare the public API", { "package.json": JSON.stringify(pkg, null, 2) + "\n" });
  const out = r.release();
  assert.equal(out.next, "1.0.0");
  assert.doesNotMatch(out.out, /New in the public API/);
  assert.match(out.out, /The public API is declared from this release on/);
});

