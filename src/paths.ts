// Where data lives. One declaration, resolved late.
//
// This was nine declarations resolved early. Every module that needed the data
// directory wrote `process.env.MDAGENT_DATA ?? path.join(process.cwd(), "data")`
// into a module-level const, which has two costs:
//
//   Duplication — the same fallback path in nine places is the bug this
//   codebase keeps producing, and the one its consistency tests exist to
//   catch. Four of the nine had already drifted: they read `process.cwd()`
//   directly and ignored MDAGENT_DATA entirely, so pointing the platform at
//   another directory moved the workspaces but left the scheduler state, the
//   runtime cache, the build scratch directory and the webhook key behind.
//
//   Import-order coupling — a const captures the environment at *import* time.
//   Anything that sets MDAGENT_DATA after importing core silently reads the
//   wrong directory, and nothing errors: you get an empty result, which reads
//   as "no data" rather than "wrong root". Tests hit this first, but so does
//   any embedder that configures the library before calling it.
//
// Resolving on each call costs a string join and removes both. Nothing here
// caches: the whole point is that the answer can change between calls.

import fs from "node:fs";
import path from "node:path";

/**
 * The nearest enclosing project root, found by walking up from `from` looking
 * for a `.git` directory. Null when there is none — an installed package in
 * someone's node_modules, or a bare directory.
 */
function projectRoot(from: string): string | null {
  let dir = path.resolve(from);
  for (;;) {
    if (fs.existsSync(path.join(dir, ".git"))) return dir;
    const up = path.dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

/**
 * The data directory: every account, workspace, run and secret lives under it.
 *
 * `MDAGENT_DATA` wins. Otherwise it is `data/` at the project root, found by
 * walking up for a `.git` — falling back to the working directory when there
 * is no project to find.
 *
 * It used to be `data/` beside the *working directory*, which meant the
 * location was decided by whichever directory you happened to start the
 * process in. The dashboard runs from `web/`, so the platform's live data —
 * every workspace, secret and run — sat inside the app's own folder. Nobody
 * chose that; it fell out of cwd. And it inverted the dependency the code is
 * careful about everywhere else: the runtime works with no app, but its data
 * was a child of one, so moving `web/` took the accounts with it.
 *
 * Anchoring to the project instead makes the answer the same whether it is the
 * CLI, a test or a cron job asking.
 *
 * The walk stops at the *nearest* `.git`, which is a nested repository's own
 * when there is one — `web/` is a submodule here, so a process started inside
 * it would still anchor to the app. That is why the dashboard sets
 * MDAGENT_DATA explicitly rather than relying on this: an inferred default is
 * a good fallback and a bad contract.
 */
export function dataRoot(): string {
  if (process.env.MDAGENT_DATA) return process.env.MDAGENT_DATA;
  return path.join(projectRoot(process.cwd()) ?? process.cwd(), "data");
}

/**
 * The single workspace this process is pinned to, or null for the multi-tenant
 * layout.
 *
 * Set by the CLI, which points the runtime at one folder on a laptop — there is
 * no account and no tenant there, so the wrapper directories collapse away.
 */
export function singleWorkspace(): string | null {
  return process.env.MDAGENT_WORKSPACE ?? null;
}
