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
      // Compare-and-set, as the Postgres store does it: another writer in
      // between means the change is made again against what is stored now.
      for (;;) {
        const before = JSON.stringify(scopes.get(key(t, w)) ?? {});
        const next = change(structuredClone(JSON.parse(before)));
        if (JSON.stringify(scopes.get(key(t, w)) ?? {}) !== before) continue;
        if (next === null) return JSON.parse(before);
        scopes.set(key(t, w), structuredClone(next));
        return next;
      }
    },
    workspaces: (t) => [...scopes.keys()].filter((k) => k.startsWith(`${t}|`) && !k.endsWith("|")).map((k) => k.slice(t.length + 1)),
  };
}

/** A store that can be made to lose a race or to refuse, whatever the store
 *  behind it: `interleave(fn)` runs `fn` (another writer, through the same
 *  functions) once, after the next change was handed what is stored and before
 *  it commits, so a compare-and-set store must read again and run the change
 *  a second time. `refuse(err)` makes every read and change throw. */
export type RacingStore = VaultStore & { interleave(fn: () => void): void; refuse(err: Error | null): void };

export function racing(store: VaultStore): RacingStore {
  let pending: (() => void) | null = null;
  let refusing: Error | null = null;
  const refused = () => {
    if (refusing) throw refusing;
  };
  return {
    ...store,
    on: (t, w) => store.on(t, w),
    read(t, w) {
      refused();
      return store.read(t, w);
    },
    mutate(t, w, change) {
      refused();
      return store.mutate(t, w, (all) => {
        const run = pending;
        pending = null;
        run?.();
        return change(all);
      });
    },
    workspaces: (t) => store.workspaces(t),
    forget: store.forget ? (t, w) => store.forget!(t, w) : undefined,
    interleave: (fn) => void (pending = fn),
    refuse: (err) => void (refusing = err),
  };
}

let n = 0;

/** `make` returns the store to register, or null for files. `mirrors`: the
 *  store also keeps the scope's file current, so files may appear. */
