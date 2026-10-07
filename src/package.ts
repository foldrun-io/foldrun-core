// Export a workspace, a flow or an agent as one .zip, and import one.
//
// Agent import (agent-import.ts) copies between workspaces of ONE account;
// `foldrun pull` then `foldrun deploy` moves a whole workspace, but only from
// a terminal. Neither gets a desk from one account or installation to
// another from the dashboard, and nothing exported a single flow. A package
// is the unit for that: the authored source a thing needs to run, as a zip
// with a small manifest, which any account can preview and take in.
//
// What is IN a package is what an author wrote — never what runs made
// (memory/, state/, outputs/, storage), never the vault (secret names are
// listed so the importer can set them; values never leave), never the
// engine's .claude session files.
//
//   workspace  the whole authored tree
//   flow       the flow, every flow it runs as a step, every agent those
//              steps and their colleagues name, and the workspace tools,
//              skills and scripts those agents grant
//   agent      the agent's folder (what agent import copies), and the
//              workspace tools, skills and scripts it grants
//
// What a package needs and does not carry — secrets, the account library,
// an agent it consults — is worked out at IMPORT, from the files and the
// target, not taken on trust from the manifest: a manifest is the sender's
// claim, the files are what will run.

import fs from "node:fs";
import path from "node:path";
import matter from "gray-matter";
import {
  assertSafeName,
  isEditablePath,
  listWorkspaceFiles,
  listWorkspaces,
  readFlow,
  parseFlow,
  readWorkspaceFile,
  saveWorkspace,
  blankTemplateFiles,
  syncBundleFor,
  notifyWorkspaceChanged,
  workspaceDir,
  WORKSPACE_DIRS,
  type DeployFile,
} from "./store.ts";
import { recordRevision, type RevisionFile } from "./history.ts";
import { libraryDir, libraryTools } from "./library.ts";
import { discoverSkills } from "./runner.ts";
import { listSecrets } from "./secrets.ts";
import { isRuntimeTool, toolEntryName } from "./tool-names.ts";
import { MAX_EDITABLE_FILE } from "./paths.ts";
import { zip, unzip, ZipError } from "./zip.ts";

export type PackageKind = "workspace" | "flow" | "agent";

export interface PackageManifest {
  format: "foldrun-package";
  version: 1;
  kind: PackageKind;
  /** The workspace's, flow's or agent's name. */
  name: string;
  /** The workspace it was exported from. */
  workspace: string;
  exportedAt: string;
  files: string[];
}

export interface Package {
  manifest: PackageManifest;
  files: DeployFile[];
}

/** An error the API layer turns into a status rather than a 500. */
export class PackageError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

export const MANIFEST_FILE = "foldrun-package.json";
const MAX_FILES = 500;

/** Made by runs or by the engine, not authored — never in a package, and
 *  refused in one: an import must not plant memory or state in a desk. */
const NOT_PACKAGED =
  /^(state|memory)\/|^agents\/[^/]+\/(memory|outputs|state|workspace|\.claude)(\/|$)|^agents\/[^/]+\/\.claude[^/]*$|(^|\/)\.claude(\/|$)/;

export function isPackagedPath(rel: string): boolean {
  return !NOT_PACKAGED.test(rel) && isEditablePath(rel);
}

// ---------------------------------------------------------------- export

export function packageOf(tenant: string, workspace: string, kind: PackageKind, name?: string): Package {
  assertSafeName(workspace, "workspace");
  if (!listWorkspaces(tenant).some((w) => w.name === workspace)) {
    throw new PackageError(`no workspace called "${workspace}" in this account`, 404);
  }
  const all = listWorkspaceFiles(tenant, workspace).filter(isPackagedPath);
  const read = (p: string) => readWorkspaceFile(tenant, workspace, p);

  let paths: string[];
  let label: string;
  if (kind === "workspace") {
    paths = all;
    label = workspace;
  } else {
    if (!name) throw new PackageError(`name the ${kind} to export`, 400);
    assertSafeName(name, kind);
    label = name;
    paths = kind === "flow" ? flowClosure(tenant, workspace, name, all, read) : agentClosure([name], all, read, false);
  }
  const files = paths.sort().map((p) => ({ path: p, content: read(p) }));
  return {
    manifest: {
      format: "foldrun-package",
      version: 1,
      kind,
      name: label,
      workspace,
      exportedAt: new Date().toISOString(),
      files: files.map((f) => f.path),
    },
    files,
  };
}

