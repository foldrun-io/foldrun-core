// What shape is this folder?
//
// There are two shapes a foldrun tree on a laptop can have, and every command
// has to answer the same question about the one it was pointed at.
//
//   flat                       account
//   my-desk/                   my-account/
//   ├── AGENTS.md              ├── AGENTS.md          ← account scope
//   ├── agents/                ├── library/           ← shared by every workspace
//   └── flows/                 └── workspaces/
//                                  └── my-desk/
//                                      ├── AGENTS.md
//                                      ├── agents/
//                                      └── flows/
//
// The second is the platform's own layout: `<data>/<account>/library` and
// `<data>/<account>/workspaces/<name>` are exactly these directories with a
// tenant directory around them. The first is what `foldrun init` made until
// today, so it is what every existing user has, and it must keep working
// forever — a folder shape is a file format.
//
// This module is the ONE place that decides. Everything else — the CLI's
// commands, `accountDir`, `libraryDir` — asks here rather than testing for a
// `workspaces` directory itself, because the last time that test was written
// inline it was written as "is my parent called workspaces", which is true of
// a real installation and of this layout and means something different in
// each.
//
// Deliberately free of every other import: `paths.ts` needs it, and `paths.ts`
// is what the rest of the codebase imports first.

import fs from "node:fs";
import path from "node:path";

/** Where an account keeps its workspaces. `projects/` is the pre-rename name,
 *  still read so an existing tree keeps working. */
export const WORKSPACES_DIRS = ["workspaces", "projects"] as const;

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * A workspace is a directory holding `agents/` or `flows/`.
 *
 * Not AGENTS.md: an account root has one of those too, and a test that cannot
 * tell the two apart is the bug this module exists to prevent.
 */
export function isWorkspaceDir(dir: string): boolean {
  return isDir(path.join(dir, "agents")) || isDir(path.join(dir, "flows"));
}

/** `<dir>/workspaces` when `dir` is an account root, else null. */
export function accountWorkspacesDir(dir: string): string | null {
  for (const name of WORKSPACES_DIRS) {
    const full = path.join(dir, name);
    if (isDir(full)) return full;
  }
  return null;
}

/** The workspaces under an account root, by name, sorted. */
export function listWorkspaceDirs(accountRoot: string): string[] {
  const dir = accountWorkspacesDir(accountRoot);
  if (!dir) return [];
  try {
    return fs
      .readdirSync(dir)
      .filter((n) => !n.startsWith("."))
      .filter((n) => isDir(path.join(dir, n)))
      .sort();
  } catch {
    return [];
  }
}

export type LayoutKind = "account" | "workspace-in-account" | "flat" | "empty";

export interface Layout {
  /**
   * `account` — an account folder, pointed at its root.
   * `workspace-in-account` — inside one of its workspaces.
   * `flat` — a lone workspace, the shape `foldrun init` made until today.
   * `empty` — neither: a bare or brand-new directory.
   */
  kind: LayoutKind;
  /** Where AGENTS.md and `library/` live — the account scope. */
  accountRoot: string;
  /** `<accountRoot>/workspaces`, or null when there is no account layout. */
  workspacesDir: string | null;
  /** The workspace we are in, absolute. Null at an account root. */
  workspaceDir: string | null;
  /** Its name. Null at an account root. */
  workspace: string | null;
  /** Every workspace this account holds, by name. A flat folder holds one. */
  workspaces: string[];
}

/** How far up to look before giving up: a project root (`.git`) is a boundary
 *  a layout does not cross, and so is the filesystem root. */
function* upward(from: string): Generator<string> {
  let dir = path.resolve(from);
  for (;;) {
    yield dir;
    if (isDir(path.join(dir, ".git"))) return;
    const up = path.dirname(dir);
    if (up === dir) return;
    dir = up;
  }
}

/**
 * Which of the two shapes `from` is in, and the directories that follow from
 * the answer.
 *
 * Walks up, remembering the first workspace directory it passes and stopping
 * at the first account root. A path anywhere inside a workspace resolves to
 * that workspace, so `foldrun status` works from `agents/writer/` the way git
 * works from anywhere in a checkout.
 */
export function detectLayout(from: string): Layout {
  const start = path.resolve(from);
  let workspaceDir: string | null = null;
  let accountRoot: string | null = null;

  for (const dir of upward(start)) {
    if (!workspaceDir && isWorkspaceDir(dir)) workspaceDir = dir;
    const ws = accountWorkspacesDir(dir);
    // An account root holds `workspaces/`. The workspace directory we may
    // have just found must be *inside* it — a workspace that happens to have
    // its own `workspaces/` folder of something else is not an account.
    if (ws && (!workspaceDir || workspaceDir.startsWith(ws + path.sep))) {
      accountRoot = dir;
      break;
    }
  }

  if (accountRoot) {
    const workspaces = listWorkspaceDirs(accountRoot);
    if (workspaceDir) {
      return {
        kind: "workspace-in-account",
        accountRoot,
        workspacesDir: accountWorkspacesDir(accountRoot),
        workspaceDir,
        workspace: path.basename(workspaceDir),
        workspaces,
      };
    }
    return {
      kind: "account",
      accountRoot,
      workspacesDir: accountWorkspacesDir(accountRoot),
      workspaceDir: null,
      workspace: null,
      workspaces,
    };
  }

  if (workspaceDir) {
    return {
      kind: "flat",
      accountRoot: path.dirname(workspaceDir),
      workspacesDir: null,
      workspaceDir,
      workspace: path.basename(workspaceDir),
      workspaces: [path.basename(workspaceDir)],
    };
  }

  return {
    kind: "empty",
    accountRoot: path.dirname(start),
    workspacesDir: null,
    workspaceDir: start,
    workspace: path.basename(start),
    workspaces: [],
  };
}

/**
 * The account scope for a workspace directory.
 *
 * For a flat workspace that is simply its parent — `my-desk/` sits beside the
 * `AGENTS.md` and `library/` that cover it, which is what `libraryDir` has
 * always assumed. For a workspace inside an account it is two levels up, NOT
 * one: one level up is `workspaces/`, which holds no library and no config,
 * and pointing the account scope there is how a local account folder used to
 * lose its shared library the moment the runtime asked for it.
 */
export function accountRootFor(workspaceDir: string): string {
  const dir = path.resolve(workspaceDir);
  const parent = path.dirname(dir);
  if ((WORKSPACES_DIRS as readonly string[]).includes(path.basename(parent))) {
    return path.dirname(parent);
  }
  return parent;
}

/**
 * The data root of the installation this account belongs to, or null when the
 * account is a folder someone made on their laptop.
 *
 * `<data>/<tenant>/workspaces/<name>` and `<my-account>/workspaces/<name>` are
 * the same shape, so the shape cannot tell them apart. What can is the
 * installation's own marker, which sits at the data root and nowhere else:
 * `.foldrun-install`, written by the platform at boot. `.secret-key` and
 * `keys.json` are the older markers — kept for installs from before it, and
 * no longer enough alone, because keys move into the database and a key held
 * in FOLDRUN_SECRET_KEY never had a file.
 */
export const INSTALL_MARKER = ".foldrun-install";

export function installationDataRoot(accountRoot: string): string | null {
  const above = path.dirname(path.resolve(accountRoot));
  for (const marker of [INSTALL_MARKER, ".secret-key", "keys.json"]) {
    try {
      if (fs.statSync(path.join(above, marker)).isFile()) return above;
    } catch {
      /* not this one */
    }
  }
  return null;
}
