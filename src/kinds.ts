// Every kind of document foldrun knows about, in one place.
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
// Everything downstream — creation templates, `foldrun init`, the scaffolder,
// the dashboard's New button — reads this table. Adding a kind means adding a
// row here and nothing else; that is the point.

/** Where a document can live. Nearest wins at read time. */
export type Scope = "account" | "workspace" | "agent";

export type Kind =
  | "agents"
  | "flows"
  | "evals"
  | "tools"
  | "skills"
  | "memory"
  | "knowledge"
  | "scripts";
// The order that matters is the KINDS table's key order below, not this
// union's: ALL_KINDS reads the object, and every noun list in the product
// follows ALL_KINDS. It runs build → do → know → scripts, which is the
// question each answers rather than the alphabet, and a consistency test
// holds the sidebar and the asset pages to it.

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
effort: high
tools: [files]
---

# ${name}

What you do, in plain English. Be specific about what "done" looks like —
this text is the whole of the agent's instructions.
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

  tools: {
    kind: "tools",
    one: "tool",
    docType: null,
    docKey: null,
    scopes: ["account", "workspace"],
    placeholder: "uuid-service",
    hint: "Something an agent can call. Pick a type, name it, and the files are written for you.",
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
  // Last, and not navigable: a folder tool holds its own code, so scripts
  // is material a tool carries rather than a shelf anyone picks from. The
  // directory still exists and library/x.py still resolves — it just isn't
  // a decision, so the sidebar has no door for it.
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
    // See the memory template: OKF's fields only.
    template: (name) => `---
type: Reference
title: ${titleCase(name)}
description: Reference material agents look up. Given, not learned.
status: stable
---

The reference content. Agents read this and never rewrite it.
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
    // `title` and nothing of ours. A bundle carries the format's fields, so a
    // reader that has never heard of this platform loses nothing: `name` was
    // ours, undefined by OKF, and an outside consumer had no reason to read
    // it — it fell back to the filename and showed a slug.
    template: (name) => `---
type: Fact
title: ${titleCase(name)}
description: One durable fact.
status: stable
---

The fact.

**Why:** what made it worth remembering.
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
  },};

/**
 * What a script tool can be written in.
 *
 * Three, not every language the runner can execute. The runner picks an
 * interpreter from the file extension, so `.rb` and the rest keep working the
 * moment someone renames a file — but a picker with nine entries is a quiz,
 * and three covers what people actually reach for. The point of asking at all
 * is that "script tool" silently meaning JavaScript was a thing you had to
 * find out by reading the file it made.
 */
export const SCRIPT_LANGUAGES = [
  { value: "javascript", label: "JavaScript", ext: ".mjs", hint: "node — the default" },
  { value: "python", label: "Python", ext: ".py", hint: "python3" },
  { value: "bash", label: "Shell", ext: ".sh", hint: "bash — for wrapping a command" },
] as const;

export type ScriptLanguage = (typeof SCRIPT_LANGUAGES)[number]["value"];

/** The starting program, in each language. Every one of them does the same
 *  three things, because those three are the tool contract:
 *
 *    validate its own arguments   — every declared arg is OPTIONAL at the
 *                                   call site, so required means checked here
 *    print the result on stdout   — that is what the agent reads back
 *    exit non-zero on failure     — that is what tells the agent it failed
 */
