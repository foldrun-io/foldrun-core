// Filesystem storage. Three real directories, one per scope — the nesting IS
// the scope model, so "nearest wins" is literally walking up the tree:
//
//   data/<account>/                        the company: one bill, one identity
//   ├── secrets.json                       account credentials
//   ├── library/                           shared by every workspace
//   │   └── {skills,memory,knowledge,tools,scripts}/
//   ├── .runtimes/                         generated: container images, venvs
//   └── workspaces/<workspace>/            a trust boundary
//       ├── AGENTS.md                      shared context for this workspace
//       ├── agents/<agent>/                one role
//       │   └── {agent.md,skills,memory,knowledge,scripts,outputs}/
//       ├── {flows,evals,skills,memory,knowledge,tools,scripts,state}/
//       ├── secrets.json                   workspace credentials
//       └── runs/                          generated: the audit trail
//
// Anything generated is either dot-prefixed (.runtimes, .results) or named for
// what produced it (runs/, outputs/). Everything else is authored by a person
// or an agent, and belongs in git.
//
// An account is a named directory (per OKF: tenancy is a hosting concern).

import fs from "node:fs";
import path from "node:path";
import { dataRoot, singleWorkspace } from "./paths.ts";
import matter from "gray-matter";
import {
  readBundle, syncIndex, appendLog, provenanceMarks, syncWorkspaceBundles,
} from "./okf.ts";
import { readTransport, KINDS } from "./kinds.ts";
import { starterFiles, accountFiles } from "./starter.ts";

// Where workspaces live. The hosted app keeps many under data/; the CLI runs
// against one folder, which is what `foldrun run ./my-desk` has to mean.

/**
 * Single-workspace mode. When set, the workspace IS this directory — no
 * tenant, no projects/ nesting. That's the difference between a framework you
 * run on a folder and a platform that hosts many, and it's the only thing the
 * core needs to know about which one it's in.
 */
export { singleWorkspace };

// The directories a workspace is made of. Declared once: this list had drifted
// into four separate copies, and the file tree quietly stopped showing
// knowledge/, evals/ and state/ because one of them was never updated.
export const WORKSPACE_DIRS = [
  "agents",
  "flows",
  "evals",
  "skills",
  "memory",
  "knowledge",
  "tools",
  "scripts",
  "state",
] as const;

const IN_WORKSPACE_DIR = new RegExp(`^(${WORKSPACE_DIRS.join("|")})/`);

// Where the file store mirrors its bytes for a run to read. Deliberately not
// in WORKSPACE_DIRS: that list is the workspace's *source*, and everything
// derived from it — the file tree, the git export, what a deploy may carry —
// treats membership as "this is reviewable text". Blobs are not. Declared
// here rather than in files.ts because saveWorkspace has to know the name to
// preserve it, and store.ts is the module files.ts depends on, not the
// reverse. See files.ts for the whole argument.
export const FILES_DIR = "storage";
/** What this directory was called before. Read-only: nothing writes here any
 *  more, but installs created before the rename have bytes under it, and a
 *  workspace whose files vanished on upgrade is a data-loss bug however
 *  cosmetic the cause. `adoptLegacyFilesDir` moves one across, once. */
export const LEGACY_FILES_DIR = "files";

/**
 * Move a pre-rename `files/` directory to `storage/`, once, in place.
 *
 * Called on the paths that resolve the store and the run mirror, so an
 * existing install upgrades the first time either is touched rather than
 * needing a migration step someone has to remember to run. A no-op when
 * `storage/` already exists (the normal case after the first call) or when
 * there is nothing to move (a fresh install).
 */
export function adoptLegacyFilesDir(parent: string): void {
  const current = path.join(parent, FILES_DIR);
  const legacy = path.join(parent, LEGACY_FILES_DIR);
  if (fs.existsSync(current) || !fs.existsSync(legacy)) return;
  try {
    fs.renameSync(legacy, current);
  } catch {
    // A rename across devices, or a permission we do not have: copy instead,
    // and leave the original alone rather than risk losing it.
    try {
      fs.cpSync(legacy, current, { recursive: true });
    } catch {
      /* the caller sees an absent directory, which is the pre-rename state */
    }
  }
}

// Where an account keeps its workspaces. Renamed from "projects" once the
// concept settled on *workspace* everywhere else; the old directory is still
// read so an existing install keeps working without a migration step.
const WORKSPACES = "workspaces";
const LEGACY_WORKSPACES = "projects";

function workspacesRoot(tenant: string) {
  const current = path.join(dataRoot(), tenant, WORKSPACES);
  if (fs.existsSync(current)) return current;
  const legacy = path.join(dataRoot(), tenant, LEGACY_WORKSPACES);
  return fs.existsSync(legacy) ? legacy : current;
}
const SAFE_NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export function assertSafeName(name: string, kind: string) {
  if (!SAFE_NAME.test(name)) throw new Error(`invalid ${kind} "${name}" — kebab-case only`);
}

export function workspaceDir(tenant: string, workspace: string) {
  const single = singleWorkspace();
  if (single) return path.resolve(single);
  assertSafeName(tenant, "tenant");
  assertSafeName(workspace, "workspace");
  // An existing workspace keeps its current home; a new one is created under
  // the canonical name.
  const legacy = path.join(dataRoot(), tenant, LEGACY_WORKSPACES, workspace);
  if (fs.existsSync(legacy)) return legacy;
  return path.join(dataRoot(), tenant, WORKSPACES, workspace);
}

/**
 * The account root — where `library/`, account secrets and the account-wide
 * AGENTS.md live.
 *
 * On a laptop there is no account, so it is the workspace's parent: `my-desk/`
 * sits beside `library/` and an `AGENTS.md` covering everything there. Same
 * rule libraryDir uses, so the two never disagree about where "up" is.
 */
export function accountDir(tenant: string) {
  const single = singleWorkspace();
  if (single) return path.resolve(single, "..");
  assertSafeName(tenant, "tenant");
  return path.join(dataRoot(), tenant);
}

/**
 * Create the account's AGENTS.md if it is missing. Returns what it wrote.
 *
 * Called from every path that brings a workspace into being, because there is
 * no separate "create an account" step — the account root accumulates
 * (`library/`, `secrets.json`) as things need it, and its AGENTS.md is one
 * more of those things.
 *
 * Never overwrites, and treats the legacy `project.md` as already-present: the
 * whole file is hand-authored config, and a deploy is not permission to touch
 * a scope the deploy did not ship. `dir` is explicit for `foldrun init`, which
 * writes a workspace to an arbitrary path before anything is pinned to it and
 * so cannot ask accountDir where "up" is.
 */
export function ensureAccountFiles(tenant: string, dir = accountDir(tenant)): string[] {
  const written: string[] = [];
  for (const f of accountFiles(path.basename(path.resolve(dir)))) {
    if (fs.existsSync(path.join(dir, f.path))) continue;
    if (f.path === "AGENTS.md" && fs.existsSync(path.join(dir, "project.md"))) continue;
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, f.path), f.content);
    written.push(f.path);
  }
  return written;
}

export interface DeployFile {
  path: string;
  content: string;
}

// Files whose names are part of a standard, and must be spelled exactly.
// AGENTS.md is the Linux Foundation convention; SKILL.md is the Agent Skills
// standard. Case-insensitive filesystems (macOS, Windows)
// happily accept `Skill.md` locally and then it vanishes on a Linux runtime —
// so the wrong case is rejected here, loudly, with the right spelling.
const CANONICAL = ["AGENTS.md", "SKILL.md"];

/**
 * The format version this build understands.
 *
 * A workspace declares what it targets with `foldrun_version` in AGENTS.md.
 * Without it, the first breaking change to the flow grammar or frontmatter
 * silently changes what everyone's existing files mean — the one failure a
 * format cannot recover from, because there is no error to notice.
 *
 * Missing is treated as "current": nobody's existing workspace breaks by
 * having been written before this existed.
 */
export const FORMAT_VERSION = "0.1";

export interface VersionCheck {
  declared: string | null;
  supported: string;
  /** Set when the workspace targets something this build cannot promise. */
  warning: string | null;
}

export function checkFormatVersion(declared: unknown): VersionCheck {
  const value = typeof declared === "string" ? declared.trim() : null;
  if (!value) return { declared: null, supported: FORMAT_VERSION, warning: null };

  const [major, minor = "0"] = value.split(".");
  const [okMajor, okMinor] = FORMAT_VERSION.split(".");
  if (major !== okMajor) {
    return {
      declared: value,
      supported: FORMAT_VERSION,
      warning:
        `this workspace targets foldrun format ${value}, and this build understands ` +
        `${FORMAT_VERSION}. A different major version may mean different behaviour — ` +
        `read it as best-effort rather than correct.`,
    };
  }
  if (Number(minor) > Number(okMinor)) {
    return {
      declared: value,
      supported: FORMAT_VERSION,
      warning:
        `this workspace targets foldrun format ${value}; this build understands ` +
        `${FORMAT_VERSION}. Newer fields will be ignored rather than rejected.`,
    };
  }
  return { declared: value, supported: FORMAT_VERSION, warning: null };
}

export function assertCanonicalCase(rel: string) {
  const base = rel.split("/").pop() ?? rel;
  for (const want of CANONICAL) {
    if (base !== want && base.toLowerCase() === want.toLowerCase()) {
      throw new Error(
        `"${base}" must be spelled exactly "${want}" — it is a standard filename and the case is ` +
          `part of it. Rename it and try again.`,
      );
    }
  }
}

/**
 * What the platform owns inside a workspace directory, in one place.
 *
 * Three separate mechanisms need this exact list and drifted apart while it
 * lived in each of them: deploys must preserve these files, and the run
 * executors (docker and k8s) must not copy them into a sandbox. A platform
 * file added to one list and not the others is either silently wiped by the
 * next deploy or silently handed to every container — both invisible until
 * someone is bitten.
 */
export const PLATFORM_FILES = ["secrets.json", "hooks.json", "hook-deliveries.jsonl"];

/** True for anything the platform, not the author or the agent, writes. */
export function isPlatformPath(rel: string): boolean {
  const norm = rel.replaceAll("\\", "/");
  if (PLATFORM_FILES.includes(norm)) return true;
  return norm === "runs" || norm.startsWith("runs/") || norm === ".foldrun" || norm.startsWith(".foldrun/");
}

