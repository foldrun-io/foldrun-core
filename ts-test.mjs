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

// Inside the repo, not /tmp: the compiled core still imports `gray-matter`
// and the SDK by bare name, and Node resolves those by walking up from the
// file — which from /tmp finds nothing. Dot-prefixed because it is generated,
// and removed in the finally below.
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
// Core's own options, so a test compiles exactly the way the code it imports
// does — including the two that let a `.ts` extension appear in an import.
const core = JSON.parse(fs.readFileSync(path.join(ROOT, "packages/core/tsconfig.json"), "utf8"));
const config = {
  compilerOptions: {
    ...core.compilerOptions,
    outDir: out,
    rootDir: ".",
    declaration: false,
    noEmit: false,
    // Types come from the one place this repo installs them.
    typeRoots: ["./web/node_modules/@types", "./node_modules/@types"],
    // A test that fails to typecheck should still be runnable: the point here
    // is to exercise a cluster, not to re-run the typecheck `npm run build`
    // already does.
    noEmitOnError: false,
  },
  // Core's own sources, not its tests: `packages/core/**/*.ts` drags in
  // *.test.ts, which core's tsconfig excludes and which therefore does not
  // typecheck — pages of unrelated errors burying the one that matters.
  include: [...files, "packages/core/index.ts", "packages/core/src/**/*.ts"],
};
const configPath = path.join(ROOT, `tsconfig.ts-test.${process.pid}.json`);
fs.writeFileSync(configPath, JSON.stringify(config, null, 2));

// `process.exit()` does not run `finally`, so calling it inside the block
// below leaked the build directory on every run. Under sudo those are
// root-owned, and rsync — which deploys as an ordinary user — then cannot
// read or delete them: `deploy exit 23`, from a test runner. Compute the
// code, clean up, exit last.
let code = 2;
try {
  // Type errors are reported and do not stop the run — see noEmitOnError.
  run(tsc, ["-p", configPath]);
  const compiled = files.map((f) => path.join(out, f.replace(/\.ts$/, ".js")));
  const missing = compiled.filter((f) => !fs.existsSync(f));
  if (missing.length) {
    console.error(`[ts-test] tsc produced no output for:\n  ${missing.join("\n  ")}`);
  } else {
    code = run(process.execPath, ["--test", ...flags, ...compiled]);
  }
} finally {
  fs.rmSync(configPath, { force: true });
  fs.rmSync(out, { recursive: true, force: true });
}
process.exit(code);
