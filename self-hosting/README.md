# Running foldrun yourself

One box, one command. The platform container is the always-on control
plane — dashboard, API, scheduler, worker — and every agent step runs in a
throwaway container beside it, spawned through the host's Docker socket. No
step, no container: run compute scales to zero by construction.

```bash
curl -O https://raw.githubusercontent.com/foldrun-io/foldrun-core/main/self-hosting/docker-compose.yml
FOLDRUN_SECRET_KEY=$(openssl rand -hex 32) docker compose up -d
```

Then open `http://localhost:3900/signup`. The first account needs no
invite — it is yours. Create an API key in Settings, point the CLI at it
(`npx foldrun login --url http://localhost:3900`) and `foldrun deploy`.

## What you need

- Docker, and a host whose socket the platform may use. That makes the
  platform root-equivalent on this machine: it is the deal on a single box,
  and the step containers' own hardening (non-root, capabilities dropped,
  no-new-privs, gVisor when the host has it) is what stands between an
  agent and the daemon. Do not do this on a box you share with strangers.
- **linux/amd64.** The published images are amd64 only — a server
  architecture, which is what this is for. They do not run on Apple Silicon
  or Graviton, and there is no source build to fall back on: the control
  plane is not open. If you want foldrun on ARM, open an issue and say so;
  the build is one flag away and nobody has asked yet.

  This does not affect writing or running agents on an ARM laptop — the CLI
  is npm and architecture-independent. It is only the self-hosted platform.
- A model credential. Either set `ANTHROPIC_API_KEY` for the whole install
  ("models included" — every run borrows it), or set none and let each
  agent bring its own `provider:` block. ~30 providers work.
- 4 GB of RAM to be comfortable. The runner image is 1.1 GB; two default
  steps reserve 2 GB each.

## What you get, and what you do not

Everything the hosted platform does on one box: workspaces as folders, the
editor, flows, schedules, webhooks, approval gates, evals, run records with
per-step cost, the secrets vault, the git remote (push = deploy), branch
previews, share links.

What you do not get: somebody else running it. No uptime, no backups, no
support. `FOLDRUN_SECRET_KEY` is the root of every derived credential —
sessions, hooks, git, the vault — so back it up somewhere that is not this
box, and back up the data volume with it. Losing the key logs everyone out
and voids every webhook URL. Losing the volume loses the workspaces.

## The images

| image | what |
|---|---|
| `ghcr.io/foldrun-io/platform` | the control plane. ~575 MB |
| `ghcr.io/foldrun-io/runner` | the step sandbox: node, python, git, Chromium, Firefox, WebKit. ~1.1 GB |

Pin them for a real install — `FOLDRUN_IMAGE=ghcr.io/foldrun-io/platform:v2026.09.08.4`
and `FOLDRUN_RUNNER_IMAGE=ghcr.io/foldrun-io/runner:v2026.09.08.4` — so a restart
never changes the version under you.

Versions are dates: `v2026.09.08.4` is the fourth build on 8 September 2026.
Every version is a [release](https://github.com/foldrun-io/foldrun-infra/releases)
listing what changed, and the same build that runs foldrun's own box is what
is published — there is no separate "community" image.

Unset `FOLDRUN_RUNNER_IMAGE` and the platform builds its own runner on
first use instead. That is what a change to the runner's Dockerfile needs,
and it costs about five minutes and 600 MB of browser downloads.

## Postgres and Redis

Optional. Without them everything lives in files on the data volume, which
is right for one person or one company. Add them when you want more than
one worker: `FOLDRUN_DATABASE_URL` moves the queue and the ledger into
Postgres, `FOLDRUN_REDIS_URL` moves leases and rate limits into Redis, and
the two together let worker replicas share the work. See
[scaling](https://foldrun.io/docs/scaling-adr).

## Upgrading

```bash
docker compose pull && docker compose up -d
```

Runs in flight are handed back to the queue and re-attached by the worker
that comes up, so an upgrade does not cost a run. Read the
[release notes](https://github.com/foldrun-io/foldrun-infra/releases) for
the version you are moving to.
