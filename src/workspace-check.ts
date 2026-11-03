// One workspace's findings, as the Checks page, `GET …/check` and the daily
// rescan see them (FOL-58): the deploy's checks and the whole scanner, with
// what the files alone do not carry — the account's network: and the
// outward tools of the library and the workspace, nearest wins.

import { accountDir, workspaceDir, workspaceTools, type OutwardMark } from "./store.ts";
import { readAgentsMdKeys } from "./agents-md.ts";
import { libraryTools } from "./library.ts";
import { checkFiles, readTree } from "./deploy.ts";
import type { DeployFile } from "./store.ts";
import type { ScanFinding, ScanOptions } from "./scan.ts";
import { platform } from "./platform.ts";
import { SUPPLY_TITLES, effortRunsAs } from "./model-supply.ts";
import { resolveTier, parseProvider } from "./store.ts";

/** What the checks read of a workspace, at most. Data (state/ and memory/,
 *  what agents write) past these is left out and named; the rest past its
 *  budget is not read at all (TreeTooLarge). On 20 Oct 2026 the daily
 *  rescan read 1.2 GB of one desk's state/ into a 2 GB heap and crash-looped
 *  the worker. The rest is 64 MiB because a deploy is 10 MiB a push. */
export const CHECK_LIMITS = {
  maxDataFileBytes: 5 * 1024 * 1024,
  maxDataBytes: 32 * 1024 * 1024,
  maxDataFiles: 5000,
  maxSourceBytes: 64 * 1024 * 1024,
} as const;

/** A workspace as the checks read it: the deploy's tree within CHECK_LIMITS.
 *  Read once and hand it to everything that checks. */
export function checkTree(dir: string, onSkip?: (path: string, bytes: number) => void): DeployFile[] {
  return readTree(dir, { ...CHECK_LIMITS, onSkip });
}

export function checkOptions(tenant: string, workspace: string): ScanOptions {
  const tools = { ...libraryTools(tenant), ...workspaceTools(tenant, workspace) };
  const outwardTools = Object.entries(tools).filter(([, d]) => (d as OutwardMark).outward === true).map(([n]) => n);
  // AGENTS.md, or the older project.md, as the runner reads it (Codex review).
  const accountKeys = readAgentsMdKeys(accountDir(tenant));
  const accountNetwork = accountKeys.network;
  return { outwardTools, accountNetwork, ...effortCheck(tenant, accountKeys.provider) };
}

/**
 * What an effort level runs at on the account's choice, for
 * config/effort-fitted — when that choice is foldrun's models (a provider
 * and its tiers the platform knows). An account AGENTS.md provider: block
 * runs instead, and its own key's models are not the platform's to say.
 */
function effortCheck(tenant: string, accountProvider: unknown): Pick<ScanOptions, "effortRunsAs" | "outputCeiling"> {
  if (parseProvider(accountProvider)?.baseUrl) return {};
  let answer: ReturnType<NonNullable<typeof platform.modelSupply>> | undefined;
  try {
    answer = platform.modelSupply?.(tenant);
  } catch {
    return {};
  }
  if (!answer || answer.kind !== "foldrun") return {};
  const { provider, tiers } = answer;
  const on = `foldrun's models (${SUPPLY_TITLES[provider]})`;
  return {
    effortRunsAs: (model, effort) => {
      const tier = resolveTier(model);
      const id = tier ? tiers[tier as "fast" | "default" | "max"] : model;
      if (!id) return null; // a Claude tier word: Claude takes every level
      const runs = effortRunsAs(provider, id, effort);
      return runs ? { effort: runs, model: id, on } : null;
    },
    outputCeiling: (model) => {
      const tier = resolveTier(model);
      const id = tier ? tiers[tier as "fast" | "default" | "max"] : model;
      const ceiling = id ? answer.ceilings?.[id] : undefined;
      return id && ceiling ? { ceiling, model: id, on } : null;
    },
  };
}

export function checkWorkspace(tenant: string, workspace: string, tree: DeployFile[] = checkTree(workspaceDir(tenant, workspace))): ScanFinding[] {
  return checkFiles(tree, checkOptions(tenant, workspace));
}
