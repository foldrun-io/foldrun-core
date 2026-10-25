// runtime: system: (Debian packages) and installer failures that say why.
//
// Before 11 Oct 2026 a step could install pip and npm packages only, and a
// failure was the installer's last 500 characters — a pycairo build that died
// for want of a C compiler read `uv pip install failed: files.` in the run log.
//
//   node --test tests/runtime-system.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  parseRuntime,
  mergeRuntimes,
  fingerprint,
  summarizeInstallFailure,
  systemInstallSh,
  checkSystemPackages,
  prepareRuntime,
} from "../src/runtime.ts";

test("system: keeps Debian package names, refuses anything else, and apt: is its alias", () => {
  const spec = parseRuntime({ system: ["libcairo2-dev", "build-essential", "g++", "python3.13-dev", "-oDebug::x", "foo;rm -rf /", "A"] })!;
  assert.deepEqual(spec.system, ["libcairo2-dev", "build-essential", "g++", "python3.13-dev"]);
  assert.deepEqual(spec.rejected, ["-oDebug::x", "foo;rm -rf /", "A"]);
  assert.deepEqual(parseRuntime({ apt: ["ffmpeg"] })!.system, ["ffmpeg"]);
});

test("a runtime that declares only system packages is a runtime", () => {
  const spec = parseRuntime({ system: ["ffmpeg"] });
  assert.ok(spec);
  assert.deepEqual(spec!.packages, []);
});

test("mergeRuntimes unions system packages", () => {
  const m = mergeRuntimes(parseRuntime({ system: ["pkg-config"], packages: ["pycairo"] }), parseRuntime({ system: ["pkg-config", "libcairo2-dev"] }))!;
  assert.deepEqual(m.system, ["pkg-config", "libcairo2-dev"]);
  assert.deepEqual(m.packages, ["pycairo"]);
});

test("a spec without system keeps the fingerprint it had before system existed", () => {
  const spec = parseRuntime({ python: true, packages: ["pandas>=2", "requests"] })!;
  const before = crypto
    .createHash("sha256")
    .update(JSON.stringify({ python: true, packages: ["pandas>=2", "requests"].sort(), node: null, npm: [] }))
    .digest("hex")
    .slice(0, 16);
  assert.equal(fingerprint(spec), before, "every cached environment must keep its key");
  const withSys = parseRuntime({ python: true, packages: ["pandas>=2", "requests"], system: ["libcairo2-dev"] })!;
  assert.notEqual(fingerprint(withSys), before, "a venv built against system libraries is a different environment");
  assert.equal(fingerprint(withSys), fingerprint(parseRuntime({ packages: ["requests", "pandas>=2"], python: true, system: ["libcairo2-dev"] })!));
});

// The real output of 10 Oct 2026's failed probe (run-mv38…), trimmed.
const NO_GCC = `\`uv\` exited 1
  × Failed to build \`manimpango==0.6.1\`
  ├─▶ The build backend returned an error
  ╰─▶ Call to \`setuptools.build_meta.build_wheel\` failed (exit status: 1)
      [stderr]
              By 2027-Feb-18, you need to update your project and remove
      deprecated calls
              or your builds will no longer be supported.
      ********************************************************************************
      !!
        for path in sorted(cls._find_pattern(pattern, enforce_match))
      error: [Errno 2] No such file or directory: 'x86_64-linux-gnu-gcc'

hint: Build failures usually indicate a problem with the package or the build environment`;

test("a build with no C compiler says so on the first line, names the package and the fix", () => {
  const msg = summarizeInstallFailure("uv pip install", NO_GCC);
  const first = msg.split("\n")[0];
  assert.match(first, /^uv pip install failed — `manimpango==0\.6\.1` has to be compiled and this runner has no C compiler/);
  assert.match(first, /system: \[build-essential\]/);
  assert.match(msg, /x86_64-linux-gnu-gcc/, "the log's tail is still there for the rest");
});

