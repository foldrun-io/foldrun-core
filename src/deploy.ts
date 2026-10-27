// Deploying a workspace from a directory — the git-push half of the platform.
//
// A workspace is markdown, so there is nothing to build. Deploy is "make the
// files on disk match the commit", which is a copy plus two things a copy
// cannot do on its own:
//
//   1. Check first. Everything here is declarative, so the whole workspace can
//      be validated before any of it is live — a broken flow is caught at push
//      time rather than at 3am when its schedule fires. A platform deploying
//      compiled code cannot do this cheaply. We can, and it is the reason to
//      route deploys through here instead of writing files directly.
//
//   2. Refuse at the wrong moment. Swapping files under a running flow means
//      step 3 reads agents that step 1 never saw.
//
// What a deploy must NOT touch is already settled by saveWorkspace: runs/,
// state/, secrets.json, and any memory an agent wrote that the push doesn't
// mention. Those are the platform's, not git's. This module decides whether a
// deploy happens at all; saveWorkspace decides what survives it.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  saveWorkspace,
  keptOnDeploy,
  workspaceDir,
  listRunSummaries,
  listWorkspaceFiles,
  parseFlow,
  parseToolDef,
  WORKSPACE_DIRS,
  assertSafeName,
  type DeployFile,
  notifyWorkspaceChanged,
  accountDir,
  frontmatterErrorText,
} from "./store.ts";
import { readAgentsMdKeys } from "./agents-md.ts";
import { libraryTools } from "./library.ts";
import { lintFlow, regexProblem } from "./flow-lint.ts";
import { parseEval } from "./evals.ts";
import { refNames } from "./refs.ts";
import { SUBAGENT_IMPORT_DIRS } from "./kinds.ts";
import matter, { configMatter } from "./matter.ts";
import { frontmatterProblems, schemaKindOf } from "./frontmatter-schema.ts";
import { conformanceIssues } from "./okf.ts";
import { timezoneProblem } from "./clock.ts";
import { webProblems, webWarnings, runnerEngines } from "./providers.ts";
import { readLimits } from "./limits.ts";
import { parseAlerts } from "./alerts.ts";
import { parseTelemetry } from "./otel-config.ts";
import { parseJudge } from "./judge-verdict.ts";
import { networkProblems } from "./network.ts";
import { actionProblems } from "./web-actions.ts";
import { languageProblem } from "./language.ts";
import { localeProblems } from "./locale.ts";
import { entriesNoFollow } from "./paths.ts";
import { filterIgnored, findingFingerprint, ruleForWhere, scanFiles, scanRule, STRICT_FRONTMATTER_PATH, type ScanFinding, type ScanOptions } from "./scan.ts";

/** Directories a deploy never reads out of a source tree. */
// `.cache` is what a run's tools leave in an agent's folder (HOME is that
// folder): logs and font caches, never authored.
const NOT_SOURCE = new Set([".git", "node_modules", "runs", "outputs", ".foldrun", ".results", ".cache"]);

/** Files that are never part of a workspace, whatever directory they sit in. */
const NOT_SOURCE_FILE = new Set([".DS_Store", "secrets.json"]);

const IN_WORKSPACE_DIR = new RegExp(`^(${WORKSPACE_DIRS.join("|")})/`);

/**
 * Is this path, relative to a workspace root, one `readTree` would carry?
 *
 * The same question the walk above asks, asked of a path that is not on this
 * machine — what the platform lists for a workspace, so `foldrun status` and
 * `foldrun pull` compare like with like. Without it the comparison counted
 * every run artefact and bookkeeping file the platform keeps as a local
 * deletion, and every status was a wall of red.
 */
export function isSourcePath(rel: string): boolean {
  const norm = rel.replaceAll("\\", "/");
  const parts = norm.split("/");
  if (parts.some((p) => NOT_SOURCE.has(p))) return false;
  if (NOT_SOURCE_FILE.has(parts[parts.length - 1])) return false;
  return norm === "AGENTS.md" || norm === "project.md" || IN_WORKSPACE_DIR.test(norm);
}

export interface DeployIssue {
  where: string;
  message: string;
}

export interface DeployPlan {
  files: DeployFile[];
  /** Paths present now that the push does not ship — they will be removed. */
  removed: string[];
  added: string[];
  updated: string[];
  /** Empty when the deploy is safe to apply. */
  issues: DeployIssue[];
  /** Advisory, non-blocking: a deploy proceeds with these. Today this is
   *  the outward-without-a-gate lint — the same one `foldrun check` fails
   *  on, surfaced here so a push over the API is not the last to hear it. */
  warnings: DeployIssue[];
  /** Set when a run is in flight, which blocks the swap. */
  blockedBy: string[];
}

