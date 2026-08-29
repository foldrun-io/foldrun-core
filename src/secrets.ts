// Secret store. Values are encrypted at rest with AES-256-GCM using a key
// derived from FOLDRUN_SECRET_KEY (falling back to a generated per-install
// key file, so dev works without configuration).
//
// Two scopes, nearest wins — the same rule knowledge uses:
//
//   data/<account>/secrets.json                     account: credentials
//                                                   genuinely shared by every
//                                                   workspace, rotated once
//   data/<account>/workspaces/<workspace>/secrets.json  workspace: the default.
//                                                   ads-desk's ad token is not
//                                                   newsroom's to read
//
// There is deliberately no agent scope. A credential buried in one agent's
// folder can't be rotated or audited, and per-agent *grant* already exists:
// an agent only receives what it names in `secrets:`. Definition is shared,
// grant is per-agent — the same split tools use.
//
// Secrets are injected as environment variables into the agent's tools at run
// time and are never returned by the API.

import fs from "node:fs";
import path from "node:path";
import { dataRoot } from "./paths.ts";
import { tenantKey } from "./tenant-keys.ts";
import crypto from "node:crypto";
import { assertSafeName } from "./store.ts";

const keyFile = () => path.join(dataRoot(), ".secret-key");

/** Which store a secret came from. */
export type SecretScope = "account" | "workspace";

function masterKey(): Buffer {
  const fromEnv = process.env.FOLDRUN_SECRET_KEY;
  if (fromEnv) return crypto.createHash("sha256").update(fromEnv).digest();
  fs.mkdirSync(dataRoot(), { recursive: true });
  if (!fs.existsSync(keyFile())) {
    fs.writeFileSync(keyFile(), crypto.randomBytes(32).toString("hex"), { mode: 0o600 });
  }
  return crypto.createHash("sha256").update(fs.readFileSync(keyFile(), "utf8")).digest();
}

// `workspace` undefined means the account store.
function secretsFile(tenant: string, workspace?: string) {
  assertSafeName(tenant, "tenant");
  if (!workspace) return path.join(dataRoot(), tenant, "secrets.json");
  assertSafeName(workspace, "workspace");
  // Follow the workspace wherever it lives — see WORKSPACES in store.ts.
  const legacy = path.join(dataRoot(), tenant, "projects", workspace);
  const base = fs.existsSync(legacy) ? legacy : path.join(dataRoot(), tenant, "workspaces", workspace);
  return path.join(base, "secrets.json");
}

/** How the stored value is used at run time — "oauth2"/"service-account"
 *  are refreshed into live tokens, "file"/"ssh"/"api" are materialised into
 *  the run's scratch. Plain values have no kind. */
export type SecretKind = "oauth2" | "service-account" | "file" | "ssh" | "api";

interface StoredSecret {
  iv: string;
  tag: string;
  data: string;
  updatedAt: string;
  kind?: SecretKind;
  /** Which key opens this. Absent means the install key, which is what every
   *  record written before per-account keys existed is encrypted with — so an
   *  old vault stays readable without a migration having to run first. */
  k?: "tenant";
}

type SecretsFile = Record<string, StoredSecret>;

function read(tenant: string, workspace?: string): SecretsFile {
  const f = secretsFile(tenant, workspace);
  if (!fs.existsSync(f)) return {};
  try {
    return JSON.parse(fs.readFileSync(f, "utf8"));
  } catch {
    return {};
  }
}

function write(tenant: string, workspace: string | undefined, data: SecretsFile) {
  const f = secretsFile(tenant, workspace);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify(data, null, 2), { mode: 0o600 });
}

export const SECRET_NAME = /^[A-Z][A-Z0-9_]{1,63}$/;

export function setSecret(
  tenant: string,
  name: string,
  value: string,
  workspace?: string,
  kind?: SecretKind,
) {
  if (!SECRET_NAME.test(name)) {
    throw new Error(`secret name "${name}" must be UPPER_SNAKE_CASE`);
  }
  if (value.length > 8192) throw new Error("secret too long");
  const sealed = encryptValue(tenant, value);
  const all = read(tenant, workspace);
  all[name] = {
    ...sealed,
    updatedAt: new Date().toISOString(),
    ...(kind ? { kind } : {}),
  };
  write(tenant, workspace, all);
}

