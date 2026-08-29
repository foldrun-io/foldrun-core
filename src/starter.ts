// The starter workspace, defined once.
//
// Two things used to build one: `foldrun init` had its own copy and the
// dashboard's "new workspace" button had another. They drifted exactly as you
// would expect — different flow names, one with evals and knowledge and one
// without — and when structural documents moved from `type:` to `kind:`, one
// copy was migrated and the other silently kept writing the old spelling.
//
// This is the same failure the consistency tests exist to catch: a list in two
// places, one updated, nothing erroring. So there is one definition here and
// both callers read it.
//
// Not to be confused with KINDS[kind].template(), which makes *one* document
// of a kind with a placeholder name — that is what the New button uses inside
// an existing workspace. This is the set of files a brand-new workspace starts
// with, and they reference each other on purpose: the flow names the agents,
// the eval names the writer, so `foldrun check` passes and `foldrun run
// publish` works before anything has been edited.

/** One authored file, relative to the workspace root. */
export interface StarterFile {
  path: string;
  content: string;
}

/**
 * The account root's own files — one scope up from any workspace.
 *
 * The account AGENTS.md was readable from the day `workspaceFrontmatter` and
 * `sharedInstructions` learned to look for it, and nothing ever wrote one. So
 * the outer half of "nearest-wins" existed only for people who had read the
 * spec closely enough to know the file could exist at all, which is the same
 * failure as prose that reached no model: a feature nobody is told about.
 *
 * Deliberately near-empty. This file's frontmatter governs *every* workspace
 * under it, so the scaffold ships the shape and a commented example rather
 * than a live `provider:` — a starter that silently routed every future
 * workspace somewhere would be worse than no starter.
 */
export function accountFiles(account: string): StarterFile[] {
  return [
    {
      path: "AGENTS.md",
      content: `---
foldrun_version: "0.1"
# Config here applies to every workspace under this account, and a workspace
# that declares the same key replaces it *whole* — base_url and token never
# merge across scopes, so a provider block belongs entirely at one level.
#
# provider:
#   base_url: https://openrouter.ai/api
#   token: \${OPENROUTER_API_KEY}
#   models:            # what this gateway calls each tier
#     fast: google/gemini-2.5-flash
#     max: anthropic/claude-opus-4.1
#   headers:           # anything else the gateway wants
#     X-Title: foldrun
#
# The token is sent as a bearer credential. A gateway that wants it as a key
# header asks for that by name: headers: { x-api-key: \${THE_SECRET} }.
---

# ${account}

Context every agent in every workspace here shares.

Unlike the frontmatter above, this prose **accumulates**: a workspace's
AGENTS.md is added to it, not swapped for it, so a rule written here cannot be
dropped further down.
`,
    },
  ];
}

