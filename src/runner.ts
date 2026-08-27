// Flow orchestration. Steps sharing a group number run in parallel; the next
// group receives every prior result, labeled per agent. Optional steps ("2?")
// fail without failing the flow. A direct agent run is a one-step ad-hoc
// flow, so there is a single execution path.

import fs from "node:fs";
import path from "node:path";
import matter from "gray-matter";
import { spawn } from "node:child_process";
import { executeStep } from "./step-exec.ts";
import { runStepInContainer, sizeLimits } from "./run-container.ts";
import { runStepInK8s } from "./run-k8s.ts";
import { gatherConsults, buildConsultTools } from "./agent-tools.ts";
import {
  accountDir,
  workspaceDir,
  buildMemoryIndex,
  workspaceMemoryIndex,
  knowledgeIndex,
  workspaceKnowledgeIndex,
  workspaceTools,
  brokenToolReport,
  listWorkspaces,
  listTenants,
  listRuns,
  syncBundleFor,
  parseToolDef,
  parseFlow,
  parseApis,
  resolveModel,
  parseProvider,
  providerEnvFor,
  resolveEffort,
  isEffortWord,
  EFFORT_LEVELS,
  checkFormatVersion,
  readRun,
  writeRun,
  type FlowStep,
  type McpSpec,
  type RunRecord,
  type StepRecord,
} from "./store.ts";
import { loadCatalog, checkModel, clampEffort, catalogCost, type Catalog } from "./catalog.ts";
import { resolveSecrets, getSecret, materializeSecrets } from "./secrets.ts";
import { materializeFileSecrets, cleanupFileSecrets } from "./secret-files.ts";
import { buildApiTools, secretsUsedByApi } from "./api-tools.ts";
import { buildScriptTools, parseScripts, type ExecutionContext } from "./script-tools.ts";
import { libraryDir, libraryTools, libraryMemoryIndex } from "./library.ts";
import { parseRuntime, prepareRuntime } from "./runtime.ts";
import { materializeFiles, harvestFiles } from "./files.ts";
import { chooseExecutor, ensureImage } from "./container.ts";
import { stampBundle } from "./okf.ts";
import type { McpServerConfig } from "@anthropic-ai/claude-agent-sdk";

// An MCP tool definition becomes an SDK server config. ${SECRET} placeholders
// in env and headers resolve server-side, so a credential reaches the server
// process without ever entering the model's context.
function mcpConfig(spec: McpSpec, tenant: string, workspace: string): McpServerConfig {
  const fill = (values: Record<string, string>) => {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(values)) {
      out[k] = v.replace(/\$\{([A-Z][A-Z0-9_]*)\}/g, (whole, secretName) => {
        const hit = getSecret(tenant, secretName, workspace);
        return hit ? hit.value : whole;
      });
    }
    return out;
  };
  // alwaysLoad: the SDK defers MCP tools behind tool search by default, which
  // hides them from an agent whose toolset we've already narrowed. A server
  // the author explicitly granted should be present from turn one.
  return spec.url
    ? { type: "http", url: spec.url, headers: fill(spec.headers), alwaysLoad: true }
    : {
        type: "stdio",
        command: spec.command!,
        args: spec.args,
        env: fill(spec.env),
        alwaysLoad: true,
      };
}

// Exact SDK tool names, accepted alongside our group aliases so a Claude Code
// subagent's `tools: Read, Grep` works unchanged. The aliases exist because
// vendors rename tools; `web` survives a rename that `WebSearch` would not.
const BUILTIN_TOOLS = new Set([
  "Read", "Write", "Edit", "MultiEdit", "Glob", "Grep", "Bash",
  "WebSearch", "WebFetch", "NotebookEdit", "TodoWrite",
]);

const TOOL_MAP: Record<string, string[]> = {
  web: ["WebSearch", "WebFetch"],
  // `read` is deliberately separate from `files`: an agent that may inspect a
  // repository but must never modify it is a real and common design.
  read: ["Read", "Glob", "Grep"],
  files: ["Read", "Write", "Edit", "Glob", "Grep"],
  bash: ["Bash"],
};

export interface DiscoveredSkill {
  name: string;
  description: string;
  /** Tags that must be present on the run for this skill to load. A skill
   *  with none always loads. Mirrors "apply when this check failed". */
  when: string[];
  /** Path to SKILL.md (or the flat .md), relative to the agent directory. */
  path: string;
  /** Skill folder relative to the agent directory, or null for flat skills. */
  dir: string | null;
  hasScripts: boolean;
  /** The rest of the Agent Skills layout: references/ and assets/. */
  hasReferences: boolean;
  hasAssets: boolean;
}

const toTags = (v: unknown): string[] =>
  Array.isArray(v) ? v.map(String) : typeof v === "string" && v.trim() ? [v.trim()] : [];

// Both layouts: skills/<name>/SKILL.md (Agent Skills standard) and the
// flat skills/<name>.md convenience form.
export function discoverSkills(agentDir: string): DiscoveredSkill[] {
  const skillsDir = path.join(agentDir, "skills");
  if (!fs.existsSync(skillsDir)) return [];
  const out: DiscoveredSkill[] = [];

  for (const entry of fs.readdirSync(skillsDir).sort()) {
    const full = path.join(skillsDir, entry);
    const stat = fs.statSync(full);

    if (stat.isDirectory()) {
      const skillMd = path.join(full, "SKILL.md");
      if (!fs.existsSync(skillMd)) continue;
      const { data } = matter(fs.readFileSync(skillMd, "utf8"));
      out.push({
        name: data.name ?? entry,
        description: data.description ?? "",
        when: toTags(data.when),
        path: `skills/${entry}/SKILL.md`,
        dir: `skills/${entry}`,
        hasScripts: fs.existsSync(path.join(full, "scripts")),
        hasReferences: fs.existsSync(path.join(full, "references")),
        hasAssets: fs.existsSync(path.join(full, "assets")),
      });
    } else if (entry.endsWith(".md")) {
      const { data } = matter(fs.readFileSync(full, "utf8"));
      out.push({
        name: data.name ?? entry.replace(/\.md$/, ""),
        description: data.description ?? "",
        when: toTags(data.when),
        path: `skills/${entry}`,
        dir: null,
        hasScripts: false,
        hasReferences: false,
        hasAssets: false,
      });
    }
  }
  return out;
}

/**
 * AGENTS.md, at both scopes it can live at.
 *
 * `AGENTS.md` is the Linux Foundation name; `project.md` is still read so
 * nothing written before the rename breaks.
 *
 * Returns null rather than throwing on unparseable YAML: a broken shared file
 * must not take down every agent under it.
 */
export function readAgentsMd(dir: string): { data: Record<string, unknown>; body: string } | null {
  for (const name of ["AGENTS.md", "project.md"]) {
    const file = path.join(dir, name);
    if (!fs.existsSync(file)) continue;
    try {
      const parsed = matter(fs.readFileSync(file, "utf8"));
      return { data: parsed.data as Record<string, unknown>, body: parsed.content.trim() };
    } catch {
      return null;
    }
  }
  return null;
}

const workspaceRootOf = (agentDir: string) => path.join(agentDir, "..", "..");

/**
 * Configuration from AGENTS.md, nearest-wins: the workspace's overrides the
 * account's, key by key.
 *
 * Config overrides and prose accumulates — see sharedInstructions. A workspace
 * naming its own `provider:` means *instead of* the account's; a workspace
 * writing instructions means *as well as*, because an account rule nobody can
 * silently drop is the point of having one.
 */
function workspaceFrontmatter(agentDir: string, tenant: string): Record<string, unknown> {
  return {
    ...(readAgentsMd(accountDir(tenant))?.data ?? {}),
    ...(readAgentsMd(workspaceRootOf(agentDir))?.data ?? {}),
  };
}

/**
 * The prose from AGENTS.md, outermost first.
 *
 * This was written by every scaffold, shown in the dashboard, described in the
 * template as "context every agent here shares" — and never read. Only the
 * frontmatter was, so the instructions people actually wrote reached no model.
 */
export function sharedInstructions(agentDir: string, tenant: string): string | null {
  const sections = [
    ["Everyone in this account", readAgentsMd(accountDir(tenant))?.body],
    ["Everyone in this workspace", readAgentsMd(workspaceRootOf(agentDir))?.body],
  ].filter(([, body]) => body) as [string, string][];
  if (!sections.length) return null;

  return (
    `# Shared context\n\nThis applies to you in addition to your own instructions ` +
    `above. Where it is more specific than they are, it is not optional.\n\n` +
    sections.map(([label, body]) => `## ${label}\n\n${body}`).join("\n\n")
  );
}

/**
 * Which of an agent's in-scope skills load for this run.
 *
 * Two independent gates: `skills:` in the agent's frontmatter is an allowlist
 * (absent means everything in scope), and a skill's own `when:` names the run
 * tags it is for (absent means every run).
 *
 * Note what an empty `tags` means — a skill with `when:` matches nothing, so
 * an untagged run gets none of them. That is the intent, and it is also why
 * failing to thread the run's tags this far made every `when:` skill
 * permanently invisible instead of conditionally loaded.
 */
export function applicableSkills<T extends { name: string; when: string[] }>(
  skills: T[],
  only: string[],
  tags: string[],
): T[] {
  return skills
    .filter((s) => only.length === 0 || only.includes(s.name))
    .filter((s) => s.when.length === 0 || s.when.some((t) => tags.includes(t)));
}

