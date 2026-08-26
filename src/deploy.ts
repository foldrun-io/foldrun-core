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
  workspaceDir,
  listRuns,
  parseFlow,
  WORKSPACE_DIRS,
  assertSafeName,
  type DeployFile,
} from "./store.ts";
import { conformanceIssues } from "./okf.ts";

/** Directories a deploy never reads out of a source tree. */
const NOT_SOURCE = new Set([".git", "node_modules", "runs", "outputs", ".foldrun", ".results"]);

/** Files that are never part of a workspace, whatever directory they sit in. */
const NOT_SOURCE_FILE = new Set([".DS_Store", "secrets.json"]);

const IN_WORKSPACE_DIR = new RegExp(`^(${WORKSPACE_DIRS.join("|")})/`);

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
  /** Set when a run is in flight, which blocks the swap. */
  blockedBy: string[];
}

export interface DeployResult extends DeployPlan {
  applied: boolean;
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
export function readTree(dir: string): DeployFile[] {
  const root = path.resolve(dir);
  const out: DeployFile[] = [];

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
        out.push({ path: next, content: fs.readFileSync(full, "utf8") });
      }
    }
  };

  walk(root, "");
  return out;
}

/**
 * Everything wrong with an incoming workspace, before any of it is live.
 *
 * Deliberately the same questions `foldrun check` asks, against files that are
 * not on disk yet. A deploy that would leave the workspace failing its own
 * checker should not be a deploy.
 */
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
  if (agents.size === 0) {
    at("agents/", "no agents — a workspace needs at least one agents/<name>/agent.md");
  }

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
  return listRuns(tenant, workspace)
    .filter((r) => r.status === "queued" || r.status === "running" || r.status === "awaiting-approval")
    .map((r) => r.id);
}

/** What a deploy would do, without doing it. */
export function planDeploy(tenant: string, workspace: string, files: DeployFile[]): DeployPlan {
  const dir = workspaceDir(tenant, workspace);
  const shipped = new Map(files.map((f) => [path.normalize(f.path), f.content]));

  const present = new Set<string>();
  if (fs.existsSync(dir)) {
    for (const entry of fs.readdirSync(dir, { recursive: true })) {
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

  // What saveWorkspace will keep regardless — reporting these as removals
  // would be a lie, and the alarming kind.
  const kept = (rel: string) =>
    /(^|\/)state\//.test(rel) || /(^|\/)memory\/[^/]+\.md$/.test(rel);
  const removed = [...present].filter((rel) => !shipped.has(rel) && !kept(rel));

  return {
    files,
    added: added.sort(),
    updated: updated.sort(),
    removed: removed.sort(),
    issues: deployIssues(files),
    blockedBy: runsInFlight(tenant, workspace),
  };
}

export interface DeployOptions {
  /** The commit these files came from, recorded so the dashboard can show it. */
  commit?: string | null;
  /** Apply even while runs are in flight. */
  force?: boolean;
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

  const plan = planDeploy(tenant, workspace, files);
  const blocked = plan.blockedBy.length > 0 && !opts.force;
  if (plan.issues.length > 0 || blocked) {
    return { ...plan, applied: false, commit: null, preserved: 0 };
  }

  const { preserved } = saveWorkspace(tenant, workspace, files);
  const commit = opts.commit ?? null;
  if (commit) writeDeployedCommit(tenant, workspace, commit);
  return { ...plan, applied: true, commit, preserved };
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
