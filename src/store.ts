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
import { readBundle, syncIndex, appendLog, ensureMemoryType, provenanceMarks } from "./okf.ts";
import { readTransport, KINDS } from "./kinds.ts";
import { starterFiles } from "./starter.ts";

// Where workspaces live. The hosted app keeps many under data/; the CLI runs
// against one folder, which is what `mdagent run ./my-desk` has to mean.

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

export interface DeployFile {
  path: string;
  content: string;
}

// Files whose names are part of a standard, and must be spelled exactly.
// AGENTS.md is the Linux Foundation convention; SKILL.md is the Agent Skills
// standard; MEMORY.md is ours. Case-insensitive filesystems (macOS, Windows)
// happily accept `Skill.md` locally and then it vanishes on a Linux runtime —
// so the wrong case is rejected here, loudly, with the right spelling.
const CANONICAL = ["AGENTS.md", "SKILL.md", "MEMORY.md"];

/**
 * The format version this build understands.
 *
 * A workspace declares what it targets with `mdagent_version` in AGENTS.md.
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
        `this workspace targets mdagent format ${value}, and this build understands ` +
        `${FORMAT_VERSION}. A different major version may mean different behaviour — ` +
        `read it as best-effort rather than correct.`,
    };
  }
  if (Number(minor) > Number(okMinor)) {
    return {
      declared: value,
      supported: FORMAT_VERSION,
      warning:
        `this workspace targets mdagent format ${value}; this build understands ` +
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

  // A deploy replaces the workspace, but it must not destroy what it never
  // owned. Git is authoritative for the files it ships; the platform owns
  // everything an agent produced at run time. So:
  //
  //   runs/            always kept — the audit trail
  //   state/           always kept — what an agent carries between runs
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
    /(^|\/)runs\//.test(rel) ||
    /(^|\/)state\//.test(rel) ||
    // Secrets are never in git — a deploy has no business deleting them, and
    // doing so silently breaks every agent that declared one.
    rel === "secrets.json" ||
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

  return { preserved: preserved.length };
}

// The prompt-facing index for an OKF bundle (memory/ or knowledge/).
//
// The on-disk artifact is index.md, written by syncIndex and conformant with
// the spec. This builds the same listing with paths the agent can actually
// open, plus the v0.2 signals that change how a fact should be treated: a
// stale price list or an unverified claim should not read like a confirmed
// one. A hand-written MEMORY.md is still honoured and placed first, so a
// curated preamble survives.
export function buildMemoryIndex(dir: string, prefix = ""): string | null {
  if (!fs.existsSync(dir)) return null;

  // Body only. MEMORY.md needs a `type:` to be conformant — it is not one of
  // OKF's two reserved names, so a consumer reads it as a concept — and this
  // preamble goes straight into an agent's context, where a raw `---` block
  // would be four lines of YAML the model has to sit through and might answer.
  const curated = path.join(dir, "MEMORY.md");
  const preamble = fs.existsSync(curated)
    ? matter(fs.readFileSync(curated, "utf8")).content.trim()
    : "";

  const lines: string[] = [];
  for (const doc of readBundle(dir)) {
    if (preamble.includes(doc.file)) continue; // already curated above
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

  const generated = lines.join("\n");
  if (!preamble && !generated) return null;
  return [preamble, generated].filter(Boolean).join("\n");
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

export function parseToolDef(data: Record<string, unknown>, fallbackName: string): ToolDef | null {
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
    if (typeof data.run !== "string") return null;
    return { kind: "script", name, spec: { ...data, name } };
  }
  const [spec] = parseApis([{ ...data, name }]);
  return spec ? { kind: "http", name, spec } : null;
}

function readToolDir(dir: string): Record<string, ToolDef> {
  if (!fs.existsSync(dir)) return {};
  const out: Record<string, ToolDef> = {};
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith(".md"))) {
    try {
      const { data } = matter(fs.readFileSync(path.join(dir, file), "utf8"));
      const def = parseToolDef(data as Record<string, unknown>, file.replace(/\.md$/, ""));
      if (def) out[def.name] = def;
    } catch {
      // skip malformed definitions rather than failing every run
    }
  }
  return out;
}

export function workspaceTools(tenant: string, workspace: string): Record<string, ToolDef> {
  return readToolDir(path.join(workspaceDir(tenant, workspace), "tools"));
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

export function resolveModel(value: unknown): string {
  const raw = typeof value === "string" && value.trim() ? value.trim() : "default";
  if (raw in MODEL_TIERS) return MODEL_TIERS[raw];
  return raw; // "opus" | "sonnet" | "haiku" | "claude-opus-5" | …
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
  /** Pause for a human before running this step. */
  approve?: boolean;
  /** Run only if the previous results contain this text (case-insensitive). */
  when?: string;
  /** Attempts on failure, beyond the first. */
  retry?: number;
  /** Abandon the step after this many seconds. */
  timeout?: number;
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
  /** Overrides every step's agent model for this flow only. */
  model: string | null;
  steps: FlowStep[];
}