export interface DeployResult extends DeployPlan {
  applied: boolean;
  /** Set when `expectRemoved` was given and the deploy would have removed
   *  paths outside it: those paths. The deploy was refused, nothing changed. */
  unexpectedRemovals?: string[];
  /** The commit this workspace is now running, when the caller knows it. */
  commit: string | null;
  preserved: number;
}

/**
 * Read a directory into the file list a deploy ships.
 *
 * Only what a workspace is made of: AGENTS.md and the tracked directories.
 * Everything else in the repo — a README, .github/, a package.json — is
 * skipped rather than rejected, because a workspace living in a repo alongside
 * other things is the normal case, not an error.
 */
// Where single-file subagents authored by other tools are found — declared
// with the kinds (kinds.ts), which the copy-back rule reads too.
export { SUBAGENT_IMPORT_DIRS };

/** What agents write as they run, not what anyone authored: state/ and
 *  memory/, the workspace's or one agent's. */
const DATA_PATH = /^(?:agents\/[^/]+\/)?(?:state|memory)\//;

/** Bounds for a reader that only looks at the text (the checks, the
 *  assistant): on 20 Oct 2026 the daily rescan read one desk's 1.2 GB of
 *  state/ into a 2 GB heap and crash-looped the worker. A deploy sets none. */
export interface ReadTreeOptions {
  /** Data (DATA_PATH) larger than this is left out, unread. */
  maxDataFileBytes?: number;
  /** Data past this many bytes in all, or this many files, is left out. */
  maxDataBytes?: number;
  maxDataFiles?: number;
  /** Everything else past this many bytes in all: readTree throws
   *  TreeTooLarge rather than return a part of the definitions, which a
   *  check would read as missing agents and flows. */
  maxSourceBytes?: number;
  /** Each data file left out, and its size. */
  onSkip?: (path: string, bytes: number) => void;
}

export class TreeTooLarge extends Error {
  /** What an HTTP route answers with it. */
  readonly status = 413;
}

export function readTree(dir: string, opts: ReadTreeOptions = {}): DeployFile[] {
  const root = path.resolve(dir);
  const out: DeployFile[] = [];
  let dataBytes = 0;
  let dataFiles = 0;
  let sourceBytes = 0;
  /** May this file be read? Data over its budget is left out; source over
   *  its budget ends the read. */
  const admit = (rel: string, bytes: number): boolean => {
    if (DATA_PATH.test(rel)) {
      const over =
        (opts.maxDataFileBytes !== undefined && bytes > opts.maxDataFileBytes) ||
        (opts.maxDataBytes !== undefined && dataBytes + bytes > opts.maxDataBytes) ||
        (opts.maxDataFiles !== undefined && dataFiles >= opts.maxDataFiles);
      if (over) {
        opts.onSkip?.(rel, bytes);
        return false;
      }
      dataBytes += bytes;
      dataFiles++;
      return true;
    }
    sourceBytes += bytes;
    if (opts.maxSourceBytes !== undefined && sourceBytes > opts.maxSourceBytes) {
      throw new TreeTooLarge(`the workspace's files other than state/ and memory/ are over ${Math.round(opts.maxSourceBytes / 1048576)} MiB — not read`);
    }
    return true;
  };

  const walk = (abs: string, rel: string) => {
    let entries: string[];
    try {
      entries = fs.readdirSync(abs).sort();
    } catch {
      return;
    }
    for (const entry of entries) {
      if (NOT_SOURCE.has(entry) || NOT_SOURCE_FILE.has(entry)) continue;
      const full = path.join(abs, entry);
      const next = rel ? `${rel}/${entry}` : entry;
      // Never follow a link out of the tree — the same rule the file listing
      // uses, for the same reason.
      let stat: fs.Stats;
      try {
        if (fs.lstatSync(full).isSymbolicLink()) continue;
        stat = fs.statSync(full);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        walk(full, next);
      } else if (next === "AGENTS.md" || next === "project.md" || IN_WORKSPACE_DIR.test(next)) {
        if (!admit(next, stat.size)) continue;
        out.push({ path: next, content: fs.readFileSync(full, "utf8") });
      }
    }
  };

  walk(root, "");

  // Bridge single-file subagents authored by ANY coding tool into the folder
  // shape the runtime expects. The cross-client, vendor-neutral location is
  // `.agents/agents/<name>.md` — the same `.agents/` root as `.agents/skills/`
  // — and it is scanned first. A tool's own location (only `.claude/agents/`
  // so far, as the one that ships single-file subagents) is scanned after, for
  // pragmatic compatibility; add another vendor here when one appears, never
  // ahead of the neutral location. A subagent's frontmatter — name,
  // description, tools, model, effort, skills, mcpServers, disallowedTools — is
  // already what a foldrun agent reads, so each maps to agents/<name>/agent.md
  // with its content unchanged. A native agents/<name>/agent.md always wins,
  // and the neutral location wins over a vendor one; the import only fills a
  // gap, so authoring elsewhere and deploying here needs no rewrite. Unknown
  // vendor-only keys (permissionMode, hooks, …) are ignored, as every other
  // frontmatter reader here ignores what it does not use.
  const nativeAgent = new Set(
    out.filter((fEntry) => /^agents\/[^/]+\/agent\.md$/.test(fEntry.path)).map((fEntry) => fEntry.path),
  );
  for (const importDir of SUBAGENT_IMPORT_DIRS) {
    let entries: string[];
    try {
      entries = fs.readdirSync(path.join(root, importDir)).sort();
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.endsWith(".md")) continue;
      const name = entry.replace(/\.md$/, "");
      const target = `agents/${name}/agent.md`;
      // Native wins; and .claude/agents beats .agents/agents on a name clash
      // (it is scanned first and this skips a path already imported).
      if (nativeAgent.has(target) || out.some((fEntry) => fEntry.path === target)) continue;
      const full = path.join(root, importDir, entry);
      try {
        const st = fs.lstatSync(full);
        if (st.isSymbolicLink()) continue;
        if (!admit(target, st.size)) continue;
        out.push({ path: target, content: fs.readFileSync(full, "utf8") });
      } catch (err) {
        if (err instanceof TreeTooLarge) throw err;
        // an unreadable import is skipped, not fatal
      }
    }
  }

  return out;
}

