// An account secret limited to selected workspaces (GitHub's "selected
// repositories" for an organisation secret): every other workspace is
// answered as if it were not set — getSecret, resolveSecrets, secretSites,
// listSecrets — while the account's own use (no workspace) is unchanged. The
// list is in a bound record's seal, survives a new value, sites, a key
// rotation and a re-seal, and follows a workspace that is renamed or deleted.
//
//   node --test tests/secret-workspaces.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const data = fs.mkdtempSync(path.join(os.tmpdir(), "secret-ws-"));
process.env.FOLDRUN_DATA = data;
process.env.FOLDRUN_SECRET_KEY = "test-install-key";
for (const ws of ["blog", "ops", "sales"]) fs.mkdirSync(path.join(data, "acme", "workspaces", ws), { recursive: true });
const s = await import("../src/secrets.ts");

const accountFile = path.join(data, "acme", "secrets.json");
const readJson = () => JSON.parse(fs.readFileSync(accountFile, "utf8"));
const writeJson = (v: unknown) => fs.writeFileSync(accountFile, JSON.stringify(v));
const bound = <T>(fn: () => T): T => {
  process.env.FOLDRUN_VAULT_WRITE_BOUND = "1";
  try {
    return fn();
  } finally {
    delete process.env.FOLDRUN_VAULT_WRITE_BOUND;
  }
};

test("no list: every workspace reads the account secret, as before", () => {
  s.setSecret("acme", "OPEN_KEY", "open");
  for (const ws of ["blog", "ops", "sales"]) assert.equal(s.getSecret("acme", "OPEN_KEY", ws)?.value, "open");
  assert.equal(s.listSecrets("acme").find((e) => e.name === "OPEN_KEY")?.workspaces, undefined);
});

test("limited: the named workspaces read it, every other one finds it missing, on every reader", () => {
  s.setSecret("acme", "STRIPE_KEY", "sk_live");
  s.setSecretSites("acme", "STRIPE_KEY", ["api.stripe.com"]);
  assert.deepEqual(s.setSecretWorkspaces("acme", "STRIPE_KEY", ["sales", "ops", "sales"]), ["ops", "sales"]);

  assert.equal(s.getSecret("acme", "STRIPE_KEY", "sales")?.value, "sk_live");
  assert.equal(s.getSecret("acme", "STRIPE_KEY", "blog"), null);
  assert.deepEqual(s.resolveSecrets("acme", ["STRIPE_KEY"], "blog").missing, ["STRIPE_KEY"]);
  assert.deepEqual(s.secretSites("acme", ["STRIPE_KEY"], "blog"), {});
  assert.deepEqual(s.secretSites("acme", ["STRIPE_KEY"], "ops"), { STRIPE_KEY: ["api.stripe.com"] });
  assert.equal(s.listSecrets("acme", "blog").some((e) => e.name === "STRIPE_KEY"), false);
  assert.equal(s.listSecrets("acme", "ops").some((e) => e.name === "STRIPE_KEY"), true);
  assert.deepEqual(s.listSecrets("acme").find((e) => e.name === "STRIPE_KEY")?.workspaces, ["ops", "sales"]);
  // The account's own use is not a workspace's.
  assert.equal(s.getSecret("acme", "STRIPE_KEY")?.value, "sk_live");
  // A workspace's own secret of the same name is still its own.
  s.setSecret("acme", "STRIPE_KEY", "sk_blog", "blog");
  assert.equal(s.getSecret("acme", "STRIPE_KEY", "blog")?.value, "sk_blog");
});

test("an empty list is no workspace; null lifts the limit", () => {
  s.setSecret("acme", "PARKED", "p");
  assert.deepEqual(s.setSecretWorkspaces("acme", "PARKED", []), []);
  assert.equal(s.getSecret("acme", "PARKED", "ops"), null);
  assert.equal(s.setSecretWorkspaces("acme", "PARKED", null), null);
  assert.equal(s.getSecret("acme", "PARKED", "ops")?.value, "p");
  assert.equal(readJson().PARKED.workspaces, undefined);
});

test("a new value keeps the list; a bad name, a missing secret and a list that is not one are refused", () => {
  s.setSecret("acme", "KEEP", "one");
  s.setSecretWorkspaces("acme", "KEEP", ["ops"]);
  s.setSecret("acme", "KEEP", "two");
  assert.equal(s.getSecret("acme", "KEEP", "blog"), null);
  assert.equal(s.getSecret("acme", "KEEP", "ops")?.value, "two");
  assert.throws(() => s.setSecretWorkspaces("acme", "KEEP", ["../x"]));
  assert.throws(() => s.setSecretWorkspaces("acme", "NOPE", ["ops"]), /no secret NOPE/);
  assert.throws(() => s.setSecretWorkspaces("acme", "KEEP", "ops" as unknown as string[]));
});