// Skills and memory files belonging to one agent — for the graph view and
// [[ ]] autocomplete.
export interface AgentAssets {
  skills: string[]; // skill names (frontmatter name or filename)
  memory: string[]; // memory file names under memory/, excluding MEMORY.md
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
      if (f.endsWith(".md") && f !== "MEMORY.md") memory.push(nameOf(path.join(memoryDir, f), f.replace(/\.md$/, "")));
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

const OPTION_RE = /^\s+([a-z]+):\s*(.+)$/;

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
      else if (key === "retry") step.retry = Math.min(5, Math.max(0, Number(value) || 0));
      else if (key === "timeout") step.timeout = Math.max(1, Number(value) || 0);
      else if (key === "verify") step.verify = value;
      else if (key === "model") step.model = value;
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
    steps,
  };
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
      // had before. Reading only the old one is why every workspace showed
      // "No description" after the rename.
      let description = "";
      for (const file of ["AGENTS.md", "project.md"]) {
        const p = path.join(pDir, file);
        if (!fs.existsSync(p)) continue;
        try {
          description = matter(fs.readFileSync(p, "utf8")).data.description ?? "";
        } catch {
          description = "";
        }
        break;
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
const SCRIPT_EXT = /\.(py|sh|js|ts|rb|sql|txt|json|ya?ml|toml|env|md)$/i;

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
    // state/ is the one place holding data rather than prose.
    const isState = /^state\//.test(rel) && /\.(json|ya?ml|txt)$/.test(rel);
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
  fs.writeFileSync(p, content);
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
  // Before the index, so a MEMORY.md written moments ago is conformant by the
  // time anything reads or exports the bundle.
  ensureMemoryType(dir);
  syncIndex(dir, kind === "memory" ? "Memory" : "Knowledge", isRoot);
  if (change) {
    appendLog(dir, path.relative(dir, file).split(path.sep).join("/"), change);
  }
}

export function deleteWorkspacePath(tenant: string, workspace: string, rel: string) {
  const norm = path.normalize(rel);
  if (norm.startsWith("..") || path.isAbsolute(norm)) throw new Error(`illegal path: ${rel}`);
  const dir = workspaceDir(tenant, workspace);
  // Whole agent (agents/<name>) or a single editable .md file.
  if (/^agents\/[a-z0-9-]+$/.test(norm)) {
    fs.rmSync(path.join(dir, norm), { recursive: true, force: true });
    return;
  }
  fs.rmSync(path.join(dir, assertEditablePath(norm)), { force: true });
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
 * lives in starter.ts so this and `mdagent init` cannot drift. They did:
 * this copy still said `type: Agent` after the CLI's had moved to `kind:`,
 * so every workspace made from the dashboard was born in the old format.
 */
export function templateFiles(workspace: string): DeployFile[] {
  return starterFiles(workspace);
}

// Kept as names because routes import them; the content lives in KINDS, which
// is the single table every creation path reads.
export const AGENT_TEMPLATE = (name: string) => KINDS.agents.template(name);
export const FLOW_TEMPLATE = (name: string, firstAgent: string) =>
  KINDS.flows.template(name, { firstAgent });

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
  approve?: boolean;
  when?: string;
  retry?: number;
  timeout?: number;
  verify?: string;
  /** Attempts made so far, for the run trace. */
  attempts?: number;
  /** Why a step was skipped, shown in the trace. */
  skipReason?: string;
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
}

export interface RunRecord {
  id: string;
  flow: string; // flow name, or "adhoc:<agent>" for direct agent runs
  /** Tags supplied when the run started — skills can require one. */
  tags?: string[];
  status: "running" | "awaiting-approval" | "completed" | "failed";
  startedAt: string;
  finishedAt: string | null;
  steps: StepRecord[];
}

export function runFilePath(tenant: string, workspace: string, runId: string) {
  assertSafeName(runId, "run id");
  return path.join(workspaceDir(tenant, workspace), "runs", `${runId}.json`);
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

export function runCost(run: RunRecord): number {
  return run.steps.reduce((sum, s) => sum + (s.costUsd ?? 0), 0);
}

export function runDurationSecs(run: RunRecord): number | null {
  if (!run.finishedAt) return null;
  return (new Date(run.finishedAt).getTime() - new Date(run.startedAt).getTime()) / 1000;
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
