// The OAuth consent flow: click Connect, approve in the provider's screen,
// and the refresh token lands in the vault — nobody copies tokens by hand.
//
// What stays with the account is the OAuth *client* (id + secret): that is
// unavoidable — a consent screen belongs to a registered app — so presets
// fill in every provider URL and the user brings the two values from their
// provider's console. The hosted platform can ship its own registered
// clients later by the same mechanism; nothing here is per-provider code.
//
// Shape: start() writes a pending file (0600, ten-minute TTL) holding the
// client config keyed by an unguessable nonce, and hands back the provider's
// authorize URL with that nonce as `state`. The callback trades the code for
// tokens, stores the result — an auto-refreshing oauth2 secret when the
// provider returned a refresh token, a static one when it only issues
// long-lived access tokens (GitHub) — and deletes the pending file. The
// nonce is the callback's whole authority: single-use, expiring, and bound
// to the tenant that started the flow.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { dataRoot } from "./paths.ts";
import { setSecret, setOAuth2Secret, SECRET_NAME } from "./secrets.ts";

export interface OAuthProviderConfig {
  authorize_url: string;
  token_url: string;
  client_id: string;
  client_secret: string;
  scopes: string;
  /** Extra authorize-URL params (Google: access_type=offline&prompt=consent). */
  authorize_extra?: Record<string, string>;
}

/** Prefills for the common providers — URLs and quirks, never credentials. */
export const OAUTH_PRESETS: Record<string, Partial<OAuthProviderConfig> & { hint: string }> = {
  google: {
    authorize_url: "https://accounts.google.com/o/oauth2/v2/auth",
    token_url: "https://oauth2.googleapis.com/token",
    authorize_extra: { access_type: "offline", prompt: "consent" },
    hint: "Scopes like https://www.googleapis.com/auth/adwords — offline access is requested for you.",
  },
  github: {
    authorize_url: "https://github.com/login/oauth/authorize",
    token_url: "https://github.com/login/oauth/access_token",
    hint: "GitHub issues long-lived tokens — stored as a static secret.",
  },
  microsoft: {
    authorize_url: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
    token_url: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
    hint: "Include offline_access in the scopes to receive a refresh token.",
  },
};

interface Pending {
  tenant: string;
  name: string;
  workspace?: string;
  config: OAuthProviderConfig;
  createdAt: number;
}

const TTL_MS = 10 * 60 * 1000;

const pendingDir = () => path.join(dataRoot(), ".oauth-pending");

function pendingFile(nonce: string) {
  if (!/^[a-f0-9]{48}$/.test(nonce)) throw new Error("malformed state");
  return path.join(pendingDir(), `${nonce}.json`);
}

/** Begin a consent flow. Returns where to send the browser. */
export function startOAuthConnect(
  tenant: string,
  name: string,
  config: OAuthProviderConfig,
  redirectUri: string,
  workspace?: string,
): { url: string; nonce: string } {
  if (!SECRET_NAME.test(name)) throw new Error(`secret name "${name}" must be UPPER_SNAKE_CASE`);
  for (const field of ["authorize_url", "token_url", "client_id", "client_secret"] as const) {
    if (!config[field]?.trim()) throw new Error(`oauth connect needs ${field}`);
  }
  if (!/^https:\/\//.test(config.authorize_url)) throw new Error("authorize_url must be https");

  // Sweep the stale while we're here — a pending consent someone abandoned
  // should not sit holding a client secret for longer than its ten minutes.
  if (fs.existsSync(pendingDir())) {
    for (const f of fs.readdirSync(pendingDir())) {
      try {
        const p = JSON.parse(fs.readFileSync(path.join(pendingDir(), f), "utf8")) as Pending;
        if (Date.now() - p.createdAt > TTL_MS) fs.rmSync(path.join(pendingDir(), f), { force: true });
      } catch {
        fs.rmSync(path.join(pendingDir(), f), { force: true });
      }
    }
  }

  const nonce = crypto.randomBytes(24).toString("hex");
  fs.mkdirSync(pendingDir(), { recursive: true });
  fs.writeFileSync(
    pendingFile(nonce),
    JSON.stringify({ tenant, name, workspace, config, createdAt: Date.now() } satisfies Pending),
    { mode: 0o600 },
  );

  const url = new URL(config.authorize_url);
  url.searchParams.set("client_id", config.client_id);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  if (config.scopes.trim()) url.searchParams.set("scope", config.scopes.trim());
  url.searchParams.set("state", nonce);
  for (const [k, v] of Object.entries(config.authorize_extra ?? {})) url.searchParams.set(k, v);
  return { url: url.href, nonce };
}

export interface ConnectResult {
  tenant: string;
  name: string;
  workspace?: string;
  /** How it was stored: auto-refreshing, or static (no refresh token issued). */
  stored: "oauth2" | "static";
}

/** The callback: trade the code for tokens and store the secret. */
export async function completeOAuthConnect(
  nonce: string,
  code: string,
  redirectUri: string,
): Promise<ConnectResult> {
  const file = pendingFile(nonce);
  if (!fs.existsSync(file)) throw new Error("this connect link expired or was already used — start again");
  const pending = JSON.parse(fs.readFileSync(file, "utf8")) as Pending;
  fs.rmSync(file, { force: true }); // single-use, before any network
  if (Date.now() - pending.createdAt > TTL_MS) {
    throw new Error("this connect link expired — start again");
  }

  const res = await fetch(pending.config.token_url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: pending.config.client_id,
      client_secret: pending.config.client_secret,
    }).toString(),
    signal: AbortSignal.timeout(15_000),
  });
  const payload = (await res.json().catch(() => ({}))) as {
    access_token?: string;
    refresh_token?: string;
    error?: string;
    error_description?: string;
  };
  if (!res.ok || (!payload.refresh_token && !payload.access_token)) {
    throw new Error(
      `the provider refused the exchange (${res.status}): ${payload.error_description ?? payload.error ?? "no tokens in the reply"}`,
    );
  }

  if (payload.refresh_token) {
    setOAuth2Secret(
      pending.tenant,
      pending.name,
      {
        token_url: pending.config.token_url,
        client_id: pending.config.client_id,
        client_secret: pending.config.client_secret,
        refresh_token: payload.refresh_token,
      },
      pending.workspace,
    );
    return { tenant: pending.tenant, name: pending.name, workspace: pending.workspace, stored: "oauth2" };
  }

  // No refresh token — a provider whose access tokens live long (GitHub).
  // A static secret is the honest representation of that.
  setSecret(pending.tenant, pending.name, payload.access_token!, pending.workspace);
  return { tenant: pending.tenant, name: pending.name, workspace: pending.workspace, stored: "static" };
}