/**
 * Everything wrong with an incoming workspace, before any of it is live.
 *
 * Deliberately the same questions `foldrun check` asks, against files that are
 * not on disk yet. A deploy that would leave the workspace failing its own
 * checker should not be a deploy.
 */
/** Best-effort warnings for a deploy: an agent's `web:` warnings (see
 *  webWarnings), and the outward gate — a step whose agent grants
 *  a workspace tool marked `outward: true` and has no `verify:`/gate. Reads
 *  only the deployed files, so a library or gallery outward tool is not seen
 *  here — `foldrun check`, which resolves every scope, remains the real gate.
 *  Non-blocking by decision: the deploy proceeds and says so. */
/**
 * A frontmatter block that lost its opening `---`: `key: value` lines, then a
 * lone `---`, with nothing above them. Nothing is read from it — the parser
 * sees prose — so the agent runs with no tools and the default model, and a
 * model told to call a tool it was never given writes the call out as text.
 * seo-digest's editor did that every Sunday from 20 Sep to 5 Oct 2026.
 * Returns the problem, or null.
 */
export function unopenedFrontmatter(raw: string): string | null {
  const text = raw.replace(/^\uFEFF/, "");
  if (/^---\r?\n/.test(text)) return null;
  const lines = text.split(/\r?\n/);
  const close = lines.findIndex((l) => l.trim() === "---");
  if (close < 1) return null;
  const above = lines.slice(0, close).filter((l) => l.trim() && !l.trim().startsWith("#"));
  if (!above.length || !above.every((l) => /^[A-Za-z_][\w-]*:(\s|$)/.test(l) || /^\s+\S/.test(l))) return null;
  return "the frontmatter has no opening `---`, so none of it is read: the agent runs with no tools and the default model. Add `---` as the first line.";
}

/**
 * What a deploy says but does not refuse: the structural warnings below, and
 * the scanner's findings about what should not be in the files at all — a
 * credential written in, text a reviewer cannot see. The scanner's design
 * advice (an agent that could leak, an unpinned package) is for `foldrun
 * check` and the Checks page, not for every deploy's output.
 */
/**
 * What `deploy_block:` in AGENTS.md refuses (FOL-58). `none`, the default:
 * the scanner's findings are warnings and the deploy goes ahead, as it always
 * did. `secrets`: a key or password written into a file is refused.
 * `security`: every security finding is — secrets, hidden or injected text,
 * the lethal trifecta, pipe-to-shell, an unpinned MCP server, a step that
 * acts outside with no check or approval. A
 * `foldrun-ignore` with a reason still accepts one.
 */
export const DEPLOY_BLOCK_MODES = ["none", "secrets", "security"] as const;
export type DeployBlockMode = (typeof DEPLOY_BLOCK_MODES)[number];

const blockMode = (v: unknown): DeployBlockMode | null =>
  typeof v === "string" && (DEPLOY_BLOCK_MODES as readonly string[]).includes(v.trim()) ? (v.trim() as DeployBlockMode) : null;

