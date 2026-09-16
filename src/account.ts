// An account folder, read as the thing a deploy pushes.
//
// `readTree` answers the same question for one workspace: what, of the files
// on disk, is source? This is that question one scope up — the account's own
// AGENTS.md, the shared `library/`, and every workspace under `workspaces/` —
// so `foldrun deploy` at an account root has one list to walk and one shape to
// report, rather than three special cases written at the call site.
//
// Nothing here talks to a platform. It reads a directory and says what is in
// it; who gets sent where is the CLI's business, because the endpoints differ
// per part (a workspace deploys whole, a library file writes one at a time)
// and that asymmetry belongs next to the fetch calls, not in here.

import fs from "node:fs";
import path from "node:path";
import { readTree } from "./deploy.ts";
import { LIBRARY_KINDS, type LibraryKind } from "./library.ts";
import { detectLayout, listWorkspaceDirs, type Layout } from "./layout.ts";
import type { DeployFile } from "./store.ts";

export interface AccountWorkspace {
  name: string;
  dir: string;
  files: DeployFile[];
}

export interface LibraryFile {
  kind: LibraryKind;
  /** Relative to the kind's directory — what the library API calls `path`. */
  path: string;
  content: string;
}

export interface AccountTree {
  root: string;
  /** The account-scope AGENTS.md, or null when there is none. */
  agentsMd: string | null;
  library: LibraryFile[];
  workspaces: AccountWorkspace[];
}

/** Anything that is bookkeeping rather than source, at either scope. */
const NOT_SOURCE = new Set([".foldrun", ".git", "node_modules", "runs", "outputs", ".DS_Store"]);

function walkFiles(root: string, rel = ""): { path: string; content: string }[] {
  const out: { path: string; content: string }[] = [];
  let entries: string[];
  try {
    entries = fs.readdirSync(root).sort();
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (NOT_SOURCE.has(entry)) continue;
    const full = path.join(root, entry);
    const next = rel ? `${rel}/${entry}` : entry;
    try {
      if (fs.lstatSync(full).isSymbolicLink()) continue;
      if (fs.statSync(full).isDirectory()) out.push(...walkFiles(full, next));
      else out.push({ path: next, content: fs.readFileSync(full, "utf8") });
    } catch {
      /* unreadable: not source */
    }
  }
  return out;
}

/** The shared library under an account root, flattened to one list. */
export function readLibraryTree(accountRoot: string): LibraryFile[] {
  const out: LibraryFile[] = [];
  for (const kind of LIBRARY_KINDS) {
    const dir = path.join(accountRoot, "library", kind);
    for (const f of walkFiles(dir)) {
      // `.gitkeep` and friends keep an empty library directory in git and are
      // not library entries: the write endpoint refuses a path with no known
      // extension, so shipping one would fail the deploy over a placeholder.
      if (f.path.split("/").some((seg) => seg.startsWith("."))) continue;
      out.push({ kind, path: f.path, content: f.content });
    }
  }
  return out;
}

/**
 * Everything an account folder would push: its AGENTS.md, its library, and
 * every workspace under it.
 *
 * `only` narrows it to one workspace — `foldrun deploy <name>` — and still
 * carries the account scope, because a workspace deployed without the library
 * its agents name is a workspace that fails on its first run.
 */
export function readAccountTree(accountRoot: string, only?: string): AccountTree {
  const root = path.resolve(accountRoot);
  const agentsMdFile = path.join(root, "AGENTS.md");
  let agentsMd: string | null = null;
  try {
    agentsMd = fs.readFileSync(agentsMdFile, "utf8");
  } catch {
    /* an account with no AGENTS.md pushes none */
  }
  const names = listWorkspaceDirs(root).filter((n) => (only ? n === only : true));
  if (only && names.length === 0) {
    throw new Error(`no workspace "${only}" in ${root} — have: ${listWorkspaceDirs(root).join(", ") || "none"}`);
  }
  const wsRoot = path.join(root, "workspaces");
  const legacy = path.join(root, "projects");
  const base = fs.existsSync(wsRoot) ? wsRoot : legacy;
  return {
    root,
    agentsMd,
    library: readLibraryTree(root),
    workspaces: names.map((name) => {
      const dir = path.join(base, name);
      return { name, dir, files: readTree(dir) };
    }),
  };
}

/**
 * The account tree for wherever you are standing — an account root, a
 * workspace inside one, or a flat workspace.
 *
 * A flat workspace is reported as an account of one whose root is its parent,
 * which is exactly what `accountDir` and `libraryDir` already believe about
 * it. So the deploy path has no branch for the old layout: it pushes one
 * workspace and whatever library sits beside it, which is what it did before.
 */
export function accountTreeFrom(from: string, only?: string): { layout: Layout; tree: AccountTree } {
  const layout = detectLayout(from);
  if (layout.kind === "flat" || layout.kind === "empty") {
    const dir = layout.workspaceDir!;
    const name = path.basename(dir);
    if (only && only !== name) throw new Error(`${dir} is a single workspace called "${name}", not "${only}"`);
    return {
      layout,
      tree: {
        root: layout.accountRoot,
        // A flat workspace's AGENTS.md belongs to the workspace, not the
        // account — pushing it as account scope would apply one desk's rules
        // to every other desk in the installation.
        agentsMd: null,
        library: readLibraryTree(layout.accountRoot),
        workspaces: [{ name, dir, files: readTree(dir) }],
      },
    };
  }
  const only2 = only ?? (layout.kind === "workspace-in-account" ? layout.workspace! : undefined);
  return { layout, tree: readAccountTree(layout.accountRoot, only2) };
}