test("a bound record seals its list: widened, stripped or rewritten on disk it does not open", () => {
  bound(() => s.setSecret("acme", "SEALED", "sealed-value"));
  s.setSecretWorkspaces("acme", "SEALED", ["ops"]);
  assert.equal(readJson().SEALED.v, 2);
  assert.equal(s.getSecret("acme", "SEALED", "ops")?.value, "sealed-value");
  // Sites re-seal it with the list kept.
  s.setSecretSites("acme", "SEALED", ["api.example.com"]);
  assert.equal(s.getSecret("acme", "SEALED", "ops")?.value, "sealed-value");
  assert.equal(s.getSecret("acme", "SEALED", "blog"), null);
  const orig = readJson().SEALED;
  for (const tamper of [
    { ...orig, workspaces: ["ops", "blog"] },
    (({ workspaces: _drop, ...rest }) => rest)(orig),
    { ...orig, workspaces: "ops" },
  ]) {
    const all = readJson();
    all.SEALED = tamper;
    writeJson(all);
    assert.equal(s.getSecret("acme", "SEALED", "blog"), null);
    assert.equal(s.getSecret("acme", "SEALED", "ops"), null, "a tampered record opens nowhere");
  }
  const all = readJson();
  all.SEALED = orig;
  writeJson(all);
  assert.equal(s.getSecret("acme", "SEALED", "ops")?.value, "sealed-value");
});

test("an unbound record's list on disk that is not a list allows nowhere", () => {
  s.setSecret("acme", "LOOSE", "l");
  const all = readJson();
  all.LOOSE.workspaces = "ops";
  writeJson(all);
  assert.equal(s.getSecret("acme", "LOOSE", "ops"), null);
});

test("sealVaultBindings and a key rotation keep the list", () => {
  s.setSecret("acme", "MIGRATE", "m");
  s.setSecretWorkspaces("acme", "MIGRATE", ["sales"]);
  bound(() => s.sealVaultBindings("acme"));
  assert.equal(readJson().MIGRATE.v, 2);
  assert.deepEqual(readJson().MIGRATE.workspaces, ["sales"]);
  assert.equal(s.getSecret("acme", "MIGRATE", "sales")?.value, "m");
  assert.equal(s.getSecret("acme", "MIGRATE", "ops"), null);

  s.rotateMasterKey("acme", "test-install-key", "next-install-key");
  process.env.FOLDRUN_SECRET_KEY = "next-install-key";
  try {
    assert.equal(s.getSecret("acme", "MIGRATE", "sales")?.value, "m");
    assert.equal(s.getSecret("acme", "MIGRATE", "ops"), null);
  } finally {
    s.rotateMasterKey("acme", "next-install-key", "test-install-key");
    process.env.FOLDRUN_SECRET_KEY = "test-install-key";
  }
});

test("a renamed workspace keeps its secrets; a deleted one's name leaves every list", () => {
  bound(() => s.setSecret("acme", "FOLLOW", "f"));
  s.setSecretWorkspaces("acme", "FOLLOW", ["ops", "sales"]);
  const moved = s.retargetSecretWorkspaces("acme", "ops", "operations");
  assert.ok(moved.changed.includes("FOLLOW"));
  assert.deepEqual(moved.failed, []);
  assert.deepEqual(readJson().FOLLOW.workspaces, ["operations", "sales"]);
  assert.equal(s.getSecret("acme", "FOLLOW", "operations")?.value, "f");
  assert.equal(s.getSecret("acme", "FOLLOW", "ops"), null);

  s.retargetSecretWorkspaces("acme", "sales", null);
  assert.deepEqual(readJson().FOLLOW.workspaces, ["operations"]);
  assert.equal(s.getSecret("acme", "FOLLOW", "sales"), null, "a new workspace given the old name inherits nothing");
  assert.equal(s.getSecret("acme", "FOLLOW", "operations")?.value, "f");
  assert.deepEqual(s.retargetSecretWorkspaces("acme", "nowhere", "x"), { changed: [], failed: [] });
});

test("a record that will not open is reported, not skipped, and keeps the name", () => {
  bound(() => s.setSecret("acme", "BROKEN", "b"));
  s.setSecretWorkspaces("acme", "BROKEN", ["blog"]);
  const all = readJson();
  all.BROKEN.data = Buffer.from("garbage").toString("base64");
  writeJson(all);
  // A readable one limited to the same workspace is left alone too: all or nothing.
  s.setSecret("acme", "FINE", "f", undefined, undefined, { workspaces: ["blog"] });
  const r = s.retargetSecretWorkspaces("acme", "blog", null);
  assert.deepEqual(r.failed, ["BROKEN"]);
  assert.deepEqual(r.changed, [], "nothing is reported changed when anything failed");
  assert.deepEqual(readJson().BROKEN.workspaces, ["blog"], "left exactly as it was");
  assert.deepEqual(readJson().FINE.workspaces, ["blog"], "the readable one was not moved either");
  s.deleteSecret("acme", "FINE");
  const again = readJson();
  delete again.BROKEN;
  writeJson(again);
});

