# Open Knowledge Format (OKF)

**Spec v0.1 (draft)**

OKF defines how a business's knowledge lives as a tree of plain markdown files — readable by humans in any editor, navigable by AI agents without vector search, versioned and reviewed in git. One tree describes one organization. A platform hosting many organizations hosts many trees; tenancy is a hosting concern and is deliberately outside this spec.

## The tree

Every directory containing a `NODE.md` is a **node**. Nodes nest without limit, so the tree can mirror how the organization actually thinks about itself — departments, locations, product lines, topics:

```
acme-inspections/            # root node — the org names this directory
├── NODE.md
├── knowledge/
│   ├── KNOWLEDGE.md         # index — one line per concept
│   ├── pricing-model.md
│   └── service-area.md
├── agents/
│   └── review-responder/    # an mdagent attached at this node
├── sydney/                  # child node (a location)
│   ├── NODE.md
│   ├── knowledge/
│   │   └── sydney-team.md
│   └── agents/
│       └── sydney-booker/
└── inspections/             # child node (a service line)
    ├── NODE.md
    └── knowledge/
        └── report-standards.md
```

A visual editor is a pure view over this: rendering the tree is rendering directories, and moving a node is `git mv`. No database, no proprietary state.

## NODE.md

Declares what a node is. Frontmatter for machines, body for models and humans.

```markdown
---
name: sydney
description: The Sydney office — coverage area, team, local pricing.
type: location            # org | department | location | product | topic | custom
---

Everything specific to our Sydney operation. Prefer knowledge here over
root-level defaults when answering Sydney questions.
```

- The **root node** is the organization; its directory name is chosen by the org and has no semantic meaning — identity comes from `NODE.md`, so trees are renameable and portable.
- `type` is advisory vocabulary for tools (icons, grouping in a UI); unknown values are allowed.

## Knowledge files

One concept per file under `knowledge/`, indexed in `KNOWLEDGE.md` (one line per file: `- [Title](file.md) — hook`). Agents read the index first, then fetch only the files a task needs — the navigation model llms.txt established, applied inside the tree.

```markdown
---
name: pricing-model
description: How inspection pricing is calculated, incl. travel surcharges.
sources:
  - https://acme.example/pricing        # where this fact came from
  - conversation:2026-07-12             # or a dated human statement
updated: 2026-07-12
visibility: private                      # private (default) | public
---

Base price is per-inspection-type, plus a travel surcharge beyond 40km
from the nearest office. [[service-area]] defines the zones.
```

- `[[wikilinks]]` reference other concepts by `name`, nearest-node-first.
- `sources` and `updated` are required: a fact without provenance can't be trusted, corrected, or expired.
- `visibility: public` marks the subset exported to the web (see llms.txt bridge).

## Resolution — how agents read the tree

An agent attached at node N assembles context as:

1. N's `NODE.md` body and `knowledge/KNOWLEDGE.md` index,
2. then each ancestor's, walking up to the root,
3. nearest node wins on conflict (same precedence rule as AGENTS.md).

So the Sydney booking agent inherits the org's pricing model but overrides it with Sydney-local knowledge — and attaching an agent to a node *is* the act of scoping it. This is the "agent tree": the hierarchy of agents falls out of where they sit in the knowledge tree, rather than being configured separately.

## Agent writes

Agents may write knowledge (that's how the tree learns), under three rules:

- writes are commits — reviewable, revertible, attributable to the agent and run that made them;
- an agent may write only at its own node or below, never to ancestors;
- every agent-written file carries `sources` pointing at the evidence (a run ID, a fetched URL, a user message).

## llms.txt bridge

`visibility: public` concepts, flattened and indexed, generate the site's `/llms.txt` and companion markdown pages. OKF is the private, structured superset; llms.txt is its public projection. Tools should generate the bridge, never hand-maintain it.

## What OKF deliberately does not define

- **Tenancy, accounts, permissions** — a tenant is one tree; isolation belongs to the host. Recommended hosting practice (non-normative): one git repo per organization, so access control, secret scoping, and history stay isolated by construction.
- **Storage or retrieval machinery** — no embeddings, no databases. If a host builds an index over the tree, that's an optimization, not part of the format.
- **Agent runtime behavior** — how agents execute is the mdagent spec's job; OKF only defines what they know and where they may write.