function agentContext(agentDir: string, tenant: string, tags: string[] = []) {
  // agentDir is <data>/<tenant>/projects/<workspace>/agents/<agent>, so the
  // workspace a secret should resolve against is two levels up.
  const workspace = path.basename(path.resolve(agentDir, "..", ".."));
  const { data: front, content: body } = matter(
    fs.readFileSync(path.join(agentDir, "agent.md"), "utf8"),
  );
  const parts = [body.trim()];

  // Where the agent is standing. Every path below this line is relative to the
  // agent's own directory, and a run showed why that has to be said rather
  // than implied: told to read `../../knowledge/index.md`, the model asked for
  // `/knowledge/index.md` twice before working it out. Two denials and a turn,
  // for want of one sentence.
  parts.push(
    `# Where you are\n\n` +
      `Your working directory is \`agents/${path.basename(agentDir)}/\` inside the ` +
      `\`${workspace}\` workspace. Every path in this prompt is relative to it — ` +
      `\`outputs/\` is yours, and \`../../\` is the workspace root, so the workspace's ` +
      `own knowledge is at \`../../knowledge/\`. Absolute paths are outside the ` +
      `workspace and will be refused.\n\n` +
      // A flow's whole point is that a later step works on what an earlier one
      // produced, and each agent writes to its own outputs/. A run showed what
      // omitting this costs: the checker looked in its own empty outputs/ and
      // reported the draft missing — reviewing nothing, and saying so
      // confidently — while the publisher only found it by guessing at a glob.
      `Each agent writes to its own \`outputs/\`, so a file an earlier step produced is ` +
      `at \`../<that-agent>/outputs/\`, not in yours. If a previous step says it wrote ` +
      `something, look there before concluding it does not exist.\n\n` +
      // The distinction agents kept getting wrong, said where they can read
      // it: outputs/ is working text between steps and never leaves the
      // source tree; files/ is the store the dashboard's Files page lists.
      // A 100-row CSV written to outputs/ is delivered nowhere — a person
      // looking for it in Files finds an empty page and concludes the run
      // produced nothing.
      `\`../../files/\` is the workspace file store: anything you leave there is kept ` +
      `after the run and shown on the Files page for people to download. Write ` +
      `deliverables people asked for — CSVs, reports, PDFs, images — to \`../../files/\`; ` +
      `use \`outputs/\` for working text the next step reads.`,
  );

  // Shared context before anything derived — an account or workspace rule is
  // background the rest of the prompt is read against, not an afterthought.
  const sharedContext = sharedInstructions(agentDir, tenant);
  if (sharedContext) parts.push(sharedContext);

  // Skills follow the open Agent Skills format (agentskills.io): a folder
  // with SKILL.md, optionally bundling its own scripts/ and references/. The
  // flat `skills/<name>.md` form is also accepted for small skills.
  //
  // Progressive disclosure, as the standard prescribes: only each skill's
  // name and description go into context up front. The agent reads the full
  // SKILL.md when a task actually calls for it — so an agent can carry many
  // skills for a few tokens each.
  // Own skills, then the workspace's, then the workspace library — nearest
  // definition of a name wins, so a team default can be overridden locally.
  const skills: DiscoveredSkill[] = [];
  const seenSkills = new Set<string>();
  const addSkills = (dir: string, prefix: string) => {
    for (const skill of discoverSkills(dir)) {
      if (seenSkills.has(skill.name)) continue;
      seenSkills.add(skill.name);
      skills.push({ ...skill, path: `${prefix}${skill.path}`, dir: skill.dir ? `${prefix}${skill.dir}` : null });
    }
  };
  addSkills(agentDir, "");
  addSkills(path.join(agentDir, "..", ".."), "../../"); // the workspace root
  addSkills(path.join(libraryDir(tenant)), "../../../../library/"); // the account library

  // A skill with `when:` only loads when the run carries a matching tag —
  // so an agent with 119 skills costs 119 lines of context only when every
  // one is genuinely relevant.
  // `skills:` is Claude Code's field for naming which skills an agent gets.
  // Absent, an agent inherits every skill in scope — knowledge cascades. Named,
  // it's an allowlist, which is how you keep a focused agent focused.
  const only: string[] = Array.isArray(front.skills) ? front.skills.map(String) : [];
  const applicable = applicableSkills(skills, only, tags);
  const withheld = skills.length - applicable.length;

  if (applicable.length) {
    const lines = applicable.map((s) => {
      // The rest of the Agent Skills layout, named so the agent knows to look
      // rather than guessing that a skill folder holds only SKILL.md.
      const bundles = [
        s.hasScripts && `scripts in \`${s.dir}/scripts/\``,
        s.hasReferences && `reference docs in \`${s.dir}/references/\``,
        s.hasAssets && `assets in \`${s.dir}/assets/\``,
      ].filter(Boolean);
      return (
        `- **${s.name}** — ${s.description || "(no description)"} ` +
        `Full instructions: \`${s.path}\`` +
        (bundles.length ? ` (also bundles ${bundles.join(", ")})` : "")
      );
    });
    parts.push(
      `# Skills\n\nCapabilities available to you. Each line is a summary — when a task matches one, ` +
        `read its file for the full instructions before proceeding:\n\n${lines.join("\n")}` +
        (withheld ? `\n\n(${withheld} further skills exist but do not apply to this run.)` : ""),
    );
  }

  // Memory: the index is loaded every run, and the agent is told how to add
  // to it. Writing is only possible if it has the `files` tool.
  const canWrite = (front.tools ?? []).some(
    (t: unknown) => (typeof t === "string" ? t : Object.keys(t as object)[0]) === "files",
  );
  const memoryDir = path.join(agentDir, "memory");
  const memoryIndex = buildMemoryIndex(memoryDir);
  if (memoryIndex || canWrite) {
    const howTo = canWrite
      ? `\n\nTo remember something durable, write one fact per file to memory/<slug>.md with ` +
        `frontmatter: type (e.g. Fact, Decision, Preference), name and description — these ` +
        `bundles follow the Open Knowledge Format. The index above maintains itself — you do not ` +
        `need to edit it. Read a memory file before relying on it, update an existing file ` +
        `rather than duplicating it, and don't record what this workspace's files already say.`
      : "";
    const projectMem = workspaceMemoryIndex(tenant, workspace);
    const shared = libraryMemoryIndex(tenant);
    parts.push(
      `# Memory — what you have learned\n\n${memoryIndex ? `Your own (files under memory/):\n\n${memoryIndex}` : "You have no memories of your own yet."}` +
        (projectMem ? `\n\nShared across this workspace:\n\n${projectMem}` : "") +
        (shared ? `\n\nShared across every workspace:\n\n${shared}` : "") +
        howTo,
    );
  }

  // Knowledge — reference material the agent was given. Same three scopes and
  // the same nearest-wins reading order as memory, but never written back:
  // an agent that edits the price list it was handed has corrupted its own
  // source of truth.
  const ownKnowledge = knowledgeIndex(path.join(agentDir, "knowledge"), "knowledge/");
  const projectKnowledge = workspaceKnowledgeIndex(tenant, workspace);
  const sharedKnowledge = knowledgeIndex(libraryDir(tenant, "knowledge"), "../../../../library/knowledge/");
  if (ownKnowledge || projectKnowledge || sharedKnowledge) {
    const sections = [
      ownKnowledge && `Your own (files under knowledge/):\n\n${ownKnowledge}`,
      projectKnowledge && `Shared across this workspace:\n\n${projectKnowledge}`,
      sharedKnowledge && `Shared across every workspace:\n\n${sharedKnowledge}`,
    ].filter(Boolean);
    parts.push(
      `# Knowledge — what you were given\n\nReference material. Open a file when a task depends ` +
        `on it rather than guessing at its contents. This is read-only: it is maintained by ` +
        `people, not by you — if you learn something new, write it to memory/ instead.\n\n` +
        sections.join("\n\n"),
    );
  }
  // Scripts an agent can run with bash: its own scripts/, plus the
  // workspace-level shared scripts/ exposed at shared/ in its working dir.
  const listDir = (dir: string, prefix: string) => {
    if (!fs.existsSync(dir)) return [];
    const out: string[] = [];
    for (const entry of fs.readdirSync(dir, { recursive: true })) {
      const rel = String(entry);
      if (fs.statSync(path.join(dir, rel)).isFile()) out.push(`- ${prefix}${rel}`);
    }
    return out.sort();
  };

  const own = listDir(path.join(agentDir, "scripts"), "scripts/");
  const shared = listDir(path.join(agentDir, "..", "..", "scripts"), "../../scripts/");
  // The library's path depends on where this run executes: isolated runs see
  // it at /library, host runs at its real location. Printing the host path
  // into a container's prompt handed the model files it could never open.
  const libraryScriptsRoot =
    process.env.FOLDRUN_RUN_ISOLATION === "container" || process.env.FOLDRUN_RUN_ISOLATION === "k8s"
      ? "/library/scripts"
      : libraryDir(tenant, "scripts");
  const global = listDir(libraryDir(tenant, "scripts"), `${libraryScriptsRoot}/`);

  if (own.length || shared.length || global.length) {
    const sections = [
      own.length ? `Your own scripts:\n${own.join("\n")}` : null,
      shared.length ? `Shared across this workspace:\n${shared.join("\n")}` : null,
      global.length ? `From the account library (read-only):\n${global.join("\n")}` : null,
    ].filter(Boolean);
    parts.push(
      `# Scripts\n\nTooling you can run with bash from your working directory:\n\n${sections.join("\n\n")}\n\n` +
        `Read a script before running it if you are unsure what it does. Credentials your ` +
        `scripts need are already in the environment as the secrets listed below.`,
    );
  }

  // State — data a run carries to the next one. It was a directory in the
  // workspace list, preserved across deploys, and nothing else: never named to
  // an agent, never loaded, never written. A promise with no implementation.
  //
  // Listed rather than inlined, for the same reason knowledge and memory are:
  // an agent that needs a cursor opens it, and one that doesn't shouldn't pay
  // for it. The difference is that state is small enough that inlining would
  // usually be free — that is a threshold worth adding once there is a real
  // file to size it against, not before.
  const state = listDir(path.join(agentDir, "..", "..", "state"), "../../state/");
  if (state.length) {
    parts.push(
      `# State — what you carry between runs\n\n` +
        `What this workspace keeps across runs: a count, a cursor, where you got to. ` +
        `Read and write these directly, and update them before you finish so the next ` +
        `run starts where you left off.\n\n${state.join("\n")}\n\n` +
        `Keep a file in the format it is already in, and write markdown for anything new. ` +
        `A count reads as well in a sentence as in JSON, and a person edits these in the ` +
        `same editor as everything else — data formats are allowed here, not preferred.\n\n` +
        `This is not memory. A fact you learned goes in memory/, where it is indexed and ` +
        `its provenance recorded — state is the bookmark, not the lesson.`,
    );
  }

  // APIs — the agent's own definitions, plus workspace tools it opted into
  // with `use: [name]`. Library tools are defined once and reused.
  const apis = parseApis(front.apis);
  // Scripts declared inline on the agent, plus any script-type tool it opted
  // into — one `use:` list grants both kinds.
  const scriptSpecs = parseScripts(front.scripts);
  // Workspace tools shadow account tools of the same name (nearest wins).
  const available = { ...libraryTools(tenant), ...workspaceTools(tenant, workspace) };
  const requested: string[] = Array.isArray(front.use) ? front.use.map(String) : [];
  const missingTools: string[] = [];
  // MCP servers an agent connects to. `mcpServers:` is Claude Code's spelling
  // for the inline form; a `type: mcp` tool file is the shared form. Both end
  // up here, and both reach the model as ordinary MCP tools.
  const mcpServers: Record<string, McpServerConfig> = {};
  const mcpNames: string[] = [];

  const grantOwnTool = (name: string) => {
    const def = available[name];
    if (!def) {
      missingTools.push(name);
      return;
    }
    if (def.kind === "http") apis.push(def.spec);
    else if (def.kind === "script") scriptSpecs.push(...parseScripts([def.spec]));
    else {
      mcpServers[def.name] = mcpConfig(def.spec, tenant, workspace);
      mcpNames.push(def.name);
    }
  };

  for (const name of requested) grantOwnTool(name);

  // `tools:` may also name your own tools — resolved after built-ins below.
  for (const entry of front.tools ?? []) {
    const n = typeof entry === "string" ? entry : Object.keys(entry)[0];
    if (!TOOL_MAP[n] && !BUILTIN_TOOLS.has(n) && available[n] && !requested.includes(n)) {
      grantOwnTool(n);
    }
  }

  // Inline servers, Claude Code's field name and shape.
  if (front.mcpServers && typeof front.mcpServers === "object") {
    for (const [name, raw] of Object.entries(front.mcpServers as Record<string, unknown>)) {
      const def = parseToolDef({ ...(raw as object), type: "mcp" }, name);
      if (def?.kind === "mcp") {
        mcpServers[name] = mcpConfig(def.spec, tenant, workspace);
        mcpNames.push(name);
      }
    }
  }
  const apiTools = buildApiTools(tenant, apis, workspace);
  if (apiTools.promptLines.length) {
    parts.push(`# APIs you can call\n\n${apiTools.promptLines.join("\n")}`);
  }

  // Secrets an agent declared become env vars for its scripts and bash.
  //
  // Plus the credentials its API tools reference. An agent that opted into
  // `use: [email]` has said nothing about RESEND_API_KEY and should not have
  // to: the whole point of a tool definition is that the capability travels
  // with its credential and the agent never learns the name. The in-process
  // path always worked this way — buildApiTools resolves what the specs
  // reference — so without this the isolated path substituted nothing and
  // sent `Bearer ${RESEND_API_KEY}` literally, which the provider answers
  // with a 4xx the agent then reports as "the credential is missing".
  //
  // Declared-and-absent is still an error; referenced-and-absent is the API
  // tool's own missingSecrets, reported where the tool is described.
  const declared: string[] = Array.isArray(front.secrets) ? front.secrets.map(String) : [];
  const referenced = [...new Set(apis.flatMap(secretsUsedByApi))];
  const {
    env: secretEnv,
    from: secretScopes,
  } = resolveSecrets(tenant, [...new Set([...declared, ...referenced])], workspace);
  const { missing: missingDeclared } = resolveSecrets(tenant, declared, workspace);

  // The step's pod size. Two classes, not a dial: a size is a price and a
  // promise, and two of each is a menu while ten is a support queue. Default
  // is large — the install's configured limits — so existing agents change
  // nothing; `size: small` is the opt-in for agents that wait on APIs more
  // than they work, and the actuals line in any trace is the evidence for
  // opting in.
  const size: "small" | "large" = front.size === "small" ? "small" : "large";

  // Provider: which endpoint the model calls run against. Anthropic by
  // default; an Anthropic-compatible gateway (z.ai, LiteLLM, OpenRouter) by
  // declaring one. The format is portable — this is where the runtime stops
  // being tied to one vendor's endpoint.
  //
  //   provider:
  //     base_url: https://api.z.ai/api/anthropic
  //     token: ${ZAI_TOKEN}
  //
  // The URL sits in git; the token is a ${SECRET} resolved server-side. An
  // agent's own block wins over the workspace's, like everything else here.
  const providerBlock =
    (front.provider as Record<string, unknown> | undefined) ?? workspaceFrontmatter(agentDir, tenant).provider;
  let providerEnv: Record<string, string> = {};
  let providerLabel: string | null = null;
  // Secret values pulled into the provider block, name → value. Kept apart
  // from providerEnv because a header blob is a poor redaction key: what
  // must never reach the journal is the credential inside it, not the blob.
  const providerSecrets: Record<string, string> = {};
  const providerWarnings: string[] = [];
  const spec = parseProvider(providerBlock);
  if (spec) {
    providerWarnings.push(...spec.warnings);
    const substitute = (text: string) =>
      text.replace(/\$\{([A-Z][A-Z0-9_]*)\}/g, (whole, secretName) => {
        const hit = getSecret(tenant, secretName, workspace);
        if (!hit) return whole;
        providerSecrets[secretName] = hit.value;
        return hit.value;
      });
    const resolved = substitute(spec.token);
    if (spec.baseUrl) {
      const headers = Object.fromEntries(
        Object.entries(spec.headers).map(([k, v]) => [k, substitute(v)]),
      );
      providerEnv = providerEnvFor({
        baseUrl: spec.baseUrl,
        token: resolved,
        models: spec.models,
        headers,
      });
      // What the run is actually pointed at, in one line: the endpoint, the
      // tiers this gateway renames, and whether the credential landed.
      const remapped = Object.entries(spec.models).map(([tier, id]) => `${tier}→${id}`);
      providerLabel = spec.baseUrl;
      if (remapped.length) providerLabel += ` (${remapped.join(", ")})`;
      // An unresolved ${SECRET} would silently fall back to Anthropic's
      // endpoint with the host's key — say so instead.
      if (spec.token && resolved === spec.token && spec.token.includes("${")) {
        providerLabel += " — token secret not set";
      }
    }
  }

  // Runtime: an agent's own `runtime:` block, else its workspace's. Built once
  // per declaration and cached, so scripts get their dependencies without
  // polluting the host.
  let runtimeSpec = parseRuntime(front.runtime);
  if (!runtimeSpec) {
    // AGENTS.md is the Linux Foundation standard name (60k+ repos, same
    // nearest-wins cascade we already use); project.md stays accepted so
    // nothing that already exists breaks.
    runtimeSpec = parseRuntime(workspaceFrontmatter(agentDir, tenant).runtime);
  }
  // Execution: a container per run when Docker is available (real isolation),
  // otherwise the host venv path so local development still works.
  const executor = chooseExecutor();
  const runtimeLog: string[] = [];
  let runtimeError: string | null = null;
  let exec: ExecutionContext | null = null;
  let runtime = { interpreters: {} as Record<string, string>, env: {} as Record<string, string>, log: [] as string[], error: null as string | null };

  if (executor === "docker") {
    const image = ensureImage(runtimeSpec);
    runtimeLog.push(...image.log);
    runtimeError = image.error;
    if (!image.error) {
      exec = {
        executor: "docker",
        image: image.tag,
        mounts: {
          [path.resolve(agentDir, "..", "..", "scripts")]: "/workspace-scripts",
          [libraryDir(tenant, "scripts")]: "/library-scripts",
        },
        // Only agents that declared an API need egress.
        network: parseApis(front.apis).length > 0 || (Array.isArray(front.use) && front.use.length > 0),
      };
    }
  } else {
    runtime = prepareRuntime(tenant, runtimeSpec);
    runtimeLog.push(...runtime.log);
    runtimeError = runtime.error;
  }

  // Scripts declared as tools — callable by name, no bash required.
  const scriptTools = buildScriptTools(
    agentDir,
    scriptSpecs,
    { ...runtime.env, ...secretEnv },
    libraryDir(tenant, "scripts"),
    runtime.interpreters,
    exec,
  );
  if (scriptTools.promptLines.length) {
    parts.push(
      `# Tools from scripts\n\nCall these directly — they run workspace scripts for you:\n\n${scriptTools.promptLines.join("\n")}`,
    );
  }
  if (declared.length) {
    parts.push(
      `# Secrets\n\nAvailable to your scripts as environment variables: ${declared.join(", ")}. ` +
        `Never print, echo, or write them to a file.`,
    );
  }

  parts.push(
    "Write deliverables for people to ../../files/ (kept and downloadable); write working text for later steps to outputs/.",
  );

  // One list. `tools:` grants anything: a built-in group, an exact SDK tool
  // name, or a tool defined in this workspace or account. `use:` still works
  // and means the same thing — it just can't name a built-in.
  //
  // The split used to be ours, not the author's: they don't care whether a
  // capability comes from the SDK or a file, only what the agent may do. Two
  // lists meant two places to look for the blast radius.
  const allowed: string[] = [];
  const disabled: string[] = [];
  const unknownTools: string[] = [];
  const shadowed: string[] = [];

  for (const entry of front.tools ?? []) {
    const toolName = typeof entry === "string" ? entry : Object.keys(entry)[0];
    const mode = typeof entry === "string" ? "allow" : Object.values(entry)[0];
    if (mode === "ask") {
      disabled.push(toolName);
      continue;
    }

    // Resolution order: built-in group, exact SDK name, then your own tools.
    // Built-ins win, because their names are a small fixed set — but a tool
    // hidden by one is worth saying out loud rather than silently ignoring.
    if (TOOL_MAP[toolName]) {
      allowed.push(...TOOL_MAP[toolName]);
      if (available[toolName]) shadowed.push(toolName);
    } else if (BUILTIN_TOOLS.has(toolName)) {
      allowed.push(toolName);
      if (available[toolName]) shadowed.push(toolName);
    } else if (available[toolName]) {
      // Already granted above, alongside `use:` — nothing more to do here.
    } else {
      unknownTools.push(toolName);
    }
  }
  allowed.push(...apiTools.toolNames, ...scriptTools.toolNames);
  // An MCP server declares its tools when it connects, so they can't be listed
  // ahead of time. Server-level specs cover them: granting the server grants
  // what it exposes, which is the unit a person actually reasons about anyway.
  for (const name of mcpNames) allowed.push(`mcp__${name}`, `mcp__${name}__*`);

  // Claude Code's spellings, so an agent written for it mostly runs here.
  // `permissionMode: plan` is its read-only mode; ours is the `read` group.
  if (front.permissionMode === "plan") {
    allowed.length = 0;
    allowed.push(...TOOL_MAP.read, ...apiTools.toolNames, ...scriptTools.toolNames);
  }
  const denied: string[] = Array.isArray(front.disallowedTools)
    ? front.disallowedTools.map(String)
    : [];
  const finalAllowed = allowed.filter((t) => !denied.includes(t));

  return {
    front,
    systemPrompt: parts.join("\n\n"),
    allowed: finalAllowed,
    disabled,
    unknownTools,
    shadowed,
    knownToolNames: Object.keys(available),
    mcpServers,
    mcpNames,
    apiTools,
    scriptTools,
    // The merged spec lists — inline plus use:-granted — for the isolated
    // path, which serialises specs across the container boundary rather
    // than using the servers built here.
    apiSpecs: apis,
    scriptSpecs,
    runtime: { log: runtimeLog, error: runtimeError, executor },
    secretEnv: { ...runtime.env, ...secretEnv },
    formatWarning: checkFormatVersion(
      // mdagent_version is the same field from before the project was
      // renamed — workspaces written then keep validating unchanged.
      workspaceFrontmatter(agentDir, tenant).foldrun_version ??
        workspaceFrontmatter(agentDir, tenant).mdagent_version,
    ).warning,
    providerEnv,
    providerLabel,
    providerSecrets,
    providerWarnings,
    secretScopes,
    missingTools,
    size,
    // Definitions that exist but could not be read. Carried alongside the
    // missing ones so the step can tell "you never made this" apart from
    // "it's right there with a typo in it".
    brokenTools: brokenToolReport(tenant, workspace),
    missingSecrets: [...new Set([...missingDeclared, ...apiTools.missingSecrets])],
  };
}

