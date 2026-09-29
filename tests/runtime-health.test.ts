// A cached runtime is checked before it is trusted, rebuilt when it lies,
// found by every way a script can be started, and pruned when nobody uses it.
//
// The incident behind this file (29 Sep 2026): a tool declared
// `runtime: packages: [openpyxl]` and `interpreter: python3`. The run log said
// the runtime was cached; the tool died with "No module named openpyxl"
// because `interpreter: python3` bypassed the venv. And above it the worker,
// which has had no python since the image split, logged "python3 is not
// available on this host" for a build nobody needed.
//
//   node --test tests/runtime-health.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  checkEntry,
  distName,
  fingerprint,
  npmName,
  parseRuntime,
  prepareRuntime,
  pruneRuntimes,
} from "../src/runtime.ts";
import { commandFor } from "../src/script-tools.ts";

function inTempData<T>(fn: (root: string) => T): T {
  const previous = process.env.FOLDRUN_DATA;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-rt-health-"));
  process.env.FOLDRUN_DATA = root;
  try {
    return fn(root);
  } finally {
    if (previous === undefined) delete process.env.FOLDRUN_DATA;
    else process.env.FOLDRUN_DATA = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const PY = { python: true as const, packages: [], npm: [] };

test("requirement names reduce to what the installers registered", () => {
  assert.equal(distName("requests[socks]>=2,<3"), "requests");
  assert.equal(distName("ruamel.yaml"), "ruamel.yaml");
  assert.equal(distName("pandas==2.1.4"), "pandas");
  assert.equal(npmName("@scope/pkg@^1"), "@scope/pkg");
  assert.equal(npmName("lodash@4"), "lodash");
  assert.equal(npmName("sharp"), "sharp");
});

test("`interpreter: python3` runs in the prepared venv, not the bare system python", () => {
  const venv = "/cache/abc/venv/bin/python";
  const spec = { name: "t", run: "x.py", description: "", args: {}, interpreter: "python3" };
  assert.deepEqual(commandFor(spec, "/w/x.py", { ".py": venv }), { cmd: venv, args: ["/w/x.py"] });
  // No runtime prepared: the declaration is obeyed as written.
  assert.deepEqual(commandFor(spec, "/w/x.py", {}), { cmd: "python3", args: ["/w/x.py"] });
  // A specific path or another language is never second-guessed.
  const bash = { ...spec, interpreter: "bash" };
  assert.deepEqual(commandFor(bash, "/w/x.sh", { ".py": venv }), { cmd: "bash", args: ["/w/x.sh"] });
  const pinned = { ...spec, interpreter: "/opt/py/bin/python3.12" };
  assert.deepEqual(commandFor(pinned, "/w/x.py", { ".py": venv }), { cmd: "/opt/py/bin/python3.12", args: ["/w/x.py"] });
});

test("the venv's bin comes first on PATH, so shebangs and Bash find it too", () => {
  inTempData(() => {
    const built = prepareRuntime("acct", PY);
    assert.equal(built.error, null, built.error ?? "");
    const first = built.env.PATH.split(path.delimiter)[0];
    assert.equal(first, path.dirname(built.interpreters[".py"]));
    // And a bare `python3` resolved through that PATH is the venv's.
    const which = spawnSync("python3", ["-c", "import sys; print(sys.prefix)"], {
      encoding: "utf8",
      env: { ...process.env, PATH: built.env.PATH },
    });
    assert.equal(fs.realpathSync(which.stdout.trim()), fs.realpathSync(built.env.VIRTUAL_ENV));
    // The cached hit wires the same PATH.
    const hit = prepareRuntime("acct", PY);
    assert.equal(hit.env.PATH, built.env.PATH);
  });
});

test("a built entry records what built it", () => {
  inTempData((root) => {
    prepareRuntime("acct", PY);
    const ready = JSON.parse(fs.readFileSync(path.join(root, "acct", ".runtimes", fingerprint(PY), ".ready"), "utf8"));
    assert.match(ready.python, /^3\.\d+/);
    assert.ok(["uv", "pip"].includes(ready.installer));
  });
});

test("a venv whose python has gone is rebuilt, not reported as cached", () => {
  inTempData((root) => {
    prepareRuntime("acct", PY);
    const venvPython = path.join(root, "acct", ".runtimes", fingerprint(PY), "venv", "bin", "python");
    // What an image upgrade does to every old venv: bin/python still exists
    // but points at an interpreter that is no longer there.
    fs.rmSync(venvPython);
    fs.symlinkSync("/nonexistent/python3.11", venvPython);
    assert.match(checkEntry(path.dirname(path.dirname(path.dirname(venvPython))), PY) ?? "", /no longer runs/);
    const again = prepareRuntime("acct", PY);
    assert.equal(again.error, null, again.error ?? "");
    assert.match(again.log.join("\n"), /cached entry unusable .*; rebuilding/);
    assert.match(again.log.join("\n"), /created venv/);
    // And the rebuilt entry is a clean hit afterwards.
    assert.deepEqual(prepareRuntime("acct", PY).log, [`runtime ${fingerprint(PY)}: cached`]);
  });
});

test("a declared package the venv does not hold is caught by name", () => {
  inTempData((root) => {
    prepareRuntime("acct", PY);
    const dir = path.join(root, "acct", ".runtimes", fingerprint(PY));
    const wants = parseRuntime({ packages: ["foldrun-absent-dist-7b2e"] })!;
    assert.match(checkEntry(dir, wants) ?? "", /the venv is missing foldrun-absent-dist-7b2e/);
    // pip itself is there (seeded or ensurepip'd), and a present distribution passes.
    assert.equal(checkEntry(dir, parseRuntime({ packages: ["pip"] })!), null);
  });
});

test("a pinned python the host cannot provide is an error, never a silent fallback", () => {
  const previous = process.env.FOLDRUN_UV;
  process.env.FOLDRUN_UV = "0"; // pip path: no uv to fetch it
  try {
    inTempData(() => {
      const out = prepareRuntime("acct", { python: "2.9", packages: [], npm: [] });
      assert.match(out.error ?? "", /python 2\.9 is not installed here/);
      assert.deepEqual(out.interpreters, {});
    });
  } finally {
    if (previous === undefined) delete process.env.FOLDRUN_UV;
    else process.env.FOLDRUN_UV = previous;
  }
});

test("the pip path still builds when uv is switched off", () => {
  const previous = process.env.FOLDRUN_UV;
  process.env.FOLDRUN_UV = "0";
  try {
    inTempData((root) => {
      const out = prepareRuntime("acct", PY);
      assert.equal(out.error, null, out.error ?? "");
      const ready = JSON.parse(fs.readFileSync(path.join(root, "acct", ".runtimes", fingerprint(PY), ".ready"), "utf8"));
      assert.equal(ready.installer, "pip");
    });
  } finally {
    if (previous === undefined) delete process.env.FOLDRUN_UV;
    else process.env.FOLDRUN_UV = previous;
  }
});

test("entries unused for the max age are pruned; recent, building and shared dirs are not", () => {
  const cache = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-prune-"));
  try {
    const old = Date.now() / 1000 - 40 * 86_400;
    const mk = (name: string, files: string[], age: number | null) => {
      const dir = path.join(cache, name);
      fs.mkdirSync(dir, { recursive: true });
      for (const f of files) {
        if (f === ".building") fs.mkdirSync(path.join(dir, f));
        else fs.writeFileSync(path.join(dir, f), "");
      }
      if (age !== null) {
        for (const f of files) fs.utimesSync(path.join(dir, f), age, age);
        fs.utimesSync(dir, age, age);
      }
    };
    mk("stale", [".ready"], old);
    mk("fresh", [".ready"], null);
    mk("failed-long-ago", [], old);
    mk("busy", [".ready", ".building"], old);
    mk("current", [".ready"], old);
    mk(".uv-cache", [], old);
    const removed = pruneRuntimes(cache, "current").sort();
    assert.deepEqual(removed, ["failed-long-ago", "stale"]);
    for (const kept of ["fresh", "busy", "current", ".uv-cache"]) {
      assert.ok(fs.existsSync(path.join(cache, kept)), `${kept} must survive`);
    }
  } finally {
    fs.rmSync(cache, { recursive: true, force: true });
  }
});

test("a cache hit refreshes the last-used clock", () => {
  inTempData((root) => {
    prepareRuntime("acct", PY);
    const ready = path.join(root, "acct", ".runtimes", fingerprint(PY), ".ready");
    const long = Date.now() / 1000 - 40 * 86_400;
    fs.utimesSync(ready, long, long);
    prepareRuntime("acct", PY);
    assert.ok(Date.now() - fs.statSync(ready).mtimeMs < 60_000, "a hit must mark the entry used");
  });
});

// ---------- the platform's shared layer ----------

function withShared<T>(dir: string, fn: () => T): T {
  const prev = process.env.FOLDRUN_RUNTIME_SHARED;
  process.env.FOLDRUN_RUNTIME_SHARED = dir;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.FOLDRUN_RUNTIME_SHARED;
    else process.env.FOLDRUN_RUNTIME_SHARED = prev;
  }
}

test("a healthy entry in the shared layer is used before the account's own cache", () => {
  inTempData((root) => {
    // Build one where the platform's builder would: <data>/shared/.runtimes.
    prepareRuntime("shared", PY);
    const layer = path.join(root, "shared", ".runtimes");
    const hit = withShared(layer, () => prepareRuntime("acct", PY));
    assert.deepEqual(hit.log, [`runtime ${fingerprint(PY)}: shared`]);
    assert.ok(hit.interpreters[".py"].startsWith(layer));
    assert.ok(!fs.existsSync(path.join(root, "acct", ".runtimes", fingerprint(PY))), "nothing was built for the account");
  });
});

test("a broken shared entry is passed over, never used, and the account builds its own", () => {
  inTempData((root) => {
    prepareRuntime("shared", PY);
    const layer = path.join(root, "shared", ".runtimes");
    const venvPython = path.join(layer, fingerprint(PY), "venv", "bin", "python");
    fs.rmSync(venvPython);
    fs.symlinkSync("/nonexistent/python3", venvPython);
    const out = withShared(layer, () => prepareRuntime("acct", PY));
    assert.equal(out.error, null, out.error ?? "");
    assert.match(out.log.join("\n"), /created venv/);
    assert.ok(out.interpreters[".py"].startsWith(path.join(root, "acct")));
  });
});

test("a missing shared layer changes nothing", () => {
  inTempData(() => {
    const out = withShared("/nonexistent/shared/.runtimes", () => prepareRuntime("acct", PY));
    assert.equal(out.error, null, out.error ?? "");
    assert.match(out.log.join("\n"), /created venv/);
  });
});
