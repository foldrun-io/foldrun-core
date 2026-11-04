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

import { platform } from "./platform.ts";
import fs from "node:fs";
import path from "node:path";
import { dataRoot, singleWorkspace, singleAccountRoot, MAX_EDITABLE_FILE } from "./paths.ts";
import matter from "./matter.ts";
import { KINDS } from "./kinds.ts";
import { recordRevision, registerTreeReader } from "./history.ts";
import {
  assertSafeName,
  assertCanonicalCase,
  buildMemoryIndex,
  parseToolDef,
  readToolDir,
  syncBundleFor,
  listWorkspaces,
  listAgents,
  workspaceDir,
  deleteWorkspacePath,
  assertDeletable,
  type ToolDef,
} from "./store.ts";


export type LibraryKind = "skills" | "scripts" | "memory" | "knowledge" | "tools" | "hooks";
// Same order as the workspace nav and asset pages — one list, one order.
// Order matters and is asserted: it is the order every noun list in the
// product uses. Tools then scripts, because a script is material a tool
// points at — see the KINDS table, which is where the order is declared.
export const LIBRARY_KINDS: LibraryKind[] = ["tools", "hooks", "knowledge", "memory", "skills", "scripts"];

export function libraryDir(tenant: string, kind?: LibraryKind) {
  // Alongside the workspace in single-workspace mode: ./library, so a shared
  // library is still possible on a laptop without inventing a home directory.
  const single = singleWorkspace();
  if (single) {
    // The account scope, which is the workspace's parent only when the
    // workspace is a flat one — see singleAccountRoot.
    const base = path.join(singleAccountRoot()!, "library");
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
  // A flat tool is a lone .md; a folder tool is tool.md plus the code it
  // runs, so anything is allowed one level down inside a tool's own folder.
  if (kind === "tools" && !norm.endsWith(".md") && !norm.includes("/")) {
    throw new Error("a tool is a .md definition, or a folder holding tool.md and its code");
  }
  return norm;
}

export interface LibraryEntry {
  /** Path relative to this kind's directory. */
  path: string;
  name: string;
  description: string;
  /** For skills: true when the folder bundles scripts/. */
  hasScripts?: boolean;
  /**
   * Every file this entry is made of, relative to the kind's directory,
   * `path` included. One entry stays one tool — the shelf must not grow a
   * second row called browser — but a caller copying the library needs the
   * code beside the manifest, and the listing is the only place that knows
   * what is in the folder. Absent for a single-file entry, where `path` is
   * already the whole of it.
   */
  files?: string[];
  /**
   * For tools: how this one connects — http, script or mcp. Surfaced so a
   * list of tools reads as one vocabulary with three transports, rather
   * than a page of names whose differences are invisible until you open
   * them. For a script tool it also names the file it runs, which is the
   * link between this shelf and the code shelf.
   */
  transport?: "http" | "script" | "mcp";
  runs?: string;
  updatedAt: string;
}

/** Every file inside a folder entry, as paths relative to the kind's
 *  directory. Depth-first so a nested `scripts/` comes with it. */
function folderFiles(dir: string, prefix: string): string[] {
  const out: string[] = [];
  const walk = (at: string, rel: string) => {
    for (const e of fs.readdirSync(at, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const here = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(at, e.name), here);
      else out.push(`${prefix}/${here}`);
    }
  };
  try {
    walk(dir, "");
  } catch {
    return [`${prefix}/tool.md`];
  }
  return out;
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

  // A folder tool is one entry named by its manifest, and its code is not a
  // separate row: listing tools/browser/run.mjs beside tools/browser/tool.md
  // says there are two tools called browser, one of which cannot be granted.
  if (kind === "tools") {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        const manifest = path.join(full, "tool.md");
        if (!fs.existsSync(manifest)) continue;
        out.push({
          ...describe(manifest, entry.name),
          path: `${entry.name}/tool.md`,
          files: folderFiles(full, entry.name),
          ...toolShape(manifest, entry.name),
          updatedAt: fs.statSync(manifest).mtime.toISOString(),
        });
      } else if (entry.name.endsWith(".md")) {
        out.push({
          ...describe(full, entry.name.replace(/\.md$/, "")),
          path: entry.name,
          ...toolShape(full, entry.name),
          updatedAt: fs.statSync(full).mtime.toISOString(),
        });
      }
    }
    return out.sort((a, b) => a.path.localeCompare(b.path));
  }

  // A hook is a folder: hook.md says when it runs, run.mjs is the code.
  if (kind === "hooks") {
    for (const entry of fs.readdirSync(dir).sort()) {
      const full = path.join(dir, entry);
      const hookMd = path.join(full, "hook.md");
      if (!fs.statSync(full).isDirectory() || !fs.existsSync(hookMd)) continue;
      out.push({
        ...describe(hookMd, entry),
        path: `${entry}/hook.md`,
        files: folderFiles(full, entry),
        updatedAt: fs.statSync(hookMd).mtime.toISOString(),
      });
    }
    return out;
  }

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
          files: folderFiles(full, entry),
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