/**
 * The SDK prices a step off Anthropic's table; through a gateway to a
 * routed model that number is fiction. When the catalogue can price the
 * tokens itself, its number replaces the SDK's, and the trace says so —
 * a silently different bill is the one kind nobody forgives.
 */
function repriced(
  catalog: Catalog | null,
  model: string,
  usage: { inputTokens: number; outputTokens: number } | null,
  sdkCost: number | null,
  push: (type: "info" | "error", text: string) => void,
): number | null {
  const known = usage ? catalogCost(catalog, model, usage) : null;
  if (known === null) return sdkCost;
  if (sdkCost !== null && Math.abs(known - sdkCost) > 0.000001) {
    push("info", `cost repriced from the gateway's catalogue: $${known.toFixed(6)} (sdk said $${sdkCost.toFixed(6)})`);
  }
  return known;
}

async function runStep(
  agentDir: string,
  tenant: string,
  step: StepRecord,
  context: string | null,
  save: () => void,
  modelOverride?: string | null,
  tags: string[] = [],
  effortOverride?: string | null,
  runId?: string,
) {
  // Secret values are injected into scripts as environment variables and
  // substituted into API headers, so a model that reads one back — from a
  // script that prints it, an API error that echoes it, or its own `env` —
  // can put a live credential into its reply. Everything a step says is
  // written to runs/<id>.json and rendered in the dashboard, which would make
  // that credential permanent and visible to anyone who can read a run.
  //
  // So values are scrubbed on the way into the journal, at the one place every
  // event passes through. The name survives, because "the token was here" is
  // the part worth keeping.
  //
  // This is the last line of defence, not the only one: the model is never
  // given the values in the first place, and checkBash already refuses the
  // obvious `echo $SOMETHING_TOKEN`. It exists because neither of those can
  // cover a script's own stdout.
  let redactions: [string, string][] = [];
  let fileDir: string | null = null;
  const redact = (text: string) => {
    let out = text;
    for (const [value, name] of redactions) out = out.split(value).join(`[redacted:${name}]`);
    return out;
  };

  const push = (type: StepRecord["events"][number]["type"], text: string) => {
    step.events.push({ t: new Date().toISOString(), type, text: redact(text) });
    save();
  };

  // The test seam: FOLDRUN_STUB_STEP=1 completes the step from a canned
  // script instead of a model, so the orchestration around steps — loops,
  // fan-out, gates — is testable at zero cost. An agent's `stub.md` holds
  // the answers, `\n---\n`-separated, consumed one per call; the last one
  // repeats. Never set outside a test.
  if (process.env.FOLDRUN_STUB_STEP === "1") {
    const stubFile = path.join(agentDir, "stub.md");
    const answers = fs.existsSync(stubFile)
      ? fs.readFileSync(stubFile, "utf8").split(/\n---\n/)
      : [`stub result from ${step.agent}`];
    const call = step.events.filter((e) => e.text.startsWith("stub call")).length;
    push("info", `stub call ${call + 1}`);
    step.status = "completed";
    step.result =
      (answers[Math.min(call, answers.length - 1)] ?? "").trim() +
      (step.item ? ` [item: ${step.item}]` : "");
    step.costUsd = 0;
    save();
    return;
  }

  try {
    const {
      front, systemPrompt, allowed, disabled, apiTools, scriptTools,
      secretEnv, secretScopes, missingSecrets, missingTools, runtime,
      unknownTools, shadowed, knownToolNames, mcpServers, mcpNames,
      apiSpecs, scriptSpecs, brokenTools, size,
      providerEnv, providerLabel, providerSecrets, providerWarnings, formatWarning,
    } = agentContext(agentDir, tenant, tags);

    // oauth2 secrets become live access tokens here — the one async moment
    // in secret resolution, at the last host-side point before anything is
    // injected or substituted. The refresh recipes never leave this process:
    // what crosses into containers, headers and env files is the token. A
    // failed refresh fails the step naming the secret and the provider's
    // reason, which beats a 401 three layers later.
    const liveSecrets = await materializeSecrets(secretEnv);
    // @file values (SSH keys, certs) still carry their content at this point.
    // The in-process branch materialises them to 0600 paths on this host
    // below; the container branch passes the content across and the driver
    // materialises inside, because a host path is meaningless in there.

    // Populate before the first push: everything after this point may quote a
    // credential. Short values are skipped — a two-character secret would
    // redact half the English language, and anything that short is not one.
    redactions = Object.entries({ ...liveSecrets, ...providerSecrets, ...providerEnv })
      .filter(([, value]) => typeof value === "string" && value.length >= 8)
      .map(([name, value]) => [value, name] as [string, string])
      // Longest first, so a value containing another is replaced whole.
      .sort((a, b) => b[0].length - a[0].length);

    if (providerLabel) push("info", `provider: ${providerLabel}`);
    for (const w of providerWarnings) push("error", w);
    if (formatWarning) push("error", formatWarning);
    for (const t of unknownTools) {
      // The commonest mistake is putting a workspace tool in `tools:`, so say
      // so explicitly rather than just reporting that the name is unknown.
      const isOwnTool = knownToolNames.includes(t);
      push(
        "error",
        isOwnTool
          ? `tools: "${t}" is a tool defined in this workspace — grant it with \`use: [${t}]\`, not \`tools:\`. Nothing was granted for it.`
          : `tools: "${t}" is not a tool group (web, read, files, bash) or an SDK tool name — nothing was granted for it`,
      );
    }
    for (const name of mcpNames) push("info", `mcp server connected: ${name}`);
    for (const name of shadowed) {
      push("error", `tools: "${name}" is a built-in, so your tool of the same name was not granted — rename one of them`);
    }
    for (const t of disabled) push("info", `tool ${t}: ask-mode is disabled for platform runs`);
    for (const s of missingSecrets) {
      push("error", `secret ${s} is not set in this workspace — add it in Settings → Secrets`);
    }
    // Say which store each secret came from: a workspace quietly falling back
    // to an account credential is the kind of thing you want to see, not infer.
    for (const [name, scope] of Object.entries(secretScopes)) {
      push("info", `secret ${name} ← ${scope} scope`);
    }
    for (const t of missingTools) {
      // "Not found" is the wrong sentence when the file is right there with a
      // typo in it, and it sends the author to the wrong place. Say which.
      const broken = brokenTools.filter((b) => b.startsWith(`${t}:`));
      push(
        "error",
        broken.length
          ? `tool "${t}" exists but could not be read — ${broken[0].slice(t.length + 2)}`
          : `tool "${t}" is not in the workspace library — add it under Library → Tools`,
      );
    }
    for (const line of runtime.log) push("info", line);
    push("info", `script executor: ${runtime.executor}`);
    if (runtime.error) push("error", `runtime: ${runtime.error}`);
    // Nearest wins, for both halves of model selection: the step names one,
    // else the flow does, else the agent's own frontmatter. Which level won
    // goes in the trace — "why did this run on haiku" should be answerable
    // from the run, not by opening three files.
    const modelSource = step.model ? "step" : modelOverride ? "flow" : "agent";
    const model = resolveModel(step.model ?? modelOverride ?? front.model);
    const rawEffort = step.effort ?? effortOverride ?? front.effort;
    const effortSource = step.effort ? "step" : effortOverride ? "flow" : "agent";
    let effort = resolveEffort(rawEffort);
    if (isEffortWord(rawEffort)) {
      push(
        "error",
        `effort: "${String(rawEffort).trim()}" is not a level — use ${EFFORT_LEVELS.join(", ")}. ` +
          `Running at the model's default instead.`,
      );
    }
    push(
      "info",
      `step started (agent: ${step.agent}, model: ${model} — ${modelSource}` +
        `${effort ? `, effort: ${effort} — ${effortSource}` : ""})`,
    );

    // The run-start gate, when a gateway is in play. "Any model they want"
    // is only an offer if a wrong pick fails here, in one line naming the
    // fix — not minutes in, as an agent narrating tool calls into prose
    // because its model cannot make them. The catalogue only ever fails a
    // step on knowledge; unknown ids, presets and offline all pass through
    // to the model call, which stays the authority of last resort.
    let catalog: Catalog | null = null;
    // The env this run's model calls actually ride: the workspace's own
    // provider block when one is declared, otherwise the platform's — the
    // "models included" path, where the host env points every run at the
    // platform's gateway and users only ever pick a model. The gate, the
    // effort fit and the repricing follow the credential, not the file:
    // keying them off the provider block alone left the platform-provided
    // path — the main one — without any of them.
    const rideEnv: Record<string, string | undefined> =
      Object.keys(providerEnv).length > 0 ? providerEnv : process.env;
    // What actually goes on the wire: a tier the gateway remapped is sent
    // as the gateway's id, and that id — not our tier word — is what the
    // catalogue can have an opinion about.
    const wireModel =
      { haiku: rideEnv.ANTHROPIC_DEFAULT_HAIKU_MODEL,
        sonnet: rideEnv.ANTHROPIC_DEFAULT_SONNET_MODEL,
        opus: rideEnv.ANTHROPIC_DEFAULT_OPUS_MODEL }[model] ?? model;
    if (rideEnv.ANTHROPIC_BASE_URL) {
      catalog = await loadCatalog(rideEnv.ANTHROPIC_BASE_URL);
      const needsTools = allowed.length > 0 || mcpNames.length > 0;
      const verdict = checkModel(catalog, wireModel, { tools: needsTools });
      if (!verdict.ok) {
        push("error", verdict.reason!);
        step.status = "failed";
        save();
        return;
      }
      // Effort, fitted to what this model actually takes: unchanged when the
      // level is supported, the nearest supported level when it isn't, gone
      // when the model doesn't reason — each departure said aloud. This is
      // what makes `effort:` portable rather than Anthropic-only: the word
      // in the file stays the intent, the wire carries what the model has.
      const fitted = clampEffort(catalog, wireModel, effort);
      if (fitted.note) push("info", fitted.note);
      effort = fitted.effort;
    }

    fs.mkdirSync(path.join(agentDir, "outputs"), { recursive: true });
    fs.mkdirSync(path.join(agentDir, "memory"), { recursive: true });

    // Expose the workspace's shared scripts/ as ./shared so every agent reaches
    // them by the same path, without each one carrying a copy.
    // No symlinks into the agent directory — they would recurse into the
    // workspace's own file listing. Shared paths are resolved by the script
    // tool layer and described to the agent below.

    // The confinement boundary: agents in a workspace are one team, but the
    // workspace is where isolation is enforced.
    const workspaceRoot = path.resolve(agentDir, "..", "..");

    let prompt = step.instruction || "Begin your run now, following your instructions.";
    if (context) prompt += `\n\n<previous_step_results>\n${context.slice(0, 30000)}\n</previous_step_results>`;
    if (step.approvalNote) {
      // The person at the gate said something while letting the run through.
      // That is the freshest instruction the step has — later than the flow
      // file, aimed at this exact run.
      prompt += `\n\n<operator_guidance>\nThe human who approved this step added:\n${step.approvalNote}\n</operator_guidance>`;
    }
    if (step.item) {
      // A fan-out instance: same instruction as its siblings, one item each.
      prompt += `\n\n<item>\nOf everything above, this instance of the step handles exactly one item — this one:\n${step.item}\n</item>`;
    }

    // Colleagues this agent may consult mid-turn — declared, like every
    // other capability.
    const { consults, missing: missingConsults } = gatherConsults(workspaceRoot, front.agents);
    for (const m of missingConsults) {
      push("error", `agents: "${m}" is not an agent in this workspace — no consult tool granted`);
    }
    const consultNames = consults.length ? [...mcpNames, "foldrun_agents"] : mcpNames;

    const isolation = process.env.FOLDRUN_RUN_ISOLATION;
    if (isolation === "container" || isolation === "k8s") {
      // The isolated path: the whole loop — model, built-in tools, scripts —
      // runs inside a throwaway container (a docker sibling, or a pod), and
      // only filtered file changes come back. The vault stays out here:
      // secrets are substituted into API headers before the specs cross,
      // and reach scripts as env.
      push("info", `isolation: ${isolation}`);
      // The *merged* lists — inline declarations plus everything `use:`
      // granted — not a re-parse of the frontmatter. Rebuilding from `front`
      // here silently dropped every use:-granted http and script tool on
      // the isolated path (mcp grants survived only because mcpServers is
      // passed as the merged object): the agent's prompt promised a tool
      // the function list didn't have, and the step failed as the model
      // politely reporting the gap.
      const substitutedApis = apiSpecs.map((api) => ({
        ...api,
        headers: Object.fromEntries(
          Object.entries(api.headers).map(([k, v]) => [
            k,
            v.replace(/\$\{([A-Z][A-Z0-9_]*)\}/g, (whole, name) => liveSecrets[name] ?? whole),
          ]),
        ),
      }));
      const runIsolated = isolation === "k8s" ? runStepInK8s : runStepInContainer;
      // The last provider refusal this step saw, for the fallback decision.
      let lastRefusal = "";
      const pushWatching: typeof push = (type, text) => {
        if (type === "error" && isProviderRefusal(text)) lastRefusal = text;
        push(type, text);
      };
      const isolatedArgs = (modelEnv: Record<string, string | undefined>) => ({
        workspaceRoot,
        libraryRoot: libraryDir(tenant),
        input: {
          agentRel: path.relative(workspaceRoot, agentDir).replaceAll("\\", "/"),
          prompt,
          model,
          effort,
          systemPrompt,
          allowed,
          mcpNames: consultNames,
          mcpServers,
          apis: substitutedApis,
          scripts: scriptSpecs,
          runtime: parseRuntime(front.runtime),
          consults,
          timeoutSec: step.timeout,
          verify: step.verify,
        },
        env: Object.fromEntries(
          Object.entries({
            // The platform's own model credential, when the agent names no
            // provider of its own — this is "models included": the host
            // process holds one key, and every isolated run borrows it.
            // A provider: block still wins, because providerEnv is spread
            // after and carries the agent's chosen endpoint + token.
            ...(Object.keys(providerEnv).length === 0 ? modelEnv : {}),
            ...liveSecrets,
            ...providerEnv,
          }).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
        ),
        emit: pushWatching,
        // Stamps the sandbox, so stopping this run can destroy it.
        runId,
        size,
      });

      let outcome = await runIsolated(isolatedArgs(platformModelEnv()));
      // The platform's second supply, tried exactly once, and only when all
      // three are true: the step rode the platform credential (a BYOK step's
      // provider is the customer's problem and their bill), the primary
      // refused over money/auth/limits rather than the work failing, and a
      // fallback is configured. The retry is a fresh sandbox — the failed
      // one is gone, and driveRun's whole contract is that re-driving is
      // safe.
      const fallback = platformFallbackEnv();
      if (
        outcome.status === "failed" &&
        lastRefusal &&
        fallback &&
        Object.keys(providerEnv).length === 0
      ) {
        push(
          "info",
          `primary model supply refused (${lastRefusal.slice(0, 80)}) — retrying this step on the fallback provider`,
        );
        const first = outcome.timing;
        outcome = await runIsolated(isolatedArgs(fallback));
        // Both attempts held sandboxes; the meter owes the sum. The first
        // try's pod ran, was billed for by the platform, and must not
        // vanish from the record because a second try replaced its outcome.
        if (first && outcome.timing) {
          outcome = {
            ...outcome,
            timing: { ...outcome.timing, totalMs: outcome.timing.totalMs + first.totalMs },
          };
        } else if (first && !outcome.timing) {
          outcome = { ...outcome, timing: first };
        }
      }
      step.status = outcome.status;
      step.result = outcome.result;
      step.costUsd = repriced(catalog, wireModel, outcome.usage ?? null, outcome.costUsd, push);
      step.tokens = outcome.usage
        ? { input: outcome.usage.inputTokens, output: outcome.usage.outputTokens }
        : null;
      step.actual = outcome.res ?? null;
      if (outcome.res?.peakMemBytes || outcome.res?.rxBytes) {
        const mb = (n: number | null) => (n === null ? "?" : (n / 1024 / 1024).toFixed(0));
        push(
          "info",
          `resources: cpu busy ${outcome.res.busyCpuSecs?.toFixed(1) ?? "?"}s · ` +
            `peak mem ${mb(outcome.res.peakMemBytes)}MB · ` +
            `net ${mb(outcome.res.rxBytes)}MB in / ${mb(outcome.res.txBytes)}MB out`,
        );
      }
      // The compute meter, recorded on the step rather than derived later:
      // the sandbox is gone by the time the run settles, and its lifetime
      // is not recoverable from the run's own timestamps.
      const secs = (ms: number) => Math.round(ms) / 1000;
      step.computeSecs = outcome.timing ? secs(outcome.timing.totalMs) : null;
      step.startupSecs = outcome.timing ? secs(outcome.timing.sandboxMs) : null;
      // Which reservation those seconds held — as numbers, because the bill
      // is per core-second and per GiB-second, and what was held must come
      // from the record, never from what the config says at billing time.
      step.size = size;
      const lim = sizeLimits(size);
      const gib = (() => {
        const m = lim.memory.match(/^(\d+(?:\.\d+)?)\s*(Gi?|Mi?|g|m)?/i);
        const n = m ? Number(m[1]) : 2;
        return (m?.[2] ?? "Gi").toLowerCase().startsWith("m") ? n / 1024 : n;
      })();
      step.reserved = { cpus: Number(lim.cpus) || 2, memGiB: gib };
    } else {
      const consultTools = buildConsultTools(
        consults,
        { ...process.env, ...liveSecrets, ...providerEnv },
        (type, text) => push(type, text),
      );
      const outcome = await executeStep({
        agentDir,
        workspaceRoot,
        libraryRoot: libraryDir(tenant),
        prompt,
        model,
        effort,
        systemPrompt,
        allowed,
        mcpNames: consultNames,
        mcpServers: {
          ...(apiTools.server ? { foldrun_apis: apiTools.server } : {}),
          ...(scriptTools.server ? { foldrun_scripts: scriptTools.server } : {}),
          ...(consultTools.server ? { foldrun_agents: consultTools.server } : {}),
          ...mcpServers,
        },
        // Declared secrets reach the agent's scripts as env vars; the model
        // only ever sees the variable names, not the values. @file secrets
        // become 0600 paths here (host run), cleaned up in the finally.
        env: (() => {
          const mat = materializeFileSecrets(agentDir, liveSecrets);
          fileDir = mat.dir;
          return { ...process.env, ...mat.env, ...providerEnv };
        })(),
        timeoutSec: step.timeout,
        verify: step.verify,
        verifyEnv: liveSecrets,
        emit: push,
      });
      step.status = outcome.status;
      step.result = outcome.result;
      // A consult's spend belongs to the step that asked.
      const consultCost = consultTools.drainCost();
      const stepCost = repriced(catalog, wireModel, outcome.usage, outcome.costUsd, push);
      step.costUsd = stepCost === null && consultCost === 0 ? null : (stepCost ?? 0) + consultCost;
      step.tokens = outcome.usage
        ? { input: outcome.usage.inputTokens, output: outcome.usage.outputTokens }
        : null;
      for (const line of apiTools.drainLog()) push("info", `api: ${line}`);
      for (const line of scriptTools.drainLog()) push("info", `script: ${line}`);
    }
  } catch (err) {
    step.status = "failed";
    push("error", err instanceof Error ? err.message : String(err));
  } finally {
    try {
      cleanupFileSecrets(fileDir);
    } catch {
      // best-effort — a leftover scratch file is swept with the run's outputs
    }
  }
  save();
}

