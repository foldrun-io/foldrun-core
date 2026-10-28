# Changelog

Notable changes to `@foldrun/core`. The format is
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[Semantic Versioning 2.0.0](https://semver.org/spec/v2.0.0.html) from 1.0.0:
a patch is a bug fix, nothing new; a minor adds something and breaks
nothing; a major breaks something, and its entry opens with Breaking
changes. Pre-releases (`1.3.0-rc.1`) are published under npm's `next` tag.

Entries are drafted from the commit subjects by `npm run release` and then
edited by a person — the commit messages in this repository are the best
description of a change anyone is going to write, so they are the source.

<!-- releases -->

## [3.0.0] — 2026-10-28

### Breaking changes

- `SUBAGENT_IMPORT_DIRS` from `@foldrun/core` — was a const, now a value
- `KindMeta` from `@foldrun/core/kinds` — copyBack is new and required

### Widened in the public API

Declarations that only widened — optional members or trailing parameters added, nothing removed or retyped. Any other change to a declaration is counted as a break (scripts/surface-change.mjs).

- `StepRecord` from `@foldrun/core`
- `Roots` from `@foldrun/core`

### New in the public API

- `CopyBackClass` from `@foldrun/core/kinds`
- `WORKSPACE_CONFIG_FILES` from `@foldrun/core/kinds`
- `SUBAGENT_IMPORT_DIRS` from `@foldrun/core/kinds`

- test(copy-back): drop an assertion about the library — read-only is the mount's, not checkPaths' ([daa28fa](https://github.com/foldrun-io/foldrun-core/commit/daa28fa))
- feat(copy-back): a step a person approved may change config and code; every handed-back hash counts (FOL-96 review) ([7ca19c7](https://github.com/foldrun-io/foldrun-core/commit/7ca19c7))

### feat

- copy-back keeps data only; config and code a step changes are refused (FOL-96) ([423928c](https://github.com/foldrun-io/foldrun-core/commit/423928c))

## [2.14.3] — 2026-10-28

- fix(schema): idempotency: false passes foldrun check (FOL-94 review) ([b46ff9f](https://github.com/foldrun-io/foldrun-core/commit/b46ff9f))
- fix(triggers): dedupe GitHub deliveries by default (FOL-94) ([2c624f4](https://github.com/foldrun-io/foldrun-core/commit/2c624f4))

## [2.14.2] — 2026-10-27

- ci(release): a changed declaration is judged, not listed; release recovers from a half-done run ([227eec9](https://github.com/foldrun-io/foldrun-core/commit/227eec9))

## [2.14.1] — 2026-10-27

- ci(release): release-merge looks for its own evidence — ci's hint, a 10-minute schedule ([cb4d86a](https://github.com/foldrun-io/foldrun-core/commit/cb4d86a))
- ci(release): merge the release PR once ci passes on its exact head; tell the CLI when a core is out ([489c3d4](https://github.com/foldrun-io/foldrun-core/commit/489c3d4))

## [2.14.0] — 2026-10-27

### Changed in the public API

Declarations whose shape changed. Check that each still accepts what it did; one that does not is a break, and needs a `!` commit before this merges.

- `FlowInfo` from `@foldrun/core`
- `StepRecord` from `@foldrun/core`
- `RunRecord` from `@foldrun/core`
- `PlatformHooks` from `@foldrun/core`

### New in the public API

- `RoomLevel` from `@foldrun/core`

- feat(compute): disk, and compute: for a flow — each run's pool ([7280639](https://github.com/foldrun-io/foldrun-core/commit/7280639))
- feat(room): a step with no room waits — no time limit — and its run waits in the queue ([df9a801](https://github.com/foldrun-io/foldrun-core/commit/df9a801))
- fix(resume): the orphan sweep keeps the sandboxes its siblings re-attach to ([23f4ec4](https://github.com/foldrun-io/foldrun-core/commit/23f4ec4))

## [2.13.1] — 2026-10-26

- fix(run): a docker step's record holds the cores Docker gave it ([debea64](https://github.com/foldrun-io/foldrun-core/commit/debea64))

## [2.13.0] — 2026-10-26

### Changed in the public API

Declarations whose shape changed. Check that each still accepts what it did; one that does not is a break, and needs a `!` commit before this merges.

- `StepRecord` from `@foldrun/core`

- feat(run): a step's container is capped at its class's cores, and records throttled time ([9df43fc](https://github.com/foldrun-io/foldrun-core/commit/9df43fc))
- fix(run): the docker executor passes memory in a spelling docker accepts ([a02ab00](https://github.com/foldrun-io/foldrun-core/commit/a02ab00))

### feat

- compute: in the account's AGENTS.md, and step.holding — what a sandbox holds while it exists ([267f757](https://github.com/foldrun-io/foldrun-core/commit/267f757))
- resources: {cpu, memory, disk} on an agent, over its size class key by key ([191cc3f](https://github.com/foldrun-io/foldrun-core/commit/191cc3f))

### fix

- a refused credential-less container step does not also say it will fall back to a login ([cf8cc4f](https://github.com/foldrun-io/foldrun-core/commit/cf8cc4f))
- self-hosting tells you what to set — a full Docker disk, no model credential ([0798444](https://github.com/foldrun-io/foldrun-core/commit/0798444))

## [2.12.1] — 2026-10-25

### deps

- claude-agent-sdk 0.3.309 (#1) ([62d8b02](https://github.com/foldrun-io/foldrun-core/commit/62d8b02))

## [2.12.0] — 2026-10-25

### ci

- GitHub's hosted runners, now that this repository is public ([44f8f60](https://github.com/foldrun-io/foldrun-core/commit/44f8f60))

### docs

- the README says foldrun is source-available and self-hostable ([4b78086](https://github.com/foldrun-io/foldrun-core/commit/4b78086))

### licence

- Functional Source License 1.1 (Apache 2.0 future licence) ([1f9d550](https://github.com/foldrun-io/foldrun-core/commit/1f9d550))

### test

- test names and comments name no customer desk ([524dbb2](https://github.com/foldrun-io/foldrun-core/commit/524dbb2))
- fixtures and comments name no customer ([a877388](https://github.com/foldrun-io/foldrun-core/commit/a877388))

## [2.11.1] — 2026-10-25

- fix(build): clear dist before compiling, so a release ships only today's code ([73170f0](https://github.com/foldrun-io/foldrun-core/commit/73170f0))

## [2.11.0] — 2026-10-25

### Changed in the public API

Declarations whose shape changed. Check that each still accepts what it did; one that does not is a break, and needs a `!` commit before this merges.

- `FlowInfo` from `@foldrun/core`
- `EvalInfo` from `@foldrun/core`
- `AssertionResult` from `@foldrun/core`
- `CaseResult` from `@foldrun/core`
- `runEval` from `@foldrun/core`
- `TriggerAdmission` from `@foldrun/core`
- `PlatformHooks` from `@foldrun/core`

### New in the public API

- `assertEditablePath` from `@foldrun/core`
- `MAX_GRADER_JUDGES` from `@foldrun/core`
- `EvalRunOptions` from `@foldrun/core`
- `JUDGE_TIMEOUT_MS` from `@foldrun/core`
- `judgeCall` from `@foldrun/core`
- `checkAssertion` from `@foldrun/core`
- `GRADE_WINDOW_MS` from `@foldrun/core`
- `GRADE_KEEP_MS` from `@foldrun/core`
- `GRADE_KEEP_LINES` from `@foldrun/core`
- `GradeAssertion` from `@foldrun/core`
- `GradeCheck` from `@foldrun/core`
- `Grade` from `@foldrun/core`
- `listGraders` from `@foldrun/core`
- `evalRevision` from `@foldrun/core`
- `sampled` from `@foldrun/core`
- `gradedOutput` from `@foldrun/core`
- `gradeRun` from `@foldrun/core`
- `recordGrade` from `@foldrun/core`
- `readGrades` from `@foldrun/core`
- `gradesOfRun` from `@foldrun/core`
- `GradeSummary` from `@foldrun/core`
- `summariseGrades` from `@foldrun/core`
- `graderSince` from `@foldrun/core`
- `graderLastServed` from `@foldrun/core`
- `GRADE_RETRY_MS` from `@foldrun/core`
- `GRADE_TRIES` from `@foldrun/core`
- `gradeCandidates` from `@foldrun/core`
- `pruneGrades` from `@foldrun/core`
- `gradeWorkspace` from `@foldrun/core`
- `MAX_CONFIGS` from `@foldrun/core`
- `MAX_REPEAT` from `@foldrun/core`
- `MAX_TRIALS` from `@foldrun/core`
- `DEFAULT_MAX_USD` from `@foldrun/core`
- `MAX_MAX_USD` from `@foldrun/core`
- `CompareConfig` from `@foldrun/core`
- `ComparePlan` from `@foldrun/core`
- `CompareCaseRow` from `@foldrun/core`
- `CompareConfigResult` from `@foldrun/core`
- `EvalComparison` from `@foldrun/core`
- `configLabel` from `@foldrun/core`
- …and 10 more

- fix(deps): zod 4.6.7, body-parser 2.4, fast-uri (npm audit) ([eaeb9b2](https://github.com/foldrun-io/foldrun-core/commit/eaeb9b2))

### feat

- graders, model comparisons and trigger filters ([7beca99](https://github.com/foldrun-io/foldrun-core/commit/7beca99))

### fix

- SSRF guard on tool test + server-side model calls, body cap (FOL-85) (#46) ([1463b0a](https://github.com/foldrun-io/foldrun-core/commit/1463b0a))

## [2.10.1] — 2026-10-23

### fix

- web.fetch: anthropic is answered by foldrun's own fetch ([93ead76](https://github.com/foldrun-io/foldrun-core/commit/93ead76))

## [2.10.0] — 2026-10-23

### feat

- copy a sandbox: own job's files back into the delegating step's sandbox ([940b022](https://github.com/foldrun-io/foldrun-core/commit/940b022))

## [2.9.0] — 2026-10-23

### New in the public API

- `sameSupply` from `@foldrun/core`

- fix(deps): runner base on Node 22.23.4 (21 Oct security release), ip-address 10.7.4 ([ca550de](https://github.com/foldrun-io/foldrun-core/commit/ca550de))

### fix

- no retry after the model usage cap is reached ([7da83c8](https://github.com/foldrun-io/foldrun-core/commit/7da83c8))
- no on-fail rescue on the same model supply after a spent window or refused credential ([0cc4903](https://github.com/foldrun-io/foldrun-core/commit/0cc4903))

## [2.8.0] — 2026-10-22

### Changed in the public API

Declarations whose shape changed. Check that each still accepts what it did; one that does not is a break, and needs a `!` commit before this merges.

- `AgentInfo` from `@foldrun/core`
- `StepRecord` from `@foldrun/core`
- `PlatformHooks` from `@foldrun/core`

### Deprecated

Still here and still working; to be removed in a later major. Move off them now.

- `OAUTH_PRESETS` from `@foldrun/core`
- `OAUTH_PRESET_NAMES` from `@foldrun/core`

### New in the public API

- `StepDelegation` from `@foldrun/core`
- `isSplicedRecord` from `@foldrun/core`
- `buildDelegateSpecs` from `@foldrun/core`
- `DelegateSpec` from `@foldrun/core/subagents`
- `ownSandbox` from `@foldrun/core/subagents`
- `delegateToolName` from `@foldrun/core/subagents`

- feat(subagents): sandbox: own — a sub-agent that works in its own sandbox ([214ac2d](https://github.com/foldrun-io/foldrun-core/commit/214ac2d))

### deprecate OAUTH_PRESETS

- a runner keeps no provider list ([93609ff](https://github.com/foldrun-io/foldrun-core/commit/93609ff))

## [2.7.0] — 2026-10-22

### Changed in the public API

Declarations whose shape changed. Check that each still accepts what it did; one that does not is a break, and needs a `!` commit before this merges.

- `SecretKind` from `@foldrun/core`
- `OAuth2Config` from `@foldrun/core`
- `ServiceAccountConfig` from `@foldrun/core`
- `ApiConfig` from `@foldrun/core`

### New in the public API

- `tokenCacheKey` from `@foldrun/core`
- `replaceOAuth2RefreshToken` from `@foldrun/core`
- `ClientCertConfig` from `@foldrun/core`
- `setClientCertSecret` from `@foldrun/core`
- `IdentityConfig` from `@foldrun/core`
- `setIdentitySecret` from `@foldrun/core`
- `isIdentityValue` from `@foldrun/core`
- `identityOf` from `@foldrun/core`
- `isClientCertValue` from `@foldrun/core`
- `withoutHeldCerts` from `@foldrun/core`
- `clientCertOf` from `@foldrun/core`
- `basicAuthorization` from `@foldrun/core`

- feat(identity): keyless cloud identity — a step's token file, kept fresh by the driver ([0aaab50](https://github.com/foldrun-io/foldrun-core/commit/0aaab50))
- feat(secrets): client certificates for mutual TLS ([2f8dfd3](https://github.com/foldrun-io/foldrun-core/commit/2f8dfd3))
- feat(secrets): service accounts act as a user (JWT bearer subject); Basic from a username and password ([b9aaddb](https://github.com/foldrun-io/foldrun-core/commit/b9aaddb))
- feat(oauth): public clients refresh with no secret; rotated refresh tokens are saved back ([a5d7476](https://github.com/foldrun-io/foldrun-core/commit/a5d7476))
- fix(secrets): token caches keyed by account and the whole credential, not by names ([1b89d42](https://github.com/foldrun-io/foldrun-core/commit/1b89d42))

## [2.6.0] — 2026-10-21

### Changed in the public API

Declarations whose shape changed. Check that each still accepts what it did; one that does not is a break, and needs a `!` commit before this merges.

- `frontmatterErrorText` from `@foldrun/core` (was a function, now a value)
- `StepRecord` from `@foldrun/core`
- `parseEval` from `@foldrun/core`

### New in the public API

- `RESCUE_MARKER` from `@foldrun/core`
- `isRescueRecord` from `@foldrun/core`
- `judgeDefaults` from `@foldrun/core`
- `judgeProcessEnv` from `@foldrun/core`
- `regexProblem` from `@foldrun/core`
- `keySpan` from `@foldrun/core/agents-md`
- `STRICT_FRONTMATTER_PATH` from `@foldrun/core/scan`

- fix(runner): no TypeScript in the driver template — every step on v2026.10.21.5 died loading it ([75e00ee](https://github.com/foldrun-io/foldrun-core/commit/75e00ee))
- fix(core): judges reason first and give PASS or FAIL last ([aecb510](https://github.com/foldrun-io/foldrun-core/commit/aecb510))
- fix(runner): one rescue per failure, and a stop that stays stopped ([9593708](https://github.com/foldrun-io/foldrun-core/commit/9593708))
- feat(check): report a matches: that is not a valid JavaScript regex ([1781e93](https://github.com/foldrun-io/foldrun-core/commit/1781e93))
- feat(check): config/invalid-frontmatter for skills and library files ([b608b18](https://github.com/foldrun-io/foldrun-core/commit/b608b18))
- fix(evals): the judge reads the live model credential ([cedf091](https://github.com/foldrun-io/foldrun-core/commit/cedf091))

### feat

- the four jobs — governance, guardrail, observability, evaluation blocks ([8fab481](https://github.com/foldrun-io/foldrun-core/commit/8fab481))

## [2.5.0] — 2026-10-21

### Changed in the public API

Declarations whose shape changed. Check that each still accepts what it did; one that does not is a break, and needs a `!` commit before this merges.

- `AgentInfo` from `@foldrun/core`
- `FlowInfo` from `@foldrun/core`
- `RunEvent` from `@foldrun/core`
- `StepMessage` from `@foldrun/core`
- `StepRecord` from `@foldrun/core`
- `RunRecord` from `@foldrun/core`
- `RunSummaryStep` from `@foldrun/core`
- `RunSummary` from `@foldrun/core`
- `reconcileRuns` from `@foldrun/core`
- `reconcileAllRuns` from `@foldrun/core`
- `promoteRunToEval` from `@foldrun/core`
- `ProviderPreset` from `@foldrun/core`
- `TranslatorSpec` from `@foldrun/core`
- `toChatCompletions` from `@foldrun/core`
- `toResponses` from `@foldrun/core`
- `translatorSpecFor` from `@foldrun/core`
- `TriggerAdmission` from `@foldrun/core`
- `readTree` from `@foldrun/core`
- `ProviderPreset` from `@foldrun/core/providers`
- `ScanFinding` from `@foldrun/core/scan`

### New in the public API

- `frontmatterErrorText` from `@foldrun/core`
- `OwnerSource` from `@foldrun/core`
- `resolveOwner` from `@foldrun/core`
- `ModelCall` from `@foldrun/core`
- `CAPTURE_CAP` from `@foldrun/core`
- `CapturedCall` from `@foldrun/core`
- `PromptLayerRecord` from `@foldrun/core`
- `promptLayersChanged` from `@foldrun/core`
- `promptCacheNote` from `@foldrun/core`
- `writeCapturedCall` from `@foldrun/core`
- `readCapturedCall` from `@foldrun/core`
- `MODEL_ENV_NAMES` from `@foldrun/core`
- `DECLARED_ENV_PREFIX` from `@foldrun/core`
- `isModelEnvName` from `@foldrun/core`
- `modelSecretCollision` from `@foldrun/core`
- `markResponding` from `@foldrun/core`
- `untilFirstReply` from `@foldrun/core`
- `warmGate` from `@foldrun/core`
- `ReconcileEnd` from `@foldrun/core`
- `changedPathsBetween` from `@foldrun/core`
- `sendPlainNotificationOutcome` from `@foldrun/core`
- `ReadTreeOptions` from `@foldrun/core`
- `TreeTooLarge` from `@foldrun/core`
- `DEPLOY_BLOCK_MODES` from `@foldrun/core`
- `DeployBlockMode` from `@foldrun/core`
- `deployBlockMode` from `@foldrun/core`
- `deployBlockers` from `@foldrun/core`
- `changedPathsBetween` from `@foldrun/core/history`
- `REPEAT_KEY` from `@foldrun/core/limits`
- `callKeysFor` from `@foldrun/core/limits`
- `hostsInTrail` from `@foldrun/core/network`
- `networkEnforceWanted` from `@foldrun/core/network`
- `untrustedTextFindings` from `@foldrun/core/scan`
- `PER_FILE_RULE` from `@foldrun/core/scan`

- feat(core): reconcileRuns tells an onEnd callback about runs it closed or saw to the end ([c5df0c9](https://github.com/foldrun-io/foldrun-core/commit/c5df0c9))
- feat(core): telemetry: — a run as an OpenTelemetry trace (OTLP/HTTP JSON) ([23cd117](https://github.com/foldrun-io/foldrun-core/commit/23cd117))
- feat(core): behaviour alerts and limits: repeat ([4685a81](https://github.com/foldrun-io/foldrun-core/commit/4685a81))
- feat(core): alerts: stale_days, and when each agent last ran ([5ac3dca](https://github.com/foldrun-io/foldrun-core/commit/5ac3dca))
- feat(core): halted — a trigger refused because its account or workspace is paused ([dd64104](https://github.com/foldrun-io/foldrun-core/commit/dd64104))
- feat(core): network_enforce: true in an account's or workspace's AGENTS.md asks the proxy to refuse ([b56a55d](https://github.com/foldrun-io/foldrun-core/commit/b56a55d))
- feat(core): owner: — who answers for an agent or a flow, else the workspace's, else the account's ([67d5065](https://github.com/foldrun-io/foldrun-core/commit/67d5065))
- fix(core): the checks read a workspace within budgets, so a desk's state/ cannot take the worker down ([c7ef26b](https://github.com/foldrun-io/foldrun-core/commit/c7ef26b))
- build(deps): bump @anthropic-ai/claude-agent-sdk (#43) ([90af857](https://github.com/foldrun-io/foldrun-core/commit/90af857))
- feat(core): issueDoctor — what the run doctor reads for an issue ([513ddea](https://github.com/foldrun-io/foldrun-core/commit/513ddea))
- fix(core): no cache-boundary marker; the fan-out gate opens when the lead's response starts ([e4443e6](https://github.com/foldrun-io/foldrun-core/commit/e4443e6))
- fix(core): one unreadable frontmatter can no longer take the worker down ([4882040](https://github.com/foldrun-io/foldrun-core/commit/4882040))
- feat(core): tools: [peers] — steps of one parallel group message each other mid-step ([bc229d8](https://github.com/foldrun-io/foldrun-core/commit/bc229d8))
- feat(core): prompt cache layers — stable prefix first, SDK boundary, warm gate for fan-outs, cache key for OpenAI-format providers ([a99ff4b](https://github.com/foldrun-io/foldrun-core/commit/a99ff4b))
- fix(core): auto-close resets earlier acks/snoozes; 1.5k is 1500; search reads whole records (Codex review of FOL-72) ([6acd92f](https://github.com/foldrun-io/foldrun-core/commit/6acd92f))
- feat(core): a run that went wrong becomes an eval case with what it should have done (FOL-72 step 10) ([4dc5c93](https://github.com/foldrun-io/foldrun-core/commit/4dc5c93))
- feat(core): search runs by tool, tool errors, agent, model, tokens, time (FOL-72 step 9) ([fb2f408](https://github.com/foldrun-io/foldrun-core/commit/fb2f408))
- feat(core): insights — recurring problems with evidence and cost (FOL-72 step 8) ([ca59a75](https://github.com/foldrun-io/foldrun-core/commit/ca59a75))
- feat(core): alerts: thresholds — failure rate, credits a day, slow runs (FOL-72 step 7) ([e95cc46](https://github.com/foldrun-io/foldrun-core/commit/e95cc46))
- feat(core): issues regress, snooze for N more, auto-close per flow, missed schedules (FOL-72 step 7) ([bd062c6](https://github.com/foldrun-io/foldrun-core/commit/bd062c6))
- feat(core): compare two runs of a flow; RunRecord.rerunOf (FOL-72 step 6) ([b623f96](https://github.com/foldrun-io/foldrun-core/commit/b623f96))
- feat(core): a run as one tree — run, step, model call, tool call (FOL-72 step 5) ([c3b55b2](https://github.com/foldrun-io/foldrun-core/commit/c3b55b2))
- fix(core): each model call's true output tokens and stop reason (FOL-72) ([4b87d9b](https://github.com/foldrun-io/foldrun-core/commit/4b87d9b))
- feat(core): runs record each model call and each tool call's input and output (FOL-54 step 4) ([b736fe4](https://github.com/foldrun-io/foldrun-core/commit/b736fe4))
- feat(core): issues — what went wrong, open until a person resolves it (FOL-54 step 3) ([73a4daa](https://github.com/foldrun-io/foldrun-core/commit/73a4daa))
- feat(core): one way to count run outcomes (FOL-54 step 1) ([87793a9](https://github.com/foldrun-io/foldrun-core/commit/87793a9))
- feat(core): online security checks — known vulnerabilities and remote MCP tool text (FOL-58) ([8ae0b7c](https://github.com/foldrun-io/foldrun-core/commit/8ae0b7c))
- feat(core): deploy_block — refuse a deploy on security findings (FOL-58) ([a585cfa](https://github.com/foldrun-io/foldrun-core/commit/a585cfa))
- fix(core): a secret named like a model variable no longer replaces the step's model settings (FOL-19) ([cca43c2](https://github.com/foldrun-io/foldrun-core/commit/cca43c2))

### ci

- run directly in the CI VM as its runner user, not in a root container (FOL-62) (#45) ([b820f15](https://github.com/foldrun-io/foldrun-core/commit/b820f15))
- drop the deploy dispatcher — the box deploy's own schedule picks up main (FOL-62) (#44) ([246a250](https://github.com/foldrun-io/foldrun-core/commit/246a250))
- run tests on the self-hosted ci runner (FOL-62) (#42) ([98d9d96](https://github.com/foldrun-io/foldrun-core/commit/98d9d96))

## [2.4.0] — 2026-10-18

- feat(core): an eval judge runs on an OpenAI-format key through the translator (FOL-16) ([7045bf3](https://github.com/foldrun-io/foldrun-core/commit/7045bf3))

## [2.3.0] — 2026-10-18

### Changed in the public API

Declarations whose shape changed. Check that each still accepts what it did; one that does not is a break, and needs a `!` commit before this merges.

- `RunEvent` from `@foldrun/core`
- `StepAttempt` from `@foldrun/core`
- `StepRecord` from `@foldrun/core`

- fix(core): keep a long result in a file only for an agent that can read it back ([f388e7a](https://github.com/foldrun-io/foldrun-core/commit/f388e7a))
- feat(core): a long script or API result is kept in a file and previewed, not cut ([afff830](https://github.com/foldrun-io/foldrun-core/commit/afff830))
- feat(core): record where a step's input tokens go ([5dc04fd](https://github.com/foldrun-io/foldrun-core/commit/5dc04fd))
- refactor(core): token helpers in a pure module the dashboard can bundle ([47859de](https://github.com/foldrun-io/foldrun-core/commit/47859de))

## [2.2.0] — 2026-10-17

### Changed in the public API

Declarations whose shape changed. Check that each still accepts what it did; one that does not is a break, and needs a `!` commit before this merges.

- `CatalogModel` from `@foldrun/core`

### New in the public API

- `parseModels` from `@foldrun/core`
- `TokenPrice` from `@foldrun/core`
- `tokenPriceOf` from `@foldrun/core`
- `costOf` from `@foldrun/core`

- fix(catalog): an unquoted price is unknown, not free ([49c9542](https://github.com/foldrun-io/foldrun-core/commit/49c9542))
- fix(pricing): cached tokens at the gateway's own cache prices ([03e1da6](https://github.com/foldrun-io/foldrun-core/commit/03e1da6))

## [2.1.0] — 2026-10-17

### Changed in the public API

Declarations whose shape changed. Check that each still accepts what it did; one that does not is a break, and needs a `!` commit before this merges.

- `saveWorkspace` from `@foldrun/core`
- `StepAttempt` from `@foldrun/core`
- `StepRecord` from `@foldrun/core`
- `RunSummaryStep` from `@foldrun/core`
- `repriced` from `@foldrun/core`
- `catalogCost` from `@foldrun/core`
- `planDeploy` from `@foldrun/core`
- `DeployOptions` from `@foldrun/core`

### New in the public API

- `TokenUsage` from `@foldrun/core`
- `tokensOf` from `@foldrun/core`
- `sumTokens` from `@foldrun/core`
- `cacheHitRate` from `@foldrun/core`
- `measuredHitRate` from `@foldrun/core`
- `runTokens` from `@foldrun/core`
- `CACHE_WRITE_MULTIPLIER` from `@foldrun/core`
- `CACHE_READ_MULTIPLIER` from `@foldrun/core`
- `anthropicUsage` from `@foldrun/core`

- feat(core): count prompt-cache reads and writes beside input tokens ([1581184](https://github.com/foldrun-io/foldrun-core/commit/1581184))
- fix(store): preserving files never follows a link out of the workspace ([5689d32](https://github.com/foldrun-io/foldrun-core/commit/5689d32))
- fix(runner): a step refused for no model key never claims the platform login (FOL-14) ([c518c96](https://github.com/foldrun-io/foldrun-core/commit/c518c96))
- feat(deploy): keepUntracked — a deploy that leaves what is not editable source ([2ccb083](https://github.com/foldrun-io/foldrun-core/commit/2ccb083))

## [2.0.0] — 2026-10-17

### Breaking changes

- the exports above are gone, and so is ./git-hook from the (d419493)
- revisions recorded from now on have r-… ids, not git (228b695)
- `syncLibraryFromTree` from `@foldrun/core` is gone (it was never deprecated)
- `registerAfterCommit` from `@foldrun/core` is gone (it was never deprecated)
- `notifyCommit` from `@foldrun/core` is gone (it was never deprecated)
- `ensureImported` from `@foldrun/core` is gone (it was never deprecated)
- `repoDir` from `@foldrun/core` is gone (it was never deprecated)
- `gitAvailable` from `@foldrun/core` is gone (it was never deprecated)
- `repoExists` from `@foldrun/core` is gone (it was never deprecated)
- `ensureRepo` from `@foldrun/core` is gone (it was never deprecated)
- `headSha` from `@foldrun/core` is gone (it was never deprecated)
- `commitChanges` from `@foldrun/core` is gone (it was never deprecated)
- `listCommits` from `@foldrun/core` is gone (it was never deprecated)
- `readCommit` from `@foldrun/core` is gone (it was never deprecated)
- `RefInfo` from `@foldrun/core` is gone (it was never deprecated)
- `listRefs` from `@foldrun/core` is gone (it was never deprecated)
- `resolveRestorePoint` from `@foldrun/core` is gone (it was never deprecated)
- `listTree` from `@foldrun/core` is gone (it was never deprecated)
- `readBlob` from `@foldrun/core` is gone (it was never deprecated)
- `filesAt` from `@foldrun/core` is gone (it was never deprecated)
- `diffRefs` from `@foldrun/core` is gone (it was never deprecated)
- `mergeBranch` from `@foldrun/core` is gone (it was never deprecated)
- `deleteBranch` from `@foldrun/core` is gone (it was never deprecated)
- `pushMirror` from `@foldrun/core` is gone (it was never deprecated)
- `hookScriptPath` from `@foldrun/core` is gone (it was never deprecated)
- `installHooks` from `@foldrun/core` is gone (it was never deprecated)
- `PushNote` from `@foldrun/core` is gone (it was never deprecated)
- `pushNotePath` from `@foldrun/core` is gone (it was never deprecated)
- `readPushNote` from `@foldrun/core` is gone (it was never deprecated)
- `writePushNote` from `@foldrun/core` is gone (it was never deprecated)
- `applyPendingPush` from `@foldrun/core` is gone (it was never deprecated)
- `TarEntry` from `@foldrun/core` is gone (it was never deprecated)
- `readTarGz` from `@foldrun/core` is gone (it was never deprecated)
- `stripRoot` from `@foldrun/core` is gone (it was never deprecated)
- `filesFromTarball` from `@foldrun/core` is gone (it was never deprecated)
- `gitSecret` from `@foldrun/core` is gone (it was never deprecated)
- `gitHookPath` from `@foldrun/core` is gone (it was never deprecated)
- `verifySignature` from `@foldrun/core` is gone (it was never deprecated)
- `PushEvent` from `@foldrun/core` is gone (it was never deprecated)
- `parsePush` from `@foldrun/core` is gone (it was never deprecated)
- …and 5 more

### Changed in the public API

Declarations whose shape changed. Check that each still accepts what it did; one that does not is a break, and needs a `!` commit before this merges.

- `WorkspaceSummary` from `@foldrun/core`
- `notifyWorkspaceChanged` from `@foldrun/core`
- `StepRecord` from `@foldrun/core`
- `PlatformHooks` from `@foldrun/core`

### New in the public API

- `liveRuns` from `@foldrun/core`
- `hasSnapshot` from `@foldrun/core`
- `snapshotAt` from `@foldrun/core`
- `headRevision` from `@foldrun/core`
- `ensureBaseline` from `@foldrun/core`
- `resolveRevision` from `@foldrun/core`
- `hasSnapshot` from `@foldrun/core/history`
- `snapshotAt` from `@foldrun/core/history`
- `headRevision` from `@foldrun/core/history`
- `ensureBaseline` from `@foldrun/core/history`
- `resolveRevision` from `@foldrun/core/history`

- fix(history): a rebuilt index keeps same-millisecond revisions in the order they were written ([ffa3fda](https://github.com/foldrun-io/foldrun-core/commit/ffa3fda))
- feat(core)!: the platform's own git is gone — gitrepo, git-hook, git, tar, previews and the pending push ([d419493](https://github.com/foldrun-io/foldrun-core/commit/d419493))
- feat(history)!: the platform's own deploy history — a snapshot at every revision, no git ([228b695](https://github.com/foldrun-io/foldrun-core/commit/228b695))
- perf(store): sweeps read the run index, and the index sees same-tick rewrites ([68cd2ec](https://github.com/foldrun-io/foldrun-core/commit/68cd2ec))
- feat(runner): a room start-up phase — the wait for room on the cluster (FOL-29) ([e7b6db2](https://github.com/foldrun-io/foldrun-core/commit/e7b6db2))
- feat(runner): start-up phases on every sandboxed step (FOL-29) ([644f515](https://github.com/foldrun-io/foldrun-core/commit/644f515))

## [1.4.2] — 2026-10-17

- fix(runner): a step's caches stay in the sandbox — XDG_CACHE_HOME out of the workspace, .cache never copied back ([9e328c8](https://github.com/foldrun-io/foldrun-core/commit/9e328c8))

## [1.4.1] — 2026-10-17

- fix(scan): a run's caches are searched for keys, not read as prompts or code ([28af031](https://github.com/foldrun-io/foldrun-core/commit/28af031))

## [1.4.0] — 2026-10-17

### New in the public API

- `STEP_OPTION_KEYS` from `@foldrun/core`

- feat(schema): one list of every frontmatter field; check validates values from it, the editor offers it ([c660f62](https://github.com/foldrun-io/foldrun-core/commit/c660f62))

## [1.3.0] — 2026-10-17

### Changed in the public API

Declarations whose shape changed. Check that each still accepts what it did; one that does not is a break, and needs a `!` commit before this merges.

- `ScanOptions` from `@foldrun/core/scan`

### New in the public API

- `redactText` from `@foldrun/core/scan`

- fix(scan): redact keys in quoted lines, resolve network: the runtime's way, tolerate bad baseline entries ([e9e0481](https://github.com/foldrun-io/foldrun-core/commit/e9e0481))

## [1.2.0] — 2026-10-17

### New in the public API

- `checkFiles` from `@foldrun/core`
- `@foldrun/core/scan`
- `ScanLevel` from `@foldrun/core/scan`
- `ScanCategory` from `@foldrun/core/scan`
- `ScanRule` from `@foldrun/core/scan`
- `ScanFile` from `@foldrun/core/scan`
- `ScanFinding` from `@foldrun/core/scan`
- `ScanOptions` from `@foldrun/core/scan`
- `OWASP_URL` from `@foldrun/core/scan`
- `SCAN_RULES` from `@foldrun/core/scan`
- `CHECK_RULES` from `@foldrun/core/scan`
- `ruleForWhere` from `@foldrun/core/scan`
- `scanRule` from `@foldrun/core/scan`
- `ruleDocsUrl` from `@foldrun/core/scan`
- `findingFingerprint` from `@foldrun/core/scan`
- `redactSecret` from `@foldrun/core/scan`
- `nearestField` from `@foldrun/core/scan`
- `scanFiles` from `@foldrun/core/scan`
- `filterIgnored` from `@foldrun/core/scan`
- `ScanBaseline` from `@foldrun/core/scan`
- `makeBaseline` from `@foldrun/core/scan`
- `applyBaseline` from `@foldrun/core/scan`
- `SarifFinding` from `@foldrun/core/scan`
- `toSarif` from `@foldrun/core/scan`

- feat(scan): a security scanner for workspaces, with rule ids, ignores, a baseline and SARIF ([554568a](https://github.com/foldrun-io/foldrun-core/commit/554568a))

### chore

- proprietary licence; repository private, self-hosting guide removed ([f2d03fa](https://github.com/foldrun-io/foldrun-core/commit/f2d03fa))

### licence

- proprietary from this release; LICENSE clarified, lockfile matches (#35) ([42fa821](https://github.com/foldrun-io/foldrun-core/commit/42fa821))

## [1.1.3] — 2026-10-16

- fix(tool-loop): no nonessential traffic from the model session ([db30eca](https://github.com/foldrun-io/foldrun-core/commit/db30eca))

## [1.1.2] — 2026-10-16

- fix(tool-loop): the model session fails closed on any tool not ours, and gets its own home ([cd66017](https://github.com/foldrun-io/foldrun-core/commit/cd66017))

## [1.1.1] — 2026-10-16

- build(deps): bump actions/create-github-app-token (#31) ([df646d0](https://github.com/foldrun-io/foldrun-core/commit/df646d0))
- build(deps): bump the minor-and-patch group across 1 directory with 2 updates (#28) ([a242186](https://github.com/foldrun-io/foldrun-core/commit/a242186))

### ci

- release — Dependabot's build(deps) commits are a patch, not a feature ([f6cb036](https://github.com/foldrun-io/foldrun-core/commit/f6cb036))
- setup-node 7.1.0 in the release workflows too — Dependabot's group bump moved ci.yml only and closed #27 ([03287e9](https://github.com/foldrun-io/foldrun-core/commit/03287e9))

## [1.1.0] — 2026-10-15

### Changed in the public API

Declarations whose shape changed. Check that each still accepts what it did; one that does not is a break, and needs a `!` commit before this merges.

- `AgentInfo` from `@foldrun/core`
- `SecretEntry` from `@foldrun/core`

### New in the public API

- `setSecretSites` from `@foldrun/core`
- `secretSites` from `@foldrun/core`
- `@foldrun/core/network`
- `NetworkLevel` from `@foldrun/core/network`
- `NETWORK_LEVELS` from `@foldrun/core/network`
- `NetworkSetting` from `@foldrun/core/network`
- `NetworkPolicy` from `@foldrun/core/network`
- `TRUSTED_SITES` from `@foldrun/core/network`
- `SITE` from `@foldrun/core/network`
- `normalHost` from `@foldrun/core/network`
- `siteCovers` from `@foldrun/core/network`
- `networkAllows` from `@foldrun/core/network`
- `readNetwork` from `@foldrun/core/network`
- `networkProblems` from `@foldrun/core/network`
- `resolveNetwork` from `@foldrun/core/network`
- `networkLine` from `@foldrun/core/network`
- `refusalText` from `@foldrun/core/network`
- `proxyEnv` from `@foldrun/core/network`
- `EGRESS_CA_ENV` from `@foldrun/core/network`
- `egressCaSh` from `@foldrun/core/network`
- `networkYaml` from `@foldrun/core/network`
- `setNetworkSetting` from `@foldrun/core/network`

- docs(self-hosting): the platform image runs steps again; size; affected releases ([879a929](https://github.com/foldrun-io/foldrun-core/commit/879a929))

### ci

- pin checkout and setup-node to commit SHAs ([48514bb](https://github.com/foldrun-io/foldrun-core/commit/48514bb))

### docs

- the starter's CLAUDE.md lists POST …/assistant ([544b530](https://github.com/foldrun-io/foldrun-core/commit/544b530))

### feat

- runToolLoop — a model with only the caller's in-process tools ([0ba46f8](https://github.com/foldrun-io/foldrun-core/commit/0ba46f8))

### fix runner

- a step that may browse gets no proxy variables — Chromium failed every page through them ([74ca3b2](https://github.com/foldrun-io/foldrun-core/commit/74ca3b2))

### network

- silence Node's EnvHttpProxyAgent warning in sandboxes, so a tool's stderr is not read as an error ([d174fae](https://github.com/foldrun-io/foldrun-core/commit/d174fae))
- which sites a step's sandbox may reach; secrets bound to sites never enter it ([b469a17](https://github.com/foldrun-io/foldrun-core/commit/b469a17))

### rescue

- a rescuer is told the step's approval, and an exhausted evaluator loop reaches its on-fail ([7d7ce97](https://github.com/foldrun-io/foldrun-core/commit/7d7ce97))

## [1.0.0] — 2026-10-13

The public API is declared from this release on; the versions after it are measured against it.

### docs

- a CLI help line is marked "(deprecated — use …)" to deprecate it ([32353ec](https://github.com/foldrun-io/foldrun-core/commit/32353ec))

### hooks

- the new-hook template carries name:, like every non-OKF kind ([4e2c9f9](https://github.com/foldrun-io/foldrun-core/commit/4e2c9f9))
- your own code at every tool call, step start and step end ([e491d4f](https://github.com/foldrun-io/foldrun-core/commit/e491d4f))

### mail

- the account category also covers an API route the account calls being switched off ([7b1e5ff](https://github.com/foldrun-io/foldrun-core/commit/7b1e5ff))

### notify

- every webhook delivery says its body's version ([0ce59d7](https://github.com/foldrun-io/foldrun-core/commit/0ce59d7))

### release

- the first release to declare the public API lists no additions ([8bd2b8a](https://github.com/foldrun-io/foldrun-core/commit/8bd2b8a))
- full SemVer 2.0.0 — a declared public API, breaks found from it ([be63037](https://github.com/foldrun-io/foldrun-core/commit/be63037))

### web.browse

- state: in the block; beside cookies it needs state_key ([246a68e](https://github.com/foldrun-io/foldrun-core/commit/246a68e))

## [0.7.0] — 2026-10-11

- System package snapshots find install-script files by ctime, not mtime ([3b1fd47](https://github.com/foldrun-io/foldrun-core/commit/3b1fd47))
- build(deps): bump the minor-and-patch group across 1 directory with 2 updates (#22) ([7144c6c](https://github.com/foldrun-io/foldrun-core/commit/7144c6c))
- System package snapshots include what install scripts create ([388df9c](https://github.com/foldrun-io/foldrun-core/commit/388df9c))
- System package snapshot restore refreshes the linker cache ([d21fcfe](https://github.com/foldrun-io/foldrun-core/commit/d21fcfe))
- fix(store): retry readRun on NFS ESTALE instead of failing the poll ([16dc4bc](https://github.com/foldrun-io/foldrun-core/commit/16dc4bc))
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

### install

- every agent installs what it finds it needs mid-step (apt, pip, npm) ([5b74e29](https://github.com/foldrun-io/foldrun-core/commit/5b74e29))

### install tool

- env casts the web app's typecheck accepts ([2c3e14c](https://github.com/foldrun-io/foldrun-core/commit/2c3e14c))

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

### runtime

- system: packages restore from a snapshot after the first install ([98a2166](https://github.com/foldrun-io/foldrun-core/commit/98a2166))
- system log lines without a doubled runtime: prefix ([acc2412](https://github.com/foldrun-io/foldrun-core/commit/acc2412))
- system: installs Debian packages; install failures lead with the cause ([df07ebf](https://github.com/foldrun-io/foldrun-core/commit/df07ebf))

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
