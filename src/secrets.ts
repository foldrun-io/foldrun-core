// Secret store. Values are encrypted at rest with AES-256-GCM using a key
// derived from MDAGENT_SECRET_KEY (falling back to a generated per-install
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
import crypto from "node:crypto";
import { assertSafeName } from "./store.ts";

const keyFile = () => path.join(dataRoot(), ".secret-key");

/** Which store a secret came from. */
export type SecretScope = "account" | "workspace";

function masterKey(): Buffer {
  const fromEnv = process.env.MDAGENT_SECRET_KEY;
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

interface StoredSecret {
  iv: string;
  tag: string;
  data: string;
  updatedAt: string;
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

export function setSecret(tenant: string, name: string, value: string, workspace?: string) {
  if (!SECRET_NAME.test(name)) {
    throw new Error(`secret name "${name}" must be UPPER_SNAKE_CASE`);
  }
  if (value.length > 8192) throw new Error("secret too long");
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", masterKey(), iv);
  const enc = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const all = read(tenant, workspace);
  all[name] = {
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    data: enc.toString("base64"),
    updatedAt: new Date().toISOString(),
  };
  write(tenant, workspace, all);
}

function decrypt(rec: StoredSecret | undefined): string | null {
  if (!rec) return null;
  try {
    const decipher = crypto.createDecipheriv(
      "aes-256-gcm",
      masterKey(),
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
    const own = decrypt(read(tenant, workspace)[name]);
    if (own !== null) return { value: own, scope: "workspace" };
  }
  const shared = decrypt(read(tenant)[name]);
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
}

// Metadata only — never values. Without a workspace this lists the account
// store; with one it lists what that workspace actually resolves, marking
// which scope each name comes from.
export function listSecrets(tenant: string, workspace?: string): SecretEntry[] {
  const account = Object.entries(read(tenant)).map(([name, rec]) => ({
    name,
    updatedAt: rec.updatedAt,
    scope: "account" as const,
  }));
  if (!workspace) return account.sort((a, b) => a.name.localeCompare(b.name));

  const own = Object.entries(read(tenant, workspace)).map(([name, rec]) => ({
    name,
    updatedAt: rec.updatedAt,
    scope: "workspace" as const,
    shadowed: account.some((a) => a.name === name),
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
 * one filesystem read gets both. `MDAGENT_SECRET_KEY` fixes that — a managed
 * secret store holds the key, the disk holds only the encrypted values — and
 * this reports which of the two is in force so the platform can say so rather
 * than leaving it to be discovered.
 */
export function masterKeySource(): { source: "env" | "file"; path: string | null } {
  return process.env.MDAGENT_SECRET_KEY
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
 * Both keys are passed in raw, exactly as MDAGENT_SECRET_KEY would be, and
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
