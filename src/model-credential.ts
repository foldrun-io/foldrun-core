// Which Anthropic credential a step runs on, decided once and said on the
// record — never whatever happens to be signed in on the machine.
//
// In order: an API key (ANTHROPIC_API_KEY), a bearer for a gateway
// (ANTHROPIC_AUTH_TOKEN), then a Claude login token (CLAUDE_CODE_OAUTH_TOKEN,
// made by `claude setup-token`). Before this, an in-process step was handed
// none of them — the host allowlist drops credentials — so Claude Code fell
// back to the machine's own claude.ai login whatever key was set: a key the
// CLI insisted on was checked and then ignored.
//
// Note on terms: Anthropic does not allow third-party products built on the
// Agent SDK to offer claude.ai login unless Anthropic has approved it. The
// login token is accepted here because the account owner chose to support
// it; offering it to customers needs that approval.
//
// What an agent's own shell sees: Claude Code keeps CLAUDE_CODE_OAUTH_TOKEN
// out of its Bash by itself; an API key is visible there, as it is when you
// run Claude Code with one in your shell. Its scrub switch
// (CLAUDE_CODE_SUBPROCESS_ENV_SCRUB) is not used: it also strips the agent's
// own declared secrets (RESEND_API_KEY, DATAFORSEO_PASSWORD) from Bash, and on
// Linux it refuses to start without bubblewrap. Script tools and shell
// `verify:` never see any of these: they start from the host allowlist.

export type ModelCredentialKind = "api-key" | "auth-token" | "claude-login" | "none";

export interface ModelCredential {
  kind: ModelCredentialKind;
  /** What the run record and the CLI say: which credential, by its variable. */
  label: string;
  /** The variables the step's Claude Code is started with. */
  env: Record<string, string>;
}

const set = (v: string | undefined) => typeof v === "string" && v.trim() !== "";

export function resolveModelCredential(source: Record<string, string | undefined> = process.env): ModelCredential {
  const base: Record<string, string> = set(source.ANTHROPIC_BASE_URL) ? { ANTHROPIC_BASE_URL: source.ANTHROPIC_BASE_URL! } : {};
  if (set(source.ANTHROPIC_API_KEY)) {
    return {
      kind: "api-key",
      label: "API key (ANTHROPIC_API_KEY)",
      env: { ...base, ANTHROPIC_API_KEY: source.ANTHROPIC_API_KEY!, CLAUDE_CODE_OAUTH_TOKEN: "" },
    };
  }
  if (set(source.ANTHROPIC_AUTH_TOKEN)) {
    return {
      kind: "auth-token",
      label: `bearer token (ANTHROPIC_AUTH_TOKEN)${base.ANTHROPIC_BASE_URL ? ` to ${base.ANTHROPIC_BASE_URL}` : ""}`,
      env: { ...base, ANTHROPIC_AUTH_TOKEN: source.ANTHROPIC_AUTH_TOKEN!, ANTHROPIC_API_KEY: "", CLAUDE_CODE_OAUTH_TOKEN: "" },
    };
  }
  if (set(source.CLAUDE_CODE_OAUTH_TOKEN)) {
    return {
      kind: "claude-login",
      label: "Claude login token (CLAUDE_CODE_OAUTH_TOKEN)",
      env: { ...base, CLAUDE_CODE_OAUTH_TOKEN: source.CLAUDE_CODE_OAUTH_TOKEN!, ANTHROPIC_API_KEY: "" },
    };
  }
  return { kind: "none", label: "none set", env: {} };
}

/** The line a step's trail carries, and what goes wrong when there is none. */
export function credentialLine(c: ModelCredential): { type: "info" | "error"; text: string } {
  if (c.kind !== "none") return { type: "info", text: `model credential: ${c.label}` };
  return {
    type: "error",
    text:
      "model credential: none set — Claude Code will fall back to whatever login this machine has, if any. " +
      "Set ANTHROPIC_API_KEY, or CLAUDE_CODE_OAUTH_TOKEN from `claude setup-token`",
  };
}


// ---------------------------------------------------------------- the account's own key
//
// An account brings its own model key without writing a provider: block:
// three secrets in the ACCOUNT vault (set from Settings → Models, the API's
// /v1/account/model, or `foldrun account model set`). A provider: block at any
// level still wins; this is what a step falls to when none names one, before
// the platform's own credential.

/** Why a step or a call that names its own model endpoint (`provider:`)
 *  is refused where a platform admin turned own keys off (models.byok). */
export const OWN_KEYS_OFF =
  "this platform runs every model call on foldrun's models, so an agent or project cannot name its own model endpoint — remove `provider:` from the agent or AGENTS.md (a platform admin can allow own keys: setting models.byok)";

/** The account vault names the account's own model key lives under. */
export const ACCOUNT_MODEL_SECRETS = {
  provider: "FOLDRUN_MODEL_PROVIDER",
  key: "FOLDRUN_MODEL_API_KEY",
  baseUrl: "FOLDRUN_MODEL_BASE_URL",
  format: "FOLDRUN_MODEL_FORMAT",
} as const;

/** A provider: block built from the account's own model secrets, or
 *  undefined when it has set no key. `read` is the account-scope secret
 *  reader (getSecret without a workspace). */
export function accountModelBlock(read: (name: string) => string | null): Record<string, unknown> | undefined {
  const key = read(ACCOUNT_MODEL_SECRETS.key);
  if (!key) return undefined;
  const block: Record<string, unknown> = { token: `\${${ACCOUNT_MODEL_SECRETS.key}}` };
  const name = read(ACCOUNT_MODEL_SECRETS.provider);
  const baseUrl = read(ACCOUNT_MODEL_SECRETS.baseUrl);
  const format = read(ACCOUNT_MODEL_SECRETS.format);
  if (name) block.name = name;
  if (baseUrl) block.base_url = baseUrl;
  if (format) block.format = format;
  return block;
}

