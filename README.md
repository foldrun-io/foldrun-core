# foldrun

**Agents are just folders. Write them, check them, run them.**

An agent is a folder. Its instructions, skills, knowledge, memory, tools and
tests are files you can read, diff and commit. There is no SDK to learn and no
graph to wire — the runtime reads the folder.

```bash
npx foldrun init my-desk
cd my-desk
foldrun check          # validate everything — costs nothing
foldrun run publish    # run the flow
```

```
my-desk/
├── AGENTS.md          what every agent here should know
├── agents/            who does the work
│   └── writer/agent.md
├── flows/             in what order
│   └── publish.md
├── skills/            how a task is done
├── knowledge/         what you gave them
├── memory/            what they learned
├── tools/             what they can call
├── scripts/           code
└── evals/             is it any good
```

**API reference:** docs/api.md — every route, its methods, and what it takes.

## Built on other people's standards

Most of this format is not ours. Where an open standard exists we adopt it
rather than compete with it:

| Layer | Standard | From |
|---|---|---|
| `AGENTS.md` | [AGENTS.md](https://agents.md/) | Linux Foundation |
| `skills/` | [Agent Skills](https://agentskills.io) | Anthropic |
| documents in `knowledge/`, `memory/` | [Open Knowledge Format v0.2](https://github.com/GoogleCloudPlatform/knowledge-catalog/tree/main/okf) | Google Cloud |
| `tools/` | [MCP](https://modelcontextprotocol.io) | Anthropic, adopted broadly |
| `flows/`, `evals/` | none exists — ours | |

A skill written for Claude Code or Cursor runs here unchanged — including one installed in the cross-client `.agents/skills/` directory, which the runtime scans alongside its own `skills/`. A knowledge
bundle exported by any OKF producer drops straight in. Agent frontmatter also
accepts Claude Code's subagent fields, so those files mostly run as they are.

## Flows are a numbered list

```markdown
1. [[researcher]] — find one topic worth writing about
2. [[writer]]     — draft it
2. [[fixer]]      — fix the technical issues, in parallel
3. [[editor]]     — review both together
   verify: test -s outputs/post.md
```

Same number runs at the same time; different numbers run in order. Each group
receives everything the group before it produced. `verify:` means a shell
command has to exit 0 — *done* should mean a check passed, not that the model
stopped talking.

## Evals, because prompts regress quietly

```markdown
## writes for farmers, not gardeners
task: Propose a topic and say who it is for.
expect:
  - not-contains: leverage
  - judge: the intended reader is a working farmer
```

Deterministic checks run first; a model only judges what survives them.
`foldrun eval` in CI is how you find out a prompt edit made things worse.

Every eval runs after every deploy unless it says otherwise. An eval of a
whole flow costs a whole run each time — and may touch real systems — so mark
it `trigger: manual` and it runs only when a person asks — the Run button,
the API, or `foldrun eval`.

## Which model, and how hard it thinks

Two knobs, set anywhere from a whole agent down to one step of one flow —
nearest wins, and the run trace names the winner:

```yaml
model: fast        # a tier (fast | default | max), an exact id, or "@preset/…"
effort: high       # low | medium | high | xhigh | max
```

Tiers keep files from rotting when models are renamed; an exact id pins one;
synonyms all land (`small`, `cheap`, `large`, `best`…). Effort is the
orthogonal axis — `fast` + `max` is the cheap model told to take its time.

A `provider:` block points the runtime at any endpoint speaking the Anthropic
Messages API — OpenRouter's Anthropic skin runs 400+ models through it, a
LiteLLM in front covers the rest — and remaps what the tiers mean there:

```yaml
provider:
  base_url: https://openrouter.ai/api
  token: ${OPENROUTER_API_KEY}
  models:
    fast: google/gemini-2.5-flash
```

The runtime then asks the gateway what each model can actually do, and uses
the answer three ways: a step whose agent needs tools fails **at start** on a
model that can't call them (one line, naming the nearest that can); `effort:`
is fitted to each model's supported levels, out loud; and step cost is priced
from the gateway's own rates, not one vendor's table. When a claim needs
proving, `foldrun probe <model>` runs a real tool loop against it — a nonce
the model must fetch through a tool and echo back — through your exact
provider config. The catalogue is the gateway's claim; the probe is ground
truth.

## The host for markdown agents

**foldrun cloud** runs your agents so you don't operate them: scheduled and
webhook triggers, durable runs with full history, a secret store, team access,
and containers you never touch. Push the folder, it runs.

The format, the CLI and the runtime are open source (Apache-2.0), and the
hosted platform imports the same core rather than a fork. Writing and checking
an agent locally costs nothing and needs no account — that is the on-ramp to
the host, not a competitor to it.

Where the two differ is operations, not capability. Locally a run happens in
your terminal; hosted, it survives a restart, retries a failed step, waits days
for an approval and tells you what it cost. Nothing is held back from the open
version to make the hosted one worth buying.

## This repo, and the others

This is `foldrun-core`: the runtime, published to npm as `@foldrun/core`.
Most people want the CLI, not this package — `npm install -g foldrun`.

| Path | What |
|---|---|
| `src/` | the runtime: parse, run, check, evaluate |
| `templates/` | starting points for a new workspace — see below |
| `SPEC.md` | the agent and flow format |
| `okf/PROFILE.md` | which parts of OKF are implemented |
| `okf/WHITE-PAPER.md` | hosting OKF: what the spec leaves to hosts |
| `tests/` | the runtime's tests (`npm test`) |

The rest of foldrun lives in sibling repositories, checked out side by side:
`foldrun-cli` (the command), `foldrun-web` (the hosted dashboard),
`foldrun-docs` (the reference), `foldrun-site` (foldrun.io), `foldrun-infra`
(deploying it) and `foldrun-deck`. `foldrun-infra/bootstrap-repos.sh` sets
the folder up.

### Templates and workspaces

There is **one** place a workspace lives: wherever you made it. `foldrun init`
makes one in a directory you name; the hosted platform makes one under
`data/<tenant>/workspaces/<name>/`, which is gitignored because it holds your
secrets, run journals and whatever your agents learned.

`templates/` is not a second home for workspaces. It holds **starting points**
— authored, committed, and shipped — and you turn one into a workspace:

```bash
foldrun init my-desk --from templates/hello
foldrun check my-desk
foldrun run note --workspace my-desk
```

`templates/hello` is the smaller of the two and exercises the whole format: an
agent, a flow, a skill, a script tool as a folder (`tools/wordcount/` — a
`tool.md` and the `run.py` it calls), knowledge it may only read, memory it
writes back, and state it carries to the next run. `templates/blog-desk` is
the two-agent shape of a real desk: a researcher picks the topic, a writer
drafts it, over shared house style in `knowledge/` and an eval that holds the
writer to it.

A template ships, so it has to be correct without anyone running it: every
bundle in `templates/` is checked for conformance on each test run, and its
generated `index.md` is regenerated and compared against the committed one, so
a hand-edited template cannot ship an index that disagrees with its own files.

## Hosting it

`infra/` holds the production story: a compose file for one box, k8s
manifests for a fleet, and the isolation ladder (runc → gVisor). The
always-on part is one small control plane; run compute is a hardened
container per step that exists only while the step does — idle agents cost
storage and nothing else. See [infra/README.md](infra/README.md).

`foldrun-infra/dev/` is a complete single-box installation as code — an
idempotent bootstrap (k3s, gVisor RuntimeClass, local registry, backup and
token-refresh timers), manifests behind one `kubectl apply -k`, and a
deploy script that builds on the target under immutable git-sha tags and
smoke-tests before it calls a deploy done. A fresh Ubuntu machine plus one
secrets file reproduces the whole installation. It is the development
cluster and it is honest about that; `foldrun-infra/prod/` holds the plan
for a real one and nothing built.

## Requirements

Node 22+. Docker or Podman if your agents run scripts. Credentials come from
`ANTHROPIC_API_KEY` or an existing Claude Code login — `foldrun check` needs
neither.

## Status

v0.1. Local and hosted runs work. Hosted runs go through a durable on-disk
queue (survives restarts, parks at approval gates), the dashboard has
accounts and sessions (scrypt + signed cookies; first signup is free, then
`FOLDRUN_OPEN_SIGNUP=1`), spending lands in an append-only per-account
ledger (`FOLDRUN_BILLING=1` makes an empty balance refuse new runs), and a
`notify:` block in AGENTS.md webhooks you when a run fails or waits for
approval.

Teams: an account holds many users, joined by 7-day invite links minted in
Settings. Webhook URLs rotate per-hook (generation counters — nothing
secret stored) and every delivery, refused ones included, lands in a log.
Card top-ups are two Stripe REST calls behind `STRIPE_SECRET_KEY`, writing
the same ledger entry the manual API does.

With `FOLDRUN_RUN_ISOLATION=container` (one box) or `=k8s` (cluster —
native run pods, gVisor by RuntimeClass, egress-limited by NetworkPolicy)
every step runs in a hardened throwaway sandbox: workspace copied in,
events streamed out, changes filtered back so `knowledge/`, secrets and
run history physically cannot come back modified. The CLI keeps in-process
runs — on a laptop there is nothing to protect the server process from.

Connections cover how services actually hand out credentials: API keys,
API with base URL + headers, SSH (key or password — materialised as a
ready-to-run wrapper, `"$NAME" 'uptime'`), browser OAuth with your own
client, OAuth client-credentials, service accounts (RS256 JWT), and file
secrets (0600). Values are encrypted at rest and never reach the model.

A built-in tools gallery ships platform-maintained scripts — first entry:
a headless browser (`fetch_rendered`) for pages that render with
JavaScript. Assigning one copies it into your account library or a
workspace; agents still opt in explicitly in their own markdown.

Known gaps: one platform replica per data directory (the web/worker role
split needs RWX storage), and the dashboard's run lists re-read run files
per request (fine to thousands of runs).

Apache-2.0.
