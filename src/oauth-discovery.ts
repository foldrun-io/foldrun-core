// Discovery from an issuer: give foldrun the provider's issuer URL and it
// reads the authorization server's own metadata (RFC 8414, OpenID Connect
// Discovery 1.0) instead of a person typing the authorize, token and
// revocation URLs by hand — where a typo costs a consent, and an endpoint
// on the wrong host is a mix-up attack waiting to happen.
//
// Where the metadata lives, in the order tried (RFC 8414 §3.1 and §5):
//   https://host/.well-known/oauth-authorization-server{/path}
//   https://host/.well-known/openid-configuration{/path}
//   https://host{/path}/.well-known/openid-configuration   (OIDC's own spelling)
// The document's `issuer` must equal the issuer asked for, exactly (RFC 8414
// §3.3) — a document that names another issuer is refused, not trusted.

import type { TokenAuth } from "./oauth-token.ts";

/** What foldrun reads from a metadata document. */
export interface OAuthServerMetadata {
  issuer: string;
  authorization_endpoint?: string;
  token_endpoint?: string;
  revocation_endpoint?: string;
  device_authorization_endpoint?: string;
  pushed_authorization_request_endpoint?: string;
  require_pushed_authorization_requests?: boolean;
  token_endpoint_auth_methods_supported?: string[];
  code_challenge_methods_supported?: string[];
  authorization_response_iss_parameter_supported?: boolean;
  dpop_signing_alg_values_supported?: string[];
  scopes_supported?: string[];
  jwks_uri?: string;
}

/** A discovered server, as the fields a saved app and an oauth2 secret take. */
export interface DiscoveredClientConfig {
  issuer: string;
  authorize_url?: string;
  token_url: string;
  revocation_url?: string;
  device_url?: string;
  par_url?: string;
  /** The server requires PAR: an authorize URL without a request_uri fails. */
  par_required?: boolean;
  /** Whether the server sends `iss` with every authorization response
   *  (RFC 9207): when true, one that comes back without it is refused. */
  iss_parameter: boolean;
  /** How the client should authenticate at the token URL, given whether it
   *  has a secret and what the server supports; absent is the form body. */
  token_auth?: TokenAuth;
  /** Where the metadata was read from. */
  metadata_url: string;
  metadata: OAuthServerMetadata;
}

/** Loopback is exempt: a server on this machine (tests, a local Keycloak)
 *  crosses no wire for http to leak on. Judged on the parsed URL, never on
 *  how it starts: `http://localhost:80@evil.example` is evil.example
 *  (Codex review, 1 Nov 2026). */
export function isSecureUrl(url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.username || u.password) return false;
  if (u.protocol === "https:") return true;
  return u.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(u.hostname);
}

/** Every URL the metadata may be at, in the order to try. */
export function metadataUrls(issuer: string): string[] {
  const u = new URL(issuer);
  const pathPart = u.pathname.replace(/\/+$/, "");
  const origin = u.origin;
  const urls = [
    `${origin}/.well-known/oauth-authorization-server${pathPart}`,
    `${origin}/.well-known/openid-configuration${pathPart}`,
  ];
  if (pathPart) urls.push(`${origin}${pathPart}/.well-known/openid-configuration`);
  return [...new Set(urls)];
}

/** Why an issuer cannot be discovered from, or null. */
export function issuerProblem(issuer: string): string | null {
  let u: URL;
  try {
    u = new URL(issuer);
  } catch {
    return "issuer must be a URL, like https://login.example.com";
  }
  if (!isSecureUrl(issuer)) return "issuer must be https";
  if (u.search || u.hash) return "issuer has no query or fragment (RFC 8414 §2)";
  return null;
}

type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

/**
 * Read the authorization server's metadata. `fetcher` is how the caller
 * reaches the network (the platform's SSRF-guarded fetchPublic, the CLI's
 * fetch). Throws with every place tried when none answers.
 */
export async function fetchOAuthMetadata(issuer: string, fetcher: Fetcher): Promise<{ url: string; metadata: OAuthServerMetadata }> {
  const problem = issuerProblem(issuer);
  if (problem) throw new Error(problem);
  const tried: string[] = [];
  for (const url of metadataUrls(issuer)) {
    let res: Response;
    try {
      res = await fetcher(url, { headers: { accept: "application/json" }, redirect: "error", signal: AbortSignal.timeout(10_000) });
    } catch (err) {
      tried.push(`${url} (${err instanceof Error ? err.message : String(err)})`);
      continue;
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      tried.push(`${url} (${res.status})`);
      continue;
    }
    let doc: unknown;
    try {
      doc = await res.json();
    } catch {
      tried.push(`${url} (not JSON)`);
      continue;
    }
    if (!doc || typeof doc !== "object" || Array.isArray(doc)) {
      tried.push(`${url} (not a metadata document)`);
      continue;
    }
    const metadata = doc as OAuthServerMetadata;
    // RFC 8414 §3.3: the issuer in the document is the one asked for, or
    // the document is not used. Trailing-slash differences are not forgiven.
    if (metadata.issuer !== issuer) {
      throw new Error(`the metadata at ${url} names the issuer ${JSON.stringify(metadata.issuer ?? null)}, not ${issuer} — refused (RFC 8414 §3.3)`);
    }
    return { url, metadata };
  }
  throw new Error(`no OAuth metadata for ${issuer} — tried ${tried.join(", ")}`);
}

