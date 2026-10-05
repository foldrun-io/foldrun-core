// Bring an agent you already have into another workspace of the same account.
//
// A new workspace starts blank (blankWorkspaceFiles), and the agents worth
// having in it are usually ones already written and tuned elsewhere — a
// researcher from one desk, a reviewer from another. Copying them by hand
// meant opening each file, and missing the skills and scripts that live in
// the agent's own folder. This copies the folder: what the agent IS, never
// what it has accumulated.
//
// Copied: agents/<name>/agent.md and everything authored beside it — its own
// skills/, scripts/, knowledge/. Not copied: memory/ (what it learned in the
// other workspace's runs), outputs/, state/, the step's workspace link, and
// the SDK's .claude session files. A fresh copy starts with no lessons that
// were about somebody else's desk.

import fs from "node:fs";
import path from "node:path";
import matter from "gray-matter";
import {
  assertSafeName,
  listWorkspaceFiles,
  readWorkspaceFile,
  writeWorkspaceFile,
  workspaceDir,
  workspaceTools,
  listWorkspaces,
} from "./store.ts";
import { libraryDir, libraryTools } from "./library.ts";
import { isRuntimeTool, toolEntryName } from "./tool-names.ts";
import { discoverSkills } from "./runner.ts";
import { listSecrets } from "./secrets.ts";

export interface AgentImportResult {
  /** The name the agent has in the target workspace. */
  name: string;
  /** Workspace-relative paths written. */
  files: string[];
  /** What the copy refers to that the target workspace does not have. The
   *  import still happens: a missing secret is set in a minute, and refusing
   *  would make the person copy the file by hand instead. */
  warnings: string[];
}

/** An error the API layer turns into a status rather than a 500. */
export class AgentImportError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

/** Accumulated or generated, not authored — never carried to another workspace. */
const NOT_COPIED = /^agents\/[^/]+\/(memory|outputs|state|workspace|\.claude)(\/|$)|^agents\/[^/]+\/\.claude\.json$/;

/** The files `importAgent` would copy, without writing anything. */
export function agentSourceFiles(tenant: string, from: string, agent: string): string[] {
  const prefix = `agents/${agent}/`;
  return listWorkspaceFiles(tenant, from).filter((p) => p.startsWith(prefix) && !NOT_COPIED.test(p));
}

const list = (v: unknown): string[] =>
  Array.isArray(v) ? v.map((x) => toolEntryName(x)).filter(Boolean) : typeof v === "string" && v.trim() ? [v.trim()] : [];

export function importAgent(
  tenant: string,
  from: string,
  agent: string,
  to: string,
  opts: { as?: string; by?: string } = {},
): AgentImportResult {
  assertSafeName(from, "workspace");
  assertSafeName(to, "workspace");
  assertSafeName(agent, "agent");
  const name = opts.as?.trim() || agent;
  assertSafeName(name, "agent");
  const known = new Set(listWorkspaces(tenant).map((w) => w.name));
  if (!known.has(from)) throw new AgentImportError(`no workspace called "${from}" in this account`, 404);
  if (!known.has(to)) throw new AgentImportError(`no workspace called "${to}" in this account`, 404);
  if (from === to && name === agent) {
    throw new AgentImportError(`${agent} is already in ${to} — give the copy another name with "as"`, 409);
  }

  const files = agentSourceFiles(tenant, from, agent);
  if (!files.includes(`agents/${agent}/agent.md`)) {
    throw new AgentImportError(`no agent called "${agent}" in ${from}`, 404);
  }
  if (fs.existsSync(path.join(workspaceDir(tenant, to), "agents", name))) {
    throw new AgentImportError(
      `${to} already has an agent called "${name}" — import it under another name with "as"`,
      409,
    );
  }

  const written: string[] = [];
  const message = `import agents/${agent} from ${from}${name !== agent ? ` as ${name}` : ""}`;
  let front: Record<string, unknown> = {};
  for (const src of files) {
    let content = readWorkspaceFile(tenant, from, src);
    const rel = src.slice(`agents/${agent}/`.length);
    if (rel === "agent.md") {
      front = matter(content).data as Record<string, unknown>;
      // The folder is the name flows address; a `name:` that disagrees with
      // it is the first thing check would complain about.
      if (name !== agent) content = content.replace(/^(---\r?\n(?:[\s\S]*?\r?\n)?)name:[^\n]*$/m, `$1name: ${name}`);
    }
    const dest = `agents/${name}/${rel}`;
    writeWorkspaceFile(tenant, to, dest, content, { ...(opts.by ? { by: opts.by } : {}), message });
    written.push(dest);
  }

  return { name, files: written, warnings: missingFor(tenant, to, name, front) };
}

/** What the imported agent names that the target workspace cannot provide. */
function missingFor(tenant: string, to: string, name: string, front: Record<string, unknown>): string[] {
  const out: string[] = [];
  const ws = workspaceDir(tenant, to);

  const tools = { ...libraryTools(tenant), ...workspaceTools(tenant, to) };
  const noTool = list(front.tools).filter((t) => !isRuntimeTool(t) && !tools[t]);
  if (noTool.length) out.push(`tools not in ${to} or the account library: ${noTool.join(", ")} — import or add them under tools/`);

  const skills = new Set<string>();
  for (const [base, sub] of [
    [path.join(ws, "agents", name), "skills"],
    [ws, "skills"],
    [ws, ".agents/skills"],
    [libraryDir(tenant), "skills"],
  ] as const) {
    for (const s of discoverSkills(base, sub)) skills.add(s.name);
  }
  const noSkill = list(front.skills).filter((s) => !skills.has(s));
  if (noSkill.length) out.push(`skills not in ${to} or the account library: ${noSkill.join(", ")}`);

  const scripts = list(front.scripts).filter(
    (s) =>
      !fs.existsSync(path.join(ws, "agents", name, "scripts", s)) &&
      !fs.existsSync(path.join(ws, "scripts", s)) &&
      !fs.existsSync(path.join(libraryDir(tenant), "scripts", s)),
  );
  if (scripts.length) out.push(`scripts not in ${to}: ${scripts.join(", ")} — copy them into scripts/`);

  let have: Set<string>;
  try {
    have = new Set(listSecrets(tenant, to).map((s) => s.name));
  } catch {
    have = new Set();
  }
  const noSecret = list(front.secrets).filter((s) => !have.has(s));
  if (noSecret.length) out.push(`secrets not set for ${to}: ${noSecret.join(", ")} — add them with \`foldrun secrets set\` or Settings → Secrets`);

  return out;
}