export function saveWorkspace(tenant: string, workspace: string, files: DeployFile[]) {
  if (files.length > 500) throw new Error("too many files");
  for (const f of files) {
    const norm = path.normalize(f.path);
    if (norm.startsWith("..") || path.isAbsolute(norm) || norm.startsWith("runs")) {
      throw new Error(`illegal file path: ${f.path}`);
    }
    assertCanonicalCase(norm);
    if (!IN_WORKSPACE_DIR.test(norm) && norm !== "project.md" && norm !== "AGENTS.md") {
      throw new Error(
        `unexpected file: ${f.path} — a workspace holds AGENTS.md plus ` +
          `${WORKSPACE_DIRS.map((d) => `${d}/`).join(", ")}`,
      );
    }
  }

  // Executable: an agent's own scripts/, or the workspace-level shared scripts/.
  const isScript = (rel: string) => {
    const norm = path.normalize(rel);
    return (
      /^agents\/[^/]+\/scripts\//.test(norm) || // an agent's own scripts
      /^agents\/[^/]+\/skills\/[^/]+\/scripts\//.test(norm) || // scripts bundled in a skill
      /^scripts\//.test(norm) // workspace-wide shared scripts
    );
  };

  const dir = workspaceDir(tenant, workspace);

  // The scope above has to exist before anything under it runs, and this is
  // the only chokepoint every hosted workspace passes through — the dashboard's
  // New button, the API, and `git push` deploys all land here.
  ensureAccountFiles(tenant);

  // A deploy replaces the workspace, but it must not destroy what it never
  // owned. Git is authoritative for the files it ships; the platform owns
  // everything an agent produced at run time. So:
  //
  //   runs/            always kept — the audit trail
  //   state/           always kept — what an agent carries between runs
  //   files/           always kept — the file store's run mirror, which no
  //                    deploy can ship (a deploy carries source, and bytes
  //                    are not source) and every run expects to find
  //   memory/*.md      kept when the deploy doesn't ship that file
  //
  // That last rule is the subtle one. Memory is written from both sides: a
  // human commits a fact, and an agent learns one. Keeping only the files the
  // deploy *didn't* mention means deleting a memory in git deletes it on the
  // server, while a memory an agent wrote survives a push that never knew
  // about it. Before this, every deploy silently erased everything the agents
  // had learned.
  const shipped = new Set(files.map((f) => path.normalize(f.path)));
  const isAgentOwned = (rel: string) =>
    // Platform bookkeeping (the vault, hook rotation state, the delivery
    // log, run history) — losing any of it on deploy silently breaks
    // something: agents lose secrets, a rotated hook un-rotates.
    isPlatformPath(rel) ||
    /(^|\/)state\//.test(rel) ||
    rel === FILES_DIR ||
    rel.startsWith(`${FILES_DIR}/`) ||
    (/(^|\/)memory\/[^/]+\.md$/.test(rel) && !shipped.has(rel));

  const snapshot = fs.existsSync(dir) ? fs.mkdtempSync(path.join(dataRoot(), ".keep-")) : null;
  const preserved: string[] = [];
  if (snapshot) {
    for (const entry of fs.readdirSync(dir, { recursive: true })) {
      const rel = String(entry).split(path.sep).join("/");
      const from = path.join(dir, rel);
      try {
        if (!fs.statSync(from).isFile() || !isAgentOwned(rel)) continue;
      } catch {
        continue; // a broken link or a file that vanished mid-deploy
      }
      const to = path.join(snapshot, rel);
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.copyFileSync(from, to);
      preserved.push(rel);
    }
  }

  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });

  for (const f of files) {
    const target = path.join(dir, path.normalize(f.path));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, f.content);
    // Anything under an agent's scripts/ is meant to be run.
    if (isScript(f.path)) fs.chmodSync(target, 0o755);
  }

  // Restore after writing, so a deploy never overwrites preserved state.
  if (snapshot) {
    for (const rel of preserved) {
      const to = path.join(dir, rel);
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.copyFileSync(path.join(snapshot, rel), to);
    }
    fs.rmSync(snapshot, { recursive: true, force: true });
  }

  // The files are conformant concepts the moment they land; the bundles around
  // them are not bundles until their index.md exists to carry okf_version. A
  // deploy writes straight to disk, so nothing else would generate them.
  syncWorkspaceBundles(dir);

  return { preserved: preserved.length };
}

// The prompt-facing index for an OKF bundle (memory/ or knowledge/).
//
// The on-disk artifact is index.md, written by syncIndex and conformant with
// the spec. This builds the same listing with paths the agent can actually
// open, plus the v0.2 signals that change how a fact should be treated: a
// stale price list or an unverified claim should not read like a confirmed
// one.
//
// There is no curated preamble. A hand-written MEMORY.md used to be read in
// ahead of this listing, and it was a reserved name we invented inside someone
// else's format — a consumer applying OKF's rules saw an untyped concept and
// rejected the bundle. Shared prose belongs in AGENTS.md, which is already the
// place for context every agent here gets.
export function buildMemoryIndex(dir: string, prefix = ""): string | null {
  if (!fs.existsSync(dir)) return null;

  const lines: string[] = [];
  for (const doc of readBundle(dir)) {
    const marks = [
      doc.type && doc.type !== "Memory" ? doc.type : null,
      doc.status !== "stable" ? doc.status : null,
      doc.stale ? `STALE since ${doc.staleAfter} — confirm before relying on it` : null,
      // Same signals as the on-disk index, one definition — see provenanceMarks.
      // This is the copy a model reads mid-run, so it is the one that decides
      // whether it treats its own earlier guess as a fact.
      ...provenanceMarks(doc),
    ].filter(Boolean);
    lines.push(
      `- [${doc.title}](${prefix}${doc.file})` +
        (doc.description ? ` — ${doc.description}` : "") +
        (marks.length ? ` _(${marks.join(", ")})_` : ""),
    );
  }

  return lines.length ? lines.join("\n") : null;
}

// Workspace-scoped shared assets: skills/, memory/, tools/ sit beside agents/
// and are available to every agent in that workspace.
export function workspaceMemoryIndex(tenant: string, workspace: string): string | null {
  return buildMemoryIndex(path.join(workspaceDir(tenant, workspace), "memory"), "../../memory/");
}

// Knowledge is what you *gave* an agent — stable reference material an agent
// reads and never rewrites. Memory is what it *learned* and authors itself.
// Keeping them apart matters: a price list an agent silently edits is a bug,
// and a fact it discovered that you have to maintain by hand is a chore.
export function knowledgeIndex(dir: string, prefix = ""): string | null {
  return buildMemoryIndex(dir, prefix);
}

export function workspaceKnowledgeIndex(tenant: string, workspace: string): string | null {
  return knowledgeIndex(path.join(workspaceDir(tenant, workspace), "knowledge"), "../../knowledge/");
}

// One noun for capability. A tools/<name>.md file declares either an HTTP
// endpoint or a script — `type:` says which, and it's inferred when omitted
// (a `base:` means http, a `run:` means script). Both are granted the same
// way, with `use: [name]`, so "what can this agent do?" has one answer in one
// place instead of three (`tools:`, `scripts:`, `apis:`).
// An MCP server an agent can connect to. MCP is the cross-vendor standard for
// tools (Anthropic, OpenAI, Google), so accepting a server here is what lets
// someone reuse the ecosystem instead of re-describing an integration we
// already have a format for. Both transports the SDK supports are allowed:
// a local process (`command`) or a remote endpoint (`url`).
const asRecord = (v: unknown): Record<string, string> =>
  v && typeof v === "object" && !Array.isArray(v)
    ? Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, String(x)]))
    : {};

export interface McpSpec {
  name: string;
  description: string;
  command?: string;
  args: string[];
  env: Record<string, string>; // values may contain ${SECRET_NAME}
  url?: string;
  headers: Record<string, string>;
}

export type ToolDef =
  | { kind: "http"; name: string; spec: ApiSpec }
  | { kind: "script"; name: string; spec: Record<string, unknown> }
  | { kind: "mcp"; name: string; spec: McpSpec };

/**
 * The program inside a single-file script tool: the first fenced block whose
 * language tag names a runnable language. By tag, not by position — a body
 * legitimately opens with a \`\`\`yaml example of the use: line, and running
 * the documentation would be a memorable bug. Untagged fences never qualify:
 * "which block is the program" must be answerable by reading, not guessing.
 */
export function fencedCode(body: string): { code: string; ext: string } | null {
  const EXT: Record<string, string> = {
    js: ".mjs", mjs: ".mjs", javascript: ".mjs", ts: ".mjs",
    python: ".py", py: ".py", bash: ".sh", sh: ".sh", ruby: ".rb", rb: ".rb",
  };
  for (const m of body.matchAll(/```([a-zA-Z0-9]+)\r?\n([\s\S]*?)```/g)) {
    const ext = EXT[m[1].toLowerCase()];
    if (ext && m[2].trim()) return { code: m[2], ext };
  }
  return null;
}

export function parseToolDef(data: Record<string, unknown>, fallbackName: string, body?: string): ToolDef | null {
  const name = typeof data.name === "string" ? data.name : fallbackName;
  // `transport:`, or a legacy `type: http|script|mcp` from before `type:` meant
  // the document. `type: Tool` says what the file is and deliberately says
  // nothing about how it connects, so it falls through to inference below.
  const declared = readTransport(data);
  // Inferred when neither is present, so simple files stay simple.
  const kind =
    declared ??
    (typeof data.command === "string" || typeof data.url === "string"
      ? "mcp"
      : typeof data.run === "string"
        ? "script"
        : "http");

  if (kind === "mcp") {
    const command = typeof data.command === "string" ? data.command : undefined;
    const url = typeof data.url === "string" ? data.url : undefined;
    if (!command && !url) return null;
    return {
      kind: "mcp",
      name,
      spec: {
        name,
        description: typeof data.description === "string" ? data.description : "",
        command,
        args: Array.isArray(data.args) ? data.args.map(String) : [],
        env: asRecord(data.env),
        url,
        headers: asRecord(data.headers),
      },
    };
  }
  if (kind === "script") {
    // The program is a run: path, or the file's own fenced code block — the
    // single-file form, which is what lets a script tool read and edit like
    // every other markdown document.
    if (typeof data.run === "string") return { kind: "script", name, spec: { ...data, name } };
    const inline = body ? fencedCode(body) : null;
    if (!inline) return null;
    return { kind: "script", name, spec: { ...data, name, code: inline.code, codeExt: inline.ext } };
  }
  const [spec] = parseApis([{ ...data, name }]);
  return spec ? { kind: "http", name, spec } : null;
}

/**
 * Tools in a directory, in both shapes.
 *
 *   tools/email.md            flat — a definition and nothing else
 *   tools/bounce-verify/      folder — tool.md plus the code it runs
 *     tool.md
 *     run.mjs
 *
 * The folder is the shape to write. A script tool is a definition and an
 * executable that cannot be separated — point `run:` at the wrong scope and
 * the tool silently resolves to nothing — so keeping them in one directory
 * is what stops the two from ever disagreeing. It is also how skills already
 * work, which is the pattern people have seen.
 *
 * A folder tool's `run:` is relative to its own folder, and rewritten here
 * to the scope-qualified path the runner resolves. That is the point of the
 * shape: the definition never names the scope it lives in, so the same
 * folder works copied into a workspace or installed at the account.
 *
 * Flat files keep working unchanged — the shape is a migration, not a break.
 */