/** The workspace's own AGENTS.md, else the account's, else none. */
export function deployBlockMode(files: DeployFile[], accountKeys: Record<string, unknown>): DeployBlockMode {
  // project.md is the older name readAgentsMdKeys still reads (Codex review).
  const own = files.find((f) => f.path === "AGENTS.md") ?? files.find((f) => f.path === "project.md");
  let fromWorkspace: DeployBlockMode | null = null;
  if (own) {
    try {
      fromWorkspace = blockMode((configMatter(own.content).data as Record<string, unknown>).deploy_block);
    } catch {
      // an AGENTS.md that does not parse is reported elsewhere
    }
  }
  return fromWorkspace ?? blockMode(accountKeys.deploy_block) ?? "none";
}

function blockersFor(tenant: string, given: DeployFile[]): DeployIssue[] {
  // The tree as it will be written: `./AGENTS.md` is saved as AGENTS.md, so
  // it is read as that here too (Codex review).
  // Two entries for one path: the save keeps the last, so this does too.
  const byPath = new Map<string, DeployFile>();
  for (const f of given) {
    // path.normalize, as saveWorkspace writes it (a backslash is a filename
    // character here, not a separator — Codex review).
    const p = path.normalize(f.path);
    byPath.set(p, { ...f, path: p });
  }
  const files = [...byPath.values()];
  const account = readAgentsMdKeys(accountDir(tenant));
  const mode = deployBlockMode(files, account);
  if (mode === "none") return [];
  // Nearest wins: a workspace tool of the same name replaces the library's,
  // and the scanner adds the workspace's own outward tools itself. Named as
  // the runtime names them — the definition's name:, else the file's.
  const ownTools = new Set<string>();
  for (const f of files) {
    const m = /^tools\/([^/]+?)(?:\/tool)?\.md$/.exec(f.path);
    if (!m) continue;
    let data: Record<string, unknown> = {};
    try {
      data = matter(f.content).data as Record<string, unknown>;
    } catch {
      continue; // unreadable: the runtime skips it and keeps the library's
    }
    // Only a definition the runtime accepts replaces the library's; an
    // invalid one is skipped there, and the library tool stays (Codex review).
    const def = parseToolDef(data, m[1], f.content);
    if (def) ownTools.add(def.name ?? m[1]);
  }
  const outwardTools = Object.entries(libraryTools(tenant))
    .filter(([n, d]) => (d as { outward?: boolean }).outward === true && !ownTools.has(n))
    .map(([n]) => n);
  return deployBlockers(files, mode, { accountNetwork: account.network, outwardTools });
}

/** The findings `mode` turns into refusals, as deploy issues. */
export function deployBlockers(files: DeployFile[], mode: DeployBlockMode, options: ScanOptions = {}): DeployIssue[] {
  if (mode === "none") return [];
  // Every finding checkFiles reports — the scanner's and the structural
  // ones, flow/outward-ungated among them (Codex review) — with the same
  // ignores honoured, kept by its rule's category.
  const categories = new Set(mode === "secrets" ? ["secret"] : ["secret", "content", "security", "supply-chain"]);
  return checkFiles(files, options)
    .filter((f) => f.level !== "info" && categories.has(scanRule(f.rule)?.category ?? ""))
    .map((f) => ({
      where: `${f.file}${f.line ? `:${f.line}` : ""}`,
      message: `${f.message} [${f.rule}] — refused: deploy_block: ${mode} in AGENTS.md`,
    }));
}

export function deployWarnings(files: DeployFile[]): DeployIssue[] {
  const scanned = scanFiles(files, { only: ["secret", "content"] })
    .filter((f) => f.level !== "info")
    .map((f) => ({ where: `${f.file}${f.line ? `:${f.line}` : ""}`, message: `${f.message} [${f.rule}]` }));
  return [...structuralWarnings(files), ...scanned];
}

/**
 * Everything the platform can say about a workspace's files, as findings
 * with rule ids: what a deploy refuses (errors), what it warns about, and the
 * whole scanner. The Checks page and `GET …/check` answer with this; `foldrun
 * check` asks more (it resolves every library and the platform's), so treat
 * this as the server's view of the same rules, not a second set.
 */
export function checkFiles(files: DeployFile[], options: ScanOptions = {}): ScanFinding[] {
  const finding = (i: DeployIssue, level: "error" | "warn", kind?: string): ScanFinding => {
    const m = /^(.*?)(?::(\d+))?(?: .*)?$/.exec(i.where);
    const file = m?.[1] || i.where;
    const rule = ruleForWhere(i.where, kind);
    return { rule, level, file, ...(m?.[2] ? { line: Number(m[2]) } : {}), message: i.message, fingerprint: findingFingerprint(rule, file, i.message) };
  };
  const own = [
    ...deployIssues(files).map((i) => finding(i, "error")),
    ...structuralWarnings(files, options.outwardTools).map((i) => finding(i, "warn", i.kind)),
  ];
  return [...filterIgnored(own, files), ...scanFiles(files, options)].sort(
    (a, b) => a.file.localeCompare(b.file) || (a.line ?? 0) - (b.line ?? 0) || a.rule.localeCompare(b.rule),
  );
}

