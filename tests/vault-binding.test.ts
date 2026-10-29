// Vault records sealed for their place (v2): moving a ciphertext to another
// name, scope or account, or rewriting its clear `sites`, makes it fail to
// open — it reads as "not set", never as unbound (OWASP review, 29 Oct 2026).
//
//   node --test tests/vault-binding.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const data = fs.mkdtempSync(path.join(os.tmpdir(), "vault-bind-"));
process.env.FOLDRUN_DATA = data;
process.env.FOLDRUN_SECRET_KEY = "test-install-key";
for (const t of ["acme", "other"]) fs.mkdirSync(path.join(data, t, "workspaces", "ops"), { recursive: true });
const s = await import("../src/secrets.ts");

const file = (tenant: string, ws?: string) =>
  ws ? path.join(data, tenant, "workspaces", ws, "secrets.json") : path.join(data, tenant, "secrets.json");
const readJson = (f: string) => JSON.parse(fs.readFileSync(f, "utf8"));
const writeJson = (f: string, v: unknown) => fs.writeFileSync(f, JSON.stringify(v));
const bound = <T>(fn: () => T): T => {
  process.env.FOLDRUN_VAULT_WRITE_BOUND = "1";
  try {
    return fn();
  } finally {
    delete process.env.FOLDRUN_VAULT_WRITE_BOUND;
  }
};

test("without the switch, records are written as before (an older pod can read them)", () => {
  s.setSecret("acme", "PLAIN_KEY", "v1");
  assert.equal(readJson(file("acme")).PLAIN_KEY.v, undefined);
  assert.equal(s.getSecret("acme", "PLAIN_KEY")?.value, "v1");
});

test("a bound record reads back, and keeps reading after its sites change", () => {
  bound(() => s.setSecret("acme", "API_KEY", "secret-1"));
  assert.equal(readJson(file("acme")).API_KEY.v, 2);
  assert.equal(s.getSecret("acme", "API_KEY")?.value, "secret-1");
  s.setSecretSites("acme", "API_KEY", ["api.example.com"]);
  assert.deepEqual(readJson(file("acme")).API_KEY.sites, ["api.example.com"]);
  assert.equal(s.getSecret("acme", "API_KEY")?.value, "secret-1");
});

test("a bound record moved under another name, scope or account does not open", () => {
  bound(() => s.setSecret("acme", "MOVE_ME", "secret-2"));
  const rec = readJson(file("acme")).MOVE_ME;
  const acct = readJson(file("acme"));
  acct.RENAMED = rec;
  writeJson(file("acme"), acct);
  assert.equal(s.getSecret("acme", "RENAMED"), null, "another name");
  writeJson(file("acme", "ops"), { MOVE_ME: rec });
  assert.equal(s.getSecret("acme", "MOVE_ME", "ops")?.scope, "account", "an account record moved into a workspace is not read there");
  writeJson(file("other"), { MOVE_ME: rec });
  assert.equal(s.getSecret("other", "MOVE_ME"), null, "another account");
});

test("rewriting a bound record's clear sites, kind or version makes it unreadable, not unbound", () => {
  bound(() => s.setSecret("acme", "BOUND_KEY", "secret-3"));
  s.setSecretSites("acme", "BOUND_KEY", ["api.example.com"]);
  const orig = readJson(file("acme")).BOUND_KEY;
  for (const tamper of [
    { ...orig, sites: { evil: true } },
    { ...orig, sites: 7 },
    { ...orig, sites: ["evil.example"] },
    (({ sites: _drop, ...rest }) => rest)(orig),
    { ...orig, kind: "oauth2" },
    (({ v: _drop, ...rest }) => rest)(orig),
  ]) {
    const all = readJson(file("acme"));
    all.BOUND_KEY = tamper;
    writeJson(file("acme"), all);
    assert.equal(s.getSecret("acme", "BOUND_KEY"), null);
  }
});

test("sealVaultBindings binds every old record, keeps sites and kind, and is idempotent", () => {
  fs.mkdirSync(path.join(data, "mig", "workspaces", "w1"), { recursive: true });
  s.setSecret("mig", "A_KEY", "a");
  s.setSecret("mig", "B_KEY", "b", "w1");
  s.setSecretSites("mig", "A_KEY", ["api.a.example"]);
  const first = s.sealVaultBindings("mig");
  assert.equal(first.sealed, 2);
  assert.deepEqual(first.unreadable, []);
  assert.equal(readJson(file("mig")).A_KEY.v, 2);
  assert.deepEqual(readJson(file("mig")).A_KEY.sites, ["api.a.example"]);
  assert.equal(readJson(file("mig", "w1")).B_KEY.v, 2);
  assert.equal(s.getSecret("mig", "A_KEY")?.value, "a");
  assert.equal(s.getSecret("mig", "B_KEY", "w1")?.value, "b");
  assert.equal(s.sealVaultBindings("mig").sealed, 0);
});

