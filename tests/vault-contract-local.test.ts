// The vault contract (tests/vault-contract.ts) on files and on an in-memory
// store. The Postgres store runs it in foldrun-platform.
//
//   node --test tests/vault-contract-local.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { vaultContract, memoryVaultStore } from "./vault-contract.ts";

vaultContract("files", () => null);
vaultContract("store", () => memoryVaultStore());

test("a scope is served from one place: with a store on, a file left behind is never read", async () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-vault-one-place-"));
  const prev = { data: process.env.FOLDRUN_DATA, key: process.env.FOLDRUN_SECRET_KEY };
  process.env.FOLDRUN_DATA = data;
  process.env.FOLDRUN_SECRET_KEY = "contract-install-key";
  const s = await import("../src/secrets.ts");
  try {
    s.setSecret("acme", "OLD", "from-the-file");
    assert.equal(s.getSecret("acme", "OLD")?.value, "from-the-file");
    const store = memoryVaultStore();
    s.setVaultStore(store);
    assert.equal(s.getSecret("acme", "OLD"), null, "deleted (never imported) in the store: the stale file does not bring it back");
    // A store that says a scope is not its own leaves that scope on files.
    s.setVaultStore({ ...store, on: () => false });
    assert.equal(s.getSecret("acme", "OLD")?.value, "from-the-file");
    // …and a file written then tells the store its copy is stale.
    const forgotten: string[] = [];
    s.setVaultStore({ ...store, on: () => false, forget: (t, w) => void forgotten.push(`${t}|${w ?? ""}`) });
    s.deleteSecret("acme", "NOT_THERE");
    assert.deepEqual(forgotten, [], "nothing written, nothing to forget");
    s.setSecret("acme", "NEW_ONE", "v");
    s.setSecret("acme", "WS_ONE", "v", "desk");
    assert.deepEqual(forgotten, ["acme|", "acme|desk"]);
  } finally {
    s.setVaultStore(null);
    prev.data === undefined ? delete process.env.FOLDRUN_DATA : (process.env.FOLDRUN_DATA = prev.data);
    prev.key === undefined ? delete process.env.FOLDRUN_SECRET_KEY : (process.env.FOLDRUN_SECRET_KEY = prev.key);
    fs.rmSync(data, { recursive: true, force: true });
  }
});