/**
 * Which key writes this account's records.
 *
 * The account's own where there is one, the install key otherwise — a laptop,
 * a self-hoster with no database, or an account whose key has not been minted.
 * Returned with the marker to store beside it, so the reader never has to
 * guess which key a record was written with.
 */
function keyFor(tenant: string): { key: Buffer; mark: "tenant" | undefined } {
  const own = tenantKey(tenant);
  return own ? { key: own, mark: "tenant" } : { key: masterKey(), mark: undefined };
}

/** Encrypt one value for an account — the same envelope secrets use, exported
 *  so sibling stores (OAuth clients) don't invent a second crypto path. */
export function encryptValue(
  tenant: string,
  value: string,
): { iv: string; tag: string; data: string; k?: "tenant" } {
  const { key, mark } = keyFor(tenant);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return {
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    data: enc.toString("base64"),
    ...(mark ? { k: mark } : {}),
  };
}

export function decryptValue(
  tenant: string,
  rec: { iv: string; tag: string; data: string; k?: "tenant" } | undefined,
): string | null {
  return decrypt(tenant, rec as StoredSecret | undefined);
}

function decrypt(tenant: string, rec: StoredSecret | undefined): string | null {
  if (!rec) return null;
  try {
    // The record says which key wrote it. An unmarked one predates per-account
    // keys and is under the install key; guessing either way would turn a
    // readable vault into an unreadable one on the first upgrade.
    let key: Buffer;
    if (rec.k === "tenant") {
      const own = tenantKey(tenant);
      if (!own) {
        // Say so. Without this the read returns null and the caller reports
        // "no such secret" — a process that forgot to load the account keys
        // would look exactly like an account that never set one, which is the
        // most expensive kind of wrong answer to debug.
        console.error(
          `[secrets] ${tenant} has account-keyed secrets but no key is loaded — ` +
            `call loadTenantKeys() before reading, or the value will read as absent`,
        );
        return null;
      }
      key = own;
    } else {
      key = masterKey();
    }
    const decipher = crypto.createDecipheriv(
      "aes-256-gcm",
      key,
      Buffer.from(rec.iv, "base64"),
    );
    decipher.setAuthTag(Buffer.from(rec.tag, "base64"));
    return Buffer.concat([
      decipher.update(Buffer.from(rec.data, "base64")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    return null; // key rotated or file tampered with
  }
}

/** Nearest wins: a workspace secret shadows an account one of the same name. */
export function getSecret(
  tenant: string,
  name: string,
  workspace?: string,
): { value: string; scope: SecretScope } | null {
  if (workspace) {
    const own = decrypt(tenant, read(tenant, workspace)[name]);
    if (own !== null) return { value: own, scope: "workspace" };
  }
  const shared = decrypt(tenant, read(tenant)[name]);
  return shared === null ? null : { value: shared, scope: "account" };
}

export function deleteSecret(tenant: string, name: string, workspace?: string) {
  const all = read(tenant, workspace);
  delete all[name];
  write(tenant, workspace, all);
}

export interface SecretEntry {
  name: string;
  updatedAt: string;
  scope: SecretScope;
  /** An account secret this workspace overrides — worth showing, not hiding. */
  shadowed?: boolean;
  /** How this credential works: auto-refreshing oauth2, a signed service
   *  account, a file/ssh/api materialised into runs — absent for static values. */
  kind?: SecretKind;
}

// Metadata only — never values. Without a workspace this lists the account
// store; with one it lists what that workspace actually resolves, marking
// which scope each name comes from.
export function listSecrets(tenant: string, workspace?: string): SecretEntry[] {
  const account = Object.entries(read(tenant)).map(([name, rec]) => ({
    name,
    updatedAt: rec.updatedAt,
    scope: "account" as const,
    ...(rec.kind ? { kind: rec.kind } : {}),
  }));
  if (!workspace) return account.sort((a, b) => a.name.localeCompare(b.name));

  const own = Object.entries(read(tenant, workspace)).map(([name, rec]) => ({
    name,
    updatedAt: rec.updatedAt,
    scope: "workspace" as const,
    shadowed: account.some((a) => a.name === name),
    ...(rec.kind ? { kind: rec.kind } : {}),
  }));
  const ownNames = new Set(own.map((s) => s.name));
  return [...own, ...account.filter((a) => !ownNames.has(a.name))].sort((a, b) =>
    a.name.localeCompare(b.name),
  );
}

// Resolve the secrets an agent declared into an env map for its tools.
// `from` records where each one came from, so a workspace silently falling
// back to an account credential is visible in the run trace instead of assumed.
export function resolveSecrets(tenant: string, names: string[], workspace?: string) {
  const env: Record<string, string> = {};
  const from: Record<string, SecretScope> = {};
  const missing: string[] = [];
  for (const name of names) {
    const hit = getSecret(tenant, name, workspace);
    if (hit === null) missing.push(name);
    else {
      env[name] = hit.value;
      from[name] = hit.scope;
    }
  }
  return { env, from, missing };
}

// ---------------------------------------------------------------- rotation

/**
 * Where the master key came from.
 *
 * The key and the ciphertext it protects live on the same disk by default, so
 * one filesystem read gets both. `FOLDRUN_SECRET_KEY` fixes that — a managed
 * secret store holds the key, the disk holds only the encrypted values — and
 * this reports which of the two is in force so the platform can say so rather
 * than leaving it to be discovered.
 */
export function masterKeySource(): { source: "env" | "file"; path: string | null } {
  return process.env.FOLDRUN_SECRET_KEY
    ? { source: "env", path: null }
    : { source: "file", path: keyFile() };
}

/** Every secrets.json under an account: the account's, then each workspace's. */
function secretFiles(tenant: string): { file: string; workspace?: string }[] {
  const out: { file: string; workspace?: string }[] = [{ file: secretsFile(tenant) }];
  for (const dirName of ["workspaces", "projects"]) {
    const dir = path.join(dataRoot(), tenant, dirName);
    if (!fs.existsSync(dir)) continue;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const f = path.join(dir, entry.name, "secrets.json");
      if (fs.existsSync(f)) out.push({ file: f, workspace: entry.name });
    }
  }
  return out;
}

export interface RotationResult {
  /** Files rewritten, and how many values each held. */
  rewritten: { file: string; secrets: number }[];
  /** Names that could not be read with `from` — left untouched, never dropped. */
  unreadable: string[];
}

/**
 * Re-encrypt every secret in an account from one master key to another.
 *
 * Without this, moving the key into a secret manager is unsafe: change the key
 * and every stored value fails to decrypt, which the platform reports as a
 * *missing* secret. You would not lose the ciphertext, but you would lose the
 * ability to read it, and the error would tell you the secret was never set.
 *
 * Both keys are passed in raw, exactly as FOLDRUN_SECRET_KEY would be, and
 * hashed here the same way masterKey does — so the caller never has to know
 * how a key becomes an AES key.
 *
 * A value that will not decrypt with `from` is reported and left exactly as it
 * is. Half-rotating is bad; silently discarding is worse.
 */
export function rotateMasterKey(
  tenant: string,
  from: string,
  to: string,
): RotationResult {
  assertSafeName(tenant, "tenant");
  const oldKey = crypto.createHash("sha256").update(from).digest();
  const newKey = crypto.createHash("sha256").update(to).digest();

  const rewritten: RotationResult["rewritten"] = [];
  const unreadable: string[] = [];

  for (const { file } of secretFiles(tenant)) {
    const all: SecretsFile = JSON.parse(fs.readFileSync(file, "utf8"));
    const next: SecretsFile = {};
    let count = 0;

    for (const [name, rec] of Object.entries(all)) {
      // A record under the ACCOUNT's key is not under the install key, so
      // rotating the install key must not touch it — re-encrypting it here
      // with a key it was never sealed with is how a rotation would destroy a
      // vault it was meant to protect. Rotating the install key now re-wraps
      // the account keys instead, which is a handful of small values rather
      // than every secret on the box.
      if (rec.k === "tenant") {
        next[name] = rec;
        continue;
      }
      let plain: string;
      try {
        const d = crypto.createDecipheriv("aes-256-gcm", oldKey, Buffer.from(rec.iv, "base64"));
        d.setAuthTag(Buffer.from(rec.tag, "base64"));
        plain = Buffer.concat([d.update(Buffer.from(rec.data, "base64")), d.final()]).toString("utf8");
      } catch {
        unreadable.push(name);
        next[name] = rec; // untouched
        continue;
      }
      const iv = crypto.randomBytes(12);
      const c = crypto.createCipheriv("aes-256-gcm", newKey, iv);
      const enc = Buffer.concat([c.update(plain, "utf8"), c.final()]);
      next[name] = {
        iv: iv.toString("base64"),
        tag: c.getAuthTag().toString("base64"),
        data: enc.toString("base64"),
        updatedAt: rec.updatedAt, // rotation is not an edit
      };
      count++;
    }

    // Write via a temp file in the same directory: a half-written secrets.json
    // is an account that cannot authenticate anything.
    const tmp = `${file}.rotating`;
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, file);
    rewritten.push({ file, secrets: count });
  }

  return { rewritten, unreadable };
}

// ---------------------------------------------------------------- oauth2

// Auto-refreshing credentials. A static value covers most APIs; the Google
// family (Ads, Search Console, Drive, …) hands out a long-lived refresh
// token that must be exchanged for a short-lived access token before every
// use. An oauth2 secret stores the exchange recipe, encrypted like any
// value; what an agent ever sees is the fresh access token, materialised at
// the last host-side moment before injection. The refresh credentials
// themselves never cross into a run.

export interface OAuth2Config {
  token_url: string;
  client_id: string;
  client_secret: string;
  /** Required for the refresh grant; absent for client_credentials. */
  refresh_token?: string;
  /** "refresh_token" (default — user-consented) or "client_credentials"
   *  (machine-to-machine: no user, no refresh token, re-exchanged on
   *  expiry). One machinery, two grants. */
  grant_type?: "refresh_token" | "client_credentials";
  /** Extra form fields some providers want (audience, scope, …). */
  extra?: Record<string, string>;
}

const OAUTH2_PREFIX = "@oauth2 ";

export function setOAuth2Secret(
  tenant: string,
  name: string,
  config: OAuth2Config,
  workspace?: string,
) {
  for (const field of ["token_url", "client_id", "client_secret"] as const) {
    if (!config[field]?.trim()) throw new Error(`oauth2 secret needs ${field}`);
  }
  if (config.grant_type !== "client_credentials" && !config.refresh_token?.trim()) {
    throw new Error("oauth2 secret needs refresh_token (or grant_type: client_credentials)");
  }
  // Loopback is exempt: a token endpoint on this same machine (tests, a
  // local mock, a sidecar) crosses no wire for http to leak on.
  if (!/^https:\/\//.test(config.token_url) && !/^http:\/\/(127\.0\.0\.1|localhost)[:/]/.test(config.token_url)) {
    throw new Error("token_url must be https — a refresh token over http is a leaked one");
  }
  setSecret(tenant, name, OAUTH2_PREFIX + JSON.stringify(config), workspace, "oauth2");
}

export function isOAuth2Value(value: string): boolean {
  return value.startsWith(OAUTH2_PREFIX);
}

// Fresh tokens are cached until shortly before expiry, and concurrent
// requests for the same secret share one exchange — a fan-out of twenty
// steps must not hit Google twenty times in one second.
const tokenCache = new Map<string, { token: string; expiresAt: number }>();
const inFlight = new Map<string, Promise<string>>();

async function exchange(config: OAuth2Config, cacheKey: string): Promise<string> {
  const cached = tokenCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.token;

  const pending = inFlight.get(cacheKey);
  if (pending) return pending;

  const flight = (async () => {
    const body = new URLSearchParams({
      grant_type: config.grant_type ?? "refresh_token",
      ...(config.grant_type === "client_credentials" ? {} : { refresh_token: config.refresh_token! }),
      client_id: config.client_id,
      client_secret: config.client_secret,
      ...(config.extra ?? {}),
    });
    const res = await fetch(config.token_url, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: body.toString(),
      signal: AbortSignal.timeout(15_000),
    });
    const payload = (await res.json().catch(() => ({}))) as {
      access_token?: string;
      expires_in?: number;
      error?: string;
      error_description?: string;
    };
    if (!res.ok || !payload.access_token) {
      throw new Error(
        `token refresh failed (${res.status}): ${payload.error_description ?? payload.error ?? "no access_token in the reply"}`,
      );
    }
    const ttl = Math.max(60, (payload.expires_in ?? 3600) - 60) * 1000;
    tokenCache.set(cacheKey, { token: payload.access_token, expiresAt: Date.now() + ttl });
    return payload.access_token;
  })();

  inFlight.set(cacheKey, flight);
  try {
    return await flight;
  } finally {
    inFlight.delete(cacheKey);
  }
}

