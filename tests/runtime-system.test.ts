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

test("checkSystemPackages says when an existing snapshot did not fit the image", () => {
  const hasDpkg = spawnSync("dpkg-query", ["-W", "bash"]).status === 0;
  if (!hasDpkg) return; // the line is only written where dpkg can verify (Linux CI, run pods)
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sys-stale-"));
  process.env.FOLDRUN_SYSTEM_STATUS = path.join(dir, "status.json");
  try {
    fs.writeFileSync(process.env.FOLDRUN_SYSTEM_STATUS, JSON.stringify({ ok: true, exit: 0, seconds: 30, mode: "apt", stale: 1 }));
    assert.match(checkSystemPackages(["bash"]).log[0], /\(apt, 30s, 1 snapshot did not fit this image\)$/);
    fs.writeFileSync(process.env.FOLDRUN_SYSTEM_STATUS, JSON.stringify({ ok: true, exit: 0, seconds: 1, mode: "snapshot", stale: 0 }));
    assert.match(checkSystemPackages(["bash"]).log[0], /\(snapshot, 1s\)$/);
  } finally {
    delete process.env.FOLDRUN_SYSTEM_STATUS;
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

// Snapshots, format v4 (FOL-50). A stand-in dpkg tree and apt-get whose
// `install` lays down one package's files, its dpkg list and an
// update-alternatives link, and appends its record to the status file.
function snapFixture() {
  // realpath: macOS keeps tmp behind /var -> /private/var, and its tar will not
  // extract through a symlink (Linux run pods have no such link).
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sys-snap-")));
  const dpkg = path.join(dir, "dpkg");
  const pkgRoot = path.join(dir, "usr");
  const bin = path.join(dir, "bin");
  fs.mkdirSync(path.join(dpkg, "info"), { recursive: true });
  fs.mkdirSync(bin);
  const BASE = "Package: base\nStatus: install ok installed\nVersion: 1\n";
  // A fresh pod: the package's files and records gone, the image's status.
  const freshPod = (status = BASE) => {
    fs.rmSync(pkgRoot, { recursive: true, force: true });
    fs.rmSync(path.join(dir, "alt"), { recursive: true, force: true });
    fs.rmSync(path.join(dpkg, "info", "fake.list"), { force: true });
    fs.writeFileSync(path.join(dpkg, "status"), status);
    fs.writeFileSync(path.join(dpkg, "info", "base.list"), "/bin/sh\n");
  };
  fs.writeFileSync(
    path.join(bin, "apt-get"),
    `#!/bin/sh\necho "$@" >> ${dir}/calls\ncase "$*" in *" install "*)\n  mkdir -p ${pkgRoot}/lib && echo lib > ${pkgRoot}/lib/libfake.so\n  printf '%s\\n' ${pkgRoot}/lib/libfake.so > ${dpkg}/info/fake.list\n  mkdir -p ${dir}/alt && ln -sf ${pkgRoot}/lib/libfake.so ${dir}/alt/libfake.so.3\n  echo "Package: fake" >> ${dpkg}/status ;;\nesac\n`,
    { mode: 0o755 },
  );
  const osRelease = path.join(dir, "os-release");
  fs.writeFileSync(osRelease, 'PRETTY_NAME="Debian GNU/Linux 13 (trixie)"\nID=debian\nVERSION_ID="13"\n');
  const sh = systemInstallSh(path.join(dir, "cache"), dir);
  const env = { PATH: `${bin}:${process.env.PATH}`, FOLDRUN_SYSTEM_PACKAGES: "fake", FOLDRUN_DPKG_DIR: dpkg, FOLDRUN_SYS_ROOT: "/", FOLDRUN_SYS_SCAN: dir, FOLDRUN_OS_RELEASE: osRelease };
  const go = (more: Record<string, string> = {}) => {
    const r = spawnSync(process.env.FOLDRUN_TEST_SH ?? "sh", ["-c", sh], { env: { ...env, ...more }, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(fs.readFileSync(path.join(dir, "system-install.json"), "utf8"));
  };
  const calls = () => (fs.existsSync(path.join(dir, "calls")) ? fs.readFileSync(path.join(dir, "calls"), "utf8").split("\n").filter(Boolean).length : 0);
  const snapRoot = path.join(dir, "cache", ".apt", "snapshots");
  const keys = () => (fs.existsSync(snapRoot) ? fs.readdirSync(snapRoot).filter((k) => !k.startsWith(".")).sort() : []);
  const gens = (key: string) => fs.readdirSync(path.join(snapRoot, key)).filter((g) => !g.startsWith(".")).sort();
  const sha = (s: string) => crypto.createHash("sha256").update(s).digest("hex");
  freshPod();
  return { dir, dpkg, pkgRoot, BASE, freshPod, go, calls, keys, gens, snapRoot, sha, osRelease };
}

test("system packages: apt once, then a snapshot restore", () => {
  const f = snapFixture();
  const first = f.go();
  assert.equal(first.mode, "apt");
  const [key] = f.keys();
  assert.match(key, /^v4-[0-9a-f]{16}$/);
  const [gen] = f.gens(key);
  assert.equal(gen, f.sha(f.BASE).slice(0, 16), "one generation, named by the base it was built on");
  assert.equal(fs.readFileSync(path.join(f.snapRoot, key, gen, "base"), "utf8").trim(), f.sha(f.BASE), "the base's whole sha256 beside it");
  const aptCalls = f.calls();

  f.freshPod();
  const second = f.go();
  assert.equal(second.mode, "snapshot");
  assert.equal(f.calls(), aptCalls, "apt is not called on a restore");
  assert.equal(fs.readFileSync(path.join(f.pkgRoot, "lib", "libfake.so"), "utf8"), "lib\n");
  assert.ok(fs.existsSync(path.join(f.dpkg, "info", "fake.list")), "dpkg's record comes back with the files");
  // What an install script made (an update-alternatives link), which dpkg's
  // list does not name: missing it broke ffmpeg's libblas.so.3 on 11 Oct 2026.
  assert.equal(fs.readlinkSync(path.join(f.dir, "alt", "libfake.so.3")), path.join(f.pkgRoot, "lib", "libfake.so"));
});

test("system snapshot key: same base on a new release → same key; changed list or Debian release → new key", () => {
  const f = snapFixture();
  f.go();
  const [key] = f.keys();
  // The key is the package set, Debian release and machine — never the base:
  // a new image is a new generation under the same key, not a new key.
  f.freshPod(f.BASE + "Package: chrome\nVersion: 151\n");
  f.go();
  assert.deepEqual(f.keys(), [key], "a base change keeps the key");
  f.freshPod();
  f.go({ FOLDRUN_SYSTEM_PACKAGES: "fake  fake" });
  assert.deepEqual(f.keys(), [key], "the same set, however it is written");
  f.freshPod();
  f.go({ FOLDRUN_SYSTEM_PACKAGES: "fake other-pkg" });
  assert.equal(f.keys().length, 2, "a changed package list is a new key");
  fs.writeFileSync(f.osRelease, 'ID=debian\nVERSION_ID="14"\n');
  f.freshPod();
  assert.equal(f.go().mode, "apt", "a new Debian release never restores the old one's files");
  assert.equal(f.keys().length, 3, "and is a new key");
});

test("system snapshot restore: only onto a byte-identical base; another base builds its own beside it", () => {
  const f = snapFixture();
  f.go();
  const [key] = f.keys();
  let aptCalls = f.calls();
  // A rebuilt image whose packages moved (a Chrome release, a Debian fix).
  const moved = f.BASE + "Package: chrome\nVersion: 151\n";
  f.freshPod(moved);
  const r = f.go();
  assert.equal(r.mode, "apt", "a changed base never restores files built on the old one");
  assert.equal(r.stale, 1, "the run says a snapshot was there and did not fit");
  assert.ok(f.calls() > aptCalls);
  assert.deepEqual(f.gens(key), [f.sha(f.BASE).slice(0, 16), f.sha(moved).slice(0, 16)].sort(), "one generation per base, side by side");
  aptCalls = f.calls();
  // Each base restores its own — the slim and the full image alike.
  for (const base of [f.BASE, moved]) {
    f.freshPod(base);
    assert.equal(f.go().mode, "snapshot");
  }
  assert.equal(f.calls(), aptCalls);
  // A generation whose recorded base is not this one is never restored, even
  // under this base's name (a torn or tampered copy).
  const g = path.join(f.snapRoot, key, f.sha(f.BASE).slice(0, 16));
  fs.writeFileSync(path.join(g, "base"), "0".repeat(64) + "\n");
  f.freshPod();
  assert.equal(f.go().mode, "apt");
  assert.equal(fs.readFileSync(path.join(g, "base"), "utf8").trim(), f.sha(f.BASE), "and is replaced by a good one");
});

test("system snapshot generations: four kept per key, none restored 14 days after it was built", () => {
  const f = snapFixture();
  for (let i = 0; i < 6; i++) {
    f.freshPod(`${f.BASE}Package: image-${i}\n`);
    assert.equal(f.go().mode, "apt");
  }
  const [key] = f.keys();
  assert.equal(f.gens(key).length, 4, "the four newest");
  f.freshPod(`${f.BASE}Package: image-5\n`);
  assert.equal(f.go().mode, "snapshot", "the newest is among them");

  const g = path.join(f.snapRoot, key, f.sha(`${f.BASE}Package: image-5\n`).slice(0, 16));
  const old = new Date(Date.now() - 15 * 86_400_000);
  fs.utimesSync(g, old, old);
  f.freshPod(`${f.BASE}Package: image-5\n`);
  assert.equal(f.go().mode, "apt", "built 15 days ago: rebuilt, so the packages it added pick up Debian's fixes");
  f.freshPod(`${f.BASE}Package: image-5\n`);
  assert.equal(f.go().mode, "snapshot", "the rebuilt one restores");
});

test("system snapshot: v3's flat tars are deleted, an incomplete generation is never restored", () => {
  const f = snapFixture();
  fs.mkdirSync(f.snapRoot, { recursive: true });
  fs.writeFileSync(path.join(f.snapRoot, "v3-123-456.tar"), "old");
  f.go();
  assert.equal(fs.existsSync(path.join(f.snapRoot, "v3-123-456.tar")), false);
  const [key] = f.keys();
  const [gen] = f.gens(key);
  fs.rmSync(path.join(f.snapRoot, key, gen, "base"));
  f.freshPod();
  assert.equal(f.go().mode, "apt", "no base file: not restored");
  fs.rmSync(path.join(f.snapRoot, key, gen, "snap.tar"));
  f.freshPod();
  assert.equal(f.go().mode, "apt", "no tar: not restored");
});
