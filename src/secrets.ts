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
import { platform } from "./platform.ts";
import { fetchUntrusted } from "./untrusted-fetch.ts";

/**
 * GCM's auth tag, pinned to its full 16 bytes at every cipher call. Without
 * `authTagLength`, Node accepts whatever length `setAuthTag` is handed — 4, 8,
 * 12, 13, 14, 15 or 16 bytes — so a stored record whose tag had been cut to
 * four bytes would still "verify" on 32 bits of authentication instead of
 * 128. The tag comes from the record on disk; the record is the thing an
 * attacker with file access would edit. One option makes a short tag an
 * error rather than a weaker check.
 */
const GCM = { authTagLength: 16 } as const;

// The account's own data key, when the platform holds one; the install key
// otherwise. See platform.ts — locally there is no account key.
const tenantKey = (tenant: string) => platform.tenantKey(tenant);
import crypto from "node:crypto";
import { assertSafeName } from "./store.ts";
import { trimSlashes } from "./paths.ts";
import { SITE } from "./network.ts";

const keyFile = () => path.join(dataRoot(), ".secret-key");

/** Which store a secret came from. */
export type SecretScope = "account" | "workspace";

/**
 * The install's root secret, as text: FOLDRUN_SECRET_KEY when set, else the
 * contents of `.secret-key` under the data root — created here, the first
 * time anything asks, so there is never a moment when a derived token has
 * nothing real to hang off. The vault, hook tokens, approval links and git
 * push secrets all derive from this one value; rotating it invalidates every
 * one of them together. Exported for webhook.ts, which used to fall back to
 * a fixed dev string until the vault happened to create this file — so hook
 * URLs were computable by anyone who read the source, and then changed the
 * first time a secret was stored.
 */
export function installKeyMaterial(): string {
  const fromEnv = process.env.FOLDRUN_SECRET_KEY;
  if (fromEnv) return fromEnv;
  fs.mkdirSync(dataRoot(), { recursive: true });
  if (!fs.existsSync(keyFile())) {
    fs.writeFileSync(keyFile(), crypto.randomBytes(32).toString("hex"), { mode: 0o600 });
  }
  return fs.readFileSync(keyFile(), "utf8");
}

function masterKey(): Buffer {
  return crypto.createHash("sha256").update(installKeyMaterial()).digest();
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
export type SecretKind = "oauth2" | "service-account" | "file" | "ssh" | "api" | "client-cert" | "identity";

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
  /** The sites this secret is bound to (network.ts SITE shape). A bound
   *  secret never enters a sandbox: the egress proxy fills its `${NAME}` for
   *  these sites alone. Metadata, not a value, so it is stored in the clear
   *  beside the ciphertext and survives the value being set again. */
  sites?: string[];
}

type SecretsFile = Record<string, StoredSecret>;

function read(tenant: string, workspace?: string): SecretsFile {
  return readFile(secretsFile(tenant, workspace));
}

// ------------------------------------------------------------ safe writes
//
// A vault file is read, changed and written back. It was written in place,
// with no lock: two saves at once kept one; a crash mid-write left half a
// file, which is an account that cannot authenticate anything; and the boot
// re-wrap ran in every pod at once through ONE shared temp name, so two pods
// could interleave into it and rename a corrupt file into place.
//
// Now every change goes through mutateVaultFile: an exclusive lock file
// (O_EXCL, which NFS 4.1 and EFS honour, so it holds across pods), the read
// and the change under it, a temp file unique to this writer, and a rename —
// atomic on the same filesystem, so a reader sees the old file or the new
// one, never half. A lock older than LOCK_STALE_MS is a crashed holder.

const LOCK_STALE_MS = 30_000;
const LOCK_WAIT_MS = 10_000;
const sleep = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function readFile(file: string): SecretsFile {
  if (!fs.existsSync(file)) return {};
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return {};
  }
}