/** How a tool connects, and (for a script tool) the code it runs. */
function toolShape(file: string, rel: string): { transport?: LibraryEntry["transport"]; runs?: string } {
  try {
    const { data } = matter(fs.readFileSync(file, "utf8"));
    const def = parseToolDef(data as Record<string, unknown>, rel.replace(/\.md$/, ""));
    if (!def) return {};
    return {
      transport: def.kind,
      ...(def.kind === "script" ? { runs: (def.spec as { run?: string }).run } : {}),
    };
  } catch {
    return {}; // a malformed definition gets no badge, not a broken page
  }
}

export function readLibraryFile(tenant: string, kind: LibraryKind, rel: string): string {
  const p = path.join(libraryDir(tenant, kind), assertLibraryPath(kind, rel));
  if (!fs.existsSync(p)) throw new Error(`not found: ${rel}`);
  return fs.readFileSync(p, "utf8");
}

/** Is there already something here? For refusing to create over it. */
export function libraryFileExists(tenant: string, kind: LibraryKind, rel: string): boolean {
  try {
    return fs.existsSync(path.join(libraryDir(tenant, kind), assertLibraryPath(kind, rel)));
  } catch {
    return false; // an illegal path does not exist, and write will refuse it
  }
}

export function writeLibraryFile(
  tenant: string,
  kind: LibraryKind,
  rel: string,
  content: string,
  meta: { by?: string; message?: string } = {},
) {
  // 512 KB: a folder tool's program is one file, and the gallery browser's is
  // past 256 KB. Still a file a person edits, not a store for data.
  if (content.length > MAX_EDITABLE_FILE) throw new Error("file too large");
  const norm = assertLibraryPath(kind, rel);
  if (norm.endsWith(".md")) matter(content); // reject broken frontmatter
  const p = path.join(libraryDir(tenant, kind), norm);
  const existed = fs.existsSync(p);
  const before = existed ? fs.readFileSync(p, "utf8") : null;
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
  // Executable where code lives: the scripts shelf, a skill's bundled
  // scripts/, and now a folder tool's own code — a tool whose run.mjs is not
  // executable fails at the exec, which reads as "the tool is broken".
  if (kind === "scripts" || /scripts\//.test(norm) || (kind === "tools" && !norm.endsWith(".md"))) {
    fs.chmodSync(p, 0o755);
  }
  syncBundleFor(p, existed ? "Update" : "Creation");
  // The account shelf has one history, keyed by kind/path.
  recordRevision(tenant, "@library", [{ path: `${kind}/${norm}`, before, after: content }], meta);
}