function structuralWarnings(files: DeployFile[], extraOutward: Iterable<string> = []): (DeployIssue & { kind?: string })[] {
  const front = (content: string): Record<string, unknown> => {
    try { return matter(content).data as Record<string, unknown>; } catch { return {}; }
  };
  // Tools that change something outside the workspace: the workspace's own,
  // and the library's the caller resolved (nearest wins already applied).
  const outwardTools = new Set<string>(extraOutward);
  for (const f of files) {
    const m = f.path.match(/^tools\/([^/]+?)(?:\/tool)?\.md$/);
    if (!m) continue;
    const data = front(f.content);
    const def = parseToolDef(data, m[1], f.content);
    // `outward: true` is read off the frontmatter, the same test the runtime
    // and the CLI use; parseToolDef does not fold it onto the def.
    if (def && data.outward === true) outwardTools.add(def.name ?? m[1]);
    // A workspace tool that is not outward replaces a library one that was.
    else if (def) outwardTools.delete(def.name ?? m[1]);
  }
  // Agents that grant one of them.
  const outwardAgents: string[] = [];
  const agentNames: string[] = [];
  const out: (DeployIssue & { kind?: string })[] = [];
  if (!files.some((f) => /^agents\/[^/]+\/agent\.md$/.test(f.path)) && !files.some((f) => /^\.(claude|agents)\/agents\/[^/]+\.md$/.test(f.path))) {
    out.push({ where: "agents/", message: "no agents yet — add one (agents/<name>/agent.md), or import one from another workspace" });
  }
  // The web: warnings check prints — the old session: key, and a pinned
  // user agent behind the runner image's Chrome, which the platform knows
  // from FOLDRUN_RUNNER_ENGINES (the deploy read it from the image).
  const { chrome, chromium } = runnerEngines() ?? {};
  for (const f of files) {
    const m = f.path.match(/^agents\/([^/]+)\/agent\.md$/);
    if (!m) continue;
    agentNames.push(m[1]);
    const data = front(f.content);
    if (refNames(data.tools).some((t: string) => outwardTools.has(t))) outwardAgents.push(m[1]);
    for (const w of webWarnings(data, { chrome, chromium })) out.push({ where: f.path, message: w });
  }
  // An eval's `matches:` is the same JavaScript RegExp as a verify's; one
  // that does not compile fails its case on every run. Read through
  // parseEval, so a block scalar (`matches: |`) or a continued line is
  // tested as the runtime will run it. The line is the item's own: the
  // parsed assertions and the `- matches:` lines come in the same order.
  for (const f of files) {
    if (!/^evals\/[^/]+\.md$/.test(f.path)) continue;
    let info;
    try { info = parseEval(f.path, f.content); } catch { continue; }
    const lines: number[] = [];
    f.content.split("\n").forEach((line, n) => { if (/^\s*-\s*matches:/.test(line)) lines.push(n + 1); });
    // When a `- matches:` line sits outside a case (an example in the
    // prose), the order no longer pairs up: name the file, not a wrong line.
    const parsed = info.cases.reduce((n, c) => n + c.expect.filter((a) => a.type === "matches").length, 0);
    const pairs = lines.length === parsed;
    let k = 0;
    for (const c of info.cases) {
      for (const a of c.expect) {
        if (a.type !== "matches") continue;
        const at = pairs ? lines[k] : undefined;
        k++;
        const problem = regexProblem(a.value);
        if (problem) out.push({ where: at ? `${f.path}:${at}` : f.path, message: `case "${c.name}": matches: ${problem}` });
      }
    }
  }
  if (!outwardAgents.length) return out;
  for (const f of files) {
    if (!/^flows\/[^/]+\.md$/.test(f.path)) continue;
    let flow;
    try { flow = parseFlow(path.basename(f.path), f.content); } catch { continue; }
    for (const w of lintFlow(flow, { agents: agentNames, outwardAgents })) {
      if (w.kind === "outward") out.push({ where: `${f.path}${w.line ? `:${w.line}` : ""}`, message: w.message, kind: "outward" });
    }
  }
  return out;
}