const PROGRAMS: Record<ScriptLanguage, string> = {
  javascript: `import { parseArgs } from "node:util";

// Every declared arg is optional at the call site — the model may omit any of
// them, and an empty value is never passed — so required means checked here.
const { values } = parseArgs({ options: { input: { type: "string" } } });
if (!values.input) {
  console.error("need --input");
  process.exit(1);
}

// One JSON object on stdout: small, structured, and the same shape every call.
console.log(JSON.stringify({ input: values.input }));
`,
  python: `#!/usr/bin/env python3
import argparse, json

# Every declared arg is optional at the call site — the model may omit any of
# them, and an empty value is never passed — so required means checked here.
# argparse exits 2 with a usage line on stderr, which is exactly the signal
# the agent should get.
p = argparse.ArgumentParser()
p.add_argument("--input", required=True)
a = p.parse_args()

# One JSON object on stdout: small, structured, and the same shape every call.
print(json.dumps({"input": a.input}))
`,
  bash: `#!/usr/bin/env bash
set -euo pipefail

# Declared args arrive as long flags: --input value
input=""
while [ $# -gt 0 ]; do
  case "$1" in
    --input) input="\${2-}"; shift 2 ;;
    *) echo "unexpected argument: $1" >&2; exit 1 ;;
  esac
done

# Every declared arg is optional at the call site, so required means checked
# here. A non-zero exit is what tells the agent the call failed.
[ -n "$input" ] || { echo "need --input" >&2; exit 1; }

# Whatever this prints on stdout is what the agent reads back. Keep it small
# and regular — print JSON when the result has structure.
echo "$input"
`,
};

/**
 * A new tool, as the files it starts as.
 *
 * Three transports, two shapes. An API or an MCP server is a definition and
 * nothing else, so it stays one flat file. A script tool is a definition and
 * the code it runs, which cannot be separated without the tool silently
 * resolving to nothing — so it starts as a folder holding both, with `run:`
 * relative to itself and naming no scope.
 *
 * Returned as a list because "create a tool" is not always one write, and
 * the callers that stamp templates should not have to know which case they
 * are in.
 */
export function toolStarter(
  name: string,
  transport: "http" | "script" | "mcp",
  language: ScriptLanguage = "javascript",
): { file: string; content: string }[] {
  if (transport === "script") {
    // A folder, because the program is a file. Code in a fenced block gets
    // no linter, no type checker, no formatter and no way to run it except
    // through a run — and the agents editing these are file-shaped tools:
    // they can patch one line of run.mjs and execute it, where a fence has
    // to be re-emitted whole and can only be tested by shipping it. The
    // single-file form still parses, for a tool small enough to read at a
    // glance; it is no longer what a new one starts as.
    //
    // The language is asked for rather than assumed. "Script tool" used to
    // mean JavaScript silently, which you found out by opening the file it
    // wrote; the runner has always picked an interpreter from the extension,
    // so the choice was already real and merely hidden.
    const lang = SCRIPT_LANGUAGES.find((l) => l.value === language) ?? SCRIPT_LANGUAGES[0];
    const program = `run${lang.ext}`;
    return [
      {
        file: `tools/${name}/tool.md`,
        content: `---
transport: script
name: ${name}
description: What this does, and when an agent should call it.
run: ${program}
args:
  input: What the caller passes in
timeout: 60
---

\`${program}\` beside this file is the tool. Arguments arrive as --flags, one
per \`args:\` entry; whatever it prints on stdout is what the agent reads back,
and a non-zero exit is what tells the agent the call failed.

\`run:\` names the file, never the scope it sits in, so this folder is correct
copied into any workspace or installed at the account.

Needs a package? Declare it here and it is installed for every agent that
grants this tool — the tool is the unit of code, so its dependencies travel
with it:

\`\`\`yaml
runtime:
  packages: [requests]      # pip
  npm: [cheerio]            # npm
\`\`\`

Agents opt in with:

\`\`\`yaml
use: [${name}]
\`\`\`

Run it by hand while you are writing it:

\`\`\`console
${lang.value === "python" ? "python3" : lang.value === "bash" ? "bash" : "node"} tools/${name}/${program} --input hello
\`\`\`
`,
      },
      { file: `tools/${name}/${program}`, content: PROGRAMS[lang.value] },
    ];
  }

  if (transport === "mcp") {
    return [
      {
        file: `tools/${name}.md`,
        content: `---
transport: mcp
name: ${name}
description: What this server provides, and when an agent should reach for it.
command: npx
args: ["-y", "@example/mcp-server"]
env:
  EXAMPLE_TOKEN: \${${envName(name)}_TOKEN}
---

Every tool this server exposes reaches the agent that opts in with:

\`\`\`yaml
use: [${name}]
\`\`\`
`,
      },
    ];
  }

  return [{ file: KINDS.tools.file(name), content: KINDS.tools.template(name) }];
}

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