function readToolDir(dir: string, scope: "workspace" | "account" = "workspace"): Record<string, ToolDef> {
  if (!fs.existsSync(dir)) return {};
  const out: Record<string, ToolDef> = {};
  const broken: string[] = [];

  const add = (raw: string, fallbackName: string, folder: string | null) => {
    try {
      const { data, content } = matter(raw);
      const d = data as Record<string, unknown>;
      // A folder tool's code sits beside its definition; qualify the path so
      // the runner can find it from an agent directory two levels down.
      if (folder && typeof d.run === "string" && !/^(workspace|account|shared|library)\//.test(d.run)) {
        d.run = `${scope}/tools/${folder}/${d.run.replace(/^\.\//, "")}`;
      }
      const def = parseToolDef(d, fallbackName, content);
      if (def) out[def.name] = def;
      else broken.push(`${fallbackName}: no base, run, command or fenced code block — nothing to call`);
    } catch (err) {
      // A malformed definition must not fail every run in the workspace. But
      // it must not vanish either: dropped silently, a tool with a YAML typo
      // is indistinguishable from one that was never created, and the agent
      // that opted into it is told the tool "is not in the workspace" —
      // which sends its author looking in the wrong place entirely.
      broken.push(`${fallbackName}: ${err instanceof Error ? err.message.split("\n")[0] : "unreadable"}`);
    }
  };

  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      const manifest = path.join(dir, entry.name, "tool.md");
      if (fs.existsSync(manifest)) add(fs.readFileSync(manifest, "utf8"), entry.name, entry.name);
      continue;
    }
    if (!entry.name.endsWith(".md")) continue;
    add(fs.readFileSync(path.join(dir, entry.name), "utf8"), entry.name.replace(/\.md$/, ""), null);
  }
  // Reported through the definitions map so a caller that only wants tools
  // can ignore it, and the runner can say what is actually wrong.
  brokenTools.set(dir, broken);
  return out;
}

/** Why a tool in this directory failed to load, keyed by directory. */
const brokenTools = new Map<string, string[]>();

/** Definitions that exist on disk but could not be read, for the scopes an
 *  agent draws on. Empty when everything parsed. */
export function brokenToolReport(tenant: string, workspace: string): string[] {
  const dirs = [
    path.join(workspaceDir(tenant, workspace), "tools"),
    path.join(dataRoot(), tenant, "library", "tools"),
  ];
  return dirs.flatMap((d) => brokenTools.get(d) ?? []);
}

export function workspaceTools(tenant: string, workspace: string): Record<string, ToolDef> {
  return readToolDir(path.join(workspaceDir(tenant, workspace), "tools"), "workspace");
}

export { readToolDir };

// Files under agents/<name>/scripts/ — the agent's own tooling, runnable
// with the bash tool.
export function agentScripts(tenant: string, workspace: string, agent: string): string[] {
  const dir = path.join(workspaceDir(tenant, workspace), "agents", agent, "scripts");
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { recursive: true })) {
    const rel = String(entry);
    if (fs.statSync(path.join(dir, rel)).isFile()) out.push(rel);
  }
  return out.sort();
}

// An API an agent may call. The platform turns each one into a single tool
// scoped to `base`, resolving ${SECRET} placeholders server-side so the
// agent never sees credentials.
export interface ApiSpec {
  name: string;
  base: string;
  description: string;
  headers: Record<string, string>; // values may contain ${SECRET_NAME}
  query: Record<string, string>; // always-appended query params (e.g. api keys)
  methods: string[]; // allowed HTTP methods; default GET only
}

export interface AgentInfo {
  name: string;
  description: string;
  model: string;
  tools: string[];
  apis: ApiSpec[];
  /** Library tools this agent opted into with `use:` — granted capability. */
  use: string[];
  secrets: string[];
}

// Recognised HTTP verbs a tool may declare. Deliberately NOT named
// "safe methods" — in HTTP that term means "no side effects" (GET, HEAD), and
// DELETE is the opposite. This is an allowlist: unknown or exotic verbs are
// dropped rather than passed to fetch, and a tool that declares none is
// read-only, because the least dangerous thing should happen when a file says
// nothing.
const ALLOWED_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"];

// Model selection. Tiers are the portable default — they keep working as
// models are renamed. An explicit alias or full model id is passed straight
// through for callers who want to pin one.
export const MODEL_TIERS: Record<string, string> = {
  fast: "haiku",
  default: "sonnet",
  max: "opus",
};

// The same three tiers under every name someone reasonably reaches for.
// Nobody should have to learn our vocabulary to pick a model, and the
// alternative to accepting `small` is worse than pedantic: an unrecognised
// word is passed through as a model id, so `model: small` would reach the
// provider as a model called "small" and fail the step at run time, on a
// file that reads perfectly. A synonym table is cheaper than that error.
const MODEL_ALIASES: Record<string, keyof typeof MODEL_TIERS> = {
  fast: "fast",
  small: "fast",
  cheap: "fast",
  mini: "fast",
  light: "fast",
  low: "fast",
  haiku: "fast",

  default: "default",
  standard: "default",
  base: "default",
  balanced: "default",
  mid: "default",
  medium: "default",
  normal: "default",
  sonnet: "default",

  max: "max",
  large: "max",
  big: "max",
  best: "max",
  smart: "max",
  high: "max",
  deep: "max",
  opus: "max",
};

export type Tier = keyof typeof MODEL_TIERS;

/** Which tier a word names, or null if it names none. Exported because the
 *  provider block keys a remap table by tier and should accept every word
 *  `model:` does — one vocabulary, not two. */
export function resolveTier(value: unknown): Tier | null {
  if (typeof value !== "string" || !value.trim()) return null;
  return MODEL_ALIASES[value.trim().toLowerCase()] ?? null;
}

export function resolveModel(value: unknown): string {
  const raw = typeof value === "string" && value.trim() ? value.trim() : "default";
  const tier = resolveTier(raw);
  if (tier) return MODEL_TIERS[tier];
  return raw; // "claude-opus-5" | a provider's own id | …
}

// Effort is the other half of model selection, and the orthogonal one: the
// model is which brain, effort is how long it thinks before answering. The
// five levels are the SDK's own union — we neither invent our own scale nor
// narrow theirs, so a level added upstream is one line here.
export const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;
export type Effort = (typeof EFFORT_LEVELS)[number];

const EFFORT_ALIASES: Record<string, Effort> = {
  low: "low",
  min: "low",
  minimal: "low",
  lowest: "low",
  fast: "low",
  quick: "low",

  medium: "medium",
  med: "medium",
  mid: "medium",
  moderate: "medium",
  normal: "medium",
  balanced: "medium",

  high: "high",
  default: "high", // the SDK's default, said out loud
  deep: "high",

  xhigh: "xhigh",
  "x-high": "xhigh",
  "extra-high": "xhigh",
  extrahigh: "xhigh",
  "very-high": "xhigh",
  veryhigh: "xhigh",
  higher: "xhigh",

  max: "max",
  maximum: "max",
  highest: "max",
  full: "max",
};

/**
 * `null` for both "not set" and "not a level we know" — unlike a model, the
 * set is closed, so passing an unrecognised word through would be a 400 from
 * the API rather than someone's pinned choice. Callers that can report say
 * which it was with `isEffortWord`.
 */
export function resolveEffort(value: unknown): Effort | null {
  if (typeof value !== "string" || !value.trim()) return null;
  return EFFORT_ALIASES[value.trim().toLowerCase()] ?? null;
}

/** True when a non-empty `effort:` was written but names no level — the
 *  one case worth a line in the run trace, because silence there looks
 *  exactly like the setting having been applied. */
export function isEffortWord(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0 && resolveEffort(value) === null;
}

// apis: frontmatter:
//   apis:
//     - name: google_ads
//       base: https://googleads.googleapis.com/v18
//       description: Google Ads REST API. Use searchStream for metrics.
//       methods: [GET, POST]
//       headers:
//         Authorization: Bearer ${GOOGLE_ADS_TOKEN}
//         developer-token: ${GOOGLE_ADS_DEV_TOKEN}
export function parseApis(raw: unknown): ApiSpec[] {
  if (!Array.isArray(raw)) return [];
  const out: ApiSpec[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    const name = typeof e.name === "string" ? e.name : null;
    const base = typeof e.base === "string" ? e.base : null;
    if (!name || !base) continue;
    const asRecordLocal = (v: unknown): Record<string, string> =>
      v && typeof v === "object" && !Array.isArray(v)
        ? Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, String(x)]))
        : {};
    const methods = Array.isArray(e.methods)
      ? e.methods.map((m) => String(m).toUpperCase()).filter((m) => ALLOWED_METHODS.includes(m))
      : ["GET"];
    out.push({
      name: name.replace(/[^a-zA-Z0-9_]/g, "_"),
      base: base.replace(/\/+$/, ""),
      description: typeof e.description === "string" ? e.description : "",
      headers: asRecordLocal(e.headers),
      query: asRecordLocal(e.query),
      methods: methods.length ? methods : ["GET"],
    });
  }
  return out;
}

export interface FlowStep {
  agent: string;
  instruction: string;
  group: number; // steps sharing a group number run in parallel
  optional: boolean; // "2?" — failure doesn't fail the flow
  /** Set when the step targets another flow (`[[flow:name]]`) instead of an agent. */
  subflow?: string;
  /** Overrides the agent's own model for this step only. */
  model?: string;
  /** Overrides the agent's own effort for this step only — the expensive
   *  step in an otherwise cheap flow is exactly what this is for. */
  effort?: string;
  /** Pause for a human before running this step. */
  approve?: boolean;
  /** Run only if the previous results contain this text (case-insensitive).
   *  Independent: every matching `when:` step in a group runs. */
  when?: string;
  /** Exclusive routing: of a group's `case:` steps, only the FIRST whose
   *  text appears in the previous results runs; the rest are routed past. */
  case?: string;
  /** The route of last resort: runs only when none of its group's `case:`
   *  steps matched. */
  else?: boolean;
  /** Attempts on failure, beyond the first. */
  retry?: number;
  /** Abandon the step after this many seconds. */
  timeout?: number;
  /** Another agent takes the step over when it fails: same instruction, the
   *  failure as context. Success continues the flow with the rescuer's
   *  result; a second failure fails the step as it always did. */
  onFail?: string;
  /** Seconds to hold before this step runs — "wait: 3d" parses to 259200.
   *  The run parks in the queue, not in a process. */
  waitSecs?: number;
  /** For `each: rows` — the CSV whose rows fan the step out, agent-relative
   *  like every other path an instruction uses. */
  eachPath?: string;
  /** A question for a human. The step parks like an approval; the answer
   *  typed at the gate reaches the step's prompt. */
  ask?: string;
  /** Model-led delegation, bounded by declaration: this step's agent picks
   *  which of THESE agents run next, one instruction each. The choice set
   *  is the file's, the picks are the model's, the record shows both. */
  delegate?: string[];
  /** Evaluator loop: when this step's result lacks `until:`'s marker, wind
   *  back to the previous group and go again — at most this many extra
   *  cycles. Bounded by declaration, so the worst-case cost is still
   *  readable off the file. */
  loop?: number;
  /** The marker (case-insensitive) whose presence in this step's result ends
   *  the loop early. Required for `loop:` to mean anything. */
  until?: string;
  /** Fan-out: run one instance of this step per item of the previous
   *  group's result. `lines` is the one mode — one item per non-empty line. */
  each?: "lines" | "rows";
  /** Fan-out cap. Items beyond it are dropped, and the run log says so. */
  max?: number;
  /** Shell command run after the step; a non-zero exit fails the step. */
  verify?: string;
  /** 1-indexed line in the flow file. Diagnostics without a line make you
   *  search; every real linter emits file:line. */
  line?: number;
}

