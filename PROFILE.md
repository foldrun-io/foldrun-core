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

Both are OKF bundles in the same format. **The two directories are ours, not
OKF's** — the spec defines a bundle and says nothing about where one sits or
who may write to it. They stay separate because the write permission differs:
`knowledge/` is read-only to a running agent, `memory/` is where it records
what it learns.

That separation is the platform's answer to something the spec deliberately
leaves open. v0.2 made provenance *describable* — `generated.by` says whether a
person or a machine produced a document — but a field is a claim, written by
whatever wrote the file. A directory decides what may be written at all, so the
split is what makes the same distinction *enforceable*.

## Conformance

Per the spec, a conformant bundle requires:

- every non-reserved `.md` file has parseable YAML frontmatter with a
  non-empty `type`
- `index.md` carries no frontmatter, except `okf_version` at a bundle root
- reserved filenames (`index.md`, `log.md`) follow their defined structure

Reserved means exactly `index.md` and `log.md`, and this platform adds nothing
to that set. It used to: a curated `MEMORY.md` sat beside the generated index,
grouped with the spec's two names, so the conformance check skipped a file
every other consumer reads as a concept and requires a `type` on. Every bundle
containing one passed here and failed elsewhere. The file is gone; curated
prose belongs in `AGENTS.md`, which is not part of any bundle.

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
That tolerance is not a licence to use it. A bundle here carries the format's
fields and no dialect of ours: documents declare `title`, never the `name:`
the rest of the platform identifies things by. `name` is still *read* from
older files, so nothing written before this breaks — it is simply never
written. The spec gives no consumer a reason to look at a key it does not
define, and one that never heard of this platform fell back to the filename
and displayed a slug.

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
| `generated` | `by` and `at` stamped automatically after a run — `by: mdagent/0.1.0`, the spec's `<producer>/<version>` form, with the agent's name kept as an extension key |
| `verified` | the trust tier is derived from it, never stored; `at` is kept, so the index can say *when* something was checked |
| `sources` | parsed, with per-source `id`, `title`, `author`, `usage_count`, `last_modified`, and a `usage_window` that falls back to the document's |
| `resource`, `timestamp` | parsed and available to consumers |

The provenance fields are the reason for adopting v0.2 rather than v0.1. A
fact an agent invented and a fact a person verified used to be
indistinguishable on disk. Now the first carries `generated.by: mdagent/0.1.0`,
renders as *machine-written, unverified* in every index, and the reader is told
which of the two they are trusting before opening either.

Trust tiers are computed rather than stored, from the spec's `verified` field.
The three tier *names* below are this platform's, not vocabulary the spec
defines — they are a presentation of `verified`, and a consumer is free to
derive something else from the same field:

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
| documents in knowledge, memory | **OKF — Google Cloud** |
| the knowledge/memory split itself | ours |
| tools | MCP — Anthropic |
| flows, evals | none exists; ours |

Scoping (nearest-wins), capability grants, secrets, containers and execution
are all outside OKF's scope and are this platform's own design.
