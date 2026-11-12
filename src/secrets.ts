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

import { opsLog, withOpsReason } from "./ops-log.ts";
import fs from "node:fs";
import path from "node:path";
import { dataRoot } from "./paths.ts";
import { platform } from "./platform.ts";
import { fetchUntrusted } from "./untrusted-fetch.ts";
import { oauthTokenRequest, readTokenResponse, tokenAuthProblem, type TokenAuth } from "./oauth-token.ts";
import { isSecureUrl } from "./oauth-discovery.ts";
import type { AssertionAlg } from "./oauth-assertion.ts";
import { dpopProof, dpopNonceFor, noteDpopNonce } from "./oauth-dpop.ts";

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
import { SITE, siteCovers } from "./network.ts";

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
  // A process that must never hold the install key (the egress proxy) says
  // so; without this, asking for it would quietly mint a NEW random key on
  // the shared data volume — a second root key nobody chose.
  if (process.env.FOLDRUN_INSTALL_KEY_ABSENT === "1") {
    throw withOpsReason(new Error("this process runs without the install key (FOLDRUN_INSTALL_KEY_ABSENT=1) — whatever asked for it belongs in the worker"), "install_key_absent");
  }
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
export type SecretKind = "oauth2" | "service-account" | "file" | "ssh" | "api" | "client-cert" | "identity" | "token-exchange";

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
  /** An ACCOUNT secret limited to these workspaces (GitHub's "selected
   *  repositories" for an organisation secret). Absent: every workspace may
   *  use it, as before. Every other workspace is answered as if it were not
   *  set (getSecret). Metadata like `sites`: in the clear, and in the seal
   *  of a bound record. Never on a workspace's own record. */
  workspaces?: string[];
  /** 2: sealed with the record's place as AAD — account, scope, name, kind,
   *  key, sites and, when limited, workspaces (vaultAad). Absent: the older,
   *  unbound form. */
  v?: 2;
}

export type SecretsFile = Record<string, StoredSecret>;

// ------------------------------------------------------------ binding
//
// A v2 record is sealed with WHERE it belongs as additional authenticated
// data: the account, the scope (account or which workspace), the name, its
// kind, which key sealed it, and the sites it is bound to. Before 29 Oct 2026
// (OWASP review) a record was bound to nothing: anyone who could write the
// data volume or a backup could move one secret's ciphertext under another
// name, scope or account, or rewrite its clear `sites` and have the egress
// proxy fill it for their own host. Now any of those makes it fail to open,
// which reads as "not set" — never as unbound.
//
// The place comes from the FILE the record is read from, never from fields
// inside it. Sites stay in clear beside the ciphertext (listing needs no
// key, and a pod from before v2 reads them there) and are authenticated by
// the AAD.
//
// Rolled out in steps: every release since reads v2; FOLDRUN_VAULT_WRITE_BOUND=1
// writes it and migrates existing records at boot; FOLDRUN_VAULT_REQUIRE_BOUND=1
// refuses the old form once none is left.

// The scope is account or workspace, not WHICH workspace: a workspace can be
// renamed (its folder moves with its vault), and binding the name would make
// every rename a re-seal racing other writers. What that leaves open — a
// ciphertext moved between two workspaces of the same account by someone who
// can already write the volume — is the residual, and stays inside one account.
//
// Rolling out (30 Oct 2026, accepted, no switch): a pod from before this
// release cannot open a limited record (its AAD lacks the list), and one that
// sets a new value over it writes the record back without the list — open to
// every workspace again. So limits are set after every pod, worker and the
// egress proxy run this version; the secrets docs say so.
//
// The workspaces an account secret is limited to are in the seal too (30 Oct
// 2026), appended only when the record has the list: every record sealed
// before keeps the AAD it was sealed with, and a list added to, widened in or
// stripped from a sealed record on disk makes it fail to open — "not set",
// never "every workspace". These ARE workspace names, so a rename re-seals
// them (retargetSecretWorkspaces), under the vault lock.
function vaultAad(tenant: string, workspace: string | undefined, name: string, rec: Pick<StoredSecret, "kind" | "k" | "sites" | "workspaces">): Buffer {
  if (rec.sites !== undefined && (!Array.isArray(rec.sites) || rec.sites.some((x) => typeof x !== "string"))) {
    throw new Error("malformed sites");
  }
  if (rec.workspaces !== undefined && (!Array.isArray(rec.workspaces) || rec.workspaces.some((x) => typeof x !== "string"))) {
    throw new Error("malformed workspaces");
  }
  return Buffer.from(
    JSON.stringify([
      "foldrun-vault/2",
      tenant,
      workspace ? "w" : "a",
      name,
      rec.kind ?? "",
      rec.k ?? "install",
      [...(rec.sites ?? [])].sort(),
      ...(rec.workspaces !== undefined ? [["workspaces", [...rec.workspaces].sort()]] : []),
    ]),
    "utf8",
  );
}

/** May an account record be used in this workspace? No list: everywhere. A
 *  list that is not a list of names (rewritten on disk) allows nowhere. */
function usableIn(rec: Pick<StoredSecret, "workspaces"> | undefined, workspace: string): boolean {
  if (!rec || rec.workspaces === undefined) return true;
  return Array.isArray(rec.workspaces) && rec.workspaces.includes(workspace);
}
const writeBound = () => process.env.FOLDRUN_VAULT_WRITE_BOUND === "1";
const requireBound = () => process.env.FOLDRUN_VAULT_REQUIRE_BOUND === "1";

/** One record, sealed for its place. Bound (v2) when the install writes bound
 *  records or `bound` says so; the unbound form otherwise. */
function sealRecord(
  tenant: string,
  workspace: string | undefined,
  name: string,
  value: string,
  meta: { kind?: SecretKind; sites?: string[]; workspaces?: string[]; updatedAt?: string },
  bound = writeBound(),
): StoredSecret {
  const { key, mark } = keyFor(tenant);
  const rec: StoredSecret = {
    iv: "",
    tag: "",
    data: "",
    updatedAt: meta.updatedAt ?? new Date().toISOString(),
    ...(meta.kind ? { kind: meta.kind } : {}),
    ...(mark ? { k: mark } : {}),
    ...(meta.sites?.length ? { sites: [...meta.sites] } : {}),
    // An empty list is a choice (no workspace may use it), kept as written.
    ...(meta.workspaces !== undefined ? { workspaces: [...meta.workspaces] } : {}),
  };
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv, GCM);
  if (bound) {
    cipher.setAAD(vaultAad(tenant, workspace, name, rec));
    rec.v = 2;
  }
  const enc = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  rec.iv = iv.toString("base64");
  rec.tag = cipher.getAuthTag().toString("base64");
  rec.data = enc.toString("base64");
  return rec;
}

