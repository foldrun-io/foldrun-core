// The account library: shared skills, scripts, memory and tool definitions
// that every workspace in the account can use.
//
//   data/<tenant>/library/
//   ├── skills/<name>/SKILL.md   Agent Skills format, shared
//   ├── scripts/<file>           shared executables
//   ├── memory/*.md              organisation-wide knowledge
//   └── tools/<name>.md          reusable API definitions (frontmatter = ApiSpec)
//
// Resolution is nearest-wins, the same rule OKF uses for knowledge: an agent's
// own file beats its workspace's, which beats the account's. So a team can set
// a house style once and one agent can still override it.

import fs from "node:fs";
import path from "node:path";
import { dataRoot, singleWorkspace } from "./paths.ts";
import matter from "gray-matter";
import { KINDS } from "./kinds.ts";
import {
  assertSafeName,
  assertCanonicalCase,
  buildMemoryIndex,
  readToolDir,
  syncBundleFor,
  listWorkspaces,
  listAgents,
  workspaceDir,
  type ToolDef,
} from "./store.ts";


export type LibraryKind = "skills" | "scripts" | "memory" | "knowledge" | "tools";
// Same order as the workspace nav and asset pages — one list, one order.
export const LIBRARY_KINDS: LibraryKind[] = ["knowledge", "memory", "scripts", "skills", "tools"];

export function libraryDir(tenant: string, kind?: LibraryKind) {
  // Alongside the workspace in single-workspace mode: ./library, so a shared
  // library is still possible on a laptop without inventing a home directory.
  const single = singleWorkspace();
  if (single) {
    const base = path.join(path.resolve(single), "..", "library");
    return kind ? path.join(base, kind) : base;
  }
  assertSafeName(tenant, "tenant");
  return kind
    ? path.join(dataRoot(), tenant, "library", kind)
    : path.join(dataRoot(), tenant, "library");
}

const TEXT_EXT = /\.(md|py|sh|[mc]?js|ts|rb|sql|txt|json|ya?ml|toml)$/i;

function assertLibraryPath(kind: LibraryKind, rel: string) {
  const norm = path.normalize(rel);
  assertCanonicalCase(norm);
  if (norm.startsWith("..") || path.isAbsolute(norm)) throw new Error(`illegal path: ${rel}`);
  if (!TEXT_EXT.test(norm)) throw new Error(`unsupported file type: ${rel}`);
  if (kind === "tools" && !norm.endsWith(".md")) throw new Error("tools must be .md files");
  return norm;
}

export interface LibraryEntry {
  /** Path relative to this kind's directory. */
  path: string;
  name: string;
  description: string;
  /** For skills: true when the folder bundles scripts/. */
  hasScripts?: boolean;
  updatedAt: string;
}

