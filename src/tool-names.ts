// The one place that knows which names are the runtime's and which are the
// author's.
//
// `tools:` is Claude Code's field, kept compatible, and grants anything: a
// built-in group, an exact SDK tool name, or a tool this workspace or account
// defines. There used to be a second spelling, `use:`, that meant only the
// author's own tools. It is gone: two keys for one grant meant two places to
// look for an agent's blast radius, and three readers — the container's
// egress flag, the library's used-by list, Tool Test's agent picker — read
// one and forgot the other. A file that still says `use:` gets an error
// naming the rewrite, and scripts/migrate-use-to-tools.mjs makes it.

import { refList, refNames, type Ref } from "./refs.ts";

/** Groups: one word an author can hold in their head, expanded to SDK names. */
export const TOOL_MAP: Record<string, string[]> = {
  // `web` includes Anthropic's server-side WebSearch, the one built-in tool
  // that runs off the box and bills per call. `fetch` is the local half only:
  // an agent that searches through the account's own `websearch` tool and
  // reads pages with WebFetch never leaves the box for anything but tokens.
  web: ["WebSearch", "WebFetch"],
  fetch: ["WebFetch"],
  // `read` is deliberately separate from `files`: an agent that may inspect a
  // repository but must never modify it is a real and common design.
  read: ["Read", "Glob", "Grep"],
  files: ["Read", "Write", "Edit", "Glob", "Grep"],
  bash: ["Bash"],
};

/** Exact SDK tool names, accepted alongside the group aliases so a Claude Code
 *  subagent's `tools: Read, Grep` works unchanged. The aliases exist because
 *  vendors rename tools; `web` survives a rename that `WebSearch` would not. */
export const BUILTIN_TOOLS = new Set([
  "Read", "Write", "Edit", "MultiEdit", "Glob", "Grep", "Bash",
  "WebSearch", "WebFetch", "NotebookEdit", "TodoWrite",
]);

/** The platform's own groups, served in-process rather than by the SDK. */
export const PLATFORM_GROUPS = new Set(["search", "history"]);

/** Would this name resolve to something the runtime provides? Built-ins win a
 *  clash, so a tool file of the same name is shadowed rather than granted. */
export function isRuntimeTool(name: string): boolean {
  return Boolean(TOOL_MAP[name]) || PLATFORM_GROUPS.has(name) || BUILTIN_TOOLS.has(name);
}

/** The name an entry grants. `tools:` also takes the map form for approval
 *  mode — `{Bash: ask}` — where the key is the tool and the value the mode. */
export function toolEntryName(entry: unknown): string {
  return refList([entry])[0]?.name ?? "";
}

type ToolFrontmatter = { tools?: unknown; use?: unknown };

/** Every entry of `tools:`, with whether it was written as a `[[link]]`. */
export function toolRefs(front: ToolFrontmatter): Ref[] {
  return refList(front.tools);
}

/** Is this entry one of the author's own tools? A `[[link]]` always is —
 *  the brackets say "my file", so `[[search]]` is yours even though `search`
 *  is a runtime group. A bare name is the author's only when no built-in
 *  claims it. */
export function isOwnToolRef(ref: Ref): boolean {
  return ref.linked || !isRuntimeTool(ref.name);
}

/**
 * Every name in `tools:` that can only mean one of the author's own tools.
 * Deduped, order preserved. Names that resolve to nothing are still
 * returned: the caller reports them, and "you asked for a tool that isn't
 * there" is a better error than silence.
 */
export function ownToolNames(front: ToolFrontmatter): string[] {
  const out: string[] = [];
  for (const ref of toolRefs(front)) {
    if (isOwnToolRef(ref) && !out.includes(ref.name)) out.push(ref.name);
  }
  return out;
}

/** What a file still says under the removed `use:` key — nothing is granted
 *  for these; they exist so the error can quote the exact `tools:` line. */
export function legacyUseNames(front: ToolFrontmatter): string[] {
  return refNames(front.use);
}

/** The one sentence every reader of a `use:` key says. */
export function legacyUseError(names: string[]): string {
  return `\`use:\` is no longer read — write \`tools: [${names.join(", ")}]\` instead (scripts/migrate-use-to-tools.mjs rewrites every agent). Nothing was granted for it.`;
}
