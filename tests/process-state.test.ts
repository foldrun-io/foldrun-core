// What the platform registers at boot is one per process, whichever copy of a
// module asks (process-state.ts). A second copy of a module is what a bundler
// that compiles the boot and the route handlers apart gives a process; here it
// is the same file imported under another URL.
//
//   node --test tests/process-state.test.ts

import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { workspaceDir } from "../src/store.ts";
import { fsBlobStore, bounded } from "../src/blob-store.ts";
import { localRevisionStore } from "../src/revision-store.ts";
import { setRevisionBackend, resetJournalForTests, flushRevisions, readAtHead } from "../src/workspace-revisions.ts";
import { setRunOutputsBackend } from "../src/run-outputs.ts";
import { setVaultStore } from "../src/secrets.ts";
import { processState } from "../src/process-state.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-pstate-"));
process.env.FOLDRUN_DATA = root;

afterEach(() => {
  setRevisionBackend(null);
  setRunOutputsBackend(null);
  setVaultStore(null);
  resetJournalForTests();
});

test("processState answers the same object for a name, and makes it once", () => {
  let made = 0;
  const a = processState("test-one", () => ({ n: ++made }));
  const b = processState("test-one", () => ({ n: ++made }));
  assert.equal(a, b);
  assert.equal(made, 1);
  assert.notEqual(processState("test-two", () => ({})), a);
});

test("a second copy of a module sees what the first was told at boot", async () => {
  const revs2 = (await import("../src/workspace-revisions.ts?copy=2")) as typeof import("../src/workspace-revisions.ts");
  const outs2 = (await import("../src/run-outputs.ts?copy=2")) as typeof import("../src/run-outputs.ts");
  assert.equal(revs2.revisionBackend(), null);
  const deps = { blobs: bounded(fsBlobStore(path.join(root, ".objects")), { backoffMs: 1 }), revisions: localRevisionStore(path.join(root, ".revisions")) };
  setRevisionBackend(deps, { journal: () => true, read: () => true });
  assert.ok(revs2.revisionBackend(), "the backend registered through one copy is the other's too");
  assert.equal(revs2.revisionReadsOn(), true);
  const backend = { blobs: deps.blobs, pins: undefined, store: {}, enabled: () => true } as unknown as Parameters<typeof setRunOutputsBackend>[0];
  setRunOutputsBackend(backend);
  assert.equal(outs2.runOutputsBackend(), backend);
});

test("a save recorded through another copy of history is journalled as a revision", async () => {
  const deps = { blobs: bounded(fsBlobStore(path.join(root, ".objects2")), { backoffMs: 1 }), revisions: localRevisionStore(path.join(root, ".revisions2")) };
  setRevisionBackend(deps, { journal: () => true, read: () => true });
  const dir = workspaceDir("acme", "desk");
  fs.mkdirSync(path.join(dir, "memory"), { recursive: true });
  fs.writeFileSync(path.join(dir, "AGENTS.md"), "---\nname: desk\n---\n");
  fs.writeFileSync(path.join(dir, "memory", "a.md"), "from a route\n");
  // a route handler's own copy of history.ts (the boot registered the journal in another)
  const history2 = (await import("../src/history.ts?copy=2")) as typeof import("../src/history.ts");
  history2.recordRevision("acme", "desk", [{ path: "memory/a.md", before: null, after: "from a route\n" }], { by: "user:a", message: "saved" });
  await flushRevisions({ tenant: "acme", workspace: "desk" });
  assert.equal((await readAtHead("acme", "desk", "memory/a.md"))?.toString(), "from a route\n");
});