export function packageZip(pkg: Package): Buffer {
  return zip([
    { path: MANIFEST_FILE, data: Buffer.from(`${JSON.stringify(pkg.manifest, null, 2)}\n`) },
    ...pkg.files.map((f) => ({ path: f.path, data: Buffer.from(f.content, "utf8") })),
  ]);
}

/** What the download is called: `<workspace>.zip`, `<workspace>-flow-<name>.zip`. */
export function packageFilename(m: PackageManifest): string {
  return m.kind === "workspace" ? `${m.workspace}.zip` : `${m.workspace}-${m.kind}-${m.name}.zip`;
}

function flowClosure(tenant: string, workspace: string, flow: string, all: string[], read: (p: string) => string): string[] {
  const flows = new Set<string>();
  const agents = new Set<string>();
  const visit = (name: string) => {
    if (flows.has(name)) return;
    const info = readFlow(tenant, workspace, name);
    if (!info) {
      if (flows.size === 0) throw new PackageError(`no flow called "${name}" in ${workspace}`, 404);
      return; // a missing subflow — import reports it, export carries what exists
    }
    flows.add(name);
    for (const s of info.steps) {
      if (s.subflow) visit(s.subflow);
      else if (s.agent) agents.add(s.agent);
      if (s.onFail) agents.add(s.onFail);
      for (const d of s.delegate ?? []) agents.add(d);
    }
  };
  visit(flow);
  const flowFiles = all.filter((p) => {
    const m = /^flows\/(.+)\.md$/.exec(p);
    return m ? flows.has(m[1]!) : false;
  });
  return [...new Set([...flowFiles, ...agentClosure([...agents], all, read, true)])];
}

/** The agents' own folders and the workspace-level tools, skills and scripts
 *  they grant. With `colleagues`, every agent they consult or delegate to as
 *  well — a flow does not run without them; a single agent's export names
 *  them instead, and import says which are missing. */
function agentClosure(names: string[], all: string[], read: (p: string) => string, colleagues: boolean): string[] {
  const out = new Set<string>();
  const seen = new Set<string>();
  const tools = toolFiles(all, read);
  const skills = skillFiles(all, read);
  const queue = [...names];
  while (queue.length) {
    const agent = queue.shift()!;
    if (seen.has(agent)) continue;
    seen.add(agent);
    const own = all.filter((p) => p.startsWith(`agents/${agent}/`));
    if (!own.includes(`agents/${agent}/agent.md`)) {
      if (seen.size === 1 && !colleagues) throw new PackageError(`no agent called "${agent}"`, 404);
      continue;
    }
    own.forEach((p) => out.add(p));
    const front = frontOf(read(`agents/${agent}/agent.md`));
    for (const t of front.tools) {
      for (const p of tools.get(t) ?? []) {
        out.add(p);
        // A single-file tool's program lives elsewhere in the workspace
        // (`run: workspace/scripts/x.mjs`); without it the tool has nothing
        // to run. onpage-desk's apply-onpage was exported without its script.
        const prog = /^tools\/[^/]+\.md$/.test(p) ? toolProgram(read(p)) : null;
        if (prog && all.includes(prog)) out.add(prog);
      }
    }
    for (const s of front.skills) for (const p of skills.get(s) ?? []) out.add(p);
    for (const s of front.scripts) if (all.includes(`scripts/${s}`)) out.add(`scripts/${s}`);
    if (colleagues) queue.push(...front.agents);
  }
  return [...out];
}

// ---------------------------------------------------------------- import

