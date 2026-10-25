// The environment a step's children start from, on the in-process path.
//
// Scripts, `verify:` shells and the SDK's own Bash tool used to inherit the
// whole of process.env — which on a platform holds FOLDRUN_SECRET_KEY (the
// key every tenant's vault and hook token derives from), the database URL,
// the object-store and mail credentials, the Stripe key. `console.log(
// process.env)` in a script tool was cross-tenant compromise. tool-test.ts
// built a stripped base for the Test button; this is that base, made the one
// definition, used everywhere a child is spawned host-side.
//
// A run container needs none of this: its process.env IS the boundary,
// assembled from an allowlist on the host before the container started.
//
// What passes is what an interpreter needs to be found and to run, the
// locale, the clock, the network's proxy settings, and the identifiers the
// runner stamps on a step (FOLDRUN_RUN_*, FOLDRUN_STEP_*) so a script can
// say which run made its records. The secrets an agent declares are layered
// on top by the caller — by name, from the vault, never from the host.

const EXACT = new Set([
  "PATH", "HOME", "TMPDIR", "TMP", "TEMP", "LANG", "LANGUAGE",
  "TZ", "TERM", "SHELL", "USER", "LOGNAME",
  // Where Claude Code / the Agent SDK keeps its config and session
  // transcripts — the same kind of thing as HOME (a path, not a secret), and
  // without it an operator cannot keep them out of the host user's
  // ~/.claude: the box's deploy tests set it to the job's temp (2026-10-02).
  "CLAUDE_CONFIG_DIR",
  // The host's way to the network is the child's way to the network.
  "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy",
  "SSL_CERT_FILE", "SSL_CERT_DIR",
  // Windows equivalents, harmless elsewhere.
  "SYSTEMROOT", "COMSPEC", "PATHEXT", "WINDIR",
]);

const PREFIXES = ["LC_", "NODE_", "FOLDRUN_RUN_", "FOLDRUN_STEP_"];

/** Does this name pass the allowlist? Exported so a test can pin the rule
 *  rather than the list. */
export function hostEnvAllowed(name: string): boolean {
  return EXACT.has(name) || PREFIXES.some((p) => name.startsWith(p));
}

/**
 * process.env, reduced to the allowlist. A fresh object every call, so a
 * caller that layers secrets on top never writes into the host's own env.
 */
export function hostSafeEnv(from: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(from)) {
    if (typeof v === "string" && hostEnvAllowed(k)) out[k] = v;
  }
  // Typed as ProcessEnv, not a string map: a host whose type augmentation
  // makes a key required (Next declares NODE_ENV so) refuses a plain map at
  // every spawn. The value is the same either way.
  return out as NodeJS.ProcessEnv;
}

/**
 * Where this install's own API answers, for a step to call: `FOLDRUN_API_URL`
 * when the operator set it, else `FOLDRUN_PUBLIC_URL` + `/api`. Undefined on a
 * laptop with neither.
 *
 * A desk that reads its own run history used to write the host into its
 * files (`https://dev.foldrun.io/api`), so the same workspace pointed at the
 * wrong server the day it moved. Now a script reads `$FOLDRUN_API_URL` and an
 * `apis:` entry writes `base: ${FOLDRUN_API_URL}`.
 */
export function platformApiUrl(from: NodeJS.ProcessEnv = process.env): string | undefined {
  const explicit = from.FOLDRUN_API_URL?.trim();
  if (explicit) return explicit.replace(/\/+$/, "");
  const origin = from.FOLDRUN_PUBLIC_URL?.trim();
  return origin ? `${origin.replace(/\/+$/, "")}/api` : undefined;
}

/** The install's own addresses an `apis:` base may name. Not secrets: they
 *  are printed in the prompt as the tool's base URL. */
export function expandPlatformVars(value: string, from: NodeJS.ProcessEnv = process.env): string {
  const vars: Record<string, string | undefined> = {
    FOLDRUN_API_URL: platformApiUrl(from),
    FOLDRUN_PUBLIC_URL: from.FOLDRUN_PUBLIC_URL?.trim().replace(/\/+$/, "") || undefined,
  };
  return value.replace(/\$\{(FOLDRUN_API_URL|FOLDRUN_PUBLIC_URL)\}/g, (whole, name: string) => vars[name] ?? whole);
}