// Block until a human approves or rejects the pending steps. Polls the run
// record — the same file the dashboard writes through the approval API — so
// no in-memory queue has to survive a restart.
async function waitForDecision(
  tenant: string,
  workspace: string,
  runId: string,
  indexes: number[],
  timeoutMs = 24 * 60 * 60_000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1000));
    const latest = readRun(tenant, workspace, runId);
    if (!latest) return false;
    const stillWaiting = indexes.some((i) => latest.steps[i]?.status === "awaiting-approval");
    if (!stillWaiting) return true;
  }
  return false;
}

/**
 * Copy a directory tree by reading and writing the bytes.
 *
 * Not fs.cpSync: that copies through the kernel's clone/copy_file_range
 * path, which on a bind-mounted or network volume — exactly where a hosted
 * install keeps its data — can report success and leave a zero-length file
 * behind. Every archived run output was empty, and nothing failed to say
 * so, which is the worst shape a bug can take. This works on every
 * filesystem, and normalises the mode while it is here: what an agent
 * produced belongs to the platform, not to the container umask that
 * happened to create it.
 */
export function copyTreeBytes(from: string, to: string) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name);
    const dst = path.join(to, entry.name);
    if (entry.isDirectory()) copyTreeBytes(src, dst);
    else if (entry.isFile()) fs.writeFileSync(dst, fs.readFileSync(src), { mode: 0o644 });
  }
}

