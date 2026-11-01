// The list of every kind of OAuth (src/oauth-capabilities.ts) stays true:
// a supported row names tests that exist, under those names, in the repos
// that hold them; every row has what a person needs to read it; and the
// customer page generated from it (foldrun-docs/oauth.md) is current.
// Rows proven in a sibling repo are checked where the siblings are checked
// out (the box, the deploy gate); core's own CI checks core's.
//
//   node --test tests/oauth-capabilities.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { OAUTH_CAPABILITIES } from "../src/oauth-capabilities.ts";

const ROOT = path.resolve(import.meta.dirname, "../..");
/** Core's own proofs are read from this checkout, whatever its folder is
 *  called; the other repos from the siblings beside it. */
const repoRoot = (repo: string) => (repo === "foldrun-core" ? path.resolve(import.meta.dirname, "..") : path.join(ROOT, repo));

test("every row has an id, a spec and a note; ids are unique", () => {
  const ids = new Set<string>();
  for (const c of OAUTH_CAPABILITIES) {
    assert.match(c.id, /^(client|server|refused)\.[a-z0-9-]+$/, c.id);
    assert.ok(!ids.has(c.id), `duplicate ${c.id}`);
    ids.add(c.id);
    assert.ok(c.title && c.spec && c.note, c.id);
  }
});

test("a supported row names at least one test, and every named test exists under that name", () => {
  let checked = 0;
  for (const c of OAUTH_CAPABILITIES) {
    if (c.status === "supported") assert.ok(c.proof?.length, `${c.id} is supported but names no test`);
    for (const p of c.proof ?? []) {
      const file = path.join(repoRoot(p.repo), p.file);
      if (!fs.existsSync(repoRoot(p.repo))) continue; // a sibling not checked out here
      assert.ok(fs.existsSync(file), `${c.id}: ${p.repo}/${p.file} does not exist`);
      const text = fs.readFileSync(file, "utf8");
      assert.ok(text.includes(p.test), `${c.id}: no test named "${p.test}" in ${p.repo}/${p.file}`);
      checked++;
    }
  }
  assert.ok(checked > 0);
});

test("a refused or planned row is never claimed as proven-supported", () => {
  for (const c of OAUTH_CAPABILITIES) {
    if (c.status === "planned" || c.status === "not-needed") assert.ok(!c.proof?.length, `${c.id} is ${c.status} but names tests`);
  }
});

test("the customer page foldrun-docs/oauth.md is generated from this list and current", { skip: fs.existsSync(path.join(ROOT, "foldrun-docs")) ? false : "foldrun-docs is not checked out beside core" }, async () => {
  const { render } = await import("../scripts/oauth-doc.mjs");
  const now = fs.readFileSync(path.join(ROOT, "foldrun-docs/oauth.md"), "utf8");
  assert.equal(now, await render(), "stale — run node scripts/oauth-doc.mjs in foldrun-core");
});