export function deleteLibraryPath(
  tenant: string,
  kind: LibraryKind,
  rel: string,
  meta: { by?: string; message?: string } = {},
) {
  const norm = path.normalize(rel);
  if (norm.startsWith("..") || path.isAbsolute(norm)) throw new Error(`illegal path: ${rel}`);
  // "." (or "./", "a/..") is the shelf itself: one call took every shared
  // tool or skill from every workspace (30 Oct 2026). Name what goes.
  if (norm === "." || norm === "./") throw new Error(`illegal path: ${rel} — name the file or folder to delete, not the whole ${kind} shelf`);
  const target = path.join(libraryDir(tenant, kind), norm);
  const gone: { path: string; before: string | null; after: null }[] = [];
  if (fs.existsSync(target)) {
    const entries = fs.statSync(target).isFile()
      ? [target]
      : fs.readdirSync(target, { recursive: true }).map((e) => path.join(target, String(e)));
    for (const e of entries) {
      try {
        if (fs.statSync(e).isFile()) {
          gone.push({ path: `${kind}/${path.relative(libraryDir(tenant, kind), e).split(path.sep).join("/")}`, before: fs.readFileSync(e, "utf8"), after: null });
        }
      } catch {
        // skip
      }
    }
  }
  fs.rmSync(target, { recursive: true, force: true });
  recordRevision(tenant, "@library", gone, { message: `deleted ${kind}/${norm}`, ...meta });
}

// ---------- consumed by the runner ----------