export function readPackage(buf: Buffer): Package {
  let entries;
  try {
    entries = unzip(buf, { maxEntries: MAX_FILES + 1, maxFileBytes: MAX_EDITABLE_FILE, maxTotalBytes: 50 * 1024 * 1024 });
  } catch (err) {
    if (err instanceof ZipError) throw new PackageError(err.message, 400);
    throw err;
  }
  // A folder zipped by hand ("Compress" on a Mac) puts everything under one
  // top directory. Look through it when that is all there is.
  const tops = new Set(entries.map((e) => e.path.split("/")[0]!));
  const top1 = [...tops][0]!;
  if (tops.size === 1 && entries.every((e) => e.path.includes("/")) && !(WORKSPACE_DIRS as readonly string[]).includes(top1)) {
    const top = `${[...tops][0]}/`;
    entries = entries.map((e) => ({ ...e, path: e.path.slice(top.length) }));
  }

  let manifest: Partial<PackageManifest> = {};
  const files: DeployFile[] = [];
  const refused: string[] = [];
  for (const e of entries) {
    if (e.path === MANIFEST_FILE) {
      try {
        manifest = JSON.parse(e.data.toString("utf8"));
      } catch {
        throw new PackageError(`${MANIFEST_FILE} is not valid JSON`, 400);
      }
      continue;
    }
    if (!isPackagedPath(e.path)) {
      refused.push(e.path);
      continue;
    }
    const content = e.data.toString("utf8");
    if (!Buffer.from(content, "utf8").equals(e.data)) throw new PackageError(`${e.path} is not UTF-8 text`, 400);
    try {
      matter(content);
    } catch {
      throw new PackageError(`${e.path}: its frontmatter does not parse`, 400);
    }
    files.push({ path: e.path, content });
  }
  if (refused.length) {
    throw new PackageError(
      `the package holds files an import may not write: ${refused.slice(0, 8).join(", ")}${refused.length > 8 ? ` and ${refused.length - 8} more` : ""} — a package carries agents, flows, evals, knowledge, skills, tools and scripts, never memory, state or outputs`,
      400,
    );
  }
  if (files.length === 0) throw new PackageError("the package has no files to import", 400);
  if (files.length > MAX_FILES) throw new PackageError(`too many files: ${files.length} (at most ${MAX_FILES})`, 400);

  // No manifest: a workspace folder zipped by hand is still importable.
  const kind: PackageKind =
    manifest.kind === "flow" || manifest.kind === "agent" || manifest.kind === "workspace"
      ? manifest.kind
      : files.some((f) => f.path === "AGENTS.md")
        ? "workspace"
        : "flow";
  if (manifest.format !== undefined && manifest.format !== "foldrun-package") {
    throw new PackageError(`${MANIFEST_FILE} is not a foldrun package manifest`, 400);
  }
  if (manifest.version !== undefined && manifest.version !== 1) {
    throw new PackageError(`package version ${manifest.version} is newer than this installation reads — update foldrun`, 400);
  }
  return {
    manifest: {
      format: "foldrun-package",
      version: 1,
      kind,
      name: typeof manifest.name === "string" ? manifest.name : "",
      workspace: typeof manifest.workspace === "string" ? manifest.workspace : "",
      exportedAt: typeof manifest.exportedAt === "string" ? manifest.exportedAt : "",
      files: files.map((f) => f.path),
    },
    files: files.sort((a, b) => a.path.localeCompare(b.path)),
  };
}

export interface ImportPlan {
  kind: PackageKind;
  name: string;
  /** Where it came from, as the package says. */
  from: string;
  workspace: string;
  /** True when the workspace does not exist yet and the import makes it. */
  creates: boolean;
  added: string[];
  /** Files that exist with different text — written only with `overwrite`. */
  overwritten: string[];
  unchanged: string[];
  /** What the imported files name that the target cannot provide. The import
   *  still happens — a missing secret is set in a minute. */
  needs: {
    secrets: string[];
    tools: string[];
    skills: string[];
    scripts: string[];
    agents: string[];
    flows: string[];
  };
}

