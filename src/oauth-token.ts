// Every request to an OAuth token endpoint, and every answer read from one,
// goes through here: core's refresh (refresh_token, client_credentials), the
// platform's code exchange after a consent, and the CLI's own loopback
// connect. Three hand-written bodies had already drifted — none could send
// the client secret any way but in the form body, which is the one way RFC
// 6749 §2.3.1 lets a server refuse (Notion, Spotify, Reddit, Zoom do).
//
// How the client proves itself at the token endpoint (`token_auth`):
//   client_secret_post   id and secret in the form body (the default — what
//                        every stored secret did before 1 Nov 2026)
//   client_secret_basic  HTTP Basic, the id and secret each form-urlencoded
//                        first (RFC 6749 §2.3.1, Appendix B) — not plain
//                        base64 of the raw pair, which breaks on a secret
//                        holding ':' or '%'
//   none                 a public client: client_id in the body, no secret
//
// Absent means the old behaviour: the body, with the secret if there is one.

export const TOKEN_AUTH_METHODS = ["client_secret_post", "client_secret_basic", "none"] as const;
export type TokenAuth = (typeof TOKEN_AUTH_METHODS)[number];

/** The short spellings a person types (`--token-auth basic`), to the RFC names. */
export function parseTokenAuth(value: string): TokenAuth | null {
  const v = value.trim().toLowerCase();
  if ((TOKEN_AUTH_METHODS as readonly string[]).includes(v)) return v as TokenAuth;
  if (v === "post" || v === "body") return "client_secret_post";
  if (v === "basic") return "client_secret_basic";
  return null;
}

export interface TokenClient {
  client_id: string;
  client_secret?: string;
  token_auth?: TokenAuth;
}

/** Why a client's token_auth cannot work, or null. */
export function tokenAuthProblem(client: { client_secret?: string; token_auth?: unknown }): string | null {
  const auth = client.token_auth;
  if (auth === undefined) return null;
  if (typeof auth !== "string" || !(TOKEN_AUTH_METHODS as readonly string[]).includes(auth)) {
    return `token_auth must be one of ${TOKEN_AUTH_METHODS.join(", ")}`;
  }
  const hasSecret = !!client.client_secret?.trim();
  if (auth === "client_secret_basic" && !hasSecret) return "token_auth client_secret_basic needs a client_secret";
  if (auth === "client_secret_post" && !hasSecret) return "token_auth client_secret_post needs a client_secret — a public app is token_auth none";
  if (auth === "none" && hasSecret) return "token_auth none is a public client — it sends no client_secret; leave the secret empty or pick client_secret_post or client_secret_basic";
  return null;
}

/** The form-urlencoding RFC 6749 Appendix B asks for: space as '+'. */
const formEncode = (s: string) => new URLSearchParams({ x: s }).toString().slice(2);

/**
 * The headers and body of one token request. `params` is the grant's own
 * fields (grant_type, code, refresh_token, …); the client's identity is
 * added here, by its token_auth. Fields in `params` named client_id or
 * client_secret are dropped — the method decides those, never an `extra`.
 */
export function oauthTokenRequest(client: TokenClient, params: Record<string, string>): { headers: Record<string, string>; body: string } {
  const problem = tokenAuthProblem(client);
  if (problem) throw new Error(problem);
  const form = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (k === "client_id" || k === "client_secret") continue;
    form.set(k, v);
  }
  const headers: Record<string, string> = {
    "content-type": "application/x-www-form-urlencoded",
    // GitHub answers form-encoded unless asked; every server may answer JSON.
    accept: "application/json",
  };
  const auth = client.token_auth ?? (client.client_secret ? "client_secret_post" : "none");
  if (auth === "client_secret_basic") {
    // One method per request (RFC 6749 §2.3): the id travels in the header,
    // not the body as well.
    const pair = `${formEncode(client.client_id)}:${formEncode(client.client_secret!)}`;
    headers.authorization = `Basic ${Buffer.from(pair, "utf8").toString("base64")}`;
  } else {
    form.set("client_id", client.client_id);
    if (auth === "client_secret_post") form.set("client_secret", client.client_secret!);
  }
  return { headers, body: form.toString() };
}

/** A token endpoint's answer, read the ways providers actually write it. */
export interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  /** Seconds; a string "3600" (some providers) is read as the number. */
  expires_in?: number;
  refresh_token_expires_in?: number;
  token_type?: string;
  scope?: string;
  error?: string;
  error_description?: string;
  /** The other plain fields beside the token — Salesforce's instance_url,
   *  Slack's team — kept for the caller; never a token. */
  fields: Record<string, string>;
}

/** Fields that are credentials or are read into their own slot above. */
const NOT_FIELDS = new Set([
  "access_token", "refresh_token", "id_token", "expires_in", "refresh_token_expires_in",
  "error", "error_description", "error_uri", "authed_user", "ok",
]);

function seconds(v: unknown): number | undefined {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v !== "" ? v : undefined;
}

/**
 * Read a token endpoint's body: JSON, or form-encoded (GitHub without an
 * Accept header, some older servers), whatever the content type claims.
 * Slack's user-token install nests the token under `authed_user` and says
 * `ok: false` with a 200 when it refuses; both are read here.
 */
export function readTokenResponse(text: string, contentType = ""): TokenResponse {
  let raw: Record<string, unknown> = {};
  const trimmed = text.trim();
  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) raw = parsed as Record<string, unknown>;
    } catch {
      raw = {};
    }
  } else if (trimmed && (/x-www-form-urlencoded|text\/plain/i.test(contentType) || /^[\w.-]+=/.test(trimmed))) {
    raw = Object.fromEntries(new URLSearchParams(trimmed));
  }

  // Slack: a user token alone comes back under authed_user, with its own
  // refresh token and expiry when rotation is on. The top-level token (a bot
  // token) wins when there is one.
  let source: Record<string, unknown> = raw;
  const nested = raw.authed_user;
  if (!str(raw.access_token) && nested && typeof nested === "object" && str((nested as Record<string, unknown>).access_token)) {
    source = nested as Record<string, unknown>;
  }

  const fields: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (NOT_FIELDS.has(k)) continue;
    if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") fields[k] = String(v);
  }
  // From the nested object: its scope and type describe the token we took.
  const scope = str(source.scope) ?? str(raw.scope);
  const tokenType = str(source.token_type) ?? str(raw.token_type);

  const out: TokenResponse = { fields };
  const access = str(source.access_token);
  const refresh = str(source.refresh_token);
  const expires = seconds(source.expires_in);
  const refreshExpires = seconds(source.refresh_token_expires_in);
  if (access) out.access_token = access;
  if (refresh) out.refresh_token = refresh;
  if (expires !== undefined) out.expires_in = expires;
  if (refreshExpires !== undefined) out.refresh_token_expires_in = refreshExpires;
  if (tokenType) out.token_type = tokenType;
  if (scope) out.scope = scope;
  const error = str(raw.error) ?? (raw.ok === false ? "refused" : undefined);
  if (error) {
    out.error = error;
    // A refusal carries no token, whatever else the body held.
    delete out.access_token;
    delete out.refresh_token;
  }
  const description = str(raw.error_description);
  if (description) out.error_description = description;
  return out;
}