test("a file holding an unreadable record is left exactly as it was", () => {
  fs.mkdirSync(path.join(data, "half"), { recursive: true });
  s.setSecret("half", "GOOD_KEY", "g");
  const all = readJson(file("half"));
  all.BAD_KEY = { ...all.GOOD_KEY, data: Buffer.from("garbage").toString("base64") };
  writeJson(file("half"), all);
  const before = fs.readFileSync(file("half"), "utf8");
  const r = s.sealVaultBindings("half");
  assert.equal(r.sealed, 0);
  assert.deepEqual(r.unreadable, ["BAD_KEY"]);
  assert.equal(fs.readFileSync(file("half"), "utf8"), before);
});

test("strict mode refuses the old form", () => {
  s.setSecret("acme", "OLD_FORM", "o");
  process.env.FOLDRUN_VAULT_REQUIRE_BOUND = "1";
  try {
    assert.equal(s.getSecret("acme", "OLD_FORM"), null);
  } finally {
    delete process.env.FOLDRUN_VAULT_REQUIRE_BOUND;
  }
  assert.equal(s.getSecret("acme", "OLD_FORM")?.value, "o");
});

test("rotating the install key keeps sites and the binding (sites were dropped before)", () => {
  fs.mkdirSync(path.join(data, "rot"), { recursive: true });
  s.setSecret("rot", "OLD_BOUND", "x");
  s.setSecretSites("rot", "OLD_BOUND", ["api.x.example"]);
  bound(() => s.setSecret("rot", "NEW_BOUND", "y"));
  s.setSecretSites("rot", "NEW_BOUND", ["api.y.example"]);
  s.rotateMasterKey("rot", "test-install-key", "next-install-key");
  process.env.FOLDRUN_SECRET_KEY = "next-install-key";
  try {
    const all = readJson(file("rot"));
    assert.deepEqual(all.OLD_BOUND.sites, ["api.x.example"]);
    assert.deepEqual(all.NEW_BOUND.sites, ["api.y.example"]);
    assert.equal(all.NEW_BOUND.v, 2);
    assert.equal(s.getSecret("rot", "OLD_BOUND")?.value, "x");
    assert.equal(s.getSecret("rot", "NEW_BOUND")?.value, "y");
  } finally {
    process.env.FOLDRUN_SECRET_KEY = "test-install-key";
  }
});

test("renaming a workspace keeps its bound secrets readable under the new name", async () => {
  const store = await import("../src/store.ts");
  fs.mkdirSync(path.join(data, "ren", "workspaces", "before"), { recursive: true });
  bound(() => s.setSecret("ren", "WS_KEY", "w", "before"));
  store.renameWorkspace("ren", "before", "after");
  assert.equal(s.getSecret("ren", "WS_KEY", "after")?.value, "w");
  fs.mkdirSync(path.join(data, "ren", "workspaces", "taken"), { recursive: true });
  assert.throws(() => store.renameWorkspace("ren", "after", "taken"));
  assert.equal(s.getSecret("ren", "WS_KEY", "after")?.value, "w", "a refused rename leaves them as they were");
});

test("re-saving a bound secret with the switch off keeps it bound", () => {
  bound(() => s.setSecret("acme", "STAYS_BOUND", "a"));
  s.setSecret("acme", "STAYS_BOUND", "b");
  assert.equal(readJson(file("acme")).STAYS_BOUND.v, 2);
  assert.equal(s.getSecret("acme", "STAYS_BOUND")?.value, "b");
});

test("a process without the install key refuses to mint one", () => {
  const saved = process.env.FOLDRUN_SECRET_KEY;
  delete process.env.FOLDRUN_SECRET_KEY;
  process.env.FOLDRUN_INSTALL_KEY_ABSENT = "1";
  try {
    assert.throws(() => s.installKeyMaterial(), /FOLDRUN_INSTALL_KEY_ABSENT/);
    assert.equal(fs.existsSync(path.join(data, ".secret-key")), false);
  } finally {
    process.env.FOLDRUN_SECRET_KEY = saved;
    delete process.env.FOLDRUN_INSTALL_KEY_ABSENT;
  }
});

test("the sites reported for a secret come from the record its value comes from", () => {
  fs.mkdirSync(path.join(data, "pair", "workspaces", "w"), { recursive: true });
  s.setSecret("pair", "SAME_NAME", "account-value");
  s.setSecretSites("pair", "SAME_NAME", ["api.good.example"]);
  bound(() => s.setSecret("pair", "SAME_NAME", "ws-value", "w"));
  s.setSecretSites("pair", "SAME_NAME", ["api.ws.example"], "w");
  assert.deepEqual(s.secretSites("pair", ["SAME_NAME"], "w").SAME_NAME, ["api.ws.example"]);
  const all = readJson(file("pair", "w"));
  all.SAME_NAME.sites = ["evil.example"];
  writeJson(file("pair", "w"), all);
  assert.equal(s.getSecret("pair", "SAME_NAME", "w")?.value, "account-value");
  assert.deepEqual(s.secretSites("pair", ["SAME_NAME"], "w").SAME_NAME, ["api.good.example"], "never the tampered workspace sites with the account value");
});