// Which of the host's own credentials an isolated run may borrow. Only the
// model credential — a run gets the ability to think on the platform's
// account, never the platform's other secrets, which is the entire reason
// the container env is allowlisted instead of inheriting process.env.
/**
 * The platform's second model supply, tried when the first refuses over
 * money or auth. Order is a cost decision: a flat-rate subscription as the
 * engine, pay-per-token only when it runs dry —
 *
 *   FOLDRUN_FALLBACK_BASE_URL     e.g. https://openrouter.ai/api
 *   FOLDRUN_FALLBACK_TOKEN        bearer for that endpoint
 *   FOLDRUN_FALLBACK_HAIKU/SONNET/OPUS_MODEL   tier ids in ITS catalogue
 *
 * Empty ANTHROPIC_API_KEY on purpose: set, it goes out as x-api-key and a
 * gateway rejects it; the fallback's whole credential is the bearer.
 */
function platformFallbackEnv(): Record<string, string> | null {
  const base = process.env.FOLDRUN_FALLBACK_BASE_URL;
  const token = process.env.FOLDRUN_FALLBACK_TOKEN;
  if (!base || !token) return null;
  const out: Record<string, string> = {
    ANTHROPIC_BASE_URL: base,
    ANTHROPIC_AUTH_TOKEN: token,
    ANTHROPIC_API_KEY: "",
    CLAUDE_CODE_OAUTH_TOKEN: "",
  };
  for (const tier of ["HAIKU", "SONNET", "OPUS"] as const) {
    const id = process.env[`FOLDRUN_FALLBACK_${tier}_MODEL`];
    if (id) out[`ANTHROPIC_DEFAULT_${tier}_MODEL`] = id;
  }
  return out;
}

