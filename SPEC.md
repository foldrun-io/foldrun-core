# foldrun — agents are just folders

**Spec v0.1 (draft)**

An foldrun is a git repository of plain markdown files. No code, no SDK, no YAML pipelines. If you can write a README, you can build an agent. Any harness that speaks this spec can run one; `foldrun` (the CLI) and foldrun cloud are reference implementations.

## Standards this builds on

Most of this format is not ours. Where an open standard exists, we adopt it
rather than invent a competitor:

| Layer | Standard | Published by |
|---|---|---|
| `AGENTS.md` — instructions | [AGENTS.md](https://agents.md/) | Linux Foundation (Agentic AI Foundation) |
| `skills/` — procedures | [Agent Skills](https://agentskills.io) | Anthropic |
| documents in `knowledge/`, `memory/` | [Open Knowledge Format v0.2](https://github.com/GoogleCloudPlatform/knowledge-catalog/tree/main/okf) | Google Cloud |
| `tools/` — capability | [MCP](https://modelcontextprotocol.io) | Anthropic, adopted by OpenAI and Google |
| `flows/`, `evals/` | none exists — ours | |

## A document's kind is its path

Nothing declares what it is. The directory says it, and every reader resolves
that way:

| File | Declares | |
|---|---|---|
| `agents/<name>/agent.md` | — | an agent, because of where it is |
| `flows/<name>.md` | — | a flow |
| `evals/<name>.md` | — | an eval |
| `skills/<name>/SKILL.md` | — | a skill |
| `tools/<name>.md` | `transport:` | *how* it connects — not what it is |
| `knowledge/*.md` | `type:` | `Reference`, `Policy`, `Price List`, … (OKF, open) |
| `memory/*.md` | `type:` | `Fact`, … (OKF, open) |
| `scripts/<file>` | — | code, not a document |

Implementations MUST NOT require a field naming the kind, and MUST NOT infer a
kind from one if it is present. A file in `agents/` is an agent even if it
claims otherwise; a file elsewhere is not one however it is labelled. There is
one source of truth and it is the path.

### `type:` is OKF's, and only on OKF bundles

`knowledge/` and `memory/` are [OKF](https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md)
bundles. There, `type:` is required — it is the spec's only required field —
and drawn from an **open** vocabulary describing what a piece of knowledge is
*about*. No other directory here is an OKF bundle, so no other directory
carries a `type:`.

```yaml
type: Price List    # what this knowledge is about — OKF, open, required
```

Unlike a kind, this genuinely cannot be derived: two files side by side in
`knowledge/` may be a Policy and a Price List, and only the frontmatter can
say. It also does real work — a bundle's generated `index.md` is grouped by it.

A tool answers a third question, which is neither of the first two:

```yaml
transport: http     # how it reaches what it calls — http | script | mcp
```

> **Compatibility.** Older files may carry a declaration that is now dead
> weight. Implementations MUST tolerate all of these, and SHOULD NOT emit them.
> - `type: http` on a tool, written before transport moved to its own field,
>   MUST be read as a *transport*. Transport stays optional either way: a file
>   with `base:` is http, `run:` is a script, `command:` or `url:` is MCP.
> - `type: Agent` (and `Flow`, `Eval`, `Skill`, `Tool`), from when our nouns
>   sat in OKF's field, MUST be ignored. A checker SHOULD point it out: to
>   anything else reading the bundle it looks like a knowledge concept.
> - `kind: Agent` and friends, briefly generated, MUST be ignored.

Why nothing declares it: the field was derived data sitting next to its source,
free to disagree with it, and nothing consumed it. The runtime never branched
on it, the model never saw it — a system prompt is built from the body, not the
frontmatter — and no index groups by it. What it bought was a file describing
itself when read alone, which the path in front of it already does.

## Where files live

Three directories, one per scope. The nesting **is** the scope model — "nearest
wins" is walking up the tree:

```
<account>/                      the company: one bill, one identity, one team
├── AGENTS.md                   context every agent in the account works under
├── secrets.json                account credentials
├── library/                    shared by every workspace
│   └── {skills,memory,knowledge,tools,scripts}/
└── workspaces/<workspace>/     a trust boundary
    ├── AGENTS.md               shared context for everyone here
    ├── agents/<agent>/         one role
    │   └── {agent.md,skills,memory,knowledge,scripts}/
    ├── {flows,evals,skills,memory,knowledge,tools,scripts,state}/
    ├── storage/                bytes, not source — see below
    ├── secrets.json            workspace credentials
    └── runs/                   generated: the audit trail
```

Anything generated is dot-prefixed (`.runtimes/`, `.results/`) or named for
what produced it (`runs/`, `outputs/`). Everything else is authored and belongs
in git.

### storage/ — the one directory that is not source

Every directory above holds markdown you diff and commit. `storage/` holds the
other thing a workspace accumulates: a PDF somebody uploaded, a CSV an agent
scraped, a rendered image. Opaque bytes, often large, with nothing to review
in a pull request.

So it is deliberately outside the format's rules. A deploy cannot carry a file
into it (`saveWorkspace` refuses any path outside the directories listed
above), the file tree and the git export never show one, and a deploy never
deletes what is there. In return, agents get the simplest possible interface:

```
1. [[researcher]] — read storage/price-list.pdf and write storage/summary.md
```

A run finds the workspace's files already on disk at `storage/` and reads them
with the same Read/Bash it uses for everything else. Whatever it leaves there
afterwards becomes a stored file, recorded against the run that wrote it.
There is no storage API, no bucket and no credential inside a run.

Hosted, the bytes live in object storage (any S3-compatible endpoint;
Cloudflare R2 by default) and the workspace copy is a cache. Locally there is
no store at all — `storage/` is a folder in your project, and putting something
in it with Finder is the upload.

Run locally and the wrapper levels disappear — the workspace *is* the folder:

```
my-desk/
├── AGENTS.md
├── agents/
└── flows/
```

There is no company on a laptop, so inventing two parent directories would be
ceremony.

### AGENTS.md, at two scopes

`AGENTS.md` may sit at the account and at the workspace, and both apply:

```
<account>/AGENTS.md                    who the company is, what nobody may do
<account>/workspaces/<ws>/AGENTS.md    what this workspace is for
```

The body of each is given to every agent beneath it, **outermost first**. On a
laptop the account file is the workspace's sibling, the same place `library/`
sits.

The two halves of the file cascade differently, and the difference is
deliberate:

| | Rule |
|---|---|
| **Frontmatter** (`provider:`, `runtime:`, `timezone:`, `foldrun_version:`) | nearest-wins, key by key — a workspace's value replaces the account's |
| **Body** (the instructions) | accumulates — both are given to the agent |

Config is a choice, so the nearer scope should win. An instruction is a
constraint, and a constraint a workspace could drop just by having its own
`AGENTS.md` would be worthless as one. "Never contact a competitor" written at
the account has to survive a workspace that only wanted to say "keep it under
300 words".

A file that carries only frontmatter contributes no prose, and unparseable
YAML in a shared file is skipped rather than fatal — one bad file must not stop
every agent under it.

`timezone:` (an IANA name, `Australia/Sydney`) is the calendar every agent
under it works to: the prompt says what day it is in that zone, and `TZ` and
`FOLDRUN_DATE` are set the same way for scripts. Unset means UTC, which is
what the containers run — so without it, an article dated "today" by a Sydney
desk is a day in the future until 10am.

### Which model runs it

By default, Anthropic. A workspace or a single agent can point at any endpoint
that speaks the **Anthropic Messages API**:

```yaml
provider:
  base_url: https://api.z.ai/api/anthropic
  token: ${ZAI_TOKEN}
```

The URL lives in git; the token is a `${SECRET}` resolved server-side. An
agent's own block wins over its workspace's.

Two optional keys make a gateway usable rather than merely reachable:

```yaml
provider:
  base_url: https://openrouter.ai/api
  token: ${OPENROUTER_API_KEY}
  models:                              # what this gateway calls each tier
    fast: google/gemini-2.5-flash
    max: anthropic/claude-opus-4.1
  headers:                             # anything else the gateway wants
    X-Title: foldrun
```

`models:` is what makes tiers portable rather than merely renamed-proof:
without it, `model: fast` means the literal string `haiku` at every endpoint,
which is true at exactly one of them. Keys accept every word `model:` does
(`small`, `cheap`, `large`, …); a tier the block omits keeps ours. `headers:`
is the escape hatch for settings this format will never have — routing
preferences, attribution, tags — so a gateway's own knobs never become a
per-vendor branch in the runtime. Header values take `${SECRET}` too, and a
value that could end a header is dropped with a line in the run trace.

A third optional key is a second supply:

```yaml
provider:
  base_url: https://api.z.ai/api/anthropic
  token: ${ZAI_TOKEN}
  fallback:
    base_url: https://openrouter.ai/api
    token: ${OPENROUTER_API_KEY}
    models: { fast: google/gemini-2.5-flash }
```

`fallback:` is the same block, one level deep, and it is tried **exactly once
per step, only when the primary refuses over money, auth or limits** — a 401,
402, 429, 5xx, an "overloaded" or "quota" — never when the work itself fails.
The retry is a fresh attempt in a fresh sandbox, and the run's trace says the
step moved and why. A step that names no `provider:` at all rides the
platform's credential and the platform's fallback, if the host configured
one; a step that names a provider has taken that arrangement over, fallback
included.

The token is sent as a **bearer** credential, and the API-key environment
variable is explicitly blanked — left set, it would be sent as `x-api-key` and
treated as a direct-Anthropic credential; left *unset*, the runtime would fall
back to authenticating against Anthropic itself, failing a long way from the
file that caused it. A gateway that genuinely wants a key header asks for it
by name: `headers: { x-api-key: ${THE_SECRET} }`.

This covers Anthropic-compatible endpoints directly — Anthropic, OpenRouter,
DeepSeek, Moonshot, z.ai, MiniMax, Qwen, Fireworks, Vercel's gateway, a
LiteLLM of your own, and the local runtimes. The other family of endpoint
speaks OpenAI's Chat Completions: OpenAI, Gemini, xAI, Groq, Mistral,
Together, Hugging Face, Cloudflare's own models. Those are reached through
**the runtime's own translator**: `format: openai` starts a small server on
loopback inside the run sandbox that presents an Anthropic endpoint to the
model loop and rewrites each request and streamed reply to Chat Completions
and back. It lives for one step, holds only that step's key, and dies with
it; nothing is installed and nothing is shared between runs. What a
Chat-Completions endpoint has no word for — `cache_control`, `top_k`,
server-side tools, thinking where there is no `reasoning_effort` — is dropped
and said once in the run trace.

Three keys make a provider block short:

```yaml
provider:
  name: groq                        # a provider this runtime knows
  token: ${GROQ_API_KEY}
  models: { fast: llama-3.3-70b-versatile }
```

- `name:` fills in `base_url`, `format` and `auth` from a shipped table (see
  `docs/providers.md`); anything spelled out beside it wins. An unknown name
  is a warning and never a guessed address — a key must not be sent to a
  stranger.
- `format: anthropic | openai` — what the endpoint speaks. Default
  `anthropic`. A pasted URL that looks like a Chat-Completions endpoint
  without `format: openai` is warned about at check time.
- `auth: bearer | x-api-key` — which header the key rides in on an
  Anthropic-format endpoint. Default `bearer`; Anthropic, DeepSeek, Ollama and
  Cloudflare want `x-api-key`. A translated endpoint always gets a bearer.
- `params:` — a map of request fields merged into what the translator sends,
  verbatim, after the translation. This is the escape hatch for every knob
  this format deliberately does not model: `temperature`, `seed`,
  `response_format`, a gateway's own routing block, whatever the endpoint
  accepts. Nothing here is validated against a vendor's schema, because the
  endpoint is the authority on what it takes and a list in this format would
  be stale in a month. A value of `null` *removes* a field the translation
  would otherwise send, which is how you tell an endpoint that rejects
  `temperature` to stop receiving it. `messages`, `tools`, `stream`,
  `stream_options` and `model` are refused with a warning: those are the
  conversation, not a setting, and a line that looks like tuning must not be
  able to break the agent loop or redefine what `model: fast` meant. `params:`
  reaches only a `format: openai` endpoint — an Anthropic-shaped one is spoken
  to directly, so its knobs are set at the provider (an OpenRouter preset,
  say) rather than here.

```yaml
provider:
  name: openai
  token: ${OPENAI_API_KEY}
  params:
    temperature: 0.2
    seed: 7
    top_p: null                      # do not send it at all
```

The division of labour stands: **we translate names, and one wire format.**
Tier words, effort levels, header maps and the translator are ours — pure
functions with tests. A per-vendor parameter surface in this format would be
stale the day it shipped, so a knob this format does not model lives in the
provider's own configuration (OpenRouter *presets* are referenced as
`model: "@preset/name"` and carry temperature, provider routing and
fallbacks) or in `provider.headers`.

**The catalogue.** When a provider block is declared, the runtime asks the
gateway's `/v1/models` what each model can do — tool support, reasoning
levels, context, real prices — and caches the answer for a day (stale beats
nothing; offline keeps working). Three things run off it:

- **The run-start gate.** A step whose agent declares tools, on a model the
  catalogue says cannot call them, fails at step start in one line naming the
  nearest capable model — not minutes in, as an agent narrating tool calls
  into prose. The gate only ever fails on *knowledge*: unknown ids, presets
  and an absent catalogue all pass through, because the model call is the
  authority of last resort. The same check runs at edit time as a flow lint.
- **Effort, fitted per model.** `effort:` is written once and fitted to what
  each model takes: a supported level passes silently; `max` on a model that
  tops out at `xhigh` runs as `xhigh`, said aloud in the trace; a model that
  does not reason drops it, said aloud. The word in the file stays the
  intent; the wire carries what the model has.
- **Cost, repriced.** Step cost is computed from the gateway's own per-token
  prices when the catalogue knows them, because a runtime that prices every
  model off one vendor's table bills fiction for the rest.

**The probe.** `foldrun probe <model>` answers "can this model hold a tool
loop?" by running one: a single tool whose result is a per-run nonce the model
must call for and echo back — unfakeable by a model that merely narrates tool
use. It runs through the workspace's own provider block, so it exercises the
exact path a run takes. The catalogue is the gateway's claim; the probe is the
ground truth.

See [okf/PROFILE.md](./okf/PROFILE.md) for exactly which parts of OKF are
implemented. Agent frontmatter also accepts the subagent field names coding
tools use (`tools`, `model`, `effort`, `skills`, `mcpServers`,
`permissionMode`, `disallowedTools`), so a single-file subagent written for one
mostly runs here unchanged.

A subagent authored as a single file by a coding tool is imported into the
folder shape on deploy. The vendor-neutral location is `.agents/agents/<name>.md`
(the same `.agents/` root as `.agents/skills/`); a tool's own location
(`.claude/agents/<name>.md`) is also read, for compatibility. Each maps to
`agents/<name>/agent.md` with its content unchanged. A native
`agents/<name>/agent.md` always wins, and the neutral location wins over a
vendor one. The import is one-way at the boundary — nothing here privileges a
single vendor, and the tail of that location list is where a new tool is added.

## What one agent is made of

An agent is a directory under `agents/`, and everything it owns sits beside its
`agent.md`:

```
agents/reporter/
├── agent.md          # required — who it is and what it does
├── skills/           # optional — one capability per folder
│   └── defect-summary/SKILL.md
├── knowledge/        # optional — given to it; it may read, never write
├── memory/           # optional — what it has learned; it writes here
│   └── index.md      # generated — one line per concept
└── scripts/          # optional — code it can call as a tool
```

An agent is never a repository on its own. It lives in a workspace, which is
what holds the flows that run it, the tools it may use and the context every
agent there shares — see [Where files live](#where-files-live). A directory
with an `agent.md` at its root defines no agents at all: readers resolve by
path, and the path they look at is `agents/<name>/agent.md`.

Everything the agent *is* lives in markdown a person can read, diff and
review in a pull request. Everything it *learns* is written back to `memory/`,
so what it knows has the same audit trail as what it does.

## agent.md

The only required file. Frontmatter for the machine, body for the model.

```markdown
---
name: competitor-watcher
description: Watches competitor sites and drafts a weekly digest.
schedule: "0 8 * * MON"          # optional — cron, runs in `timezone`
timezone: Australia/Sydney
model: default                    # default | fast | max — tiers, not model IDs
effort: high                      # low | medium | high | xhigh | max — how hard it thinks
tools:
  - web                           # web search + fetch
  - files                         # read/write inside the workspace
  - bash: ask                     # enabled but requires approval per call
  - [[price-tracker]]             # a tool of yours — tools/price-tracker.md
secrets:
  - SLACK_WEBHOOK_TOKEN           # names only — values live in the vault, never in git
---

You watch our competitors and produce a weekly digest.

Check each site listed in memory/competitors.md. Note pricing changes,
new features, and new blog posts. Write the digest to outputs/digest.md
and post a two-line summary to Slack.

Never contact competitor sites in any way other than reading public pages.
```

Rules:
- `name` is the agent's identity; kebab-case, unique per account.
- `schedule` absent → agent runs on demand (CLI, API call, or dashboard button).
- `model` accepts a **tier** (`fast` | `default` | `max`) so agents don't rot when models are renamed, or an explicit alias/model id (`opus`, `claude-opus-5`) to pin one. Every reasonable synonym lands on its tier (`small`, `cheap` → `fast`; `large`, `best` → `max`), because an unrecognised word is passed through as a model id and fails at run time on a file that reads perfectly.
- `effort` is the other half of model selection, and the orthogonal one: the model is which brain, effort is how long it thinks before answering. Five levels — `low` | `medium` | `high` | `xhigh` | `max` — plus synonyms (`minimal` → `low`, `highest` → `max`). Unset leaves the model's own default. `fast` + `max` is a real pairing: the cheap model, told to take its time. The same word means different things on the two keys — `model: max` is the most capable model, `effort: max` is think-hardest — and neither leaks into the other.
- `size` is the sandbox reservation the step runs in, and it is a price, not just a limit. Three classes — `small` | `large` (default) | `heavy` — each mapping to a memory ceiling and a compute rate the host configures (reference: 1Gi, 2Gi, 8Gi). **Memory is a hard ceiling** because it is not compressible: a step that exceeds it is killed, which on a single-node host protects every other tenant. **CPU is not capped** — a step bursts to whatever the node has free and bills at its class rate, so a `heavy` step both may use more and costs more. Pick `small` for an agent that mostly waits on an API, `heavy` for one that renders a browser or holds real data, and leave it unset otherwise. The class the step actually held is recorded on the run, so the bill is computed from what was reserved, never from what the config says later.

## Giving an agent real capabilities

Three mechanisms, in increasing order of power:

**`apis:`** — declare an HTTP API and the agent gets one tool scoped to it. Credentials are `${SECRET}` placeholders resolved by the host at call time, so the model never sees them and can't leak them.

```yaml
apis:
  - name: google_ads
    base: https://googleads.googleapis.com/v18
    description: Google Ads REST API. Use searchStream for metrics.
    methods: [GET, POST]
    headers:
      Authorization: Bearer ${GOOGLE_ADS_TOKEN}
      developer-token: ${GOOGLE_ADS_DEV_TOKEN}
```

**`scripts/`** — real code in any language, deployed alongside the markdown and made executable. Three scopes, one prefix each: an agent's own `scripts/`, the workspace's shared scripts as `workspace/scripts/`, and the account library's as `account/scripts/`. (`shared/` and `library/` are older spellings of the last two; implementations keep accepting them.) This is how existing tooling comes onto the platform unchanged.

A script can be **declared as a tool**, which is preferred over granting `bash`: the agent calls it by name with typed arguments and never composes a shell command.

```yaml
scripts:
  - name: ads_summary
    run: scripts/summary.py          # or workspace/scripts/fx.py for a shared one
    description: Pull this week's campaign performance.
    args:
      customer_id: The Google Ads customer id
    interpreter: python3             # optional; inferred from the extension
```

Declared arguments are passed as long flags (`--customer_id 123`), stdout and stderr are returned, and the script is confined to the project directory. Grant `bash` only when the agent needs to compose commands you can't predict.

A tool may declare what its program needs, and it is installed for every agent that grants the tool — the tool is the unit of code, so its dependencies travel with it rather than being repeated in each agent's `runtime:`:

```yaml
runtime:
  packages: [requests]      # pip
  npm: [cheerio]            # npm
```

An agent's own `runtime:` and the runtimes of the tools it grants are merged into one environment per step. Pins are kept verbatim; two tools pinning one package differently is reported by the installer at build time rather than resolved silently.

**`agents:`** — colleagues this agent may consult mid-turn, by name:

```yaml
agents: [researcher, fact-checker]
```

Each name becomes a `consult_<name>(question)` tool: the colleague's
`agent.md` persona answers one self-contained question as a toolless model
call, inline, with the spend landing on the consulting step. Toolless is the
design — a consult is asking a specialist what they think, not delegating
the task; consultants cannot consult further (depth is one), and nothing
about what runs next is decided by a model, which keeps this on the right
side of the handoff pattern this spec rejects.

A secret may also be an **OAuth2 credential**: instead of a static value,
the vault stores the refresh recipe (`token_url`, `client_id`,
`client_secret`, `refresh_token`), and the host exchanges it for a live
access token immediately before every use — cached until near expiry, one
exchange however many steps fan out. Agents, scripts and API headers see
only the fresh token; the recipe never leaves the host process. This is
what makes the Google family (Ads, Search Console, Drive) work like any
other API. A failed refresh fails the step naming the secret and the
provider's reason, not a 401 three layers later.

**`secrets:`** — names only, never values. Declared secrets are injected as environment variables into the agent's scripts and substituted into `apis:` headers. Hosts must store them encrypted and never return them through an API.

```yaml
tools: [files, bash]
secrets: [GOOGLE_ADS_TOKEN, ADS_CUSTOMER_ID]
```
- `tools` is an allowlist. Values: bare name (enabled), `name: ask` (human approval per call), omitted (disabled). Default when `tools` is absent: `files` only. Groups: `read` (Read, Glob, Grep), `files` (read plus Write, Edit), `bash`, `fetch` (WebFetch — fetched from the run's own sandbox), `web` (WebFetch plus Anthropic's server-side WebSearch, the one built-in that runs off your machine and bills per search). An install that runs its own search engine sets `FOLDRUN_SEARCH_URL` and grants `fetch` with the account's `websearch` tool instead — then nothing but tokens ever leaves the box.
- Two more groups are the platform's own, served in-process and rebuilt inside a run container from values: `search` gives `search_files(query)` — ranked full-text search (lexical, no embeddings, nothing leaves the box) over the agent's knowledge, memory, state, storage and outputs at all three scopes, so an agent with three hundred memory files searches instead of guessing which to open; `history` gives `recall_runs()` and `read_run(id)` — the workspace's last thirty finished runs, what each concluded and what each step replied, so a scheduled flow can continue where yesterday's left off rather than redo it. Neither needs a secret and neither is granted by default.

An `apis:` entry may also carry `openapi:`, `operations:` and `rate:`:

```yaml
apis:
  - name: hubspot
    base: https://api.hubapi.com
    description: HubSpot CRM. Contacts, companies, deals.
    methods: [GET, POST, PATCH]
    headers:
      Authorization: Bearer ${HUBSPOT_TOKEN}
    openapi: tools/hubspot/openapi.json        # a workspace file (JSON or YAML) or an https URL
    operations:                                # optional: only these become tools
      - getContact                             # an operationId…
      - "POST /crm/v3/objects/contacts/search" # …or METHOD /path
    rate: 100/m                                # 5/s, 100/m, 1000/h — a call over the limit waits
```

`openapi:` points at an OpenAPI 3.x document — a path relative to the workspace root or an `https://` URL, fetched once a day and cached. Every operation in it that uses one of the API's `methods:` becomes its own tool, named `<api>_<operationId>`: the parameters the document declares are the tool's arguments, typed and required where the document says so, and the platform fills the path template, routes query and header parameters to where they belong, and adds the credentials. The agent no longer guesses at paths. Without `operations:`, every operation is exposed, capped at 60 (the run warns when the document has more), and the generic `call_<api>` tool stays alongside them as the escape hatch. With `operations:` — operationIds or `"METHOD /path"` strings — only those are exposed and `call_<api>` is withheld, so the file is the complete list of what the agent may do. A document that cannot be read is a warning on the run, not a failure: the generic tool still works.

`rate:` caps how fast one step may call the API, as `count/unit`. It is a token bucket: the first `count` calls go straight through, then calls proceed at that average rate, and a call over the limit waits for its turn rather than failing (a wait over a second is noted in the request log). The bucket belongs to the step, not the account: two steps running at once each get their own, so set `rate:` to the vendor's per-key limit divided by how many things run in parallel. Without `rate:` no clock is applied — as everywhere in foldrun, the limit is only what the file says.
- `secrets` declares names only. The harness injects them at the network edge (vault-backed); the agent's sandbox never sees raw values.

## skills/

Skills use the open **[Agent Skills](https://agentskills.io) format** — an open standard (originally Anthropic's) adopted across the agent ecosystem. foldrun does not invent a skill format: a skill written here runs in other skills-compatible tools, and any published skill drops into an agent unchanged.

A skill is a folder containing `SKILL.md`, optionally bundling its own code and reference material:

```
agents/reporter/skills/
├── pacing-check/           # standard form
│   ├── SKILL.md            #   name + description + instructions
│   ├── scripts/pace.py     #   bundled executable code
│   └── references/         #   optional supporting docs
└── house-style.md          # flat form — fine for a short skill
```

```markdown
---
name: pacing-check
description: Check whether ad spend is pacing to budget. Use when asked if spend is on track.
---

Run `scripts/pace.py --spent <amount> --budget <amount>` from this skill's folder,
then report the verdict in one sentence.
```

- `name` and `description` are the required frontmatter. The description is what the model reads when deciding whether the skill applies — write it for the model, and say *when* to use it.
- The frontmatter follows the [Agent Skills](https://agentskills.io) spec: `name` (max 64, lowercase letters/digits/single hyphens, matching the folder), `description` (non-empty, max 1024), and the optional `license`, `compatibility`, `metadata` and `allowed-tools`. `foldrun check` reports a name that breaks these rules or a folder that disagrees with its `name`, as warnings — a skill still loads, matching the standard's lenient-client guidance. A skill with no description is the one exception: it is skipped, because there is nothing to disclose it by.
- **Discovery locations.** Skills are found in an agent's own `skills/`, the workspace `skills/`, the account library, **and the workspace `.agents/skills/`** — the cross-client convention that other skills-compatible tools (Claude Code, Cursor, Codex, Copilot, Gemini CLI…) read and write. A skill any of them installs under `.agents/skills/` is visible here, and one written here to the standard drops into them. The native `skills/` wins a name clash; both are discovered.
- **Progressive disclosure:** only names and descriptions sit in context; the agent reads the full `SKILL.md` when a task matches. An agent can carry many skills for a few tokens each.
- A skill that bundles `scripts/` needs `bash` (or those scripts declared as tools) for the agent to execute them.

## memory/

An OKF bundle, like `knowledge/`, in exactly the same format. What separates
them is not the format but the write permission, and that separation is
**ours** — OKF defines no such directories. The spec makes provenance
*describable*, with `generated.by` saying whether a person or a machine
produced a document; the split is what makes it *enforceable*, because a field
is a claim written by whatever wrote the file, while a directory decides what
may be written at all.

- One concept per file, `type:` required — see the [OKF profile](okf/PROFILE.md).
- `index.md` is generated at every level, `log.md` at the bundle root. Both are
  OKF's, both are written by the platform, and an agent may not edit either.
- There is no curated index beside the generated one. Shared prose belongs in
  `AGENTS.md`, which is already the place for context every agent here gets.
- Harness guarantee: memory writes are the *only* writes an agent may make
  outside `outputs/` without an explicit `files` grant. `knowledge/` is denied
  outright — through the file tools and through `bash`.

## Runs

A run = clone repo → assemble context (agent.md body + relevant skills + memory index) → execute in a sandbox → commit memory/outputs → report.

- Every run gets an ID, a full event log, and a cost figure.
- `outputs/` in the workspace is captured as run artifacts (not committed unless configured).
- Exit states: `completed`, `needs-approval` (paused on a `: ask` tool), `failed`.

## CLI (reference)

```
foldrun init            # scaffold the layout above
foldrun run             # run locally against your own API key
foldrun deploy          # push → runs hosted (foldrun cloud)
foldrun logs <run-id>   # event log for a run
foldrun secrets set SLACK_WEBHOOK_TOKEN   # vault, never the repo
```

## Projects and flows

A **project** is the deploy unit: a repo holding a team of agents and the flows that orchestrate them.

```
my-project/
├── project.md            # optional — name/description; defaults from directory
├── agents/
│   ├── researcher/       # each agent follows the layout above
│   │   └── agent.md
│   └── writer/
│       └── agent.md
└── flows/
    └── weekly-digest.md  # orchestration, in markdown
```

A **flow** is an ordered list of steps. Each step names an agent with a `[[wikilink]]` and gives it an instruction. A step receives the previous step's result as context — output passing is the default, not configuration.

```markdown
---
name: weekly-digest
trigger: manual            # manual | schedule (cron in `schedule:`)
---

1. [[researcher]] — gather this week's competitor updates into bullet points
2. [[writer]] — turn the research into a 300-word digest at outputs/digest.md
```

Rules:
- Steps run in ascending group order. **Steps sharing a number run in parallel**; the next group starts when all of them finish and receives every result, labeled per agent:

  ```markdown
  1. [[researcher]] — gather the facts
  2. [[optimist]] — argue the bull case from the research
  2. [[skeptic]] — argue the bear case from the research
  3. [[editor]] — weigh both cases and write the verdict
  ```

- A `?` after the number marks the step **optional**: if it fails, the flow continues without its result (`2? [[enricher]] — nice-to-have enrichment`).
- **Routing** — `case:` steps in one group are exclusive branches: the FIRST
  whose text appears in the previous results runs, the rest are routed past,
  and an `else:` step runs only when no case matched:

  ```markdown
  1. [[classifier]] — reply with exactly one word, BUG or QUESTION
  2. [[debugger]] — investigate and fix
     case: BUG
  2. [[writer]] — answer it clearly
     case: QUESTION
  2. [[triager]] — neither label fit; say what is missing
     else: true
  ```

  `when:` is the non-exclusive sibling — every matching `when:` step runs —
  which is why routing is its own vocabulary instead of a mode on `when:`.
- **Evaluator loops** — a step may send the flow back one group until it is satisfied:

  ```markdown
  1. [[writer]] — draft the post
  2. [[editor]] — review it; end your reply with APPROVED when it is ready
     loop: 3
     until: APPROVED
  ```

  The marker must stand **alone on its own line** (case-insensitive, and
  markdown emphasis or trailing punctuation around it is ignored). It is a
  switch, not a clause: a reply of "APPROVED once the citation is fixed"
  contains the word but is a rejection, and reading it as a pass ends the loop
  with the correction unmade — which is exactly the failure the loop exists to
  prevent. Notes may follow the marker on later lines, so an approval with a
  list of nits still passes. When the result carries no such line, the
  previous group and this one run again — at most `loop:` extra cycles
  (capped at 5), so the worst-case cost is still readable off the file. A
  loop that exhausts its budget fails the step. This is the
  generate-critique-revise pattern with the determinism kept: the file
  decides the shape, the model decides only whether to say the word.
- **Fan-out** — a step may run once per item of the previous group's result:

  ```markdown
  1. [[scout]] — list the competitor URLs, one per line
  2. [[analyst]] — analyse this one site
     each: lines
     max: 10
  ```

  `each: lines` splits the previous result into non-empty lines (leading
  list markers stripped), caps them at `max:` (default 10, hard cap 20 —
  dropped items are logged, never silent), and runs one instance of the
  step per item, in parallel, each labeled by its item in the next group's
  context. The declared shape stays one line in the file; the width comes
  from the data.
- **Model and effort per step or per flow** — a step's option lines may name
  `model:` and `effort:`, and the flow's frontmatter may too. Resolution is
  nearest-wins: step, then flow, then the agent's own frontmatter — and the
  run trace names which level won, so "why did this run on haiku" is
  answerable from the run, not by opening three files:

  ```markdown
  ---
  name: digest
  model: fast              # every step, unless the step says otherwise
  ---

  1. [[scout]] — list the URLs
  2. [[analyst]] — the one hard step
     model: max
     effort: xhigh
  ```
- A step may target **another flow** instead of an agent — `1. [[flow:weekly]] — …` — which is how flows compose. The nested flow's steps run in place, keeping their own parallelism; cycles and nesting deeper than three levels are errors.

### Triggers

`trigger:` declares how a flow starts. Nine models:

| `trigger` | Starts when | Input |
|---|---|---|
| `manual` (default) | a human clicks Run, or `foldrun invoke`, or an API call | optional run task |
| `schedule` | a 5-field cron in `schedule:` matches (with optional IANA `timezone:`, default UTC; `@hourly`/`@daily`/`@weekly`/`@monthly` accepted) | none |
| `once` | the instant in `at:` (ISO 8601) passes — fires on the first tick at or after it, once; an instant more than six hours gone at first sighting is recorded and never fired | none |
| `webhook` | an HTTP POST arrives at the flow's hook URL. With `signature:` (`github`, `stripe`, `slack`, `hmac`) and `signing_secret: ${NAME}` the delivery must also carry that provider's HMAC, checked host-side against the vault; Slack's `url_verification` handshake is answered without starting anything | the request body |
| `email` | a message arrives at the flow's inbox URL (`/api/inbox/…`, same token as a hook) from any inbound-email service that POSTs received mail — Resend, Postmark, Mailgun, SendGrid, a Cloudflare Email Worker | from, to, subject, text |
| `flow` | another flow of the workspace named in `after:` settles the way `on:` says (`completed`, the default; `failed`; `any`) — a flow may not chain on itself | the finished run's id, status, summary and final result |
| `storage` | a file lands under the `path:` prefix of `storage/` — an upload, an API write, or another flow's run; a flow's own run never restarts it | the paths and who wrote them |
| `watch` | the content at `url:` changes, polled every `every:` (default 15m; first sighting records, never fires) | the new content |
| *(composed)* | another flow reaches a `[[flow:name]]` step | the previous step's results |

Hosts should not backfill missed scheduled occurrences beyond a bounded catch-up window, and must authenticate webhook and inbox URLs.

Beside the trigger, a flow's frontmatter may carry `budget: 5` — the most one run of it may spend, in USD. A literal, never an expression, so the cap is readable off the file. It is checked between groups: the group that crosses it is the last one that runs, the remaining steps are skipped as "over budget", and the run fails saying so. The workspace's monthly `budget:` in AGENTS.md still applies on top.

`[[name]]` is the format's one reference syntax, and the rule for where it may appear is one sentence: **if it names a file, you can link it.** Agents, flows, skills, tools, knowledge and memory are files; secrets, `model:`, `size:` and `effort:` are values. So a frontmatter field that names files — `tools:`, `skills:`, `agents:`, a step's `delegate:`, a flow's `after:` — accepts a link or a bare name and reads both as the same name, and hosts must offer `[[` completion inside them. The brackets carry one distinction: a linked name can only mean one of the author's own files, so in `tools:` a bare `search` is the runtime's group and `[[search]]` is `tools/search.md` — which is how a tool named after a built-in is granted at all. Prefer the block form when linking (`- [[site_repo]]`); to YAML `[[x]]` is a nested list, which is why the inline `tools: [read, [[site_repo]]]` parses but reads badly. In a flow's step line the first link is structural — it names the agent (or `flow:`) the step runs, parsed and validated. Anywhere prose reaches a model — a step's instruction, an agent's prompt — a `[[link]]` naming a knowledge or memory document (by filename, or by its `title:`/`name:` frontmatter, compared case- and separator-insensitively) or a `storage/` path — or a workspace folder itself (`[[storage/]]`, `[[state/]]`) — resolves to the real agent-relative path before the prompt is built. Unresolved links pass through as written: the syntax is sugar over paths, never a gate in front of them.

The idiom hosts and authors should follow: **link what you read, spell out what you write.** A link points at something that exists — an input. An output destination does not exist yet, so it stays a literal path.

Step options continued — failure, time, people and delegation:

- `verify: <command>` — a shell command run after the step; a non-zero exit fails it. This is where a flow puts anything that must be decided by arithmetic rather than judgement: the step options are matched as text, deliberately, so a threshold or a total belongs in a command that can be tested, not in a comparison in frontmatter. The command sees what the step's scripts saw: its secrets, `FOLDRUN_RUN_ID`, `FOLDRUN_AGENT`, `FOLDRUN_DATE` and `TZ` — so a proof a step leaves on disk can be checked to name *this* run, which matters because a run's copy-back never propagates a deletion and a marker from an earlier run rides into every later sandbox. `verify:` also accepts the eval file's assertion vocabulary — `verify: contains: $34`, `not-contains: leverage`, `matches: RG-\d+`, `file: outputs/report.md`, `judge: quotes the real price` — so a flow and an eval say "the output must mention the price" in one sentence, and the commonest checks need no shell. `judge:` is a toolless fast-tier grading call on the step's own credential; the other four cost nothing.
- `retry: <n>` — attempts after the first, clamped to 5. Consumed before `on-fail:` hands the step to another agent.
- `timeout: <seconds>` — abandon the step after this long. Minimum 1. **Without it, a step runs until it finishes.** The platform sets no clock of its own anywhere — not on a step, a script tool, an HTTP tool, a verify command, a consult, or a wait for a person's approval; every limit that exists is one written in a markdown file (`timeout:` on a step, on a script tool, on an HTTP tool). The run's events say which it is (`timeout: 3000s` or `no timeout`) at every step start. A step that has hit its limit is stopped with the files it wrote so far kept.
- `approve: true` — park the step until a person releases it. `ask:` is the same gate carrying a question; a step with `ask:` does not also need `approve:`.
- `on-fail: <agent>` — when the step fails (after its retries), the named agent takes it over: same instruction, the failure as context. Its success continues the flow with its result; a second failure fails the step as it always did.
- `wait: 3d` — hold before the step runs (`s`/`m`/`h`/`d`, capped at 30 days). The clock starts when the run reaches the step; the run parks in the queue with a not-before, not in a process, so a restart resumes the same deadline.
- `wait: event` — hold until something outside POSTs the run's event URL (`/api/events/<tenant>/<ws>/<run>?token=…`, derived like a hook token and printed in the step's trace). The same park as an approval, released by a machine instead of a person — a human can still release it from the run page — and whatever was POSTed reaches the step as its event. This is how a flow sends a quote, waits for the reply, and follows up, with no clock of the platform's and without the format becoming a chat product.
- `output: json` — the step returns data, not only prose: its reply must end with one JSON value in a ```` ```json ```` block (the prompt says so; the runner parses it back, and a reply with no JSON fails the step). The value reaches the next group beside the prose as `<previous_step_data>`, losslessly — a URL step 1 found reaches step 3 as the URL, not as a re-reading of step 1's paragraph — and rides the run record as `data`. `each: items` fans a later step out over the array it returned (or the one array-valued field of the object it returned), and a shell `verify:` receives it on stdin, so `verify: jq -e '.total > 0'` is arithmetic on the value the step actually returned. This is the one structured handoff the grammar ADR allowed instead of variables: a step declares it returns JSON, and nothing else in the file evaluates anything.
- `each: rows of <path>` — fan out one instance per CSV data row (path agent-relative, confined to the workspace); each instance receives the header plus its row. Caps as `each: lines`.
- `ask: <question>` — the approval gate carrying a question. The step parks awaiting a human; the answer typed at the gate reaches the step's prompt as the operator's answer.
- `delegate: a, b, c` — bounded model-led delegation: the step's agent ends its reply with `agent: instruction` lines choosing only from the declared set (at most 5); the picks run as a fresh group immediately after, and both the set and the picks are on the record. The set is who the step **may** call on, not who it must: choosing nobody is a normal outcome and is recorded as one.

`overlap:` in the flow's frontmatter says what a new fire does while a run of the same flow is still live: `skip` consumes the occurrence without starting anything (a cron refiring over yesterday's long run almost never means "run two"), `queue` starts the run but holds it until the live one finishes. Unset, runs may overlap — the historical behaviour, kept as the default so flows that legitimately run in parallel are undisturbed.
- A required step failing fails the flow; remaining groups are skipped.
- A workspace with one agent and no flows is perfectly normal — `foldrun run <agent>` runs it directly as a one-step flow, so there is a single execution path whether or not a flow file exists.

## Execution environments

Scripts need a language runtime and dependencies. An agent (or its project) declares them:

```yaml
runtime:
  python: "3.12"
  packages: [pandas, google-ads]   # pip
  node: true
  npm: [lodash]
```

Hosts **must** key the built environment on a fingerprint of this declaration and reuse it across runs — building per run is the difference between a 7-second and a 400-millisecond script call. Two agents declaring different versions of the same library must not collide.

The isolation boundary is the **run**, not the individual script. A single agent turn may call a script many times; a fresh sandbox per call is pathological, and scripts within a turn often pass state through files. This mirrors CI systems, where the unit is the job rather than the step.

| Level | What it gives you | Cost |
|---|---|---|
| Host process (dev only) | dependency isolation via venv / npm prefix | none — but scripts run as the server user |
| **Container per run**, image = runtime fingerprint | real isolation; the recommended production shape | image build + ~0.3s per call, amortised by caching |
| Hosted sandbox (e.g. Claude Managed Agents) | the same, operated for you, plus network policy | per-session-hour fee |

Long-lived per-agent containers are **not** recommended: state leaks between runs and tenants, and idle capacity is paid for whether or not anything runs.

### Reservation classes — `size`

A step declares how much sandbox it needs with `size:` in the agent's frontmatter (or a flow step's options, nearest-wins like `model:`). The host maps each class to a memory ceiling and a compute rate:

| `size` | Reference memory | CPU | For |
|---|---|---|---|
| `small` | 1Gi | burstable | agents that mostly wait on an API |
| `large` (default) | 2Gi | burstable | ordinary model work |
| `heavy` | 8Gi | burstable | a rendered browser, or real data in memory |

The figures are the host's to set (env-tunable), but the **shape** is normative: memory is a **hard ceiling** and CPU is **not capped**. This is because the two resources fail differently. CPU is compressible — a step over its share is throttled, so capping it only wastes idle cores the customer is paying for. Memory is not — a step over its ceiling is killed by the kernel, and on a single-node host an *uncapped* runaway takes the control plane and every other tenant's runs down with it. So the ceiling exists to bound the blast radius, not to ration.

Because a bigger class costs more (more GiB-seconds, a higher compute rate) and the price is billed from the class the step **actually held** — recorded on the run, not read from config at billing time — right-sizing is the author's own interest to get right. A host must not bill a class the step did not hold, and must treat a step with no recorded reservation (from before sizing existed) as the default class.

**Copy, don't bind-mount.** Hosts should copy the agent's directory into the container and copy `outputs/` back out, rather than bind-mounting it. Bind mounts require the host path to be in the container runtime's shared-paths configuration and fail *silently* (an empty mount) when it isn't — and copying additionally prevents a script from corrupting the source tree. Any Docker-compatible CLI then works unchanged: Docker Engine, colima, Podman, nerdctl, OrbStack.

A conforming container execution must run as a **non-root user**, drop all capabilities, forbid privilege escalation, bound CPU/memory/process count, and **disable networking unless the agent declared an API**. Secrets are passed as environment variables at container start, never baked into the image.

## The library — sharing across projects

Skills, scripts, memory and tool definitions exist at three scopes, and resolution is **nearest-wins**: an agent's own beats its project's, which beats the workspace's.

```
agents/writer/skills/house-style.md     ← this agent only
<project>/skills/ · scripts/            ← every agent in the project (workspace/scripts/)
<workspace>/library/                    ← every project in the workspace (mounted as library/)
├── skills/<name>/SKILL.md
├── scripts/<file>
├── memory/*.md
└── tools/<name>.md
```

A **library tool** is a reusable API definition — one file, written once, used by name:

```yaml
# library/tools/google-ads.md
transport: http
name: google-ads
base: https://googleads.googleapis.com/v18
methods: [GET, POST]
headers:
  Authorization: Bearer ${GOOGLE_ADS_TOKEN}
```

```yaml
# any agent, in any project
tools: [google-ads]
```

So an integration is defined once per workspace rather than copied into every agent, and rotating its credentials is a single edit. Hosts should expose the library as a first-class section of their UI, not bury it in project settings.

`tools:` is the one list. It is Claude Code's subagent field, kept compatible, and it accepts built-in groups, exact SDK names, and the author's own tools, with built-ins winning a bare name clash — a tool of yours named like a built-in is reported as shadowed, and `[[name]]` is how you say you meant yours. There is no second key: an earlier `use:` spelling, which meant only the author's own tools, was removed because two keys for one grant meant two places to look for an agent's blast radius. A host that finds `use:` in a file must grant nothing for it and report the `tools:` line to write instead.

## What this format is not

Two of these used to say the opposite, and the product answered the question
before the spec caught up. They are recorded here as *decisions*, because what
a format refuses is as much a part of it as what it accepts.

**Code is allowed, but never as behaviour.** An agent's instructions, skills,
knowledge and orchestration are markdown, and nothing may be expressed only in
a programming language. Code lives in `scripts/`, declared as a tool with typed
arguments, and is called *by* the markdown rather than wrapping it. That line
is the whole design: a domain expert reads and edits what the agent does, an
engineer writes the deterministic parts it calls, and both are reviewing the
same pull request. There are no hooks, no plugins and no lifecycle callbacks —
those would put behaviour back into a language most of the people responsible
for the agent cannot read.

**Orchestration is authored, not inferred.** Flows are a deterministic
backbone: numbered groups, the same number running together, control returning
between them. A step never decides who runs next, and there is no free-form
handoff between agents — that pattern's common failure is a loop where each
agent re-plans and nobody owns the task. A model chooses *what to do within a
step*; the file decides what happens after it. This is also what makes a flow's
cost predictable before it runs, which an inferred graph can never be.

**One wire format, not a model abstraction.** The runtime speaks the Anthropic
Messages API. A `provider:` block points it at any endpoint that speaks the
same shape, and anything else — OpenAI, Gemini — belongs behind a translating
gateway. Model *tiers* (`fast`, `default`, `max`) and *effort*
(`low`-`max`) are the only abstractions, so files do not rot when models are
renamed, and a gateway maps the tiers to its own ids with `provider.models`. Building a lowest-common-denominator
layer over every vendor would cost more than it returns.

**Not a chat product.** A run has a beginning and an end. Sessions,
conversation history and multi-turn dialogue with a person are a different
shape of thing, and a format that tried to be both would serve neither.
