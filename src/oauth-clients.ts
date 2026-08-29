// Saved OAuth clients — the user's own registered apps, as first-class
// things. The platform supplies none: every record here began as someone
// pasting the client id and secret from their provider's console. Once
// saved, a client can run the consent flow any number of times — first
// connect, re-consent after a revocation, a second secret with different
// scopes — which is the whole reason it is worth saving.
//
//   data/<tenant>/oauth-clients.json    client_secret encrypted, 0600

import fs from "node:fs";
import path from "node:path";
import { accountDir } from "./store.ts";
import { encryptValue, decryptValue } from "./secrets.ts";
import type { OAuthProviderConfig } from "./oauth-connect.ts";

export interface OAuthClientRecord {
  name: string; // kebab-case identity, e.g. "google-ads"
  authorize_url: string;
  token_url: string;
  client_id: string;
  client_secret: { iv: string; tag: string; data: string };
  scopes: string;
  authorize_extra?: Record<string, string>;
  createdAt: string;
}

const CLIENT_NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;

function file(tenant: string) {
  return path.join(accountDir(tenant), "oauth-clients.json");
}

function read(tenant: string): Record<string, OAuthClientRecord> {
  const f = file(tenant);
  if (!fs.existsSync(f)) return {};
  try {
    return JSON.parse(fs.readFileSync(f, "utf8"));
  } catch {
    return {};
  }
}

function write(tenant: string, all: Record<string, OAuthClientRecord>) {
  fs.mkdirSync(path.dirname(file(tenant)), { recursive: true });
  fs.writeFileSync(file(tenant), JSON.stringify(all, null, 2), { mode: 0o600 });
}

export function saveOAuthClient(
  tenant: string,
  name: string,
  config: OAuthProviderConfig,
): void {
  if (!CLIENT_NAME.test(name)) throw new Error(`client name "${name}" — kebab-case only`);
  for (const field of ["authorize_url", "token_url", "client_id", "client_secret"] as const) {
    if (!config[field]?.trim()) throw new Error(`an OAuth client needs ${field}`);
  }
  if (!/^https:\/\//.test(config.authorize_url)) throw new Error("authorize_url must be https");
  const all = read(tenant);
  all[name] = {
    name,
    authorize_url: config.authorize_url,
    token_url: config.token_url,
    client_id: config.client_id,
    client_secret: encryptValue(tenant, config.client_secret),
    scopes: config.scopes ?? "",
    ...(config.authorize_extra ? { authorize_extra: config.authorize_extra } : {}),
    createdAt: new Date().toISOString(),
  };
  write(tenant, all);
}

/** Metadata only — the client_secret never comes back out through a list. */
export function listOAuthClients(
  tenant: string,
): Omit<OAuthClientRecord, "client_secret">[] {
  return Object.values(read(tenant))
    .map(({ client_secret: _secret, ...rest }) => rest)
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** The full config, decrypted — for starting a consent flow, nothing else. */
export function getOAuthClient(tenant: string, name: string): OAuthProviderConfig | null {
  const rec = read(tenant)[name];
  if (!rec) return null;
  const secret = decryptValue(tenant, rec.client_secret);
  if (secret === null) return null; // key rotated away from under it
  return {
    authorize_url: rec.authorize_url,
    token_url: rec.token_url,
    client_id: rec.client_id,
    client_secret: secret,
    scopes: rec.scopes,
    authorize_extra: rec.authorize_extra,
  };
}

export function deleteOAuthClient(tenant: string, name: string): boolean {
  const all = read(tenant);
  if (!all[name]) return false;
  delete all[name];
  write(tenant, all);
  return true;
}
