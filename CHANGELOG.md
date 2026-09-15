# Changelog

Notable changes to `@foldrun/core`. The format is
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[semantic versioning](https://semver.org/), with the 0.x rule that a
breaking change is a minor bump until 1.0.0.

Entries are drafted from the commit subjects by `npm run release` and then
edited by a person — the commit messages in this repository are the best
description of a change anyone is going to write, so they are the source.

<!-- releases -->

## [0.4.0] — 2026-09-15

- The step clocks stay referenced: a hanging tool call must not let the loop exit around them ([66be8f1](https://github.com/foldrun-io/foldrun-core/commit/66be8f1))
- A parked step's summary carries its instruction and when it last spoke ([27213c3](https://github.com/foldrun-io/foldrun-core/commit/27213c3))
- The step editor reads the option key from the regrouped option regex ([a93ea16](https://github.com/foldrun-io/foldrun-core/commit/a93ea16))
- schema:, parallel: and max_turns: — what a step returns, how wide it fans out, how long it may go ([8723c60](https://github.com/foldrun-io/foldrun-core/commit/8723c60))
- A JSON Schema validator small enough to read, with no dependency ([e9447d9](https://github.com/foldrun-io/foldrun-core/commit/e9447d9))
- A gate's notification carries one step-bound link per waiting step ([ad21a84](https://github.com/foldrun-io/foldrun-core/commit/ad21a84))
- hostSafeEnv is a ProcessEnv, so a host that requires NODE_ENV accepts it ([d993e8e](https://github.com/foldrun-io/foldrun-core/commit/d993e8e))
- A run index beside the records, so a list never parses every run ([85e4589](https://github.com/foldrun-io/foldrun-core/commit/85e4589))
- Every attempt on the record; the step's cost is their sum; a retry's share is what is left ([6c0716d](https://github.com/foldrun-io/foldrun-core/commit/6c0716d))
- An approval link decides one step, before a moment, once — and as somebody ([be7068b](https://github.com/foldrun-io/foldrun-core/commit/be7068b))
- A secret with a line break crosses into the container as a file, out loud ([3350b5e](https://github.com/foldrun-io/foldrun-core/commit/3350b5e))
- The in-process step ends at its timeout and on a stop, on a clock ([49b1ce2](https://github.com/foldrun-io/foldrun-core/commit/49b1ce2))
- One allowlisted host environment for every child a step spawns in-process ([a44ee8c](https://github.com/foldrun-io/foldrun-core/commit/a44ee8c))
- Read an option's value or refuse it; timeout: takes wait:'s units ([7983d77](https://github.com/foldrun-io/foldrun-core/commit/7983d77))
- An eval queues its run wherever a platform owns the queue ([535dd46](https://github.com/foldrun-io/foldrun-core/commit/535dd46))
- Hook tokens hang off the vault's key, made on first ask, never a dev constant ([429ea50](https://github.com/foldrun-io/foldrun-core/commit/429ea50))
- Scrub the reply, the conclusion and the data the way the events already were ([cd15270](https://github.com/foldrun-io/foldrun-core/commit/cd15270))
- csv and tsv are editable workspace files ([cbb92a0](https://github.com/foldrun-io/foldrun-core/commit/cbb92a0))
- Tell the executor a run is a test, so the cluster can deny its pod the world ([ba7c164](https://github.com/foldrun-io/foldrun-core/commit/ba7c164))
- Leave a trail when a run stops or fails between groups ([1b2ee30](https://github.com/foldrun-io/foldrun-core/commit/1b2ee30))
- Tell the platform how each oauth2 refresh went ([86f439a](https://github.com/foldrun-io/foldrun-core/commit/86f439a))
- Merge concurrent appends at write-back instead of overwriting ([f4f01f7](https://github.com/foldrun-io/foldrun-core/commit/f4f01f7))
- The platform's tools, on every account's shelf (#14) ([961d56a](https://github.com/foldrun-io/foldrun-core/commit/961d56a))
- build(deps-dev): bump @types/node from 22.20.1 to 26.5.0 (#4) ([4044fd3](https://github.com/foldrun-io/foldrun-core/commit/4044fd3))
- sdk bump zod pinned (#12) ([684b59d](https://github.com/foldrun-io/foldrun-core/commit/684b59d))
- Say what these hashes actually take (#11) ([def658f](https://github.com/foldrun-io/foldrun-core/commit/def658f))
- Bump typescript from 5.9.3 to 7.0.2 (#3) ([5ec5986](https://github.com/foldrun-io/foldrun-core/commit/5ec5986))
- Bump the actions group with 3 updates (#1) ([e6c1859](https://github.com/foldrun-io/foldrun-core/commit/e6c1859))
- The README told people to use a login the CLI refuses (#10) ([e06ff4e](https://github.com/foldrun-io/foldrun-core/commit/e06ff4e))
- Let GitHub see the licence (#8) ([8987169](https://github.com/foldrun-io/foldrun-core/commit/8987169))
- every CodeQL finding, closed ([12fc759](https://github.com/foldrun-io/foldrun-core/commit/12fc759))
- the record of why nothing happened, and whether a credential still works ([2c56e4d](https://github.com/foldrun-io/foldrun-core/commit/2c56e4d))
- the four gates between a trigger and a run, and who may answer a gate ([59ccd41](https://github.com/foldrun-io/foldrun-core/commit/59ccd41))

### audit

- what three reviewers and a re-read found ([3840300](https://github.com/foldrun-io/foldrun-core/commit/3840300))

### budget

- one grammar, a period, an agent's own cap, and unset means no limit ([418462b](https://github.com/foldrun-io/foldrun-core/commit/418462b))

### dependabot

- weekly, grouped ([064aac3](https://github.com/foldrun-io/foldrun-core/commit/064aac3))

### Dirent.parentPath only

- the deprecated .path fallback fails the box's typecheck ([a2a2dda](https://github.com/foldrun-io/foldrun-core/commit/a2a2dda))

### lint

- an address check that cannot be made slow by a flow file ([3d54582](https://github.com/foldrun-io/foldrun-core/commit/3d54582))

### platform

- edition() — the one question a commercial surface asks ([9ab0e79](https://github.com/foldrun-io/foldrun-core/commit/9ab0e79))

### release

- only stage the lockfile when git tracks it ([6fcf3c1](https://github.com/foldrun-io/foldrun-core/commit/6fcf3c1))

### Revert

- the LICENSE was never the problem (#9) ([ee516f3](https://github.com/foldrun-io/foldrun-core/commit/ee516f3))

### runner image

- build for another platform, named for it ([6fa8a26](https://github.com/foldrun-io/foldrun-core/commit/6fa8a26))

### secrets

- GCM is told its tag length ([6854fba](https://github.com/foldrun-io/foldrun-core/commit/6854fba))

### self-hosting

- ARM has no fallback, and say so ([5bde1db](https://github.com/foldrun-io/foldrun-core/commit/5bde1db))
- the platform, one container, one command — public ([120c970](https://github.com/foldrun-io/foldrun-core/commit/120c970))

### Test mode

- a run that exercises everything and changes nothing outside ([9faa9d3](https://github.com/foldrun-io/foldrun-core/commit/9faa9d3))

### three silent wrongs

- truncated instructions, markers matched in prose, the Test button ([8445735](https://github.com/foldrun-io/foldrun-core/commit/8445735))

### trailing whitespace

- trimEnd, not a regex ([3de915d](https://github.com/foldrun-io/foldrun-core/commit/3de915d))

### when

- and case: read the previous group's result, as documented ([bbcfb56](https://github.com/foldrun-io/foldrun-core/commit/bbcfb56))

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