export function deployIssues(files: DeployFile[]): DeployIssue[] {
  const issues: DeployIssue[] = [];
  const at = (where: string, message: string) => issues.push({ where, message });

  if (files.length === 0) at("/", "nothing to deploy — no workspace files in this tree");
  if (files.length > 500) at("/", `${files.length} files — a workspace is capped at 500`);

  // Path safety, as questions rather than exceptions: a push should report
  // everything wrong with it at once, not fail on the first bad path.
  for (const f of files) {
    const norm = path.normalize(f.path);
    if (norm.startsWith("..") || path.isAbsolute(norm) || norm.startsWith("runs")) {
      at(f.path, "illegal path");
    }
    const base = norm.split("/").pop() ?? norm;
    for (const want of ["AGENTS.md", "SKILL.md"]) {
      if (base !== want && base.toLowerCase() === want.toLowerCase()) {
        at(f.path, `must be spelled exactly "${want}" — the case is part of the standard`);
      }
    }
  }

  const agents = new Set<string>();
  for (const f of files) {
    const m = f.path.match(/^agents\/([^/]+)\/agent\.md$/);
    if (m) agents.add(m[1]);
  }

  // Frontmatter whose YAML does not parse is a file the runtime cannot read:
  // an agent with no tools and the default model, a flow that never fires,
  // a tool that is skipped. Refused where it was written. Until 20 Oct 2026
  // nothing said so — gray-matter's cache let a second parse pass — and one
  // such agent file kept the worker from booting for every account.
  // Definition files only: a skill is read leniently (an unquoted colon is
  // quoted and retried, matter.ts parseLenient), and the markdown beside a
  // definition — references, a tool's README — is prose, not frontmatter.
  // The scanner warns about skills and library files (config/invalid-frontmatter).
  for (const f of files) {
    if (!STRICT_FRONTMATTER_PATH.test(f.path)) continue;
    if (!/^\uFEFF?---\r?\n/.test(f.content)) continue;
    try {
      matter(f.content);
    } catch (err) {
      at(f.path, frontmatterErrorText(err));
    }
  }

  // The four job blocks (frontmatter-fields.ts JOB_FIELDS): a setting
  // written both at the top and in its block, or in another job's block, is
  // a setting that does not do what the file says — a guardrail under
  // governance: guards nothing — so the deploy refuses it as check does
  // (config/conflict, config/misplaced; Codex debate, 21 Oct 2026).
  for (const f of files) {
    const kind = schemaKindOf(f.path);
    if (kind !== "agent" && kind !== "flow" && kind !== "agents-md") continue;
    if (!/^\uFEFF?---\r?\n/.test(f.content)) continue;
    let front: Record<string, unknown>;
    try {
      front = configMatter(f.content).data as Record<string, unknown>;
    } catch {
      continue; // unparseable frontmatter is its own report
    }
    for (const p of frontmatterProblems(kind, front, () => null)) {
      if (p.level === "error" && (p.rule === "config/conflict" || p.rule === "config/misplaced")) at(f.path, `${p.message} [${p.rule}]`);
    }
  }

  // `timezone:` is read at four levels and a value nothing can parse falls
  // silently through to the level above — so it is refused where it was
  // written, not discovered as a date that is a day out.
  for (const f of files) {
    if (!/^(AGENTS\.md|agents\/[^/]+\/agent\.md)$/.test(f.path)) continue;
    const unopened = unopenedFrontmatter(f.content);
    if (unopened) at(f.path, unopened);
    let front: Record<string, unknown> = {};
    try {
      front = configMatter(f.content).data as Record<string, unknown>;
    } catch {
      continue; // unparseable frontmatter is its own report
    }
    const problem = timezoneProblem(front.timezone);
    if (problem) at(f.path, problem);
    // `schedule:` on an agent or AGENTS.md runs nothing — only a flow has a
    // clock. Refuse it where it was written rather than deploy it dead.
    if (front.schedule !== undefined) {
      at(f.path, "schedule: an agent has no schedule of its own — only a flow runs on a clock. Put schedule: on the flow that runs this agent, or remove it.");
    }
    // The same refusal check gives: a web key that cannot work never ships.
    for (const w of [...webProblems(front), ...actionProblems(front)]) at(f.path, w);
    // `limits:` that cannot be read — a count of 0, a word, web.<not an
    // action> — would run uncapped where the author meant a cap.
    for (const w of readLimits(front.limits).problems) at(f.path, w);
    // `network:` that cannot be read would leave the step on the level
    // above it — wider or narrower than the author wrote.
    for (const w of networkProblems(front.network)) at(f.path, w);
    // `alerts:` that cannot be read would never alert (FOL-72).
    for (const w of parseAlerts(front.alerts).problems) at(f.path, w);
    // `telemetry:` that cannot be read would never send — and a token
    // written into it would ship in the file.
    for (const w of parseTelemetry(front.telemetry).problems) at(f.path, w);
    // `judge:` that cannot be read would leave every judge on the default.
    for (const w of parseJudge(front.judge).problems) at(f.path, w);
    const lang = languageProblem(front.language);
    if (lang) at(f.path, lang);
    for (const w of localeProblems(front)) at(f.path, w);
  }
  // No agents is a workspace that has not started yet — "Create workspace"
  // makes exactly that — and deploying it is harmless: a flow that names an
  // agent this push lacks is refused below, step by step. deployWarnings says
  // it, so the empty state is visible without blocking the first push.

  // Flows, parsed from the incoming text rather than from disk. A step naming
  // an agent that this push does not ship is the single most common way a
  // deploy breaks a schedule, and it is free to catch here.
  const flows = files.filter((f) => /^flows\/[^/]+\.md$/.test(f.path));
  const flowNames = new Set<string>();
  for (const f of flows) {
    try {
      flowNames.add(parseFlow(path.basename(f.path), f.content).name);
    } catch {
      // reported below, when it is parsed for real
    }
  }
  for (const f of flows) {
    let parsed;
    try {
      parsed = parseFlow(path.basename(f.path), f.content);
    } catch (err) {
      at(f.path, err instanceof Error ? err.message : String(err));
      continue;
    }
    if (parsed.steps.length === 0) at(f.path, "no steps");
    for (const fp of parsed.frontProblems) at(f.path, fp);
    for (const s of parsed.steps) {
      const target = s.subflow ?? s.agent;
      const known = s.subflow ? flowNames.has(target) : agents.has(target);
      if (!known) {
        at(
          `${f.path}${s.line ? `:${s.line}` : ""}`,
          `[[${s.subflow ? "flow:" : ""}${target}]] does not exist in this deploy`,
        );
      }
    }
  }

  // An eval whose settings cannot be read: a `sample:` past 100, a grader
  // (`trigger: runs`) with a task nothing receives or a file:/run: check
  // that would act on the platform's host. Refused where they are written.
  for (const f of files) {
    if (!/^evals\/[^/]+\.md$/.test(f.path)) continue;
    let info;
    try { info = parseEval(f.path, f.content); } catch { continue; }
    for (const p of info.problems) at(f.path, p);
  }

  // OKF conformance, which needs the files as a tree. Staged in a temp
  // directory and thrown away — nothing touches the live workspace until every
  // check above has passed.
  const staged = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-stage-"));
  try {
    for (const f of files) {
      const norm = path.normalize(f.path);
      if (norm.startsWith("..") || path.isAbsolute(norm)) continue;
      const target = path.join(staged, norm);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, f.content);
    }
    for (const bundle of ["memory", "knowledge"]) {
      for (const { file, issue } of conformanceIssues(path.join(staged, bundle))) {
        at(`${bundle}/${file}`, issue);
      }
    }
    for (const agent of agents) {
      for (const bundle of ["memory", "knowledge"]) {
        const dir = path.join(staged, "agents", agent, bundle);
        for (const { file, issue } of conformanceIssues(dir)) {
          at(`agents/${agent}/${bundle}/${file}`, issue);
        }
      }
    }
  } finally {
    fs.rmSync(staged, { recursive: true, force: true });
  }

  return issues;
}

