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
  ROOT_ENV_RESET_SH,
} from "../src/runtime.ts";

// Folders made the way a run pod's root makes them (umask 022): a snapshot
// is refused under a folder others can write, and a group-writable umask
// (Debian's for a login user) would make every fixture folder one.
process.umask(0o022);

// Run as root (a Debian container with an `agent` user, as on a run pod),
// the snippet works in the cache as the agent: the fixture hands the cache
// to that user, the way the start-up's chown does.
const AGENT_UID = process.getuid?.() === 0 ? Number(spawnSync("id", ["-u", "agent"], { encoding: "utf8" }).stdout.trim()) || null : null;
function agentOwns(p: string) {
  if (AGENT_UID === null || !fs.existsSync(p)) return;
  fs.lchownSync(p, AGENT_UID, AGENT_UID);
  if (fs.lstatSync(p).isDirectory()) for (const e of fs.readdirSync(p)) agentOwns(path.join(p, e));
}

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

// Snapshots, format v5 (FOL-50, FOL-129). A stand-in dpkg tree and apt-get
// whose `install` lays down one package's files, its dpkg list and an
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
  // The account's key, where the start-up keeps it: away from the cache.
  const keyDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sys-key-")));
  const keyHex = crypto.randomBytes(32).toString("hex");
  const keyFile = path.join(keyDir, "key");
  fs.writeFileSync(keyFile, keyHex, { mode: 0o600 });
  // Somewhere a snapshot must never write: not under the allowed root.
  const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sys-outside-")));
  const sh = systemInstallSh(path.join(dir, "cache"), dir);
  const env = {
    PATH: `${bin}:${process.env.PATH}`,
    FOLDRUN_SYSTEM_PACKAGES: "fake",
    FOLDRUN_DPKG_DIR: dpkg,
    FOLDRUN_SYS_ROOT: "/",
    FOLDRUN_SYS_SCAN: dir,
    FOLDRUN_OS_RELEASE: osRelease,
    // The fixture is the only "system" path here; on a run pod it is
    // /etc /usr /var … (SNAPSHOT_ALLOWED).
    FOLDRUN_SYS_ALLOW: dir.slice(1),
    FOLDRUN_SNAP_KEY_FILE: keyFile,
    COPYFILE_DISABLE: "1",
  };
  if (AGENT_UID !== null) fs.chmodSync(dir, 0o755);
  const go = (more: Record<string, string | undefined> = {}, script = sh) => {
    // What the agent wrote into its cache is the agent's.
    fs.mkdirSync(path.join(dir, "cache"), { recursive: true });
    agentOwns(path.join(dir, "cache"));
    const e: Record<string, string> = {};
    for (const [k, v] of Object.entries({ ...env, ...more })) if (v !== undefined) e[k] = v;
    const r = spawnSync(process.env.FOLDRUN_TEST_SH ?? "sh", ["-c", script], { env: e, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(fs.readFileSync(path.join(dir, "system-install.json"), "utf8"));
  };
  const calls = () => (fs.existsSync(path.join(dir, "calls")) ? fs.readFileSync(path.join(dir, "calls"), "utf8").split("\n").filter(Boolean).length : 0);
  const snapRoot = path.join(dir, "cache", ".system-snapshots");
  const keys = () => (fs.existsSync(snapRoot) ? fs.readdirSync(snapRoot).filter((k) => !k.startsWith(".")).sort() : []);
  const gens = (key: string) => fs.readdirSync(path.join(snapRoot, key)).filter((g) => !g.startsWith(".")).sort();
  const sha = (s: string | Buffer) => crypto.createHash("sha256").update(s).digest("hex");
  // A seal as the start-up makes one — what only the key's holder can write.
  const sealOf = (key: string, base: string, built: number, tar: Buffer, k = keyHex) => {
    const h = sha(tar);
    const mac = crypto.createHmac("sha256", Buffer.from(k, "hex")).update(["v5", key, sha(base), String(built), h].join("\n")).digest("hex");
    return `v5 ${built} ${h} ${mac}\n`;
  };
  const now = () => Math.floor(Date.now() / 1000);
  // Lay a generation down the way an agent with write access to the cache
  // could: its own tar, whatever seal it has, the base it reads off the disk.
  const plant = (key: string, base: string, tar: Buffer, seal: string | null) => {
    const g = path.join(snapRoot, key, sha(base).slice(0, 16));
    fs.rmSync(g, { recursive: true, force: true });
    fs.mkdirSync(g, { recursive: true });
    fs.writeFileSync(path.join(g, "snap.tar"), tar);
    fs.writeFileSync(path.join(g, "base"), sha(base) + "\n");
    if (seal !== null) fs.writeFileSync(path.join(g, "seal"), seal);
    return g;
  };
  // Nothing written outside: the outside folder holds only what was put there.
  const outsideHas = () => fs.readdirSync(outside).sort();
  freshPod();
  return { dir, dpkg, pkgRoot, BASE, freshPod, go, calls, keys, gens, snapRoot, sha, osRelease, keyFile, keyHex, outside, outsideHas, sealOf, plant, now, sh, rel: dir.slice(1) };
}

/** A tar written by hand, so a test can say exactly what is in it: GNU
 *  headers, long names as `L` records, the end marker. */
type TarEntry = { name: string; type?: string; mode?: number; body?: string; link?: string; uname?: string; uid?: number };
function tarOf(entries: TarEntry[]): Buffer {
  const oct = (h: Buffer, off: number, len: number, v: number) => h.write(v.toString(8).padStart(len - 1, "0") + "\0", off, "latin1");
  const pad = (b: Buffer) => Buffer.concat([b, Buffer.alloc((512 - (b.length % 512)) % 512)]);
  const hdr = (name: string, type: string, size: number, mode: number, link: string, uname: string, uid: number) => {
    const h = Buffer.alloc(512);
    h.write(name.slice(0, 100), 0, "utf8");
    oct(h, 100, 8, mode);
    oct(h, 108, 8, uid);
    oct(h, 116, 8, 0);
    oct(h, 124, 12, size);
    oct(h, 136, 12, 1_700_000_000);
    h.fill(32, 148, 156);
    h[156] = type.charCodeAt(0);
    h.write(link.slice(0, 100), 157, "utf8");
    h.write("ustar  \0", 257, "latin1");
    h.write(uname, 265, "utf8");
    h.write("root", 297, "utf8");
    let sum = 0;
    for (const b of h) sum += b;
    h.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, "latin1");
    return h;
  };
  const blocks: Buffer[] = [];
  for (const e of entries) {
    const type = e.type ?? "0";
    const body = Buffer.from(e.body ?? "");
    if (Buffer.byteLength(e.name) > 99) {
      const d = Buffer.from(e.name + "\0");
      blocks.push(hdr("././@LongLink", "L", d.length, 0o644, "", "root", 0), pad(d));
    }
    if (Buffer.byteLength(e.link ?? "") > 99) {
      const d = Buffer.from(e.link + "\0");
      blocks.push(hdr("././@LongLink", "K", d.length, 0o644, "", "root", 0), pad(d));
    }
    blocks.push(hdr(e.name, type, type === "0" ? body.length : 0, e.mode ?? 0o644, e.link ?? "", e.uname ?? "root", e.uid ?? 0));
    if (type === "0" && body.length) blocks.push(pad(body));
  }
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}