test("missing headers, pkg-config, Python.h, apt names, npm and resolution failures each get their cause", () => {
  assert.match(summarizeInstallFailure("uv pip install", "Failed to build `pycairo==1.29`\n../meson.build:31: ERROR: Dependency \"cairo\" not found, tried pkgconfig").split("\n")[0], /needs the system library cairo .*libcairo-dev/);
  assert.match(summarizeInstallFailure("uv pip install", "Failed to build `pycairo`\nDid not find pkg-config by name 'pkg-config'").split("\n")[0], /system: \[pkg-config\]/);
  assert.match(summarizeInstallFailure("uv pip install", "Failed to build `x`\nfatal error: Python.h: No such file or directory").split("\n")[0], /python3-dev/);
  assert.match(summarizeInstallFailure("apt-get install", "E: Unable to locate package libcairo-devv").split("\n")[0], /apt has no package `libcairo-devv`/);
  assert.match(summarizeInstallFailure("npm install", "npm error code E404\nnpm error 404 Not Found - GET https://registry.npmjs.org/nope").split("\n")[0], /npm E404: 404 Not Found/);
  assert.match(summarizeInstallFailure("uv pip install", "  × No solution found when resolving dependencies:\n  ╰─▶ Because foo==9 was not found in the package registry").split("\n")[0], /cannot all be satisfied/);
  assert.match(summarizeInstallFailure("pip install", "something odd\nERROR: the thing broke").split("\n")[0], /pip install failed — the thing broke/);
});

test("the install snippet hands apt only well-formed names, whatever the variable holds", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sys-sh-"));
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin);
  // A stand-in apt-get that records its argv.
  fs.writeFileSync(path.join(bin, "apt-get"), `#!/bin/sh\necho "$@" >> ${dir}/argv\n`, { mode: 0o755 });
  const sh = systemInstallSh(path.join(dir, "cache"), dir);
  const r = spawnSync("sh", ["-c", sh], {
    env: { PATH: `${bin}:${process.env.PATH}`, FOLDRUN_SYSTEM_PACKAGES: "libcairo2-dev -oAPT::Get::x=1 foo;touch${IFS}pwned $(id) ok+pkg" },
    encoding: "utf8",
  });
  assert.equal(r.status, 0, r.stderr);
  const argv = fs.readFileSync(path.join(dir, "argv"), "utf8");
  const install = argv.split("\n").find((l) => l.includes(" install "))!;
  assert.match(install, /libcairo2-dev ok\+pkg$/);
  assert.doesNotMatch(argv, /APT::Get::x|pwned|\$\(id\)/);
  assert.equal(fs.existsSync(path.join(dir, "pwned")), false);
  const status = JSON.parse(fs.readFileSync(path.join(dir, "system-install.json"), "utf8"));
  assert.equal(status.ok, true);
  assert.equal(status.packages.trim(), "libcairo2-dev ok+pkg");
});

test("checkSystemPackages: assumed present without dpkg, verified and explained with it", () => {
  const hasDpkg = spawnSync("dpkg-query", ["--version"]).status === 0;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sys-check-"));
  process.env.FOLDRUN_SYSTEM_STATUS = path.join(dir, "status.json");
  process.env.FOLDRUN_SYSTEM_LOG = path.join(dir, "log");
  try {
    if (!hasDpkg) {
      const r = checkSystemPackages(["libcairo2-dev"]);
      assert.equal(r.error, null);
      assert.match(r.log[0], /install only in a run container/);
      return;
    }
    fs.writeFileSync(process.env.FOLDRUN_SYSTEM_STATUS, JSON.stringify({ ok: false, exit: 100, seconds: 3 }));
    fs.writeFileSync(process.env.FOLDRUN_SYSTEM_LOG, "E: Unable to locate package zz-not-a-package\n");
    const r = checkSystemPackages(["zz-not-a-package"]);
    assert.match(r.error!, /system packages not installed: zz-not-a-package — apt: apt has no package `zz-not-a-package`/);
  } finally {
    delete process.env.FOLDRUN_SYSTEM_STATUS;
    delete process.env.FOLDRUN_SYSTEM_LOG;
  }
});

test("prepareRuntime with only system packages builds no environment", () => {
  const hasDpkg = spawnSync("dpkg-query", ["--version"]).status === 0;
  if (hasDpkg) return; // on Linux CI the packages are genuinely absent — covered above
  const r = prepareRuntime("t", parseRuntime({ system: ["ffmpeg"] }));
  assert.equal(r.error, null);
  assert.deepEqual(r.env, {});
  assert.match(r.log.join("\n"), /assumed present/);
});

