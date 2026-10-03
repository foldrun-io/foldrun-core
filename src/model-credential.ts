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
