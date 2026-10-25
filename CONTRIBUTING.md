# Contributing

Thank you for looking. This is the runtime behind
[foldrun](https://foldrun.io): the markdown format, the step runner, the
checks. The hosted platform — queue, accounts, pods, gates, billing — is a
separate, private package that registers into `src/platform.ts`. Core never
imports it, and a change here must keep that true.

## Getting set up

```bash
git clone https://github.com/foldrun-io/foldrun-core
cd foldrun-core
npm ci
npm test          # the whole suite, no network, no model calls
npx tsc --noEmit -p .
```

Node 22 or newer. No model key is needed: every test that would call a model
uses the stub executor.

## Git hooks

Problems are caught before the push, not in CI or the deploy. `.githooks/` is
versioned here and `npm install` (its `prepare` runs `sh .githooks/install.sh`) points `core.hooksPath` at it.

- **pre-commit** (seconds, staged files only): gitleaks with the deploy gate's
  config (`../foldrun-infra/.gitleaks.toml`), `node --check` on `.mjs`,
  `bash -n` + `shellcheck -S error` on `.sh`, YAML parse.
- **pre-push** (what CI and the deploy gate run): gitleaks over the commits being
  pushed and the pushed tree, then `npx tsc --noEmit -p .` and `npm test`. The checks run on a
  detached worktree of the pushed commit beside this checkout (sharing its
  `node_modules`), so uncommitted work here neither hides a failure nor
  causes one.

Hooks only read; they never format, stash or reset. Emergency bypass:
`SKIP_HOOKS=1 git push` (or `--no-verify`) — and say why in the commit or PR.

## What a good change looks like

- **A test that fails before it and passes after.** The tests here are the
  specification — the grammar, `check`'s rules, the runner's contracts — so
  a behaviour with no test is a behaviour that will be broken by accident.
- **A commit message that explains why.** Prose, not a convention. The
  changelog is drafted from these, so write the sentence you would want to
  read in six months when the behaviour surprises you. Say what was
  happening before, if something was.
- **Comments where the reason is not obvious from the code.** Especially:
  what you tried that did not work, and what a reader will be tempted to
  "simplify" back into a bug.

## What is deliberately not here

Some absences are decisions, not gaps. Before proposing one, please open an
issue — the answer may be in `SPEC.md` or the docs:

- No timeouts a person did not write. A step runs until it finishes.
- No fingerprint spoofing, proxy rotation or captcha evasion in the browser
  tool. A challenge page comes back as the page.
- No platform concepts in core: no accounts, no queue, no billing.

## Releasing

Maintainers only:

```bash
npm run release              # a preview: the version, the changelog entry
npm run release -- --yes     # write it, commit, tag
git push --follow-tags       # this publishes
```

Usually you don't run it: every push to main keeps a "release X.Y.Z" pull
request open, and merging it publishes.

### Versions

[Semantic Versioning 2.0.0](https://semver.org/spec/v2.0.0.html), held to
three rules:

| | Means | Example |
|---|---|---|
| PATCH | a bug fix, nothing new — safe to update | 3.2.16 → 3.2.17 |
| MINOR | a new feature; everything that worked still works | 3.2.16 → 3.3.0 |
| MAJOR | a breaking change: something old stops working or works differently | 3.2.16 → 4.0.0 |

`npm run release` decides which, and the larger of two answers wins:

- **The public surface**, compared between the last stable tag and HEAD
  (`scripts/surface.mjs`): the exports of every entry point in `package.json` `foldrun.publicApi` — the names, and how many arguments each function needs; the Node.js it needs. Something gone, or now demanding more,
  is a major whatever the commits say; something new is at least a minor.
- **The commits.** A break the surface cannot see — the same call doing
  something different — is yours to mark: `!` before the subject's colon
  (`runs!: a stopped run keeps its sandbox`), or a body line
  `BREAKING CHANGE: <what breaks, for whom>`. A subject that reads as a fix
  (fix, docs, test, chore, deps, ci) is a patch; anything else is a minor.

`--major`, `--minor` or `--patch` can raise the bump, never lower it.

**Deprecate before you remove.** Mark it first — a `@deprecated` doc comment,
or "(deprecated — use …)" on its help line — and release that as a minor; take it out
in a later major. The release notes list both.

**Pre-releases**, by hand: `npm run release -- --pre rc --yes` makes
`1.3.0-rc.1` (then `rc.2` …), and `git push --follow-tags` publishes it under
npm's `next` tag, so `npm install` keeps getting the last stable release.
The release itself is then cut as usual and covers everything since the
last stable one.

A published version is never changed. A mistake is fixed by the next patch.

The tag is what publishes; CI builds, tests and pushes to npm (no
provenance: the repository is private). Nothing publishes from a laptop, and there is no publish token
anywhere — npm trusts this repository and `release.yml` by name (trusted
publishing), and each run mints its own short-lived credential.

## Licence of contributions

foldrun is source-available under FSL-1.1-ALv2 ([LICENSING.md](LICENSING.md)).
Before we merge your first pull request we ask you to agree that we may
release your contribution under those terms and under commercial licences.