const ENDPOINTS = [
  "authorization_endpoint", "token_endpoint", "revocation_endpoint",
  "device_authorization_endpoint", "pushed_authorization_request_endpoint", "jwks_uri",
] as const;

/**
 * What a client config should say for this server. `hasSecret`: the app
 * has a client secret; `pkce`: false when the caller turned PKCE off;
 * `tokenAuth`: one the caller chose, which wins over the server's list.
 */
export function clientConfigFromMetadata(
  found: { url: string; metadata: OAuthServerMetadata },
  opts: { hasSecret: boolean; pkce?: boolean; tokenAuth?: TokenAuth; needsAuthorize?: boolean } = { hasSecret: true },
): DiscoveredClientConfig {
  const m = found.metadata;
  for (const k of ENDPOINTS) {
    const v = m[k];
    if (v !== undefined && (typeof v !== "string" || !isSecureUrl(v))) throw new Error(`the server's ${k} is not an https URL: ${String(v)}`);
  }
  if (!m.token_endpoint) throw new Error(`${m.issuer} publishes no token_endpoint`);
  if ((opts.needsAuthorize ?? true) && !m.authorization_endpoint) throw new Error(`${m.issuer} publishes no authorization_endpoint — it does not do browser sign-in`);
  // PKCE S256 is required of every connection (RFC 9700 §2.1.1). A server
  // that lists its methods and leaves S256 out would ignore our challenge.
  if (opts.pkce !== false && Array.isArray(m.code_challenge_methods_supported) && !m.code_challenge_methods_supported.includes("S256")) {
    throw new Error(`${m.issuer} does not support PKCE S256 (it lists ${m.code_challenge_methods_supported.join(", ") || "none"}) — refused; turn PKCE off only if you are sure (--no-pkce)`);
  }
  return {
    issuer: m.issuer,
    ...(m.authorization_endpoint ? { authorize_url: m.authorization_endpoint } : {}),
    token_url: m.token_endpoint,
    ...(m.revocation_endpoint ? { revocation_url: m.revocation_endpoint } : {}),
    ...(m.device_authorization_endpoint ? { device_url: m.device_authorization_endpoint } : {}),
    ...(m.pushed_authorization_request_endpoint ? { par_url: m.pushed_authorization_request_endpoint } : {}),
    ...(m.require_pushed_authorization_requests === true ? { par_required: true } : {}),
    iss_parameter: m.authorization_response_iss_parameter_supported === true,
    ...pickTokenAuth(m.token_endpoint_auth_methods_supported, opts),
    metadata_url: found.url,
    metadata: m,
  };
}

/**
 * The token_auth to use. A choice the caller made is kept. Otherwise, with a
 * secret: the form body when the server lists it (what every secret did
 * before), else Basic — which is also the RFC 8414 default when the server
 * lists nothing. Without a secret: none (a public client).
 */
export function pickTokenAuth(supported: unknown, opts: { hasSecret: boolean; tokenAuth?: TokenAuth }): { token_auth?: TokenAuth } {
  if (opts.tokenAuth) return { token_auth: opts.tokenAuth };
  const list = Array.isArray(supported) ? supported.filter((s): s is string => typeof s === "string") : null;
  // A public client sends no secret. Not refused when the list leaves out
  // `none`: Keycloak takes public clients and lists only secret methods,
  // so the list is not the last word on it (found by the conformance suite).
  if (!opts.hasSecret) return {};
  if (list && list.includes("client_secret_post")) return {};
  if (!list || list.includes("client_secret_basic")) return { token_auth: "client_secret_basic" };
  throw new Error(`the server takes none of the ways foldrun signs in at its token URL (it lists ${list.join(", ") || "nothing"}; foldrun sends the secret in the form body or as HTTP Basic)`);
}

/** Discover and turn into a client config in one call. */
export async function discoverOAuth(
  issuer: string,
  fetcher: Fetcher,
  opts: { hasSecret: boolean; pkce?: boolean; tokenAuth?: TokenAuth; needsAuthorize?: boolean },
): Promise<DiscoveredClientConfig> {
  return clientConfigFromMetadata(await fetchOAuthMetadata(issuer, fetcher), opts);
}