/** Library tool definitions, keyed by name — http or script, both grantable by name in `tools:`. */
export function libraryTools(tenant: string): Record<string, ToolDef> {
  // The platform's gallery first, the account's own copies over it: a tool
  // the platform ships is granted by name in every account without anyone
  // installing it, and an account that installed (copied) one keeps its
  // copy — that is what "install to customise" means. Both read at account
  // scope, so a folder tool's `run:` resolves to /library/tools/<name>/…
  // in the sandbox either way; the staging step lays the gallery down
  // first and the account library over it for the same reason.
  const gallery = platform.galleryDir();
  return {
    ...(gallery ? readToolDir(path.join(gallery, "tools"), "account") : {}),
    ...readToolDir(libraryDir(tenant, "tools"), "account"),
  };
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
 *   use       an explicit grant. Only tools have one (`tools: [name]`), which
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

    // Explicit grant. Only tools have one.
    if (kind === "tools") {
      for (const a of agents) {
        if (a.ownTools.includes(name)) out.push({ workspace: ws.name, agent: a.name, relation: "use" });
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

// The account shelf as one tree, kind/path — see registerTreeReader.
registerTreeReader((tenant, scope) => {
  if (scope !== "@library") return null;
  const out: { path: string; before: null; after: string }[] = [];
  for (const kind of LIBRARY_KINDS) {
    const dir = libraryDir(tenant, kind);
    if (!fs.existsSync(dir)) continue;
    for (const entry of fs.readdirSync(dir, { recursive: true })) {
      const rel = String(entry).split(path.sep).join("/");
      const full = path.join(dir, rel);
      try {
        if (!fs.statSync(full).isFile() || !TEXT_EXT.test(rel)) continue;
        out.push({ path: `${kind}/${rel}`, before: null, after: fs.readFileSync(full, "utf8") });
      } catch {
        // skip
      }
    }
  }
  return out;
});




/** The workspace folders "Move to shared" applies to: the library's kinds
 *  but hooks, whose run.mjs is code a shared hook is made for on purpose. */
export const SHAREABLE_KINDS = ["skills", "tools", "scripts", "knowledge", "memory"] as const;

const refusal = (message: string, status: number) => Object.assign(new Error(message), { status });

/**
 * Move a workspace's skill, tool, script, knowledge or memory file into the
 * account library — the dashboard's and `foldrun source share`'s "Move to
 * shared", done here in one call (5 Nov 2026). Done by the client it copied
 * one file and deleted the folder (a skill's other files were lost), and a
 * folder tool's path was flattened.
 *
 * A skill or folder tool moves as its whole folder; anything else names one
 * file. Everything is checked before anything is written: a file the library
 * cannot hold (an image, a binary), one too large, broken frontmatter, or a
 * library file already at a path (unless `overwrite`) refuses the move and
 * nothing changes. Then every file is copied and the original deleted, in
 * one synchronous step. `dryRun` answers what would move.
 */
export function moveToLibrary(
  tenant: string,
  workspace: string,
  rel: string,
  opts: { overwrite?: boolean; dryRun?: boolean; by?: string } = {},
): { kind: LibraryKind; unit: string; files: { from: string; to: string; replaces: boolean }[]; moved: boolean } {
  const clean = path.normalize(String(rel ?? "")).replaceAll("\\", "/").replace(/^(\.\/)+/, "").replace(/\/+$/, "");
  if (!clean || clean === "." || clean.startsWith("..") || path.isAbsolute(clean)) throw refusal(`illegal path: ${rel}`, 400);
  const [kind, ...rest] = clean.split("/");
  if (kind === "hooks") throw refusal("a hook is a folder whose run.mjs goes with it — make a shared one with `foldrun hook add <name> --library`", 400);
  if (!(SHAREABLE_KINDS as readonly string[]).includes(kind) || !rest.length) {
    throw refusal(`"${rel}" is not under ${SHAREABLE_KINDS.join("/, ")}/ — only those move to the shared library`, 400);
  }
  const dir = workspaceDir(tenant, workspace);
  const folderKind = kind === "skills" || kind === "tools";
  // skills/x/SKILL.md or tools/x/tool.md names its folder: the folder is the unit.
  const unit = folderKind && rest.length >= 2 ? `${kind}/${rest[0]}` : clean;
  const full = path.join(dir, unit);
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(full);
  } catch {
    throw refusal(`no ${unit} in ${workspace}`, 404);
  }
  if (stat.isSymbolicLink()) throw refusal(`${unit} is a link — move what it points at instead`, 400);
  if (stat.isDirectory() && !(folderKind && unit.split("/").length === 2)) {
    throw refusal(`${unit} is a folder — name a file in it (only a skill or a folder tool moves as a folder)`, 400);
  }
  const realDir = fs.realpathSync(dir);
  if (!fs.realpathSync(full).startsWith(realDir + path.sep)) throw refusal(`illegal path: ${rel}`, 400);
  // The original is deleted last, so ask now whether that delete would go
  // through: a file the workspace cannot do without (knowledge/index.md, a
  // memory log) or a folder that is not a whole unit is refused before the
  // library is touched.
  try {
    const d = assertDeletable(tenant, workspace, unit);
    if (stat.isDirectory() !== d.folder) throw new Error(`${unit} cannot be moved as one thing`);
  } catch (err) {
    throw refusal(`${(err as Error).message} — nothing was moved`, 409);
  }

  const members: string[] = stat.isDirectory()
    ? (fs.readdirSync(full, { recursive: true }) as string[])
        .map((e) => path.join(full, String(e)))
        .filter((e) => {
          const st = fs.lstatSync(e);
          if (st.isSymbolicLink()) throw refusal(`${path.relative(dir, e)} is a link — the library holds files, not links; nothing was moved`, 409);
          return st.isFile();
        })
        .map((e) => path.relative(dir, e).split(path.sep).join("/"))
        .sort()
    : [unit];
  if (!members.length) throw refusal(`${unit} is empty — nothing to move`, 400);

  const files: { from: string; to: string; replaces: boolean; content: string }[] = [];
  const cannot: string[] = [];
  for (const from of members) {
    const to = from.slice(kind.length + 1);
    try {
      assertLibraryPath(kind as LibraryKind, to);
    } catch {
      cannot.push(from);
      continue;
    }
    // Text in the library's sense: an allowed extension AND bytes that are
    // UTF-8, or reading it as text would change it and the original goes.
    const bytes = fs.readFileSync(path.join(dir, from));
    const content = bytes.toString("utf8");
    if (!Buffer.from(content, "utf8").equals(bytes)) {
      cannot.push(from);
      continue;
    }
    if (content.length > MAX_EDITABLE_FILE) throw refusal(`${from} is too large for the library (over ${Math.round(MAX_EDITABLE_FILE / 1024)} KB); nothing was moved`, 409);
    if (to.endsWith(".md")) {
      try {
        matter(content);
      } catch {
        throw refusal(`${from} has frontmatter that does not parse; fix it first — nothing was moved`, 409);
      }
    }
    files.push({ from, to, replaces: libraryFileExists(tenant, kind as LibraryKind, to), content });
  }
  if (cannot.length) {
    throw refusal(`${unit} holds files the shared library cannot hold (${cannot.join(", ")}) — only text files go there; nothing was moved`, 409);
  }
  // A file already where one of these needs a folder (or a folder where one
  // needs a file) would stop the copy halfway: refuse it now.
  // And no link anywhere on the library side: a write through one could land
  // back in the workspace, and the delete after it would take the only copy.
  const shelf = libraryDir(tenant, kind as LibraryKind);
  const linked = (p: string) => {
    try {
      return fs.lstatSync(p).isSymbolicLink();
    } catch {
      return false;
    }
  };
  for (const up of [path.dirname(shelf), shelf]) {
    if (linked(up)) throw refusal(`the library's ${kind} shelf is a link — nothing was moved`, 409);
  }
  for (const f of files) {
    const parts = f.to.split("/");
    for (let i = 1; i <= parts.length; i++) {
      const at = path.join(shelf, ...parts.slice(0, i));
      if (linked(at)) throw refusal(`the library has a link at ${kind}/${parts.slice(0, i).join("/")} — nothing was moved`, 409);
      if (i < parts.length && fs.existsSync(at) && !fs.statSync(at).isDirectory()) throw refusal(`the library has a file at ${kind}/${parts.slice(0, i).join("/")}, where ${kind}/${f.to} needs a folder — nothing was moved`, 409);
      if (i === parts.length && fs.existsSync(at) && fs.statSync(at).isDirectory()) throw refusal(`the library has a folder at ${kind}/${f.to} — nothing was moved`, 409);
    }
    // The bundle files a write keeps beside it (syncBundleFor) are written too.
    for (const keeper of ["index.md", "log.md"]) {
      const at = path.join(shelf, path.dirname(f.to), keeper);
      if (linked(at)) throw refusal(`the library has a link at ${kind}/${path.join(path.dirname(f.to), keeper)} — nothing was moved`, 409);
    }
  }
  const taken = files.filter((f) => f.replaces);
  const answer = { kind: kind as LibraryKind, unit, files: files.map(({ from, to, replaces }) => ({ from, to, replaces })) };
  if (taken.length && !opts.overwrite && !opts.dryRun) {
    throw refusal(`the library already has ${taken.map((f) => `${kind}/${f.to}`).join(", ")} — nothing was moved; overwrite replaces ${taken.length === 1 ? "it" : "them"}`, 409);
  }
  if (opts.dryRun) return { ...answer, moved: false };
  // Copy, then delete; if anything fails on the way, put the library back
  // as it was (each undo is a revision too), so a move is all or nothing.
  const done: { to: string; before: string | null }[] = [];
  try {
    for (const f of files) {
      // On the undo list before the write: a writer that fails after the
      // file landed (its chmod, index or revision) is undone too.
      done.push({ to: f.to, before: f.replaces ? readLibraryFile(tenant, kind as LibraryKind, f.to) : null });
      writeLibraryFile(tenant, kind as LibraryKind, f.to, f.content, { by: opts.by, message: `moved from ${workspace}/${f.from}` });
    }
  } catch (err) {
    undo(err);
  }
  try {
    deleteWorkspacePath(tenant, workspace, unit, { by: opts.by, message: `moved ${unit} to the shared library` });
  } catch (err) {
    // Gone already, even in part (the delete landed, or stopped halfway, or
    // its bookkeeping failed): the library copy is now the only whole one —
    // keep it, and say so. Undo only while every original is still there.
    if (!members.every((m) => fs.existsSync(path.join(dir, m)))) {
      throw refusal(`moved ${unit} to the shared library, but recording it in ${workspace}'s history failed — ${(err as Error).message}`, 500);
    }
    undo(err);
  }
  return { ...answer, moved: true };

  function undo(err: unknown): never {
    for (const d of done.reverse()) {
      try {
        if (d.before === null) deleteLibraryPath(tenant, kind as LibraryKind, d.to, { by: opts.by, message: "move to shared undone" });
        else writeLibraryFile(tenant, kind as LibraryKind, d.to, d.before, { by: opts.by, message: "move to shared undone" });
      } catch {
        // best effort: the error below says the move failed
      }
    }
    throw refusal(`could not move ${unit} — ${(err as Error).message}; the library was put back and ${unit} is still in ${workspace}`, (err as { status?: number }).status ?? 500);
  }
}