test("system packages: apt once, then a snapshot restore — and a new image means a new snapshot", () => {
  // realpath: macOS keeps tmp behind /var -> /private/var, and its tar will not
  // extract through a symlink (Linux run pods have no such link).
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sys-snap-")));
  const dpkg = path.join(dir, "dpkg");
  const pkgRoot = path.join(dir, "usr");
  fs.mkdirSync(path.join(dpkg, "info"), { recursive: true });
  fs.writeFileSync(path.join(dpkg, "status"), "Package: base\nStatus: install ok installed\n");
  fs.writeFileSync(path.join(dpkg, "info", "base.list"), "/bin/sh\n");
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin);
  // A stand-in apt-get: `install` lays down one package's files and its dpkg list.
  fs.writeFileSync(
    path.join(bin, "apt-get"),
    `#!/bin/sh\necho "$@" >> ${dir}/calls\ncase "$*" in *" install "*)\n  mkdir -p ${pkgRoot}/lib && echo lib > ${pkgRoot}/lib/libfake.so\n  printf '%s\\n' ${pkgRoot}/lib/libfake.so > ${dpkg}/info/fake.list\n  mkdir -p ${dir}/alt && ln -sf ${pkgRoot}/lib/libfake.so ${dir}/alt/libfake.so.3\n  echo "Package: fake" >> ${dpkg}/status ;;\nesac\n`,
    { mode: 0o755 },
  );
  const sh = systemInstallSh(path.join(dir, "cache"), dir);
  const env = { PATH: `${bin}:${process.env.PATH}`, FOLDRUN_SYSTEM_PACKAGES: "fake", FOLDRUN_DPKG_DIR: dpkg, FOLDRUN_SYS_ROOT: "/", FOLDRUN_SYS_SCAN: dir };
  const go = () => {
    const r = spawnSync("sh", ["-c", sh], { env, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(fs.readFileSync(path.join(dir, "system-install.json"), "utf8"));
  };
  const calls = () => (fs.existsSync(path.join(dir, "calls")) ? fs.readFileSync(path.join(dir, "calls"), "utf8").split("\n").filter(Boolean).length : 0);

  const first = go();
  assert.equal(first.mode, "apt");
  const snaps = fs.readdirSync(path.join(dir, "cache", ".apt", "snapshots")).filter((f) => f.endsWith(".tar") && !f.startsWith("."));
  assert.equal(snaps.length, 1, "the install was saved");
  const aptCalls = calls();

  // A fresh pod: the package's files and records are gone — and come back from the snapshot.
  fs.rmSync(pkgRoot, { recursive: true });
  fs.rmSync(path.join(dir, "alt"), { recursive: true });
  fs.rmSync(path.join(dpkg, "info", "fake.list"));
  fs.writeFileSync(path.join(dpkg, "status"), "Package: base\nStatus: install ok installed\n");
  const second = go();
  assert.equal(second.mode, "snapshot");
  assert.equal(calls(), aptCalls, "apt is not called on a restore");
  assert.equal(fs.readFileSync(path.join(pkgRoot, "lib", "libfake.so"), "utf8"), "lib\n");
  assert.ok(fs.existsSync(path.join(dpkg, "info", "fake.list")), "dpkg's record comes back with the files");
  // What an install script made (an update-alternatives link), which dpkg's
  // list does not name: missing it broke ffmpeg's libblas.so.3 on 11 Oct 2026.
  assert.equal(fs.readlinkSync(path.join(dir, "alt", "libfake.so.3")), path.join(pkgRoot, "lib", "libfake.so"));

  // A different runner image (its own dpkg status) never restores the old files.
  fs.rmSync(pkgRoot, { recursive: true });
  fs.rmSync(path.join(dpkg, "info", "fake.list"));
  fs.writeFileSync(path.join(dpkg, "status"), "Package: base\nStatus: install ok installed\nPackage: newer-image-tool\n");
  const third = go();
  assert.equal(third.mode, "apt");
  assert.ok(calls() > aptCalls);
});