/** A record's value, opened for its place; null when it will not open. */
function openRecord(tenant: string, workspace: string | undefined, name: string, rec: StoredSecret | undefined): string | null {
  if (!rec) return null;
  if (rec.v === 2) {
    // Metadata someone rewrote into a shape that is not a list fails closed,
    // like a bad tag — never as an exception up the read path.
    let aad: Buffer;
    try {
      aad = vaultAad(tenant, workspace, name, rec);
    } catch {
      return null;
    }
    return decrypt(tenant, rec, aad);
  }
  return requireBound() ? null : decrypt(tenant, rec);
}

// ------------------------------------------------------------ where a vault lives
//
// A vault scope (an account's, or one workspace's) is its secrets.json — or,
// on a platform that has registered a store and moved that scope, rows in its
// database (FOL-126 phase 6: the last thing the egress pod needs the shared
// volume for). The records are the same sealed records either way: the store
// never sees a value. A scope is served from exactly one place — a store
// that says `on` for it is the only thing read and written, so a secret
// deleted there cannot come back from a file left behind.

export interface VaultStore {
  /** Is this scope (workspace undefined: the account's) served from the store? */
  on(tenant: string, workspace?: string): boolean;
  read(tenant: string, workspace?: string): SecretsFile;
  /** mutateVaultFile's contract: `change` gets what is stored now and returns
   *  the new contents, or null to leave them; one writer at a time per scope
   *  (the callback may run again if another writer got in first), all or
   *  nothing; returns what is stored after. Throws the same "busy" error. */
  mutate(tenant: string, workspace: string | undefined, change: (all: SecretsFile) => SecretsFile | null): SecretsFile;
  /** The workspaces of this account whose scope is in the store. */
  workspaces(tenant: string): string[];
}

let vaultStore: VaultStore | null = null;
/** Register (or, with null, remove) the platform's vault store. None: files. */
export function setVaultStore(store: VaultStore | null): void {
  vaultStore = store;
}
const inStore = (tenant: string, workspace?: string): VaultStore | null => (vaultStore?.on(tenant, workspace) ? vaultStore : null);

function read(tenant: string, workspace?: string): SecretsFile {
  const store = inStore(tenant, workspace);
  return store ? store.read(tenant, workspace) : readFile(secretsFile(tenant, workspace));
}

/** Change one vault scope safely, wherever it lives (see mutateVaultFile). */
function mutateVault(tenant: string, workspace: string | undefined, change: (all: SecretsFile) => SecretsFile | null): SecretsFile {
  const store = inStore(tenant, workspace);
  return store ? store.mutate(tenant, workspace, change) : mutateVaultFile(secretsFile(tenant, workspace), change);
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
  return lockFileExclusive(file, "the vault is busy — another change is being saved; try again");
}

/**
 * An exclusive lock on `file` for a read-change-write, across processes and
 * pods: `<file>.lock` opened O_EXCL (NFS 4.1 and EFS honour it), taken over
 * when older than LOCK_STALE_MS (a holder that died), waited for up to
 * LOCK_WAIT_MS, then `busy` is thrown. Returns the release. The vault's,
 * and any other small state file several runs write (a2a-tools' handles).
 */