/** A model-call failure the fallback can answer: the primary refusing over
 *  credit, quota or auth — never a failure of the work itself, which would
 *  fail identically anywhere. */
function isProviderRefusal(text: string): boolean {
  // Money and auth words only, plus the API's own status codes. The first
  // version matched bare "exceed", which is also how the pod backstop
  // phrases a timeout — and a timed-out step got retried on the paid
  // fallback it could only time out on again. A refusal the fallback can
  // answer is about the ACCOUNT; anything about the work or the sandbox is
  // not, however similar the vocabulary.
  return /API Error: (401|402|403|429|5\d\d)|credits?\b|quota|billing|insufficient|overloaded/i.test(text);
}

function platformModelEnv(): Record<string, string | undefined> {
  const {
    ANTHROPIC_API_KEY,
    ANTHROPIC_AUTH_TOKEN,
    ANTHROPIC_BASE_URL,
    CLAUDE_CODE_OAUTH_TOKEN,
    // What the tiers mean when the platform's own provider is not Anthropic.
    // These belong to the credential: a base URL pointing at OpenRouter with
    // Anthropic's model ids still attached is not a working provider, it is
    // a 404 per step. Forwarded for the same reason the base URL is — an
    // agent that names no provider gets the platform's, whole.
    ANTHROPIC_DEFAULT_HAIKU_MODEL,
    ANTHROPIC_DEFAULT_SONNET_MODEL,
    ANTHROPIC_DEFAULT_OPUS_MODEL,
  } = process.env;
  return {
    ANTHROPIC_API_KEY,
    ANTHROPIC_AUTH_TOKEN,
    ANTHROPIC_BASE_URL,
    CLAUDE_CODE_OAUTH_TOKEN,
    ANTHROPIC_DEFAULT_HAIKU_MODEL,
    ANTHROPIC_DEFAULT_SONNET_MODEL,
    ANTHROPIC_DEFAULT_OPUS_MODEL,
  };
}

/**
 * Write a fresh run record and reset outputs — everything starting a run
 * means *except* driving it. Split out so the queue can create a `queued`
 * record for a worker to pick up, while `startFlowRun` keeps its promise of
 * a run that is already going when it returns.
 */
