// The CLI smoke test: scaffold a workspace, then validate it.
//
// This replaced `foldrun check examples/blog-desk`, a workspace committed to
// the repo purely so `check` had something to point at. Its files were the
// ones `foldrun init` already generates, so it was a second copy of the
// starter — and it drifted exactly as a second copy does, needing migrating
// twice in one day while the generator moved on without it.
//
// Generating the workspace instead tests strictly more: `init` and `check`
// together, on the path a new user actually takes, against a starter that
// cannot be stale because it was written seconds earlier.
//
//   node scripts/smoke.mjs

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), "../packages/cli/bin/foldrun.mjs");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-smoke-"));
const workspace = path.join(dir, "desk");

const run = (...args) => spawnSync(process.execPath, [CLI, ...args], { stdio: "inherit" });

try {
  const init = run("init", workspace);
  if (init.status !== 0) process.exit(init.status ?? 1);

  // A fresh workspace must pass its own checker with nothing to report. If a
  // template ever emits something `check` complains about — a field it no
  // longer reads, a flow naming an agent that isn't there — this is where it
  // surfaces, before anyone has typed a word of their own.
  const check = run("check", workspace);
  process.exit(check.status ?? 1);
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
