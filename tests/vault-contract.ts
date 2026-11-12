// The vault's contract, wherever a scope lives (FOL-126 phase 6): the same
// behaviours against secrets.json files and against a registered store.
// tests/vault-contract-local.test.ts runs it on files and on an in-memory
// store; foldrun-platform runs it on the Postgres store.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { SecretsFile, VaultStore } from "../src/secrets.ts";

/** A store over a Map, with mutateVaultFile's semantics (one process). */
export function memoryVaultStore(): VaultStore & { scopes: Map<string, SecretsFile> } {
  const scopes = new Map<string, SecretsFile>();
  const key = (t: string, w?: string) => `${t}|${w ?? ""}`;
  return {
    scopes,
    on: () => true,
    read: (t, w) => structuredClone(scopes.get(key(t, w)) ?? {}),
    mutate(t, w, change) {
      const current = scopes.get(key(t, w)) ?? {};
      const next = change(structuredClone(current));
      if (next === null) return current;
      scopes.set(key(t, w), structuredClone(next));
      return next;
    },
    workspaces: (t) => [...scopes.keys()].filter((k) => k.startsWith(`${t}|`) && !k.endsWith("|")).map((k) => k.slice(t.length + 1)),
  };
}

let n = 0;

/** `make` returns the store to register, or null for files. `filesExpected`:
 *  whether a secrets.json may appear under the data root. */