/**
 * Swap every oauth2 recipe in an env map for a live access token. The one
 * async moment in secret resolution, kept out of the sync paths: callers
 * materialise right before values are injected or substituted. A failed
 * refresh throws with the secret's name and the provider's reason — a run
 * should fail saying "GOOGLE_ADS_TOKEN: invalid_grant", not 401 somewhere.
 */
export async function materializeSecrets(
  env: Record<string, string>,
): Promise<Record<string, string>> {
  const out: Record<string, string> = { ...env };
  for (const [name, value] of Object.entries(env)) {
    if (typeof value !== "string") continue;
    if (isOAuth2Value(value)) {
      let config: OAuth2Config;
      try {
        config = JSON.parse(value.slice(OAUTH2_PREFIX.length));
      } catch {
        throw new Error(`secret ${name}: stored oauth2 config is unreadable`);
      }
      try {
        out[name] = await exchange(config, `${name}:${config.client_id}:${(config.refresh_token ?? config.grant_type ?? "").slice(0, 8)}`);
      } catch (err) {
        throw new Error(`secret ${name}: ${err instanceof Error ? err.message : String(err)}`);
      }
    } else if (value.startsWith(SERVICE_ACCOUNT_PREFIX)) {
      let config: ServiceAccountConfig;
      try {
        config = JSON.parse(value.slice(SERVICE_ACCOUNT_PREFIX.length));
      } catch {
        throw new Error(`secret ${name}: stored service account config is unreadable`);
      }
      try {
        out[name] = await exchangeServiceAccount(config, `sa:${name}:${config.issuer}`);
      } catch (err) {
        throw new Error(`secret ${name}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    // @file/@ssh/@api values are left as-is here; the run layer materialises
    // them (paths, wrapper scripts), because only it knows the sandbox's
    // writable scratch.
  }
  return out;
}

// ---------------------------------------------------------------- service account

// Signed-key credentials: a Google service account, or anything that mints a
// token by self-signing a JWT with a private key and exchanging it. No user,
// no browser, no refresh token — the key IS the identity. Better than the
// consent flow for server-side access: no consent to expire, IAM per service.
//
// Stored as the JSON key, encrypted. Materialised the same way oauth2 is: a
// live access token appears at the last host-side moment, cached until expiry.

const SERVICE_ACCOUNT_PREFIX = "@service-account ";

export interface ServiceAccountConfig {
  token_url: string; // where the signed JWT is exchanged
  issuer: string; // JWT iss/sub — the service account's email
  private_key: string; // PEM
  scope: string; // space-separated
  /** JWT audience — usually the same as token_url. */
  audience?: string;
}

export function setServiceAccountSecret(
  tenant: string,
  name: string,
  config: ServiceAccountConfig,
  workspace?: string,
) {
  for (const field of ["token_url", "issuer", "private_key", "scope"] as const) {
    if (!config[field]?.trim()) throw new Error(`service account secret needs ${field}`);
  }
  if (!/BEGIN [A-Z ]*PRIVATE KEY/.test(config.private_key)) {
    throw new Error("private_key must be a PEM key (from the service account JSON)");
  }
  setSecret(tenant, name, SERVICE_ACCOUNT_PREFIX + JSON.stringify(config), workspace, "service-account");
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function exchangeServiceAccount(config: ServiceAccountConfig, cacheKey: string): Promise<string> {
  const cached = tokenCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.token;
  const pending = inFlight.get(cacheKey);
  if (pending) return pending;

  const flight = (async () => {
    const now = Math.floor(Date.now() / 1000);
    const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
    const claim = base64url(
      JSON.stringify({
        iss: config.issuer,
        sub: config.issuer,
        scope: config.scope,
        aud: config.audience ?? config.token_url,
        iat: now,
        exp: now + 3600,
      }),
    );
    const signer = crypto.createSign("RSA-SHA256");
    signer.update(`${header}.${claim}`);
    const signature = base64url(signer.sign(config.private_key));
    const jwt = `${header}.${claim}.${signature}`;

    const res = await fetch(config.token_url, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion: jwt,
      }).toString(),
      signal: AbortSignal.timeout(15_000),
    });
    const payload = (await res.json().catch(() => ({}))) as {
      access_token?: string;
      expires_in?: number;
      error?: string;
      error_description?: string;
    };
    if (!res.ok || !payload.access_token) {
      throw new Error(
        `service account exchange failed (${res.status}): ${payload.error_description ?? payload.error ?? "no access_token"}`,
      );
    }
    const ttl = Math.max(60, (payload.expires_in ?? 3600) - 60) * 1000;
    tokenCache.set(cacheKey, { token: payload.access_token, expiresAt: Date.now() + ttl });
    return payload.access_token;
  })();

  inFlight.set(cacheKey, flight);
  try {
    return await flight;
  } finally {
    inFlight.delete(cacheKey);
  }
}

// ---------------------------------------------------------------- file secrets

// Some credentials are files, not strings: an SSH private key ssh insists on
// reading at 0600, a client certificate + key for mTLS. The value is stored
// like any secret; what differs is delivery — the run materialises it to a
// path and the agent's env var holds the *path*, not the bytes. The
// materialising happens in the sandbox layer (run-container/host), which is
// the only place that knows where a run's writable scratch is; here we only
// mark the kind and carry the content.

const FILE_PREFIX = "@file ";

export function setFileSecret(tenant: string, name: string, content: string, workspace?: string) {
  if (!content) throw new Error("a file secret needs content");
  setSecret(tenant, name, FILE_PREFIX + content, workspace, "file");
}

export function isFileValue(value: string): boolean {
  return value.startsWith(FILE_PREFIX);
}

export function fileContent(value: string): string {
  return value.slice(FILE_PREFIX.length);
}

// ---------------------------------------------------------------- ssh

// A whole SSH destination, stored as one connection: host, port, user, and
// either a private key or a password. The user describes the connection the
// way the service handed it to them; how it is plumbed (key files, sshpass,
// ssh flags) is the platform's business — the run layer materialises the
// config into an executable wrapper, so the agent runs `"$NAME" 'uptime'`
// and never learns which auth flavour it is.

const SSH_PREFIX = "@ssh ";

export interface SshConfig {
  host: string;
  port?: number;
  user: string;
  /** Exactly one of these two. */
  private_key?: string;
  password?: string;
}

export function setSshSecret(tenant: string, name: string, config: SshConfig, workspace?: string) {
  const host = config.host?.trim();
  const user = config.user?.trim();
  if (!host || /[\s'"`$\\]/.test(host)) throw new Error("ssh secret needs a host (no spaces or quotes)");
  if (!user || /[\s'"`$\\]/.test(user)) throw new Error("ssh secret needs a username (no spaces or quotes)");
  const port = config.port ?? 22;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("ssh port must be 1-65535");
  const hasKey = Boolean(config.private_key?.trim());
  const hasPassword = Boolean(config.password);
  if (hasKey === hasPassword) throw new Error("ssh secret needs a private key or a password (not both)");
  if (hasKey && !/BEGIN [A-Z ]*PRIVATE KEY/.test(config.private_key!)) {
    throw new Error("private_key must be a PEM/OpenSSH private key");
  }
  if (hasPassword && /[\n\r]/.test(config.password!)) throw new Error("ssh password cannot contain newlines");
  const stored: SshConfig = {
    host, user, port,
    ...(hasKey ? { private_key: config.private_key } : { password: config.password }),
  };
  setSecret(tenant, name, SSH_PREFIX + JSON.stringify(stored), workspace, "ssh");
}

export function isSshValue(value: string): boolean {
  return value.startsWith(SSH_PREFIX);
}

export function sshConfigOf(value: string): SshConfig {
  return JSON.parse(value.slice(SSH_PREFIX.length));
}

// ---------------------------------------------------------------- api

// An HTTP API credential that is more than one bare token: a base URL plus
// the headers the service wants (Cloudflare's X-Auth-Email + X-Auth-Key,
// Stripe's Authorization + Stripe-Version, ...). Materialised as a curl
// wrapper with the headers baked in — `"$NAME" /v1/charges` — so the secret
// never appears in the bash command at all.

const API_PREFIX = "@api ";

export interface ApiConfig {
  base_url?: string;
  headers: Record<string, string>;
}

export function setApiSecret(tenant: string, name: string, config: ApiConfig, workspace?: string) {
  const headers = Object.entries(config.headers ?? {});
  if (headers.length === 0) throw new Error("api secret needs at least one header");
  for (const [h, v] of headers) {
    if (!/^[A-Za-z0-9-]+$/.test(h)) throw new Error(`"${h}" is not a valid header name`);
    if (/[\n\r]/.test(v)) throw new Error(`header ${h} cannot contain newlines`);
  }
  const base = config.base_url?.trim();
  if (base && !/^https?:\/\//.test(base)) throw new Error("base_url must be http(s)");
  setSecret(
    tenant, name,
    API_PREFIX + JSON.stringify({ ...(base ? { base_url: base.replace(/\/+$/, "") } : {}), headers: config.headers }),
    workspace, "api",
  );
}

export function isApiValue(value: string): boolean {
  return value.startsWith(API_PREFIX);
}

export function apiConfigOf(value: string): ApiConfig {
  return JSON.parse(value.slice(API_PREFIX.length));
}


/**
 * Move an account's secrets from the install key onto its own key.
 *
 * Read with whichever key each record names, write them all back under the
 * account's. Every value is decrypted BEFORE anything is written: a vault
 * half-moved is an account that can authenticate nothing, so the whole file
 * either converts or is left exactly as it was.
 */
export function rewrapTenantSecrets(tenant: string): { moved: number; unreadable: string[] } {
  assertSafeName(tenant, "tenant");
  if (!tenantKey(tenant)) return { moved: 0, unreadable: [] };

  let moved = 0;
  const unreadable: string[] = [];

  for (const { file } of secretFiles(tenant)) {
    const all: SecretsFile = JSON.parse(fs.readFileSync(file, "utf8"));
    const plain = new Map<string, string>();
    let pending = 0;

    for (const [name, rec] of Object.entries(all)) {
      if (rec.k === "tenant") continue; // already moved
      const value = decrypt(tenant, rec);
      if (value === null) {
        unreadable.push(name);
        continue;
      }
      plain.set(name, value);
      pending += 1;
    }
    // Nothing to do, or something could not be read — leave the file alone.
    // A partial conversion is worse than none, because the half that moved is
    // no longer openable by the key the other half still needs.
    if (pending === 0 || unreadable.length) continue;

    const next: SecretsFile = { ...all };
    for (const [name, value] of plain) {
      next[name] = { ...encryptValue(tenant, value), updatedAt: all[name].updatedAt, ...(all[name].kind ? { kind: all[name].kind } : {}) };
    }
    const tmp = `${file}.rewrap`;
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, file);
    moved += pending;
  }
  return { moved, unreadable };
}
