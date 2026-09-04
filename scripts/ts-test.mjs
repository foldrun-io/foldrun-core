#!/usr/bin/env node
// Run a TypeScript test on a Node that cannot strip types.
//
// The dev machine's Node runs `.ts` directly. The box's does not — Ubuntu's
// build is compiled without TypeScript support, which is exactly why
// production runs the compiled dist and never the experimental flag. That is
// fine for production and wrong for the e2e suites, because the two that
// matter most can only run where the thing they test lives:
//
//   tests/k8s-e2e.test.ts        needs a cluster — that is the box
//   tests/container-e2e.test.ts  needs a Docker daemon that can pull
//
// So the k8s executor, the one production actually uses, had no way to be
// tested end to end at all: not on the box (no type stripping) and not from
// the dev machine (no kubectl). This closes that.
//
//   node scripts/ts-test.mjs tests/k8s-e2e.test.ts [more.test.ts...]
//
// Where Node can strip types it just runs them. Where it cannot, it compiles
// with the repo's own tsc — same options core is built with — into a temp
// directory, and runs the JavaScript.

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const ROOT = path.resolve(import.meta.dirname, "..");
const files = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const flags = process.argv.slice(2).filter((a) => a.startsWith("--"));
if (!files.length) {
  console.error("usage: node scripts/ts-test.mjs <test.ts> [...] [--node-flags]");
  process.exit(2);
}

const run = (cmd, args, opts = {}) =>
  spawnSync(cmd, args, { stdio: "inherit", cwd: ROOT, ...opts }).status ?? 1;

// The happy path: this Node strips types itself.
if (process.features.typescript) {
  process.exit(run(process.execPath, ["--test", ...flags, ...files]));
}

console.error(`[ts-test] this Node has no TypeScript support — compiling ${files.length} file(s) first`);

const tsc = path.join(ROOT, "node_modules/.bin/tsc");
if (!fs.existsSync(tsc)) {
  console.error("[ts-test] node_modules/.bin/tsc is missing — run `npm ci` at the repo root");
  process.exit(2);
}

// Compile the TEST only, and link it against the built dist rather than
// against a compiled copy of core.
//
// Compiling core into a scratch tree looked simpler and was wrong: core finds
// its own package root by walking up for a package.json named @foldrun/core,
// and uses it to `npm pack` itself into the runner image's build context. A
// scratch tree has no manifest, no tsconfig and no lockfile, so the container
// e2e died three different ways as each was faked in turn. dist is the real
// package — and it is what production runs, so the test exercises the same
// artifact rather than a lookalike.
const dist = path.join(ROOT, "dist");
if (!fs.existsSync(dist)) {
  console.error("[ts-test] dist is missing — building it");
  if (run("npm", ["run", "build"]) !== 0) {
    console.error("[ts-test] the build failed");
    process.exit(2);
  }
}

// A run killed mid-flight leaves its directory; a leftover one inside the
// repo is what a deploy trips over, so clear them before making a new one.
for (const stale of fs.readdirSync(ROOT).filter((f) => f.startsWith(".ts-test-"))) {
  try {
    fs.rmSync(path.join(ROOT, stale), { recursive: true, force: true });
  } catch (err) {
    console.error(`[ts-test] could not remove ${stale}: ${err.message}`);
  }
}
const out = fs.mkdtempSync(path.join(ROOT, ".ts-test-"));

const core = JSON.parse(fs.readFileSync(path.join(ROOT, "tsconfig.json"), "utf8"));
const config = {
  compilerOptions: {
    ...core.compilerOptions,
    outDir: out,
    rootDir: ".",
    declaration: false,
    noEmit: false,
    noEmitOnError: false,
    // The test's imports of core resolve against the sources for typing; the
    // emitted JS is repointed at dist below.
    typeRoots: ["./web/node_modules/@types", "./node_modules/@types"],
  },
  include: files,
};
const configPath = path.join(ROOT, `tsconfig.ts-test.${process.pid}.json`);
fs.writeFileSync(configPath, JSON.stringify(config, null, 2));

let code = 2;
try {
  // Type errors are reported and do not stop the run — the point here is to
  // exercise a cluster or a daemon, not to re-run `npm run build`'s typecheck.
  run(tsc, ["-p", configPath]);
  const compiled = files.map((f) => path.join(out, f.replace(/\.ts$/, ".js")));
  const missing = compiled.filter((f) => !fs.existsSync(f));
  if (missing.length) {
    console.error(`[ts-test] tsc produced no output for:\n  ${missing.join("\n  ")}`);
  } else {
    // `../src/x.js` → the real built module. tsc has already
    // rewritten the .ts extension (rewriteRelativeImportExtensions), so only
    // the location is wrong.
    const distUrl = new URL(`${dist}/`, "file://").href;
    for (const file of compiled) {
      const src = fs.readFileSync(file, "utf8");
      fs.writeFileSync(
        file,
        src.replaceAll(/(from\s+|import\()(["'])(?:\.\.\/)+(?:foldrun-core\/)?src\//g,
          (_m, kw, q) => `${kw}${q}${distUrl}src/`),
      );
    }
    code = run(process.execPath, ["--test", ...flags, ...compiled]);
  }
} finally {
  fs.rmSync(configPath, { force: true });
  fs.rmSync(out, { recursive: true, force: true });
}
process.exit(code);