export interface ImportResult extends ImportPlan {
  written: string[];
  revision: string | null;
}

export function planImport(tenant: string, workspace: string, pkg: Package): ImportPlan {
  assertSafeName(workspace, "workspace");
  const exists = listWorkspaces(tenant).some((w) => w.name === workspace);
  if (!exists && pkg.manifest.kind !== "workspace") {
    throw new PackageError(`no workspace called "${workspace}" — a ${pkg.manifest.kind} imports into one that exists`, 404);
  }
  const dir = workspaceDir(tenant, workspace);
  const added: string[] = [];
  const overwritten: string[] = [];
  const unchanged: string[] = [];
  for (const f of pkg.files) {
    const abs = path.join(dir, f.path);
    if (!exists || !fs.existsSync(abs)) added.push(f.path);
    else if (sameText(fs.readFileSync(abs, "utf8"), f.content)) unchanged.push(f.path);
    else overwritten.push(f.path);
  }
  // A workspace with no AGENTS.md exports fine (sched-lab had none) but a new
  // workspace needs one: it gets the blank one "Create workspace" makes.
  if (!exists && !pkg.files.some((f) => f.path === "AGENTS.md")) added.push("AGENTS.md");
  return {
    kind: pkg.manifest.kind,
    name: pkg.manifest.name,
    from: pkg.manifest.workspace,
    workspace,
    creates: !exists,
    added,
    overwritten,
    unchanged,
    needs: needsOf(tenant, workspace, exists, pkg.files),
  };
}

export function applyImport(
  tenant: string,
  workspace: string,
  pkg: Package,
  opts: { overwrite?: boolean; by?: string } = {},
): ImportResult {
  const plan = planImport(tenant, workspace, pkg);
  if (plan.overwritten.length && !opts.overwrite) {
    throw new PackageError(
      `${plan.overwritten.length} file${plan.overwritten.length === 1 ? "" : "s"} in ${workspace} would be overwritten: ${plan.overwritten.slice(0, 8).join(", ")}${plan.overwritten.length > 8 ? " …" : ""} — import with overwrite to replace them`,
      409,
    );
  }
  const what = plan.kind === "workspace" ? "workspace" : `${plan.kind} ${plan.name}`;
  const message = `import ${what}${plan.from ? ` from ${plan.from}` : ""}`.trim();
  const meta = { ...(opts.by ? { by: opts.by } : {}), message };

  if (plan.creates) {
    const files = pkg.files.some((f) => f.path === "AGENTS.md") ? pkg.files : [...pkg.files, ...blankTemplateFiles(workspace)];
    saveWorkspace(tenant, workspace, files, meta);
    return { ...plan, written: files.map((f) => f.path), revision: null };
  }

  // One revision for the whole import, so History and restore treat it as
  // the single change it is. Never deletes: a file the package lacks stays.
  const dir = workspaceDir(tenant, workspace);
  const write = new Set([...plan.added, ...plan.overwritten]);
  const changes: RevisionFile[] = [];
  for (const f of pkg.files) {
    if (!write.has(f.path)) continue;
    const abs = path.join(dir, f.path);
    const before = fs.existsSync(abs) ? fs.readFileSync(abs, "utf8") : null;
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, normalized(f.content));
    // Same rule as writeWorkspaceFile: code is executable wherever it lives.
    if (/(^|\/)scripts\//.test(f.path) || (/^tools\//.test(f.path) && !f.path.endsWith(".md"))) fs.chmodSync(abs, 0o755);
    syncBundleFor(abs, before === null ? "Creation" : "Update");
    changes.push({ path: f.path, before, after: fs.readFileSync(abs, "utf8") });
  }
  const rev = recordRevision(tenant, workspace, changes, meta);
  if (changes.length) notifyWorkspaceChanged(tenant, workspace, "write");
  return { ...plan, written: changes.map((c) => c.path), revision: rev?.id ?? null };
}

/** As writeWorkspaceFile stores it: one trailing newline. */
const normalized = (s: string) => `${s.trimEnd()}\n`;