function lockVault(file: string): () => void {
  const lock = `${file}.lock`;
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      const fd = fs.openSync(lock, "wx", 0o600);
      fs.writeSync(fd, `${process.pid}@${new Date().toISOString()}`);
      fs.closeSync(fd);
      return () => fs.rmSync(lock, { force: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > LOCK_STALE_MS) {
          fs.rmSync(lock, { force: true }); // a holder that died; take it over
          continue;
        }
      } catch {
        continue; // released between the open and the stat
      }
      if (Date.now() > deadline) throw new Error("the vault is busy — another change is being saved; try again");
      sleep(25);
    }
  }
}

/**
 * Change one vault file safely: `change` gets what is stored now and returns
 * the new contents, or null to leave the file untouched. Returns what is
 * stored after.
 */
export function mutateVaultFile(file: string, change: (all: SecretsFile) => SecretsFile | null): SecretsFile {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const release = lockVault(file);
  try {
    const current = readFile(file);
    const next = change(structuredClone(current));
    if (next === null) return current;
    const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, file);
    return next;
  } finally {
    release();
  }
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
  mutateVaultFile(secretsFile(tenant, workspace), (all) => {
    // A new value keeps the sites the old one was bound to: binding is a
    // property of the credential's use, not of its current value, and a
    // rotation that silently unbound it would put the new value in pods.
    const sites = all[name]?.sites;
    all[name] = {
      ...sealed,
      updatedAt: new Date().toISOString(),
      ...(kind ? { kind } : {}),
      ...(sites?.length ? { sites } : {}),
    };
    return all;
  });
}

/**
 * Bind a secret to sites, or unbind it (an empty list). The secret must
 * exist in that scope. Sites are `api.example.com` or `*.example.com` — no
 * scheme, path or port. Returns the list as stored.
 */
export function setSecretSites(tenant: string, name: string, sites: string[], workspace?: string): string[] {
  const clean = [...new Set(sites.map((x) => x.trim().toLowerCase()).filter(Boolean))];
  for (const site of clean) {
    if (!SITE.test(site)) throw new Error(`"${site}" is not a site — a domain like api.example.com or *.example.com, no scheme, path or port`);
  }
  let found = false;
  mutateVaultFile(secretsFile(tenant, workspace), (all) => {
    const rec = all[name];
    if (!rec) return null;
    found = true;
    // A file, an ssh key or an @api header set is not a value that travels
    // in a header — it is unpacked inside the sandbox, so there is nothing
    // for the proxy to fill.
    if (clean.length && (rec.kind === "file" || rec.kind === "ssh" || rec.kind === "api")) {
      throw new Error(`${name} is a ${rec.kind} secret, unpacked inside the sandbox — only a value sent in a request can be bound to sites`);
    }
    // A client certificate is presented by the egress proxy to the exact
    // hosts named — never to a whole domain on a wildcard.
    if (rec.kind === "client-cert" && clean.some((s) => s.startsWith("*."))) {
      throw new Error(`${name} is a client certificate — bind it to exact hosts, not a wildcard`);
    }
    if (clean.length) rec.sites = clean;
    else delete rec.sites;
    return all;
  });
  if (!found) throw new Error(`no secret ${name}${workspace ? ` in workspace ${workspace}` : " in the account"}`);
  return clean;
}

/**
 * The sites each named secret is bound to, nearest scope first — the same
 * record getSecret would read the value from. A name with no binding (or
 * no secret) is absent from the answer.
 */
