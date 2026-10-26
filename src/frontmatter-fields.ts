// Every frontmatter field foldrun reads, per kind of file — as data.
//
// The one list. Before it, the fields lived in five places that drifted: the
// runtime's reads, the dashboard's completions, the scanner's typo lists, the
// docs, and the assistant's vocabulary — the completions offered `language:`
// on a flow, which no run reads. Now:
//
//   · completions.ts offers exactly these, in the browser (so this file is
//     pure data: no fs, no store);
//   · frontmatter-schema.ts checks values against them, for `foldrun check`,
//     the Checks page, the editor and the deploy's view;
//   · tests/frontmatter-schema.test.ts fails when the runner, parseFlow or a
//     tool parser reads a field missing here, or a completion offers one
//     that is not; foldrun-web's consistency test fails when one here is not
//     in the docs.
//
// A new field is added here first, then read.

export type FieldType = "string" | "number" | "boolean" | "list" | "object";

export interface FieldSpec {
  key: string;
  /** What YAML may hand over. "list" is also offered where the runtime
   *  splits `a, b` on one line, so such fields list "string" too. */
  type: FieldType | FieldType[];
  /** The values that do something, when the set is closed and has no
   *  aliases. Anything else is reported. */
  values?: readonly string[];
  /** Another function validates this field in full and is the one place
   *  that does; the schema only says the field exists. */
  validated?: boolean;
  /** An older name still read, or kept so the right message (not
   *  "unknown") reaches whoever wrote it. Not offered as a completion. */
  legacy?: boolean;
  /** One line: what it is. The completion's hint. */
  help: string;
  /** Which of the four jobs it does, when it does one (set from JOB_FIELDS
   *  below, not by hand): the block it may also be written in. */
  job?: Job;
}

/**
 * The four jobs of running agents — governance, guardrail, observability,
 * evaluation (the owner's choice of words, 21 Oct 2026). A field that does
 * one may be written flat, as always, or inside a block of that name:
 *
 *   guardrail:
 *     limits: {repeat: 5}
 *     network: [api.example.com]
 *
 * reads exactly as `limits:` and `network:` at the top. matter.ts folds the
 * blocks as it parses, so every reader sees flat keys; check reports a key
 * set both ways (config/conflict) or in the wrong block.
 */
export type Job = "governance" | "guardrail" | "observability" | "evaluation";

export const JOBS: readonly { name: Job; title: string; what: string }[] = [
  { name: "governance", title: "Governance", what: "who answers for it and what it may spend, decide and ship" },
  { name: "guardrail", title: "Guardrail", what: "what it may reach and call, and what stops it" },
  { name: "observability", title: "Observability", what: "what is recorded, and who is told" },
  { name: "evaluation", title: "Evaluation", what: "how its work is judged" },
];

export type SchemaKind = "agent" | "agents-md" | "flow" | "tool" | "skill" | "eval" | "hook";

/** What can start a flow. store.ts re-exports it; parseFlow and the editor
 *  read this one. */
export const FLOW_TRIGGERS = ["manual", "schedule", "webhook", "email", "flow", "once", "watch", "storage"] as const;

/** The effort levels; store.ts re-exports it with the aliases beside. */
export const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;

const LOCALE = { validated: true } as const;

