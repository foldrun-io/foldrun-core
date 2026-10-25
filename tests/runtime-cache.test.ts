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
import { spawn } from "node:child_process";
import { prepareRuntime, parseRuntime, fingerprint, safeTenantSegment, claimBuild, releaseBuild, checkEntry } from "../src/runtime.ts";

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
      // The private build lives in the tmpdir, and nothing prunes that: the
      // step removes it when it is done.
      const priv = path.dirname(path.dirname(path.dirname(out.interpreters[".py"])));
      assert.ok(fs.existsSync(priv));
      assert.ok(out.dispose, "a private build comes with its own disposer");
      out.dispose!();
      assert.ok(!fs.existsSync(priv), "disposed");
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
test("a ready entry that cannot satisfy the declaration is rebuilt, not trusted", () => {
  // It used to be reported as an error and left in place, so every later
  // step failed the same way until someone deleted the directory by hand. It
  // is rebuilt now; this package does not exist, so the rebuild itself fails
  // and says so, which proves the path without needing the network to work.
  const spec = parseRuntime({ node: true, npm: ["foldrun-no-such-package-3f9a1c"] })!;
  const fp = fingerprint(spec);
  inTempData((root) => {
    const dir = path.join(root, "acct", ".runtimes", fp);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, ".ready"), ""); // ready, but nothing installed
    const hit = prepareRuntime("acct", spec);
    assert.match(hit.log.join("\n"), /cached entry unusable \(node_modules is missing foldrun-no-such-package-3f9a1c\); rebuilding/);
    assert.ok(hit.error, "a rebuild of a package that does not exist must fail loudly");
    assert.ok(!hit.env.NODE_PATH, "nothing to point NODE_PATH at");
    assert.ok(!fs.existsSync(path.join(dir, ".ready")), "the stale marker is gone, so the next step retries");
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

test("a claim taken over as abandoned is not released by the build that lost it", () => {
  inTempData((root) => {
    const previous = process.env.FOLDRUN_RUNTIME_BUILD_TIMEOUT_MS;
    process.env.FOLDRUN_RUNTIME_BUILD_TIMEOUT_MS = "50";
    try {
      const dir = entry(root);
      fs.mkdirSync(dir, { recursive: true });
      const lock = path.join(dir, ".building");
      const first = claimBuild(dir)!;
      assert.ok(first);
      assert.equal(claimBuild(dir), null, "held, and fresh: not taken");
      const past = new Date(Date.now() - 60_000);
      fs.utimesSync(lock, past, past);
      const second = claimBuild(dir)!;
      assert.ok(second && second !== first, "quiet past the timeout: taken over");
      // The first build finishes late. Its finally used to remove the lock
      // whoever held it, and a third step then built beside the second.
      releaseBuild(dir, first);
      assert.ok(fs.existsSync(lock), "the new holder's claim survives");
      releaseBuild(dir, second);
      assert.ok(!fs.existsSync(lock));
    } finally {
      if (previous === undefined) delete process.env.FOLDRUN_RUNTIME_BUILD_TIMEOUT_MS;
      else process.env.FOLDRUN_RUNTIME_BUILD_TIMEOUT_MS = previous;
    }
  });
});

test("a concurrent build that failed ends the wait at once, with its error", () => {
  inTempData((root) => {
    const dir = entry(root);
    fs.mkdirSync(path.join(dir, ".building"), { recursive: true });
    // The holder, in another process (the wait blocks this one): it fails
    // after a moment, leaving .failed and releasing the claim.
    spawn("sh", ["-c", `sleep 0.4; printf '{"error":"pip exploded"}' > .failed; rm -rf .building`], { cwd: dir, stdio: "ignore" });
    const started = Date.now();
    const out = prepareRuntime("acct", SPEC);
    assert.ok(Date.now() - started < 5000, `it did not wait out the six minutes (${Date.now() - started}ms)`);
    assert.match(out.error ?? "", /a concurrent step's build of this runtime failed — pip exploded/);
  });
});

test("a failed shared build leaves .failed; the next claimant clears it and retries", () => {
  const spec = parseRuntime({ node: true, npm: ["foldrun-no-such-package-3f9a1c"] })!;
  inTempData((root) => {
    const dir = path.join(root, "acct", ".runtimes", fingerprint(spec));
    const out = prepareRuntime("acct", spec);
    assert.ok(out.error);
    const failed = JSON.parse(fs.readFileSync(path.join(dir, ".failed"), "utf8"));
    assert.match(failed.error, /npm install failed/);
    assert.ok(!fs.existsSync(path.join(dir, ".building")), "the claim is released");
  });
});

test("python: false is not a declaration of python", () => {
  assert.equal(parseRuntime({ python: false }), null, "nothing wanted, nothing built");
  assert.equal(parseRuntime({ node: false }), null);
  const spec = parseRuntime({ python: false, node: true })!;
  inTempData((root) => {
    const out = prepareRuntime("acct", spec);
    assert.equal(out.error, null, out.error ?? "");
    assert.ok(!out.interpreters[".py"], "no venv wired");
    assert.ok(!fs.existsSync(path.join(root, "acct", ".runtimes", fingerprint(spec), "venv")), "and none built");
  });
});

test("a health check that times out is inconclusive — the entry is used, not rebuilt", () => {
  inTempData((root) => {
    const previous = process.env.FOLDRUN_RUNTIME_CHECK_TIMEOUT_MS;
    process.env.FOLDRUN_RUNTIME_CHECK_TIMEOUT_MS = "200";
    try {
      // A venv whose python is merely slow to answer (a busy host).
      const bin = path.join(root, "venv", "bin");
      fs.mkdirSync(bin, { recursive: true });
      fs.writeFileSync(path.join(bin, "python"), "#!/bin/sh\nsleep 5\n", { mode: 0o755 });
      assert.equal(checkEntry(root, { python: true, packages: ["pandas"], npm: [] }), null);
      // One that answers and fails is still broken.
      fs.writeFileSync(path.join(bin, "python"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
      assert.match(checkEntry(root, { python: true, packages: ["pandas"], npm: [] }) ?? "", /no longer runs/);
    } finally {
      if (previous === undefined) delete process.env.FOLDRUN_RUNTIME_CHECK_TIMEOUT_MS;
      else process.env.FOLDRUN_RUNTIME_CHECK_TIMEOUT_MS = previous;
    }
  });
});

test("an abandoned claim is taken over by exactly one of the steps that find it at once", () => {
  // Every waiter that saw the stale lock used to remove it and take it: the
  // second remover deleted the first taker's fresh lock, and two steps built
  // into one directory. The seam pauses one claimer between "it is stale"
  // and the takeover, and lets another claimer run the whole way through.
  inTempData((root) => {
    const dir = entry(root);
    const lock = path.join(dir, ".building");
    fs.mkdirSync(lock, { recursive: true });
    fs.writeFileSync(path.join(lock, "owner"), "dead");
    const past = new Date(Date.now() - 60 * 60_000);
    fs.utimesSync(lock, past, past);
    let second: string | null = null;
    let raced = false;
    const first = claimBuild(dir, { beforeTakeover: () => { raced = true; second = claimBuild(dir); } });
    assert.ok(raced, "the other claimer ran mid-takeover");
    const winners = [first, second].filter(Boolean);
    assert.equal(winners.length, 1, `exactly one holder (first=${first}, second=${second})`);
    assert.equal(fs.readFileSync(path.join(lock, "owner"), "utf8"), winners[0], "the lock is the winner's");
    assert.deepEqual(fs.readdirSync(dir).filter((n) => n.startsWith(".building")), [".building"], "nothing left behind");
  });
});