/** The same text, whatever the line endings and trailing whitespace. A file
 *  a deploy stored without a final newline, or a CSV with CRLF endings, is
 *  byte-different from what an import would write and identical to read —
 *  comparing bytes listed six such files of a live desk as "would replace"
 *  when the desk was re-imported into itself. */
const sameText = (a: string, b: string) => a.replace(/\r\n/g, "\n").trimEnd() === b.replace(/\r\n/g, "\n").trimEnd();

function needsOf(tenant: string, workspace: string, exists: boolean, files: DeployFile[]): ImportPlan["needs"] {
  const inPkg = new Map(files.map((f) => [f.path, f.content]));
  const there = exists ? listWorkspaceFiles(tenant, workspace) : [];
  const readThere = (p: string) => readWorkspaceFile(tenant, workspace, p);
  // Everything the target will have once the package is in.
  const paths = [...new Set([...there, ...inPkg.keys()])];
  const read = (p: string) => inPkg.get(p) ?? readThere(p);

  const tools = new Set([...toolFiles(paths, read).keys(), ...Object.keys(libraryTools(tenant))]);
  const skills = new Set([...skillFiles(paths, read).keys(), ...discoverSkills(libraryDir(tenant), "skills").map((s) => s.name)]);
  const agents = new Set(paths.map((p) => /^agents\/([^/]+)\/agent\.md$/.exec(p)?.[1]).filter((x): x is string => Boolean(x)));
  const flows = new Set(paths.map((p) => /^flows\/(.+)\.md$/.exec(p)?.[1]).filter((x): x is string => Boolean(x)));

  const need = { secrets: new Set<string>(), tools: new Set<string>(), skills: new Set<string>(), scripts: new Set<string>(), agents: new Set<string>(), flows: new Set<string>() };
  for (const f of files) {
    const agent = /^agents\/([^/]+)\/agent\.md$/.exec(f.path)?.[1];
    if (agent) {
      const front = frontOf(f.content);
      for (const t of front.tools) if (!isRuntimeTool(t) && !tools.has(t) && !front.inline.has(t)) need.tools.add(t);
      for (const s of front.skills) if (!skills.has(s) && !agentSkill(paths, read, agent, s)) need.skills.add(s);
      for (const s of front.scripts) {
        if (![`agents/${agent}/scripts/${s}`, `scripts/${s}`].some((p) => paths.includes(p)) && !fs.existsSync(path.join(libraryDir(tenant), "scripts", s))) need.scripts.add(s);
      }
      for (const a of front.agents) if (!agents.has(a)) need.agents.add(a);
      front.secrets.forEach((s) => need.secrets.add(s));
    }
    if (/^tools\//.test(f.path) && f.path.endsWith(".md")) {
      const data = safeFront(f.content);
      list(data.secrets).forEach((s) => need.secrets.add(s));
      const prog = /^tools\/[^/]+\.md$/.test(f.path) ? toolProgram(f.content) : null;
      if (prog && !paths.includes(prog)) need.scripts.add(prog);
    }
    if (/^(agents\/[^/]+\/agent\.md|tools\/.+\.md)$/.test(f.path)) {
      for (const m of f.content.matchAll(/\$\{([A-Z][A-Z0-9_]*)\}/g)) need.secrets.add(m[1]!);
    }
    if (/^flows\/.+\.md$/.test(f.path)) {
      let steps: ReturnType<typeof parseFlow>["steps"] = [];
      try {
        steps = parseFlow(f.path, f.content).steps;
      } catch {
        // an unparseable flow is check's to report, not import's
      }
      for (const s of steps) {
        if (s.subflow) {
          if (!flows.has(s.subflow)) need.flows.add(s.subflow);
          continue;
        }
        for (const a of [s.agent, s.onFail, ...(s.delegate ?? [])]) if (a && !agents.has(a)) need.agents.add(a);
      }
    }
  }
  let have: Set<string>;
  try {
    have = new Set(listSecrets(tenant, exists ? workspace : undefined).map((s) => s.name));
  } catch {
    have = new Set();
  }
  const sorted = (s: Set<string>) => [...s].sort();
  return {
    secrets: sorted(new Set([...need.secrets].filter((s) => !have.has(s)))),
    tools: sorted(need.tools),
    skills: sorted(need.skills),
    scripts: sorted(need.scripts),
    agents: sorted(need.agents),
    flows: sorted(need.flows),
  };
}