/** A Claude login token (`claude setup-token`, sk-ant-oat…), not an API key.
 *  An account may set one as its model key — its own claude.ai subscription —
 *  the same as any provider key. */
export function isClaudeLoginToken(value: string | null | undefined): boolean {
  return typeof value === "string" && /^sk-ant-oat\d*-/.test(value.trim());
}

/**
 * The variables a step's own model call is made with: the credential, the
 * endpoint, the tier names a provider renames and its headers, and the
 * egress proxy's name for the key. A declared secret with one of these
 * names would replace the step's model settings in the sandbox, so `check`
 * warns about it and the runner leaves it out (FOL-19).
 */
export const MODEL_ENV_NAMES: readonly string[] = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_CUSTOM_HEADERS",
  "ANTHROPIC_MODEL",
  "ANTHROPIC_SMALL_FAST_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "FOLDRUN_MODEL_KEY",
  "FOLDRUN_MODEL_KEY_FALLBACK",
];

/** How such a secret crosses into the sandbox instead; the driver maps it
 *  back for the agent's own tools (run-container.ts). */
export const DECLARED_ENV_PREFIX = "FOLDRUN_DECLARED_";

/** Names the model process (the Agent SDK, Claude Code's runtime) reads to
 * decide where its calls go, what goes into them, and where it reports:
 * every `ANTHROPIC_*` and `CLAUDE_*` name, its OpenTelemetry exporters, and
 * the switches that add betas, body fields, caching or thinking to a request
 * (FOL-338; the full sort is foldrun-infra docs/claude-code-env-vars.md). A
 * secret named after one would steer the step's model process, so it goes in
 * under the declared prefix like the names above: the agent's scripts and
 * tools still get it, its model process never does. Prefixes end in `*`. */
export const MODEL_RUNTIME_ENV: readonly string[] = [
  "ANTHROPIC_*",
  "CLAUDE_*",
  "CLAUDECODE",
  "OTEL_*",
  "BETA_TRACING_ENDPOINT",
  "ENABLE_BETA_TRACING_DETAILED",
  "AWS_BEARER_TOKEN_BEDROCK",
  "VERTEX_REGION_*",
  "MAX_THINKING_TOKENS",
  "DISABLE_PROMPT_CACHING*",
  "ENABLE_PROMPT_CACHING_1H*",
  "FORCE_PROMPT_CACHING_5M",
  "DISABLE_INTERLEAVED_THINKING",
  "ENABLE_TOOL_SEARCH",
  "ENABLE_CLAUDEAI_MCP_SERVERS",
  "DISABLE_TELEMETRY",
  "DISABLE_ERROR_REPORTING",
  "DISABLE_AUTOUPDATER",
  "DISABLE_UPDATES",
  "DO_NOT_TRACK",
  "API_TIMEOUT_MS",
];

export function isModelEnvName(name: string): boolean {
  const n = name.trim();
  if (MODEL_ENV_NAMES.includes(n)) return true;
  return MODEL_RUNTIME_ENV.some((p) => (p.endsWith("*") ? n.startsWith(p.slice(0, -1)) : n === p));
}

/** Declared secrets as the step's model process may see them: a name the
 * model process reads (isModelEnvName, or `alsoReserved`, e.g. the egress
 * proxy's) crosses as FOLDRUN_DECLARED_<NAME>; scripts and API tools get it
 * back under its own name. A secret the list already spells with the prefix
 * keeps its own value, so two declarations never fold into one (FOL-338,
 * Codex). Used for the sandbox and for in-process steps alike, so a local run
 * keeps the same rule as the cloud. */
export function declaredEnv(secrets: Record<string, string>, alsoReserved: (name: string) => boolean = () => false): Record<string, string> {
  const reserved = (n: string) => isModelEnvName(n) || alsoReserved(n);
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(secrets)) if (!reserved(name)) out[name] = value;
  for (const [name, value] of Object.entries(secrets)) {
    if (!reserved(name)) continue;
    const as = `${DECLARED_ENV_PREFIX}${name}`;
    if (!(as in out)) out[as] = value;
  }
  return out;
}

/** Why a `secrets:` list names a model variable, or null. */
export function modelSecretCollision(names: unknown): string | null {
  const list = (Array.isArray(names) ? names : typeof names === "string" ? names.split(",") : [])
    .filter((n): n is string => typeof n === "string")
    .map((n) => n.trim())
    .filter(isModelEnvName);
  if (!list.length) return null;
  const which = list.map((n) => `\`${n}\``).join(", ");
  const credential = list.every((n) => MODEL_ENV_NAMES.includes(n));
  return credential
    ? `${which} ${list.length === 1 ? "is a name" : "are names"} the step's own model call uses, so the model keeps its own value: ` +
        "its script and API tools and `verify:` get the declared one, but its own shell sees the model's — " +
        "give the secret another name (MY_ANTHROPIC_KEY), or run the model on it with `provider:` or `foldrun account model set`"
    : `${which} ${list.length === 1 ? "is in" : "are in"} the names the step's model process reserves (ANTHROPIC_*, CLAUDE_*, OTEL_* and the switches it reads), ` +
        "so the secret goes in as FOLDRUN_DECLARED_<name>: its script and API tools and `verify:` get it under its own name, the agent's own shell does not — " +
        "give the secret another name if the shell needs it";
}
