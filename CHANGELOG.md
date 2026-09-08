# Changelog

Notable changes to `@foldrun/core`. The format is
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[semantic versioning](https://semver.org/), with the 0.x rule that a
breaking change is a minor bump until 1.0.0.

Entries are drafted from the commit subjects by `npm run release` and then
edited by a person — the commit messages in this repository are the best
description of a change anyone is going to write, so they are the source.

<!-- releases -->

## [0.3.0] — 2026-09-08

- the in-pod budget meter priced every step at Opus rates, and cache reads as fresh input ([476688f](https://github.com/foldrun-io/foldrun-core/commit/476688f))
- steps resume across drivers; retry: waits, and an evicted attempt comes back a size up ([276fd58](https://github.com/foldrun-io/foldrun-core/commit/276fd58))
- workspaceChanged fires from saveWorkspace, so a created workspace is seen too ([c57b3b1](https://github.com/foldrun-io/foldrun-core/commit/c57b3b1))
- Provider presets re-checked against every vendor's docs on 2026-09-06 ([84b7551](https://github.com/foldrun-io/foldrun-core/commit/84b7551))
- Store a run's files when it parks, not only when it ends ([11b363e](https://github.com/foldrun-io/foldrun-core/commit/11b363e))
- The platform seam lives on globalThis, one per process ([adaa40b](https://github.com/foldrun-io/foldrun-core/commit/adaa40b))
- OAuth presets in core, with LinkedIn ([93833d3](https://github.com/foldrun-io/foldrun-core/commit/93833d3))
- Evaluate every applied deploy, and say why an eval could not run ([c684f6d](https://github.com/foldrun-io/foldrun-core/commit/c684f6d))
- Platform mail is foldrun's: notifications, invites and the low-balance warning go through FOLDRUN_RESEND_API_KEY as hello@foldrun.io; agents bring their own ([84f5196](https://github.com/foldrun-io/foldrun-core/commit/84f5196))

### budget

- a hard cap — a step stops itself mid-turn at its share of the remainder ([991e95c](https://github.com/foldrun-io/foldrun-core/commit/991e95c))

### container

- host.docker.internal on run containers, so the egress proxy is reachable on Linux too ([cf694af](https://github.com/foldrun-io/foldrun-core/commit/cf694af))

### egress

- a lease is committed before each attempt; drain and release are async ([ae0772a](https://github.com/foldrun-io/foldrun-core/commit/ae0772a))
- the sandbox never holds a credential it only puts in a header ([3c33424](https://github.com/foldrun-io/foldrun-core/commit/3c33424))

### flows

- priority: high | normal | low — where a flow's runs stand in the queue ([fc6ad29](https://github.com/foldrun-io/foldrun-core/commit/fc6ad29))

### linkedin preset

- r_organization_admin, so a token can find its own pages ([2453c13](https://github.com/foldrun-io/foldrun-core/commit/2453c13))

### notify

- a gate email carries the question and the run's latest verdict line ([3d0b64e](https://github.com/foldrun-io/foldrun-core/commit/3d0b64e))
- a run notification is the account's mail, the platform's is the fallback ([da3d056](https://github.com/foldrun-io/foldrun-core/commit/da3d056))
- a test completing is nobody's news; script arguments accept a number ([de9cb90](https://github.com/foldrun-io/foldrun-core/commit/de9cb90))
- say why Resend refused, not just that it did ([9a5252e](https://github.com/foldrun-io/foldrun-core/commit/9a5252e))

### platform seam

- workspaceChanged; reconcile leaves runs another worker holds ([aa65f36](https://github.com/foldrun-io/foldrun-core/commit/aa65f36))

### preview

- named in SPEC.md and the scaffold's step table ([73118db](https://github.com/foldrun-io/foldrun-core/commit/73118db))
- on a gated step — what the approval box shows, declared ([b13fd8e](https://github.com/foldrun-io/foldrun-core/commit/b13fd8e))

### release

- publish by trusted publishing, not a stored token ([fb73350](https://github.com/foldrun-io/foldrun-core/commit/fb73350))

### release engineering

- changelog, tagged releases, CI, and the community files ([0f64c03](https://github.com/foldrun-io/foldrun-core/commit/0f64c03))

### runner

- FOLDRUN_WORKSPACE in every step's environment ([72ca745](https://github.com/foldrun-io/foldrun-core/commit/72ca745))
- wait out a busy provider before failing the step ([e72a59e](https://github.com/foldrun-io/foldrun-core/commit/e72a59e))
- a decision that lands while a gate is being parked is kept, not erased ([176f440](https://github.com/foldrun-io/foldrun-core/commit/176f440))

### runner image

- install firefox and webkit beside chromium ([d8baf83](https://github.com/foldrun-io/foldrun-core/commit/d8baf83))

### search

- an inverted index behind search_files, refreshed by mtime ([70cbffc](https://github.com/foldrun-io/foldrun-core/commit/70cbffc))

### store

- readFrontmatter, exported for the CLI ([02ee106](https://github.com/foldrun-io/foldrun-core/commit/02ee106))

### tools

- [desks] — what the account's other workspaces concluded, gathered host-side ([eaefa29](https://github.com/foldrun-io/foldrun-core/commit/eaefa29))

### translator

- Responses format driven live against api.openai.com ([f2a7b78](https://github.com/foldrun-io/foldrun-core/commit/f2a7b78))
- format responses — OpenAI's Responses API as the third wire ([d57cdc4](https://github.com/foldrun-io/foldrun-core/commit/d57cdc4))

## [0.2.0] — 2026-09-07

The first version published after the npm scope was wiped and recreated;
`0.1.x` is burned and cannot be reused.

- Agents, flows, tools, skills, evals and knowledge as one plain-text
  folder, with the parser, the checks and the run record.
- The step runner: one sandbox per step (a container, or whatever the
  platform seam registers), the workspace copied in and its changes copied
  back through a filter.
- ~30 model providers through one `provider:` block — Anthropic-shaped
  direct, Chat Completions and Responses through the in-sandbox translator.
- `foldrun check`'s rules, the eval runner, and the OKF conformance pass.

## [0.1.0] — 2026-09-05

First publish. Withdrawn with the scope wipe; do not install.

[0.2.0]: https://github.com/foldrun-io/foldrun-core/releases/tag/v0.2.0
