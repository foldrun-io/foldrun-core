# Hosting the Open Knowledge Format

**A conformant host, and the permission model the spec leaves open.**

---

## Summary

The [Open Knowledge Format](https://github.com/GoogleCloudPlatform/knowledge-catalog/tree/main/okf)
specifies how curated knowledge is packaged for agents: a directory tree of
markdown files whose frontmatter carries enough signal to judge a document
before reading it. It deliberately does not specify where a bundle lives, who
may write to it, or what reads it.

Those omissions are not gaps in the spec. They are the host's job, and OKF says
so — tenancy is named as a hosting concern and left alone.

This paper describes a host that answers them. It covers three things:

1. **Conformance** — what a bundle we emit guarantees, and the checks that
   hold that line.
2. **The three questions OKF leaves to hosts** — scope, permission, and
   whether provenance survives contact with an agent that can write files.
3. **What we would contribute upstream** — two mechanisms that belong in the
   format rather than in one implementation of it.

The argument in one sentence: **OKF made provenance describable, and a host has
to make it enforceable.**

---

## 1. What OKF specifies

The format is small, which is its strength. A bundle is a directory tree of
markdown files. Every non-reserved `.md` file is a *concept* and carries YAML
frontmatter with a non-empty `type`. Two filenames are reserved — `index.md`
and `log.md` — and a bundle-root `index.md` may declare `okf_version`.

Frontmatter divides into two families. v0.1 describes the concept: `type`,
`title`, `description`, `resource`, `tags`. v0.2 adds the fields you use to
decide something about a concept *before* opening it: `generated`, `verified`,
`status`, `stale_after`, `sources`, and — for `type: Attested Computation` — a
contract of `runtime`, `parameters`, `executor`, and `attester`.

The reasoning behind that split is the most important idea in the spec. Most
interactions with a concept never reach its body. A reader — person, script, or
agent scanning for relevance — first has to decide whether a document is worth
opening at all. Frontmatter exists to make that decision cheap, so it can be
made often, without paying for prose.

Conformance is correspondingly narrow, and the spec is explicit that consumers
**must not** reject a bundle for unknown frontmatter keys, unknown `type`
values, missing optional fields, or broken cross-links.

## 2. What OKF does not specify

Three things, each of which a host must answer to run anything:

- **Where a bundle lives.** The spec describes one tree. It says nothing about
  many trees, or how a reader picks between them.
- **Who may write to it.** There is no permission model, because there is no
  runtime to enforce one.
- **What reads it.** OKF is a packaging format. Nothing in it turns a folder
  into an agent's context.

A format that stopped short of these is a better format. But an
implementation cannot stop there, and the answers are where the engineering is.

---

## 3. Conformance

We treat conformance as a property of what we *emit*, tested against the
spec's rules rather than our own reader. The distinction matters more than it
sounds: a checker built from the same assumptions as the writer will agree with
the writer about a bundle nobody else accepts.

`conformanceIssues()` walks the directory tree directly rather than asking the
platform's own document reader, because those answer different questions —
*"what should we display"* versus *"would an outside validator accept this"* —
and they differ by exactly the files an implementation chooses to hide.

Two rules we learned by getting them wrong:

**Do not invent a reserved filename.** We shipped a curated `MEMORY.md`
alongside the generated index and grouped it with the spec's two reserved
names. Our conformance check therefore skipped a file every other consumer
reads as an ordinary concept and demands a `type` on. Every bundle containing
one passed here and failed elsewhere. The file is gone; curated prose belongs
outside the bundle.

**Do not carry your own dialect into someone else's format.** The spec's
tolerance for unknown keys is not a licence to use it. Our documents once
carried a `name:` — the identifier the rest of our platform uses — and no
`title:`, OKF's field for a human label. The bundle was conformant and the
labels were invisible: a reader with no knowledge of this platform has no
reason to look at `name`, so it fell back to the filename and displayed a slug.
Bundles now carry the format's fields and nothing of ours.

The general rule both cases produce: **a bundle is written for a reader who has
never heard of you.**

### Beyond conformance

Two behaviours sit deliberately outside the conformance checker, because the
spec's rules say nothing about them and a bundle that violates them is still
one an outside validator accepts:

- **Dates that cannot be compared.** `stale_after`, `generated.at`,
  `verified[].at`, `sources[].last_modified` and both ends of a `usage_window`
  are only meaningful as comparisons — *is today past this*, *which of these is
  most recent*. Those comparisons are lexical, so a value like `yesterday`
  sorts above every real timestamp. We normalise the spec's two shapes and
  refuse anything else, then report what was dropped rather than swallowing it.
- **Attested Computation.** We parse the full contract and mark every such
  concept **UNATTESTED** in the index. This is the spec's own limitation rather
  than a defect in the bundle: OKF defers the receipt and verdict wire formats
  to a future revision, so no consumer can evaluate a verdict yet. Surfacing
  that is more useful than presenting an unchecked output as though it had been
  checked.

Keeping these apart from conformance is the point. The conformance answer stays
exactly the spec's.

---

## 4. Scope: where a bundle lives

OKF describes one tree. An organisation has many, and an agent needs several at
once — its own notes, its team's reference material, the company's policies.

We resolve bundles at three scopes, nearest-wins:

```
<account>/library/knowledge/     every workspace
<workspace>/knowledge/           every agent in the workspace
<workspace>/agents/<name>/knowledge/    one agent
```

Each is a bundle in its own right; the workspace and account bundles are roots
and carry `okf_version`, while an agent's own pair is nested and does not. A
reader assembles context by walking outward, and the nearest definition wins —
so a team can set a house style once and one agent can still override it.

This is the same precedence rule the format already uses inside a bundle, lifted
one level up. Nothing about it required extending OKF.

## 5. Permission: who may write

This is the question the format cannot answer, and the one that decides whether
provenance means anything.

v0.2 made provenance **describable**: `generated.by` says whether a person or a
machine produced a document. But a field is a claim, and it is written by
whatever wrote the file. An agent that can write a concept can write its
`generated` block too. The signal is only as strong as the weakest path to the
file.

Our answer is a directory boundary with a rule attached:

| | `knowledge/` | `memory/` |
|---|---|---|
| Contents | what a person gave the agent | what the agent worked out |
| Agent may read | yes | yes |
| Agent may write | **no** | yes |

Both are OKF bundles in the same format. **The split is ours** — the spec
defines neither directory. What it buys is that `generated.by: human:…` on a
knowledge concept is not a claim an agent could have made: there is no path by
which an agent writes that file at all.

Enforcement has to cover every path, which is easy to get wrong. Built-in file
tools are checked by argument. A shell is not — there is no path argument, only
a string — so the same protections are recognised there from the command's
shape, and `knowledge/` is denied only alongside a *writing* shape. Reading the
price list is the entire reason it exists; a blanket rule would have banned
`cat` to close a hole about `>`.

The generated files are protected on both paths. An index that an agent can
edit is an index that can lie, and a log that a step can rewrite makes every
other guarantee unverifiable.

We are honest about the limit: pattern-matching a shell command is best-effort,
and the sandbox is the real boundary. This layer exists to name the obvious
cases with a clear message rather than a confusing sandbox error.

## 6. Runtime: what reads a bundle

The spec's progressive-disclosure argument only pays off if something acts on
it. Ours does, in the narrow sense that matters: **the runtime never loads a
concept body to decide relevance.**

An agent receives an index — one line per document, built entirely from
frontmatter — and opens only what it picks:

```
- [Northwind price list](products.md) — what we sell, with current prices  _(human-reviewed 2026-07-31)_
- [Q3 revenue](q3.md) — the number                    _(machine-written, unverified)_
- [Warranty terms](warranty.md) — what we cover       _(STALE since 2026-06-30 — confirm before relying on it)_
```

Every mark is a v0.2 field doing work at the moment of decision. That is the
whole design: relevance and trust cost frontmatter, and prose is paid for only
once a document is chosen.

Two details we would call out to anyone building the same thing:

**Surface all three trust states, not just the bad one.** Marking only
`unverified` renders *machine-confirmed* and *human-reviewed* identically — as
silence — so trust becomes something you can detect the absence of rather than
filter on.

**Date the verification.** Undated, a fact checked last week and one checked in
2019 read the same. The tier alone answers a weaker question than it appears
to: not *can I rely on this*, but *did anyone ever look*.

**Actors are read per §7.** Only `human:<id>` is a person;
`<producer>/<version>` and `process:<id>` are not. Test for the human form —
testing for a machine form means matching a *producer's name*, and the spec's
own `reference_agent/gemini-2.5-pro` does not begin with the word "producer".

---

## 7. Divergences worth knowing

Stated plainly, because an interop claim with hidden edges is worth less than a
narrow one:

- **The `knowledge/` and `memory/` directories are ours**, not OKF's. The
  documents inside them are the format's; the split and the write rule are the
  host's.
- **Skills.** Google's worked example places `skills/` *inside* the bundle. Ours
  sit beside it, in the Agent Skills format. Both are legitimate, but a bundle
  imported from elsewhere with a `skills/` folder will be listed as concepts
  rather than loaded as skills. This is a real import gap, not a resolved one.
- **Trust tier names are ours.** `unverified` / `machine-confirmed` /
  `human-reviewed` are a presentation of the spec's `verified` field. A consumer
  is free to derive something else from the same data.

---

## 8. What belongs upstream

Two mechanisms we implemented that are not implementation details. We would
rather they were in the format than in one host:

**1. A write-permission signal.** The provenance fields describe who wrote a
document; nothing describes who *may*. A bundle that could declare a subtree
read-only to non-human actors would let the guarantee travel with the bundle
instead of living in each host's configuration — and would make
`generated.by: human:…` mean the same thing everywhere.

**2. Producer-stamped provenance as an obligation.** Our runtime stamps
`generated` after a run, so a fact an agent worked out never looks like one a
person gave it, without anyone remembering to record it. The spec currently
leaves stamping to producers' discretion. Making it an expectation of
conforming *producers* — rather than an option — would raise the floor on
exactly the signal v0.2 was added to provide.

A third is smaller but concrete: **`log.md` has no defined actor.** The version
history in the reserved log records what changed and when, but not who — while
`generated` and `verified` record actors for the document. Extending log
entries with the same actor convention would close that asymmetry.

---

## Appendix: conformance evidence

The claims in §3 are tested rather than asserted. Two suites apply the spec's
rules rather than the platform's:

- `tests/okf-conformance.test.ts` — validates emitted bundles against the
  spec's three conformance rules with an independent validator, including the
  four cases §Conformance says consumers must **not** reject, and asserts that
  a filename of our own earns no exemption.
- `tests/okf-signals.test.ts` — asserts the v0.2 decision signals reach the
  index, that every actor form in §7 is recognised, and that a date the
  platform cannot compare is dropped and reported rather than silently kept.

Field coverage, verified against the v0.2 specification:

| Family | Fields | Status |
|---|---|---|
| Describe | `type`, `title`, `description`, `resource`, `tags`, `timestamp` | parsed; `type` enforced |
| Trust | `generated{by,at}`, `verified[{by,at}]`, `status`, `stale_after`, `sources[…]`, `usage_window` | parsed; surfaced in every index |
| Compute | `runtime`, `computation`, `parameters`, `executor{resource,receipt}`, `attester{resource}` | parsed; marked UNATTESTED |
| Reserved | `index.md`, `log.md`, `okf_version` | generated and maintained |

---

*This document records one implementation's reading of OKF v0.2. Where it and
the specification disagree, the specification wins.*