const AGENT: FieldSpec[] = [
  { key: "name", type: "string", help: "kebab-case; the folder is the identity" },
  { key: "description", type: "string", help: "what it does and when — other agents and people read it" },
  { key: "owner", type: "string", help: "the person accountable for it — an email or a name; else the workspace's, else the account's" },
  { key: "model", type: "string", help: "fast | default | max, an alias, or a full model id" },
  { key: "effort", type: "string", values: EFFORT_LEVELS, help: "how long it thinks" },
  { key: "size", type: "string", values: ["small", "large", "heavy"], help: "the sandbox it rents; anything else becomes large" },
  { key: "resources", type: "object", help: "{cpu, memory, disk} in numbers, over the size class's figures key by key — cpu 0.5–8, memory 256Mi–16Gi, disk 1–40Gi" },
  { key: "permissionMode", type: "string", values: ["plan"], help: "plan = read-only; no other mode changes anything here" },
  { key: "tools", type: ["list", "string"], help: "the one grant list" },
  { key: "disallowedTools", type: ["list", "string"], help: "subtract from what it would otherwise have" },
  { key: "skills", type: ["list", "string"], help: "an allowlist; absent inherits every skill" },
  { key: "hooks", type: ["list", "string", "object"], help: "hook names; a Claude Code hooks: object is read as none" },
  { key: "scripts", type: "list", help: "programs in scripts/, each a tool" },
  { key: "apis", type: "list", help: "an HTTP API as a tool" },
  { key: "mcpServers", type: "object", help: "MCP servers, name → {command | url, args, env, headers}" },
  { key: "agents", type: ["list", "string"], help: "colleagues it may consult" },
  { key: "subagents", type: ["list", "string"], help: "colleagues it may delegate to" },
  { key: "sandbox", type: "string", values: ["own", "parent"], help: "when delegated to as a sub-agent: own = its own sandbox, tools, secrets and network; parent (default) = inside the delegating step's" },
  { key: "secrets", type: ["list", "string"], help: "keys it spends itself" },
  { key: "budget", type: ["number", "string"], help: "USD per run" },
  { key: "limits", type: "object", validated: true, help: "per-step call limits" },
  { key: "network", type: ["string", "list", "object"], validated: true, help: "open | trusted | none, sites, or {level, allow, defaults}" },
  { key: "web", type: "object", validated: true, help: "providers for the web tool's actions" },
  { key: "provider", type: "object", help: "an Anthropic- or OpenAI-format endpoint for this agent" },
  { key: "runtime", type: "object", help: "packages and system packages for its sandbox" },
  { key: "ask", type: "object", help: "{timeout} for tools: [ask]" },
  { key: "timezone", type: "string", ...LOCALE, help: "IANA name or offset" },
  { key: "language", type: "string", ...LOCALE, help: "BCP-47 tag" },
  { key: "region", type: "string", ...LOCALE, help: "two-letter country" },
  { key: "currency", type: "string", ...LOCALE, help: "three letters" },
  { key: "units", type: "string", ...LOCALE, help: "metric | imperial" },
  { key: "calendar", type: "string", ...LOCALE, help: "an Intl calendar" },
  { key: "schedule", type: ["string", "object"], validated: true, legacy: true, help: "refused: only a flow has a clock" },
  { key: "use", type: ["list", "string"], validated: true, legacy: true, help: "retired: write tools:" },
];

const AGENTS_MD: FieldSpec[] = [
  { key: "foldrun_version", type: ["string", "number"], help: "the format version this account targets" },
  { key: "mdagent_version", type: ["string", "number"], legacy: true, help: "older spelling of foldrun_version" },
  { key: "name", type: "string", help: "the workspace's name" },
  { key: "description", type: "string", help: "shown in the workspace list" },
  { key: "owner", type: "string", help: "the person accountable for every agent and flow here that names none" },
  { key: "provider", type: "object", help: "the model endpoint every agent here uses unless it names its own" },
  { key: "runtime", type: "object", help: "packages for agents that declare none" },
  { key: "web", type: "object", validated: true, help: "web.browse defaults" },
  { key: "network", type: ["string", "list", "object"], validated: true, help: "every agent's default network" },
  { key: "limits", type: "object", validated: true, help: "default call limits" },
  { key: "hooks", type: ["list", "string"], help: "hooks every agent here runs" },
  { key: "timezone", type: "string", ...LOCALE, help: "default timezone" },
  { key: "language", type: "string", ...LOCALE, help: "default language" },
  { key: "region", type: "string", ...LOCALE, help: "default region" },
  { key: "currency", type: "string", ...LOCALE, help: "default currency" },
  { key: "units", type: "string", ...LOCALE, help: "default units" },
  { key: "calendar", type: "string", ...LOCALE, help: "default calendar" },
  { key: "notify", type: ["string", "object"], help: "an email or URL told about failed runs and waiting approvals" },
  { key: "budget", type: ["number", "string"], help: "USD per month, or N/day | N/week | N/month" },
  { key: "priority", type: "string", values: ["high", "normal", "low"], help: "account: where its runs stand in the queue" },
  { key: "concurrency", type: ["number", "string"], help: "account: runs at once" },
  { key: "compute", type: "object", help: "account: {vcpu, memory} its running steps may hold together — lowers the plan's, never raises it" },
  { key: "alerts", type: "object", validated: true, help: "thresholds that tell notify: — failure_rate (30%), min_runs, credits_day, run_minutes, stale_days, cost_spike, runs_per_hour, new_host" },
  { key: "capture", type: "string", values: ["full", "metadata"], help: "what runs record of each tool call: full (its input and output, secrets masked) or metadata (name, size and time only)" },
  { key: "network_enforce", type: "boolean", help: "true: a site off a step's network: list is refused, not only named in the trace. The account's or the workspace's true is enough" },
  { key: "telemetry", type: "object", validated: true, help: "send each run as an OpenTelemetry trace — otlp: <https …/v1/traces>, headers: { authorization: ${SECRET} }" },
  { key: "deploy_block", type: "string", values: ["none", "secrets", "security"], help: "refuse a deploy on scanner findings: secrets (a key written in) or security (any security warning)" },
  { key: "judge", type: "object", validated: true, help: "the model every judge: here grades with — {model: fast | default | max, effort}; an eval's own model: wins" },
  { key: "schedule", type: ["string", "object"], validated: true, legacy: true, help: "refused: only a flow has a clock" },
];

