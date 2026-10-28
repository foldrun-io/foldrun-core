// What a run's sandbox may hand back to the workspace (FOL-96, 27 Oct 2026).
//
// A step's file changes come back from its sandbox (run-container.ts
// applyContainerChanges — the docker and the k8s runner both), and until now
// everything came back that was not platform-owned, knowledge or hooks. So a
// step steered by a page it read could rewrite AGENTS.md, an agent.md or a
// flow — its own tools:, network:, a provider: block, a new scheduled flow —
// and every later run, the next step of the same run included, ran on it.
//
// Configuration and code are a person's to change. A step that wants a
// change proposes it (Proposed fixes, the assistant), and a person applies
// it; a step that writes one anyway has the write refused, and the run's
// trail names it. What steps legitimately write — state/, memory/, storage/,
// an agent's own outputs — comes back as before.
//
// The list is not written here. It is read off the kinds (kinds.ts), whose
// every row must say what its files are, so a kind added later is classified
// the moment it exists — tsc refuses a row without `copyBack`.

import { KINDS, ALL_KINDS, SUBAGENT_IMPORT_DIRS, WORKSPACE_CONFIG_FILES, type CopyBackClass, type Kind } from "./kinds.ts";

/** A path a step changed that was not taken back, and why. */
export interface RefusedPath {
  path: string;
  kind: "config" | "code";
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const NAME = "\u0000";

/** Where an agent's own folder is — the scope agent-level kinds live under. */
const AGENT_SCOPE = KINDS.agents.file(NAME).split(NAME)[0]; // "agents/"

/** The path shapes one kind's files take, inside a workspace. */
export function kindPatterns(kind: Kind): RegExp[] {
  const meta = KINDS[kind];
  const file = meta.file(NAME);
  // An agent's folder is a scope as well as a document: everything else in
  // it is the agent's working directory. Its document is the one file.
  if (kind === "agents") {
    const [head, tail] = file.split(NAME);
    return [new RegExp(`^${escape(head)}[^/]+${escape(tail)}$`)];
  }
  // Every other kind owns its top-level folder — a file document's siblings
  // (a tool's script beside its .md) and a folder document's contents alike.
  const root = file.split("/")[0];
  const out = [new RegExp(`^${escape(root)}/`)];
  if (meta.scopes.includes("agent")) out.push(new RegExp(`^${escape(AGENT_SCOPE)}[^/]+/${escape(root)}/`));
  return out;
}

const RULES: { re: RegExp; kind: "config" | "code" }[] = [
  ...WORKSPACE_CONFIG_FILES.map((f) => ({ re: new RegExp(`^${escape(f)}$`), kind: "config" as const })),
  // Single-file subagents another tool wrote: a deploy imports them as agents.
  ...[...new Set(SUBAGENT_IMPORT_DIRS.map((d) => d.split("/")[0]))].map((d) => ({ re: new RegExp(`^${escape(d)}/`), kind: "config" as const })),
  ...ALL_KINDS.flatMap((k) => {
    const cls: CopyBackClass = KINDS[k].copyBack;
    return cls === "data" ? [] : kindPatterns(k).map((re) => ({ re, kind: cls }));
  }),
];

/** Whether a step's write to `rel` (workspace-relative) is refused on the way
 *  back, and as what; null when it is data and may come back. */
export function refusedBack(rel: string): "config" | "code" | null {
  const norm = rel.replaceAll("\\", "/").replace(/^\.\//, "");
  for (const r of RULES) if (r.re.test(norm)) return r.kind;
  return null;
}

/** The trail's line for a step's refused writes. */
/** The trail's line for config and code a person-approved step changed and
 *  that were kept (an approval gate before the step: the person read what
 *  it would do — the desks' retro applies approved fixes this way). */
export function keptLine(kept: readonly RefusedPath[]): string {
  const shown = kept.slice(0, 20).map((r) => `${r.path} (${r.kind})`).join(", ");
  const more = kept.length > 20 ? ` and ${kept.length - 20} more` : "";
  return `kept with approval: ${shown}${more} — configuration or code this step changed, kept because a person approved the step before it ran`;
}

export function refusedLine(refused: readonly RefusedPath[]): string {
  const shown = refused.slice(0, 20).map((r) => `${r.path} (${r.kind})`).join(", ");
  const more = refused.length > 20 ? ` and ${refused.length - 20} more` : "";
  return (
    `refused path: ${shown}${more} — a step cannot change the workspace's configuration or code; ` +
    `the workspace keeps its own copy. Propose the change instead (Proposed fixes), and a person applies it.`
  );
}