export function vaultContract(label: string, make: () => Promise<VaultStore | null> | VaultStore | null): void {
  const t = (name: string, fn: (s: typeof import("../src/secrets.ts"), T: string, store: VaultStore | null, data: string) => Promise<void> | void) =>
    test(`vault [${label}]: ${name}`, async () => {
      const data = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-vault-contract-"));
      const prev = { data: process.env.FOLDRUN_DATA, key: process.env.FOLDRUN_SECRET_KEY, bound: process.env.FOLDRUN_VAULT_WRITE_BOUND };
      process.env.FOLDRUN_DATA = data;
      process.env.FOLDRUN_SECRET_KEY = "contract-install-key";
      process.env.FOLDRUN_VAULT_WRITE_BOUND = "1";
      const s = await import("../src/secrets.ts");
      const store = await make();
      s.setVaultStore(store);
      const T = `vc${Date.now().toString(36)}${n++}`;
      try {
        await fn(s, T, store, data);
        if (store) {
          const files: string[] = [];
          const walk = (d: string) => fs.existsSync(d) && fs.readdirSync(d, { withFileTypes: true }).forEach((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : e.name.startsWith("secrets.json") && files.push(e.name)));
          walk(path.join(data, T));
          assert.deepEqual(files, [], "a scope in the store writes no vault file");
        }
      } finally {
        s.setVaultStore(null);
        for (const [k, v] of [["FOLDRUN_DATA", prev.data], ["FOLDRUN_SECRET_KEY", prev.key], ["FOLDRUN_VAULT_WRITE_BOUND", prev.bound]] as const) v === undefined ? delete process.env[k] : (process.env[k] = v);
        fs.rmSync(data, { recursive: true, force: true });
      }
    });

  t("a value set is read back, listed without its value, replaced, and deleted", (s, T) => {
    s.setSecret(T, "API_KEY", "v1");
    assert.equal(s.getSecret(T, "API_KEY")?.value, "v1");
    assert.deepEqual(s.listSecrets(T).map((e) => [e.name, e.scope]), [["API_KEY", "account"]]);
    assert.ok(!JSON.stringify(s.listSecrets(T)).includes("v1"));
    s.setSecret(T, "API_KEY", "v2");
    assert.equal(s.getSecret(T, "API_KEY")?.value, "v2");
    s.deleteSecret(T, "API_KEY");
    assert.equal(s.getSecret(T, "API_KEY"), null);
    assert.deepEqual(s.listSecrets(T), []);
  });

  t("a workspace's secret shadows the account's there and nowhere else", (s, T) => {
    s.setSecret(T, "TOKEN", "account");
    s.setSecret(T, "TOKEN", "desk-own", "desk");
    assert.equal(s.getSecret(T, "TOKEN", "desk")?.value, "desk-own");
    assert.equal(s.getSecret(T, "TOKEN", "other")?.value, "account");
    assert.equal(s.getSecret(T, "TOKEN")?.value, "account");
    s.deleteSecret(T, "TOKEN", "desk");
    assert.equal(s.getSecret(T, "TOKEN", "desk")?.value, "account", "the account's shows through again");
  });

  t("what is stored is sealed: no scope holds the value in the clear", (s, T, store, data) => {
    s.setSecret(T, "API_KEY", "plain-text-value-123");
    const stored = store ? JSON.stringify(store.read(T)) : fs.readFileSync(path.join(data, T, "secrets.json"), "utf8");
    assert.ok(stored.includes("API_KEY") && !stored.includes("plain-text-value-123"));
  });

  t("sites and workspace limits survive a new value, and a limit hides the secret elsewhere", (s, T) => {
    s.setSecret(T, "CRM", "one");
    s.setSecretSites(T, "CRM", ["api.example.com"]);
    s.setSecretWorkspaces(T, "CRM", ["desk"]);
    s.setSecret(T, "CRM", "two");
    assert.deepEqual(s.secretSites(T, ["CRM"]), { CRM: ["api.example.com"] });
    assert.equal(s.accountSecretUsableIn(T, "CRM", "desk"), true);
    assert.equal(s.accountSecretUsableIn(T, "CRM", "other"), false);
    assert.equal(s.getSecret(T, "CRM", "desk")?.value, "two");
    assert.equal(s.getSecret(T, "CRM", "other"), null);
  });

  t("a workspace renamed or deleted is followed on every account secret's list, all or nothing", (s, T) => {
    s.setSecret(T, "KEY_A", "a");
    s.setSecret(T, "KEY_B", "b");
    s.setSecretWorkspaces(T, "KEY_A", ["desk", "lab"]);
    s.setSecretWorkspaces(T, "KEY_B", ["desk"]);
    assert.deepEqual(s.retargetSecretWorkspaces(T, "desk", "bureau").changed.sort(), ["KEY_A", "KEY_B"]);
    assert.equal(s.accountSecretUsableIn(T, "KEY_A", "bureau"), true);
    assert.equal(s.accountSecretUsableIn(T, "KEY_B", "desk"), false);
    s.retargetSecretWorkspaces(T, "bureau", null);
    assert.equal(s.accountSecretUsableIn(T, "KEY_A", "lab"), true);
    assert.equal(s.accountSecretUsableIn(T, "KEY_B", "bureau"), false, "a list that would be empty stays closed, not open to all");
    assert.equal(s.getSecret(T, "KEY_A", "lab")?.value, "a", "values untouched by the rename");
  });

  t("rotating the install key re-seals every scope, the workspaces' too", (s, T) => {
    s.setSecret(T, "ACC", "account-value");
    s.setSecret(T, "WS", "desk-value", "desk");
    const r = s.rotateMasterKey(T, "contract-install-key", "next-install-key");
    assert.deepEqual(r.unreadable, []);
    assert.equal(r.rewritten.reduce((a, x) => a + x.secrets, 0), 2);
    process.env.FOLDRUN_SECRET_KEY = "next-install-key";
    assert.equal(s.getSecret(T, "ACC")?.value, "account-value");
    assert.equal(s.getSecret(T, "WS", "desk")?.value, "desk-value");
  });

  t("a change that decides to do nothing writes nothing", (s, T, store) => {
    s.setSecret(T, "KEEP", "v");
    const before = store ? JSON.stringify(store.read(T)) : null;
    s.deleteSecret(T, "NOT_THERE");
    if (store) assert.equal(JSON.stringify(store.read(T)), before);
    assert.equal(s.getSecret(T, "KEEP")?.value, "v");
  });
}