export interface FlowInfo {
  name: string;
  file: string;
  trigger: string;
  schedule: string | null;
  timezone: string | null;
  /** The model every step in this flow runs on, unless the step names its
   *  own. Nearest wins: step, then flow, then the agent's own frontmatter. */
  model: string | null;
  /** Same, for effort. */
  effort: string | null;
  /** What a new fire does while a run of this flow is still live:
   *  "skip" doesn't start one, "queue" starts it but the worker holds it
   *  until the live run finishes. Unset keeps today's behaviour (runs may
   *  overlap) — a default that changed underfoot would surprise every flow
   *  that legitimately runs in parallel. */
  overlap: "skip" | "queue" | null;
  steps: FlowStep[];
}

// Skills and memory files belonging to one agent — for the graph view and
// [[ ]] autocomplete.
export interface AgentAssets {
  skills: string[]; // skill names (frontmatter name or filename)
  memory: string[]; // memory file names under memory/
}

export function agentAssets(tenant: string, workspace: string, agent: string): AgentAssets {
  const base = path.join(workspaceDir(tenant, workspace), "agents", agent);
  const nameOf = (file: string, fallback: string) => {
    try {
      return matter(fs.readFileSync(file, "utf8")).data.name ?? fallback;
    } catch {
      return fallback;
    }
  };

  // Skills: folders with SKILL.md (Agent Skills standard) plus flat .md files.
  const skills: string[] = [];
  const skillsDir = path.join(base, "skills");
  if (fs.existsSync(skillsDir)) {
    for (const entry of fs.readdirSync(skillsDir).sort()) {
      const full = path.join(skillsDir, entry);
      if (fs.statSync(full).isDirectory()) {
        const skillMd = path.join(full, "SKILL.md");
        if (fs.existsSync(skillMd)) skills.push(nameOf(skillMd, entry));
      } else if (entry.endsWith(".md")) {
        skills.push(nameOf(full, entry.replace(/\.md$/, "")));
      }
    }
  }

  const memory: string[] = [];
  const memoryDir = path.join(base, "memory");
  if (fs.existsSync(memoryDir)) {
    for (const f of fs.readdirSync(memoryDir).sort()) {
      if (f.endsWith(".md") && !["index.md", "log.md"].includes(f)) {
        memory.push(nameOf(path.join(memoryDir, f), f.replace(/\.md$/, "")));
      }
    }
  }
  return { skills, memory };
}

export function listAgents(tenant: string, workspace: string): AgentInfo[] {
  const dir = path.join(workspaceDir(tenant, workspace), "agents");
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((n) => fs.existsSync(path.join(dir, n, "agent.md")))
    .sort()
    .map((name) => {
      const { data } = matter(fs.readFileSync(path.join(dir, name, "agent.md"), "utf8"));
      const tools = (data.tools ?? []).map((t: unknown) =>
        typeof t === "string" ? t : Object.keys(t as object)[0],
      );
      return {
        name,
        description: data.description ?? "",
        model: data.model ?? "default",
        effort: data.effort ?? null,
        tools,
        apis: parseApis(data.apis),
        use: Array.isArray(data.use) ? data.use.map(String) : [],
        secrets: Array.isArray(data.secrets) ? data.secrets.map(String) : [],
      };
    });
}

// A step targets an agent — `[[writer]]` — or another flow — `[[flow:digest]]`,
// which is how one flow triggers another.
const STEP_RE = /^\s*(\d+)([?!])?\.?\s+\[\[(flow:)?([a-z0-9-]+)\]\]\s*(?:[—–-]\s*)?(.*)$/;

const OPTION_RE = /^\s+([a-z-]+):\s*(.+)$/;

/** "90s", "30m", "4h", "3d" — or a bare number of seconds. Clamped to 30
 *  days: a wait is a pause in a flow, not a second scheduler. */
export function parseWait(value: string): number | undefined {
  const m = value.trim().match(/^(\d+(?:\.\d+)?)\s*([smhd]?)$/i);
  if (!m) return undefined;
  const mult = { "": 1, s: 1, m: 60, h: 3600, d: 86400 }[m[2].toLowerCase() as "" | "s" | "m" | "h" | "d"];
  const secs = Math.round(Number(m[1]) * mult);
  return secs > 0 ? Math.min(secs, 30 * 86400) : undefined;
}

