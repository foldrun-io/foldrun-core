// Every kind of document mdagent knows about, in one place.
//
// The naming, settled: these are **documents**. Not "resources" — MCP already
// owns that word for something specific, and we speak MCP, so a "resource" in
// our docs would be genuinely ambiguous. Not "entities" or "assets" either;
// both are ORM words for things that are, plainly, markdown files. OKF calls
// them documents and gives every one a `type:`, and we adopted OKF — so the
// spec says *document*, the UI says the actual noun (agent, flow, skill), and
// "resource" stays reserved for MCP.
//
// That leaves one rule, which this file exists to enforce:
//
//   **A document's kind is its path. Only OKF documents declare anything.**
//
// Agents, flows, evals, skills and tools carry no field naming what they are.
// The directory already says it — `agents/x/agent.md` is an agent — and every
// reader here resolves by path: listAgents scans agents/, parseFlow is handed
// files from flows/. A field restating that is derived data sitting next to
// its source, free to disagree with it, and nothing consumed it: the runtime
// never branched on it and the model never saw it, because a system prompt is
// built from the body, not the frontmatter.
//
// `type:` is different and stays. It is OKF's one required field, an open
// vocabulary saying what a piece of knowledge is *about*, and it is genuinely
// not derivable — two files side by side in knowledge/ can be a Policy and a
// Price List. It also does real work: buildIndex groups index.md by it.
//
// So the asymmetry is not an oversight. Ours was redundant; OKF's carries
// information nothing else has.
//
// Tools declare `transport:` (http | script | mcp) — how the tool reaches the
// thing it calls, which is a different question from what the file is. A
// legacy `type: http` is still read as a transport; see readTransport below.
//
// Everything downstream — creation templates, `mdagent init`, the scaffolder,
// the dashboard's New button — reads this table. Adding a kind means adding a
// row here and nothing else; that is the point.

/** Where a document can live. Nearest wins at read time. */
export type Scope = "account" | "workspace" | "agent";

export type Kind =
  | "agents"
  | "flows"
  | "evals"
  | "skills"
  | "memory"
  | "knowledge"
  | "tools"
  | "scripts";

export interface KindMeta {
  kind: Kind;
  /** Singular noun, for buttons and prose. */
  one: string;
  /**
   * The OKF concept type a new document of this kind starts with, for the two
   * kinds that are OKF bundles. Null everywhere else: a kind is read from the
   * path, so nothing else declares what it is.
   *
   * Only a starting point even where it is set — the vocabulary is open.
   */
  docType: string | null;
  /** The frontmatter key carrying `docType`. Always OKF's `type`, or null. */
  docKey: "type" | null;
  /** Scopes this kind can live at, nearest last. */
  scopes: Scope[];
  /** Shown in the name box. */
  placeholder: string;
  /** One line under the name box saying what you're about to make. */
  hint: string;
  /** Path relative to the scope root. */
  file: (name: string) => string;
  /** Starting content. */
  template: (name: string, ctx?: TemplateContext) => string;
}

/** What the caller knows that the template can use. Only flows need it — a new
 *  flow that names a real agent is one edit closer to running than one that
 *  names a placeholder. */
export interface TemplateContext {
  firstAgent?: string;
}

const envName = (name: string) => name.toUpperCase().replace(/[^A-Z0-9]+/g, "_");

/**
 * A slug as a starting display label: `house-style` → `House style`.
 *
 * A placeholder, not a guess to keep — the author renames it to whatever the
 * document is actually called. Its job is to make the field present, because
 * an absent `title` is the case that silently falls back to the slug.
 */
const titleCase = (slug: string) => {
  const words = slug.replace(/[-_]+/g, " ").trim();
  return words ? words[0].toUpperCase() + words.slice(1) : slug;
};

