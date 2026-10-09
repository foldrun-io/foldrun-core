# Changelog

Notable changes to `@foldrun/core`. The format is
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[semantic versioning](https://semver.org/), with the 0.x rule that a
breaking change is a minor bump until 1.0.0.

Entries are drafted from the commit subjects by `npm run release` and then
edited by a person — the commit messages in this repository are the best
description of a change anyone is going to write, so they are the source.

<!-- releases -->

## [0.7.0] — 2026-10-09

- A tool.md body reaches the model as the tool's guide ([218f41d](https://github.com/foldrun-io/foldrun-core/commit/218f41d))
- Wait for the rotated Claude token on 'OAuth token revoked' too ([aab8eb8](https://github.com/foldrun-io/foldrun-core/commit/aab8eb8))
- A re-run starts after a carried failed step instead of stopping at it ([63b11c3](https://github.com/foldrun-io/foldrun-core/commit/63b11c3))
- Steps learn this install's API address: FOLDRUN_API_URL ([15cf8c5](https://github.com/foldrun-io/foldrun-core/commit/15cf8c5))
- Platform retries for what is not the step's fault; fewer wasted turns ([b9e17f8](https://github.com/foldrun-io/foldrun-core/commit/b9e17f8))
- Packages carry the script a single-file tool runs ([e80a94f](https://github.com/foldrun-io/foldrun-core/commit/e80a94f))
- Export and import a workspace, flow or agent as a .zip (FOL-23) ([ef0be02](https://github.com/foldrun-io/foldrun-core/commit/ef0be02))

### approvals

- deliverEvent takes { by, step } — a signed-in person can release a wait: event step, named on the trace ([6d42265](https://github.com/foldrun-io/foldrun-core/commit/6d42265))

### ci

- the App token step is not fatal — an App not yet installed on a repository mints nothing, and the job uses the token secret instead ([c48740f](https://github.com/foldrun-io/foldrun-core/commit/c48740f))
- cross-repo access through the foldrun-bot GitHub App when it is set up — a token per run, cut to the repositories and permission the job needs; the PAT secrets stay the fallback until then ([b3891b4](https://github.com/foldrun-io/foldrun-core/commit/b3891b4))

### confine

- a web URL whose path says runs/ is not the run journal ([0495b39](https://github.com/foldrun-io/foldrun-core/commit/0495b39))
- leave a workspace/ path as written when the step's link opens it ([1ca98b1](https://github.com/foldrun-io/foldrun-core/commit/1ca98b1))

### core

- blank workspaces, and importing an agent from another workspace ([bd537e9](https://github.com/foldrun-io/foldrun-core/commit/bd537e9))

### deploy

- refuse an agent.md whose frontmatter has no opening --- ([e5f336a](https://github.com/foldrun-io/foldrun-core/commit/e5f336a))
- a push to main asks the box to deploy (repository_dispatch to foldrun-infra) instead of waiting for its schedule ([776b982](https://github.com/foldrun-io/foldrun-core/commit/776b982))

### deps

- @modelcontextprotocol/sdk 1.32.1 (and sharp 0.35.5 in web) for new advisories ([169b604](https://github.com/foldrun-io/foldrun-core/commit/169b604))
- proxy-addr 2.0.8 (and source-map-js 1.2.2 in web) for new advisories ([cbde053](https://github.com/foldrun-io/foldrun-core/commit/cbde053))

### Export/import

- fixes from the audit ([a2cb89f](https://github.com/foldrun-io/foldrun-core/commit/a2cb89f))

### Import

- identical text is not 'would replace'; a package with no AGENTS.md still makes a workspace ([ccf01b2](https://github.com/foldrun-io/foldrun-core/commit/ccf01b2))

### judge

- grades the step's conclusion as the reply, the work as context ([6b1810e](https://github.com/foldrun-io/foldrun-core/commit/6b1810e))

### multi-tenant model keys

- customers bring their own API key ([c4bc270](https://github.com/foldrun-io/foldrun-core/commit/c4bc270))

### parseToolDef

- a frontmatter guide: does not stand in for the body ([2545784](https://github.com/foldrun-io/foldrun-core/commit/2545784))

### release

- a publish npm refuses as already published is a published version — tag it ([a0e892a](https://github.com/foldrun-io/foldrun-core/commit/a0e892a))
- tag without the laptop pre-push hook; actions pinned to commit SHAs ([14da9d3](https://github.com/foldrun-io/foldrun-core/commit/14da9d3))

### release-pr

- approve the release pull request's own ci run — it waits for approval, and the required checks are its jobs ([b3d1d4d](https://github.com/foldrun-io/foldrun-core/commit/b3d1d4d))

### runner

- a plain approval answers an ask: gate; step-exec: a failed tool call's reason reaches the trail ([c37e71f](https://github.com/foldrun-io/foldrun-core/commit/c37e71f))

### runs

- an on-fail rescuer inherits the step's verify ([a8eb1e9](https://github.com/foldrun-io/foldrun-core/commit/a8eb1e9))
- the agent engine's home files stay in the sandbox ([39ec684](https://github.com/foldrun-io/foldrun-core/commit/39ec684))
- a cut model connection runs the step again, unless it already acted outward ([50bbb51](https://github.com/foldrun-io/foldrun-core/commit/50bbb51))
- a re-driven run keeps what its finished steps wrote to storage/ ([24c43aa](https://github.com/foldrun-io/foldrun-core/commit/24c43aa))

### starter

- CLAUDE.md template lists GET on agents/import ([7b9dc5e](https://github.com/foldrun-io/foldrun-core/commit/7b9dc5e))

### step-exec

- state permissionMode "default" — the SDK's auto-mode classifier was refusing granted tools ([a7931fe](https://github.com/foldrun-io/foldrun-core/commit/a7931fe))

### Tool test

- a script gets its granting agent's secrets, as in a run ([3436925](https://github.com/foldrun-io/foldrun-core/commit/3436925))

### web

- tell the agent up front when WebSearch/WebFetch answer search/fetch ([5733803](https://github.com/foldrun-io/foldrun-core/commit/5733803))

### write-back

- mergeAppends in one pass, not quadratic ([c85759b](https://github.com/foldrun-io/foldrun-core/commit/c85759b))

## [0.6.0] — 2026-10-03

### docker scripts

- workspace/… arguments work, outputs/ is writable, and a JavaScript tool gets node ([9cced0b](https://github.com/foldrun-io/foldrun-core/commit/9cced0b))
- a folder tool's tools/ is mounted, and the step's workspace link no longer breaks the copy ([a3e7a11](https://github.com/foldrun-io/foldrun-core/commit/a3e7a11))

### host env

- pass CLAUDE_CONFIG_DIR to a step's children ([c4ec796](https://github.com/foldrun-io/foldrun-core/commit/c4ec796))

### model credential

- an API key, a gateway bearer or a Claude login token — named, used, and on the record ([2f80284](https://github.com/foldrun-io/foldrun-core/commit/2f80284))

### prompts

- workspace/… for every workspace path an agent is told — skills, knowledge, memory, shared scripts, sub-agents ([c832b6a](https://github.com/foldrun-io/foldrun-core/commit/c832b6a))

### release automation

- every push to main keeps a "release X.Y.Z" pull request open; merging it publishes and tags ([46c29ae](https://github.com/foldrun-io/foldrun-core/commit/46c29ae))

### runner image

- install core in its own stage — no tarball or README in slim/full ([63ef907](https://github.com/foldrun-io/foldrun-core/commit/63ef907))

### SDK sessions

- no claude.ai connectors and no on-disk MCP config — an agent gets what foldrun grants, nothing of the person's account ([634216f](https://github.com/foldrun-io/foldrun-core/commit/634216f))

### slim browsing

- a full re-run that throws records its failed try as full, not slim ([7702e7d](https://github.com/foldrun-io/foldrun-core/commit/7702e7d))
- browse actions are read from action positions — a step's own keys and its then/else, not option values ([960ecfd](https://github.com/foldrun-io/foldrun-core/commit/960ecfd))
- a page script is a write — init= on the call, or FOLDRUN_BROWSER_INIT from the agent's web.browse block ([89cdf98](https://github.com/foldrun-io/foldrun-core/commit/89cdf98))

### templates

- write, not the retired files; workspace/memory/ and workspace/knowledge/ ([1e826fe](https://github.com/foldrun-io/foldrun-core/commit/1e826fe))

### test runs

- a later step sees what earlier steps of the run wrote ([9492016](https://github.com/foldrun-io/foldrun-core/commit/9492016))

### ts-test

- test paths are the caller's — platform's `npm run k8s` could not find its own test ([a872917](https://github.com/foldrun-io/foldrun-core/commit/a872917))

### unsubscribe

- a signature with a multibyte character is refused (401), not thrown ([0e2c62e](https://github.com/foldrun-io/foldrun-core/commit/0e2c62e))

## [0.5.0] — 2026-10-02

- workspace/ is the one spelling for the workspace root, in every tool and the shell ([6d8e15e](https://github.com/foldrun-io/foldrun-core/commit/6d8e15e))
- a person in the loop mid-step: tools: [ask] (ask_person) and messages into a running step ([f68b72c](https://github.com/foldrun-io/foldrun-core/commit/f68b72c))
- a step cut off before its closing result is charged for the turns it took ([cfa7c51](https://github.com/foldrun-io/foldrun-core/commit/cfa7c51))
- Mount the runtime cache from a per-tenant Docker volume (#18) ([e959449](https://github.com/foldrun-io/foldrun-core/commit/e959449))
- a subscription's weekly limit is a refusal the second supply answers ([e0b594d](https://github.com/foldrun-io/foldrun-core/commit/e0b594d))
- a 401 from a rotated token is waited out, not a failed run ([d8d2ce8](https://github.com/foldrun-io/foldrun-core/commit/d8d2ce8))
- Let an empty FOLDRUN_RUNNER_IMAGE or FOLDRUN_EGRESS_URL mean what the comments say it means (#17) ([6a02cb1](https://github.com/foldrun-io/foldrun-core/commit/6a02cb1))
- the model credential is read per step, not held from boot ([6dd28e4](https://github.com/foldrun-io/foldrun-core/commit/6dd28e4))
- A web key that cannot work is refused at check and at deploy, not only in the trail ([60ac110](https://github.com/foldrun-io/foldrun-core/commit/60ac110))
- A test fixture that looks like a credential stops the box deploying ([5fddc68](https://github.com/foldrun-io/foldrun-core/commit/5fddc68))
- Provider search shapes, and the files a folder entry is made of ([cee3fc3](https://github.com/foldrun-io/foldrun-core/commit/cee3fc3))
- Say why the model supply refused, in the run's own words ([4634b65](https://github.com/foldrun-io/foldrun-core/commit/4634b65))
- A step's instruction ends where the step ends ([6fcb4c8](https://github.com/foldrun-io/foldrun-core/commit/6fcb4c8))
- The scaffolded CLAUDE.md knows an agent has a calendar ([0d1f838](https://github.com/foldrun-io/foldrun-core/commit/0d1f838))
- Tests for the clock cascade, offsets and the date rolling over ([c48ae7e](https://github.com/foldrun-io/foldrun-core/commit/c48ae7e))
- A timezone nobody can read is refused where it was written ([2b0484a](https://github.com/foldrun-io/foldrun-core/commit/2b0484a))
- The clock an agent works to is resolvable at every level ([91689b6](https://github.com/foldrun-io/foldrun-core/commit/91689b6))
- readTree's rule, asked of a path that is not on this machine ([2f4a39c](https://github.com/foldrun-io/foldrun-core/commit/2f4a39c))
- One helper decides whether a folder is an account or a lone workspace ([92c0bd7](https://github.com/foldrun-io/foldrun-core/commit/92c0bd7))

### AGENTS.md

- the coding-agent block is stripped before the prose reaches an agent ([ae7fe1e](https://github.com/foldrun-io/foldrun-core/commit/ae7fe1e))

### budget

- an agent's cap is shared across its fan-out copies, not handed whole to each ([dd0eabf](https://github.com/foldrun-io/foldrun-core/commit/dd0eabf))

### check

- refuse a web.browse engine paired with what it cannot do, in the tool's words ([9e23642](https://github.com/foldrun-io/foldrun-core/commit/9e23642))
- a gate sharing its number with another step, and a gap in the step numbers ([2281309](https://github.com/foldrun-io/foldrun-core/commit/2281309))
- punctuation is not a shell operator ([ed52184](https://github.com/foldrun-io/foldrun-core/commit/ed52184))
- a prose verify: and a step whose agent does not exist are errors ([d63b64f](https://github.com/foldrun-io/foldrun-core/commit/d63b64f))
- a step that can act outward needs a verify or a gate ([9070dee](https://github.com/foldrun-io/foldrun-core/commit/9070dee))

### CLAUDE.md template

- a Node script started through workspace/ is its own main module ([797fcc8](https://github.com/foldrun-io/foldrun-core/commit/797fcc8))

### completions

- region: ([c017396](https://github.com/foldrun-io/foldrun-core/commit/c017396))

### confine

- refuse a write that would grow storage/, state/ or workspace/ inside an agent's own folder ([b27c27c](https://github.com/foldrun-io/foldrun-core/commit/b27c27c))
- workspace/ still resolves after the SDK makes the path absolute; staging keeps file times ([20c3394](https://github.com/foldrun-io/foldrun-core/commit/20c3394))

### deploy

- the plan and the save share one keep rule; the trigger log survives ([bd5a28e](https://github.com/foldrun-io/foldrun-core/commit/bd5a28e))
- expectRemoved refuses removals nobody confirmed ([1865d0e](https://github.com/foldrun-io/foldrun-core/commit/1865d0e))

### deps

- patch fast-uri and ip-address (transitive via the MCP SDK) ([78fd139](https://github.com/foldrun-io/foldrun-core/commit/78fd139))
- claude-agent-sdk ^0.3.285 (latest) ([6631aff](https://github.com/foldrun-io/foldrun-core/commit/6631aff))

### egress

- a re-granted secret takes the new value — the rotation retry sent the revoked token ([b9594d5](https://github.com/foldrun-io/foldrun-core/commit/b9594d5))

### engine limits

- pdf and webmcp in the one table; obscura prints its raster pdf ([a62743d](https://github.com/foldrun-io/foldrun-core/commit/a62743d))

### evals

- `inputs: true` marks a flow's saved inputs, never run as an eval ([4bcac51](https://github.com/foldrun-io/foldrun-core/commit/4bcac51))

### fetch

- a tenant's URL follows its redirects one hop at a time, each back through the seam ([df35dc5](https://github.com/foldrun-io/foldrun-core/commit/df35dc5))

### flow edits

- a step's options after a blank line go with it; CRLF flows parse ([6232bd0](https://github.com/foldrun-io/foldrun-core/commit/6232bd0))

### flow patterns

- duplicateStep, stepSource and pasteSteps — copy a step beside itself, copy and paste steps as markdown ([959667e](https://github.com/foldrun-io/foldrun-core/commit/959667e))

### flow rewriters

- a CRLF flow is edited as LF and stays CRLF ([b2ac9f0](https://github.com/foldrun-io/foldrun-core/commit/b2ac9f0))

### flow-patterns

- removeStep — delete one step, its options, renumber groups ([e742f9e](https://github.com/foldrun-io/foldrun-core/commit/e742f9e))
- orchestration patterns and team changes as line-level markdown edits ([90efddf](https://github.com/foldrun-io/foldrun-core/commit/90efddf))

### flows

- pause_when — a flow whose work is finished stops itself ([04965ec](https://github.com/foldrun-io/foldrun-core/commit/04965ec))

### flows/agents

- name what silently defaulted; deploy warns on an ungated outward step ([d5cf901](https://github.com/foldrun-io/foldrun-core/commit/d5cf901))

### git hooks

- pre-push checks the pushed commit in a worktree, not the working tree; a failed archive is not a clean scan ([358610c](https://github.com/foldrun-io/foldrun-core/commit/358610c))
- run pre-push checks without git's GIT_DIR ([894a34f](https://github.com/foldrun-io/foldrun-core/commit/894a34f))
- take the repo's own .gitleaks.toml when it has one ([2c6c63e](https://github.com/foldrun-io/foldrun-core/commit/2c6c63e))
- secrets, typecheck and tests before the push, not in CI ([5d4a022](https://github.com/foldrun-io/foldrun-core/commit/5d4a022))

### gitignore

- the ./data fallback, which holds a secret key ([4ffd2ee](https://github.com/foldrun-io/foldrun-core/commit/4ffd2ee))

### gitrepo

- resolveRestorePoint — a sha, ref, date or age to the commit on main a restore means ([20f20d7](https://github.com/foldrun-io/foldrun-core/commit/20f20d7))

### language

- — the language an agent works in, cascading like its clock ([aa54582](https://github.com/foldrun-io/foldrun-core/commit/aa54582))

### layout

- .foldrun-install marks an installation's data root ([de4a3be](https://github.com/foldrun-io/foldrun-core/commit/de4a3be))

### limits

- an API operation counts under the API it was built for, not the longest name it starts with ([bfcd09b](https://github.com/foldrun-io/foldrun-core/commit/bfcd09b))
- per-step call limits for every kind of tool, refused in the PreToolUse hook ([9674eb1](https://github.com/foldrun-io/foldrun-core/commit/9674eb1))

### notify

- durable webhook deliveries and one mail door with preferences and one-click unsubscribe ([8038fe4](https://github.com/foldrun-io/foldrun-core/commit/8038fe4))
- the test notification no longer names the platform in its subject ([c1eac69](https://github.com/foldrun-io/foldrun-core/commit/c1eac69))
- an account with its own sender gets all its mail from it — invites, resets, low balance too ([4aaf990](https://github.com/foldrun-io/foldrun-core/commit/4aaf990))

### operations

- allowlist fails closed ([25d4db6](https://github.com/foldrun-io/foldrun-core/commit/25d4db6))

### operator

- close an unanswered question on the proxy when ask_person times out ([2a8d91d](https://github.com/foldrun-io/foldrun-core/commit/2a8d91d))

### outward steps

- a failed verify's detail line no longer lets the step retry ([1cf315b](https://github.com/foldrun-io/foldrun-core/commit/1cf315b))

### platform hook

- syncPublicShares is asynchronous — share links are rows now, not a manifest ([fa522bf](https://github.com/foldrun-io/foldrun-core/commit/fa522bf))

### prompt

- find storage files by Read or Glob's path, never a climbing pattern ([ed684be](https://github.com/foldrun-io/foldrun-core/commit/ed684be))

### providers

- scrapingbee fetch, zenrows browser; exa description matches the fresh fetch ([da2b9a8](https://github.com/foldrun-io/foldrun-core/commit/da2b9a8))

### region

- — the country an agent works for, with everything it implies derived ([37a1474](https://github.com/foldrun-io/foldrun-core/commit/37a1474))

### retry

- an outward step whose tools ran and whose check then failed is not run again ([1f2d7be](https://github.com/foldrun-io/foldrun-core/commit/1f2d7be))

### Run verdicts

- a completed run that refused itself reads BLOCKED, not success ([a9fe528](https://github.com/foldrun-io/foldrun-core/commit/a9fe528))

### runner

- carry the step's index on its egress lease ([cea36e1](https://github.com/foldrun-io/foldrun-core/commit/cea36e1))
- the slim image ships fonts ([ed6d289](https://github.com/foldrun-io/foldrun-core/commit/ed6d289))
- a person's stop mid-step is said on the step ([a263e9c](https://github.com/foldrun-io/foldrun-core/commit/a263e9c))
- the rotation retry re-grants the model key before it commits the lease ([d88cb15](https://github.com/foldrun-io/foldrun-core/commit/d88cb15))

### runner image

- engine downloads retry; a missing engine leads the error; web.browse vendor_session; pinned UA drift warns ([905246f](https://github.com/foldrun-io/foldrun-core/commit/905246f))
- Debian 13 base, Lightpanda 0.4.1 ([dd5e1c8](https://github.com/foldrun-io/foldrun-core/commit/dd5e1c8))
- slim draws emoji, CJK, Devanagari and Thai; base pin under test ([91867ee](https://github.com/foldrun-io/foldrun-core/commit/91867ee))
- Xvfb by name, and /opt/browser/engines.json says which engines it has ([ecec5a0](https://github.com/foldrun-io/foldrun-core/commit/ecec5a0))
- pin Playwright to 1.63.0 ([ba074c5](https://github.com/foldrun-io/foldrun-core/commit/ba074c5))

### runtime

- take over an abandoned build claim atomically ([0da0fdd](https://github.com/foldrun-io/foldrun-core/commit/0da0fdd))
- a hash-pinned requirements.txt installs its pins, and the log says the hashes were not ([3b20788](https://github.com/foldrun-io/foldrun-core/commit/3b20788))
- a build claim names its holder and beats while it builds; failures end the wait ([6b429ac](https://github.com/foldrun-io/foldrun-core/commit/6b429ac))
- uv, checked cache hits, a slim image, and a shared layer ([7746263](https://github.com/foldrun-io/foldrun-core/commit/7746263))

### script tools

- a gallery program runs on the host when the library has no copy ([dd4eb1f](https://github.com/foldrun-io/foldrun-core/commit/dd4eb1f))

### secret-files

- one directory per step, so a fan-out's first finisher keeps its hands off the rest ([5aff799](https://github.com/foldrun-io/foldrun-core/commit/5aff799))

### secret-health

- a pluggable store; reads are async ([27c779d](https://github.com/foldrun-io/foldrun-core/commit/27c779d))

### secrets

- granting a script tool grants the secrets its file lists ([8bc2964](https://github.com/foldrun-io/foldrun-core/commit/8bc2964))

### Security

- SSRF guard and tenant isolation (foldrun-core) (#16) ([972b6a4](https://github.com/foldrun-io/foldrun-core/commit/972b6a4))

### self-hosting

- the runner image is built when the value is empty, not absent (#19) ([6ded4e4](https://github.com/foldrun-io/foldrun-core/commit/6ded4e4))

### slim browsing

- a full re-run after a lost slim go is the next try; a reconnect that met a closing pod is not "got through" ([96b437e](https://github.com/foldrun-io/foldrun-core/commit/96b437e))
- the slim go a lost browser pod ended is its own try; reconnect lines say when ([5324447](https://github.com/foldrun-io/foldrun-core/commit/5324447))
- a browsing step may run slim through the account's browser pod, with a safe fallback ([c32fc9c](https://github.com/foldrun-io/foldrun-core/commit/c32fc9c))

### SPEC

- a gate holds its group; check warns on a shared number or a gap ([ab41a16](https://github.com/foldrun-io/foldrun-core/commit/ab41a16))

### starter

- /api/version and /api/changelog in the shipped CLAUDE.md's route list ([083f312](https://github.com/foldrun-io/foldrun-core/commit/083f312))
- answer/message routes and the ask tool in the shipped CLAUDE.md ([6daa3b6](https://github.com/foldrun-io/foldrun-core/commit/6daa3b6))
- the canvas and CLI pattern verbs, and where a secret is declared, in every new account's CLAUDE.md ([5f775f0](https://github.com/foldrun-io/foldrun-core/commit/5f775f0))

### starter CLAUDE.md

- /restore, /api/account/backups and /api/me/onboarding in the route tables ([1f2da4c](https://github.com/foldrun-io/foldrun-core/commit/1f2da4c))
- the API conventions every call shares — Foldrun-Version, X-RateLimit-*, Idempotency-Key, /api/openapi.json ([3b84005](https://github.com/foldrun-io/foldrun-core/commit/3b84005))
- a deploy that would delete stops; a coding agent tells the person, never adds --yes on its own ([13b1a41](https://github.com/foldrun-io/foldrun-core/commit/13b1a41))

### step-exec

- rewrite workspace/ in a PreToolUse hook, so reads reach the workspace too ([db54a46](https://github.com/foldrun-io/foldrun-core/commit/db54a46))

### storage

- a signed download's filename survives any alphabet ([dc5270b](https://github.com/foldrun-io/foldrun-core/commit/dc5270b))
- inline-safe types for more media and fonts; scaffold lists /storage/preview ([d41fc50](https://github.com/foldrun-io/foldrun-core/commit/d41fc50))
- preview types, and signed links that may say inline for them ([6da90b4](https://github.com/foldrun-io/foldrun-core/commit/6da90b4))
- the S3 driver signs with the pod's role when no static key is set ([c54c4fa](https://github.com/foldrun-io/foldrun-core/commit/c54c4fa))

### store

- seal what a move into the database leaves behind ([44385bd](https://github.com/foldrun-io/foldrun-core/commit/44385bd))
- seal billing.json, oauth-connections.json, secret-health.json and once/ in the account browser ([7b81016](https://github.com/foldrun-io/foldrun-core/commit/7b81016))

### subagents

- guard undeclared agents, keep the inbox off them, price at their model ([baa56ca](https://github.com/foldrun-io/foldrun-core/commit/baa56ca))
- every refusal names the agent that tried — path and shell checks too ([e5163d1](https://github.com/foldrun-io/foldrun-core/commit/e5163d1))
- delegate a job to a colleague with its own context and tools ([8a123b7](https://github.com/foldrun-io/foldrun-core/commit/8a123b7))

### The whole list

- SERP scrapers, Perplexity, Linkup, and web_browse: for a remote browser ([80f9b7b](https://github.com/foldrun-io/foldrun-core/commit/80f9b7b))

### tool test

- an oauth2 secret reaches the tool as a live token, as it does in a run ([afd37b9](https://github.com/foldrun-io/foldrun-core/commit/afd37b9))
- an operations: allowlist binds the tester too ([8be251c](https://github.com/foldrun-io/foldrun-core/commit/8be251c))

### tool-programs

- toolSecretNeeds — the secret names a script tool's file says it reads ([d06ce0b](https://github.com/foldrun-io/foldrun-core/commit/d06ce0b))

### tools

- retire files and bash too — write and code are the only names ([789a311](https://github.com/foldrun-io/foldrun-core/commit/789a311))
- write and code name the file and shell groups; web, fetch, WebSearch, WebFetch retired ([2d92d86](https://github.com/foldrun-io/foldrun-core/commit/2d92d86))

### translator

- every stop reason a provider can report ([8993cb0](https://github.com/foldrun-io/foldrun-core/commit/8993cb0))

### updateFlowStep

- limits — the step options panel writes {web.search: 10, calls: 300} on one line ([e4d1974](https://github.com/foldrun-io/foldrun-core/commit/e4d1974))

### vault

- every change under a cross-process lock, written atomically ([5974e66](https://github.com/foldrun-io/foldrun-core/commit/5974e66))

### verify

- no timeout: on the step, no clock on its check ([ba0c460](https://github.com/foldrun-io/foldrun-core/commit/ba0c460))
- a check gets what is left of the step's timeout, and a stop ends it ([67d6942](https://github.com/foldrun-io/foldrun-core/commit/67d6942))

### verify test

- run in a real workspace shape; escapes (../../../, absolute, workspace/../..) refused, both spellings of storage accepted ([65e9b83](https://github.com/foldrun-io/foldrun-core/commit/65e9b83))

### web

- remove web_search, web_fetch, web_browse and the SDK web aliases completely ([be223c0](https://github.com/foldrun-io/foldrun-core/commit/be223c0))
- one tool, eight actions, a web: block for who does each ([45533ae](https://github.com/foldrun-io/foldrun-core/commit/45533ae))

### web actions

- one registry of which provider does which action ([b68b8ff](https://github.com/foldrun-io/foldrun-core/commit/b68b8ff))

### web browse

- a pinned user_agent on engine chromium is compared with Chromium, not Google Chrome ([5b9d4ac](https://github.com/foldrun-io/foldrun-core/commit/5b9d4ac))

### web_browse

- live: true in the block keeps the page open between calls ([9ad07cc](https://github.com/foldrun-io/foldrun-core/commit/9ad07cc))
- version: — pick a specific build of the engine ([5e40d3e](https://github.com/foldrun-io/foldrun-core/commit/5e40d3e))
- engine: chrome is real Google Chrome, a fourth browser ([bc7534c](https://github.com/foldrun-io/foldrun-core/commit/bc7534c))
- accept headless: true|false in the agent's block ([ccaa6a7](https://github.com/foldrun-io/foldrun-core/commit/ccaa6a7))
- named identities in the browse settings, and axe-core in the runner image ([9116843](https://github.com/foldrun-io/foldrun-core/commit/9116843))
- chrome and safari, the names people use ([bdea4ce](https://github.com/foldrun-io/foldrun-core/commit/bdea4ce))
- seed localStorage, sessionStorage and IndexedDB from a secret ([617d6c3](https://github.com/foldrun-io/foldrun-core/commit/617d6c3))
- a cookie default must name its site ([95832f2](https://github.com/foldrun-io/foldrun-core/commit/95832f2))
- cookies: and cookie_domain: in the block, refused unless cookies: is a vault name ([b66fedb](https://github.com/foldrun-io/foldrun-core/commit/b66fedb))
- takes a settings block, not only a vendor name ([8c198dc](https://github.com/foldrun-io/foldrun-core/commit/8c198dc))

### web_browse block

- obscura engine, video, live_view; cdp vendor; editable file cap 512 KB ([8b30a94](https://github.com/foldrun-io/foldrun-core/commit/8b30a94))
- allowed_domains, deny, boundaries, init, extensions, webgpu, ignore_https_errors, state_key; engine lightpanda ([8884b62](https://github.com/foldrun-io/foldrun-core/commit/8884b62))

### web_search

- a settings block for the account's own engine ([e3f72f6](https://github.com/foldrun-io/foldrun-core/commit/e3f72f6))
- and web_fetch: take a search or fetch API, with your own key ([381dec7](https://github.com/foldrun-io/foldrun-core/commit/381dec7))

### web.browse.session

- what a vendor's own session is asked for, checked per vendor ([9b9b6a9](https://github.com/foldrun-io/foldrun-core/commit/9b9b6a9))

### when

- rows of <csv>, the reply for a shell verify:, and options a nested flow drops ([a2ddc55](https://github.com/foldrun-io/foldrun-core/commit/a2ddc55))

### workspace/

- a Node program started through the link is its own main module ([7535fe6](https://github.com/foldrun-io/foldrun-core/commit/7535fe6))

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