export function createFlowRun(
  tenant: string,
  workspace: string,
  steps: FlowStep[],
  flowName: string,
  status: "queued" | "running",
  tags: string[] = [],
): RunRecord {
  const run: RunRecord = {
    id: `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    flow: flowName,
    tags,
    status,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    steps: steps.map((s) => ({
      agent: s.agent,
      instruction: s.instruction,
      group: s.group ?? 1,
      optional: s.optional ?? false,
      model: s.model,
      effort: s.effort,
      approve: s.approve,
      when: s.when,
      case: s.case,
      else: s.else,
      retry: s.retry,
      timeout: s.timeout,
      verify: s.verify,
      loop: s.loop,
      until: s.until,
      loopRemaining: s.loop,
      each: s.each,
      max: s.max,
      attempts: 0,
      status: "pending",
      events: [],
      result: null,
      costUsd: null,
    })),
  };
  writeRun(tenant, workspace, run);

  // Start every run from an empty outputs/ for each agent it will touch.
  //
  // Without this, `verify: test -s outputs/report.md` passes on run 2 because
  // run 1 left the file behind — the one check that exists to catch a model
  // claiming work it didn't do can be satisfied by a stale artifact. The
  // previous contents aren't lost: they were archived when that run finished.
  //
  // This is the one thing resuming must not do: a resumed run's earlier steps
  // already wrote there, and clearing it would delete the work being resumed.
  const runRoot = workspaceDir(tenant, workspace);
  for (const agent of new Set(run.steps.map((s) => s.agent))) {
    const outputs = path.join(runRoot, "agents", agent, "outputs");
    fs.rmSync(outputs, { recursive: true, force: true });
    fs.mkdirSync(outputs, { recursive: true });
  }

  return run;
}

export function startFlowRun(
  tenant: string,
  workspace: string,
  steps: FlowStep[],
  flowName: string,
  modelOverride?: string | null,
  tags: string[] = [],
  effortOverride?: string | null,
): RunRecord {
  const run = createFlowRun(tenant, workspace, steps, flowName, "running", tags);
  void driveRun(tenant, workspace, run, modelOverride, tags, { effortOverride });
  return run;
}

/**
 * Drive a run to completion: groups in order, approval gates, retries.
 *
 * Separate from starting one so a run can be picked up again. The loop reads
 * every decision off the run record — `pending` steps are the work left, and
 * a completed group's results are already on it — so re-entering it on a
 * partly-finished record continues rather than restarts.
 *
 * `parkOnApproval` — a queue worker's slot is too expensive to spend polling
 * a file for a person who may answer tomorrow. With it set, an approval gate
 * saves the run as parked and returns; the approval API re-enqueues it and a
 * worker re-enters this loop, which continues where the record says it
 * stopped. Without it (the CLI, whose process belongs to the person waiting)
 * the gate blocks in place exactly as before.
 */
export function driveRun(
  tenant: string,
  workspace: string,
  run: RunRecord,
  modelOverride?: string | null,
  tags: string[] = [],
  opts: { parkOnApproval?: boolean; effortOverride?: string | null } = {},
): Promise<void> {
  const effortOverride = opts.effortOverride ?? null;
  const pDir = workspaceDir(tenant, workspace);
  const runRoot = pDir;
  const save = () => writeRun(tenant, workspace, run);

  // Provenance: a memory an agent wrote gets stamped with who wrote it, per
  // OKF v0.2. Without this a fact the model invented and a fact a person
  // verified are indistinguishable on disk — and the reader has no way to
  // know which one they're trusting.
  const stampMemories = () => {
    const agents = new Set(run.steps.map((s) => s.agent));

    // Every memory bundle a run can write to, not just the agent's own. The
    // workspace bundle is writable from any step — confine only denies
    // knowledge/ — so a fact left there was going unstamped and untyped, and
    // the bundle stopped conforming until someone ran `foldrun check`.
    // The account library is not here: it is read-only from a run.
    const dirs: { dir: string; agent: string | null }[] = [
      // Attributable only when one agent could have written it.
      { dir: path.join(runRoot, "memory"), agent: agents.size === 1 ? [...agents][0] : null },
      ...[...agents].map((agent) => ({
        dir: path.join(runRoot, "agents", agent, "memory"),
        agent,
      })),
    ];

    for (const { dir, agent } of dirs) {
      // Each stamped file is a Creation in the bundle's log — that is what the
      // log is for, and an agent's writes are exactly the changes a reader
      // most wants dated. syncBundleFor logs the file it is given, so passing
      // index.md logged nothing about the concept that actually appeared.
      for (const rel of stampBundle(dir, agent)) {
        syncBundleFor(path.join(dir, rel), "Creation");
      }
    }
  };

  // Archive what a run produced, so history survives the next run's reset.
  const archive = () => {
    for (const agent of new Set(run.steps.map((s) => s.agent))) {
      const from = path.join(runRoot, "agents", agent, "outputs");
      if (!fs.existsSync(from) || fs.readdirSync(from).length === 0) continue;
      copyTreeBytes(from, path.join(runRoot, "runs", run.id, "outputs", agent));
    }
  };

  // A parked run is paused, not finished — the completion bookkeeping in
  // `finally` (finishedAt, archive, memory stamps) must not touch it.
  let parked = false;

  return (async () => {
    try {
      // Entering the loop is what makes a run live, whatever state it was
      // saved in: `queued` from the queue, `awaiting-approval` from a park.
      if (run.status !== "running") {
        run.status = "running";
        run.parkedAt = null;
        save();
      }

      // A step still marked `running` here is an orphan: exactly one driver
      // holds a run's job, so whatever process set that status is gone —
      // killed mid-step by a deploy or a crash. Left alone it is worse than
      // failed: the group loop only runs `pending` steps, so the driver
      // would step over the unfinished work, run everything after it, and
      // mark the run completed — a run that reports success on work that
      // never happened, which reconcile can then never see. Reset it to
      // pending and it simply runs again; driveRun's whole contract is that
      // re-driving a partly-finished record is safe.
      for (const step of run.steps) {
        if (step.status !== "running") continue;
        step.status = "pending";
        step.events.push({
          t: new Date().toISOString(),
          type: "info",
          text: "interrupted mid-step (platform restart) — running again from the start of the step",
        });
      }
      save();

      // Put the workspace's files on disk before the first step, so they are
      // simply *there* when the step's container copy is taken. This is the
      // whole of the agent-facing file API: a directory. Nothing here hands
      // the model a bucket, a URL or a credential, and a run pod that has
      // never heard of S3 reads a 200MB PDF the same way it reads AGENTS.md.
      //
      // Runs on resume too — a parked run's container is long gone, and the
      // one it comes back in needs the same files the first one had.
      try {
        const brought = await materializeFiles(tenant, workspace);
        if (brought.length) {
          run.steps[0]?.events.push({
            t: new Date().toISOString(),
            type: "info",
            text: `files: ${brought.length} brought into the workspace`,
          });
        }
      } catch (err) {
        // A file store that is down must not take the run with it: most flows
        // never touch files/, and the ones that do will fail their own verify.
        run.steps[0]?.events.push({
          t: new Date().toISOString(),
          type: "error",
          text: `files: could not be brought in — ${err instanceof Error ? err.message : String(err)}`,
        });
      }

      // Group steps by their group number, ascending. Rebuilt on demand
      // because two patterns mutate the step list mid-run: fan-out expands a
      // step into instances, and an evaluator loop winds groups back.
      const orderedGroups = () => {
        const groups = new Map<number, StepRecord[]>();
        for (const s of run.steps) {
          const list = groups.get(s.group) ?? [];
          list.push(s);
          groups.set(s.group, list);
        }
        return [...groups.entries()].sort(([a], [b]) => a - b).map(([, g]) => g);
      };
      let ordered = orderedGroups();

      // What each finished group produced, by position — so a loop that
      // winds back can hand the re-run the same upstream context the first
      // pass saw, instead of its own stale output.
      const groupResults: (string | null)[] = [];
      const contextBefore = (gi: number) => {
        for (let i = gi - 1; i >= 0; i--) if (groupResults[i]) return groupResults[i];
        return null;
      };

      let gi = 0;
      let context: string | null = null;
      while (gi < ordered.length) {
        const group = ordered[gi];
        context = contextBefore(gi);

        // Fan-out: a step with `each:` becomes one instance per item of the
        // previous group's result, capped, all in this same group — the
        // declared shape stays readable in the file, the width comes from
        // the data. The template survives as a skipped step for the trace.
        for (const step of [...group]) {
          if (step.each !== "lines" || step.status !== "pending" || step.item) continue;
          const cap = Math.min(step.max ?? 10, 20);
          const items = (context ?? "")
            .split("\n")
            .map((l) => l.replace(/^[-*\d.)\s]+/, "").trim())
            .filter(Boolean)
            .slice(0, cap + 1);
          const dropped = items.length > cap ? "at least one" : "";
          const used = items.slice(0, cap);
          step.status = "skipped";
          if (used.length === 0) {
            step.skipReason = "each: the previous group produced no items";
            continue;
          }
          step.skipReason = `expanded into ${used.length} item${used.length === 1 ? "" : "s"}`;
          step.events.push({
            t: new Date().toISOString(),
            type: "info",
            text:
              `fan-out: ${used.length} instance${used.length === 1 ? "" : "s"}` +
              (dropped ? ` (more items existed — capped at ${cap})` : ""),
          });
          const at = run.steps.indexOf(step);
          const instances: StepRecord[] = used.map((item) => ({
            ...step,
            each: undefined,
            max: undefined,
            skipReason: undefined,
            item,
            status: "pending",
            events: [],
            result: null,
            costUsd: null,
            attempts: 0,
          }));
          run.steps.splice(at + 1, 0, ...instances);
          ordered = orderedGroups();
        }
        save();

        // A person asked for this to stop. Checked between groups, off the
        // record rather than in memory, because the request arrives in
        // another process — the same way an approval decision does. The
        // sandbox for any in-flight step was already destroyed by stopRun;
        // this is what keeps the *next* group from starting.
        const stopCheck = readRun(tenant, workspace, run.id);
        if (stopCheck?.stopRequested) {
          for (const s of run.steps) {
            if (s.status === "pending" || s.status === "running") {
              s.status = "skipped";
              s.skipReason = "run stopped";
            }
          }
          run.status = "failed";
          run.stopRequested = true;
          save();
          break;
        }

        const freshGroup = ordered[gi];

        // Validate agents exist before launching the group.
        let missing = false;
        for (const step of freshGroup) {
          // Only what still has work to do. This walked every step in the
          // group regardless of status, which never showed on a fresh run
          // because they all start pending — but on a resumed one it rewrote
          // finished steps to `failed`, destroying the history it was
          // resuming around.
          if (step.status !== "pending") continue;
          const aDir = path.join(pDir, "agents", step.agent);
          if (!fs.existsSync(path.join(aDir, "agent.md"))) {
            step.status = "failed";
            step.events.push({
              t: new Date().toISOString(),
              type: "error",
              text: `agent "${step.agent}" not found in workspace`,
            });
            if (!step.optional) missing = true;
          }
        }
        save();
        if (missing) {
          run.status = "failed";
          break;
        }

        const ctx = context;

        // `when:` — skip a step whose condition isn't met by prior results.
        for (const step of freshGroup) {
          if (step.status !== "pending" || !step.when) continue;
          const met = (ctx ?? "").toLowerCase().includes(step.when.toLowerCase());
          if (!met) {
            step.status = "skipped";
            step.skipReason = `condition not met: when "${step.when}"`;
            step.events.push({
              t: new Date().toISOString(),
              type: "info",
              text: `skipped — previous results do not mention "${step.when}"`,
            });
          }
        }
        save();

        // `case:`/`else:` — exclusive routing. Of this group's case steps,
        // the FIRST whose text appears in the previous results runs; the
        // rest are routed past. `else:` runs only when no case matched.
        // (`when:` above stays independent — every matching when runs —
        // which is why routing is its own vocabulary instead of a mode.)
        const caseSteps = freshGroup.filter((s) => s.status === "pending" && s.case);
        if (caseSteps.length || freshGroup.some((s) => s.status === "pending" && s.else)) {
          let matchedCase: StepRecord | null = null;
          for (const step of caseSteps) {
            if (!matchedCase && (ctx ?? "").toLowerCase().includes(step.case!.toLowerCase())) {
              matchedCase = step;
              continue;
            }
            step.status = "skipped";
            step.skipReason = matchedCase
              ? `routed past — "${matchedCase.case}" matched first`
              : `case not matched: "${step.case}"`;
            step.events.push({
              t: new Date().toISOString(),
              type: "info",
              text: step.skipReason,
            });
          }
          for (const step of freshGroup) {
            if (step.status !== "pending" || !step.else) continue;
            if (matchedCase) {
              step.status = "skipped";
              step.skipReason = `routed past — "${matchedCase.case}" matched`;
              step.events.push({ t: new Date().toISOString(), type: "info", text: step.skipReason });
            }
          }
          save();
        }

        // Approval gate — pause the whole run until a human decides. The run
        // record is the queue: it sits in awaiting-approval until the API
        // flips the step back to pending.
        // `!s.approvedAt` — a step approved before the process went away is
        // already answered. Filtering on status alone asked again.
        const needsApproval = freshGroup.filter(
          (s) => s.status === "pending" && s.approve && !s.approvedAt,
        );
        if (needsApproval.length) {
          for (const step of needsApproval) {
            step.status = "awaiting-approval";
            step.events.push({
              t: new Date().toISOString(),
              type: "info",
              text: "waiting for approval before running",
            });
          }
          run.status = "awaiting-approval";
          save();

          if (opts.parkOnApproval) {
            // Hand the slot back. The approval API sees parkedAt and
            // re-enqueues; re-entering this loop skips finished groups and
            // lands back here with the decision already on the record.
            run.parkedAt = new Date().toISOString();
            parked = true;
            save();
            return;
          }

          const decided = await waitForDecision(tenant, workspace, run.id, needsApproval.map((s) => run.steps.indexOf(s)));
          if (!decided) {
            run.status = "failed";
            break;
          }
          // Re-read: the API rewrote the file, so refresh statuses in place.
          const latest = readRun(tenant, workspace, run.id);
          if (latest) {
            latest.steps.forEach((s, i) => {
              run.steps[i].status = s.status;
              run.steps[i].events = s.events;
            });
          }
          run.status = "running";
          save();
          if (freshGroup.every((s) => s.status !== "pending")) {
            // everything in this group was rejected
            if (freshGroup.some((s) => s.status === "failed" && !s.optional)) {
              run.status = "failed";
              break;
            }
            gi += 1;
            continue;
          }
        }

        await Promise.all(
          freshGroup
            .filter((s) => s.status === "pending")
            .map(async (step) => {
              const attempts = (step.retry ?? 0) + 1;
              for (let attempt = 1; attempt <= attempts; attempt++) {
                step.attempts = attempt;
                step.status = "running";
                save();
                await runStep(
                  path.join(pDir, "agents", step.agent),
                  tenant,
                  step,
                  ctx,
                  save,
                  modelOverride,
                  tags,
                  effortOverride,
                  run.id,
                );
                // runStep mutates step.status; read it through a widened local
                // so TS doesn't keep the "running" narrowing from above.
                const outcome: string = step.status;
                if (outcome !== "failed" || attempt === attempts) break;
                step.events.push({
                  t: new Date().toISOString(),
                  type: "info",
                  text: `attempt ${attempt} failed — retrying (${attempts - attempt} left)`,
                });
                save();
              }
            }),
        );

        const requiredFailed = freshGroup.some((s) => s.status === "failed" && !s.optional);
        if (requiredFailed) {
          run.status = "failed";
          break;
        }

        const results = freshGroup
          .filter((s) => s.status === "completed" && s.result)
          .map((s) =>
            s.item
              ? `## Result for item: ${s.item.slice(0, 80)} (${s.agent})\n\n${s.result}`
              : freshGroup.length > 1
                ? `## Result from ${s.agent}\n\n${s.result}`
                : s.result!,
          );
        groupResults[gi] = results.length ? results.join("\n\n") : null;

        // Evaluator loop: a completed step with `loop:` whose result lacks
        // its `until:` marker sends this group and the one before it around
        // again — at most `loop:` times, so the worst case is still readable
        // off the flow file. Approval marks survive the rewind: a person
        // answered, and the question has not changed.
        const looper = freshGroup.find((s) => s.loop && s.until && s.status === "completed");
        if (
          looper?.until &&
          !(looper.result ?? "").toLowerCase().includes(looper.until.toLowerCase())
        ) {
          if ((looper.loopRemaining ?? 0) > 0 && gi > 0) {
            looper.loopRemaining = (looper.loopRemaining ?? 0) - 1;
            looper.events.push({
              t: new Date().toISOString(),
              type: "info",
              text: `loop: result does not say "${looper.until}" — winding back one group (${looper.loopRemaining} cycle${looper.loopRemaining === 1 ? "" : "s"} left)`,
            });
            for (const s of [...ordered[gi - 1], ...freshGroup]) {
              if (s.status === "skipped" && s.each) continue; // an expanded template stays expanded
              s.status = "pending";
              s.result = null;
            }
            groupResults[gi] = null;
            groupResults[gi - 1] = null;
            save();
            gi -= 1;
            continue;
          }
          looper.status = "failed";
          looper.events.push({
            t: new Date().toISOString(),
            type: "error",
            text: `loop exhausted: after ${looper.loop} cycle${looper.loop === 1 ? "" : "s"} the result still does not say "${looper.until}"`,
          });
          save();
          if (!looper.optional) {
            run.status = "failed";
            break;
          }
        }

        gi += 1;
      }

      if (run.status === "running") run.status = "completed";
      for (const s of run.steps) if (s.status === "pending") s.status = "skipped";
    } catch (err) {
      run.status = "failed";
      run.steps.forEach((s) => {
        if (s.status === "running") {
          s.status = "failed";
          s.events.push({
            t: new Date().toISOString(),
            type: "error",
            text: err instanceof Error ? err.message : String(err),
          });
        }
      });
    } finally {
      if (!parked) {
        run.finishedAt = new Date().toISOString();
        // Archive before the next run resets outputs/ — a failed run's
        // artifacts are usually the most interesting ones, so this runs on
        // failure too.
        try {
          stampMemories();
          archive();
        } catch {
          // never let bookkeeping fail a run that already finished
        }
        // Whatever the run left in files/ becomes a stored file, stamped with
        // the run and the agent that wrote it — which is what lets the
        // dashboard answer "where did this PDF come from?" without a join
        // table. On failure too: a failed run's half-written artifact is
        // usually the one worth looking at.
        try {
          const { saved, errors } = await harvestFiles(
            tenant,
            workspace,
            `run:${run.id}`,
          );
          const last = run.steps.findLast((s) => s.status !== "pending") ?? run.steps[0];
          if (saved.length) {
            last?.events.push({
              t: new Date().toISOString(),
              type: "info",
              text: `files: saved ${saved.join(", ")}`,
            });
          }
          for (const e of errors) {
            last?.events.push({ t: new Date().toISOString(), type: "error", text: `files: ${e}` });
          }
        } catch {
          // same rule as archive(): bookkeeping never fails a finished run
        }
        save();
      }
    }
  })();
}