test("system packages: apt once, then a snapshot restore", () => {
  const f = snapFixture();
  const first = f.go();
  assert.equal(first.mode, "apt");
  const [key] = f.keys();
  assert.match(key, /^v5-[0-9a-f]{16}$/);
  const [gen] = f.gens(key);
  assert.equal(gen, f.sha(f.BASE).slice(0, 16), "one generation, named by the base it was built on");
  const g = path.join(f.snapRoot, key, gen);
  assert.equal(fs.readFileSync(path.join(g, "base"), "utf8").trim(), f.sha(f.BASE), "the base's whole sha256 beside it");
  assert.match(fs.readFileSync(path.join(g, "seal"), "utf8"), /^v5 \d+ [0-9a-f]{64} [0-9a-f]{64}\n$/, "and its seal");
  const aptCalls = f.calls();

  f.freshPod();
  const second = f.go();
  assert.equal(second.mode, "snapshot");
  assert.equal(second.refused, "");
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

test("system snapshot generations: four kept per key, none restored 14 days after its sealed build time", () => {
  const f = snapFixture();
  for (let i = 0; i < 6; i++) {
    f.freshPod(`${f.BASE}Package: image-${i}\n`);
    assert.equal(f.go().mode, "apt");
  }
  const [key] = f.keys();
  assert.equal(f.gens(key).length, 4, "the four newest");
  const base = `${f.BASE}Package: image-5\n`;
  f.freshPod(base);
  assert.equal(f.go().mode, "snapshot", "the newest is among them");

  const g = path.join(f.snapRoot, key, f.sha(base).slice(0, 16));
  // The folder's times are the agent's to set; the age is the seal's.
  const old = new Date(Date.now() - 15 * 86_400_000);
  fs.utimesSync(g, old, old);
  f.freshPod(base);
  assert.equal(f.go().mode, "snapshot", "an old mtime does not age a sealed snapshot");
  const tar = fs.readFileSync(path.join(g, "snap.tar"));
  fs.writeFileSync(path.join(g, "seal"), f.sealOf(key, base, f.now() - 15 * 86_400, tar));
  f.freshPod(base);
  const r = f.go();
  assert.equal(r.mode, "apt", "sealed 15 days ago: rebuilt, so the packages it added pick up Debian's fixes");
  assert.equal(r.refused, "", "an expired snapshot is not a refused one");
  f.freshPod(base);
  assert.equal(f.go().mode, "snapshot", "the rebuilt one restores");
});

test("system snapshot: the v3/v4 layout under .apt is removed, an incomplete generation is never restored", () => {
  const f = snapFixture();
  const legacy = path.join(f.dir, "cache", ".apt");
  fs.mkdirSync(path.join(legacy, "snapshots", "v4-0123456789abcdef", "0123456789abcdef"), { recursive: true });
  fs.mkdirSync(path.join(legacy, "archives", "partial"), { recursive: true });
  fs.writeFileSync(path.join(legacy, "snapshots", "v3-123-456.tar"), "old");
  f.go();
  assert.equal(fs.existsSync(legacy), false, "the old snapshots and the shared .deb cache go");
  const [key] = f.keys();
  const [gen] = f.gens(key);
  const g = path.join(f.snapRoot, key, gen);
  fs.rmSync(path.join(g, "seal"));
  f.freshPod();
  const unsealed = f.go();
  assert.equal(unsealed.mode, "apt", "no seal: not restored");
  assert.equal(unsealed.refused, "it carries no seal");
  fs.rmSync(path.join(g, "base"));
  f.freshPod();
  assert.equal(f.go().mode, "apt", "no base file: not restored");
  fs.rmSync(path.join(g, "snap.tar"));
  f.freshPod();
  assert.equal(f.go().mode, "apt", "no tar: not restored");
});

test("system snapshots: no key, no snapshot made and none restored", () => {
  const f = snapFixture();
  assert.equal(f.go({ FOLDRUN_SNAP_KEY_FILE: undefined }).mode, "apt");
  assert.deepEqual(f.keys(), [], "nothing sealed, nothing saved");
  f.freshPod();
  f.go();
  f.freshPod();
  assert.equal(f.go({ FOLDRUN_SNAP_KEY_FILE: undefined }).mode, "apt", "a sealed one is not restored without the key to check it");
  f.freshPod();
  assert.equal(f.go({ FOLDRUN_SNAP_KEY_FILE: path.join(f.dir, "no-such-key") }).mode, "apt");
});

test("the install helper's variant restores but never saves a snapshot", () => {
  const f = snapFixture();
  const helper = systemInstallSh(path.join(f.dir, "cache"), f.dir, { save: false });
  assert.equal(f.go({}, helper).mode, "apt");
  assert.deepEqual(f.keys(), [], "what the helper installed beside the agent is never sealed");
  f.freshPod();
  f.go();
  f.freshPod();
  assert.equal(f.go({}, helper).mode, "snapshot", "a start-up's snapshot it restores");
});

// FOL-129: the agent owns the runtime cache. Play the agent: rewrite the
// snapshot files with an archive that writes outside, and check that the
// next start-up writes nothing outside, installs with apt and says why.
test("a rewritten snapshot without the account's key is refused: nothing lands outside, apt installs, the log says why", () => {
  const f = snapFixture();
  f.go();
  const [key] = f.keys();
  const g = path.join(f.snapRoot, key, f.sha(f.BASE).slice(0, 16));
  const genuine = fs.readFileSync(path.join(g, "seal"), "utf8");
  const evil = tarOf([
    { name: `${f.rel}/usr/lib/libfake.so`, body: "evil\n" },
    { name: `${f.outside.slice(1)}/pwned`, body: "root wrote this\n" },
    { name: `${f.rel}/dpkg/status`, body: f.BASE + "Package: fake\n" },
  ]);
  const attempts: [string, string | null, RegExp][] = [
    ["the genuine seal kept", genuine, /^its contents do not match its seal$/],
    ["a seal made with the agent's own key", f.sealOf(key, f.BASE, f.now(), evil, crypto.randomBytes(32).toString("hex")), /^its seal was not made with the account key$/],
    ["no seal", null, /^it carries no seal$/],
    ["a seal that never ends", "/dev/zero", /^it carries no seal$/],
    ["a seal dated in the future", f.sealOf(key, f.BASE, f.now() + 86_400, evil, crypto.randomBytes(32).toString("hex")), /^its seal is dated in the future$/],
  ];
  for (const [what, seal, why] of attempts) {
    f.freshPod();
    const g = f.plant(key, f.BASE, evil, seal === "/dev/zero" ? null : seal);
    if (seal === "/dev/zero") fs.symlinkSync("/dev/zero", path.join(g, "seal"));
    const r = f.go();
    assert.equal(r.mode, "apt", what);
    assert.equal(r.ok, true, what);
    assert.match(r.refused, why, what);
    assert.deepEqual(f.outsideHas(), [], `${what}: nothing written outside`);
    assert.equal(fs.readFileSync(path.join(f.pkgRoot, "lib", "libfake.so"), "utf8"), "lib\n", `${what}: apt's file, not the agent's`);
  }
  // The refusal is in the run log's line (checkSystemPackages), on a run pod.
  const hasDpkg = spawnSync("dpkg-query", ["-W", "bash"]).status === 0;
  if (hasDpkg) {
    process.env.FOLDRUN_SYSTEM_STATUS = path.join(f.dir, "system-install.json");
    try {
      assert.match(checkSystemPackages(["bash"]).log.join("\n"), /^system packages ready: bash \(apt, \d+s\)\nsnapshot refused: its seal is dated in the future$/);
    } finally {
      delete process.env.FOLDRUN_SYSTEM_STATUS;
    }
  }
});

test("even a correctly sealed snapshot can only put package files where packages go", () => {
  const f = snapFixture();
  f.go();
  const [key] = f.keys();
  const out = f.outside.slice(1);
  fs.writeFileSync(path.join(f.outside, "victim"), "original\n");
  // On the disk before the restore: a link out, and a folder anyone can write.
  fs.symlinkSync(f.outside, path.join(f.dir, "lnk"));
  fs.mkdirSync(path.join(f.dir, "ww"));
  fs.chmodSync(path.join(f.dir, "ww"), 0o777);
  // A folder others can write holding a link into a safe one: resolving the
  // link alone would see only the safe folder; the link itself can be swapped.
  fs.mkdirSync(path.join(f.dir, "wapp"));
  fs.mkdirSync(path.join(f.dir, "safe"));
  fs.symlinkSync(path.join(f.dir, "safe"), path.join(f.dir, "wapp", "lib"));
  fs.chmodSync(path.join(f.dir, "wapp"), 0o777);
  const lib = { name: `${f.rel}/usr/lib/libfake.so`, body: "evil\n" };
  const cases: [string, TarEntry[], RegExp][] = [
    ["../ in a name", [lib, { name: `${f.rel}/usr/../../../../../../../../../${out}/x`, body: "x" }], /climbs out with \.\./],
    ["an absolute name", [lib, { name: `/${out}/x`, body: "x" }], /is an absolute path/],
    ["a link to / and a file through it", [lib, { name: `${f.rel}/usr/esc`, type: "2", link: "/" }, { name: `${f.rel}/usr/esc/${out}/x`, body: "x" }], /lies under a link in the snapshot itself/],
    ["a setuid binary", [lib, { name: `${f.rel}/usr/bin/sudo`, body: "#!/bin/sh\n", mode: 0o4755 }], /is setuid or setgid/],
    ["a setgid binary", [lib, { name: `${f.rel}/usr/bin/sg`, body: "#!/bin/sh\n", mode: 0o2755 }], /is setuid or setgid/],
    ["a path packages do not install to", [lib, { name: `${out}/x`, body: "x" }], /is outside the paths packages install to/],
    ["a hard link to a file outside", [lib, { name: `${f.rel}/usr/h`, type: "1", link: `${out}/victim` }], /hard link .* not at a file earlier in the snapshot/],
    ["a device", [lib, { name: `${f.rel}/usr/dev`, type: "3" }], /of a kind a snapshot never holds/],
    ["a fifo", [lib, { name: `${f.rel}/usr/fifo`, type: "6" }], /of a kind a snapshot never holds/],
    ["a link already on the disk", [lib, { name: `${f.rel}/lnk/x`, body: "x" }], /leads through a link to/],
    ["a folder anyone can write", [lib, { name: `${f.rel}/ww/x`, body: "x" }], /which others can write/],
    ["a link in a folder anyone can write", [lib, { name: `${f.rel}/wapp/lib/x`, body: "x" }], /wapp, which others can write/],
    ["a name twice", [lib, { name: `${f.rel}/usr/lib/libfake.so`, type: "2", link: `/${out}/victim` }], /appears twice/],
    ["a file of the agent's", [lib, { name: `${f.rel}/usr/lib/agent.so`, body: "x", uname: "agent" }], /belongs to the agent user/],
    ["a file under a file", [lib, { name: `${f.rel}/usr/lib/libfake.so/x`, body: "x" }], /lies under the file/],
    ["a long name past the old field", [lib, { name: `${f.rel}/usr/${"d".repeat(120)}/../../../../../${out}/x`, body: "x" }], /climbs out with \.\./],
  ];
  for (const [what, entries, why] of cases) {
    f.freshPod();
    const tar = tarOf(entries);
    f.plant(key, f.BASE, tar, f.sealOf(key, f.BASE, f.now(), tar));
    const r = f.go();
    assert.equal(r.mode, "apt", what);
    assert.match(r.refused, why, what);
    assert.deepEqual(f.outsideHas(), ["victim"], `${what}: nothing written outside`);
    assert.equal(fs.readFileSync(path.join(f.outside, "victim"), "utf8"), "original\n", `${what}: the file outside is untouched`);
    assert.equal(fs.readFileSync(path.join(f.pkgRoot, "lib", "libfake.so"), "utf8"), "lib\n", `${what}: not one member of it was extracted`);
    assert.deepEqual(fs.readdirSync(path.join(f.dir, "ww")), [], `${what}: nothing in the open folder`);
    assert.deepEqual(fs.readdirSync(path.join(f.dir, "safe")), [], `${what}: nothing through the swappable link`);
  }
  // The same audit before root seals: a set whose install leaves a setuid
  // file is installed with apt every time, never kept as a snapshot.
  const bin = path.join(f.dir, "bin", "apt-get");
  fs.writeFileSync(bin, fs.readFileSync(bin, "utf8").replace(`echo "Package: fake" >>`, `cp /bin/sh ${f.pkgRoot}/lib/su && chmod 4755 ${f.pkgRoot}/lib/su && echo ${f.pkgRoot}/lib/su >> ${f.dpkg}/info/fake.list && echo "Package: fake" >>`));
  fs.rmSync(f.snapRoot, { recursive: true, force: true });
  f.freshPod();
  const r = f.go();
  assert.equal(r.mode, "apt");
  assert.match(r.unsaved, /lib\/su is setuid or setgid$/);
  assert.deepEqual(f.keys().flatMap((k) => f.gens(k)), [], "no snapshot kept");
});

test("root works in the agent's cache only where the agent could itself: a planted link moves nothing", () => {
  const f = snapFixture();
  f.go();
  const [key] = f.keys();
  // The agent swaps its key folder, then the whole snapshot folder, for links
  // into a folder it wants written or emptied (on a pod: /, /etc …).
  const victim = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sys-victim-")));
  for (let i = 0; i < 6; i++) fs.mkdirSync(path.join(victim, `d${i}`));
  fs.writeFileSync(path.join(victim, "file"), "keep\n");
  const before = fs.readdirSync(victim).sort();
  fs.rmSync(path.join(f.snapRoot, key), { recursive: true });
  fs.symlinkSync(victim, path.join(f.snapRoot, key));
  f.freshPod();
  assert.equal(f.go().mode, "apt");
  assert.deepEqual(fs.readdirSync(victim).sort(), before, "nothing published into, or pruned from, the link's target");
  fs.rmSync(f.snapRoot, { recursive: true });
  fs.symlinkSync(victim, f.snapRoot);
  f.freshPod();
  assert.equal(f.go().mode, "apt");
  assert.deepEqual(fs.readdirSync(victim).sort(), before);
  for (const d of fs.readdirSync(victim)) if (d.startsWith("d")) assert.deepEqual(fs.readdirSync(path.join(victim, d)), [], "nor into its folders");
});

test("root's start-up runs apt with none of the step's environment but the proxy", () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sys-env-")));
  // A PATH the account's env could set, with an `env` of its own first on it.
  const evil = path.join(dir, "evil");
  fs.mkdirSync(evil);
  fs.writeFileSync(path.join(evil, "env"), `#!/bin/sh\necho pwned > ${dir}/pwned\n`, { mode: 0o755 });
  const r = spawnSync("sh", ["-c", `${ROOT_ENV_RESET_SH}\nenv > ${dir}/seen`], {
    env: {
      PATH: `${evil}:/usr/bin:/bin`,
      HTTPS_PROXY: "http://foldrun:t@egress:3128",
      no_proxy: "localhost",
      MY_SECRET: "s3cret",
      NODE_OPTIONS: "--require /nowhere.js",
      LD_PRELOAD: "/nowhere.so",
      FOLDRUN_DPKG_DIR: "/home/agent/dpkg",
      FOLDRUN_SYS_ALLOW: "home",
      MULTI: "line one\nexport NOT_A_VAR=1",
    },
    encoding: "utf8",
  });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.existsSync(path.join(dir, "pwned")), false, "the step's PATH is not root's");
  const seen = fs.readFileSync(path.join(dir, "seen"), "utf8");
  assert.match(seen, /^HTTPS_PROXY=http:\/\/foldrun:t@egress:3128$/m);
  assert.match(seen, /^no_proxy=localhost$/m);
  assert.match(seen, /^PATH=\/usr\/local\/sbin:\/usr\/local\/bin:\/usr\/sbin:\/usr\/bin:\/sbin:\/bin$/m);
  for (const gone of ["MY_SECRET", "NODE_OPTIONS", "LD_PRELOAD", "FOLDRUN_DPKG_DIR", "FOLDRUN_SYS_ALLOW", "MULTI"]) {
    assert.doesNotMatch(seen, new RegExp(`^${gone}=`, "m"), `${gone} is not in root's environment`);
  }
  // And the shell after it splits words as a shell does: the package list,
  // `runuser -u agent --` and tar's flags are all split on spaces.
  const split = spawnSync("sh", ["-c", `${ROOT_ENV_RESET_SH}
set -- $(echo "a b	c"); echo $#; X="printf %s"; $X ok`], { env: { IFS: "x", PATH: "/usr/bin:/bin" }, encoding: "utf8" });
  assert.equal(split.stdout, "3\nok");
});
