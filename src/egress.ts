// Egress: the run sandbox never holds a credential it only ever puts in a
// header.
//
// Until now a step's secrets were decrypted host-side and copied into the
// sandbox as environment variables. The model never saw a value — only the
// names — but every program in the pod could read them: a script tool, a
// bash grant, a dependency `runtime:` installed. The pod was the blast
// radius, and the credential was inside it.
//
// The egress proxy moves the credential to the boundary. The pod is handed
// a per-step address (`http://<worker>/e/<lease>`) and a set of
// placeholders (`${RESEND_API_KEY}`), and sends every API request through
// that address with the placeholder still in the header. The worker holds
// the lease, swaps the placeholder for the value on the way out — for the
// host that secret was granted to, and no other — forwards the request, and
// streams the answer back. The value exists in the worker's memory and on
// the wire to the provider. Never in the pod.
//
// Three consumers, in the pod:
//   - the http tools (api-tools.ts): every declared API
//   - the translator (translator.ts): the model key, for Chat Completions
//     and Responses providers
//   - the Agent SDK itself, for Anthropic-shaped providers: its base URL is
//     pointed through the proxy and its key IS the placeholder
//
// Script tools are the exception, on purpose: a script reads secrets from
// its environment and may need the real value in process (a browser seeding
// cookies, an ssh key). A step that grants such a script materialises its
// secrets into the pod as before, and the run record says so. A script that
// declares `secrets: proxied` in its tool file gets the placeholders and
// `FOLDRUN_EGRESS` instead, and sends through the proxy like everything
// else.
//
// This file is the vocabulary both sides share. The server is the
// platform's (it needs a long-lived process and a Service); the pod side is
// here in core, because it is what the runner image runs.

/** `${NAME}` — the shape a secret reference takes everywhere in foldrun. */
export const PLACEHOLDER = /\$\{([A-Z][A-Z0-9_]*)\}/g;

/** The env var the pod reads to know it should send through a proxy. */
export const EGRESS_ENV = "FOLDRUN_EGRESS";

/** The placeholder name the platform's own model key travels under. */
export const MODEL_KEY_NAME = "FOLDRUN_MODEL_KEY";

/**
 * The address a request to `target` should actually be sent to. With no
 * proxy configured, the target itself — every caller works unchanged on a
 * machine with no worker, which is the CLI and every test.
 */
export function viaEgress(egress: string | undefined | null, target: string): string {
  if (!egress) return target;
  return `${egress.replace(/\/+$/, "")}/${target}`;
}

/** The names referenced by placeholders in a string. */
export function placeholderNames(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(PLACEHOLDER)) out.add(m[1]);
  return [...out];
}

/** Replace the placeholders in `text` whose names `values` knows. Unknown
 *  names stay literal, so a wrong grant fails loudly at the provider
 *  instead of silently sending nothing. */
export function substitutePlaceholders(text: string, values: Record<string, string>): string {
  return text.replace(PLACEHOLDER, (whole, name: string) => (name in values ? values[name] : whole));
}

/** The host a granted secret may be sent to. Compared case-insensitively;
 *  a port is part of the host. */
export function hostOf(url: string): string | null {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * What one step is allowed to send, and where. The runner builds this
 * from the step's declared secrets and the hosts its tools and provider
 * name; the proxy enforces it per request.
 */
export interface EgressGrant {
  /** Secret name → the hosts that secret may be substituted for. */
  secrets: Record<string, { value: string; hosts: string[] }>;
}

export interface EgressLease {
  /** The base the pod sends through: `http://…/e/<token>`. */
  url: string;
  /** One line per request, for the run trace. Drained by the runner. */
  drainLog(): string[];
  /** The step is over: the lease is void and its values are dropped. */
  release(): void;
}

/**
 * The seam the platform fills. `null` from `lease` (or no `egress` at all)
 * means "no proxy here" and the runner falls back to materialising, exactly
 * as it always did.
 */
export interface EgressHooks {
  lease(args: { tenant: string; runId: string; grant: EgressGrant }): Promise<EgressLease | null>;
}

/** Strip a header set of the proxy's own and hop-by-hop headers. */
export const HOP_BY_HOP = new Set([
  "connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer",
  "transfer-encoding", "upgrade", "host", "content-length",
]);

const ANTHROPIC_DEFAULT_BASE = "https://api.anthropic.com";

/**
 * A model env (the SDK's ANTHROPIC_* variables) rewritten to send through
 * a lease: the base URL goes via the proxy, and whichever credential is
 * set becomes the `${FOLDRUN_MODEL_KEY}` placeholder — the SDK only ever
 * puts it in a header, and the proxy fills it for that one host. Provider
 * headers that carried a secret's value get the value swapped back for
 * its `${NAME}`, so the pod holds the name and the proxy holds the value.
 * Adds the grants it needs to `grant`. Pure apart from that.
 */
export function proxyModelEnv(
  env: Record<string, string | undefined>,
  leaseUrl: string,
  grant: EgressGrant,
  knownSecrets: Record<string, string> = {},
  name: string = MODEL_KEY_NAME,
): Record<string, string | undefined> {
  const base = env.ANTHROPIC_BASE_URL || ANTHROPIC_DEFAULT_BASE;
  const host = hostOf(base);
  if (!host) return env;
  const out: Record<string, string | undefined> = { ...env, ANTHROPIC_BASE_URL: viaEgress(leaseUrl, base) };
  const credentialKeys = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN"] as const;
  for (const key of credentialKeys) {
    const value = env[key];
    if (typeof value === "string" && value.length) {
      addGrant(grant, name, value, host);
      out[key] = `\${${name}}`;
    }
  }
  if (typeof env.ANTHROPIC_CUSTOM_HEADERS === "string") {
    out.ANTHROPIC_CUSTOM_HEADERS = unsubstitute(env.ANTHROPIC_CUSTOM_HEADERS, knownSecrets, host, grant);
  }
  return out;
}

/** Put the `${NAME}` back where a known secret's value sits in `text`,
 *  granting the name to `host`. Longest values first, so one that contains
 *  another is replaced whole. */
export function unsubstitute(text: string, knownSecrets: Record<string, string>, host: string, grant: EgressGrant): string {
  let out = text;
  const entries = Object.entries(knownSecrets).filter(([, v]) => v.length >= 8).sort((a, b) => b[1].length - a[1].length);
  for (const [name, value] of entries) {
    if (!out.includes(value)) continue;
    out = out.split(value).join(`\${${name}}`);
    addGrant(grant, name, value, host);
  }
  return out;
}

export function addGrant(grant: EgressGrant, name: string, value: string, host: string): void {
  const h = host.toLowerCase();
  const existing = grant.secrets[name];
  if (existing) {
    if (!existing.hosts.includes(h)) existing.hosts.push(h);
  } else grant.secrets[name] = { value, hosts: [h] };
}