function readFlow(tenant: string, workspace: string, flowName: string) {
  const dir = path.join(workspaceDir(tenant, workspace), "flows");
  if (!fs.existsSync(dir)) return null;
  for (const f of fs.readdirSync(dir).filter((f) => f.endsWith(".md"))) {
    const flow = parseFlow(f, fs.readFileSync(path.join(dir, f), "utf8"));
    if (flow.name === flowName) return flow;
  }
  return null;
}

// Splice `[[flow:other]]` steps into the parent's step list, renumbering
// groups so the nested flow's own parallelism survives. Depth-limited, and
// a cycle raises rather than expanding forever.
function expandSubflows(
  tenant: string,
  workspace: string,
  steps: FlowStep[],
  seen: string[] = [],
  depth = 0,
): FlowStep[] {
  if (depth > 3) throw new Error("flow nesting too deep (max 3)");
  const out: FlowStep[] = [];
  let group = 0;
  for (const [i, step] of steps.entries()) {
    const startsNewGroup = i === 0 || step.group !== steps[i - 1].group;
    if (startsNewGroup) group += 1;

    if (!step.subflow) {
      out.push({ ...step, group });
      continue;
    }
    if (seen.includes(step.subflow)) {
      throw new Error(`flow cycle: ${[...seen, step.subflow].join(" → ")}`);
    }
    const nested = readFlow(tenant, workspace, step.subflow);
    if (!nested) throw new Error(`flow "${step.subflow}" not found`);
    const nestedSteps = expandSubflows(
      tenant,
      workspace,
      nested.steps,
      [...seen, step.subflow],
      depth + 1,
    );
    // Nested groups continue from here; the parent's next group follows them.
    const base = group - 1;
    let maxGroup = group;
    for (const ns of nestedSteps) {
      const g = base + ns.group;
      maxGroup = Math.max(maxGroup, g);
      out.push({
        ...ns,
        group: g,
        optional: ns.optional || step.optional,
        instruction: ns.instruction || step.instruction,
      });
    }
    group = maxGroup;
  }
  return out;
}

export function loadFlow(tenant: string, workspace: string, flowName: string) {
  const flow = readFlow(tenant, workspace, flowName);
  if (!flow) return null;
  if (!flow.steps.some((s) => s.subflow)) return flow;
  return { ...flow, steps: expandSubflows(tenant, workspace, flow.steps, [flowName]) };
}

// ---------------------------------------------------------------- recovery

/**
 * How long a run may sit in `running` with nobody touching it before it is
 * considered abandoned.
 *
 * Long enough that a slow model call is never mistaken for a dead process —
 * a single step can legitimately take minutes — and short enough that a
 * restarted server does not leave yesterday's run looking live.
 */
const ABANDONED_AFTER_MS = 30 * 60 * 1000;

/** The most recent moment a run showed any sign of life. */
function lastActivity(run: RunRecord): number {
  let latest = Date.parse(run.startedAt);
  for (const step of run.steps) {
    for (const event of step.events) {
      const t = Date.parse(event.t);
      if (t > latest) latest = t;
    }
  }
  return latest;
}

export interface Reconciliation {
  runId: string;
  tenant: string;
  workspace: string;
  /** What was done about it: closed as dead, or picked back up. */
  action: "closed" | "resumed";
  /** Steps that were mid-flight when the process went away. */
  interrupted: string[];
}

/**
 * Close out runs abandoned by a process that is no longer here.
 *
 * Runs execute in the server process, and nothing writes a terminal status
 * when that process goes away — so a deploy, a crash or a Ctrl-C during a run
 * leaves `status: "running"` on disk forever. The run history then contains
 * entries that are not merely stale but false: they claim to be in progress,
 * the dashboard renders them as live, and no one can tell them apart from a
 * step that is genuinely still thinking.
 *
 * Called at startup, before anything reads run history. A run still being
 * worked on by a live process is protected by the idle window, not by a lock —
 * so this is safe to call while runs are in flight, and deliberately
 * conservative about what it declares dead.
 *
 * A run genuinely waiting for a person is left alone: that state legitimately
 * outlives any process. A run whose person already answered is not waiting,
 * and is picked back up — see below.
 */
export function reconcileRuns(tenant: string, now = Date.now()): Reconciliation[] {
  const closed: Reconciliation[] = [];

  for (const workspace of listWorkspaces(tenant)) {
    for (const summary of listRuns(tenant, workspace.name)) {
      if (now - lastActivity(summary) < ABANDONED_AFTER_MS) continue;

      // Approved, then abandoned. Approval only writes to the run record; the
      // loop that acts on it polls in memory, inside the process that started
      // the run. If that process goes away between the click and the next
      // poll, the decision is on disk with nobody left to read it — and the
      // run sits in `awaiting-approval` with no step awaiting approval, so
      // the dashboard cannot even offer the button again. Nothing else here
      // rescues it: this status is exempt from being closed, by design.
      if (summary.status === "awaiting-approval") {
        const stillAsking = summary.steps.some((s) => s.status === "awaiting-approval");
        const answered = summary.steps.some((s) => s.approvedAt && s.status === "pending");
        if (stillAsking || !answered) continue;

        const run = readRun(tenant, workspace.name, summary.id);
        if (!run || run.status !== "awaiting-approval") continue;
        run.status = "running";
        writeRun(tenant, workspace.name, run);
        // Park at any *later* gate rather than poll: reconcile runs inside
        // long-lived server processes, where a 24h file-poll is exactly the
        // slot-burning the queue exists to avoid.
        void driveRun(tenant, workspace.name, run, null, run.tags ?? [], { parkOnApproval: true });
        closed.push({
          runId: run.id,
          tenant,
          workspace: workspace.name,
          action: "resumed",
          interrupted: [],
        });
        continue;
      }

      if (summary.status !== "running") continue;

      const run = readRun(tenant, workspace.name, summary.id);
      if (!run || run.status !== "running") continue;

      const interrupted: string[] = [];
      for (const step of run.steps) {
        if (step.status === "running") {
          interrupted.push(step.agent);
          step.status = "failed";
          step.events.push({
            t: new Date(now).toISOString(),
            type: "error",
            text: "interrupted — the process running this step went away before it finished",
          });
        } else if (step.status === "pending") {
          step.status = "skipped";
          step.skipReason = "the run was interrupted before this step started";
        }
      }

      run.status = "failed";
      run.finishedAt = new Date(now).toISOString();
      writeRun(tenant, workspace.name, run);
      closed.push({ runId: run.id, tenant, workspace: workspace.name, action: "closed", interrupted });
    }
  }

  return closed;
}

/**
 * The same, for every account this installation holds.
 *
 * A server reconciles on boot, and it boots for everyone — reconciling only
 * one hard-coded account left every other account's interrupted runs marked
 * `running` forever, with no process left to finish them.
 */
export function reconcileAllRuns(now = Date.now()): Reconciliation[] {
  return listTenants().flatMap((tenant) => reconcileRuns(tenant, now));
}

/**
 * Wait for a run to stop being in progress.
 *
 * Runs start and return immediately, which is right for a schedule and wrong
 * for a caller putting an agent behind their own request: they want the
 * answer, not a receipt. Polls the run record rather than holding a callback,
 * so it works from a different process than the one doing the work.
 *
 * `awaiting-approval` counts as stopping. It is not finished, but it is not
 * going to progress without a person, and a caller blocked on it would hang
 * for as long as the approval window allows.
 */
export async function waitForRun(
  tenant: string,
  workspace: string,
  runId: string,
  timeoutMs = 5 * 60_000,
): Promise<{ run: RunRecord | null; timedOut: boolean }> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const run = readRun(tenant, workspace, runId);
    if (!run) return { run: null, timedOut: false };
    // Queued counts as in flight — a caller asking to wait wants the result,
    // not a report that the worker hadn't picked the job up yet.
    if (run.status !== "running" && run.status !== "queued") return { run, timedOut: false };
    if (Date.now() >= deadline) return { run, timedOut: true };
    await new Promise((r) => setTimeout(r, 250));
  }
}

/**
 * What a run produced, for a caller that wanted an answer.
 *
 * The last step that actually returned something: a flow's final step is the
 * conclusion, and skipping back past steps that were skipped or produced
 * nothing is what makes `?wait=true` useful rather than merely blocking.
 */
export function runResult(run: RunRecord): string | null {
  for (let i = run.steps.length - 1; i >= 0; i--) {
    const r = run.steps[i].result;
    if (r && r.trim()) return r;
  }
  return null;
}