export function starterFiles(workspace: string): StarterFile[] {
  return [
    {
      // AGENTS.md, not project.md — the file was renamed to the Linux
      // Foundation standard and this scaffold was missed once already, so
      // every workspace made from the dashboard started with a file nothing
      // reads.
      path: "AGENTS.md",
      content: `---
name: ${workspace}
description: A starter workspace — edit the agents, then run the flow.
foldrun_version: "0.1"
---

# ${workspace}

Context every agent here shares. Prices, rules, anything they should all know.
`,
    },

    {
      // A workspace is meant to be a git repository — that is the whole pitch,
      // that you can diff and review what an agent is. So it has to arrive
      // knowing which of its own files must never be committed. The decisive
      // one is `.foldrun/.secret-key`: the CLI writes the key that decrypts
      // every secret *inside the workspace*, and without this file the first
      // `git add -A` after setting a secret commits it.
      path: ".gitignore",
      content: `# The key that decrypts every secret in this workspace, plus the
# local run store. Never commit these.
.foldrun/

# Written by runs, not by you.
runs/
outputs/

.env
.env.local
.DS_Store
`,
    },

    {
      path: "agents/researcher/agent.md",
      content: `---
name: researcher
description: Finds one thing worth writing about, and says why.
model: fast
effort: high
tools:
  - web
  - read
---

Pick exactly one topic, in a short paragraph, and say who it helps and why now.
Do not write the article.
`,
    },

    {
      path: "agents/writer/agent.md",
      content: `---
name: writer
description: Turns a brief into a short draft.
tools:
  - files
---

Write a short draft from the brief you were given. Save it to outputs/draft.md.
`,
    },

    {
      path: "flows/publish.md",
      content: `---
name: publish
trigger: manual
---

Read the numbers, not the order of the lines.
Same number = at the same time. Different number = one after the other.

1. [[researcher]] — find one topic worth writing about
2. [[writer]] — draft it
`,
    },

    {
      // knowledge/ is an OKF bundle, so this one declares itself in `type:`.
      path: "knowledge/house-style.md",
      content: `---
type: Reference
title: How we write
description: How we write. Agents read this; they never rewrite it.
status: stable
---

- Short sentences. One idea each.
- Say the number, not "significant growth".
`,
    },

    {
      // The other half of OKF, and the half the starter never showed. Same
      // format as knowledge/, different write permission: an agent may add
      // here, and when it does the runtime stamps `generated:` so a fact it
      // worked out never looks like one you gave it.
      path: "memory/what-worked.md",
      content: `---
type: Fact
title: What worked last time
description: Something learned from a run. Agents add files here themselves.
status: stable
# generated: is stamped automatically when an agent writes a memory.
# Add verified: with a \`human:\` actor once you have checked one yourself —
# that is what moves it from unverified to human-reviewed in the index.
---

Short drafts got edited less than long ones. Prefer four paragraphs to eight.
`,
    },

    {
      // For the CODING TOOL the author is using, not for the platform — this is
      // the one file here that foldrun itself never reads. Claude Code and its
      // peers look for AGENTS.md/CLAUDE.md at the root of whatever they open,
      // and without one they infer conventions from the tree, which for a
      // workspace of loosely-structured markdown means guessing frontmatter
      // fields that do not exist and putting agents in the wrong place.
      //
      // The platform already imports .claude/agents/*.md as agents, so a
      // subagent authored in Claude Code deploys as a foldrun agent with no
      // conversion. That path is much more useful when the tool knows it
      // exists, which is most of what this file is for.
      path: "CLAUDE.md",
      content: `# Working on this foldrun workspace

This is a foldrun workspace: agents, flows and knowledge as markdown. There is
no build — the files ARE the program — so the loop is edit, check, run, deploy.

## The loop

\`\`\`sh
foldrun check              # validate everything, offline, no model calls
foldrun run <flow>         # run it locally against real models
foldrun eval               # run the evals
foldrun deploy --url <server> --token $FOLDRUN_TOKEN
\`\`\`

\`check\` is cheap and catches a broken flow before a schedule fires it at 3am.
Run it after edits, the way you would run a typecheck.

## Where things go

| Path | What |
|---|---|
| \`AGENTS.md\` | shared context every agent in this workspace sees |
| \`agents/<name>/agent.md\` | one role: its persona, model, tools |
| \`flows/<name>.md\` | steps, in order, naming the agents that run them |
| \`knowledge/\` | reference material agents read |
| \`memory/\` | what past runs learned — agents write here themselves |
| \`evals/\` | tests for agents, same idea as unit tests |
| \`skills/\` | a procedure an agent can follow, named in \`skills:\` |
| \`tools/\` | a folder tool: its definition and its code together |
| \`scripts/\` | code the agents call, referenced by \`scripts:\` |
| \`state/\` | what runs accumulate. Yours to read, never deployed over |
| \`.claude/agents/<name>.md\` | a Claude Code subagent — deploys AS an agent |

\`knowledge/\` is what you tell the agents; \`memory/\` is what they worked out.
Regenerated every run means a file; accumulated across runs means \`state/\`.

That last row is worth knowing: a subagent you write in Claude Code is imported
as \`agents/<name>/agent.md\` at deploy, no conversion. Write it either way.

## What a deploy does NOT touch

\`runs/\`, \`state/\`, \`secrets.json\`, and any memory an agent wrote that your
push does not mention. Those belong to the platform, not to git — a deploy that
reverted what an agent learned would make every run a little dumber.

Secrets never go in these files. \`foldrun secrets\` puts them in the vault, and
agents reference them by name.

## Writing an agent

Frontmatter then prose. The prose IS the system prompt, so write it to be read
by a model: what this role is for, what it must not do, what good looks like.

\`\`\`markdown
---
name: researcher
description: Finds and summarises sources.
model: default              # fast | default | max
effort: low                 # how hard to think about it
size: large                 # small | large | heavy — the sandbox it rents
tools: [WebSearch, Read, Write]
disallowedTools: [Bash]     # subtract from what it would otherwise have
skills: [house-style]       # from skills/
scripts: [summarise.py]     # from scripts/, each becomes a callable tool
use: [my-folder-tool]       # from tools/
apis: [{ name: crm }]       # an HTTP API, as a tool
mcpServers: {}              # an MCP server, as a tool
agents: [writer]            # colleagues this one may consult
secrets: [CRM_TOKEN]        # from the vault — never written in these files
provider: {}                # BYOK: your own model credential
permissionMode: plan        # plan first, act once approved
runtime:                    # only if scripts need packages
  packages: [requests]
---

You research a topic and report what you found...
\`\`\`

Only \`name\` and the prose are required. Every other field widens or narrows
what the agent can reach, and the default is narrow.

\`runtime:\` installs pip/npm packages in the sandbox each agent runs in. Pin
versions the normal way (\`pandas>=2\`, \`lodash@^4\`). Python and Node are
supported; anything else should ship as a committed binary.

Link documents to each other with \`[[wikilinks]]\` — the name, not the path.
`,
    },

    {
      path: "evals/writer-quality.md",
      content: `---
name: writer-quality
agent: writer
model: fast
effort: low
---

## writes something
task: Write two sentences about rain.
expect:
  - judge: it is two sentences and mentions rain
`,
    },
  ];
}