// ---------------------------------------------------------------- shared

const list = (v: unknown): string[] =>
  Array.isArray(v) ? v.map((x) => toolEntryName(x)).filter(Boolean) : typeof v === "string" && v.trim() ? [v.trim()] : [];

function safeFront(content: string): Record<string, unknown> {
  try {
    return matter(content).data as Record<string, unknown>;
  } catch {
    return {};
  }
}

interface AgentFront {
  tools: string[];
  skills: string[];
  scripts: string[];
  secrets: string[];
  /** Colleagues: `agents:` and `subagents:` together. */
  agents: string[];
  /** Tool names the agent defines itself (`apis:`, `mcpServers:`, `scripts:`). */
  inline: Set<string>;
}

function frontOf(content: string): AgentFront {
  const d = safeFront(content);
  const apis = Array.isArray(d.apis) ? d.apis.map((a) => (a && typeof a === "object" ? String((a as { name?: unknown }).name ?? "") : "")) : [];
  const mcp = d.mcpServers && typeof d.mcpServers === "object" ? Object.keys(d.mcpServers) : [];
  const scripts = list(d.scripts);
  return {
    tools: list(d.tools),
    skills: list(d.skills),
    scripts,
    secrets: list(d.secrets),
    agents: [...list(d.agents), ...list(d.subagents)],
    inline: new Set([...apis, ...mcp, ...scripts, ...scripts.map((s) => s.replace(/\.[^.]+$/, ""))].filter(Boolean)),
  };
}

/** The workspace file a single-file tool's `run:` names, as a workspace
 *  path (`scripts/x.mjs`), or null when it names none or a place outside
 *  the workspace (the account library, the gallery). */
function toolProgram(content: string): string | null {
  const run = safeFront(content).run;
  if (typeof run !== "string") return null;
  const rel = run.trim().replace(/^\.\//, "").replace(/^workspace\//, "").replace(/^(\.\.\/)+/, "");
  if (/^(account|library|shared)\//.test(run.trim()) || rel.includes("..") || rel.startsWith("/")) return null;
  return rel || null;
}

/** Workspace tool name → its files: `tools/<x>.md`, or a folder tool's whole folder. */
function toolFiles(paths: string[], read: (p: string) => string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const p of paths) {
    let m = /^tools\/([^/]+)\.md$/.exec(p);
    if (m) {
      const name = String(safeFront(read(p)).name ?? m[1]);
      out.set(name, [p]);
      continue;
    }
    m = /^tools\/([^/]+)\/tool\.md$/.exec(p);
    if (m) {
      const name = String(safeFront(read(p)).name ?? m[1]);
      out.set(name, paths.filter((q) => q.startsWith(`tools/${m![1]}/`)));
    }
  }
  return out;
}

/** Workspace skill name → its folder's files. */
function skillFiles(paths: string[], read: (p: string) => string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const p of paths) {
    const m = /^skills\/([^/]+)\/SKILL\.md$/.exec(p);
    if (!m) continue;
    const name = String(safeFront(read(p)).name ?? m[1]);
    out.set(name, paths.filter((q) => q.startsWith(`skills/${m[1]}/`)));
  }
  return out;
}

function agentSkill(paths: string[], read: (p: string) => string, agent: string, skill: string): boolean {
  const prefix = `agents/${agent}/skills/`;
  return paths.some((p) => {
    if (!p.startsWith(prefix) || !p.endsWith("/SKILL.md")) return false;
    const dir = p.slice(prefix.length, -"/SKILL.md".length);
    return dir === skill || safeFront(read(p)).name === skill;
  });
}