test("value and limit in one write: a new secret is never open in between; a workspace's own secret has no list", () => {
  s.setSecret("acme", "BORN_LIMITED", "v", undefined, undefined, { workspaces: ["sales"] });
  const rec = readJson().BORN_LIMITED;
  assert.equal(rec.v, 2, "a limited record is sealed even without FOLDRUN_VAULT_WRITE_BOUND");
  assert.deepEqual(rec.workspaces, ["sales"]);
  assert.equal(s.getSecret("acme", "BORN_LIMITED", "blog"), null);
  assert.equal(s.getSecret("acme", "BORN_LIMITED", "sales")?.value, "v");
  // The other shapes take it too.
  s.setFileSecret("acme", "BORN_FILE", "x", undefined, { workspaces: [] });
  assert.equal(s.getSecret("acme", "BORN_FILE", "sales"), null);
  // null opens it again with the new value, in the same write.
  s.setSecret("acme", "BORN_LIMITED", "w", undefined, undefined, { workspaces: null });
  assert.equal(s.getSecret("acme", "BORN_LIMITED", "blog")?.value, "w");
  assert.throws(() => s.setSecret("acme", "OWN", "v", "blog", undefined, { workspaces: ["sales"] }), /only an account secret/);
  // A name that does not exist, asked under the lock: nothing is written.
  assert.throws(() => s.setSecret("acme", "GHOST", "v", undefined, undefined, { workspaces: ["nosuch"], exists: (w) => w !== "nosuch" }), /no workspace nosuch/);
  assert.equal(readJson().GHOST, undefined);
});

test("limiting a legacy (unsealed) record seals it: a stripped list makes it unreadable, never open", () => {
  delete process.env.FOLDRUN_VAULT_WRITE_BOUND;
  s.setSecret("acme", "LEGACY", "old");
  assert.equal(readJson().LEGACY.v, undefined);
  s.setSecretWorkspaces("acme", "LEGACY", ["ops"]);
  assert.equal(readJson().LEGACY.v, 2);
  assert.equal(s.getSecret("acme", "LEGACY", "ops")?.value, "old");
  const all = readJson();
  delete all.LEGACY.workspaces;
  writeJson(all);
  assert.equal(s.getSecret("acme", "LEGACY", "blog"), null);
  assert.equal(s.getSecret("acme", "LEGACY", "ops"), null);
});

test("a conditional update is refused when the list changed meanwhile; names are checked under the lock", () => {
  s.setSecret("acme", "COND", "c");
  s.setSecretWorkspaces("acme", "COND", ["ops"], { ifWorkspaces: null });
  assert.throws(
    () => s.setSecretWorkspaces("acme", "COND", ["sales"], { ifWorkspaces: null }),
    (err: Error & { status?: number }) => err.status === 409 && /changed since/.test(err.message),
  );
  assert.deepEqual(s.setSecretWorkspaces("acme", "COND", ["sales"], { ifWorkspaces: ["ops"] }), ["sales"]);
  assert.throws(
    () => s.setSecretWorkspaces("acme", "COND", ["gone"], { exists: (w) => w !== "gone" }),
    (err: Error & { status?: number }) => err.status === 400 && /no workspace gone/.test(err.message),
  );
  assert.deepEqual(readJson().COND.workspaces, ["sales"]);
  assert.throws(() => s.setSecretWorkspaces("acme", "NOT_THERE", null), (err: Error & { status?: number }) => err.status === 404);
});

test("a workspace's notification mail does not use an account sender limited away from it", async () => {
  const n = await import("../src/notify.ts");
  delete process.env.FOLDRUN_RESEND_API_KEY;
  s.setSecret("acme", "RESEND_API_KEY", "re_acct", undefined, undefined, { workspaces: ["sales"] });
  s.setSecret("acme", "EMAIL_FROM", "desk@acme.test");
  assert.equal(n.notifyMail("acme", "sales")?.key, "re_acct");
  assert.equal(n.notifyMail("acme", "blog"), null, "no platform key here: nothing to send with");
  process.env.FOLDRUN_RESEND_API_KEY = "re_platform";
  try {
    assert.equal(n.notifyMail("acme", "blog")?.key, "re_platform");
    // The account's own mail (resets, invites) names no workspace: not limited.
    assert.equal(n.accountMail("acme")?.key, "re_acct");
  } finally {
    delete process.env.FOLDRUN_RESEND_API_KEY;
  }
  s.deleteSecret("acme", "RESEND_API_KEY");
  s.deleteSecret("acme", "EMAIL_FROM");
});