export function parseFlow(file: string, raw: string): FlowInfo {
  const { data, content } = matter(raw);
  const steps: FlowStep[] = [];
  // Frontmatter is stripped by matter(), so add it back to keep line numbers
  // pointing at the real file rather than the body.
  const offset = raw.slice(0, raw.length - content.length).split("\n").length - 1;
  let lineNo = 0;
  for (const line of content.split("\n")) {
    lineNo++;
    const m = line.match(STEP_RE);
    if (m) {
      steps.push({
        group: Number(m[1]),
        // Both "2? [[x]]" and an `approve: true` option are accepted; "!"
        // is shorthand for the common case of needing a human.
        optional: m[2] === "?",
        approve: m[2] === "!" || undefined,
        agent: m[4],
        subflow: m[3] ? m[4] : undefined,
        instruction: m[5].trim(),
        line: lineNo + offset,
      });
      continue;
    }
    // Indented options belong to the step above them.
    const opt = line.match(OPTION_RE);
    if (opt && steps.length) {
      const step = steps[steps.length - 1];
      const [, key, rawValue] = opt;
      const value = rawValue.trim().replace(/^["']|["']$/g, "");
      if (key === "approve") step.approve = value !== "false";
      else if (key === "when") step.when = value;
      else if (key === "case") step.case = value;
      else if (key === "else") step.else = value !== "false";
      else if (key === "retry") step.retry = Math.min(5, Math.max(0, Number(value) || 0));
      else if (key === "timeout") step.timeout = Math.max(1, Number(value) || 0);
      else if (key === "verify") step.verify = value;
      else if (key === "model") step.model = value;
      else if (key === "effort") step.effort = value;
      else if (key === "loop") step.loop = Math.min(5, Math.max(1, Number(value) || 0)) || undefined;
      else if (key === "until") step.until = value;
      else if (key === "each") {
        if (value === "lines") step.each = "lines";
        else if (/^rows\b/.test(value)) {
          step.each = "rows";
          // "rows of ../../files/leads.csv" — the path is the part after "of".
          step.eachPath = value.replace(/^rows(\s+of)?\s*/, "").trim() || undefined;
        }
      }
      else if (key === "on-fail" || key === "onfail") step.onFail = value.replace(/^\[\[|\]\]$/g, "");
      else if (key === "wait") step.waitSecs = parseWait(value);
      else if (key === "ask") { step.ask = value; }
      else if (key === "delegate")
        step.delegate = value.split(",").map((v) => v.trim().replace(/^\[\[|\]\]$/g, "")).filter(Boolean).slice(0, 5);
      else if (key === "max") step.max = Math.min(20, Math.max(1, Number(value) || 0)) || undefined;
    }
  }
  steps.sort((a, b) => a.group - b.group);
  return {
    name: data.name ?? file.replace(/\.md$/, ""),
    file,
    trigger: data.trigger ?? "manual",
    schedule: data.schedule ?? null,
    timezone: data.timezone ?? null,
    model: data.model ?? null,
    effort: data.effort ?? null,
    overlap: data.overlap === "skip" || data.overlap === "queue" ? data.overlap : null,
    steps,
  };
}

/** A live run of this flow — the fact overlap: decisions are made on. */
export function flowHasLiveRun(tenant: string, workspace: string, flowName: string): boolean {
  return listRuns(tenant, workspace).some(
    (r) => r.flow === flowName && (r.status === "running" || r.status === "queued" || r.status === "awaiting-approval"),
  );
}

// Rearranging a flow from the dashboard rewrites the numbers in the markdown
// and nothing else. Working on raw text blocks rather than re-serialising the
// parsed FlowInfo means instructions, option lines, frontmatter and any prose
// survive a drag exactly as the author wrote them — the file stays theirs.
//
// `groups` is the new arrangement: an array of groups, each holding indices
// into the flow's parsed `steps`. Steps sharing a group run in parallel.
interface FlowBlock {
  group: number;
  lines: string[]; // the step line, plus its indented options and notes
}

// Split a flow file into its frontmatter, any prose before the first step,
// and one block per step. Blocks come back in the same order as parseFlow's
// steps, so a block index and a step index mean the same thing.
function splitFlowBlocks(raw: string) {
  const head = raw.match(/^(---\r?\n[\s\S]*?\r?\n---\r?\n?)/)?.[1] ?? "";
  const preamble: string[] = [];
  const blocks: FlowBlock[] = [];
  for (const line of raw.slice(head.length).split("\n")) {
    if (STEP_RE.test(line)) blocks.push({ group: Number(line.match(STEP_RE)![1]), lines: [line] });
    else if (blocks.length) blocks[blocks.length - 1].lines.push(line);
    else preamble.push(line);
  }
  // parseFlow sorts by group, and Array.prototype.sort is stable, so the same
  // sort here keeps block i aligned with steps[i].
  const ordered = blocks.map((b, i) => ({ ...b, i })).sort((a, b) => a.group - b.group || a.i - b.i);
  while (preamble.length && preamble[preamble.length - 1].trim() === "") preamble.pop();
  return { head, preamble, blocks: ordered as FlowBlock[] };
}

function emitFlow(head: string, preamble: string[], groups: FlowBlock[][]): string {
  const out: string[] = [];
  groups.forEach((group, g) => {
    for (const block of group) {
      const [stepLine, ...rest] = block.lines;
      const m = stepLine.match(STEP_RE)!;
      const [, , marker = "", flowPrefix = "", target, instruction] = m;
      out.push(
        `${g + 1}${marker}. [[${flowPrefix}${target}]]${instruction.trim() ? ` — ${instruction.trim()}` : ""}`,
      );
      while (rest.length && rest[rest.length - 1].trim() === "") rest.pop();
      out.push(...rest);
    }
  });
  // Keep the blank line that conventionally follows frontmatter.
  const gap = preamble.length ? `${preamble.join("\n")}\n\n` : head ? "\n" : "";
  return `${head}${gap}${out.join("\n")}\n`;
}

/**
 * Rewrite a flow's trigger in place — the dashboard's trigger picker.
 *
 * Line-level surgery on the frontmatter, not a YAML round-trip: everything
 * the author wrote (comments, key order, unrelated keys) survives verbatim,
 * and the diff is exactly the lines that changed. A flow with no
 * frontmatter gains the smallest one that can carry the trigger.
 */
export function setFlowTrigger(
  raw: string,
  opts: { trigger: "manual" | "schedule" | "webhook"; schedule?: string; timezone?: string },
): string {
  if (!["manual", "schedule", "webhook"].includes(opts.trigger)) {
    throw new Error(`unknown trigger "${opts.trigger}" — manual, schedule or webhook`);
  }
  const wanted = new Map<string, string | null>();
  wanted.set("trigger", opts.trigger === "manual" ? null : opts.trigger); // manual is the default — say nothing
  if (opts.trigger === "schedule") {
    const cron = (opts.schedule ?? "").trim();
    // Shape only — the scheduler's parseCron is the authority, and the API
    // route runs it; importing it here would cycle store ↔ scheduler.
    const shaped = /^@\w+$/.test(cron) || cron.split(/\s+/).length === 5;
    if (!cron || !shaped) {
      throw new Error(`"${cron}" is not a cron expression (5 fields, or @daily-style)`);
    }
    wanted.set("schedule", `"${cron}"`);
    wanted.set("timezone", opts.timezone?.trim() ? opts.timezone.trim() : null);
  } else {
    wanted.set("schedule", null);
    wanted.set("timezone", null);
  }

  const lines = raw.split("\n");
  const hasFront = lines[0]?.trim() === "---";
  const close = hasFront ? lines.indexOf("---", 1) : -1;
  const front = hasFront && close > 0 ? lines.slice(1, close) : [];
  const body = hasFront && close > 0 ? lines.slice(close + 1) : lines;

  const kept = front.filter((line) => {
    const key = line.match(/^(\w+):/)?.[1];
    return !(key && wanted.has(key));
  });
  for (const [key, value] of wanted) {
    if (value !== null) kept.push(`${key}: ${value}`);
  }

  if (kept.length === 0) return body.join("\n").replace(/^\n+/, "");
  return ["---", ...kept, "---", ...body].join("\n");
}

/**
 * Rewrite one step's option lines — the board's step editor. Surgical, like
 * every flow rewrite: only the managed option lines of block `index` change;
 * the step line, its unmanaged options (approve stays the `!` marker's
 * business), other steps, comments and frontmatter survive verbatim.
 * `null` clears an option; values are clamped exactly as parseFlow reads
 * them, so what the editor writes is what the runner will do.
 */
/**
 * Rewrite one step's instruction, and nothing else.
 *
 * The step line carries four things — the group number, the optional/approve
 * marker, the wikilink, and the instruction — and only the last is being
 * edited. Rebuilding the line from the parsed step would silently normalise
 * the other three (a "2?" becoming "2.", an en dash becoming an em dash), so
 * the prefix is taken verbatim from the file and only the tail replaced. A
 * flow's markdown stays the author's.
 */
export function updateFlowStepInstruction(raw: string, index: number, instruction: string): string {
  const { head, preamble, blocks } = splitFlowBlocks(raw);
  if (!Number.isInteger(index) || index < 0 || index >= blocks.length) {
    throw new Error(`no step ${index}`);
  }
  const block = blocks[index];
  const line = block.lines[0];
  const m = line.match(STEP_RE);
  if (!m) throw new Error(`step ${index} is not a step line`);
  // Everything up to where the instruction starts, exactly as written.
  const prefix = m[5] ? line.slice(0, line.length - m[5].length) : `${line.replace(/\s+$/, "")} — `;
  const next = instruction.trim().replace(/\s*\n\s*/g, " ");
  block.lines = [`${prefix}${next}`.replace(/\s+$/, ""), ...block.lines.slice(1)];
  // Same regrouping as updateFlowStep: consecutive blocks sharing a number
  // are one parallel group, and emitFlow puts the file back together.
  const groups: FlowBlock[][] = [];
  for (const b of blocks) {
    const last = groups[groups.length - 1];
    if (last && last[0].group === b.group) last.push(b);
    else groups.push([b]);
  }
  return emitFlow(head, preamble, groups);
}

export function updateFlowStep(
  raw: string,
  index: number,
  options: Partial<Record<"model" | "effort" | "retry" | "timeout" | "verify" | "when" | "case" | "else" | "loop" | "until" | "each" | "max", string | number | null>>,
): string {
  const { head, preamble, blocks } = splitFlowBlocks(raw);
  if (!Number.isInteger(index) || index < 0 || index >= blocks.length) {
    throw new Error(`no step ${index}`);
  }

  const clamp: Record<string, (v: string) => string | null> = {
    model: (v) => v || null,
    effort: (v) => resolveEffort(v) ?? null,
    verify: (v) => v || null,
    when: (v) => v || null,
    case: (v) => v || null,
    else: (v) => (v === "true" || v === "1" ? "true" : null),
    until: (v) => v || null,
    retry: (v) => String(Math.min(5, Math.max(0, Number(v) || 0))),
    timeout: (v) => (Number(v) > 0 ? String(Math.max(1, Math.floor(Number(v)))) : null),
    loop: (v) => (Number(v) > 0 ? String(Math.min(5, Math.max(1, Math.floor(Number(v))))) : null),
    max: (v) => (Number(v) > 0 ? String(Math.min(20, Math.max(1, Math.floor(Number(v))))) : null),
    each: (v) => (v === "lines" ? "lines" : null),
  };

  const block = blocks[index];
  const managed = new Set(Object.keys(options));
  const kept = block.lines.slice(1).filter((line) => {
    const key = line.match(OPTION_RE)?.[1];
    return !(key && managed.has(key));
  });
  const added: string[] = [];
  for (const [key, value] of Object.entries(options)) {
    if (value === null || value === undefined || !(key in clamp)) continue;
    const cleaned = clamp[key](String(value).trim());
    if (cleaned === null) continue;
    added.push(`   ${key}: ${cleaned}`);
  }
  block.lines = [block.lines[0], ...added, ...kept];

  // Reassemble the original grouping: consecutive blocks sharing a group.
  const groups: FlowBlock[][] = [];
  for (const b of blocks) {
    const last = groups[groups.length - 1];
    if (last && last[0].group === b.group) last.push(b);
    else groups.push([b]);
  }
  return emitFlow(head, preamble, groups);
}

export function reorderFlowSteps(raw: string, groups: number[][]): string {
  const { head, preamble, blocks: ordered } = splitFlowBlocks(raw);

  const seen = new Set<number>();
  for (const group of groups) {
    if (group.length === 0) throw new Error("a group must contain at least one step");
    for (const i of group) {
      if (!Number.isInteger(i) || i < 0 || i >= ordered.length) throw new Error(`no step ${i}`);
      if (seen.has(i)) throw new Error(`step ${i} appears twice`);
      seen.add(i);
    }
  }
  if (seen.size !== ordered.length) {
    throw new Error(`expected all ${ordered.length} steps, got ${seen.size}`);
  }

  return emitFlow(head, preamble, groups.map((g) => g.map((i) => ordered[i])));
}

/** Append a step as its own group at the end of the flow. */
export function addFlowStep(
  raw: string,
  step: { target: string; subflow?: boolean; instruction?: string },
): string {
  assertSafeName(step.target, "step target");
  const { head, preamble, blocks } = splitFlowBlocks(raw);
  const instruction = (step.instruction ?? "").replace(/[\r\n]+/g, " ").trim();
  const line = `0. [[${step.subflow ? "flow:" : ""}${step.target}]]${instruction ? ` — ${instruction}` : ""}`;
  if (!STEP_RE.test(line)) throw new Error("could not build a valid step line");
  const groups = groupBlocks(blocks);
  groups.push([{ group: 0, lines: [line] }]);
  return emitFlow(head, preamble, groups);
}

/** Drop one step, by its index in the flow's parsed steps. */
export function removeFlowStep(raw: string, index: number): string {
  const { head, preamble, blocks } = splitFlowBlocks(raw);
  if (!Number.isInteger(index) || index < 0 || index >= blocks.length) {
    throw new Error(`no step ${index}`);
  }
  const kept = blocks.filter((_, i) => i !== index);
  return emitFlow(head, preamble, groupBlocks(kept));
}

/** Blocks → the group structure they currently describe. */
function groupBlocks(blocks: FlowBlock[]): FlowBlock[][] {
  const map = new Map<number, FlowBlock[]>();
  for (const b of blocks) map.set(b.group, [...(map.get(b.group) ?? []), b]);
  return [...map.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v);
}

export function listFlows(tenant: string, workspace: string): FlowInfo[] {
  const dir = path.join(workspaceDir(tenant, workspace), "flows");
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .sort()
    .map((f) => parseFlow(f, fs.readFileSync(path.join(dir, f), "utf8")));
}

export interface WorkspaceSummary {
  name: string;
  description: string;
  agents: number;
  flows: number;
  deployedAt: string;
  runCount: number;
}

/**
 * Every account this installation holds.
 *
 * A tenant is a directory under the data root, but not every directory there
 * is one — `.runtimes/` sits beside them, and so do keys.json and the secret
 * key. What makes a tenant is that it holds workspaces, so that is the test.
 *
 * Single-workspace mode has no accounts at all: the workspace *is* the whole
 * installation, and there is nothing above it to enumerate.
 */
export function listTenants(): string[] {
  if (singleWorkspace()) return [];
  const root = dataRoot();
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root)
    .filter((name) => SAFE_NAME.test(name))
    .filter((name) => {
      const dir = path.join(root, name);
      try {
        if (!fs.statSync(dir).isDirectory()) return false;
      } catch {
        return false;
      }
      return [WORKSPACES, LEGACY_WORKSPACES].some((w) => fs.existsSync(path.join(dir, w)));
    })
    .sort();
}

export function listWorkspaces(tenant: string): WorkspaceSummary[] {
  assertSafeName(tenant, "tenant");
  const dir = workspacesRoot(tenant);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((n) => fs.statSync(path.join(dir, n)).isDirectory())
    .map((name) => {
      const pDir = path.join(dir, name);
      // AGENTS.md is the workspace's config file; project.md is the name it
      // had before. Take the first NON-EMPTY description across both — not the
      // first file that merely exists. A workspace with both files but a
      // description only in project.md (AGENTS.md carrying just `notify:`, say)
      // otherwise shows blank, because the old code broke on file-exists.
      let description = "";
      for (const file of ["AGENTS.md", "project.md"]) {
        const p = path.join(pDir, file);
        if (!fs.existsSync(p)) continue;
        try {
          const d = matter(fs.readFileSync(p, "utf8")).data.description ?? "";
          if (d) { description = d; break; }
        } catch {
          // an unreadable file is not a description; try the next
        }
      }
      const runsDir = path.join(pDir, "runs");
      return {
        name,
        description,
        agents: listAgents(tenant, name).length,
        flows: listFlows(tenant, name).length,
        deployedAt: fs.statSync(pDir).mtime.toISOString(),
        runCount: fs.existsSync(runsDir) ? fs.readdirSync(runsDir).length : 0,
      };
    })
    .sort((a, b) => b.deployedAt.localeCompare(a.deployedAt));
}

// ---------- file management (dashboard editing) ----------

// Editable paths: project.md, .md files under agents/ or flows/, and an
// agent's own scripts (text source files it runs with bash).
const SCRIPT_EXT = /\.(py|sh|[mc]?js|ts|rb|sql|txt|json|ya?ml|toml|env|md)$/i;

function assertEditablePath(rel: string) {
  const norm = path.normalize(rel);
  if (norm.startsWith("..") || path.isAbsolute(norm)) throw new Error(`illegal path: ${rel}`);
  assertCanonicalCase(norm);
  if (norm === "project.md" || norm === "AGENTS.md") return norm;
  if (norm.includes("outputs/")) throw new Error(`not an editable path: ${rel}`);
  if (/scripts\//.test(norm) && SCRIPT_EXT.test(norm)) return norm;
  if (/^agents\/[^/]+\/skills\/[^/]+\//.test(norm) && SCRIPT_EXT.test(norm)) return norm;
  if (/^(skills|memory|knowledge|tools|state)\//.test(norm) && SCRIPT_EXT.test(norm)) return norm;
  if (/^(agents|flows|evals)\//.test(norm) && norm.endsWith(".md")) return norm;
  throw new Error(`not an editable path: ${rel}`);
}

export function listWorkspaceFiles(tenant: string, workspace: string): string[] {
  const dir = workspaceDir(tenant, workspace);
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { recursive: true })) {
    const rel = String(entry);
    if (/(^|\/)(runs|outputs)\//.test(rel)) continue;
    // Skip anything reached through a symlink — a stray link would otherwise
    // pull another workspace (or the whole library) into this listing.
    try {
      if (fs.lstatSync(path.join(dir, rel)).isSymbolicLink()) continue;
    } catch {
      continue;
    }
    // Generated, not authored — the same reason runs/ is hidden above.
    if (/(^|\/)\.results\//.test(rel)) continue;

    const isScript = /scripts\//.test(rel) && SCRIPT_EXT.test(rel);
    const isSkillAsset = /^agents\/[^/]+\/skills\/[^/]+\//.test(rel) && SCRIPT_EXT.test(rel);
    const isMarkdown =
      rel.endsWith(".md") &&
      (rel === "project.md" ||
        rel === "AGENTS.md" ||
        new RegExp(`^(${WORKSPACE_DIRS.join("|")})/`).test(rel));
    // state/ is the one place holding data rather than prose — but the listing
    // admitted fewer extensions than the writer does, so `state/notes.md` could
    // be written and then never appeared in the tree. Writable and invisible is
    // the worst of both; one rule now decides.
    const isState = /^state\//.test(rel) && SCRIPT_EXT.test(rel);
    if (isScript || isSkillAsset || isMarkdown || isState) out.push(rel);
  }
  return out.sort();
}

export function readWorkspaceFile(tenant: string, workspace: string, rel: string): string {
  const p = path.join(workspaceDir(tenant, workspace), assertEditablePath(rel));
  if (!fs.existsSync(p)) throw new Error(`file not found: ${rel}`);
  return fs.readFileSync(p, "utf8");
}

export function writeWorkspaceFile(tenant: string, workspace: string, rel: string, content: string) {
  if (content.length > 256 * 1024) throw new Error("file too large");
  matter(content); // reject files whose frontmatter doesn't parse
  const p = path.join(workspaceDir(tenant, workspace), assertEditablePath(rel));
  const existed = fs.existsSync(p);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  // One trailing newline, never a run of them.
  //
  // Models end a document with blank lines — several, sometimes dozens — and
  // nothing trimmed them, so every save kept whatever the last writer left.
  // A reader sees it as a file that scrolls for a page after the text stops;
  // the editor's line gutter dutifully numbered all of it. Trailing blank
  // lines are not content in any format this holds (markdown, YAML
  // frontmatter, a script), and no author types thirty of them on purpose.
  fs.writeFileSync(p, `${content.replace(/\s+$/, "")}\n`);
  // Code is executable wherever it lives: the scripts shelf, a skill's
  // bundled scripts/, or a folder tool's own directory. A run.mjs written
  // without the bit fails at exec, which reads as "the tool is broken".
  const norm = rel.replaceAll("\\", "/");
  if (/^scripts\//.test(norm) || /(^|\/)scripts\//.test(norm) ||
      (/^tools\//.test(norm) && !norm.endsWith(".md"))) {
    fs.chmodSync(p, 0o755);
  }
  syncBundleFor(p, existed ? "Update" : "Creation");
}

// memory/ and knowledge/ are OKF bundles, so index.md has to stay current —
// a generated index that drifts is the same class of bug as a memory index
// naming files that don't exist.
export function syncBundleFor(file: string, change?: "Creation" | "Update") {
  // Walk up to the bundle root — a concept may sit in a nested section.
  let dir = path.dirname(file);
  let hops = 0;
  while (hops < 6) {
    const base = path.basename(dir);
    if (base === "memory" || base === "knowledge") break;
    dir = path.dirname(dir);
    hops++;
  }
  const kind = path.basename(dir);
  if (kind !== "memory" && kind !== "knowledge") return;

  // A workspace- or account-level bundle is a root; an agent's own is nested
  // inside one, and the spec permits okf_version only at a bundle root.
  const isRoot = path.basename(path.resolve(dir, "..", "..")) !== "agents";
  syncIndex(dir, kind === "memory" ? "Memory" : "Knowledge", isRoot);
  if (change) {
    appendLog(dir, path.relative(dir, file).split(path.sep).join("/"), change);
  }
}

/**
 * Rename one editable file. Both ends pass the same gate as a write — a
 * rename must not be able to move a file somewhere a write couldn't create
 * it — and an existing target refuses rather than silently replacing
 * someone's work. Bundle indexes on both sides are re-synced, because a
 * memory file leaving a bundle is as much a change to its index as one
 * arriving.
 */
/**
 * Why a path can never be moved or renamed, in a sentence — or null when it
 * can. One vocabulary for the tree, the API and the tests, because "not an
 * editable path" told the person *that* they were refused and made them
 * guess at *why*, when the why is the whole lesson: in this format,
 * location is meaning.
 */
export function anchoredReason(rel: string): string | null {
  const norm = rel.replaceAll("\\", "/");
  const base = norm.split("/").pop()!;
  if (norm === "AGENTS.md" || norm === "project.md") {
    return `${base} is the workspace's own identity — it cannot move; rename or delete the workspace instead`;
  }
  if (base === "agent.md") {
    return "agent.md is the agent because of where it sits — to rename the agent, rename its folder";
  }
  if (base === "SKILL.md") {
    return "SKILL.md names its skill — to rename the skill, rename its folder";
  }
  if (base === "tool.md") {
    return "tool.md names its tool — to rename the tool, rename its folder";
  }
  if (/(^|\/)(knowledge|memory)\/(.*\/)?(index|log)\.md$/.test(norm)) {
    return `${base} is generated from the files around it — it is rebuilt in place on the next write`;
  }
  return null;
}

export function renameWorkspaceFile(tenant: string, workspace: string, from: string, to: string) {
  // Refuse with the reason before any path validation: "not an editable
  // path" is true of AGENTS.md too, and the generic sentence buries the
  // specific one worth reading.
  const why = anchoredReason(from) ?? anchoredReason(to);
  if (why) throw new Error(why);
  const dir = workspaceDir(tenant, workspace);
  const src = path.join(dir, assertEditablePath(from));
  const dst = path.join(dir, assertEditablePath(to));
  if (!fs.existsSync(src)) throw new Error(`${from} does not exist`);
  if (fs.existsSync(dst)) throw new Error(`${to} already exists`);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.renameSync(src, dst);
  syncBundleFor(src);
  syncBundleFor(dst, "Update");
}

export function deleteWorkspacePath(tenant: string, workspace: string, rel: string) {
  const norm = path.normalize(rel).replaceAll("\\", "/");
  if (norm.startsWith("..") || path.isAbsolute(norm)) throw new Error(`illegal path: ${rel}`);
  const dir = workspaceDir(tenant, workspace);
  // The two files a workspace cannot exist without. assertEditablePath lets
  // them through — they are editable — but editable and deletable are
  // different claims, and deleting AGENTS.md is deleting the workspace's
  // own name.
  // The same sentences the tree and the rename path use — one vocabulary
  // for "this file is structure, not content". An identity file is only
  // deletable as its whole folder: agent.md alone leaves a folder that is
  // no longer an agent but still shadows the name.
  const anchored = anchoredReason(norm);
  if (anchored) {
    if (/(agent|SKILL|tool)\.md$/.test(norm)) {
      throw new Error(`${norm.split("/").pop()} is its folder's identity — delete the whole folder instead`);
    }
    throw new Error(anchored);
  }
  // Whole-folder units: an agent, a skill, a folder tool. Each is one thing
  // to its reader, so each is one thing to delete.
  if (/^agents\/[a-z0-9-]+$/.test(norm) ||
      /^(skills|tools)\/[a-z0-9-]+$/.test(norm) ||
      /^agents\/[a-z0-9-]+\/skills\/[a-z0-9-]+$/.test(norm)) {
    fs.rmSync(path.join(dir, norm), { recursive: true, force: true });
    return;
  }
  const p = path.join(dir, assertEditablePath(norm));
  fs.rmSync(p, { force: true });
  // A bundle's index must stop naming what is gone.
  syncBundleFor(p);
}

export function deleteWorkspace(tenant: string, workspace: string) {
  const dir = workspaceDir(tenant, workspace);
  if (!fs.existsSync(dir)) throw new Error(`workspace ${workspace} not found`);
  fs.rmSync(dir, { recursive: true, force: true });
}

/**
 * What a rename would break, so the caller can say so before doing it.
 *
 * The workspace name is not just a directory: it is in every webhook URL *and*
 * in the token those URLs carry, which is derived from `tenant/workspace/flow`.
 * So a rename invalidates both halves — an old hook doesn't 404, it fails the
 * signature check, which reads like an attack rather than a rename. Anything
 * calling those URLs has to be re-pointed by hand.
 */
export function renameImpact(tenant: string, workspace: string): { webhookFlows: string[] } {
  return {
    webhookFlows: listFlows(tenant, workspace)
      .filter((f) => f.trigger === "webhook")
      .map((f) => f.name),
  };
}

/**
 * Rename a workspace: move the directory, then update the `name:` in AGENTS.md
 * so the file and its folder don't disagree.
 *
 * Runs, state and secrets travel with it — they live inside the directory, so
 * there is nothing to migrate and nothing to lose.
 */
export function renameWorkspace(tenant: string, from: string, to: string) {
  assertSafeName(to, "workspace");
  if (from === to) return;

  const src = workspaceDir(tenant, from);
  if (!fs.existsSync(src)) throw new Error(`workspace ${from} not found`);

  // Deliberately not workspaceDir(): that returns the *legacy* path when one
  // exists, and renaming into `projects/` would resurrect the old layout.
  const dest = singleWorkspace()
    ? (() => { throw new Error("cannot rename in single-workspace mode"); })()
    : path.join(dataRoot(), tenant, WORKSPACES, to);
  if (fs.existsSync(dest)) throw new Error(`workspace ${to} already exists`);

  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.renameSync(src, dest);

  const agentsMd = path.join(dest, "AGENTS.md");
  if (fs.existsSync(agentsMd)) {
    const raw = fs.readFileSync(agentsMd, "utf8");
    fs.writeFileSync(agentsMd, raw.replace(/^name:.*$/m, `name: ${to}`));
  }
}

/** Set a workspace's description, in AGENTS.md, without touching anything else. */
export function setWorkspaceDescription(tenant: string, workspace: string, description: string) {
  const file = path.join(workspaceDir(tenant, workspace), "AGENTS.md");
  if (!fs.existsSync(file)) throw new Error("this workspace has no AGENTS.md");

  const raw = fs.readFileSync(file, "utf8");
  const block = raw.match(/^(---\r?\n)([\s\S]*?)(\r?\n---)/);
  if (!block) throw new Error("AGENTS.md has no frontmatter");

  const [, open, body, close] = block;
  const lines = body.split("\n");
  const at = lines.findIndex((l) => /^description:/.test(l));
  const line = `description: ${description}`;
  if (at === -1) lines.push(line);
  else lines[at] = line;

  fs.writeFileSync(file, raw.replace(open + body + close, open + lines.join("\n") + close));
}

/**
 * Starter files for "+ New workspace" in the dashboard.
 *
 * Kept as a name because the API route and its callers use it; the content
 * lives in starter.ts so this and `foldrun init` cannot drift. They did:
 * this copy still said `type: Agent` after the CLI's had moved to `kind:`,
 * so every workspace made from the dashboard was born in the old format.
 */
export function templateFiles(workspace: string): DeployFile[] {
  // The starter minus what only matters on a laptop's disk: .gitignore
  // guards a local clone's secrets, but the hosted store never keeps
  // secrets in the tree and saveWorkspace rightly refuses files outside
  // the workspace's own vocabulary.
  return starterFiles(workspace).filter((f) => f.path === "AGENTS.md" || IN_WORKSPACE_DIR.test(f.path));
}

// Kept as names because routes import them; the content lives in KINDS, which
// is the single table every creation path reads.
export const AGENT_TEMPLATE = (name: string) => KINDS.agents.template(name);
export const FLOW_TEMPLATE = (name: string, firstAgent: string) =>
  KINDS.flows.template(name, { firstAgent });

// The orchestration patterns a new flow can start from. Each template ships
// the pattern's syntax filled in with real agent names, because a working
// example in your own workspace teaches loop:/until:/each: better than any
// reference page — you rename the instructions, not learn the shape.
export const FLOW_PATTERNS = ["pipeline", "review-loop", "fan-out", "debate", "router"] as const;
export type FlowPattern = (typeof FLOW_PATTERNS)[number];

export function flowPatternTemplate(pattern: FlowPattern, name: string, agents: string[]): string {
  // Real agents where they exist, honest placeholders where they don't —
  // `foldrun check` will point at any placeholder left unrenamed.
  const a = (i: number, fallback: string) => agents[i] ?? agents[0] ?? fallback;
  const head = `---\nname: ${name}\n---\n\n`;
  switch (pattern) {
    case "review-loop":
      return (
        head +
        `1. [[${a(0, "writer")}]] — draft the deliverable\n` +
        `2. [[${a(1, "reviewer")}]] — review it against the brief; end your reply with APPROVED when it is ready\n` +
        `   loop: 3\n` +
        `   until: APPROVED\n`
      );
    case "fan-out":
      return (
        head +
        `1. [[${a(0, "lister")}]] — list the items to process, one per line\n` +
        `2. [[${a(1, "worker")}]] — handle this one item\n` +
        `   each: lines\n` +
        `   max: 10\n` +
        `3. [[${a(2, "summariser")}]] — pull every result into one summary\n`
      );
    case "router":
      return (
        head +
        `1. [[${a(0, "classifier")}]] — classify the request: reply with exactly one word, BUG or QUESTION\n` +
        `2. [[${a(1, "debugger")}]] — investigate and fix the bug\n` +
        `   case: BUG\n` +
        `2. [[${a(2, "writer")}]] — answer the question clearly\n` +
        `   case: QUESTION\n` +
        `2. [[${a(3, "triager")}]] — neither label fit; say what is missing\n` +
        `   else: true\n`
      );
    case "debate":
      return (
        head +
        `1. [[${a(0, "researcher")}]] — gather the facts\n` +
        `2. [[${a(1, "advocate")}]] — argue the strongest case for, from the facts\n` +
        `2. [[${a(2, "skeptic")}]] — argue the strongest case against, from the facts\n` +
        `3. [[${a(3, "judge")}]] — weigh both cases and give a verdict\n`
      );
    default:
      return FLOW_TEMPLATE(name, a(0, "my-agent"));
  }
}

export interface RunEvent {
  t: string;
  type: "text" | "tool" | "error" | "info";
  text: string;
}

export interface StepRecord {
  agent: string;
  instruction: string;
  group: number;
  optional: boolean;
  /** Carried from the flow — see FlowStep. Both are resolved at run
   *  time rather than stored resolved, so a record stays readable as
   *  what its author wrote. */
  model?: string;
  effort?: string;
  approve?: boolean;
  when?: string;
  case?: string;
  else?: boolean;
  retry?: number;
  timeout?: number;
  verify?: string;
  /** Attempts made so far, for the run trace. */
  attempts?: number;
  /** Why a step was skipped, shown in the trace. */
  skipReason?: string;
  /** Evaluator loop, carried from the flow — see FlowStep. `loopRemaining`
   *  counts down on the record so a resumed run knows how many cycles are
   *  left rather than starting the budget over. */
  loop?: number;
  until?: string;
  loopRemaining?: number;
  /** Fan-out, carried from the flow — see FlowStep. */
  each?: "lines" | "rows";
  eachPath?: string;
  max?: number;
  /** Set on the instances a fan-out step expanded into: the item this one
   *  works on. The template step itself becomes status "expanded". */
  item?: string;
  /** Carried from the flow — see FlowStep for each. */
  onFail?: string;
  waitSecs?: number;
  /** Stamped when the run reaches the step; the queue holds it until then.
   *  On the record so a restart resumes the same deadline, not a new one. */
  waitUntil?: string;
  ask?: string;
  delegate?: string[];
  /** Set once a delegate step's picks have been expanded — the guard that
   *  a loop rewind cannot fan the same choice out twice. */
  delegated?: boolean;
  /**
   * When a person approved this step. Set by the approval API and never
   * cleared, because approval is a fact about the past.
   *
   * Status alone cannot carry it: approving flips the step back to `pending`,
   * which is indistinguishable from never having been asked. A run that was
   * approved and then abandoned could not be resumed without asking the same
   * person the same question again.
   */
  approvedAt?: string;
  /** What the approver said while approving — carried into the step's prompt
   *  as operator guidance. This turns the gate from a yes/no button into a
   *  place to steer: "approve, but skip the Sydney batch". */
  approvalNote?: string;
  status:
    | "pending"
    | "awaiting-approval"
    | "running"
    | "completed"
    | "failed"
    | "skipped";
  events: RunEvent[];
  result: string | null;
  costUsd: number | null;
  /** Set on steps copied into a re-run from an earlier run: the run they
   *  actually executed in. Carried steps provide context and are never
   *  billed again — the original run's ledger line already paid for them. */
  carriedFrom?: string;
  /**
   * Sandbox seconds this step rented, and how many of them were cold start.
   * Set only on the isolated path — an in-process step rents nothing, so
   * `null` is the honest value and billing must read it as zero, not as
   * "unknown, charge something".
   *
   * Wall time is deliberately not a substitute: a step parked at an approval
   * gate has no pod, and billing a customer for a person taking the weekend
   * to click approve is charging them for their own deliberation.
   */
  computeSecs?: number | null;
  startupSecs?: number | null;
  /** Which reservation class the sandbox held (small | large), and the
   *  actual limits it held, as numbers. Facts of the step: a price is per
   *  core-second, so what was reserved must come from the record, never
   *  from what the config says when the bill is computed. Absent on steps
   *  from before sizes existed — billing falls back to the flat rate. */
  size?: "small" | "large" | "heavy";
  reserved?: { cpus: number; memGiB: number } | null;
  /** Token counts behind costUsd, kept so usage reports can say "how many"
   *  and not only "how much" — the price of a token changes, the count is
   *  the fact. Absent on steps recorded before this existed. */
  tokens?: { input: number; output: number } | null;
  /** What the sandbox actually touched, against what it reserved: CPU
   *  busy-seconds and peak memory from the pod's own cgroup, bytes on the
   *  wire from /proc/net/dev. Null per-field where the kernel interface
   *  wasn't readable in the sandbox — never estimated. */
  actual?: {
    busyCpuSecs: number | null;
    peakMemBytes: number | null;
    rxBytes: number | null;
    txBytes: number | null;
  } | null;
}

export interface RunRecord {
  id: string;
  flow: string; // flow name, or "adhoc:<agent>" for direct agent runs
  /** Tags supplied when the run started — skills can require one. */
  tags?: string[];
  status: "queued" | "running" | "awaiting-approval" | "completed" | "failed";
  startedAt: string;
  finishedAt: string | null;
  /** Set when a worker parked this run at an approval gate and returned its
   *  slot to the queue. The approval API re-enqueues exactly when this is
   *  set — without the marker it would also re-enqueue runs whose starting
   *  process is still alive and polling, and two drivers would race. */
  parkedAt?: string | null;
  /** Set when a person stopped this run. Kept on the record rather than
   *  expressed only as a status, because "failed" and "someone stopped it"
   *  are different facts and the trace should not conflate them. */
  stopRequested?: boolean;
  steps: StepRecord[];
}

export function runFilePath(tenant: string, workspace: string, runId: string) {
  assertSafeName(runId, "run id");
  return path.join(workspaceDir(tenant, workspace), "runs", `${runId}.json`);
}

/**
 * Erase a run from history: its record and the outputs archived under its
 * id.
 *
 * The ledger line stays, and that is settled rather than provisional: if
 * deleting a run voided its charge, deletion would be a refund button — run
 * the expensive extraction, read the result, delete, never pay. Money is
 * not deleted because a trace was.
 *
 * What deletion *does* owe the books is an explanation. A charge pointing
 * at a run that no longer exists reads as unexplained forever, so the
 * deletion writes itself down: a zero-value adjustment naming the run, on
 * the same append-only file the charge lives in. The balance is untouched;
 * the story is complete.
 */
export function deleteRun(tenant: string, workspace: string, runId: string): boolean {
  const file = runFilePath(tenant, workspace, runId);
  if (!fs.existsSync(file)) return false;
  fs.rmSync(file, { force: true });
  fs.rmSync(path.join(workspaceDir(tenant, workspace), "runs", runId), {
    recursive: true,
    force: true,
  });
  onRunDeleted?.(tenant, workspace, runId);
  return true;
}

/** ledger.ts registers here — store cannot import it without a cycle, and
 *  money must not depend on one. */
let onRunDeleted: ((tenant: string, workspace: string, runId: string) => void) | undefined;
export function registerRunDeletionListener(fn: typeof onRunDeleted) {
  onRunDeleted = fn;
}

export function readRun(tenant: string, workspace: string, runId: string): RunRecord | null {
  const p = runFilePath(tenant, workspace, runId);
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf8")) : null;
}

export function writeRun(tenant: string, workspace: string, run: RunRecord) {
  const p = runFilePath(tenant, workspace, run.id);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  // Atomic write — runs are re-read while running (dashboard polls, CLI
  // tails), and a plain writeFileSync can be caught half-written.
  const tmp = `${p}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(run, null, 2));
  fs.renameSync(tmp, p);
}

// Every run in an account, each tagged with the workspace it belongs to —
// the observability surface.
export interface RunWithWorkspace extends RunRecord {
  workspace: string;
}

export function listAllRuns(tenant: string): RunWithWorkspace[] {
  return listWorkspaces(tenant)
    .flatMap((p) => listRuns(tenant, p.name).map((r) => ({ ...r, workspace: p.name })))
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

/**
 * The status a person should see. "failed" and "someone stopped it" are
 * different facts — the record keeps them apart (stopRequested), and the
 * display must too: a run a person chose to end is not a run that broke,
 * and showing it red teaches people that stopping things is dangerous.
 */
export function runDisplayStatus(run: Pick<RunRecord, "status" | "stopRequested">): string {
  return run.status === "failed" && run.stopRequested ? "stopped" : run.status;
}

export function runCost(run: RunRecord): number {
  return run.steps.reduce((sum, s) => sum + (s.costUsd ?? 0), 0);
}

/**
 * What a finished run consumed, in the units the format itself has — the
 * shape ledger.ts prices. Structural, not an import, because ledger.ts
 * imports this module and money must not depend on a cycle.
 *
 * Only steps that actually ran count. A pending step never happened, a
 * skipped one was skipped by the flow's own `when`, and an `expanded`
 * fan-out template is a row in the trace rather than work — billing any of
 * them would charge for steps the customer can see never executed, which is
 * the fastest way to lose an argument about an invoice.
 */
export function runMeter(run: RunRecord): {
  tokenCostUsd: number;
  steps: number;
  computeSecs: number;
  /** The subset of computeSecs held at the small reservation. Steps from
   *  before sizes existed count as large — they held the large limits. */
  smallSecs: number;
  netBytes: number;
} {
  let steps = 0;
  let computeSecs = 0;
  let smallSecs = 0;
  let netBytes = 0;
  for (const s of run.steps) {
    if (s.status !== "completed" && s.status !== "failed") continue;
    // A carried step ran — and was billed — in the run it was carried from.
    if (s.carriedFrom) continue;
    steps += 1;
    const secs = s.computeSecs ?? 0;
    computeSecs += secs;
    if (s.size === "small") smallSecs += secs;
    netBytes += (s.actual?.rxBytes ?? 0) + (s.actual?.txBytes ?? 0);
  }
  return { tokenCostUsd: runCost(run), steps, computeSecs, smallSecs, netBytes };
}

/**
 * The compute meter for hold+work pricing: core-seconds and GiB-seconds
 * actually reserved (from each step's own recorded reservation), and CPU
 * seconds actually burned (from the sandbox's cgroup, where readable).
 * Steps with no recorded reservation contribute plain seconds only — the
 * flat-rate fallback prices those.
 */
export function runComputeMeter(run: RunRecord): {
  coreSecs: number;
  gibSecs: number;
  busyCpuSecs: number;
  flatSecs: number;
} {
  let coreSecs = 0, gibSecs = 0, busyCpuSecs = 0, flatSecs = 0;
  for (const s of run.steps) {
    if (s.status !== "completed" && s.status !== "failed") continue;
    if (s.carriedFrom) continue;
    const secs = s.computeSecs ?? 0;
    if (secs <= 0) continue;
    if (s.reserved) {
      coreSecs += secs * s.reserved.cpus;
      gibSecs += secs * s.reserved.memGiB;
    } else {
      flatSecs += secs;
    }
    busyCpuSecs += s.actual?.busyCpuSecs ?? 0;
  }
  return { coreSecs, gibSecs, busyCpuSecs, flatSecs };
}

export function runDurationSecs(run: RunRecord): number | null {
  if (!run.finishedAt) return null;
  return (new Date(run.finishedAt).getTime() - new Date(run.startedAt).getTime()) / 1000;
}

/**
 * Why a failed run failed, said in one line: the failing step and its last
 * error event. The journal has the whole story; a runs *list* needs the
 * sentence — "failed" with no reason makes every diagnosis start by opening
 * the run, and the answer was sitting in the record all along.
 */
export function runFailure(run: RunRecord): { agent: string; reason: string } | null {
  if (run.status !== "failed") return null;
  const step = run.steps.find((s) => s.status === "failed");
  if (!step) return null;
  const errors = step.events.filter((e) => e.type === "error");
  const last = errors[errors.length - 1];
  return { agent: step.agent, reason: last?.text ?? "failed without an error event" };
}

export function listRuns(tenant: string, workspace: string): RunRecord[] {
  const dir = path.join(workspaceDir(tenant, workspace), "runs");
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")) as RunRecord)
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

// ------------------------------------------------------------------ provider

/**
 * `provider:` — which endpoint the model calls run against, and the two
 * knobs that make a non-Anthropic gateway usable rather than merely
 * reachable.
 *
 *   provider:
 *     base_url: https://openrouter.ai/api
 *     token: ${OPENROUTER_API_KEY}
 *     models:
 *       fast: google/gemini-2.5-flash
 *       max: anthropic/claude-opus-4.1
 *     headers:
 *       X-Title: foldrun
 *
 * `models:` is what makes tiers portable rather than merely renamed-proof:
 * without it `model: fast` means the literal string "haiku" on every
 * endpoint, which is only true on one of them. `headers:` is the escape
 * hatch for whatever a gateway wants that our schema will never have —
 * routing preferences, attribution, tags. Both are the gateway's business,
 * so neither grows a per-vendor branch in here.
 */
export interface ProviderSpec {
  baseUrl: string;
  /** May still contain `${SECRET}` — resolving needs a tenant. */
  token: string;
  /** Tier → the id this gateway calls that tier. Absent tiers keep ours. */
  models: Partial<Record<Tier, string>>;
  /** Header name → value; values may contain `${SECRET}`. */
  headers: Record<string, string>;
  /** Things wrong enough to say out loud but not to fail a run over. */
  warnings: string[];
}

// RFC 9110 field-name characters. Anything else is not a header, and a
// gateway would reject it — better to say so here than to have the run fail
// with someone else's error message.
const HEADER_NAME_RE = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;

export function parseProvider(raw: unknown): ProviderSpec | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const block = raw as Record<string, unknown>;
  const warnings: string[] = [];

  const baseUrl = typeof block.base_url === "string" ? block.base_url.trim() : "";
  const token = typeof block.token === "string" ? block.token.trim() : "";

  const models: Partial<Record<Tier, string>> = {};
  if (block.models && typeof block.models === "object" && !Array.isArray(block.models)) {
    for (const [key, value] of Object.entries(block.models as Record<string, unknown>)) {
      const tier = resolveTier(key);
      if (!tier) {
        warnings.push(
          `provider.models: "${key}" is not a tier — use ${Object.keys(MODEL_TIERS).join(", ")}. Ignored.`,
        );
        continue;
      }
      const id = typeof value === "string" ? value.trim() : "";
      if (!id) {
        warnings.push(`provider.models.${key}: empty — ignored`);
        continue;
      }
      models[tier] = id;
    }
  } else if (block.models !== undefined) {
    warnings.push("provider.models: expected a map of tier → model id — ignored");
  }

  const headers: Record<string, string> = {};
  if (block.headers && typeof block.headers === "object" && !Array.isArray(block.headers)) {
    for (const [name, value] of Object.entries(block.headers as Record<string, unknown>)) {
      const key = name.trim();
      if (!HEADER_NAME_RE.test(key)) {
        warnings.push(`provider.headers: "${name}" is not a valid header name — ignored`);
        continue;
      }
      const text = value == null ? "" : String(value);
      // A newline in a value would end the header and start another one —
      // the whole point of a separator-delimited blob is that nothing in it
      // may contain the separator.
      if (/[\r\n]/.test(text)) {
        warnings.push(`provider.headers.${key}: value contains a line break — ignored`);
        continue;
      }
      headers[key] = text.trim();
    }
  } else if (block.headers !== undefined) {
    warnings.push("provider.headers: expected a map of name → value — ignored");
  }

  return { baseUrl, token, models, headers, warnings };
}

/** The env the SDK reads for a tier remap. Our tier names are ours; these
 *  are the SDK's, and this function is the only place the two meet. */
const TIER_ENV: Record<Tier, string> = {
  fast: "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  default: "ANTHROPIC_DEFAULT_SONNET_MODEL",
  max: "ANTHROPIC_DEFAULT_OPUS_MODEL",
};

/**
 * The whole of a provider block as the env the Agent SDK reads. The one
 * place our format meets the SDK's, so the mapping is testable without a
 * vault: the caller resolves `${SECRET}` first and passes values.
 *
 * The token goes to ANTHROPIC_AUTH_TOKEN (a bearer credential) and
 * ANTHROPIC_API_KEY is explicitly blanked. Both matter. A key left in the
 * environment is sent as `x-api-key` and treated as a direct-Anthropic
 * credential, so a gateway that wants `Authorization: Bearer` gets the
 * wrong header — and worse, an *unset* key lets the SDK fall back to
 * authenticating against Anthropic directly, which fails somewhere far from
 * the file that caused it. A gateway that genuinely wants the key header
 * asks for it by name: `headers: { x-api-key: ${TOKEN} }`.
 */
export function providerEnvFor(spec: {
  baseUrl?: string;
  /** Already secret-substituted. */
  token?: string;
  models: Partial<Record<Tier, string>>;
  headers: Record<string, string>;
}): Record<string, string> {
  const env: Record<string, string> = {};
  if (spec.baseUrl) env.ANTHROPIC_BASE_URL = spec.baseUrl;
  if (spec.token) {
    env.ANTHROPIC_AUTH_TOKEN = spec.token;
    env.ANTHROPIC_API_KEY = "";
  }
  for (const [tier, id] of Object.entries(spec.models)) {
    if (id) env[TIER_ENV[tier as Tier]] = id;
  }
  const lines = Object.entries(spec.headers).map(([k, v]) => `${k}: ${v}`);
  if (lines.length) env.ANTHROPIC_CUSTOM_HEADERS = lines.join("\n");
  return env;
}
