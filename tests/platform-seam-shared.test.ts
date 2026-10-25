// The platform seam must be one object per process, whichever bundle loaded
// it. Next compiles instrumentation.ts and each route handler separately;
// a seam held in module scope was registered in one bundle and read, still
// on its local defaults, in another — so an approval's enqueueResume did
// nothing and the run waited for reconcile. Simulated here with two module
// instances, the way two bundles would see it.

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

test("two module instances of platform.ts share one seam", async () => {
  const file = pathToFileURL(path.join(import.meta.dirname, "../src/platform.ts")).href;
  // A query string makes the loader treat it as a distinct module, i.e. a second bundle.
  const a = await import(`${file}?bundle=a`);
  const b = await import(`${file}?bundle=b`);
  assert.notEqual(a, b, "the loader really gave us two instances");
  let called = "";
  a.registerPlatform({ enqueueResume: async (_t: string, _w: string, runId: string) => { called = runId; } });
  await b.platform.enqueueResume("acme", "desk", "run-1");
  assert.equal(called, "run-1", "a registration in one instance is seen by the other");
  a.resetPlatform();
});