export function vaultContract(label: string, make: () => Promise<VaultStore | null> | VaultStore | null, opts: { mirrors?: boolean } = {}): void {
  const t = (name: string, fn: (s: typeof import("../src/secrets.ts"), T: string, store: RacingStore | null, data: string) => Promise<void> | void) =>
    test(`vault [${label}]: ${name}`, async () => {
      const data = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-vault-contract-"));
      const prev = { data: process.env.FOLDRUN_DATA, key: process.env.FOLDRUN_SECRET_KEY, bound: process.env.FOLDRUN_VAULT_WRITE_BOUND };
      process.env.FOLDRUN_DATA = data;
      process.env.FOLDRUN_SECRET_KEY = "contract-install-key";
      process.env.FOLDRUN_VAULT_WRITE_BOUND = "1";
      const s = await import("../src/secrets.ts");
      const made = await make();
      const store = made ? racing(made) : null;
      s.setVaultStore(store);
      const T = `vc${Date.now().toString(36)}${n++}`;
      try {
        await fn(s, T, store, data);
        if (store && !opts.mirrors) {
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

  const CANARY = (k: string) => `canary-${k}-9f3a7c2e41b8`;
  const OA = { token_url: "https://idp.example.com/token", client_id: "cid", refresh_token: "rt-0" };
  /** What a call said (console, stdout, stderr) and threw, as one string. */
  const watching = (fn: () => void): string => {
    const said: string[] = [];
    const saved = { log: console.log, info: console.info, warn: console.warn, error: console.error, out: process.stdout.write, err: process.stderr.write };
    const take = (...a: unknown[]) => void said.push(a.map(String).join(" "));
    console.log = console.info = console.warn = console.error = take;
    process.stdout.write = ((c: unknown) => (said.push(String(c)), true)) as typeof process.stdout.write;
    process.stderr.write = ((c: unknown) => (said.push(String(c)), true)) as typeof process.stderr.write;
    try {
      fn();
    } catch (err) {
      said.push(String((err as Error)?.stack ?? err));
    } finally {
      Object.assign(console, { log: saved.log, info: saved.info, warn: saved.warn, error: saved.error });
      process.stdout.write = saved.out;
      process.stderr.write = saved.err;
    }
    return said.join("\n");
  };

  t("a refresh token is replaced only while the copy still holds the value the refresh used", (s, T) => {
    s.setOAuth2Secret(T, "REFRESHED", OA);
    const used = s.getSecret(T, "REFRESHED")!.value;
    assert.equal(s.replaceOAuth2RefreshToken(T, "REFRESHED", undefined, used, "rt-1"), true);
    assert.ok(s.getSecret(T, "REFRESHED")!.value.includes("rt-1"));
    assert.equal(s.replaceOAuth2RefreshToken(T, "REFRESHED", undefined, used, "rt-late"), false, "a refresh that started from the old value loses");
    assert.ok(s.getSecret(T, "REFRESHED")!.value.includes("rt-1") && !s.getSecret(T, "REFRESHED")!.value.includes("rt-late"));
    assert.equal(s.replaceOAuth2RefreshToken(T, "NOT_THERE", undefined, used, "rt-x"), false);
  });

  t("a workspace's copy is replaced before the account's, and only the copy the refresh used", (s, T) => {
    s.setOAuth2Secret(T, "SHARED_OA", OA);
    s.setOAuth2Secret(T, "SHARED_OA", OA, "desk");
    const used = s.getSecret(T, "SHARED_OA", "desk")!.value;
    assert.equal(s.replaceOAuth2RefreshToken(T, "SHARED_OA", "desk", used, "rt-desk"), true);
    assert.ok(s.getSecret(T, "SHARED_OA", "desk")!.value.includes("rt-desk"));
    assert.ok(!s.getSecret(T, "SHARED_OA")!.value.includes("rt-desk"), "the account's copy is not touched when the workspace's was the one used");
  });

  const storeTest = (name: string, fn: (s: typeof import("../src/secrets.ts"), T: string, store: RacingStore) => void) =>
    t(name, (s, T, store) => {
      if (!store) return; // files have no second writer between a read and a write: the lock excludes it
      fn(s, T, store);
    });

  storeTest("a change that loses a race is made again, and what it reports is about the retry", (s, T, store) => {
    // refresh: the other writer replaces the same token first, so ours is lost
    s.setOAuth2Secret(T, "RACE_OA", OA);
    const used = s.getSecret(T, "RACE_OA")!.value;
    store.interleave(() => assert.equal(s.replaceOAuth2RefreshToken(T, "RACE_OA", undefined, used, "rt-other"), true));
    assert.equal(s.replaceOAuth2RefreshToken(T, "RACE_OA", undefined, used, "rt-mine"), false, "the first read matched, the retry did not");
    assert.ok(s.getSecret(T, "RACE_OA")!.value.includes("rt-other") && !s.getSecret(T, "RACE_OA")!.value.includes("rt-mine"));

    // sites: found on the first read, deleted by the other writer, gone on the retry
    s.setSecret(T, "SITE_RACE", "v");
    store.interleave(() => s.deleteSecret(T, "SITE_RACE"));
    assert.throws(() => s.setSecretSites(T, "SITE_RACE", ["a.example.com"]), /no secret SITE_RACE/);

    // workspaces: the same
    s.setSecret(T, "WS_RACE", "v");
    store.interleave(() => s.deleteSecret(T, "WS_RACE"));
    assert.throws(() => s.setSecretWorkspaces(T, "WS_RACE", ["desk"]), /no secret WS_RACE/);
  });

  storeTest("two writers to one scope both land", (s, T, store) => {
    s.setSecret(T, "FIRST_KEY", "f");
    store.interleave(() => s.setSecret(T, "RACER_KEY", "r"));
    s.setSecret(T, "SECOND_KEY", "s");
    assert.deepEqual(s.listSecrets(T).map((e) => e.name).sort(), ["FIRST_KEY", "RACER_KEY", "SECOND_KEY"]);
    assert.equal(s.getSecret(T, "SECOND_KEY")?.value, "s");
  });

  storeTest("a rotation, a seal and a retarget count each secret once, though a change ran twice", (s, T, store) => {
    s.setSecret(T, "ROT_ONE", "one");
    s.setSecret(T, "ROT_TWO", "two");
    store.interleave(() => s.setSecret(T, "ROT_THREE", "three"));
    const r = s.rotateMasterKey(T, "contract-install-key", "next-install-key");
    assert.equal(r.rewritten.reduce((a, x) => a + x.secrets, 0), 3, "what was stored when the rotation committed, not the sum of two tries");
    assert.deepEqual(r.unreadable, []);
    process.env.FOLDRUN_SECRET_KEY = "next-install-key";

    // seal: unbound records made with the switch off, then sealed with one racer in between
    delete process.env.FOLDRUN_VAULT_WRITE_BOUND;
    s.setSecret(T, "SEAL_ONE", "one");
    s.setSecret(T, "SEAL_TWO", "two");
    store.interleave(() => s.setSecret(T, "SEAL_THREE", "three"));
    const sealed = s.sealVaultBindings(T);
    assert.deepEqual(sealed, { sealed: 3, unreadable: [] });
    process.env.FOLDRUN_VAULT_WRITE_BOUND = "1";

    // retarget: all or nothing, and the lists are those of the committed run
    s.setSecret(T, "LIST_ONE", "a");
    s.setSecretWorkspaces(T, "LIST_ONE", ["desk"]);
    store.interleave(() => {
      s.setSecret(T, "LIST_TWO", "b");
      s.setSecretWorkspaces(T, "LIST_TWO", ["desk"]);
    });
    assert.deepEqual(s.retargetSecretWorkspaces(T, "desk", "bureau").changed.sort(), ["LIST_ONE", "LIST_TWO"]);
  });

  storeTest("a store that refuses is an error, never a stale read or a write to a file", (s, T, store) => {
    s.setSecret(T, "LIVE_KEY", "v");
    store.refuse(new Error("the records database did not answer"));
    assert.throws(() => s.getSecret(T, "LIVE_KEY"), /did not answer/);
    assert.throws(() => s.setSecret(T, "LIVE_KEY", "v2"), /did not answer/);
    assert.throws(() => s.deleteSecret(T, "LIVE_KEY"), /did not answer/);
    assert.throws(() => s.listSecrets(T), /did not answer/);
    store.refuse(null);
    assert.equal(s.getSecret(T, "LIVE_KEY")?.value, "v", "nothing was half-written");
  });

  t("canary: no value reaches a log line, an error, a listing, a report or a row in the clear", (s, T, store, data) => {
    const values = ["one", "two", "three", "four", "five", "six"].map(CANARY);
    const seen: string[] = [];
    const run = (fn: () => unknown) => seen.push(watching(() => void fn()));
    run(() => s.setSecret(T, "CANARY_ONE", values[0]));
    run(() => s.setSecret(T, "CANARY_TWO", values[1], "desk"));
    run(() => s.setOAuth2Secret(T, "CANARY_OA", { token_url: "https://idp.example.com/token", client_id: "cid", client_secret: values[2], refresh_token: values[3] }));
    run(() => s.setSecretSites(T, "CANARY_ONE", ["api.example.com"]));
    run(() => s.setSecretSites(T, "CANARY_ONE", ["a.example.com", "b example"])); // refused
    run(() => s.setSecret(T, "bad name", values[5])); // refused: the error names the name, not the value
    run(() => s.setSecret(T, "CANARY_LONG", values[0] + "x".repeat(9000))); // refused
    run(() => s.getSecret(T, "CANARY_ONE", "desk"));
    run(() => s.resolveSecrets(T, ["CANARY_ONE", "CANARY_TWO", "MISSING_KEY"], "desk"));
    run(() => s.listSecrets(T, "desk"));
    run(() => s.replaceOAuth2RefreshToken(T, "CANARY_OA", undefined, s.getSecret(T, "CANARY_OA")!.value, values[5]));
    // a wrong key: unreadable reads as not set, and says so without a value
    const keep = process.env.FOLDRUN_SECRET_KEY;
    process.env.FOLDRUN_SECRET_KEY = "someone-elses-key";
    run(() => s.getSecret(T, "CANARY_ONE"));
    run(() => s.rotateMasterKey(T, "someone-elses-key", "a-third-key"));
    process.env.FOLDRUN_SECRET_KEY = keep;
    run(() => s.sealVaultBindings(T));
    seen.push(JSON.stringify(s.listSecrets(T, "desk")), JSON.stringify(s.rotateMasterKey(T, "contract-install-key", "contract-install-key-2")));
    process.env.FOLDRUN_SECRET_KEY = "contract-install-key-2";
    if (store) {
      store.refuse(new Error("boom"));
      run(() => s.getSecret(T, "CANARY_ONE"));
      run(() => s.setSecret(T, "CANARY_ONE", values[0]));
      store.refuse(null);
      seen.push(JSON.stringify(store.read(T)), JSON.stringify(store.read(T, "desk")));
    }
    const walk = (d: string) => fs.existsSync(d) && fs.readdirSync(d, { withFileTypes: true }).forEach((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : e.name.startsWith("secrets.json") && seen.push(fs.readFileSync(path.join(d, e.name), "utf8"))));
    walk(path.join(data, T));
    const all = seen.join("\n");
    for (const v of values) assert.ok(!all.includes(v), `a canary value leaked: ${v.slice(0, 12)}…`);
    assert.ok(!all.includes(Buffer.from(values[0]).toString("base64")), "nor its base64");
    assert.ok(!all.includes("someone-elses-key") && !all.includes("contract-install-key"), "nor a key");
  });
}
