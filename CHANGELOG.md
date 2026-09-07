# Changelog

Notable changes to `@foldrun/core`. The format is
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[semantic versioning](https://semver.org/), with the 0.x rule that a
breaking change is a minor bump until 1.0.0.

Entries are drafted from the commit subjects by `npm run release` and then
edited by a person — the commit messages in this repository are the best
description of a change anyone is going to write, so they are the source.

<!-- releases -->

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