export function secretSites(tenant: string, names: string[], workspace?: string): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  const own = workspace ? read(tenant, workspace) : {};
  const account = read(tenant);
  for (const name of names) {
    const rec = own[name] ?? account[name];
    if (rec?.sites?.length) out[name] = [...rec.sites];
  }
  return out;
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
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv, GCM);
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
      GCM,
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
  mutateVaultFile(secretsFile(tenant, workspace), (all) => {
    if (!(name in all)) return null;
    delete all[name];
    return all;
  });
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
  /** The sites it is bound to — the proxy fills it for these and no other,
   *  and it never enters a sandbox. Absent when unbound. */
  sites?: string[];
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
    ...(rec.sites?.length ? { sites: [...rec.sites] } : {}),
  }));
  if (!workspace) return account.sort((a, b) => a.name.localeCompare(b.name));

  const own = Object.entries(read(tenant, workspace)).map(([name, rec]) => ({
    name,
    updatedAt: rec.updatedAt,
    scope: "workspace" as const,
    shadowed: account.some((a) => a.name === name),
    ...(rec.kind ? { kind: rec.kind } : {}),
    ...(rec.sites?.length ? { sites: [...rec.sites] } : {}),
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
    let count = 0;
    mutateVaultFile(file, (all) => {
      const next: SecretsFile = {};
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
          const d = crypto.createDecipheriv("aes-256-gcm", oldKey, Buffer.from(rec.iv, "base64"), GCM);
          d.setAuthTag(Buffer.from(rec.tag, "base64"));
          plain = Buffer.concat([d.update(Buffer.from(rec.data, "base64")), d.final()]).toString("utf8");
        } catch {
          unreadable.push(name);
          next[name] = rec; // untouched
          continue;
        }
        const iv = crypto.randomBytes(12);
        const c = crypto.createCipheriv("aes-256-gcm", newKey, iv, GCM);
        const enc = Buffer.concat([c.update(plain, "utf8"), c.final()]);
        next[name] = {
          iv: iv.toString("base64"),
          tag: c.getAuthTag().toString("base64"),
          data: enc.toString("base64"),
          updatedAt: rec.updatedAt, // rotation is not an edit
          // Kept: without it an oauth2 secret stops being refreshed after a
          // rotation, and a file/ssh/api secret stops being materialised.
          ...(rec.kind ? { kind: rec.kind } : {}),
        };
        count++;
      }
      return next;
    });
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
  /** Absent for a public client (an app with no secret, connected with
   *  PKCE): its refresh sends client_id and refresh_token only. */
  client_secret?: string;
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

/** Tries at a token endpoint before a refresh is called failed: the first,
 *  and two more after a short wait, for a network error, a 5xx or a 429. */
export const OAUTH_REFRESH_TRIES = 3;
/** Wait before try n (1-based retry): 1s, 3s — FOLDRUN_OAUTH_RETRY_MS scales it for tests. */
export function oauthRetryDelayMs(n: number): number {
  const base = Number(process.env.FOLDRUN_OAUTH_RETRY_MS ?? 1000);
  return base * (n === 1 ? 1 : 3);
}

export function setOAuth2Secret(
  tenant: string,
  name: string,
  config: OAuth2Config,
  workspace?: string,
) {
  for (const field of ["token_url", "client_id"] as const) {
    if (!config[field]?.trim()) throw new Error(`oauth2 secret needs ${field}`);
  }
  // A public client (PKCE, no secret) refreshes with its client id alone;
  // client credentials are nothing without the secret.
  if (config.grant_type === "client_credentials" && !config.client_secret?.trim()) {
    throw new Error("oauth2 secret needs client_secret for client_credentials");
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

/**
 * The cache key for a live token: SHA-256 over the kind, the account and the
 * WHOLE stored config — credential material included (client secret, refresh
 * token, private key, subject, scopes, token URL). A caller can only hit an
 * entry it could have minted itself. Both maps are process-wide, so a key of
 * names alone (`sa:${name}:${issuer}`, `${name}:${client_id}:…`) once let a
 * second account with the same names be handed the first one's token
 * (Codex debate, 22 Oct 2026).
 */
export function tokenCacheKey(kind: "oauth2" | "sa", storedValue: string, tenant?: string): string {
  return crypto.createHash("sha256").update(JSON.stringify([kind, tenant ?? "", storedValue])).digest("hex");
}

/**
 * A provider that rotates refresh tokens (RFC 9700 §2.2.2) answered a refresh
 * with a new one: write it back where the old one is stored — the workspace
 * copy, else the account's — but only while that copy still holds the value
 * this refresh used (compare-and-set), so two refreshes racing cannot put an
 * older token over a newer one. Returns whether a copy was replaced.
 */
export function replaceOAuth2RefreshToken(tenant: string, name: string, workspace: string | undefined, usedValue: string, refreshToken: string): boolean {
  if (!isOAuth2Value(usedValue)) return false;
  const config = JSON.parse(usedValue.slice(OAUTH2_PREFIX.length)) as OAuth2Config;
  const next = OAUTH2_PREFIX + JSON.stringify({ ...config, refresh_token: refreshToken });
  for (const scope of workspace ? [workspace, undefined] : [undefined]) {
    let replaced = false;
    mutateVaultFile(secretsFile(tenant, scope), (all) => {
      const rec = all[name];
      if (rec && decrypt(tenant, rec) === usedValue) {
        all[name] = { ...rec, ...encryptValue(tenant, next), updatedAt: new Date().toISOString() };
        replaced = true;
      }
      return all;
    });
    if (replaced) return true;
  }
  return false;
}

/** An oauth2 refresh's outcome: the access token and, when the provider
 *  rotated it, the new refresh token — kept with the cache entry so every
 *  copy of the old credential (another secret name, another scope) that is
 *  served this token also gets the new refresh token written back. */
interface OAuthLive { token: string; expiresAt: number; rotated?: string }
const oauthCache = new Map<string, OAuthLive>();
const oauthFlight = new Map<string, Promise<OAuthLive>>();

/** Cache an access token, sweeping expired entries as it goes: a rotating
 *  provider changes the stored config — and so the key — on every refresh,
 *  and expired entries would otherwise pile up for the life of the process. */
function cacheOAuth(key: string, live: OAuthLive): void {
  const now = Date.now();
  for (const [k, v] of oauthCache) if (v.expiresAt <= now) oauthCache.delete(k);
  oauthCache.set(key, live);
}

async function exchange(config: OAuth2Config, cacheKey: string): Promise<OAuthLive> {
  const cached = oauthCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached;

  const pending = oauthFlight.get(cacheKey);
  if (pending) return pending;

  const flight = (async () => {
    const body = new URLSearchParams({
      grant_type: config.grant_type ?? "refresh_token",
      ...(config.grant_type === "client_credentials" ? {} : { refresh_token: config.refresh_token! }),
      client_id: config.client_id,
      ...(config.client_secret ? { client_secret: config.client_secret } : {}),
      ...(config.extra ?? {}),
    });
    // A network blip is retried; a provider's answer is not. "fetch failed"
    // (a reset, a DNS hiccup, a timeout) failed whole steps on the first try
    // — gbp-desk's Thursday posts, 7 Oct 2026. A 4xx (revoked, wrong client)
    // will say the same thing again, so it goes straight to the error below
    // and the reconnect mail; a 5xx or 429 is the provider busy, retried.
    let res: Response | undefined;
    let lastNetwork: unknown;
    for (let attempt = 0; attempt < OAUTH_REFRESH_TRIES; attempt++) {
      if (attempt) await new Promise((r) => setTimeout(r, oauthRetryDelayMs(attempt)));
      try {
        res = await fetchUntrusted(config.token_url, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: body.toString(),
          signal: AbortSignal.timeout(15_000),
        }, { sameOrigin: true });
      } catch (err) {
        lastNetwork = err;
        res = undefined;
        continue;
      }
      if (res.status === 429 || res.status >= 500) continue;
      break;
    }
    if (!res) throw lastNetwork instanceof Error ? lastNetwork : new Error(String(lastNetwork));
    const payload = (await res.json().catch(() => ({}))) as {
      access_token?: string;
      refresh_token?: string;
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
    // A rotated refresh token replaces the old one, which the provider may
    // now refuse; dropping it broke the next refresh for rotating providers.
    const rotated = payload.refresh_token && config.grant_type !== "client_credentials" && payload.refresh_token !== config.refresh_token
      ? payload.refresh_token
      : undefined;
    const live: OAuthLive = { token: payload.access_token, expiresAt: Date.now() + ttl, ...(rotated ? { rotated } : {}) };
    cacheOAuth(cacheKey, live);
    return live;
  })();

  oauthFlight.set(cacheKey, flight);
  try {
    return await flight;
  } finally {
    oauthFlight.delete(cacheKey);
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
  /** Whose secrets these are, when the caller knows: lets the platform keep
   *  each OAuth connection's health and quote a reconnect link on failure. */
  ctx?: { tenant: string; workspace?: string },
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
        const live = await exchange(config, tokenCacheKey("oauth2", value, ctx?.tenant));
        out[name] = live.token;
        if (live.rotated) {
          // This caller's copy takes the new refresh token (compare-and-set:
          // a copy already updated, or changed since, is left alone), and the
          // access token is cached under the config as it is now stored, so
          // the next run does not refresh again.
          const next = OAUTH2_PREFIX + JSON.stringify({ ...config, refresh_token: live.rotated });
          try {
            if (ctx) replaceOAuth2RefreshToken(ctx.tenant, name, ctx.workspace, value, live.rotated);
          } catch {
            // The access token is good either way; the next refresh says if not.
          }
          cacheOAuth(tokenCacheKey("oauth2", next, ctx?.tenant), { token: live.token, expiresAt: live.expiresAt });
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const link = ctx ? await platform.noteOAuthRefresh(ctx, name, message).catch(() => undefined) : undefined;
        throw new Error(`secret ${name}: ${message}${link ? ` — reconnect it in one click: ${link}` : ""}`);
      }
      if (ctx) await platform.noteOAuthRefresh(ctx, name, null).catch(() => undefined);
    } else if (value.startsWith(SERVICE_ACCOUNT_PREFIX)) {
      let config: ServiceAccountConfig;
      try {
        config = JSON.parse(value.slice(SERVICE_ACCOUNT_PREFIX.length));
      } catch {
        throw new Error(`secret ${name}: stored service account config is unreadable`);
      }
      try {
        out[name] = await exchangeServiceAccount(config, tokenCacheKey("sa", value, ctx?.tenant));
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
  /** The JWT bearer grant's subject (RFC 7523 §3): the user the account acts
   *  as, where the provider allows it — Google's domain-wide delegation, once
   *  a Workspace admin grants it. Absent, the account acts as itself. */
  subject?: string;
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
  if (!/BEGIN [A-Z ]{0,40}PRIVATE KEY/.test(config.private_key)) {
    throw new Error("private_key must be a PEM key (from the service account JSON)");
  }
  if (config.subject !== undefined) {
    if (typeof config.subject !== "string" || !config.subject.trim()) throw new Error("subject is the user to act as — leave it out to act as the account itself");
    if (config.subject.length > 320 || /[\u0000-\u001f\u007f\s]/.test(config.subject.trim())) throw new Error("subject is one identifier, no spaces or control characters");
  }
  const stored: ServiceAccountConfig = { ...config, ...(config.subject !== undefined ? { subject: config.subject.trim() } : {}) };
  setSecret(tenant, name, SERVICE_ACCOUNT_PREFIX + JSON.stringify(stored), workspace, "service-account");
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
        // The subject is part of the stored config, so of the cache key: two
        // subjects never share a token (tokenCacheKey).
        sub: config.subject || config.issuer,
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

    const res = await fetchUntrusted(config.token_url, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion: jwt,
      }).toString(),
      signal: AbortSignal.timeout(15_000),
    }, { sameOrigin: true });
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
  if (hasKey && !/BEGIN [A-Z ]{0,40}PRIVATE KEY/.test(config.private_key!)) {
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
const CLIENT_CERT_PREFIX = "@client-cert ";

/** A client certificate for mutual TLS: presented by the egress proxy, on its
 *  own connection, to the exact hosts the secret is bound to — the sandbox
 *  never holds the key. `export` puts it in the sandbox as files instead,
 *  only when asked for (a step with no egress proxy). */
export interface ClientCertConfig {
  /** PEM certificate, chain included. */
  cert: string;
  /** PEM private key. */
  key: string;
  passphrase?: string;
  export?: boolean;
}

export function setClientCertSecret(tenant: string, name: string, config: ClientCertConfig, workspace?: string) {
  if (!/-----BEGIN CERTIFICATE-----/.test(config.cert ?? "")) throw new Error("cert must be a PEM certificate");
  if (!/-----BEGIN [A-Z ]{0,40}PRIVATE KEY-----/.test(config.key ?? "")) throw new Error("key must be a PEM private key");
  // The pair must match: a certificate presented with another key's proof
  // fails at the server, after the request has gone.
  let matches = false;
  try {
    const key = crypto.createPrivateKey({ key: config.key, ...(config.passphrase ? { passphrase: config.passphrase } : {}) });
    matches = new crypto.X509Certificate(config.cert).checkPrivateKey(key);
  } catch (err) {
    throw new Error(`the certificate or key cannot be read: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!matches) throw new Error("the key does not belong to the certificate");

  const stored: ClientCertConfig = {
    cert: config.cert,
    key: config.key,
    ...(config.passphrase ? { passphrase: config.passphrase } : {}),
    ...(config.export ? { export: true } : {}),
  };
  if (!SECRET_NAME.test(name)) throw new Error(`secret name "${name}" must be UPPER_SNAKE_CASE`);
  const sealed = encryptValue(tenant, CLIENT_CERT_PREFIX + JSON.stringify(stored));
  // Written under the vault's own lock, with the binding checked in the same
  // step: a value set over a secret keeps its site binding, and a wildcard
  // one would present the certificate to a whole domain.
  mutateVaultFile(secretsFile(tenant, workspace), (all) => {
    const sites = all[name]?.sites;
    if (sites?.some((site) => site.startsWith("*."))) {
      throw new Error(`${name} is bound to ${sites.join(", ")} — a client certificate is bound to exact hosts; unbind the wildcard first`);
    }
    all[name] = { ...sealed, updatedAt: new Date().toISOString(), kind: "client-cert", ...(sites?.length ? { sites } : {}) };
    return all;
  });
}

const IDENTITY_PREFIX = "@identity ";

/** A keyless cloud identity: no credential at all, only the audience the
 *  platform's signed tokens are for. A step that declares it gets a token
 *  file the sandbox driver keeps fresh through the egress proxy. */
export interface IdentityConfig {
  audience: string;
}

export function setIdentitySecret(tenant: string, name: string, config: IdentityConfig, workspace?: string) {
  const audience = typeof config.audience === "string" ? config.audience.trim() : "";
  if (!audience) throw new Error("an identity needs an audience — the value your cloud's trust expects in aud");
  if (audience.length > 600 || /[\u0000-\u001f\u007f]/.test(audience)) throw new Error("audience is one value, at most 600 characters, no control characters");
  setSecret(tenant, name, IDENTITY_PREFIX + JSON.stringify({ audience }), workspace, "identity");
}

export function isIdentityValue(value: string): boolean {
  return value.startsWith(IDENTITY_PREFIX);
}

export function identityOf(value: string): IdentityConfig {
  return JSON.parse(value.slice(IDENTITY_PREFIX.length));
}

export function isClientCertValue(value: string): boolean {
  return value.startsWith(CLIENT_CERT_PREFIX);
}

/** An environment without the client certificates that were not saved with
 *  `export`: those are the egress proxy's to present, never a program's. */
export function withoutHeldCerts(env: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(env).filter(([, v]) => typeof v !== "string" || !isClientCertValue(v) || clientCertOf(v).export === true));
}

export function clientCertOf(value: string): ClientCertConfig {
  return JSON.parse(value.slice(CLIENT_CERT_PREFIX.length));
}

export interface ApiConfig {
  base_url?: string;
  headers: Record<string, string>;
  /** Username and password for HTTP Basic (RFC 7617): stored as the
   *  `Authorization: Basic …` header they make, never kept apart. */
  basic?: { username: string; password: string };
}

/** `Authorization: Basic …` from a username and password (RFC 7617 §2):
 *  UTF-8, no colon in the username, no control characters in either. */
export function basicAuthorization(username: string, password: string): string {
  if (typeof username !== "string" || typeof password !== "string") throw new Error("basic needs username and password");
  if (!username) throw new Error("basic needs a username");
  if (username.includes(":")) throw new Error("a Basic username cannot contain a colon (RFC 7617)");
  if (/[\u0000-\u001f\u007f]/.test(username) || /[\u0000-\u001f\u007f]/.test(password)) throw new Error("Basic credentials cannot contain control characters");
  return `Basic ${Buffer.from(`${username}:${password}`, "utf8").toString("base64")}`;
}

export function setApiSecret(tenant: string, name: string, config: ApiConfig, workspace?: string) {
  let all = { ...(config.headers ?? {}) };
  if (config.basic) {
    if (Object.keys(all).some((h) => h.toLowerCase() === "authorization")) {
      throw new Error("give either basic or an Authorization header, not both");
    }
    // Credentials in the clear over http are leaked ones: https, or loopback.
    const base = config.base_url?.trim();
    if (base) {
      let u: URL | null = null;
      try {
        u = new URL(base);
      } catch {
        u = null;
      }
      const loopback = u?.protocol === "http:" && (u.hostname === "localhost" || u.hostname === "127.0.0.1");
      if (!u || (u.protocol !== "https:" && !loopback)) throw new Error("Basic credentials need an https base_url");
    }
    all = { ...all, Authorization: basicAuthorization(config.basic.username, config.basic.password) };
  }
  config = { ...(config.base_url ? { base_url: config.base_url } : {}), headers: all };
  const headers = Object.entries(all);
  if (headers.length === 0) throw new Error("api secret needs at least one header");
  for (const [h, v] of headers) {
    if (!/^[A-Za-z0-9-]+$/.test(h)) throw new Error(`"${h}" is not a valid header name`);
    if (/[\n\r]/.test(v)) throw new Error(`header ${h} cannot contain newlines`);
  }
  const base = config.base_url?.trim();
  if (base && !/^https?:\/\//.test(base)) throw new Error("base_url must be http(s)");
  setSecret(
    tenant, name,
    API_PREFIX + JSON.stringify({ ...(base ? { base_url: trimSlashes(base) } : {}), headers: config.headers }),
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
    // Under the vault's lock: every pod runs this at boot, and a save made
    // between our read and our write must not be lost.
    mutateVaultFile(file, (all) => {
      const plain = new Map<string, string>();
      const unreadableHere: string[] = [];
      for (const [name, rec] of Object.entries(all)) {
        if (rec.k === "tenant") continue; // already moved
        const value = decrypt(tenant, rec);
        if (value === null) {
          unreadableHere.push(name);
          continue;
        }
        plain.set(name, value);
      }
      unreadable.push(...unreadableHere);
      // Nothing to do, or something in THIS file could not be read — leave it
      // alone. A partial conversion is worse than none, because the half that
      // moved is no longer openable by the key the other half still needs.
      if (plain.size === 0 || unreadableHere.length) return null;
      const next: SecretsFile = { ...all };
      for (const [name, value] of plain) {
        next[name] = {
          ...encryptValue(tenant, value),
          updatedAt: all[name].updatedAt,
          ...(all[name].kind ? { kind: all[name].kind } : {}),
          ...(all[name].sites?.length ? { sites: all[name].sites } : {}),
        };
      }
      moved += plain.size;
      return next;
    });
  }
  return { moved, unreadable };
}
