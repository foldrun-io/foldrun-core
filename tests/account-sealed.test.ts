// The account file browser never serves the vault, the money or the
// bookkeeping. billing.json, oauth-connections.json and secret-health.json
// were listed and served to any member until 2026-09-24.
//
//   node --test tests/account-sealed.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { accountDir, accountFileSealed, listAccountFiles } from "../src/store.ts";

test("private account files are sealed and left out of the listing", () => {
  const dir = accountDir("sealtest");
  fs.mkdirSync(path.join(dir, "once"), { recursive: true });
  fs.mkdirSync(path.join(dir, "library", "skills"), { recursive: true });
  for (const f of ["secrets.json", "oauth-clients.json", "ledger.jsonl", "billing.json", "oauth-connections.json", "secret-health.json", "once/abc", "AGENTS.md", "library/skills/x.md"]) {
    fs.writeFileSync(path.join(dir, f), "{}");
  }
  for (const f of ["secrets.json", "oauth-clients.json", "ledger.jsonl", "billing.json", "oauth-connections.json", "secret-health.json", "once/abc", "topups/x", "billed/run-1"]) {
    assert.ok(accountFileSealed(f), `${f} must be sealed`);
  }
  for (const f of ["AGENTS.md", "library/skills/x.md"]) assert.equal(accountFileSealed(f), null, `${f} is authored`);
  const listed = listAccountFiles("sealtest");
  for (const f of ["billing.json", "oauth-connections.json", "secret-health.json", "once/abc", "secrets.json"]) {
    assert.ok(!listed.includes(f), `${f} must not be listed`);
  }
  assert.ok(listed.includes("AGENTS.md"));
});