export function lockFileExclusive(file: string, busy = `${path.basename(file)} is busy — another writer holds it; try again`): () => void {
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
      if (Date.now() > deadline) throw new Error(busy);
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

/**
 * How a `signing_secret:` is shown in an answer, a log line or a delivery
 * record: the name it holds, and only a name (30 Oct 2026). It is meant to
 * name a vault entry, but nothing stopped the value itself being written
 * there, and notify's test send echoed it back to the dashboard as "signed
 * with <it>". Anything that is not a secret name is described, never
 * repeated (foldrun check flags it as secret/signing-secret-value).
 */
export function signingSecretShown(name: string): string {
  return SECRET_NAME.test(name) ? name : "the signing_secret: (not a secret name — see foldrun check)";
}

/**
 * Which workspaces an ACCOUNT secret may be used in, given with the value so
 * both are sealed in one locked write (30 Oct 2026): a new secret created
 * and limited in two calls was open to every workspace between them, and
 * stayed open if the second failed. `workspaces` undefined keeps what the
 * record has; null opens it to every workspace; a list limits it.
 * `exists` is asked about each name under the vault lock, so a workspace
 * deleted meanwhile is not granted (the delete takes its name off every
 * list under the same lock — retargetSecretWorkspaces).
 */
export interface SecretLimit {
  workspaces?: string[] | null;
  exists?: (workspace: string) => boolean;
}

/** A list as stored: trimmed, de-duplicated, sorted; every name a safe one
 *  and, when the caller can say, one that exists. */
function cleanWorkspaceList(workspaces: unknown): string[] | null {
  if (workspaces === null) return null;
  if (!Array.isArray(workspaces) || workspaces.some((w) => typeof w !== "string")) {
    throw new Error("workspaces is a list of workspace names, or null for every workspace");
  }
  const clean = [...new Set((workspaces as string[]).map((w) => w.trim()).filter(Boolean))].sort();
  for (const w of clean) assertSafeName(w, "workspace");
  return clean;
}
function assertWorkspacesExist(list: string[] | null, exists?: (w: string) => boolean) {
  if (!list || !exists) return;
  const missing = list.filter((w) => !exists(w));
  if (missing.length) throw Object.assign(new Error(`no workspace ${missing.join(", ")} in this account`), { status: 400 });
}

export function setSecret(
  tenant: string,
  name: string,
  value: string,
  workspace?: string,
  kind?: SecretKind,
  limit: SecretLimit = {},
) {
  // A string, not anything that prints as one: RegExp.test and the vault's
  // keys both coerce, so ["RESEND_API_KEY"] from a JSON body was stored as
  // RESEND_API_KEY past a caller's check on the name (30 Oct 2026).
  if (typeof name !== "string" || !SECRET_NAME.test(name)) {
    throw new Error(`secret name "${name}" must be UPPER_SNAKE_CASE`);
  }
  if (value.length > 8192) throw new Error("secret too long");
  const wanted = limitFor(workspace, limit);
  mutateVault(tenant, workspace, (all) => {
    // A new value keeps the sites the old one was bound to: binding is a
    // property of the credential's use, not of its current value, and a
    // rotation that silently unbound it would put the new value in pods.
    // Sealed here, under the lock: a bound record's AAD names those sites.
    const sites = all[name]?.sites;
    // The workspaces it is limited to stay too, for the same reason: a new
    // value that every workspace could suddenly read is a widening nobody
    // asked for — unless this call says otherwise, in the same write.
    if (wanted !== undefined) assertWorkspacesExist(wanted, limit.exists);
    const workspaces = wanted !== undefined ? (wanted ?? undefined) : all[name]?.workspaces;
    // Once bound, always bound: a re-save with the switch off must not
    // quietly drop the record's authentication. A limited record is always
    // bound, so its list is in its seal (see setSecretWorkspaces).
    all[name] = sealRecord(tenant, workspace, name, value, { kind, sites, workspaces }, all[name]?.v === 2 || workspaces !== undefined || writeBound());
    return all;
  });
}

/** The list a write was asked to store, checked: undefined when it was not
 *  asked to change it. Only the account's store has lists. */
function limitFor(workspace: string | undefined, limit: SecretLimit): string[] | null | undefined {
  if (limit.workspaces === undefined) return undefined;
  if (workspace) throw new Error("a workspace's own secret is that workspace's already — only an account secret is limited to workspaces");
  return cleanWorkspaceList(limit.workspaces);
}

/**
 * Bind a secret to sites, or unbind it (an empty list). The secret must
 * exist in that scope. Sites are `api.example.com` or `*.example.com` — no
 * scheme, path or port. Returns the list as stored.
 */
export function setSecretSites(tenant: string, name: string, sites: string[], workspace?: string): string[] {
  // all[name] would find ["NAME"] as NAME: see setSecret.
  if (typeof name !== "string") throw new Error("a secret's name is a string");
  const clean = [...new Set(sites.map((x) => x.trim().toLowerCase()).filter(Boolean))];
  for (const site of clean) {
    if (!SITE.test(site)) throw new Error(`"${site}" is not a site — a domain like api.example.com or *.example.com, no scheme, path or port`);
  }
  let found = false;
  mutateVault(tenant, workspace, (all) => {
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
    // A bound record names its sites in its seal: open it with the old
    // binding and seal it again with the new one. One that will not open is
    // refused, never relabelled.
    if (rec.v === 2) {
      const value = openRecord(tenant, workspace, name, rec);
      if (value === null) throw new Error(`${name} cannot be read with this install's keys — set its value again before binding it`);
      all[name] = sealRecord(tenant, workspace, name, value, { kind: rec.kind, sites: clean, workspaces: rec.workspaces, updatedAt: rec.updatedAt }, true);
      return all;
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
    // The record getSecret would take the VALUE from — the workspace's only
    // when it opens, else the account's. Picking by presence paired an
    // account value with a workspace record's (unauthenticated) sites.
    const ownRec = own[name];
    const ownOpens = Boolean(ownRec && openRecord(tenant, workspace, name, ownRec) !== null);
    // An account record limited to other workspaces is not this one's.
    if (!ownOpens && workspace && !usableIn(account[name], workspace)) continue;
    const rec = ownOpens ? ownRec : account[name];
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

function decrypt(tenant: string, rec: StoredSecret | undefined, aad?: Buffer): string | null {
  if (!rec) return null;
  // A bound record opens only with its binding: one without is not a guess.
  if (rec.v === 2 && !aad) return null;
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
        // loadTenantKeys() was not called before reading: the value reads as absent.
        opsLog("error", "secrets.account_key_not_loaded", { tenant });
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
    if (aad) decipher.setAAD(aad);
    return Buffer.concat([
      decipher.update(Buffer.from(rec.data, "base64")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    return null; // key rotated or file tampered with
  }
}

/** Nearest wins: a workspace secret shadows an account one of the same name.
 *  An account secret limited to some workspaces (setSecretWorkspaces) is
 *  absent for every other — the answer a secret that was never set gets, on
 *  every path that resolves one for a workspace: runs, tool tests, notify,
 *  the egress proxy, MCP servers. Without a workspace it is the account's
 *  own use (its model key, its mail sender), which no list limits. */
export function getSecret(
  tenant: string,
  name: string,
  workspace?: string,
): { value: string; scope: SecretScope } | null {
  if (workspace) {
    const own = openRecord(tenant, workspace, name, read(tenant, workspace)[name]);
    if (own !== null) return { value: own, scope: "workspace" };
  }
  const rec = read(tenant)[name];
  if (workspace && !usableIn(rec, workspace)) return null;
  const shared = openRecord(tenant, undefined, name, rec);
  return shared === null ? null : { value: shared, scope: "account" };
}

/** May the ACCOUNT's secret `name` be used for this workspace? True when it
 *  is not limited (or not set); for callers that read the account's copy on
 *  a workspace's behalf without getSecret's workspace-first lookup — the
 *  account's mail sender for a workspace's notifications (notify.ts). */
export function accountSecretUsableIn(tenant: string, name: string, workspace: string): boolean {
  return usableIn(read(tenant)[name], workspace);
}

/**
 * Limit an account secret to some workspaces, or lift the limit (null).
 * An empty list means no workspace may use it. Returns the list as stored,
 * sorted, or null.
 *
 * `exists` is asked about each name under the vault lock (the API passes
 * "is there such a workspace"), so it cannot grant a name a delete has just
 * taken off every list. `ifWorkspaces`, when given, is the list the caller
 * saw (null: every workspace): a list changed since is refused (409), so
 * two admins editing it at once do not silently overwrite each other.
 *
 * The record is sealed (v2) whatever it was, whatever
 * FOLDRUN_VAULT_WRITE_BOUND says: a list in the clear on an unbound record
 * could be stripped on disk to open the secret to every workspace; sealed,
 * a stripped list makes it unreadable. Every reader since 29 Oct 2026 reads v2.
 */
export function setSecretWorkspaces(
  tenant: string,
  name: string,
  workspaces: string[] | null,
  opts: { exists?: (workspace: string) => boolean; ifWorkspaces?: string[] | null } = {},
): string[] | null {
  if (typeof name !== "string") throw new Error("a secret's name is a string");
  const clean = cleanWorkspaceList(workspaces);
  const expected = opts.ifWorkspaces === undefined ? undefined : cleanWorkspaceList(opts.ifWorkspaces);
  let found = false;
  mutateVault(tenant, undefined, (all) => {
    const rec = all[name];
    if (!rec) return null;
    found = true;
    if (expected !== undefined) {
      const now = Array.isArray(rec.workspaces) ? [...rec.workspaces].sort() : null;
      if (JSON.stringify(now) !== JSON.stringify(expected)) {
        throw Object.assign(new Error(`${name}'s workspaces changed since you loaded them (now ${now === null ? "every workspace" : now.length ? now.join(", ") : "none"}) — reload and try again`), { status: 409 });
      }
    }
    assertWorkspacesExist(clean, opts.exists);
    all[name] = withWorkspaces(tenant, name, rec, clean);
    return all;
  });
  if (!found) throw Object.assign(new Error(`no secret ${name} in the account`), { status: 404 });
  return clean;
}

/** An account record with its workspace list replaced (null: removed),
 *  opened and sealed again as a bound record with the new list in its seal.
 *  One that will not open is refused, never relabelled (setSecretSites). */
function withWorkspaces(tenant: string, name: string, rec: StoredSecret, workspaces: string[] | null): StoredSecret {
  const value = openRecord(tenant, undefined, name, rec);
  if (value === null) throw new Error(`${name} cannot be read with this install's keys — set its value again before changing its workspaces`);
  return sealRecord(tenant, undefined, name, value, { kind: rec.kind, sites: rec.sites, workspaces: workspaces ?? undefined, updatedAt: rec.updatedAt }, true);
}

/**
 * A workspace is being renamed (to: its new name) or deleted (to: null):
 * every account secret limited to it follows. Without this a rename quietly
 * cut the workspace off its secrets, and a delete left the name on the list
 * for the next workspace given it.
 *
 * `failed` names the records that hold the name but will not open with this
 * install's keys: they are left exactly as they are, so the old name is
 * STILL on their list — a key restored later would bring the grant back.
 * The caller must not report the rename or delete as clean while any are
 * left (the API refuses it, naming them: set them again, or delete them).
 *
 * Names, not ids: a grant naming a workspace's immutable id would survive a
 * rename untouched and could never pass to a new workspace given an old
 * name — the stronger design, not built yet (30 Oct 2026).
 */
export function retargetSecretWorkspaces(tenant: string, from: string, to: string | null): { changed: string[]; failed: string[] } {
  const changed: string[] = [];
  const failed: string[] = [];
  if (!inStore(tenant) && !fs.existsSync(secretsFile(tenant))) return { changed, failed };
  mutateVault(tenant, undefined, (all) => {
    changed.length = 0;
    failed.length = 0;
    const staged: typeof all = {};
    for (const [name, rec] of Object.entries(all)) {
      const list = rec.workspaces as unknown;
      if (list === undefined) continue;
      if (!Array.isArray(list)) {
        // A list rewritten on disk into something else allows nowhere
        // (usableIn) — nothing for this rename to carry.
        continue;
      }
      if (!list.includes(from)) continue;
      const next = [...new Set(list.map((w) => (w === from ? to : w)).filter((w): w is string => typeof w === "string"))].sort();
      try {
        staged[name] = withWorkspaces(tenant, name, rec, next);
        changed.push(name);
      } catch {
        failed.push(name);
      }
    }
    // All or nothing (Codex, 30 Oct 2026): writing the readable records and
    // refusing the rename for the unreadable ones moved grants to a name the
    // workspace never took. One failure leaves the vault exactly as it was.
    if (failed.length) {
      changed.length = 0;
      return null;
    }
    if (!changed.length) return null;
    Object.assign(all, staged);
    return all;
  });
  return { changed, failed };
}

export function deleteSecret(tenant: string, name: string, workspace?: string) {
  mutateVault(tenant, workspace, (all) => {
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
  /** An account secret limited to these workspaces; absent: every one. */
  workspaces?: string[];
}

// Metadata only — never values. Without a workspace this lists the account
// store; with one it lists what that workspace actually resolves, marking
// which scope each name comes from.
export function listSecrets(tenant: string, workspace?: string): SecretEntry[] {
  const records = Object.entries(read(tenant));
  const account = records
    // What a workspace resolves leaves out an account secret limited to
    // others: it is not set, as far as that workspace is concerned.
    .filter(([, rec]) => !workspace || usableIn(rec, workspace))
    .map(([name, rec]) => ({
      name,
      updatedAt: rec.updatedAt,
      scope: "account" as const,
      ...(rec.kind ? { kind: rec.kind } : {}),
      ...(rec.sites?.length ? { sites: [...rec.sites] } : {}),
      ...(!workspace && Array.isArray(rec.workspaces) ? { workspaces: [...rec.workspaces] } : {}),
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
  // Scopes in the platform's store have no file; they are named by where
  // the file would be (the result's `file` is a label, never opened).
  for (const workspace of vaultStore?.workspaces(tenant) ?? []) {
    if (!out.some((x) => x.workspace === workspace)) out.push({ file: secretsFile(tenant, workspace), workspace });
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

  for (const { file, workspace } of secretFiles(tenant)) {
    let count = 0;
    mutateVault(tenant, workspace, (all) => {
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
        // A bound record keeps its binding: same place, same AAD.
        let aad: Buffer | null = null;
        let plain: string;
        try {
          if (rec.v === 2) aad = vaultAad(tenant, workspace, name, rec);
          const d = crypto.createDecipheriv("aes-256-gcm", oldKey, Buffer.from(rec.iv, "base64"), GCM);
          d.setAuthTag(Buffer.from(rec.tag, "base64"));
          if (aad) d.setAAD(aad);
          plain = Buffer.concat([d.update(Buffer.from(rec.data, "base64")), d.final()]).toString("utf8");
        } catch {
          unreadable.push(name);
          next[name] = rec; // untouched
          continue;
        }
        const iv = crypto.randomBytes(12);
        const c = crypto.createCipheriv("aes-256-gcm", newKey, iv, GCM);
        if (aad) c.setAAD(aad);
        const enc = Buffer.concat([c.update(plain, "utf8"), c.final()]);
        next[name] = {
          iv: iv.toString("base64"),
          tag: c.getAuthTag().toString("base64"),
          data: enc.toString("base64"),
          updatedAt: rec.updatedAt, // rotation is not an edit
          // Kept: without it an oauth2 secret stops being refreshed after a
          // rotation, and a file/ssh/api secret stops being materialised.
          ...(rec.kind ? { kind: rec.kind } : {}),
          // Kept too (it was dropped until 29 Oct 2026): a rotation that
          // unbinds every bound secret puts their values into pods.
          ...(rec.sites?.length ? { sites: rec.sites } : {}),
          // And the workspaces it is limited to: dropped, it would read as
          // "every workspace" (and fail its seal).
          ...(rec.workspaces !== undefined ? { workspaces: rec.workspaces } : {}),
          ...(aad ? { v: 2 as const } : {}),
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
  /** How the client authenticates at the token endpoint (oauth-token.ts):
   *  absent is the form body, with the secret when there is one. */
  token_auth?: TokenAuth;
  /** Plain fields the provider returned beside the first token (Salesforce's
   *  instance_url) — kept with the recipe, never a credential. */
  fields?: Record<string, string>;
  /** The provider's revocation endpoint (RFC 7009): deleting or replacing
   *  this secret revokes its tokens there (revokeOAuth2). */
  revocation_url?: string;
  /** token_auth private_key_jwt: the private key (PEM or JWK) the client
   *  signs its assertions with, sealed with the rest of the recipe; its kid,
   *  alg, and certificate when the provider names keys by it (Entra). */
  client_assertion_key?: string;
  client_assertion_kid?: string;
  client_assertion_alg?: AssertionAlg;
  client_assertion_cert?: string;
  /** DPoP (RFC 9449): this connection's own key; token requests and the
   *  calls that use its token carry proofs signed with it (oauth-dpop.ts). */
  dpop_key?: string;
  /** tls_client_auth (RFC 8705): the client certificate and key presented
   *  to the token URL — and, through the egress proxy, on the calls its
   *  certificate-bound token is used for. */
  tls_client_cert?: string;
  tls_client_key?: string;
  tls_client_passphrase?: string;
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
  limit: SecretLimit = {},
) {
  for (const field of ["token_url", "client_id"] as const) {
    if (!config[field]?.trim()) throw new Error(`oauth2 secret needs ${field}`);
  }
  // A public client (PKCE, no secret) refreshes with its client id alone;
  // client credentials are nothing without the secret.
  // Client credentials need a proof of the client: a secret, a signing key or a certificate.
  if (config.grant_type === "client_credentials" && !config.client_secret?.trim() && !["private_key_jwt", "tls_client_auth", "self_signed_tls_client_auth"].includes(config.token_auth ?? "")) {
    throw new Error("oauth2 secret needs client_secret for client_credentials (or token_auth private_key_jwt with a key, or tls_client_auth with a certificate)");
  }
  if (config.grant_type !== "client_credentials" && !config.refresh_token?.trim()) {
    throw new Error("oauth2 secret needs refresh_token (or grant_type: client_credentials)");
  }
  if (config.revocation_url !== undefined && (typeof config.revocation_url !== "string" || !isSecureUrl(config.revocation_url))) {
    throw new Error("revocation_url must be https");
  }
  const authProblem = tokenAuthProblem(config);
  if (authProblem) throw new Error(`oauth2 secret: ${authProblem}`);
  // Loopback is exempt: a token endpoint on this same machine (tests, a
  // local mock, a sidecar) crosses no wire for http to leak on.
  if (!isSecureUrl(config.token_url)) {
    throw new Error("token_url must be https — a refresh token over http is a leaked one");
  }
  setSecret(tenant, name, OAUTH2_PREFIX + JSON.stringify(config), workspace, "oauth2", limit);
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
export function tokenCacheKey(kind: "oauth2" | "sa" | "tx", storedValue: string, tenant?: string): string {
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
    mutateVault(tenant, scope, (all) => {
      const rec = all[name];
      if (rec && openRecord(tenant, scope, name, rec) === usedValue) {
        // Built whole, not spread over the old record: a spread kept a stale
        // `k: "tenant"` when this seal fell back to the install key, and the
        // record then opened with neither.
        all[name] = sealRecord(tenant, scope, name, next, { kind: rec.kind, sites: rec.sites, workspaces: rec.workspaces }, rec.v === 2 || writeBound());
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
    // One builder for every token request (oauth-token.ts): the client's
    // identity goes where its token_auth says, and an `extra` cannot set it.
    // Built per try: a private_key_jwt assertion's jti is good once, so a
    // retry after a lost answer must carry a new one (Codex review).
    const build = () => oauthTokenRequest(config, {
      grant_type: config.grant_type ?? "refresh_token",
      ...(config.grant_type === "client_credentials" ? {} : { refresh_token: config.refresh_token! }),
      ...(config.extra ?? {}),
    }, { audience: config.token_url });
    build(); // a config that cannot make a request says so before any network
    // A network blip is retried; a provider's answer is not. "fetch failed"
    // (a reset, a DNS hiccup, a timeout) failed whole steps on the first try
    // — gbp-desk's Thursday posts, 7 Oct 2026. A 4xx (revoked, wrong client)
    // will say the same thing again, so it goes straight to the error below
    // and the reconnect mail; a 5xx or 429 is the provider busy, retried.
    let res: Response | undefined;
    let lastNetwork: unknown;
    let text = "";
    // A certificate-authenticated client (RFC 8705) presents it on the connection.
    const clientCert = config.tls_client_cert && config.tls_client_key
      ? { cert: config.tls_client_cert, key: config.tls_client_key, ...(config.tls_client_passphrase ? { passphrase: config.tls_client_passphrase } : {}) }
      : undefined;
    let nonceRetried = false;
    for (let attempt = 0; attempt < OAUTH_REFRESH_TRIES; attempt++) {
      if (attempt) await new Promise((r) => setTimeout(r, oauthRetryDelayMs(attempt)));
      try {
        const request = build();
        // DPoP: a fresh proof per try, with the server's nonce when it gave one.
        const headers = config.dpop_key
          ? { ...request.headers, dpop: dpopProof(config.dpop_key, { htm: "POST", htu: config.token_url, ...(dpopNonceFor(config.token_url, config.dpop_key) ? { nonce: dpopNonceFor(config.token_url, config.dpop_key) } : {}) }) }
          : request.headers;
        res = await fetchUntrusted(config.token_url, {
          method: "POST",
          headers,
          body: request.body,
          signal: AbortSignal.timeout(15_000),
          // A DPoP proof names this URL and method: a redirect would carry it
          // somewhere it is not for, so none is followed (Codex review).
        }, { sameOrigin: true, ...(clientCert ? { clientCert } : {}), ...(config.dpop_key ? { noRedirects: true } : {}) });
      } catch (err) {
        lastNetwork = err;
        res = undefined;
        continue;
      }
      // Read before deciding to retry: the last answer's own words are the
      // error a person sees when every try is busy (Codex review).
      text = await res.text().catch(() => "");
      if (res.status === 429 || res.status >= 500) continue;
      if (config.dpop_key) {
        noteDpopNonce(config.token_url, res, config.dpop_key);
        // The server wants a nonce in the proof (RFC 9449 §8): once more, at once.
        if (!nonceRetried && res.status === 400 && res.headers.get("dpop-nonce") && readTokenResponse(text, res.headers.get("content-type") ?? "").error === "use_dpop_nonce") {
          nonceRetried = true;
          attempt--;
          continue;
        }
      }
      break;
    }
    if (!res) throw lastNetwork instanceof Error ? lastNetwork : new Error(String(lastNetwork));
    // JSON or form-encoded, Slack's nested user token, expires_in as a string.
    const payload = readTokenResponse(text, res.headers.get("content-type") ?? "");
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

// ---------------------------------------------------------------- revocation

/** The oauth2 recipe stored at exactly this scope — never the account copy a
 *  workspace would fall back to: revoking is about the copy being removed. */
export function oauth2ValueAt(tenant: string, name: string, workspace?: string): string | null {
  const v = openRecord(tenant, workspace, name, read(tenant, workspace)[name]);
  return v !== null && isOAuth2Value(v) ? v : null;
}

/** The workspaces with a vault file of their own (current and legacy layout). */
function workspacesWithSecrets(tenant: string): string[] {
  const out = new Set<string>();
  for (const dir of ["workspaces", "projects"]) {
    const base = path.join(dataRoot(), tenant, dir);
    let names: string[] = [];
    try {
      names = fs.readdirSync(base);
    } catch {
      continue;
    }
    for (const n of names) if (fs.existsSync(path.join(base, n, "secrets.json"))) out.add(n);
  }
  for (const n of vaultStore?.workspaces(tenant) ?? []) out.add(n);
  return [...out];
}

/**
 * Another stored secret of this account holds a grant revoking this one could
 * end: the same refresh token (a copy made by hand, or one rotation reached),
 * or any grant from the same app (token URL and client id). Providers such as
 * Google revoke every token of a user's grant to an app together, so deleting
 * the Ads connection would take down the Search Console one made with the
 * same app (Codex review, 1 Nov 2026). Such a grant is left alone.
 */
export function oauthGrantSharedElsewhere(tenant: string, name: string, workspace: string | undefined, refreshToken: string, app?: { token_url: string; client_id: string }): boolean {
  for (const scope of [undefined, ...workspacesWithSecrets(tenant)]) {
    for (const [other, rec] of Object.entries(read(tenant, scope))) {
      if (other === name && scope === workspace) continue;
      // By the value, not the optional kind tag: a recipe copied with a
      // plain setSecret is still one materializeSecrets refreshes.
      const v = openRecord(tenant, scope, other, rec);
      if (!v || !isOAuth2Value(v)) continue;
      try {
        const other = JSON.parse(v.slice(OAUTH2_PREFIX.length)) as OAuth2Config;
        if (other.refresh_token === refreshToken) return true;
        if (app && other.grant_type !== "client_credentials" && other.token_url === app.token_url && other.client_id === app.client_id) return true;
      } catch {
        continue;
      }
    }
  }
  return false;
}

/** What revoking an oauth2 secret's tokens came to. */
export interface OAuthRevokeResult {
  /** Nothing was asked: no revocation endpoint; another secret holds the
   *  same grant or one from the same app; the replacement is from the same
   *  app (a reconnect: revoking would end the new grant too at providers
   *  that revoke per app); or the stored recipe could not be read. */
  skipped?: "no-revocation-url" | "shared-grant" | "same-app" | "unreadable";
  /** The token types the provider accepted the revocation of. */
  revoked: ("refresh_token" | "access_token")[];
  /** Why one failed — reported, never a reason to keep a secret. */
  error?: string;
}

type RevokeFetcher = (url: string, init: RequestInit) => Promise<Response>;

/**
 * Revoke what an oauth2 recipe holds at its provider (RFC 7009): the refresh
 * token, then the access token this process has cached for it. The client
 * authenticates as at the token URL (its token_auth). A 200 is success —
 * the RFC answers 200 for a token already invalid too; anything else is
 * reported in `error`, and the next token is still tried. `replacement`: the
 * recipe taking this one's place; one from the same app (token URL and client
 * id) means nothing is revoked, since a provider that revokes per app would
 * end the new grant with the old.
 */
export async function revokeOAuth2Value(
  value: string,
  opts: { tenant?: string; name?: string; workspace?: string; fetcher?: RevokeFetcher; replacement?: { token_url: string; client_id: string } } = {},
): Promise<OAuthRevokeResult> {
  let config: OAuth2Config;
  try {
    config = JSON.parse(value.slice(OAUTH2_PREFIX.length)) as OAuth2Config;
  } catch {
    return { skipped: "unreadable", revoked: [] };
  }
  if (!config.revocation_url) return { skipped: "no-revocation-url", revoked: [] };
  if (opts.replacement && opts.replacement.token_url === config.token_url && opts.replacement.client_id === config.client_id) {
    return { skipped: "same-app", revoked: [] };
  }
  if (config.grant_type !== "client_credentials" && opts.tenant && opts.name
    && oauthGrantSharedElsewhere(opts.tenant, opts.name, opts.workspace, config.refresh_token ?? "", { token_url: config.token_url, client_id: config.client_id })) {
    return { skipped: "shared-grant", revoked: [] };
  }
  // No redirect is followed: a 3xx is not ok, so a revocation endpoint that
  // sends us to a login page is reported, never counted as revoked.
  // A certificate-authenticated client (RFC 8705) presents it here too.
  const clientCert = config.tls_client_cert && config.tls_client_key ? { cert: config.tls_client_cert, key: config.tls_client_key, ...(config.tls_client_passphrase ? { passphrase: config.tls_client_passphrase } : {}) } : undefined;
  const fetcher: RevokeFetcher = opts.fetcher ?? ((url, init) => fetchUntrusted(url, init, { sameOrigin: true, noRedirects: true, ...(clientCert ? { clientCert } : {}) }));
  const key = tokenCacheKey("oauth2", value, opts.tenant);
  const access = oauthCache.get(key)?.token;
  const tokens: ["refresh_token" | "access_token", string][] = [];
  if (config.grant_type !== "client_credentials" && config.refresh_token) tokens.push(["refresh_token", config.refresh_token]);
  if (access) tokens.push(["access_token", access]);
  const out: OAuthRevokeResult = { revoked: [] };
  for (const [hint, token] of tokens) {
    try {
      const request = oauthTokenRequest(config, { token, token_type_hint: hint }, { audience: config.token_url });
      const res = await fetcher(config.revocation_url, { method: "POST", headers: request.headers, body: request.body, redirect: "error", signal: AbortSignal.timeout(10_000) });
      if (res.ok) {
        await res.body?.cancel().catch(() => {});
        out.revoked.push(hint);
      } else {
        // Reported, and the next token is still tried: a provider that will
        // not revoke refresh tokens may still revoke the access token.
        const why = readTokenResponse(await res.text().catch(() => ""), res.headers.get("content-type") ?? "");
        out.error ??= `the provider refused to revoke the ${hint.replace("_", " ")} (${res.status}${why.error ? `: ${why.error_description ?? why.error}` : ""})`;
      }
    } catch (err) {
      out.error ??= `revoking the ${hint.replace("_", " ")} failed: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
  // Every entry serving that access token goes: after a rotation the same
  // token is cached under the recipe before and after it (Codex review).
  oauthCache.delete(key);
  if (access) for (const [k, v] of oauthCache) if (v.token === access) oauthCache.delete(k);
  return out;
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
  ctx?: {
    tenant: string;
    workspace?: string;
    /** A rotated refresh token goes here INSTEAD of the vault: a caller that
     *  cannot open the vault (the egress proxy without the install key)
     *  keeps it itself and has it written by a process that can. `next` is
     *  the stored value with the new refresh token. */
    onRotate?: (name: string, usedValue: string, next: string) => unknown;
  },
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
            if (ctx?.onRotate) await ctx.onRotate(name, value, next);
            else if (ctx) replaceOAuth2RefreshToken(ctx.tenant, name, ctx.workspace, value, live.rotated);
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
    } else if (value.startsWith(TOKEN_EXCHANGE_PREFIX)) {
      out[name] = await materializeTokenExchange(name, value, env, ctx);
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

/**
 * materializeSecrets for a tool that holds secrets for a whole step and
 * makes them live per call (the API tools, the a2a tools), on a host with
 * the vault.
 *
 * Two things the step's copy of a recipe cannot do alone. A provider that
 * rotates refresh tokens has spent the refresh token the step started with —
 * the runner materialised it at step start, and any refresh since spent its
 * successor — so an oauth2 recipe is read again from the vault as it is now
 * (and `env` updated in place, for the next call). And it is made live in
 * the account's scope, as the runner and the egress proxy do: the cached
 * access token is keyed by account, and a rotation is written back to the
 * vault by the compare-and-set above. Refreshing the starting recipe outside
 * that scope missed the cache and sent a spent refresh token: invalid_grant.
 *
 * No `scope` (inside a sandbox, where there is no vault and the values
 * crossed already made live): materializeSecrets as it was.
 */
export async function materializeCurrent(
  env: Record<string, string>,
  scope?: { tenant: string; workspace?: string } | null,
): Promise<Record<string, string>> {
  if (!scope?.tenant) return materializeSecrets(env);
  for (const [name, value] of Object.entries(env)) {
    if (typeof value !== "string" || !isOAuth2Value(value)) continue;
    const current = getSecret(scope.tenant, name, scope.workspace)?.value;
    if (current && isOAuth2Value(current)) env[name] = current;
  }
  return materializeSecrets(env, { tenant: scope.tenant, ...(scope.workspace ? { workspace: scope.workspace } : {}) });
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
  limit: SecretLimit = {},
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
  setSecret(tenant, name, SERVICE_ACCOUNT_PREFIX + JSON.stringify(stored), workspace, "service-account", limit);
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

export function setFileSecret(tenant: string, name: string, content: string, workspace?: string, limit: SecretLimit = {}) {
  if (!content) throw new Error("a file secret needs content");
  setSecret(tenant, name, FILE_PREFIX + content, workspace, "file", limit);
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

export function setSshSecret(tenant: string, name: string, config: SshConfig, workspace?: string, limit: SecretLimit = {}) {
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
  setSecret(tenant, name, SSH_PREFIX + JSON.stringify(stored), workspace, "ssh", limit);
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

export function setClientCertSecret(tenant: string, name: string, config: ClientCertConfig, workspace?: string, limit: SecretLimit = {}) {
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
  if (typeof name !== "string" || !SECRET_NAME.test(name)) throw new Error(`secret name "${name}" must be UPPER_SNAKE_CASE`);
  const plainCert = CLIENT_CERT_PREFIX + JSON.stringify(stored);
  // Written under the vault's own lock, with the binding checked in the same
  // step: a value set over a secret keeps its site binding, and a wildcard
  // one would present the certificate to a whole domain.
  const wanted = limitFor(workspace, limit);
  mutateVault(tenant, workspace, (all) => {
    const sites = all[name]?.sites;
    if (wanted !== undefined) assertWorkspacesExist(wanted, limit.exists);
    const workspaces = wanted !== undefined ? (wanted ?? undefined) : all[name]?.workspaces;
    if (sites?.some((site) => site.startsWith("*."))) {
      throw new Error(`${name} is bound to ${sites.join(", ")} — a client certificate is bound to exact hosts; unbind the wildcard first`);
    }
    all[name] = sealRecord(tenant, workspace, name, plainCert, { kind: "client-cert", sites, workspaces }, all[name]?.v === 2 || workspaces !== undefined || writeBound());
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

// ---------------------------------------------------------------- token exchange

// Token exchange (RFC 8693): a secret that is not a credential of its own but
// a recipe for one — present another secret's token (the subject) at a token
// endpoint and get back a narrower one: another audience, fewer scopes, a
// token a downstream service accepts. Cached like an oauth2 token; the
// subject is made live first, the same way it would be on its own.

export const TOKEN_EXCHANGE_GRANT = "urn:ietf:params:oauth:grant-type:token-exchange";
const ACCESS_TOKEN_TYPE = "urn:ietf:params:oauth:token-type:access_token";
const TOKEN_EXCHANGE_PREFIX = "@token-exchange ";

export interface TokenExchangeConfig {
  token_url: string;
  client_id: string;
  client_secret?: string;
  token_auth?: TokenAuth;
  client_assertion_key?: string;
  client_assertion_kid?: string;
  client_assertion_alg?: AssertionAlg;
  client_assertion_cert?: string;
  tls_client_cert?: string;
  tls_client_key?: string;
  tls_client_passphrase?: string;
  /** The secret whose live token is the subject: an oauth2 or service-account
   *  secret, or a static token. Declared beside this one, or found in the
   *  vault at the same scope. */
  subject_secret: string;
  /** Default urn:ietf:params:oauth:token-type:access_token. */
  subject_token_type?: string;
  requested_token_type?: string;
  audience?: string;
  resource?: string;
  scope?: string;
}

export function setTokenExchangeSecret(tenant: string, name: string, config: TokenExchangeConfig, workspace?: string, limit: SecretLimit = {}) {
  for (const field of ["token_url", "client_id", "subject_secret"] as const) {
    if (typeof config[field] !== "string" || !config[field].trim()) throw new Error(`a token-exchange secret needs ${field}`);
  }
  if (!SECRET_NAME.test(config.subject_secret)) throw new Error("subject_secret is a secret's name, UPPER_SNAKE_CASE");
  if (config.subject_secret === name) throw new Error("a token exchange cannot be its own subject");
  if (!isSecureUrl(config.token_url)) throw new Error("token_url must be https");
  for (const k of ["subject_token_type", "requested_token_type", "audience", "resource", "scope"] as const) {
    if (config[k] !== undefined && typeof config[k] !== "string") throw new Error(`${k} is a string`);
  }
  const authProblem = tokenAuthProblem(config);
  if (authProblem) throw new Error(`token-exchange secret: ${authProblem}`);
  setSecret(tenant, name, TOKEN_EXCHANGE_PREFIX + JSON.stringify(config), workspace, "token-exchange", limit);
}

export function isTokenExchangeValue(value: string): boolean {
  return value.startsWith(TOKEN_EXCHANGE_PREFIX);
}

const txCache = new Map<string, { token: string; expiresAt: number }>();
const txFlight = new Map<string, Promise<string>>();

async function materializeTokenExchange(
  name: string,
  value: string,
  env: Record<string, string>,
  ctx?: { tenant: string; workspace?: string },
): Promise<string> {
  let config: TokenExchangeConfig;
  try {
    config = JSON.parse(value.slice(TOKEN_EXCHANGE_PREFIX.length));
  } catch {
    throw new Error(`secret ${name}: stored token-exchange config is unreadable`);
  }
  // The subject: declared beside this secret, else the vault at this scope.
  const subjectName = config.subject_secret;
  let subjectValue: string | undefined = env[subjectName];
  if (subjectValue === undefined && ctx) subjectValue = getSecret(ctx.tenant, subjectName, ctx.workspace)?.value;
  if (subjectValue === undefined) throw new Error(`secret ${name}: its subject ${subjectName} is not set — declare it in secrets: beside ${name}`);
  if (isTokenExchangeValue(subjectValue)) throw new Error(`secret ${name}: its subject ${subjectName} is itself a token exchange — the subject must be a token`);
  // Only a token may be sent as the subject: a file, ssh key, header set,
  // certificate or identity recipe would hand its contents to the token
  // endpoint (Codex review).
  for (const p of [FILE_PREFIX, SSH_PREFIX, API_PREFIX, CLIENT_CERT_PREFIX, IDENTITY_PREFIX]) {
    if (subjectValue.startsWith(p)) throw new Error(`secret ${name}: its subject ${subjectName} is a ${p.slice(1).trim()} secret — the subject must be a token (an oauth2, service-account or plain token secret)`);
  }
  // A subject bound to sites goes to those sites alone: an exchange whose
  // token URL is not one of them would carry it elsewhere (Codex review).
  if (ctx) {
    const bound = secretSites(ctx.tenant, [subjectName], ctx.workspace)[subjectName] ?? [];
    const host = new URL(config.token_url).host;
    if (bound.length && !bound.some((site) => siteCovers(site, host))) {
      throw new Error(`secret ${name}: its subject ${subjectName} is bound to ${bound.join(", ")} — the exchange's token URL (${host}) is not one of them; bind the subject to it too`);
    }
  }
  const subjectToken = (await materializeSecrets({ [subjectName]: subjectValue }, ctx))[subjectName];
  // Cached by the recipe and the subject token: a new subject is a new exchange.
  const key = tokenCacheKey("tx", `${value}\n${crypto.createHash("sha256").update(subjectToken).digest("hex")}`, ctx?.tenant);
  const hit = txCache.get(key);
  if (hit && hit.expiresAt > Date.now()) return hit.token;
  const pending = txFlight.get(key);
  if (pending) return pending;
  const flight = (async () => {
    const clientCert = config.tls_client_cert && config.tls_client_key ? { cert: config.tls_client_cert, key: config.tls_client_key, ...(config.tls_client_passphrase ? { passphrase: config.tls_client_passphrase } : {}) } : undefined;
    const request = oauthTokenRequest(config, {
      grant_type: TOKEN_EXCHANGE_GRANT,
      subject_token: subjectToken,
      subject_token_type: config.subject_token_type ?? ACCESS_TOKEN_TYPE,
      ...(config.requested_token_type ? { requested_token_type: config.requested_token_type } : {}),
      ...(config.audience ? { audience: config.audience } : {}),
      ...(config.resource ? { resource: config.resource } : {}),
      ...(config.scope ? { scope: config.scope } : {}),
    }, { audience: config.token_url });
    const res = await fetchUntrusted(config.token_url, { method: "POST", headers: request.headers, body: request.body, signal: AbortSignal.timeout(15_000) }, { sameOrigin: true, ...(clientCert ? { clientCert } : {}) });
    const payload = readTokenResponse(await res.text().catch(() => ""), res.headers.get("content-type") ?? "");
    if (!res.ok || !payload.access_token) {
      throw new Error(`secret ${name}: the token exchange was refused (${res.status}): ${payload.error_description ?? payload.error ?? "no access_token in the reply"}`);
    }
    // Never cached past its life: a minute short of it, or half a short life.
    const life = payload.expires_in ?? 3600;
    const ttl = Math.max(0, life - Math.min(60, life / 2)) * 1000;
    const now = Date.now();
    for (const [k, v] of txCache) if (v.expiresAt <= now) txCache.delete(k);
    txCache.set(key, { token: payload.access_token, expiresAt: now + ttl });
    return payload.access_token;
  })();
  txFlight.set(key, flight);
  try {
    return await flight;
  } finally {
    txFlight.delete(key);
  }
}

export function setIdentitySecret(tenant: string, name: string, config: IdentityConfig, workspace?: string, limit: SecretLimit = {}) {
  const audience = typeof config.audience === "string" ? config.audience.trim() : "";
  if (!audience) throw new Error("an identity needs an audience — the value your cloud's trust expects in aud");
  if (audience.length > 600 || /[\u0000-\u001f\u007f]/.test(audience)) throw new Error("audience is one value, at most 600 characters, no control characters");
  setSecret(tenant, name, IDENTITY_PREFIX + JSON.stringify({ audience }), workspace, "identity", limit);
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

export function setApiSecret(tenant: string, name: string, config: ApiConfig, workspace?: string, limit: SecretLimit = {}) {
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
    workspace, "api", limit,
  );
}

export function isApiValue(value: string): boolean {
  return value.startsWith(API_PREFIX);
}

export function apiConfigOf(value: string): ApiConfig {
  return JSON.parse(value.slice(API_PREFIX.length));
}


/**
 * Seal every unbound record of an account for its place (v2). Run at boot
 * once the install writes bound records (FOLDRUN_VAULT_WRITE_BOUND=1), and by
 * scripts/seal-vault-bindings.mjs. Per file, all or nothing: every unbound
 * value is opened first, and a file holding one that will not open is left
 * exactly as it is and reported. Idempotent: bound records are skipped.
 */
export function sealVaultBindings(tenant: string): { sealed: number; unreadable: string[] } {
  assertSafeName(tenant, "tenant");
  let sealed = 0;
  const unreadable: string[] = [];
  for (const { workspace } of secretFiles(tenant)) {
    mutateVault(tenant, workspace, (all) => {
      const plain = new Map<string, string>();
      const bad: string[] = [];
      for (const [name, rec] of Object.entries(all)) {
        if (rec.v === 2) continue;
        const value = decrypt(tenant, rec);
        if (value === null) bad.push(workspace ? `${workspace}/${name}` : name);
        else plain.set(name, value);
      }
      unreadable.push(...bad);
      if (plain.size === 0 || bad.length) return null;
      const next: SecretsFile = { ...all };
      for (const [name, value] of plain) {
        const rec = all[name];
        next[name] = sealRecord(tenant, workspace, name, value, { kind: rec.kind, sites: rec.sites, workspaces: rec.workspaces, updatedAt: rec.updatedAt }, true);
      }
      sealed += plain.size;
      return next;
    });
  }
  return { sealed, unreadable };
}

/** Whether this install writes bound vault records (and migrates at boot). */
export const vaultWritesBound = writeBound;

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

  for (const { workspace } of secretFiles(tenant)) {
    // Under the vault's lock: every pod runs this at boot, and a save made
    // between our read and our write must not be lost.
    mutateVault(tenant, workspace, (all) => {
      const plain = new Map<string, string>();
      const unreadableHere: string[] = [];
      for (const [name, rec] of Object.entries(all)) {
        if (rec.k === "tenant") continue; // already moved
        const value = openRecord(tenant, workspace, name, rec);
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
        next[name] = sealRecord(tenant, workspace, name, value, { kind: all[name].kind, sites: all[name].sites, workspaces: all[name].workspaces, updatedAt: all[name].updatedAt }, all[name].v === 2 || writeBound());
      }
      moved += plain.size;
      return next;
    });
  }
  return { moved, unreadable };
}