const FLOW: FieldSpec[] = [
  { key: "name", type: "string", help: "the flow's name" },
  { key: "description", type: "string", help: "what it is for" },
  { key: "owner", type: "string", help: "the person accountable for it — an email or a name; else the workspace's, else the account's" },
  { key: "trigger", type: "string", values: FLOW_TRIGGERS, help: "what starts it; any other value never fires" },
  { key: "schedule", type: "string", help: "cron, when trigger: schedule" },
  { key: "timezone", type: "string", validated: true, help: "the zone its schedule reads in" },
  { key: "model", type: "string", help: "every step's model unless the step says" },
  { key: "effort", type: "string", values: EFFORT_LEVELS, help: "every step's effort unless the step says" },
  { key: "overlap", type: "string", validated: true, help: "skip | queue" },
  { key: "issues", type: "string", values: ["stay-open", "auto-close"], help: "what a good run does to this flow's open issues: stay-open (the default — a person resolves them) or auto-close" },
  { key: "priority", type: "string", validated: true, help: "high | normal | low" },
  { key: "catchup", type: "string", validated: true, help: "last | none" },
  { key: "on", type: "string", validated: true, help: "trigger: flow — completed | failed | blocked | any" },
  { key: "signature", type: "string", validated: true, help: "github | stripe | slack | hmac" },
  { key: "signing_secret", type: "string", help: "the secret a webhook's signature is checked with" },
  { key: "after", type: ["string", "list"], help: "trigger: flow — the flow this one follows" },
  { key: "at", type: "string", help: "trigger: once — when" },
  { key: "url", type: "string", help: "trigger: watch — the page watched" },
  { key: "every", type: ["string", "number"], help: "trigger: watch — how often" },
  { key: "path", type: "string", help: "trigger: storage — the prefix under storage/" },
  { key: "filter", type: "object", validated: true, help: "webhook, email, flow or storage trigger: the fields a delivery must have to start a run — e.g. {action: [opened], sender: {type: {not_in: [Bot]}}}" },
  { key: "idempotency", type: "string", help: "a header name, or body:<field>, that marks a repeat delivery" },
  { key: "debounce", type: ["string", "number"], help: "wait for a burst to end" },
  { key: "throttle", type: ["string", "number"], help: "at most one run per window" },
  { key: "sla", type: ["string", "number"], help: "tell someone when a run outlives it" },
  { key: "approve_within", type: ["string", "number"], help: "how long an approval may wait" },
  { key: "disable_after", type: ["number", "string"], help: "switch the flow off after this many failures in a row" },
  { key: "pause_when", type: "string", help: "a marker that pauses the flow when a run's result says it" },
  { key: "approvers", type: ["list", "string"], help: "who may approve its gates" },
  { key: "budget", type: ["number", "string"], help: "USD per run" },
  { key: "live", type: "boolean", help: "true: steps may act for real in a test run" },
];

