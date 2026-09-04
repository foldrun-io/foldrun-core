// The dependency cache: built once per (account, declaration), reused after.
//
// This directory used to die with the container, so every step reinstalled
// what the last one had just installed. Making it survive is the point — but
// surviving also makes it *shared*, and these tests are mostly about that
// second half: two steps of one account with the same dependencies now start
// at the same instant routinely, and a half-written venv is not a slow run,
// it is a corrupt cache every later step inherits.
//
//   node --test tests/runtime-cache.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { prepareRuntime, parseRuntime, fingerprint, safeTenantSegment } from "../packages/core/src/runtime.ts";

const SPEC = { python: true as const, packages: [], npm: [] };
const FP = fingerprint(SPEC);

/** A throwaway FOLDRUN_DATA, so the cache under test is nobody else's. */
function inTempData<T>(fn: (root: string) => T): T {
  const previous = process.env.FOLDRUN_DATA;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-rt-test-"));
  process.env.FOLDRUN_DATA = root;
  try {
    return fn(root);
  } finally {
    if (previous === undefined) delete process.env.FOLDRUN_DATA;
    else process.env.FOLDRUN_DATA = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const entry = (root: string, tenant = "acct") => path.join(root, tenant, ".runtimes", FP);

test("a built runtime is marked ready and releases its claim", () => {
  inTempData((root) => {
    const built = prepareRuntime("acct", SPEC);
    assert.equal(built.error, null, built.error ?? "");
    assert.ok(fs.existsSync(path.join(entry(root), ".ready")), "ready marker");
    assert.ok(
      !fs.existsSync(path.join(entry(root), ".building")),
      "the claim must not outlive the build, or every later step waits on a ghost",
    );
    assert.match(built.log.join("\n"), /created venv/);
  });
});

test("the second step reuses it instead of rebuilding — the whole point", () => {
  inTempData(() => {
    prepareRuntime("acct", SPEC);
    const second = prepareRuntime("acct", SPEC);
    assert.deepEqual(second.log, [`runtime ${FP}: cached`]);
    assert.ok(second.interpreters[".py"], "a cached hit still wires the interpreter up");
  });
});

test("accounts do not share an entry, even for identical dependencies", () => {
  inTempData((root) => {
    prepareRuntime("acct-a", SPEC);
    assert.ok(fs.existsSync(path.join(entry(root, "acct-a"), ".ready")));
    assert.ok(
      !fs.existsSync(path.join(entry(root, "acct-b"), ".ready")),
      "one account's build must never be another's — a shared venv is code one " +
        "tenant writes and another executes",
    );
  });
});

test("a live claim is waited on, not raced", () => {
  inTempData((root) => {
    const previous = process.env.FOLDRUN_RUNTIME_BUILD_TIMEOUT_MS;
    process.env.FOLDRUN_RUNTIME_BUILD_TIMEOUT_MS = "400";
    try {
      // Stand in for a concurrent step that claimed the build and is still
      // working. The waiter must not write into the shared entry.
      fs.mkdirSync(path.join(entry(root), ".building"), { recursive: true });
      const started = Date.now();
      const out = prepareRuntime("acct", SPEC);
      assert.ok(Date.now() - started >= 400, "it waited for the holder");
      assert.equal(out.error, null, out.error ?? "");
      assert.ok(out.interpreters[".py"], "the step still gets a working runtime");
      assert.ok(
        !out.interpreters[".py"].startsWith(entry(root)),
        "the fallback build is private — it must not be published as the shared entry",
      );
      assert.ok(!fs.existsSync(path.join(entry(root), ".ready")), "and it is not marked ready");
    } finally {
      if (previous === undefined) delete process.env.FOLDRUN_RUNTIME_BUILD_TIMEOUT_MS;
      else process.env.FOLDRUN_RUNTIME_BUILD_TIMEOUT_MS = previous;
    }
  });
});

test("an abandoned claim is stolen, not waited on forever", () => {
  inTempData((root) => {
    const previous = process.env.FOLDRUN_RUNTIME_BUILD_TIMEOUT_MS;
    process.env.FOLDRUN_RUNTIME_BUILD_TIMEOUT_MS = "50";
    try {
      const lock = path.join(entry(root), ".building");
      fs.mkdirSync(lock, { recursive: true });
      // Older than the timeout: whoever held this is gone. Without the steal,
      // a single crashed build would send every later step down the private
      // path permanently, and the cache would never fill again.
      const past = new Date(Date.now() - 60_000);
      fs.utimesSync(lock, past, past);
      const out = prepareRuntime("acct", SPEC);
      assert.equal(out.error, null, out.error ?? "");
      assert.ok(fs.existsSync(path.join(entry(root), ".ready")), "it rebuilt the shared entry");
      assert.ok(!fs.existsSync(lock), "and released the claim it stole");
    } finally {
      if (previous === undefined) delete process.env.FOLDRUN_RUNTIME_BUILD_TIMEOUT_MS;
      else process.env.FOLDRUN_RUNTIME_BUILD_TIMEOUT_MS = previous;
    }
  });
});

test("only a safe single segment can name a cache directory", () => {
  for (const ok of ["acct", "acct-1", "A.b_c", "0"]) assert.equal(safeTenantSegment(ok), ok);
  // These are the ones that would reach another tenant's venvs through a
  // docker -v source or a k8s subPath.
  for (const bad of ["", ".", "..", "../x", "a/b", "a\\b", "-lead", " sp", "a b"]) {
    assert.equal(safeTenantSegment(bad), null, `${JSON.stringify(bad)} must be refused`);
  }
});

test("different declarations get different entries", () => {
  assert.notEqual(fingerprint(SPEC), fingerprint({ ...SPEC, packages: ["requests"] }));
  // Order is not identity: the same dependencies declared either way are one
  // cache entry, not two.
  assert.equal(
    fingerprint({ ...SPEC, packages: ["requests", "pandas"] }),
    fingerprint({ ...SPEC, packages: ["pandas", "requests"] }),
  );
});

// ---------- what may be handed to an installer ----------
//
// pip and npm read options out of the same argv as their operands, so the list
// of packages an agent declares is an argument vector, not a list of names. It
// is validated as one.

const kept = (v: unknown) => parseRuntime({ packages: v })?.packages ?? [];
const keptNpm = (v: unknown) => parseRuntime({ npm: v })?.npm ?? [];

test("a leading dash is refused — the declaration is an argv, not a name list", () => {
  // The shape that mattered: pip takes the index from its arguments, so this
  // moved every install in the declaration to somebody else's server, and the
  // packages it returned then ran inside the sandbox with the step's secrets.
  const poisoned = ["--index-url", "http://elsewhere.example/simple", "pandas"];
  assert.deepEqual(kept(poisoned), ["pandas"], "only the actual package survives");
  for (const flag of ["--index-url", "--extra-index-url", "--find-links", "--target", "-r", "-e"]) {
    assert.deepEqual(kept([flag]), [], `${flag} must never reach pip`);
  }
  for (const flag of ["--registry", "-g", "--prefix"]) {
    assert.deepEqual(keptNpm([flag]), [], `${flag} must never reach npm`);
  }
});

test("the pins people actually write survive", () => {
  // Each of these was silently dropped before: the pattern allowed a single
  // comparator character, so `pandas>2` passed and `pandas>=2` did not — and a
  // dropped requirement is never installed, so the script failed later with
  // "no module named pandas" and nothing pointing at the declaration.
  for (const req of ["pandas", "pandas>=2", "pandas==2.1.4", "pandas>=2,<3", "requests[socks]", "ruamel.yaml"]) {
    assert.deepEqual(kept([req]), [req], `${req} must reach pip`);
  }
  assert.deepEqual(keptNpm(["lodash", "@scope/pkg", "lodash@^4"]), ["lodash", "@scope/pkg", "lodash@^4"]);
});

test("a refused requirement is reported, not swallowed", () => {
  const spec = parseRuntime({ packages: ["pandas", "--index-url"] });
  assert.deepEqual(spec?.rejected, ["--index-url"]);
  inTempData(() => {
    const out = prepareRuntime("acct", spec!);
    assert.match(out.log.join("\n"), /ignored invalid requirement\(s\): --index-url/);
  });
});

test("what was rejected does not change the cache key", () => {
  // Otherwise a typo would fork the cache: same installed packages, new entry,
  // new install.
  const clean = parseRuntime({ packages: ["pandas"] })!;
  const noisy = parseRuntime({ packages: ["pandas", "--index-url"] })!;
  assert.equal(fingerprint(clean), fingerprint(noisy));
});

// A `.ready` marker and the packages it promises can disagree — a build that
// was interrupted, a cache volume restored without its contents, an entry
// written when npm could not reach its own cache. The old wire() said
// "cached", wired nothing, and returned error: null; the step then failed
// hundreds of lines later inside a tool with "Cannot find package 'sharp'",
// which reads as a broken tool rather than a broken runtime. Found in
// production: gbp-desk's post_image reported sharp missing for two runs while
// the runtime line above it said the entry was cached.
test("a ready entry that cannot satisfy the declaration is an error, not a hit", () => {
  const spec = parseRuntime({ node: true, npm: ["sharp"] })!;
  const fp = fingerprint(spec);
  inTempData((root) => {
    const dir = path.join(root, "acct", ".runtimes", fp);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, ".ready"), ""); // ready, but nothing installed
    const hit = prepareRuntime("acct", spec);
    assert.ok(hit.error, "an entry promising sharp with no node_modules must not pass as a hit");
    assert.match(hit.error!, /node_modules/);
    assert.ok(!hit.env.NODE_PATH, "nothing to point NODE_PATH at");
  });
});

test("`node: true` alone installs nothing, so a bare ready entry is still a hit", () => {
  const spec = parseRuntime({ node: true })!;
  const fp = fingerprint(spec);
  inTempData((root) => {
    const dir = path.join(root, "acct", ".runtimes", fp);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, ".ready"), "");
    const hit = prepareRuntime("acct", spec);
    assert.equal(hit.error, null, "no packages were asked for, so none can be missing");
  });
});
