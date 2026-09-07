# Contributing

Thank you for looking. This is the open runtime behind
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

The tag is what publishes; CI builds, tests and pushes to npm with
provenance. Nothing publishes from a laptop.
