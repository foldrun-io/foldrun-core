// The starter workspace, defined once.
//
// Two things used to build one: `mdagent init` had its own copy and the
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
// the eval names the writer, so `mdagent check` passes and `mdagent run
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
mdagent_version: "0.1"
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
#     X-Title: mdagent
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
mdagent_version: "0.1"
---

# ${workspace}

Context every agent here shares. Prices, rules, anything they should all know.
`,
    },

    {
      // A workspace is meant to be a git repository — that is the whole pitch,
      // that you can diff and review what an agent is. So it has to arrive
      // knowing which of its own files must never be committed. The decisive
      // one is `.mdagent/.secret-key`: the CLI writes the key that decrypts
      // every secret *inside the workspace*, and without this file the first
      // `git add -A` after setting a secret commits it.
      path: ".gitignore",
      content: `# The key that decrypts every secret in this workspace, plus the
# local run store. Never commit these.
.mdagent/

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