export const KINDS: Record<Kind, KindMeta> = {
  agents: {
    kind: "agents",
    one: "agent",
    docType: null,
    docKey: null,
    scopes: ["workspace"],
    placeholder: "researcher",
    hint: "Someone who does one job. Its instructions are the body of the file.",
    file: (name) => `agents/${name}/agent.md`,
    template: (name) => `---
name: ${name}
description: What this agent is for, in one line.
model: fast
tools: [files]
---

# ${name}

What you do, in plain English. Be specific about what "done" looks like —
this text is the whole of the agent's instructions.
`,
  },

  flows: {
    kind: "flows",
    one: "flow",
    docType: null,
    docKey: null,
    scopes: ["workspace"],
    placeholder: "publish",
    hint: "An ordered list of agents. Same number means they run in parallel.",
    file: (name) => `flows/${name}.md`,
    template: (name, ctx) => `---
name: ${name}
description: What this flow accomplishes, end to end.
trigger: manual
---

1. [[${ctx?.firstAgent ?? "agent-name"}]] — what this step does
`,
  },

  evals: {
    kind: "evals",
    one: "eval",
    docType: null,
    docKey: null,
    scopes: ["workspace"],
    placeholder: "researcher-quality",
    hint: "Cases an agent must pass. Run them after every edit to its prompt.",
    file: (name) => `evals/${name}.md`,
    template: (name) => `---
name: ${name}
agent: agent-name
description: What this eval protects against.
---

## a short name for the case
task: What to ask the agent.
expect:
  - contains: something the answer must mention
  - judge: a sentence describing what a good answer does
`,
  },

  skills: {
    kind: "skills",
    one: "skill",
    docType: null,
    docKey: null,
    scopes: ["account", "workspace", "agent"],
    placeholder: "plain-english",
    hint: "A procedure an agent loads when it needs it. Folder, not one file.",
    file: (name) => `skills/${name}/SKILL.md`,
    template: (name) => `---
name: ${name}
description: What this skill does, and when an agent should use it.
---

# ${name}

Step-by-step instructions. Bundle code in this folder's scripts/ if it needs any.
`,
  },

  memory: {
    kind: "memory",
    one: "memory",
    docType: "Fact",
    // OKF's field and OKF's vocabulary — `Fact` is only the starting point.
    docKey: "type",
    scopes: ["account", "workspace", "agent"],
    placeholder: "house-tone",
    hint: "One durable fact, learned. Agents write here themselves.",
    file: (name) => `memory/${name}.md`,
    // `name` is the identifier — kebab-case, matches the filename. `title` is
    // OKF's human label, and a different thing: without one, every reader
    // falls back to the slug, so our own index listed "house-style" where it
    // meant "How we write", and an outside consumer saw the filename.
    template: (name) => `---
type: Fact
name: ${name}
title: ${titleCase(name)}
description: One durable fact.
status: stable
---

The fact.

**Why:** what made it worth remembering.
`,
  },

  knowledge: {
    kind: "knowledge",
    one: "knowledge doc",
    docType: "Reference",
    // OKF's field and OKF's vocabulary — `Reference` is only the starting point.
    docKey: "type",
    scopes: ["account", "workspace", "agent"],
    placeholder: "pricing",
    hint: "Reference material, given not learned. Agents read it, never write it.",
    file: (name) => `knowledge/${name}.md`,
    // See the memory template: `name` identifies, `title` is what a person
    // reads. OKF defines only the second.
    template: (name) => `---
type: Reference
name: ${name}
title: ${titleCase(name)}
description: Reference material agents look up. Given, not learned.
status: stable
---

The reference content. Agents read this and never rewrite it.
`,
  },

  tools: {
    kind: "tools",
    one: "tool",
    docType: null,
    docKey: null,
    scopes: ["account", "workspace"],
    placeholder: "uuid-service",
    hint: "Something an agent can call: an API, a script, or an MCP server.",
    file: (name) => `tools/${name}.md`,
    template: (name) => `---
transport: http
name: ${name}
description: What this does, and when to call it.
base: https://api.example.com/v1
methods: [GET]
headers:
  Authorization: Bearer \${${envName(name)}_TOKEN}
---

Notes for whoever maintains this. Agents opt in with:

\`\`\`yaml
use: [${name}]
\`\`\`
`,
  },

  scripts: {
    kind: "scripts",
    one: "script",
    // Code, not a document — no frontmatter to carry either field. A tool
    // file points at it.
    docType: null,
    docKey: null,
    scopes: ["account", "workspace", "agent"],
    placeholder: "slugify",
    hint: "Code an agent runs through a tool. Deterministic work belongs here.",
    file: (name) => `scripts/${name}.py`,
    template: (name) => `#!/usr/bin/env python3
"""${name}"""
import argparse

p = argparse.ArgumentParser()
p.add_argument("--input")
args = p.parse_args()

print(args.input)
`,
  },
};

export const ALL_KINDS = Object.keys(KINDS) as Kind[];

/** The kinds that exist at a given scope. */
export const kindsAt = (scope: Scope) => ALL_KINDS.filter((k) => KINDS[k].scopes.includes(scope));

/** The noun a kind declares, for asserting a file says what it is. */
export const docTypeOf = (kind: Kind) => KINDS[kind].docType;

/** Which frontmatter key carries that noun — `kind:` for ours, `type:` for OKF's. */
export const docKeyOf = (kind: Kind) => KINDS[kind].docKey;


/**
 * How a tool reaches the thing it calls.
 *
 * Read from `transport:`, falling back to a legacy `type: http|script|mcp`
 * written before `type:` meant the document. Files written either way keep
 * working; only one of them is what we generate now.
 */
export type Transport = "http" | "script" | "mcp";

const TRANSPORTS = new Set<Transport>(["http", "script", "mcp"]);

export function readTransport(data: Record<string, unknown>): Transport | null {
  const explicit = typeof data.transport === "string" ? data.transport.toLowerCase() : null;
  if (explicit && TRANSPORTS.has(explicit as Transport)) return explicit as Transport;

  const legacy = typeof data.type === "string" ? data.type.toLowerCase() : null;
  if (legacy && TRANSPORTS.has(legacy as Transport)) return legacy as Transport;

  return null;
}