/**
 * Runs that make this a bad moment to swap the files under them.
 *
 * A flow reads its agents step by step. Replacing them mid-run means step 3
 * runs against a definition step 1 never saw, and the trace becomes a record
 * of two different workspaces. A run waiting on a person counts too: they are
 * about to approve work that the deploy would silently redefine.
 */
export function runsInFlight(tenant: string, workspace: string): string[] {
  if (!fs.existsSync(workspaceDir(tenant, workspace))) return [];
  return listRunSummaries(tenant, workspace)
    .filter((r) => r.status === "queued" || r.status === "running" || r.status === "awaiting-approval")
    .map((r) => r.id);
}

/** What a deploy would do, without doing it. */
export function planDeploy(tenant: string, workspace: string, files: DeployFile[], opts: { keepUntracked?: boolean } = {}): DeployPlan {
  const dir = workspaceDir(tenant, workspace);
  const shipped = new Map(files.map((f) => [path.normalize(f.path), f.content]));

  const present = new Set<string>();
  if (fs.existsSync(dir)) {
    for (const entry of entriesNoFollow(dir)) {
      const rel = String(entry).split(path.sep).join("/");
      if (NOT_SOURCE.has(rel.split("/")[0])) continue;
      if (/(^|\/)(runs|outputs|\.results)\//.test(rel)) continue;
      if (rel === "secrets.json") continue;
      try {
        if (!fs.statSync(path.join(dir, rel)).isFile()) continue;
      } catch {
        continue;
      }
      present.add(rel);
    }
  }

  const added: string[] = [];
  const updated: string[] = [];
  for (const [rel, content] of shipped) {
    if (!present.has(rel)) {
      added.push(rel);
      continue;
    }
    try {
      if (fs.readFileSync(path.join(dir, rel), "utf8") !== content) updated.push(rel);
    } catch {
      updated.push(rel);
    }
  }

  // What saveWorkspace will keep regardless — storage/, state/, agent
  // memory, the platform's own files. Reporting these as removals would be
  // a lie, and the alarming kind; one predicate serves both.
  const shippedPaths = new Set(shipped.keys());
  // keepUntracked (a restore): what is not editable source stays, as
  // saveWorkspace keeps it — see its meta.keepUntracked.
  const tracked = opts.keepUntracked ? new Set(listWorkspaceFiles(tenant, workspace)) : null;
  const removed = [...present].filter((rel) => !shipped.has(rel) && !keptOnDeploy(rel, shippedPaths) && (!tracked || tracked.has(rel)));

  return {
    files,
    added: added.sort(),
    updated: updated.sort(),
    removed: removed.sort(),
    // deploy_block: (FOL-58) turns the scanner's findings into refusals —
    // scanned with what the Checks page passes too: the account's network:
    // and the library's outward tools (Codex review).
    issues: [...deployIssues(files), ...blockersFor(tenant, files)],
    warnings: deployWarnings(files),
    blockedBy: runsInFlight(tenant, workspace),
  };
}

export interface DeployOptions {
  /** The commit these files came from, recorded so the dashboard can show it. */
  commit?: string | null;
  /** Attribution for the revision this deploy records. */
  by?: string;
  message?: string;
  /** Apply even while runs are in flight. */
  force?: boolean;
  /**
   * The removals a person confirmed from a dry run. When given, the deploy
   * is refused (applied: false, `unexpectedRemovals` set) if it would remove
   * anything not in this list — a run can write new storage/ outputs between
   * the question and the answer, and a yes to one list is not a yes to
   * another. Checked in the same synchronous call that writes, so there is
   * no window between the check and the swap. Absent: no check, as before.
   */
  expectRemoved?: string[];
  /** Keep what is not editable source (planDeploy, saveWorkspace): a
   *  restore takes history's tree, and history tracks source only. */
  keepUntracked?: boolean;
}

/**
 * Deploy a file list to a workspace, if it checks out.
 *
 * Returns the plan either way, with `applied` saying whether anything changed.
 * A refused deploy is a normal outcome, not an exception: the caller is a
 * webhook or a CLI that needs to report *why*, and every reason is already in
 * the plan.
 */
export function deployWorkspace(
  tenant: string,
  workspace: string,
  files: DeployFile[],
  opts: DeployOptions = {},
): DeployResult {
  assertSafeName(tenant, "tenant");
  assertSafeName(workspace, "workspace");

  const plan = planDeploy(tenant, workspace, files, { keepUntracked: opts.keepUntracked });
  const blocked = plan.blockedBy.length > 0 && !opts.force;
  if (plan.issues.length > 0 || blocked) {
    return { ...plan, applied: false, commit: null, preserved: 0 };
  }
  if (opts.expectRemoved) {
    const ok = new Set(opts.expectRemoved.map((p) => path.normalize(p).split(path.sep).join("/")));
    const unexpectedRemovals = plan.removed.filter((p) => !ok.has(p));
    if (unexpectedRemovals.length) {
      return { ...plan, applied: false, commit: null, preserved: 0, unexpectedRemovals };
    }
  }

  const { preserved } = saveWorkspace(tenant, workspace, files, { commit: opts.commit ?? null, by: opts.by ?? "deploy", message: opts.message, keepUntracked: opts.keepUntracked });
  const commit = opts.commit ?? null;
  if (commit) writeDeployedCommit(tenant, workspace, commit);
  return { ...plan, applied: true, commit, preserved }; // saveWorkspace told the platform
}

// Which commit a workspace is running.
//
// Outside the workspace directory on purpose: saveWorkspace replaces that
// directory wholesale, so a marker written inside it would be deleted by the
// very deploy it describes. It also is not a workspace file — nobody should
// see it in the file tree or be able to edit it.
const commitFile = (tenant: string, workspace: string) =>
  path.join(workspaceDir(tenant, workspace), "..", `.${workspace}.deployed`);

export function writeDeployedCommit(tenant: string, workspace: string, commit: string) {
  const f = commitFile(tenant, workspace);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, `${JSON.stringify({ commit, at: new Date().toISOString() })}\n`);
}

export function deployedCommit(
  tenant: string,
  workspace: string,
): { commit: string; at: string } | null {
  try {
    return JSON.parse(fs.readFileSync(commitFile(tenant, workspace), "utf8"));
  } catch {
    return null;
  }
}
