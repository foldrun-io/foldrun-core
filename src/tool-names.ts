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
import { providerOfName } from "./model-names.ts";

/** Groups: one word an author can hold in their head, expanded to SDK names. */
export const TOOL_MAP: Record<string, string[]> = {
  // The web is one tool of ours, `web` — search, fetch, browse, crawl, map,
  // extract, answer, monitor, served from the gallery and on the run record
  // whichever model is driving. So `web` is deliberately NOT here: a name in
  // TOOL_MAP shadows a real tool of the same name (see runner.ts).
  // `read` is deliberately separate from `write`: an agent that may inspect a
  // repository but must never modify it is a real and common design. The pair
  // says what it grants. `files` and `bash` were the old names for `write`
  // and `code` (`code`, because it is not only shell — anything in the
  // sandbox runs through it); both are retired, below.
  read: ["Read", "Glob", "Grep"],
  write: ["Read", "Write", "Edit", "Glob", "Grep"],
  files: ["Read", "Write", "Edit", "Glob", "Grep"],
  code: ["Bash"],
  bash: ["Bash"],
};

/** Names an author may no longer write, and what to write instead. They are
 *  still granted, so nothing deployed breaks; `check` and the run log say the
 *  rewrite. */
export const RETIRED_TOOLS: Record<string, string> = {
  files: "write",
  bash: "code",
};

/** Exact SDK tool names, accepted alongside the group aliases so a Claude Code
 *  subagent's `tools: Read, Grep` works unchanged. The aliases exist because
 *  vendors rename tools; `write` survives a rename that `Write` would not.
 *  The SDK's WebSearch and WebFetch are not here: the web is our `web` tool,
 *  and a model provider's own search (`web: {search: zai}`) is the runtime's
 *  to swap in, not the author's to name. */
export const BUILTIN_TOOLS = new Set([
  "Read", "Write", "Edit", "MultiEdit", "Glob", "Grep", "Bash",
  "NotebookEdit", "TodoWrite",
]);

/** The platform's own groups, served in-process rather than by the SDK.
 *  `install` is granted to every agent anyway (install-tool.ts); naming it is
 *  accepted so a file that says so is not flagged. `text` is extract_text
 *  (text-tool.ts) — named `text`, not `extract`, because `extract` is
 *  already one of the web tool's actions (`limits: {web.extract: 5}`). */
export const PLATFORM_GROUPS = new Set(["search", "history", "desks", "ask", "peers", "install", "text", "symbols", "debate", "review"]);

/** tools: [debate, review] (FOL-418): served by foldrun's gateway as server
 *  tools, answered by `second_model:` — a model of another provider. Their
 *  dated types, as the gateway announces them. */
export const SECOND_MODEL_TOOLS = { debate: { type: "foldrun_debate_20261127", name: "foldrun_debate" }, review: { type: "foldrun_review_20261127", name: "foldrun_review" } } as const;
export type SecondModelTool = keyof typeof SECOND_MODEL_TOOLS;
/** `second_model:` is written provider/model, as the gateway takes it. */
export const SECOND_MODEL_RE = /^[a-z0-9-]{2,32}\/[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

/** The built-in names a tools:/disallowedTools: value grants or takes away, read as the runtime reads it: a list, one
 *  name, Claude Code's comma string or the `{Bash: ask}` map form; a `[[link]]` (the author's own tool) is not one. */
export function builtinToolNames(raw: unknown, grant = false): string[] {
  // `grant`: a tools: list's, where `{review: ask}` asks before each use — not a grant to act without asking.
  return refList(raw).filter((r) => !r.linked && !(grant && r.mode === "ask")).map((r) => r.name);
}
/** The `[[link]]` entries of such a value: the author's own tools, by name. */
export function linkedToolNames(raw: unknown): string[] {
  return refList(raw).filter((r) => r.linked).map((r) => r.name);
}

/** What `foldrun check` says about tools: [debate, review] and second_model: (warnings: a new rule). */
export function secondModelProblems(front: { tools?: unknown; second_model?: unknown; model?: unknown }): string[] {
  const tools = toolRefs(front).filter((r) => !r.linked && (r.name === "debate" || r.name === "review")).map((r) => r.name);
  const want = front.second_model;
  const out: string[] = [];
  if (want !== undefined && (typeof want !== "string" || !SECOND_MODEL_RE.test(want.trim()))) out.push(`second_model: is written provider/model (a model of another provider than model:), e.g. openai/<model>`);
  else if (typeof want === "string" && typeof front.model === "string" && front.model.includes("/") && (providerOfName(front.model) ?? front.model.split("/")[0]) === (providerOfName(want.trim()) ?? want.trim().split("/")[0])) out.push(`second_model: ${want} is the same provider as model: — debate and review are answered by ANOTHER provider's model`);
  if (tools.length && want === undefined) out.push(`tools: [${tools.join(", ")}] needs second_model: (provider/model of another provider) — until it is set they are not offered`);
  if (want !== undefined && !tools.length) out.push(`second_model: is set but tools: has neither debate nor review — it does nothing`);
  return out;
}

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

/** Retired names written bare in `tools:`, deduped. A `[[link]]` is the
 *  author's own file, so it is never one of these. */
export function retiredToolNames(front: ToolFrontmatter): string[] {
  const out: string[] = [];
  for (const ref of toolRefs(front)) {
    if (!ref.linked && RETIRED_TOOLS[ref.name] && !out.includes(ref.name)) out.push(ref.name);
  }
  return out;
}

/** The one sentence every reader of a retired name says. */
export function retiredToolError(name: string): string {
  return `tools: "${name}" is retired — use ${RETIRED_TOOLS[name]} instead: the same grant, under the name that says what it does. It is still granted for now.`;
}

/** The one sentence every reader of a `use:` key says. */
export function legacyUseError(names: string[]): string {
  return `\`use:\` is no longer read — write \`tools: [${names.join(", ")}]\` instead (scripts/migrate-use-to-tools.mjs rewrites every agent). Nothing was granted for it.`;
}