const TOOL: FieldSpec[] = [
  { key: "name", type: "string", help: "defaults to the file or folder name" },
  { key: "description", type: "string", help: "what it does — the model chooses by it" },
  { key: "transport", type: "string", values: ["http", "script", "mcp"], help: "http | script | mcp" },
  { key: "type", type: "string", legacy: true, help: "older spelling of transport" },
  { key: "outward", type: "boolean", help: "true: it changes something outside the workspace" },
  { key: "base", type: "string", help: "http: the API's base URL" },
  { key: "headers", type: "object", help: "http or mcp: request headers; ${SECRET} is filled server-side" },
  { key: "query", type: "object", help: "http: query parameters on every call" },
  { key: "methods", type: ["list", "string"], help: "http: GET, POST, PUT, PATCH, DELETE" },
  { key: "openapi", type: "string", help: "http: an OpenAPI document for the operations" },
  { key: "operations", type: ["list", "object"], help: "http: which operations to offer" },
  { key: "rate", type: ["string", "number"], help: "http: N/s, N/minute, N/hour, or a number per second" },
  { key: "timeout", type: ["number", "string"], help: "seconds one call may take" },
  { key: "run", type: "string", help: "script: the program, relative to the tool" },
  { key: "args", type: ["object", "list"], help: "script: its arguments, name → what it is; mcp: the command's arguments" },
  { key: "interpreter", type: "string", help: "script: what runs it" },
  { key: "test_mode", type: "string", values: ["allow"], help: "script: allow — it may run in a test run" },
  { key: "secrets", type: ["list", "string"], help: "script: secret names, or proxied | materialised" },
  { key: "runtime", type: "object", help: "script: packages it needs" },
  { key: "code", type: "string", help: "script: the program inline" },
  { key: "command", type: "string", help: "mcp: the server's command" },
  { key: "env", type: "object", help: "mcp: its environment" },
  { key: "url", type: "string", help: "mcp: a server over http" },
  { key: "guide", type: "string", legacy: true, help: "ignored — the guide is the body" },
];

const SKILL: FieldSpec[] = [
  { key: "name", type: "string", help: "defaults to the folder" },
  { key: "description", type: "string", help: "required — the model chooses a skill by it" },
  { key: "when", type: ["list", "string"], help: "run tags it loads on" },
  // The Agent Skills format's own optional fields: not read, not wrong.
  { key: "license", type: "string", help: "Agent Skills format" },
  { key: "compatibility", type: "string", help: "Agent Skills format" },
  { key: "metadata", type: "object", help: "Agent Skills format" },
  { key: "allowed-tools", type: ["string", "list"], help: "Agent Skills format: space-separated pre-approved tools (experimental)" },
];

const EVAL: FieldSpec[] = [
  { key: "name", type: "string", help: "the eval's name" },
  { key: "agent", type: "string", help: "the agent it tests" },
  { key: "flow", type: "string", help: "or the flow" },
  { key: "model", type: "string", help: "the judge's model" },
  { key: "effort", type: "string", values: EFFORT_LEVELS, help: "the judge's effort" },
  { key: "trigger", type: "string", values: ["deploy", "manual", "runs"], help: "deploy (default) | manual | runs — runs: grade real finished runs of the agent or flow instead of running cases" },
  { key: "sample", type: ["number", "string"], validated: true, help: "trigger: runs — the share of finished runs graded, 0 to 100 percent (default 25)" },
  { key: "improve", type: ["boolean", "number"], validated: true, help: "trigger: runs — true (or a count, default 5): propose a fix once that many graded runs failed" },
  { key: "live", type: "boolean", help: "true: real calls" },
  { key: "inputs", type: "boolean", help: "true: cases carry inputs" },
];

const HOOK: FieldSpec[] = [
  { key: "on", type: "string", validated: true, help: "tool.call | tool.result | step.start | step.end" },
  { key: "tool", type: "string", validated: true, help: "only on tool events" },
  { key: "timeout", type: "number", validated: true, help: "seconds, 1 to 120" },
  { key: "description", type: "string", help: "what it guards" },
  { key: "name", type: "string", help: "the folder is the name" },
];

/** `kind:` and `type:` were how a document once said what it was; the path
 *  says it now, and `foldrun check` has its own message for them. */
const SAID_WHAT_IT_IS: FieldSpec[] = [
  { key: "kind", type: "string", validated: true, legacy: true, help: "no longer read — the path says what this is" },
  { key: "type", type: "string", validated: true, legacy: true, help: "no longer read — the path says what this is" },
];

