# OKF profile

**How mdagent uses the Open Knowledge Format.**

[Open Knowledge Format](https://github.com/GoogleCloudPlatform/knowledge-catalog/tree/main/okf)
is Google Cloud's vendor-neutral specification for packaging curated context
for AI agents — a directory of markdown files with YAML frontmatter, published
under Apache 2.0 (v0.1 June 2026, v0.2 July 2026).

This document is **not** a specification. It records which parts of OKF this
platform implements and the conventions it layers on top. The spec itself
lives in Google's repository; where this document and the spec disagree, the
spec wins.

## What is an OKF bundle here

Two directories, at every scope:

```
<workspace>/knowledge/     what a person gave the agents
<workspace>/memory/        what the agents learned
<workspace>/agents/<name>/knowledge/
<workspace>/agents/<name>/memory/
<account>/library/knowledge/
<account>/library/memory/
```

Both are OKF bundles in the same format. They stay separate directories
because the *write permission* differs — `knowledge/` is read-only to a
running agent, `memory/` is where it records what it learns — not because the
format differs.

## Conformance

Per the spec, a conformant bundle requires:

- every non-reserved `.md` file has parseable YAML frontmatter with a
  non-empty `type`
- `index.md` carries no frontmatter, except `okf_version` at a bundle root
- reserved filenames (`index.md`, `log.md`) follow their defined structure

The platform enforces the first by warning on any file without a `type`, and
maintains both reserved files itself:

- **`index.md`** at every level of the bundle, regenerated on each write, so
  an index can never drift from the files it describes. A root index lists
  its nested sections; only a root carries `okf_version`.
- **`log.md`** at the bundle root — date-grouped, newest first, ISO 8601
  headings, `**Creation**` / `**Update**` entries.

Bundles are trees, not flat directories, matching the spec's own example
(`sales/tables/orders.md`): the path within the bundle is the concept's
identity.

The spec requires consumers **not** to reject a bundle for unknown frontmatter
keys, unknown `type` values, missing optional fields, or broken cross-links.
That is why `name:` — which predates our adoption of OKF and is used
throughout the rest of the platform — sits alongside OKF's `title:` without
conflict. Both are read; `title` wins when present.

### `type` is OKF's alone

Only `knowledge/` and `memory/` are OKF bundles. The platform's own documents —
agents, flows, evals, skills, tools — are not concept documents and carry no
`type:`. They carry no equivalent field either: a document's kind is the
directory it sits in, and every reader resolves it that way.

They did share `type:` before v0.1, which put five words of ours into a
namespace that is not ours. It cost nothing at read time — the spec's open
vocabulary tolerates any value — but it made the export direction dishonest: a
consumer ingesting this repo would have filed an agent definition as a concept
of type `Agent`.

The first fix moved them to a `kind:` of our own, which the spec would have
permitted indefinitely — producers may add keys, and consumers preserve them.
It was removed instead, because the field turned out to answer a question the
path had already answered. Nothing read it, and a second copy of an answer is
only somewhere for the two copies to disagree.

Both directions now say something true, and `type:` means exactly one thing
here: OKF's.

## v0.2 fields, and where they earn their place

| Field | How the platform uses it |
|---|---|
| `type` | required; grouped into sections in `index.md` |
| `status` | `draft`/`deprecated` surfaces as a badge and in the agent's index |
| `stale_after` | a stale document is marked **STALE** in the agent's context, with an instruction to confirm before relying on it |
| `generated.by` | stamped automatically after a run — `producer/mdagent:<agent>` for anything an agent wrote |
| `verified` | the trust tier is derived from it, never stored |
| `sources` | parsed, with per-source `title`, `author`, `usage_count`, `last_modified` |
| `resource`, `timestamp` | parsed and available to consumers |

The provenance fields are the reason for adopting v0.2 rather than v0.1. A
fact an agent invented and a fact a person verified used to be
indistinguishable on disk. Now the first carries
`generated.by: producer/mdagent:writer` and derives to **unverified**, and the
reader is told which one they are trusting.

Trust tiers are computed, per the spec:

| `verified` contains | tier |
|---|---|
| nothing | unverified |
| only non-`human:` actors | machine-confirmed |
| any `human:<id>` | human-reviewed |

## Concept types in use

OKF deliberately does not define `type` values. This platform suggests:
`Fact`, `Decision`, `Preference`, `Reference`, `Runbook`, `Price List`,
`Policy`. Any other value is valid and will be grouped under its own heading.

## What OKF does not cover

OKF is the knowledge layer, and only that. The rest of the platform sits on
other standards, or on none:

| Layer | Standard |
|---|---|
| instructions | `AGENTS.md` — Linux Foundation |
| skills | Agent Skills — Anthropic |
| knowledge, memory | **OKF — Google Cloud** |
| tools | MCP — Anthropic |
| flows, evals | none exists; ours |

Scoping (nearest-wins), capability grants, secrets, containers and execution
are all outside OKF's scope and are this platform's own design.