export function listLibrary(tenant: string, kind: LibraryKind): LibraryEntry[] {
  const dir = libraryDir(tenant, kind);
  if (!fs.existsSync(dir)) return [];
  const out: LibraryEntry[] = [];

  const describe = (file: string, fallback: string) => {
    try {
      const { data } = matter(fs.readFileSync(file, "utf8"));
      return { name: data.name ?? fallback, description: data.description ?? "" };
    } catch {
      return { name: fallback, description: "" };
    }
  };

  if (kind === "skills") {
    for (const entry of fs.readdirSync(dir).sort()) {
      const full = path.join(dir, entry);
      if (fs.statSync(full).isDirectory()) {
        const skillMd = path.join(full, "SKILL.md");
        if (!fs.existsSync(skillMd)) continue;
        out.push({
          ...describe(skillMd, entry),
          path: `${entry}/SKILL.md`,
          hasScripts: fs.existsSync(path.join(full, "scripts")),
          updatedAt: fs.statSync(skillMd).mtime.toISOString(),
        });
      } else if (entry.endsWith(".md")) {
        out.push({
          ...describe(full, entry.replace(/\.md$/, "")),
          path: entry,
          hasScripts: false,
          updatedAt: fs.statSync(full).mtime.toISOString(),
        });
      }
    }
    return out;
  }

  for (const entry of fs.readdirSync(dir, { recursive: true })) {
    const rel = String(entry);
    const full = path.join(dir, rel);
    if (!fs.statSync(full).isFile() || !TEXT_EXT.test(rel)) continue;
    // The memory index is generated, so it isn't an entry in its own list.
    if ((kind === "memory" || kind === "knowledge") &&
        ["index.md", "log.md"].includes(rel)) continue;
    out.push({
      ...describe(full, rel),
      path: rel,
      updatedAt: fs.statSync(full).mtime.toISOString(),
    });
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

export function readLibraryFile(tenant: string, kind: LibraryKind, rel: string): string {
  const p = path.join(libraryDir(tenant, kind), assertLibraryPath(kind, rel));
  if (!fs.existsSync(p)) throw new Error(`not found: ${rel}`);
  return fs.readFileSync(p, "utf8");
}

export function writeLibraryFile(tenant: string, kind: LibraryKind, rel: string, content: string) {
  if (content.length > 256 * 1024) throw new Error("file too large");
  const norm = assertLibraryPath(kind, rel);
  if (norm.endsWith(".md")) matter(content); // reject broken frontmatter
  const p = path.join(libraryDir(tenant, kind), norm);
  const existed = fs.existsSync(p);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
  if (kind === "scripts" || /scripts\//.test(norm)) fs.chmodSync(p, 0o755);
  syncBundleFor(p, existed ? "Update" : "Creation");
}

export function deleteLibraryPath(tenant: string, kind: LibraryKind, rel: string) {
  const norm = path.normalize(rel);
  if (norm.startsWith("..") || path.isAbsolute(norm)) throw new Error(`illegal path: ${rel}`);
  const target = path.join(libraryDir(tenant, kind), norm);
  fs.rmSync(target, { recursive: true, force: true });
}

// ---------- consumed by the runner ----------

/** Library tool definitions, keyed by name — http or script, both `use:`-able. */
export function libraryTools(tenant: string): Record<string, ToolDef> {
  return readToolDir(libraryDir(tenant, "tools"));
}

/** Shared memory index — derived from the files, like every other scope. */
export function libraryMemoryIndex(tenant: string): string | null {
  // The prefix matters: without it the index names bare filenames that don't
  // exist relative to the agent, so it guesses and gets denied.
  return buildMemoryIndex(libraryDir(tenant, "memory"), "../../../../library/memory/");
}

/**
 * Account-scope creation, expressed as a path inside `library/<kind>/`.
 *
 * The content comes from KINDS — an account skill and a workspace skill are
 * the same document in a different place, and used to be two templates that
 * drifted. `file()` returns a path from the scope root (`skills/x/SKILL.md`);
 * here the kind directory is already the root, so the leading segment goes.
 */
export const LIBRARY_TEMPLATES: Record<LibraryKind, (name: string) => { path: string; content: string }> =
  Object.fromEntries(
    LIBRARY_KINDS.map((kind) => [
      kind,
      (name: string) => ({
        path: KINDS[kind].file(name).replace(new RegExp(`^${kind}/`), ""),
        content: KINDS[kind].template(name),
      }),
    ]),
  ) as Record<LibraryKind, (name: string) => { path: string; content: string }>;

// ---------------------------------------------------------------- usage

/**
 * Who actually depends on a shared file.
 *
 * The account library is the one place where editing a single file changes
 * behaviour in workspaces you are not looking at, and nothing in the product
 * could answer "if I rotate this credential, what breaks?" The graph shows
 * containment — a library tool hangs off the account node — never consumption,
 * so the edge that matters was the one edge missing.
 *
 * Two relations, because the shared scopes work in two different ways:
 *
 *   use       an explicit opt-in. Only tools have one (`use: [name]`), which
 *             is exactly why tools are the kind worth tracing: a credential
 *             reaches precisely the agents that named it, and no others.
 *
 *   shadowed  a nearer file of the same name wins. This is the quiet one — the
 *             account file still exists, still looks live on this page, and is
 *             not what runs in that workspace. Resolution is nearest-wins, so
 *             a name collision is a silent override rather than an error.
 *
 * Everything else (memory, knowledge) is indexed for every agent in scope with
 * no per-agent opt-in, so "used by" is "everyone" — true, and not information.
 * Those kinds report shadowing only.
 */
export interface LibraryUse {
  workspace: string;
  /** The agent that opted in or overrides it; null when it is workspace-wide. */
  agent: string | null;
  relation: "use" | "shadowed";
}

/** The file a kind would occupy at a given scope root, relative to that root. */
function localPath(kind: LibraryKind, name: string): string {
  return KINDS[kind].file(name);
}

export function libraryUsage(tenant: string, kind: LibraryKind, name: string): LibraryUse[] {
  const out: LibraryUse[] = [];

  for (const ws of listWorkspaces(tenant)) {
    const dir = workspaceDir(tenant, ws.name);
    const agents = listAgents(tenant, ws.name);

    // Explicit opt-in. Only tools have one.
    if (kind === "tools") {
      for (const a of agents) {
        if (a.use.includes(name)) out.push({ workspace: ws.name, agent: a.name, relation: "use" });
      }
    }

    // Nearest-wins: a workspace file of the same name, or an agent's own.
    if (fs.existsSync(path.join(dir, localPath(kind, name)))) {
      out.push({ workspace: ws.name, agent: null, relation: "shadowed" });
    }
    for (const a of agents) {
      const own = path.join(dir, "agents", a.name, localPath(kind, name));
      if (fs.existsSync(own)) {
        out.push({ workspace: ws.name, agent: a.name, relation: "shadowed" });
      }
    }
  }

  return out;
}
