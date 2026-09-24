// The vault file is changed safely: under a lock that holds across processes
// (pods share one volume), written to a unique temp file and renamed into
// place. Before, saves raced and the boot re-wrap in every pod shared one
// temp name.
//
//   node --test tests/vault-safe-write.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const SECRETS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src/secrets.ts");

function run(data: string, code: string): Promise<number> {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, ["--input-type=module", "-e", code], {
      env: { ...process.env, FOLDRUN_DATA: data, FOLDRUN_SECRET_KEY: "test-install-key" },
      stdio: "inherit",
    });
    p.on("exit", (c) => resolve(c ?? 1));
  });
}

test("twelve processes saving at once all land, and nothing half-written is left", async () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), "vault-race-"));
  fs.mkdirSync(path.join(data, "acme"), { recursive: true });
  const codes = await Promise.all(
    Array.from({ length: 12 }, (_, i) =>
      run(data, `const s = await import(${JSON.stringify(SECRETS)}); s.setSecret("acme", "KEY_${i}", "value-${i}");`),
    ),
  );
  assert.deepEqual(codes, Array(12).fill(0));
  process.env.FOLDRUN_DATA = data;
  process.env.FOLDRUN_SECRET_KEY = "test-install-key";
  const s = await import(SECRETS);
  const names = s.listSecrets("acme").map((e: { name: string }) => e.name).sort();
  assert.equal(names.length, 12, `every save landed: ${names.join(",")}`);
  assert.equal(s.getSecret("acme", "KEY_7")?.value, "value-7");
  const left = fs.readdirSync(path.join(data, "acme")).filter((f) => f !== "secrets.json");
  assert.deepEqual(left, [], "no lock or temp file left behind");
});

test("a rotation keeps each secret's kind, so an oauth2 secret still refreshes", async () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), "vault-rotate-"));
  fs.mkdirSync(path.join(data, "acme"), { recursive: true });
  process.env.FOLDRUN_DATA = data;
  process.env.FOLDRUN_SECRET_KEY = "old-key";
  const s = await import(SECRETS);
  s.setOAuth2Secret("acme", "LI_OAUTH", { token_url: "https://x/token", client_id: "c", client_secret: "s", refresh_token: "r" });
  const r = s.rotateMasterKey("acme", "old-key", "new-key");
  assert.deepEqual(r.unreadable, []);
  process.env.FOLDRUN_SECRET_KEY = "new-key";
  const entry = s.listSecrets("acme").find((e: { name: string }) => e.name === "LI_OAUTH");
  assert.equal(entry?.kind, "oauth2", "the kind survived the rotation");
  assert.ok(s.isOAuth2Value(s.getSecret("acme", "LI_OAUTH")!.value));
});

test("the vault's lock and temp files are sealed like the vault", async () => {
  const { accountFileSealed, isPlatformPath } = await import("../src/store.ts");
  const { checkPaths } = await import("../src/confine.ts");
  for (const f of ["secrets.json.lock", "secrets.json.123.ab12cd34.tmp", "workspaces/desk/secrets.json.lock"]) {
    assert.ok(accountFileSealed(f), `${f} sealed in the browser`);
  }
  assert.equal(isPlatformPath("secrets.json.lock"), true, "never copied into a run");
  const roots = { agentDir: "/d/t/workspaces/w/agents/a", workspaceRoot: "/d/t/workspaces/w", libraryRoot: "/d/lib" };
  assert.equal(checkPaths("Read", { file_path: "/d/t/workspaces/w/secrets.json.lock" }, roots).ok, false, "an agent cannot open it");
});
