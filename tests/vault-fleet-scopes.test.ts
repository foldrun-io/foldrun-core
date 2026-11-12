// What a fleet check over the vault stands on (FOL-126 phase 6): which scopes
// have a file on the volume, and whether a stored record opens, without a
// value ever coming out.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

test("vaultFileScopes lists every account's and workspace's file, and only files that exist", async () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-vault-scopes-"));
  const prev = { data: process.env.FOLDRUN_DATA, key: process.env.FOLDRUN_SECRET_KEY };
  process.env.FOLDRUN_DATA = data;
  process.env.FOLDRUN_SECRET_KEY = "scopes-install-key";
  try {
    const s = await import("../src/secrets.ts");
    assert.deepEqual(s.vaultFileScopes(), [], "nothing yet");
    s.setSecret("acme", "ACC_KEY", "v1");
    s.setSecret("acme", "DESK_KEY", "v2", "desk");
    s.setSecret("globex", "ONLY_ACC", "v3");
    fs.mkdirSync(path.join(data, "acme", "workspaces", "empty"), { recursive: true }); // a workspace with no vault
    fs.mkdirSync(path.join(data, "not a tenant!"), { recursive: true }); // not an account's folder
    const got = s.vaultFileScopes().map((x) => `${x.tenant}/${x.workspace ?? ""}`).sort();
    assert.deepEqual(got, ["acme/", "acme/desk", "globex/"]);
  } finally {
    for (const [k, v] of [["FOLDRUN_DATA", prev.data], ["FOLDRUN_SECRET_KEY", prev.key]] as const) v === undefined ? delete process.env[k] : (process.env[k] = v);
    fs.rmSync(data, { recursive: true, force: true });
  }
});

test("vaultRecordOpens says whether a record opens for its place, and never returns the value", async () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-vault-opens-"));
  const prev = { data: process.env.FOLDRUN_DATA, key: process.env.FOLDRUN_SECRET_KEY, bound: process.env.FOLDRUN_VAULT_WRITE_BOUND };
  process.env.FOLDRUN_DATA = data;
  process.env.FOLDRUN_SECRET_KEY = "opens-install-key";
  process.env.FOLDRUN_VAULT_WRITE_BOUND = "1";
  try {
    const s = await import("../src/secrets.ts");
    s.setSecret("acme", "OPEN_KEY", "canary-opens-71c0aa");
    const file = s.vaultFilePath("acme");
    const rec = s.readVaultFile(file).OPEN_KEY;
    assert.equal(s.vaultRecordOpens("acme", undefined, "OPEN_KEY", rec), true);
    assert.equal(typeof s.vaultRecordOpens("acme", undefined, "OPEN_KEY", rec), "boolean");
    assert.equal(s.vaultRecordOpens("acme", undefined, "OTHER_NAME", rec), false, "a record moved under another name does not open");
    assert.equal(s.vaultRecordOpens("acme", "desk", "OPEN_KEY", rec), false, "nor into another scope");
    assert.equal(s.vaultRecordOpens("globex", undefined, "OPEN_KEY", rec), false, "nor another account");
    assert.equal(s.vaultRecordOpens("acme", undefined, "OPEN_KEY", { ...rec, tag: Buffer.alloc(16).toString("base64") }), false, "nor a damaged one");
    process.env.FOLDRUN_SECRET_KEY = "someone-elses-key";
    assert.equal(s.vaultRecordOpens("acme", undefined, "OPEN_KEY", rec), false, "nor under a different install key");
  } finally {
    for (const [k, v] of [["FOLDRUN_DATA", prev.data], ["FOLDRUN_SECRET_KEY", prev.key], ["FOLDRUN_VAULT_WRITE_BOUND", prev.bound]] as const) v === undefined ? delete process.env[k] : (process.env[k] = v);
    fs.rmSync(data, { recursive: true, force: true });
  }
});