/** Which fields each job holds, per kind of file. One table: the blocks'
 *  help, the fold, the editor's completions and check all read it. */
const JOB_FIELDS: Partial<Record<SchemaKind, Partial<Record<Job, readonly string[]>>>> = {
  agent: {
    governance: ["owner", "budget"],
    guardrail: ["limits", "network", "hooks", "disallowedTools", "permissionMode", "secrets", "sandbox", "resources"],
  },
  flow: {
    governance: ["owner", "approvers", "approve_within", "budget", "priority"],
    guardrail: ["throttle", "debounce", "overlap", "disable_after", "live"],
    observability: ["issues", "sla"],
  },
  "agents-md": {
    governance: ["owner", "budget", "priority", "concurrency", "compute", "deploy_block"],
    guardrail: ["limits", "network", "network_enforce", "hooks"],
    observability: ["alerts", "telemetry", "notify", "capture"],
    evaluation: ["judge"],
  },
};

/** The fields of one kind that do this job, in schema order. */
export function fieldsOfJob(kind: SchemaKind, job: Job): string[] {
  return [...(JOB_FIELDS[kind]?.[job] ?? [])];
}

/** Every key any kind lets a block hold, per job — what matter.ts may lift
 *  out of a block without knowing which kind of file it is reading. */
export const FOLDABLE: Readonly<Record<Job, ReadonlySet<string>>> = Object.fromEntries(
  JOBS.map(({ name }) => [name, new Set(Object.values(JOB_FIELDS).flatMap((byJob) => byJob?.[name] ?? []))]),
) as unknown as Record<Job, ReadonlySet<string>>;

/** A kind's fields with their jobs set, and a block field per job it has. */
function withJobs(kind: SchemaKind, fields: FieldSpec[]): FieldSpec[] {
  const byJob = JOB_FIELDS[kind] ?? {};
  const jobOf = new Map<string, Job>();
  for (const [job, keys] of Object.entries(byJob) as [Job, readonly string[]][]) for (const k of keys) jobOf.set(k, job);
  const tagged = fields.map((f) => (jobOf.has(f.key) ? { ...f, job: jobOf.get(f.key)! } : f));
  const blocks: FieldSpec[] = JOBS.filter((j) => (byJob[j.name]?.length ?? 0) > 0).map((j) => ({
    key: j.name,
    type: "object",
    help: `${j.title} — ${j.what}: ${byJob[j.name]!.join(", ")}, as one block`,
  }));
  return [...tagged, ...blocks];
}

export const FRONTMATTER: Readonly<Record<SchemaKind, readonly FieldSpec[]>> = {
  agent: withJobs("agent", [...AGENT, ...SAID_WHAT_IT_IS]),
  "agents-md": withJobs("agents-md", AGENTS_MD),
  flow: withJobs("flow", [...FLOW, ...SAID_WHAT_IT_IS]),
  tool: [...TOOL, ...SAID_WHAT_IT_IS.filter((f) => f.key !== "type")],
  skill: [...SKILL, ...SAID_WHAT_IT_IS],
  eval: [...EVAL, ...SAID_WHAT_IT_IS],
  hook: HOOK,
};

/** Which schema a workspace-relative path is read with, or null. */
export function schemaKindOf(p: string): SchemaKind | null {
  // A library entry is `library/<kind>/<path>`; read it as `<kind>/<path>`.
  const rel = p.replace(/^library\/(?=[a-z]+\/)/, "");
  if (/^agents\/[^/]+\/agent\.md$/.test(rel) || /^\.(?:claude|agents)\/agents\/[^/]+\.md$/.test(rel)) return "agent";
  if (rel === "AGENTS.md" || rel === "project.md") return "agents-md";
  if (/^flows\/[^/]+\.md$/.test(rel)) return "flow";
  if (/^tools\/[^/]+\/tool\.md$/.test(rel) || /^tools\/[^/]+\.md$/.test(rel)) return "tool";
  if (/(?:^|\/)skills\/[^/]+\/SKILL\.md$/.test(rel)) return "skill";
  if (/^evals\/[^/]+\.md$/.test(rel)) return "eval";
  if (/^hooks\/[^/]+\/hook\.md$/.test(rel)) return "hook";
  return null;
}
