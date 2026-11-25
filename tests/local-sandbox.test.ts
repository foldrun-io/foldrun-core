// The local sandbox (FOL-214): the pure rules the file tools apply, the
// refusals (fail closed), and — where the host can start one — the real
// walls, through the engine's own Bash, Write and Read tools.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { APPARMOR_HINT, CONTAINER_HINT, inContainer, appArmorRestrictsUserns, cacheProblem, carry, chainOutside, fileRules, helperFolder, killTree, linkHops, remoteHelper, shellWords, gitProtected, type GitCache, isRefusal, openLocalSandbox, realish, trustedPath } from "../src/local-sandbox.ts";
import { readOptions } from "../src/engine-common.ts";
import { connectMcp } from "../src/engine-mcp.ts";
import { ENGINE_TOOLS, type ToolContext } from "../src/engine-tools.ts";
import { shellLine } from "../src/engine-mcp.ts";

const tmpProject = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-sbx-test-")));

test("the file rules: write the project and its temp only, never git hooks or config, never read credentials", () => {
  const proj = tmpProject();
  const tmp = tmpProject();
  try {
    const r = fileRules({ cwd: proj, sites: [] }, tmp, [path.join(proj, ".git/hooks"), path.join(proj, ".git/config")]);
    assert.equal(r.canWrite(path.join(proj, "src/new.ts")), true, "a file that does not exist yet, inside");
    assert.equal(r.canWrite(path.join(tmp, "x")), true);
    assert.equal(r.canWrite(path.join(os.homedir(), "x.txt")), false);
    assert.equal(r.canWrite("/etc/hosts"), false);
    assert.equal(r.canWrite(path.join(proj, ".git/hooks/pre-commit")), false);
    assert.equal(r.canWrite(path.join(proj, ".git/config")), false);
    assert.equal(r.canWrite(path.join(proj, ".git/HEAD")), true);
    assert.equal(r.canRead(path.join(os.homedir(), ".ssh/id_ed25519")), false);
    assert.equal(r.canRead(path.join(os.homedir(), ".aws/credentials")), false);
    assert.equal(r.canRead(path.join(os.homedir(), ".foldrun/credentials.json")), false);
    assert.equal(r.canRead(path.join(proj, "README.md")), true);
    assert.equal(r.canRead("/usr/bin/env"), true);
    // A link inside the project that leads out is judged by where it lands.
    fs.symlinkSync(os.homedir(), path.join(proj, "home"));
    assert.equal(r.canWrite(path.join(proj, "home/escape.txt")), false);
    assert.equal(r.canRead(path.join(proj, "home/.ssh/id_rsa")), false);
    // A name that only starts like the project is not inside it.
    assert.equal(r.canWrite(proj + "-other/x"), false);
    // A nested repository's hooks and config, at any depth.
    assert.equal(r.canWrite(path.join(proj, "vendor/lib/.git/hooks/post-checkout")), false);
    assert.equal(r.canWrite(path.join(proj, "vendor/lib/.git/config")), false);
    assert.equal(r.canWrite(path.join(proj, "vendor/lib/.git/HEAD")), true);
  } finally {
    fs.rmSync(proj, { recursive: true, force: true });
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("realish resolves the nearest existing parent of a path that does not exist", () => {
  const proj = tmpProject();
  try {
    assert.equal(realish(path.join(proj, "a/b/c.txt")), path.join(proj, "a/b/c.txt"));
  } finally {
    fs.rmSync(proj, { recursive: true, force: true });
  }
});

test("refused, never run without walls: Windows, an unknown OS, a runtime that does not load, missing tools", async () => {
  const win = await openLocalSandbox({ cwd: os.tmpdir(), sites: [] }, { platform: "win32" });
  assert.ok(isRefusal(win) && /Windows/.test(win.refused) && /WSL2/.test(win.hint ?? ""));
  const bsd = await openLocalSandbox({ cwd: os.tmpdir(), sites: [] }, { platform: "freebsd" });
  assert.ok(isRefusal(bsd));
  const broken = await openLocalSandbox({ cwd: os.tmpdir(), sites: [] }, { platform: "linux", load: () => Promise.reject(new Error("gone")) });
  assert.ok(isRefusal(broken) && /did not load: gone/.test(broken.refused));
  const missing = await openLocalSandbox({ cwd: os.tmpdir(), sites: [] }, {
    platform: "darwin",
    load: async () =>
      ({ SandboxManager: { isSupportedPlatform: () => true, checkDependencies: () => ({ errors: ["ripgrep (rg) not found"], warnings: [] }) } }) as never,
  });
  assert.ok(isRefusal(missing) && /ripgrep/.test(missing.refused) && /brew install ripgrep/.test(missing.hint ?? ""));
});

test("Ubuntu's AppArmor userns block is recognised, and the fix offered is the bwrap profile, not turning it off", () => {
  assert.equal(appArmorRestrictsUserns(() => "1\n"), true);
  assert.equal(appArmorRestrictsUserns(() => "0\n"), false);
  assert.equal(appArmorRestrictsUserns(() => { throw new Error("ENOENT"); }), false);
  assert.match(APPARMOR_HINT, /bwrap-userns-restrict/);
  // A container's runtime decides, not the host's AppArmor (bench, 25 Nov 2026).
  assert.equal(inContainer((f) => f === "/.dockerenv", () => ""), true, "Docker");
  assert.equal(inContainer((f) => f === "/run/.containerenv", () => ""), true, "Podman");
  assert.equal(inContainer(() => false, () => "0::/kubepods/burstable/pod1/abc\n"), true, "a Kubernetes pod");
  assert.equal(inContainer(() => false, () => "0::/init.scope\n"), false, "a machine of its own");
  assert.equal(inContainer(() => false, () => { throw new Error("ENOENT"); }), false);
  assert.match(CONTAINER_HINT, /sandbox off/);
  assert.doesNotMatch(CONTAINER_HINT, /Ubuntu/);
  assert.doesNotMatch(APPARMOR_HINT, /sysctl|=0/);
});

test("shellLine quotes every word, quotes inside included", () => {
  assert.equal(shellLine("npx", ["-y", "it's"]), `'npx' '-y' 'it'\\''s'`);
});

// ------------------------------------------------------- the real walls

const ctxFor = (cwd: string, sandbox: ToolContext["sandbox"], env: Record<string, string | undefined>): ToolContext => ({
  cwd,
  env,
  signal: new AbortController().signal,
  reads: new Map(),
  groups: new Set(),
  sandbox,
});

test("inside the walls: a site not on the list is asked about, by host, and only a yes lets it through (FOL-312)", async (t) => {
  if (process.platform !== "darwin" && process.platform !== "linux") return t.skip("no local sandbox on this OS");
  const proj = tmpProject();
  const asked: string[] = [];
  let answer: boolean | { allow: false; reason: string } = { allow: false, reason: "the person said no" };
  const box = await openLocalSandbox({ cwd: proj, sites: [] }, {}, async (host, port) => (asked.push(`${host}:${port}`), answer));
  if (isRefusal(box)) {
    fs.rmSync(proj, { recursive: true, force: true });
    if (process.env.FOLDRUN_REQUIRE_SANDBOX === "1") assert.fail(`the sandbox must start here: ${box.refused}`);
    return t.skip(`the sandbox cannot start here: ${box.refused}`);
  }
  try {
    assert.deepEqual(asked, [], "the probe's own unlisted site is never asked about");
    const ctx = ctxFor(proj, box, { ...process.env, TMPDIR: box.tmp });
    const bash = (command: string) => ENGINE_TOOLS.Bash!.run({ command, timeout: 30_000 }, ctx);
    const no = await bash("curl -sS -m 10 -o /dev/null -w '%{http_code}' https://example.org/");
    assert.equal(no.isError, true, no.text);
    assert.ok(asked.includes("example.org:443"), JSON.stringify(asked));
    // A yes lets that connection through (whether the site then answers depends on this machine's network).
    answer = true;
    const n = asked.length;
    await bash("curl -sS -m 10 -o /dev/null https://example.org/ || true");
    assert.ok(asked.length > n, "asked again: remembering an answer is the caller's");
    // A second opener of the same walls never answers for the first (Codex).
    const other: string[] = [];
    const second = await openLocalSandbox({ cwd: proj, sites: [] }, {}, async (h) => (other.push(h), true));
    assert.ok(!isRefusal(second));
    answer = { allow: false, reason: "no" };
    await bash("curl -sS -m 10 -o /dev/null https://example.org/ || true");
    assert.deepEqual(other, [], "the first handle's asker still answers");
    await (second as any).close();
  } finally {
    await box.close();
    fs.rmSync(proj, { recursive: true, force: true });
  }
});

test("inside the walls: an opener of walls already up cannot install an asker (FOL-312, Codex)", async (t) => {
  if (process.platform !== "darwin" && process.platform !== "linux") return t.skip("no local sandbox on this OS");
  const proj = tmpProject();
  const first = await openLocalSandbox({ cwd: proj, sites: [] });
  if (isRefusal(first)) {
    fs.rmSync(proj, { recursive: true, force: true });
    if (process.env.FOLDRUN_REQUIRE_SANDBOX === "1") assert.fail(`the sandbox must start here: ${first.refused}`);
    return t.skip(`the sandbox cannot start here: ${first.refused}`);
  }
  const asked: string[] = [];
  const second = await openLocalSandbox({ cwd: proj, sites: [] }, {}, async (h) => (asked.push(h), true));
  try {
    assert.ok(!isRefusal(second));
    const ctx = ctxFor(proj, first, { ...process.env, TMPDIR: first.tmp });
    const r = await ENGINE_TOOLS.Bash!.run({ command: "curl -sS -m 10 -o /dev/null https://example.org/", timeout: 30_000 }, ctx);
    assert.equal(r.isError, true, "refused: no asker on these walls");
    assert.deepEqual(asked, [], "the second opener's asker was never installed");
  } finally {
    if (!isRefusal(second)) await second.close();
    await first.close();
    fs.rmSync(proj, { recursive: true, force: true });
  }
});

test("inside the walls: the syntax guard reads the grammar and checks Python there (FOL-292)", async (t) => {
  if (process.platform !== "darwin" && process.platform !== "linux") return t.skip("no local sandbox on this OS");
  const proj = tmpProject();
  const box = await openLocalSandbox({ cwd: proj, sites: [] });
  if (isRefusal(box)) {
    fs.rmSync(proj, { recursive: true, force: true });
    if (process.env.FOLDRUN_REQUIRE_SANDBOX === "1") assert.fail(`the sandbox must start here: ${box.refused}`);
    return t.skip(`the sandbox cannot start here: ${box.refused}`);
  }
  try {
    const ctx = { ...ctxFor(proj, box, { ...process.env, TMPDIR: box.tmp }), programs: true };
    fs.writeFileSync(path.join(proj, "package.json"), JSON.stringify({ type: "module" }));
    const f = path.join(proj, "m.js");
    fs.writeFileSync(f, "export const a = 1;\n");
    await ENGINE_TOOLS.Read!.run({ file_path: f }, ctx);
    // `with` parses as a script but not as a module: refused because the package says module (read inside the walls).
    const w = await ENGINE_TOOLS.Write!.run({ file_path: f, content: "with ({}) {}\n" }, ctx);
    assert.equal(w.isError, true, w.text);
    assert.match(w.text, /would stop parsing/);
    // A dependency under node_modules is outside the project's package scope, as node reads it.
    fs.mkdirSync(path.join(proj, "node_modules", "dep"), { recursive: true });
    const dep = await ENGINE_TOOLS.Write!.run({ file_path: path.join(proj, "node_modules", "dep", "index.js"), content: "with ({}) {}\n" }, ctx);
    assert.equal(dep.isError, undefined, dep.text);
    // Python, through the walls, when a system python3 is there.
    const { systemPython } = await import("../src/edit-check.ts");
    if (systemPython()) {
      const p = path.join(proj, "x.py");
      const r = await ENGINE_TOOLS.Write!.run({ file_path: p, content: "def (:\n" }, ctx);
      assert.equal(r.isError, true, r.text);
      assert.match(r.text, /SyntaxError/);
      const ok = await ENGINE_TOOLS.Write!.run({ file_path: p, content: "x = 1\n" }, ctx);
      assert.equal(ok.isError, undefined, ok.text);
    }
  } finally {
    await box.close();
    fs.rmSync(proj, { recursive: true, force: true });
  }
});

test("inside the walls: the shell writes the project, not the home folder; credentials stay unread; only listed sites answer", async (t) => {
  if (process.platform !== "darwin" && process.platform !== "linux") return t.skip("no local sandbox on this OS");
  const proj = tmpProject();
  const box = await openLocalSandbox({ cwd: proj, sites: ["registry.npmjs.org"] });
  if (isRefusal(box)) {
    fs.rmSync(proj, { recursive: true, force: true });
    if (process.env.FOLDRUN_REQUIRE_SANDBOX === "1") assert.fail(`the sandbox must start here: ${box.refused}`);
    return t.skip(`the sandbox cannot start here: ${box.refused}`);
  }
  const marker = path.join(os.homedir(), `.foldrun-sbx-escape-${process.pid}`);
  try {
    const ctx = ctxFor(proj, box, { ...process.env, TMPDIR: box.tmp });
    const bash = (command: string) => ENGINE_TOOLS.Bash!.run({ command, timeout: 30_000 }, ctx);
    const inside = await bash("echo hi > made.txt && cat made.txt");
    assert.equal(inside.isError, undefined, inside.text);
    assert.equal(inside.text, "hi");
    const out = await bash(`echo x > ${JSON.stringify(marker)}`);
    assert.equal(out.isError, true);
    assert.equal(fs.existsSync(marker), false, "nothing landed in the home folder");
    const ssh = await bash("ls ~/.ssh");
    // Either it is not there, or it is not readable — never listed.
    assert.equal(ssh.isError, true, ssh.text);
    const tmpWrite = await bash('echo t > "$TMPDIR/t" && cat "$TMPDIR/t"');
    assert.equal(tmpWrite.text, "t");
    // The engine's own file tools ask the same rules.
    const w = await ENGINE_TOOLS.Write!.run({ file_path: marker, content: "x" }, ctx);
    assert.equal(w.isError, true);
    assert.match(w.text, /outside what this session may write/);
    const r = await ENGINE_TOOLS.Read!.run({ file_path: path.join(os.homedir(), ".ssh/id_rsa") }, ctx);
    assert.equal(r.isError, true);
    assert.match(r.text, /credentials/);
    // Network: an unlisted site is refused at the proxy. (A listed one is
    // left to the network test below: CI may have no way out.)
    const denied = await bash("curl -sS -m 10 -o /dev/null -w '%{http_code}' https://example.com/");
    assert.equal(denied.isError, true, denied.text);
  } finally {
    fs.rmSync(marker, { force: true });
    await box.close();
    fs.rmSync(proj, { recursive: true, force: true });
  }
});

test("what the walls do is said in plain words: no backend names, and every writable folder listed (FOL-271)", async (t) => {
  if (process.platform !== "darwin" && process.platform !== "linux") return t.skip("no local sandbox on this OS");
  const proj = tmpProject();
  const box = await openLocalSandbox({ cwd: proj, sites: ["registry.npmjs.org", "github.com"] });
  if (isRefusal(box)) {
    fs.rmSync(proj, { recursive: true, force: true });
    if (process.env.FOLDRUN_REQUIRE_SANDBOX === "1") assert.fail(`the sandbox must start here: ${box.refused}`);
    return t.skip(`the sandbox cannot start here: ${box.refused}`);
  }
  try {
    const said = box.describe();
    assert.doesNotMatch(said, /seatbelt|bubblewrap|bwrap|seccomp|landlock|sandbox-runtime|gvisor/i, said);
    assert.match(said, /changes stay here and in a package cache/);
    assert.match(said, /internet limited to 2 approved sites/);
    assert.ok(said.length <= 140, `one short line: ${said.length} characters`);
    const w = box.writable();
    assert.equal(w[0], proj);
    assert.ok(w.includes(box.tmp), "its temp folder is listed");
    assert.ok(w.length > 2, "the runtime's own folders are listed too");
  } finally {
    await box.close();
    fs.rmSync(proj, { recursive: true, force: true });
  }
});

test("package managers keep their downloads in the project's cache, not the home folder (FOL-272)", async (t) => {
  if (process.platform !== "darwin" && process.platform !== "linux") return t.skip("no local sandbox on this OS");
  const proj = tmpProject();
  const cache = path.join(tmpProject(), "packages");
  const box = await openLocalSandbox({ cwd: proj, sites: [], cache });
  if (isRefusal(box)) {
    fs.rmSync(proj, { recursive: true, force: true });
    if (process.env.FOLDRUN_REQUIRE_SANDBOX === "1") assert.fail(`the sandbox must start here: ${box.refused}`);
    return t.skip(`the sandbox cannot start here: ${box.refused}`);
  }
  try {
    assert.equal(box.cache, fs.realpathSync(cache));
    assert.ok(box.writable().includes(box.cache));
    const ctx = ctxFor(proj, box, { ...process.env, TMPDIR: box.tmp, npm_config_cache: path.join(os.homedir(), ".npm") });
    const bash = (command: string) => ENGINE_TOOLS.Bash!.run({ command, timeout: 30_000 }, ctx);
    const r = await bash('echo "$npm_config_cache|$PIP_CACHE_DIR" && mkdir -p "$npm_config_cache" && echo ok > "$npm_config_cache/probe" && cat "$npm_config_cache/probe"');
    assert.equal(r.isError, undefined, r.text);
    assert.ok(r.text.includes(`${path.join(box.cache, "npm")}|${path.join(box.cache, "pip")}`), r.text);
    assert.match(r.text, /\bok\b/);
    assert.equal(fs.readFileSync(path.join(box.cache, "npm", "probe"), "utf8"), "ok\n");
    // The home folder's own npm folder stays out of reach.
    const home = await bash(`touch "${path.join(os.homedir(), ".npm", `foldrun-sbx-${process.pid}`)}" 2>&1; echo "exit=$?"`);
    assert.doesNotMatch(home.text, /exit=0/, home.text);
  } finally {
    await box.close();
    fs.rmSync(proj, { recursive: true, force: true });
    fs.rmSync(path.dirname(cache), { recursive: true, force: true });
  }
});

test("a package cache inside a credential folder is refused", async () => {
  const proj = tmpProject();
  try {
    const box = await openLocalSandbox({ cwd: proj, sites: [], cache: path.join(os.homedir(), ".ssh", "foldrun-cache") }, { platform: process.platform === "linux" ? "linux" : "darwin" });
    assert.ok(isRefusal(box), "refused");
    assert.equal(fs.existsSync(path.join(os.homedir(), ".ssh", "foldrun-cache")), false, "nothing made there");
  } finally {
    fs.rmSync(proj, { recursive: true, force: true });
  }
});

test("a package cache in or around the project, or behind a link that is not the system's, is refused before it is made writable (Codex)", async () => {
  const proj = tmpProject();
  const home = fs.mkdtempSync(path.join(os.homedir(), ".foldrun-cache-test-"));
  try {
    // Inside the project, and the project inside it.
    assert.match(cacheProblem(path.join(proj, ".cache", "pkgs"), proj, []) ?? "", /project folder/);
    assert.match(cacheProblem(path.dirname(proj), proj, []) ?? "", /project folder/);
    // A link under the home anywhere on the way: the person's own npx cache behind it would become writable.
    const real = path.join(home, "npx");
    fs.mkdirSync(real);
    fs.symlinkSync(real, path.join(home, "link"));
    assert.match(cacheProblem(path.join(home, "link"), proj, []) ?? "", /symbolic link/);
    assert.match(cacheProblem(path.join(home, "link", "deeper"), proj, []) ?? "", /symbolic link/);
    // A link outside the home too (an XDG cache in /tmp): only the system's own, owned by root, may be on the way (Codex).
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-xdg-"));
    try {
      fs.mkdirSync(path.join(outside, "real"));
      fs.symlinkSync(path.join(outside, "real"), path.join(outside, "foldrun-packages"));
      assert.match(cacheProblem(path.join(outside, "foldrun-packages", "proj-1"), proj, []) ?? "", /symbolic link/);
      assert.equal(cacheProblem(path.join(outside, "real", "proj-1"), proj, []), null, "the system's /var or /tmp link above it is fine");
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
    // A folder of this person's that others may write, without the sticky bit: refused; with it (as /tmp), fine.
    const shared = path.join(home, "shared");
    fs.mkdirSync(shared);
    fs.chmodSync(shared, 0o775);
    assert.match(cacheProblem(path.join(shared, "proj-1"), proj, []) ?? "", /others can write/);
    fs.chmodSync(shared, 0o1777);
    assert.equal(cacheProblem(path.join(shared, "proj-1"), proj, []), null);
    // macOS: 755, but an access list lets everyone add and remove entries.
    if (process.platform === "darwin") {
      const acl = path.join(home, "acl");
      fs.mkdirSync(acl, { mode: 0o755 });
      spawnSync("/bin/chmod", ["+a", "everyone allow add_file,add_subdirectory,delete_child", acl]);
      assert.match(cacheProblem(path.join(acl, "proj-1"), proj, []) ?? "", /access list/);
      // The home's own "everyone deny delete" is not a way in.
      assert.equal(cacheProblem(path.join(home, "plain", "proj-1"), proj, []), null);
    }
    // A file in the way, and a relative path.
    fs.writeFileSync(path.join(home, "file"), "");
    assert.match(cacheProblem(path.join(home, "file", "x"), proj, []) ?? "", /file where a folder/);
    assert.match(cacheProblem("relative/cache", proj, []) ?? "", /absolute/);
    // A plain folder of its own is fine.
    assert.equal(cacheProblem(path.join(home, "packages", "proj-1"), proj, []), null);
    // And the open itself refuses a cache in the project, making nothing there.
    const box = await openLocalSandbox({ cwd: proj, sites: [], cache: path.join(proj, "cache") }, { platform: process.platform === "linux" ? "linux" : "darwin" });
    assert.ok(isRefusal(box), "refused");
    assert.equal(fs.existsSync(path.join(proj, "cache")), false, "nothing made there");
  } finally {
    fs.rmSync(proj, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("a helper this process would run by name may not sit in the package cache either (Codex)", () => {
  const cache = tmpProject();
  const bin = tmpProject();
  try {
    fs.writeFileSync(path.join(cache, "rg"), "#!/bin/sh\n", { mode: 0o755 });
    fs.symlinkSync(path.join(cache, "rg"), path.join(bin, "rg"));
    const bad = helperFolder([bin, "/usr/bin", "/bin"].join(path.delimiter), [cache]);
    assert.ok("refused" in bad, JSON.stringify(bad));
  } finally {
    fs.rmSync(cache, { recursive: true, force: true });
    fs.rmSync(bin, { recursive: true, force: true });
  }
});

test("inside the walls a listed site answers (skipped offline)", { skip: process.env.FOLDRUN_TEST_OFFLINE === "1" ? "offline" : false }, async (t) => {
  if (process.platform !== "darwin" && process.platform !== "linux") return t.skip("no local sandbox on this OS");
  const proj = tmpProject();
  const box = await openLocalSandbox({ cwd: proj, sites: ["registry.npmjs.org"] });
  if (isRefusal(box)) {
    fs.rmSync(proj, { recursive: true, force: true });
    if (process.env.FOLDRUN_REQUIRE_SANDBOX === "1") assert.fail(`the sandbox must start here: ${box.refused}`);
    return t.skip(`the sandbox cannot start here: ${box.refused}`);
  }
  try {
    const ctx = ctxFor(proj, box, { ...process.env, TMPDIR: box.tmp });
    const ok = await ENGINE_TOOLS.Bash!.run({ command: "curl -sS -m 20 -o /dev/null -w '%{http_code}' https://registry.npmjs.org/", timeout: 30_000 }, ctx);
    if (ok.isError && /resolve|network is unreachable/i.test(ok.text)) return t.skip("no network here");
    assert.equal(ok.text, "200", ok.text);
  } finally {
    await box.close();
    fs.rmSync(proj, { recursive: true, force: true });
  }
});

test("on a Mac a deny holds for every spelling of the path's case", () => {
  const proj = tmpProject();
  const tmp = tmpProject();
  try {
    const mac = fileRules({ cwd: proj, sites: [] }, tmp, [path.join(proj, ".git/config")], "darwin");
    assert.equal(mac.canRead(path.join(os.homedir(), ".SSH/id_rsa")), false);
    assert.equal(mac.canRead(path.join(os.homedir(), ".Aws/credentials")), false);
    assert.equal(mac.canWrite(path.join(proj, ".GIT/CONFIG")), false);
    assert.equal(mac.canWrite(path.join(proj, ".git/Hooks/pre-commit")), false);
  } finally {
    fs.rmSync(proj, { recursive: true, force: true });
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("the git paths that run code are protected: the repo's hooks and config, and the folder core.hooksPath names", () => {
  const proj = tmpProject();
  try {
    assert.equal(spawnSync("git", ["init", "-q", proj]).status, 0);
    assert.equal(spawnSync("git", ["-C", proj, "config", "core.hooksPath", ".githooks"]).status, 0);
    fs.mkdirSync(path.join(proj, "sub"));
    const got = gitProtected(path.join(proj, "sub"));
    for (const p of [".git/hooks", ".git/config", ".githooks"]) assert.ok(got.includes(realish(path.join(proj, p))), `${p} in ${got.join(", ")}`);
    const r = fileRules({ cwd: path.join(proj, "sub"), sites: [] }, os.tmpdir(), got);
    assert.equal(r.canWrite(path.join(proj, "sub/ok.txt")), true);
  } finally {
    fs.rmSync(proj, { recursive: true, force: true });
  }
});

test("the launcher's PATH holds no folder a command may write, and no relative entry", () => {
  const proj = tmpProject();
  try {
    const got = trustedPath([path.join(proj, "node_modules/.bin"), "/usr/bin", ".", "", "bin", "/bin", path.join(proj, "bin")].join(path.delimiter), [proj]);
    // Each by where it really is (on a merged-/usr Linux /bin is /usr/bin).
    assert.deepEqual(got.split(path.delimiter), [...new Set([realish("/usr/bin"), realish("/bin")])]);
    // A link in the project to a system folder is kept as where it points.
    fs.symlinkSync("/usr/bin", path.join(proj, "sysbin"));
    assert.equal(trustedPath(path.join(proj, "sysbin"), [proj]), realish("/usr/bin"));
    assert.equal(trustedPath(path.join(proj, "bin"), [proj]), "/usr/bin:/bin:/usr/sbin:/sbin");
  } finally {
    fs.rmSync(proj, { recursive: true, force: true });
  }
});

test("git's answers are kept per repository, and asked again when anything they came from changes", async () => {
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-gitcache-"));
  const git = (...a: string[]) => assert.equal(spawnSync("git", a, { encoding: "utf8" }).status, 0, a.join(" "));
  const env = { ...process.env, GIT_CONFIG_GLOBAL: path.join(proj, "..", path.basename(proj) + "-global"), GIT_CONFIG_NOSYSTEM: "1" };
  const wait = () => new Promise((r) => setTimeout(r, 1100)); // past the "racy" second
  try {
    git("init", "-q", proj);
    git("init", "-q", path.join(proj, "sub"));
    await wait();
    const cache: GitCache = new Map();
    const ask = () => gitProtected(proj, undefined, env, [proj], cache).sort();
    const first = ask();
    assert.equal(cache.size, 2, "both repositories kept");
    assert.deepEqual(ask(), first, "unchanged: the same answer");
    // A hooks path set in a nested repository's config: seen at once.
    git("-C", path.join(proj, "sub"), "config", "core.hooksPath", "tools/hooks");
    const hooks = path.join(realish(path.join(proj, "sub")), "tools/hooks");
    assert.ok(ask().includes(hooks), "a config change is asked again");
    // Changed within the racy second: not kept, so a later change in that second is still seen.
    git("-C", path.join(proj, "sub"), "config", "core.hooksPath", "tools/hooks2");
    assert.ok(ask().includes(path.join(realish(path.join(proj, "sub")), "tools/hooks2")));
    assert.equal(cache.has(realish(path.join(proj, "sub"))) || cache.has(path.join(proj, "sub")), false, "a just-changed repository is not kept");
    await wait();
    ask();
    // An include file that appears where the config points: the config names it, so it is watched, there or not.
    git("-C", proj, "config", "include.path", "extra.gitconfig");
    await wait();
    ask();
    fs.writeFileSync(path.join(proj, ".git", "extra.gitconfig"), "[core]\n\thooksPath = from-include\n");
    assert.ok(ask().some((x) => x.endsWith(`${path.sep}from-include`)), "an include file that appeared is read");
    // The global config is every repository's: a change there is seen for all.
    await wait();
    ask();
    fs.writeFileSync(env.GIT_CONFIG_GLOBAL, "[core]\n\tpager = ./pager-in-project\n");
    assert.ok(ask().some((x) => x.endsWith(`${path.sep}pager-in-project`)), "a global config change is seen");
    // Edited in place (same inode: an editor that writes over the file, `>>`): seen by its times and size.
    await wait();
    ask();
    const ino = fs.statSync(env.GIT_CONFIG_GLOBAL).ino;
    fs.appendFileSync(env.GIT_CONFIG_GLOBAL, "[diff]\n\texternal = ./differ-in-project\n");
    assert.equal(fs.statSync(env.GIT_CONFIG_GLOBAL).ino, ino, "the same file");
    assert.ok(ask().some((x) => x.endsWith(`${path.sep}differ-in-project`)), "an in-place edit is seen");
    await wait();
    ask();
    const subConfig = path.join(proj, "sub", ".git", "config");
    fs.appendFileSync(subConfig, "[core]\n\tfsmonitor = ./monitor-in-project\n");
    assert.ok(ask().some((x) => x.endsWith(`${path.sep}monitor-in-project`)), "an in-place edit of a repository's config is seen");
    // A new repository made by a command: found by the walk, asked in full.
    await wait();
    ask();
    git("init", "-q", path.join(proj, "made", "later"));
    assert.ok(ask().some((x) => x.includes(`made${path.sep}later${path.sep}.git${path.sep}hooks`)), "a new repository is found");
    // A .git swapped for another: by identity, asked again.
    await wait();
    ask();
    fs.renameSync(path.join(proj, "sub", ".git"), `${proj}-old-sub-git`);
    git("init", "-q", path.join(proj, "sub"));
    git("-C", path.join(proj, "sub"), "config", "core.hooksPath", "swapped");
    assert.ok(ask().includes(path.join(realish(path.join(proj, "sub")), "swapped")), "a swapped .git is asked again");
    // Commits and new files in the work tree change nothing asked: still kept (the point of it).
    await wait();
    ask();
    const kept = cache.get([...cache.keys()].find((k) => k.endsWith(`${path.sep}sub`))!);
    fs.writeFileSync(path.join(proj, "sub", "f.txt"), "x");
    git("-C", path.join(proj, "sub"), "add", "f.txt");
    git("-C", path.join(proj, "sub"), "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "x");
    ask();
    assert.equal(cache.get([...cache.keys()].find((k) => k.endsWith(`${path.sep}sub`))!), kept, "a commit does not throw the answer away");
    // Asked with other settings (another PATH, environment or writable folders): nothing kept counts.
    const other = gitProtected(proj, undefined, { ...env, GIT_CONFIG_GLOBAL: path.join(proj, "elsewhere") }, [proj], cache);
    assert.ok(!other.some((x) => x.endsWith(`${path.sep}pager-in-project`)), "another environment is asked, not answered from the cache");
  } finally {
    fs.rmSync(proj, { recursive: true, force: true });
    fs.rmSync(path.join(proj, "..", path.basename(proj) + "-global"), { force: true });
    fs.rmSync(`${proj}-old-sub-git`, { recursive: true, force: true });
  }
});

test("kept git answers are not used when another git program would answer (Codex round 21)", async () => {
  const base = realish(fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-gitcache4-")));
  try {
    const bin = path.join(base, "bin");
    fs.mkdirSync(bin);
    const real = spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8", env: { PATH: "/usr/bin:/bin:/opt/homebrew/bin:/usr/local/bin" } }).stdout.trim();
    fs.writeFileSync(path.join(bin, "git"), `#!/bin/sh\nexec ${real} "$@"\n`, { mode: 0o755 });
    const proj = path.join(base, "proj");
    assert.equal(spawnSync(real, ["init", "-q", proj]).status, 0);
    const env = { ...process.env, GIT_CONFIG_GLOBAL: path.join(base, "global"), GIT_CONFIG_NOSYSTEM: "1" };
    const cache: GitCache = new Map();
    await new Promise((r) => setTimeout(r, 1100));
    const pathVar = `${bin}:/usr/bin:/bin`;
    gitProtected(proj, pathVar, env, [proj], cache);
    const kept = [...cache.values()][0];
    assert.ok(kept);
    gitProtected(proj, pathVar, env, [proj], cache);
    assert.equal([...cache.values()][0], kept, "the same git: kept");
    fs.appendFileSync(path.join(bin, "git"), "# another build\n");
    gitProtected(proj, pathVar, env, [proj], cache);
    assert.notEqual([...cache.values()][0], kept, "another git: asked again");
    // A git that cannot say where its system config is (2.39 has no `var GIT_CONFIG_SYSTEM`): nothing kept (Codex round 30).
    fs.writeFileSync(path.join(bin, "git"), `#!/bin/sh\nfor a in "$@"; do [ "$a" = GIT_CONFIG_SYSTEM ] && { echo "usage: git var (-l | <variable>)" >&2; exit 129; }; done\nexec ${real} "$@"\n`, { mode: 0o755 });
    const old: GitCache = new Map();
    await new Promise((r) => setTimeout(r, 1100));
    gitProtected(proj, pathVar, { ...env, GIT_CONFIG_NOSYSTEM: "" }, [proj], old);
    assert.equal(old.size, 0, "an older git's answer is not kept");
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("kept git answers ask git which repository each time: a folder made bare between, a .git file pointed elsewhere, a hooks folder on PATH (Codex round 20)", async () => {
  const base = realish(fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-gitcache3-")));
  const outside = path.join(base, "outside");
  fs.mkdirSync(outside);
  const git = (...a: string[]) => assert.equal(spawnSync("git", a, { encoding: "utf8" }).status, 0, a.join(" "));
  const wait = () => new Promise((r) => setTimeout(r, 1100));
  try {
    // 1. Started below the top; the folder between is made a bare repository with hooks in the project.
    const proj = path.join(base, "proj");
    const deep = path.join(proj, "a", "b");
    fs.mkdirSync(deep, { recursive: true });
    git("init", "-q", proj);
    const env = { ...process.env, GIT_CONFIG_GLOBAL: path.join(outside, "global"), GIT_CONFIG_NOSYSTEM: "1" };
    const cache: GitCache = new Map();
    await wait();
    gitProtected(deep, undefined, env, [deep], cache);
    assert.equal(cache.size, 1);
    git("init", "-q", "--bare", path.join(proj, "a"));
    git("--git-dir", path.join(proj, "a"), "config", "core.hooksPath", path.join(deep, "bare-hooks"));
    const r1 = spawnSync("git", ["-C", deep, "rev-parse", "--absolute-git-dir"], { encoding: "utf8" });
    if (r1.status === 0 && r1.stdout.trim() === path.join(proj, "a")) {
      assert.ok(gitProtected(deep, undefined, env, [deep], cache).includes(path.join(deep, "bare-hooks")), "a folder made bare between is seen");
    }
    // 2. A worktree's .git file pointed at another repository, edited in place.
    const main1 = path.join(base, "main1");
    const main2 = path.join(base, "main2");
    for (const m of [main1, main2]) {
      git("init", "-q", m);
      git("-C", m, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "x");
    }
    const wt = path.join(base, "wt");
    git("-C", main1, "worktree", "add", "-q", "--detach", wt);
    git("-C", main2, "worktree", "add", "-q", "--detach", path.join(base, "wt2"));
    git("-C", main2, "config", "core.hooksPath", path.join(wt, "other-hooks"));
    const c2: GitCache = new Map();
    await wait();
    gitProtected(wt, undefined, env, [wt], c2);
    const dotGit = path.join(wt, ".git");
    const wt2Git = fs.readFileSync(path.join(base, "wt2", ".git"), "utf8");
    const fd = fs.openSync(dotGit, "r+");
    fs.ftruncateSync(fd, 0);
    fs.writeSync(fd, wt2Git, 0);
    fs.closeSync(fd);
    assert.ok(gitProtected(wt, undefined, env, [wt], c2).includes(path.join(wt, "other-hooks")), "a .git file pointed elsewhere is seen");
    // 3. A hooks folder outside that is also on PATH (a helper looked for there): a hook added is seen.
    const hp = path.join(outside, "hp");
    fs.mkdirSync(hp);
    const r3 = path.join(base, "r3");
    git("init", "-q", r3);
    git("-C", r3, "config", "core.hooksPath", hp);
    git("-C", r3, "config", "credential.helper", "mine");
    const env3 = { ...env, PATH: `${hp}${path.delimiter}${process.env.PATH}` };
    const c3: GitCache = new Map();
    await wait();
    gitProtected(r3, undefined, env3, [r3], c3);
    assert.equal(c3.size, 1);
    fs.writeFileSync(path.join(r3, "evil"), "#!/bin/sh\n");
    fs.symlinkSync(path.join(r3, "evil"), path.join(hp, "pre-commit"));
    assert.ok(gitProtected(r3, undefined, env3, [r3], c3).includes(path.join(r3, "evil")), "a hook added in a hooks folder on PATH is seen");
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("kept git answers do not miss a folder becoming a repository, a hook added through a linked hooks folder, or a program link moved into the project (Codex round 18)", async () => {
  const base = realish(fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-gitcache2-")));
  const proj = path.join(base, "proj");
  const outside = path.join(base, "outside");
  fs.mkdirSync(proj);
  fs.mkdirSync(outside);
  const git = (...a: string[]) => assert.equal(spawnSync("git", a, { encoding: "utf8" }).status, 0, a.join(" "));
  const env = { ...process.env, GIT_CONFIG_GLOBAL: path.join(outside, "global"), GIT_CONFIG_NOSYSTEM: "1" };
  const wait = () => new Promise((r) => setTimeout(r, 1100));
  try {
    // 1. Not a repository, then a bare one where it stands: asked every time.
    const cache: GitCache = new Map();
    await wait();
    gitProtected(proj, undefined, env, [proj], cache);
    assert.equal(cache.size, 0, "a folder that is no repository is not kept");
    // 2. A hooks folder that is a link to a folder outside: a hook added there (a link into the project) is seen.
    git("init", "-q", proj);
    const hooksReal = path.join(outside, "hooks-real");
    fs.mkdirSync(hooksReal);
    fs.rmSync(path.join(proj, ".git", "hooks"), { recursive: true, force: true });
    fs.symlinkSync(hooksReal, path.join(proj, ".git", "hooks"));
    // 3. A program named by a path outside, itself a link to a file outside.
    fs.writeFileSync(path.join(outside, "pager-real"), "#!/bin/sh\n");
    fs.symlinkSync(path.join(outside, "pager-real"), path.join(outside, "pager"));
    git("-C", proj, "config", "core.pager", path.join(outside, "pager"));
    await wait();
    const first = gitProtected(proj, undefined, env, [proj], cache);
    assert.equal(cache.size, 1, "the repository is kept");
    assert.ok(!first.includes(path.join(proj, "evil-pager")));
    await wait();
    fs.writeFileSync(path.join(proj, "evil-hook"), "#!/bin/sh\n");
    fs.symlinkSync(path.join(proj, "evil-hook"), path.join(hooksReal, "pre-commit"));
    assert.ok(gitProtected(proj, undefined, env, [proj], cache).includes(path.join(proj, "evil-hook")), "a hook added through the linked folder is seen");
    await wait();
    gitProtected(proj, undefined, env, [proj], cache);
    fs.writeFileSync(path.join(proj, "evil-pager"), "#!/bin/sh\n");
    fs.rmSync(path.join(outside, "pager"));
    fs.symlinkSync(path.join(proj, "evil-pager"), path.join(outside, "pager"));
    assert.ok(gitProtected(proj, undefined, env, [proj], cache).includes(path.join(proj, "evil-pager")), "a program link moved into the project is seen");
    // 4. A program path whose leaf is missing, and whose folder is then made a link into the project.
    await wait();
    git("-C", proj, "config", "diff.external", path.join(outside, "tools", "differ"));
    fs.mkdirSync(path.join(outside, "tools"));
    await wait();
    gitProtected(proj, undefined, env, [proj], cache);
    fs.rmSync(path.join(outside, "tools"), { recursive: true });
    fs.mkdirSync(path.join(proj, "planted"));
    fs.symlinkSync(path.join(proj, "planted"), path.join(outside, "tools"));
    assert.ok(gitProtected(proj, undefined, env, [proj], cache).includes(path.join(proj, "planted", "differ")), "a folder made a link into the project is seen");
    // 4b. A program path that goes into a folder and back out with `..`: that folder made a link later.
    await wait();
    fs.mkdirSync(path.join(outside, "via"));
    fs.mkdirSync(path.join(outside, "bin2"));
    git("-C", proj, "config", "gpg.program", `${path.join(outside, "via")}${path.sep}..${path.sep}bin2${path.sep}signer`);
    await wait();
    gitProtected(proj, undefined, env, [proj], cache);
    fs.rmSync(path.join(outside, "via"), { recursive: true });
    fs.mkdirSync(path.join(proj, "x", "bin2"), { recursive: true });
    fs.symlinkSync(path.join(proj, "x", "y"), path.join(outside, "via"));
    fs.mkdirSync(path.join(proj, "x", "y"));
    assert.ok(gitProtected(proj, undefined, env, [proj], cache).some((p) => p.startsWith(path.join(proj, "x", "bin2", "signer")) || p.includes(`via${path.sep}..${path.sep}bin2${path.sep}signer`)), "a folder walked through before .. is seen");
    // 5. Started below the top: a nearer repository made between them is seen.
    const deep = path.join(proj, "a", "b");
    fs.mkdirSync(deep, { recursive: true });
    const c2: GitCache = new Map();
    await wait();
    gitProtected(deep, undefined, env, [deep], c2);
    assert.equal(c2.size, 1);
    git("init", "-q", path.join(proj, "a"));
    git("-C", path.join(proj, "a"), "config", "core.hooksPath", "b/nearer-hooks");
    assert.ok(gitProtected(deep, undefined, env, [deep], c2).includes(path.join(proj, "a", "b", "nearer-hooks")), "a nearer repository is seen");
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("a deep node_modules or build folder does not refuse the sandbox; repositories anywhere in it are found, and a folder past 64 levels still refuses", () => {
  const proj = tmpProject();
  try {
    fs.mkdirSync(path.join(proj, "node_modules", ...Array.from({ length: 14 }, (_, i) => `d${i}`)), { recursive: true });
    assert.equal(spawnSync("git", ["init", "-q", path.join(proj, "node_modules/plain")]).status, 0);
    assert.equal(spawnSync("git", ["init", "-q", path.join(proj, "node_modules/@scope/pkg")]).status, 0);
    // A whole folder of projects, each with its own node_modules (a person's folder of repos — the report).
    fs.mkdirSync(path.join(proj, "app/node_modules", ...Array.from({ length: 14 }, (_, i) => `e${i}`)), { recursive: true });
    const got = gitProtected(proj);
    assert.ok(got.includes(realish(path.join(proj, "node_modules/plain/.git/hooks"))), got.join(", "));
    assert.ok(got.includes(realish(path.join(proj, "node_modules/@scope/pkg/.git/hooks"))), got.join(", "));
    // A .git folder git does not read as a repository (a folder of bare ones) is passed over, its paths still kept from writes.
    assert.equal(spawnSync("git", ["init", "-q", "--bare", path.join(proj, "data/.git/old.git")]).status, 0);
    const inert = gitProtected(proj);
    assert.ok(inert.includes(path.join(proj, "data/.git/hooks")), inert.join(", "));
    // The bare repository inside it is asked about: its own hooks are kept from writes (Codex).
    assert.ok(inert.some((x) => x.endsWith(path.join("data", ".git", "old.git", "hooks"))), inert.join(", "));
    // A package's own node_modules is searched too.
    assert.equal(spawnSync("git", ["init", "-q", path.join(proj, "node_modules/plain/node_modules/deep")]).status, 0);
    assert.ok(gitProtected(proj).includes(realish(path.join(proj, "node_modules/plain/node_modules/deep/.git/hooks"))));
    // pnpm's store is searched too (Codex round 15).
    assert.equal(spawnSync("git", ["init", "-q", path.join(proj, "node_modules/.pnpm/pkg@1.0.0/node_modules/pkg")]).status, 0);
    assert.ok(gitProtected(proj).includes(realish(path.join(proj, "node_modules/.pnpm/pkg@1.0.0/node_modules/pkg/.git/hooks"))));
    // Anywhere in node_modules, not only at a package's root (Codex round 16).
    assert.equal(spawnSync("git", ["init", "-q", path.join(proj, "node_modules/library/vendor/dep")]).status, 0);
    assert.ok(gitProtected(proj).includes(realish(path.join(proj, "node_modules/library/vendor/dep/.git/hooks"))));
    // A cache folder is not a package folder: a checkout deep in it is still found.
    assert.equal(spawnSync("git", ["init", "-q", path.join(proj, ".cache/checkouts/pkg")]).status, 0);
    assert.ok(gitProtected(proj).includes(realish(path.join(proj, ".cache/checkouts/pkg/.git/hooks"))));
    // A build folder deeper than the old cap of 10 (Next's .next is 12) does not refuse; one past 64 still does.
    fs.mkdirSync(path.join(proj, ".next", ...Array.from({ length: 14 }, (_, i) => `n${i}`)), { recursive: true });
    gitProtected(proj);
    fs.mkdirSync(path.join(proj, "src", ...Array.from({ length: 70 }, (_, i) => `s${i}`)), { recursive: true });
    assert.throws(() => gitProtected(proj), /deeper than/);
  } finally {
    fs.rmSync(proj, { recursive: true, force: true });
  }
});

test("a nested repository's hooks are found, and a project inside a credential folder is refused", async () => {
  const proj = tmpProject();
  try {
    assert.equal(spawnSync("git", ["init", "-q", path.join(proj, "vendor/lib")]).status, 0);
    const got = gitProtected(proj);
    assert.ok(got.includes(realish(path.join(proj, "vendor/lib/.git/hooks"))), got.join(", "));
    const inside = await openLocalSandbox({ cwd: proj, sites: [], denyRead: [path.dirname(proj)] });
    assert.ok(isRefusal(inside) && /holds credentials/.test(inside.refused));
  } finally {
    fs.rmSync(proj, { recursive: true, force: true });
  }
});

test("a project folder that holds the home folder is refused", async () => {
  const r = await openLocalSandbox({ cwd: os.homedir(), sites: [] });
  assert.ok(isRefusal(r) && /home folder/.test(r.refused));
});

test("inside the walls the loop needs shellEnv said outright, and a walls object with every part", () => {
  const walls = { launch: async (c: string) => ({ line: c, env: {} }), canRead: () => true, canWrite: () => true };
  assert.throws(() => readOptions({ model: "m", tools: ["Bash"], localSandbox: walls }, "foldrun"), /shellEnv/);
  assert.throws(() => readOptions({ model: "m", tools: ["Bash"], localSandbox: { launch: walls.launch }, shellEnv: {} }, "foldrun"), /needs launch/);
  assert.ok(readOptions({ model: "m", tools: ["Bash"], localSandbox: walls, shellEnv: {} }, "foldrun").localSandbox);
});

test("inside the walls an MCP server over HTTP needs the walls' proxy, and a stdio one only wrapped", async () => {
  const walls = { launch: async () => ({ line: "", env: {} }) };
  // A sandbox with no way to check a long-lived server is refused for one.
  const noFresh = { launch: async () => ({ line: "x", env: {}, token: "t" }) };
  await assert.rejects(connectMcp({ loc: { type: "stdio", command: "node", args: ["x.js"] } }, { env: {}, toolEnv: {}, cwd: os.tmpdir(), signal: new AbortController().signal, sandbox: noFresh }), /cannot tell a long-lived server/);
  const signal = new AbortController().signal;
  await assert.rejects(connectMcp({ far: { type: "http", url: "https://ok.example.com/mcp" } }, { env: {}, toolEnv: {}, cwd: os.tmpdir(), signal, sandbox: walls }), /needs the sandbox's site proxy/);
  await assert.rejects(connectMcp({ loc: { type: "stdio", command: "node", args: ["x.js"] } }, { env: {}, toolEnv: {}, cwd: os.tmpdir(), signal, sandbox: walls }), /gave no command line/);
});

test("a closed sandbox handle wraps nothing and allows nothing", async (t) => {
  if (process.platform !== "darwin" && process.platform !== "linux") return t.skip("no local sandbox on this OS");
  const proj = tmpProject();
  const box = await openLocalSandbox({ cwd: proj, sites: [] });
  if (isRefusal(box)) {
    fs.rmSync(proj, { recursive: true, force: true });
    if (process.env.FOLDRUN_REQUIRE_SANDBOX === "1") assert.fail(`the sandbox must start here: ${box.refused}`);
    return t.skip(`the sandbox cannot start here: ${box.refused}`);
  }
  try {
    // The same policy gets a handle of its own on the same walls.
    const again = await openLocalSandbox({ cwd: proj, sites: [] });
    assert.ok(!isRefusal(again));
    assert.notEqual(again, box);
    const other = await openLocalSandbox({ cwd: proj, sites: ["x.example.com"] });
    assert.ok(isRefusal(other), "another policy is refused while this one is in use");
    await again.close();
    assert.equal(again.canWrite(path.join(proj, "a")), false, "a handle given back allows nothing");
    await assert.rejects(again.launch("true", {}), /closed/);
    await again.close(); // and closing it again takes nothing from the other
    assert.equal(box.canWrite(path.join(proj, "a")), true, "the other handle still holds");
    await box.close();
    await box.close(); // twice is nothing
    assert.equal(box.canWrite(path.join(proj, "a")), false);
    assert.equal(box.canRead(path.join(proj, "a")), false);
    await assert.rejects(box.launch("true", {}), /closed/);
  } finally {
    await box.close();
    fs.rmSync(proj, { recursive: true, force: true });
  }
});

test("a command's environment rides past the launcher by name only, and is set again inside", async () => {
  const { inner, outer } = carry({ PATH: "/p/bin", LD_PRELOAD: "/proj/evil.so", SECRET: "s3cr3t", "BASH_FUNC_x%%": "() { :; }", UID: "0", NOPE: undefined });
  assert.deepEqual(Object.keys(outer).sort(), ["FOLDRUN_IN_LD_PRELOAD", "FOLDRUN_IN_PATH", "FOLDRUN_IN_SECRET"]);
  assert.ok(!inner.includes("s3cr3t") && !inner.includes("/proj/evil.so"), "no value on the line");
  // Run the prelude in a plain shell: what it sets, and that the carriers are gone.
  const r = spawnSync("/bin/bash", ["-c", `${inner}\necho "$PATH|$SECRET|$LD_PRELOAD|\${FOLDRUN_IN_SECRET-gone}"`], { env: { ...outer, LD_PRELOAD: "kept" }, encoding: "utf8" });
  assert.equal(r.stdout.trim(), "/p/bin|s3cr3t|kept|gone");
});

test("a repository with no git to ask about it is refused, not left unprotected", () => {
  const proj = tmpProject();
  try {
    assert.equal(spawnSync("git", ["init", "-q", proj]).status, 0);
    assert.throws(() => gitProtected(proj, "/nonexistent-bin"), /no git was found/);
  } finally {
    fs.rmSync(proj, { recursive: true, force: true });
  }
});

test("git's worktree config and included files are protected too", () => {
  const proj = tmpProject();
  try {
    assert.equal(spawnSync("git", ["init", "-q", proj]).status, 0);
    fs.writeFileSync(path.join(proj, "extra.gitconfig"), "[core]\n\tpager = less\n");
    assert.equal(spawnSync("git", ["-C", proj, "config", "include.path", "../extra.gitconfig"]).status, 0);
    const got = gitProtected(proj);
    assert.ok(got.includes(realish(path.join(proj, ".git/config.worktree"))), got.join(", "));
    assert.ok(got.includes(realish(path.join(proj, "extra.gitconfig"))), got.join(", "));
  } finally {
    fs.rmSync(proj, { recursive: true, force: true });
  }
});

test("inside the walls Write lands through the sandbox, and is stopped by it outside the project", async (t) => {
  if (process.platform !== "darwin" && process.platform !== "linux") return t.skip("no local sandbox on this OS");
  const proj = tmpProject();
  const box = await openLocalSandbox({ cwd: proj, sites: [] });
  if (isRefusal(box)) {
    fs.rmSync(proj, { recursive: true, force: true });
    if (process.env.FOLDRUN_REQUIRE_SANDBOX === "1") assert.fail(`the sandbox must start here: ${box.refused}`);
    return t.skip(`the sandbox cannot start here: ${box.refused}`);
  }
  const outside = fs.mkdtempSync(path.join(os.homedir(), ".foldrun-wt-"));
  try {
    const ctx = ctxFor(proj, box, { ...process.env, TMPDIR: box.tmp });
    const ok = await ENGINE_TOOLS.Write!.run({ file_path: path.join(proj, "deep/er/new.txt"), content: "it's here\n" }, ctx);
    assert.ok(!ok.isError, ok.text);
    assert.equal(fs.readFileSync(path.join(proj, "deep/er/new.txt"), "utf8"), "it's here\n");
    // A folder in the project that is a link out: the walls hold the write.
    fs.symlinkSync(outside, path.join(proj, "out"));
    const no = await ENGINE_TOOLS.Write!.run({ file_path: path.join(proj, "out/x.txt"), content: "x" }, ctx);
    assert.ok(no.isError);
    assert.equal(fs.existsSync(path.join(outside, "x.txt")), false);
  } finally {
    await box.close();
    fs.rmSync(outside, { recursive: true, force: true });
    fs.rmSync(proj, { recursive: true, force: true });
  }
});

test("a program is trusted only when every link on the way to it is outside the writable folders", () => {
  const proj = tmpProject();
  const bin = tmpProject();
  try {
    fs.writeFileSync(path.join(proj, "rg"), "#!/bin/sh\n", { mode: 0o755 });
    fs.symlinkSync(path.join(proj, "rg"), path.join(bin, "rg"));
    assert.equal(chainOutside(path.join(bin, "rg"), [proj]), false, "the link leads into the project");
    fs.writeFileSync(path.join(bin, "ok"), "#!/bin/sh\n", { mode: 0o755 });
    fs.symlinkSync(path.join(bin, "ok"), path.join(proj, "hop"));
    fs.symlinkSync(path.join(proj, "hop"), path.join(bin, "via"));
    assert.equal(chainOutside(path.join(bin, "via"), [proj]), false, "a hop inside the project could be re-pointed");
    assert.equal(chainOutside(path.join(bin, "ok"), [proj]), true);
  } finally {
    fs.rmSync(proj, { recursive: true, force: true });
    fs.rmSync(bin, { recursive: true, force: true });
  }
});

test("a denied name that is a link today stays denied by its own name", () => {
  const proj = tmpProject();
  const elsewhere = tmpProject();
  try {
    const cred = path.join(proj, "cred");
    fs.symlinkSync(elsewhere, cred);
    const r = fileRules({ cwd: proj, sites: [], denyRead: [cred] }, os.tmpdir());
    assert.equal(r.canRead(path.join(elsewhere, "x")), false, "where it leads");
    fs.unlinkSync(cred);
    fs.mkdirSync(cred);
    assert.equal(r.canRead(path.join(cred, "x")), false, "the name, once it is a real folder");
  } finally {
    fs.rmSync(proj, { recursive: true, force: true });
    fs.rmSync(elsewhere, { recursive: true, force: true });
  }
});

test("inside the walls Grep and Read run there: a link to a credential shows nothing", async (t) => {
  if (process.platform !== "darwin" && process.platform !== "linux") return t.skip("no local sandbox on this OS");
  const proj = tmpProject();
  const secretDir = fs.mkdtempSync(path.join(os.homedir(), ".foldrun-cred-"));
  fs.writeFileSync(path.join(secretDir, "token"), "needle-secret\n");
  fs.writeFileSync(path.join(proj, "a.txt"), "needle-open\n");
  const box = await openLocalSandbox({ cwd: proj, sites: [], denyRead: [secretDir] });
  if (isRefusal(box)) {
    fs.rmSync(proj, { recursive: true, force: true });
    fs.rmSync(secretDir, { recursive: true, force: true });
    if (process.env.FOLDRUN_REQUIRE_SANDBOX === "1") assert.fail(`the sandbox must start here: ${box.refused}`);
    return t.skip(`the sandbox cannot start here: ${box.refused}`);
  }
  try {
    const ctx = ctxFor(proj, box, { ...process.env, TMPDIR: box.tmp });
    fs.symlinkSync(path.join(secretDir, "token"), path.join(proj, "b.txt"));
    const g = await ENGINE_TOOLS.Grep!.run({ pattern: "needle", output_mode: "content" }, ctx);
    assert.ok(!g.isError, g.text);
    assert.match(g.text, /needle-open/);
    assert.doesNotMatch(g.text, /needle-secret/);
    const r = await ENGINE_TOOLS.Read!.run({ file_path: path.join(proj, "a.txt") }, ctx);
    assert.match(r.text, /needle-open/);
    const no = await ENGINE_TOOLS.Read!.run({ file_path: path.join(proj, "b.txt") }, ctx);
    assert.ok(no.isError);
    assert.doesNotMatch(no.text, /needle-secret/);
  } finally {
    await box.close();
    fs.rmSync(secretDir, { recursive: true, force: true });
    fs.rmSync(proj, { recursive: true, force: true });
  }
});

test("the helpers this process runs by name are links to real files outside the project, or the open is refused", () => {
  const proj = tmpProject();
  const bin = tmpProject();
  try {
    fs.writeFileSync(path.join(proj, "rg"), "#!/bin/sh\n", { mode: 0o755 });
    fs.symlinkSync(path.join(proj, "rg"), path.join(bin, "rg"));
    const bad = helperFolder([bin, "/usr/bin", "/bin"].join(path.delimiter), [proj]);
    assert.ok("refused" in bad && /could change/.test(bad.refused), JSON.stringify(bad));
    const ok = helperFolder(["/usr/bin", "/bin"].join(path.delimiter), [proj]);
    assert.ok("dir" in ok);
    try {
      const env = fs.readlinkSync(path.join(ok.dir, "env"));
      assert.equal(env, fs.realpathSync.native("/usr/bin/env"));
    } finally {
      fs.rmSync(ok.dir, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(proj, { recursive: true, force: true });
    fs.rmSync(bin, { recursive: true, force: true });
  }
});

test("while the walls are up this process's PATH is the helper folder, and after they come down it is the person's again", async (t) => {
  if (process.platform !== "darwin" && process.platform !== "linux") return t.skip("no local sandbox on this OS");
  const before = process.env.PATH;
  const proj = tmpProject();
  const box = await openLocalSandbox({ cwd: proj, sites: [] });
  if (isRefusal(box)) {
    fs.rmSync(proj, { recursive: true, force: true });
    assert.equal(process.env.PATH, before, "a refusal leaves PATH as it was");
    if (process.env.FOLDRUN_REQUIRE_SANDBOX === "1") assert.fail(`the sandbox must start here: ${box.refused}`);
    return t.skip(`the sandbox cannot start here: ${box.refused}`);
  }
  try {
    assert.notEqual(process.env.PATH, before);
    assert.ok(!process.env.PATH!.includes(path.delimiter), "one folder");
    assert.ok(fs.existsSync(path.join(process.env.PATH!, "env")));
  } finally {
    await box.close();
    fs.rmSync(proj, { recursive: true, force: true });
  }
  assert.equal(process.env.PATH, before);
});

test("a nested bare repository is protected, and a relative hooks path from both the work tree and the git folder", () => {
  const proj = tmpProject();
  try {
    assert.equal(spawnSync("git", ["init", "-q", proj]).status, 0);
    assert.equal(spawnSync("git", ["-C", proj, "config", "core.hooksPath", "hk"]).status, 0);
    assert.equal(spawnSync("git", ["init", "-q", "--bare", path.join(proj, "srv/repo.git")]).status, 0);
    const got = gitProtected(proj);
    for (const p of ["hk", ".git/hk", "srv/repo.git/hooks", "srv/repo.git/config"]) assert.ok(got.includes(realish(path.join(proj, p))), `${p} in ${got.join(", ")}`);
  } finally {
    fs.rmSync(proj, { recursive: true, force: true });
  }
});

test("inside the walls a credential folder within the project is not writable by a command", async (t) => {
  if (process.platform !== "darwin" && process.platform !== "linux") return t.skip("no local sandbox on this OS");
  const proj = tmpProject();
  const cred = path.join(proj, "creds");
  fs.mkdirSync(cred);
  fs.writeFileSync(path.join(cred, "key"), "orig");
  const box = await openLocalSandbox({ cwd: proj, sites: [], denyRead: [cred] });
  if (isRefusal(box)) {
    fs.rmSync(proj, { recursive: true, force: true });
    if (process.env.FOLDRUN_REQUIRE_SANDBOX === "1") assert.fail(`the sandbox must start here: ${box.refused}`);
    return t.skip(`the sandbox cannot start here: ${box.refused}`);
  }
  try {
    const ctx = ctxFor(proj, box, { ...process.env, TMPDIR: box.tmp });
    await ENGINE_TOOLS.Bash!.run({ command: `printf x > ${JSON.stringify(path.join(cred, "key"))}; true`, timeout: 30_000 }, ctx);
    assert.equal(fs.readFileSync(path.join(cred, "key"), "utf8"), "orig");
  } finally {
    await box.close();
    fs.rmSync(proj, { recursive: true, force: true });
  }
});

test("git: commondir, inactive conditional hooks, and project programs named in config are protected; a GIT_DIR in the shell is refused", () => {
  const proj = tmpProject();
  try {
    assert.equal(spawnSync("git", ["init", "-q", proj]).status, 0);
    fs.writeFileSync(path.join(proj, "branch.gitconfig"), "[core]\n\thooksPath = other-hooks\n");
    assert.equal(spawnSync("git", ["-C", proj, "config", "includeIf.onbranch:release.path", "../branch.gitconfig"]).status, 0);
    assert.equal(spawnSync("git", ["-C", proj, "config", "core.fsmonitor", "./tools/monitor.sh"]).status, 0);
    assert.equal(spawnSync("git", ["-C", proj, "config", "alias.go", "!sh ./scripts/go.sh"]).status, 0);
    const got = gitProtected(proj);
    for (const p of [".git/commondir", "other-hooks", "tools/monitor.sh", "scripts/go.sh", "branch.gitconfig"]) assert.ok(got.includes(realish(path.join(proj, p))), `${p} in ${got.join(", ")}`);
    assert.throws(() => gitProtected(proj, undefined, { ...process.env, GIT_DIR: "/elsewhere/.git" }), /GIT_DIR is set/);
  } finally {
    fs.rmSync(proj, { recursive: true, force: true });
  }
});

test("git: a bare-word alias script, an empty global file in the project, and settings from the environment are protected", () => {
  const proj = tmpProject();
  try {
    assert.equal(spawnSync("git", ["init", "-q", proj]).status, 0);
    assert.equal(spawnSync("git", ["-C", proj, "config", "alias.check", "!sh check.sh"]).status, 0);
    assert.equal(spawnSync("git", ["-C", proj, "config", "alias.sp", `!sh "my script.sh"`]).status, 0);
    const env = { ...process.env, GIT_CONFIG_GLOBAL: path.join(proj, "empty.gitconfig"), GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.fsmonitor", GIT_CONFIG_VALUE_0: "tools/fsm.sh" };
    const got = gitProtected(proj, undefined, env);
    for (const p of ["check.sh", "empty.gitconfig", "tools/fsm.sh"]) assert.ok(got.includes(realish(path.join(proj, p))), `${p} in ${got.join(", ")}`);
    assert.ok(got.includes(realish(path.join(proj, "my script.sh"))), "a quoted name with a space, whole");
    assert.throws(() => gitProtected(proj, undefined, { ...process.env, GIT_CONFIG_PARAMETERS: "'core.pager'='x'" }), /GIT_CONFIG_PARAMETERS is set/);
  } finally {
    fs.rmSync(proj, { recursive: true, force: true });
  }
});

test("git: a project that is no repository still protects a global config inside it; escaped names, links out and patterns", () => {
  const proj = tmpProject();
  const outside = tmpProject();
  try {
    assert.deepEqual(shellWords(`sh my\\ script.sh "a b" 'c d' x|y scripts/check=v2.sh scripts/c!v.sh`), ["sh", "my script.sh", "a b", "c d", "x", "y", "scripts/check=v2.sh", "scripts/c!v.sh"]);
    const g = path.join(proj, "g.gitconfig");
    fs.writeFileSync(g, "[alias]\n\tone = !sh my\\\\ script.sh\n\ttwo = !./linked.sh\n");
    fs.writeFileSync(path.join(outside, "real.sh"), "#!/bin/sh\n");
    fs.symlinkSync(path.join(outside, "real.sh"), path.join(proj, "linked.sh"));
    const got = gitProtected(proj, undefined, { ...process.env, GIT_CONFIG_GLOBAL: g });
    for (const p of ["g.gitconfig", "my script.sh"]) assert.ok(got.includes(realish(path.join(proj, p))), `${p} in ${got.join(", ")}`);
    assert.ok(got.includes(path.join(realish(proj), "linked.sh")), `the link itself in ${got.join(", ")}`);
    fs.writeFileSync(g, "[alias]\n\tall = !sh scripts/*.sh\n");
    assert.throws(() => gitProtected(proj, undefined, { ...process.env, GIT_CONFIG_GLOBAL: g }), /by a pattern/);
  } finally {
    fs.rmSync(proj, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test("git: a hook that links to a project script, a single-quoted $ name, and a project global config with no git", () => {
  assert.deepEqual(shellWords(`sh '$HOME/x.sh' "$HOME/y.sh" $HOME/z.sh`, { HOME: "/h" }), ["sh", "$HOME/x.sh", "/h/y.sh", "/h/z.sh"]);
  const proj = tmpProject();
  try {
    assert.equal(spawnSync("git", ["init", "-q", proj]).status, 0);
    fs.mkdirSync(path.join(proj, "scripts"));
    fs.writeFileSync(path.join(proj, "scripts/pre.sh"), "#!/bin/sh\n", { mode: 0o755 });
    fs.symlinkSync("../../scripts/pre.sh", path.join(proj, ".git/hooks/pre-commit"));
    assert.equal(spawnSync("git", ["-C", proj, "config", "alias.q", "!sh '$dollar.sh'"]).status, 0);
    const got = gitProtected(proj);
    assert.ok(got.includes(realish(path.join(proj, "scripts/pre.sh"))), `hook target in ${got.join(", ")}`);
    assert.ok(got.includes(realish(path.join(proj, "$dollar.sh"))), `literal $ name in ${got.join(", ")}`);
  } finally {
    fs.rmSync(proj, { recursive: true, force: true });
  }
  const plain = tmpProject();
  try {
    assert.throws(() => gitProtected(plain, "/nonexistent-bin", { ...process.env, GIT_CONFIG_GLOBAL: path.join(plain, "g") }), /no git was found to read git's settings/);
  } finally {
    fs.rmSync(plain, { recursive: true, force: true });
  }
});

test("git: a program in another writable folder (the runtime's own) is protected, and an unlistable hooks folder is refused", (t) => {
  const proj = tmpProject();
  const other = tmpProject();
  try {
    assert.equal(spawnSync("git", ["init", "-q", proj]).status, 0);
    assert.equal(spawnSync("git", ["-C", proj, "config", "core.pager", path.join(other, "pager.sh")]).status, 0);
    const got = gitProtected(proj, undefined, process.env, [proj, other]);
    assert.ok(got.includes(realish(path.join(other, "pager.sh"))), got.join(", "));
    if (process.getuid?.() === 0) return t.skip("root can list any folder");
    fs.chmodSync(path.join(proj, ".git/hooks"), 0o100);
    try {
      assert.throws(() => gitProtected(proj), /could not be listed/);
    } finally {
      fs.chmodSync(path.join(proj, ".git/hooks"), 0o755);
    }
  } finally {
    fs.rmSync(proj, { recursive: true, force: true });
    fs.rmSync(other, { recursive: true, force: true });
  }
});

test("git: a bare program found on a PATH folder in the project, and a hook led through a folder link", () => {
  const proj = tmpProject();
  const outside = tmpProject();
  try {
    assert.equal(spawnSync("git", ["init", "-q", proj]).status, 0);
    fs.mkdirSync(path.join(proj, "bin"));
    assert.equal(spawnSync("git", ["-C", proj, "config", "core.pager", "mypager -R"]).status, 0);
    // A hook through a link to a folder in the project.
    fs.mkdirSync(path.join(outside, "h"));
    fs.writeFileSync(path.join(outside, "h/pre.sh"), "#!/bin/sh\n");
    fs.symlinkSync(outside, path.join(proj, "via"));
    fs.symlinkSync(path.join(proj, "via/h/pre.sh"), path.join(proj, ".git/hooks/pre-push"));
    const got = gitProtected(proj, undefined, { ...process.env, PATH: [path.join(proj, "bin"), "/usr/bin", "/bin"].join(path.delimiter) });
    assert.ok(got.includes(realish(path.join(proj, "bin/mypager"))), `the name on the project's PATH folder in ${got.join(", ")}`);
    assert.ok(got.includes(path.join(realish(proj), "via")), `the folder link on the way in ${got.join(", ")}`);
    assert.ok(linkHops(path.join(proj, ".git/hooks/pre-push")).includes(path.join(realish(proj), "via")));
  } finally {
    fs.rmSync(proj, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test("git: a config reached through a project link, link/.. taken as the kernel does, git-credential-<name>, and a quoted ~", () => {
  const proj = tmpProject();
  const outside = tmpProject();
  try {
    assert.equal(spawnSync("git", ["init", "-q", proj]).status, 0);
    fs.mkdirSync(path.join(outside, "deep"));
    fs.writeFileSync(path.join(outside, "inc.gitconfig"), "[core]\n\tpager = less\n");
    fs.symlinkSync(outside, path.join(proj, "cfg"));
    assert.equal(spawnSync("git", ["-C", proj, "config", "include.path", path.join(proj, "cfg/inc.gitconfig")]).status, 0);
    // proj/l -> outside/deep, so proj/l/../helper.sh is outside/helper.sh.
    fs.symlinkSync(path.join(outside, "deep"), path.join(proj, "l"));
    assert.equal(spawnSync("git", ["-C", proj, "config", "core.editor", "l/../helper.sh"]).status, 0);
    assert.equal(spawnSync("git", ["-C", proj, "config", "credential.helper", "example"]).status, 0);
    assert.equal(spawnSync("git", ["-C", proj, "config", "alias.t", "!sh '~/check.sh'"]).status, 0);
    fs.mkdirSync(path.join(proj, "bin"));
    const got = gitProtected(proj, undefined, { ...process.env, PATH: [path.join(proj, "bin"), "/usr/bin"].join(path.delimiter) });
    const has = (p: string) => assert.ok(got.includes(p), `${p} in ${got.join(", ")}`);
    has(path.join(realish(proj), "cfg"));
    has(path.join(realish(proj), "l"));
    has(realish(path.join(proj, "bin/git-credential-example")));
    has(realish(path.join(proj, "~/check.sh")));
    // Joined as text: path.join would drop "l/.." before any link is seen.
    assert.ok(linkHops(`${proj}/l/../helper.sh`).includes(path.join(realish(outside), "helper.sh")));
  } finally {
    fs.rmSync(proj, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test("git: an include, a hooks path and a PATH folder written with link/.., GIT_EXEC_PATH, and programs from the environment", () => {
  const proj = tmpProject();
  const outside = tmpProject();
  try {
    assert.equal(spawnSync("git", ["init", "-q", proj]).status, 0);
    // proj/up -> proj/a/b, so proj/up/../x is proj/a/x.
    fs.mkdirSync(path.join(proj, "a/b"), { recursive: true });
    fs.symlinkSync(path.join(proj, "a/b"), path.join(proj, "up"));
    assert.equal(spawnSync("git", ["-C", proj, "config", "includeIf.onbranch:x.path", `${proj}/up/../settings`]).status, 0);
    assert.equal(spawnSync("git", ["-C", proj, "config", "core.hooksPath", `${proj}/up/../hk`]).status, 0);
    fs.mkdirSync(path.join(proj, "a/hk"));
    fs.writeFileSync(path.join(proj, "a/hk.sh"), "#!/bin/sh\n");
    fs.symlinkSync("../hk.sh", path.join(proj, "a/hk/pre-commit"));
    const env = { ...process.env, PATH: `${proj}/up/../tools:/usr/bin`, GIT_EXEC_PATH: path.join(proj, "gx"), GIT_SSH_COMMAND: "ssh -F ./ssh.conf", EDITOR: "./ed.sh" };
    assert.equal(spawnSync("git", ["-C", proj, "config", "credential.helper", "store2"]).status, 0);
    const got = gitProtected(proj, undefined, env);
    const has = (p: string) => assert.ok(got.includes(realish(path.join(proj, p))), `${p} in ${got.join(", ")}`);
    for (const p of ["a/settings", "a/hk", "a/hk.sh", "a/tools/git-credential-store2", "gx/git-credential-store2", "ssh.conf", "ed.sh"]) has(p);
  } finally {
    fs.rmSync(proj, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test("git: a literal program path with a space (GIT_SSH), gpg.ssh.defaultKeyCommand, and ~/link/.. taken as the kernel does", () => {
  const proj = tmpProject();
  const homeLink = path.join(os.homedir(), `.foldrun-hl-${process.pid}`);
  try {
    assert.equal(spawnSync("git", ["init", "-q", proj]).status, 0);
    fs.mkdirSync(path.join(proj, "x/y"), { recursive: true });
    fs.symlinkSync(path.join(proj, "x/y"), homeLink);
    assert.equal(spawnSync("git", ["-C", proj, "config", "gpg.ssh.defaultKeyCommand", "./keys.sh"]).status, 0);
    assert.equal(spawnSync("git", ["-C", proj, "config", "core.editor", `~/${path.basename(homeLink)}/../ed.sh`]).status, 0);
    const got = gitProtected(proj, undefined, { ...process.env, GIT_SSH: path.join(proj, "my ssh") });
    for (const p of ["my ssh", "keys.sh", "x/ed.sh"]) assert.ok(got.includes(realish(path.join(proj, p))), `${p} in ${got.join(", ")}`);
  } finally {
    fs.rmSync(homeLink, { force: true });
    fs.rmSync(proj, { recursive: true, force: true });
  }
});

test("the project folder is found as the kernel finds it (link/..), a missing one is refused; submodule update; ~user and a raw GIT_SSH", async () => {
  const base = tmpProject();
  try {
    fs.mkdirSync(path.join(base, "real/inner"), { recursive: true });
    fs.mkdirSync(path.join(base, "decoy"));
    fs.symlinkSync(path.join(base, "real/inner"), path.join(base, "decoy/l"));
    // decoy/l/.. is real (the link's parent), not decoy.
    assert.equal(realish(`${base}/decoy/l/..`), realish(path.join(base, "real")));
    const r = await openLocalSandbox({ cwd: path.join(base, "nope"), sites: [] });
    assert.ok(isRefusal(r) && /not a folder that exists/.test(r.refused));
    const proj = path.join(base, "real");
    assert.equal(spawnSync("git", ["init", "-q", proj]).status, 0);
    assert.equal(spawnSync("git", ["-C", proj, "config", "submodule.x.update", "!./up.sh"]).status, 0);
    const got = gitProtected(proj, undefined, { ...process.env, GIT_SSH: path.join(proj, "ssh ") });
    assert.ok(got.includes(realish(path.join(proj, "up.sh"))), got.join(", "));
    assert.ok(got.includes(path.join(realish(proj), "ssh ")), "the value as given, trailing space too");
    assert.equal(spawnSync("git", ["-C", proj, "config", "include.path", "~someone-else/x.gitconfig"]).status, 0);
    // Refused either way: by git, which cannot expand it, or by foldrun.
    assert.throws(() => gitProtected(proj), /another user's home folder|could not expand include path/);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("git: remote helpers by name, and an include written ~<own name>/ as git expands it", () => {
  assert.equal(remoteHelper("remote.o.vcs", "hg"), "hg");
  assert.equal(remoteHelper("remote.o.url", "foo::bar"), "foo");
  assert.equal(remoteHelper("remote.o.url", "s3://bucket/x"), "s3");
  assert.equal(remoteHelper("remote.o.url", "ssh://h/x"), null);
  assert.equal(remoteHelper("url.gcrypt::https://h/.insteadof", "secret:"), "gcrypt");
  const proj = tmpProject();
  try {
    assert.equal(spawnSync("git", ["init", "-q", proj]).status, 0);
    fs.mkdirSync(path.join(proj, "bin"));
    assert.equal(spawnSync("git", ["-C", proj, "config", "remote.o.url", "foo::bar"]).status, 0);
    const got = gitProtected(proj, undefined, { ...process.env, PATH: [path.join(proj, "bin"), "/usr/bin"].join(path.delimiter) });
    assert.ok(got.includes(realish(path.join(proj, "bin/git-remote-foo"))), got.join(", "));
  } finally {
    fs.rmSync(proj, { recursive: true, force: true });
  }
});

test("inside the walls git's protections are found again for each command: a hooks path set mid-session holds from the next one", async (t) => {
  if (process.platform !== "darwin" && process.platform !== "linux") return t.skip("no local sandbox on this OS");
  const proj = tmpProject();
  assert.equal(spawnSync("git", ["init", "-q", proj]).status, 0);
  const box = await openLocalSandbox({ cwd: proj, sites: [] });
  if (isRefusal(box)) {
    fs.rmSync(proj, { recursive: true, force: true });
    if (process.env.FOLDRUN_REQUIRE_SANDBOX === "1") assert.fail(`the sandbox must start here: ${box.refused}`);
    return t.skip(`the sandbox cannot start here: ${box.refused}`);
  }
  try {
    // Set from outside (as an earlier command's git config would have, had
    // it been allowed): the next command cannot write that hooks folder.
    fs.mkdirSync(path.join(proj, "newhooks"));
    assert.equal(spawnSync("git", ["-C", proj, "config", "core.hooksPath", "newhooks"]).status, 0);
    const ctx = ctxFor(proj, box, { ...process.env, TMPDIR: box.tmp });
    await ENGINE_TOOLS.Bash!.run({ command: "printf 'x' > newhooks/pre-commit; true", timeout: 30_000 }, ctx);
    assert.equal(fs.existsSync(path.join(proj, "newhooks/pre-commit")), false);
    assert.equal(box.canWrite(path.join(proj, "newhooks/pre-commit")), false);
  } finally {
    await box.close();
    fs.rmSync(proj, { recursive: true, force: true });
  }
});

test("a launch's token goes stale when git's protections change; helpers keep their case; an env hooks path is expanded by git", async (t) => {
  assert.equal(remoteHelper("remote.o.url", "MyHelper://x"), "MyHelper");
  assert.equal(remoteHelper("url.Fancy::https://h/.insteadOf", "f:"), "Fancy");
  const proj = tmpProject();
  try {
    assert.equal(spawnSync("git", ["init", "-q", proj]).status, 0);
    const prefix = spawnSync("git", ["--exec-path"], { encoding: "utf8" });
    const got = gitProtected(proj, undefined, { ...process.env, GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.hooksPath", GIT_CONFIG_VALUE_0: `${proj}/envhooks` });
    assert.ok(got.includes(realish(path.join(proj, "envhooks"))), got.join(", "));
    assert.ok(prefix.status === 0);
  } finally {
    fs.rmSync(proj, { recursive: true, force: true });
  }
  if (process.platform !== "darwin" && process.platform !== "linux") return t.skip("no local sandbox on this OS");
  const repo = tmpProject();
  assert.equal(spawnSync("git", ["init", "-q", repo]).status, 0);
  const box = await openLocalSandbox({ cwd: repo, sites: [] });
  if (isRefusal(box)) {
    fs.rmSync(repo, { recursive: true, force: true });
    if (process.env.FOLDRUN_REQUIRE_SANDBOX === "1") assert.fail(`the sandbox must start here: ${box.refused}`);
    return t.skip(`the sandbox cannot start here: ${box.refused}`);
  }
  try {
    const { token } = await box.launch("true", {});
    assert.equal(box.fresh(token), true);
    assert.equal(spawnSync("git", ["-C", repo, "config", "core.hooksPath", "later"]).status, 0);
    assert.equal(box.fresh(token), false, "a server started before the change must stop");
  } finally {
    await box.close();
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("a launch that finds the protections changed tells the listeners (so a long-lived server is stopped at once)", async (t) => {
  if (process.platform !== "darwin" && process.platform !== "linux") return t.skip("no local sandbox on this OS");
  const repo = tmpProject();
  assert.equal(spawnSync("git", ["init", "-q", repo]).status, 0);
  const box = await openLocalSandbox({ cwd: repo, sites: [] });
  if (isRefusal(box)) {
    fs.rmSync(repo, { recursive: true, force: true });
    if (process.env.FOLDRUN_REQUIRE_SANDBOX === "1") assert.fail(`the sandbox must start here: ${box.refused}`);
    return t.skip(`the sandbox cannot start here: ${box.refused}`);
  }
  try {
    const { token } = await box.launch("true", {});
    const heard: string[] = [];
    const stop = box.onChange((now) => heard.push(now));
    await box.launch("true", {});
    assert.equal(heard.length, 0, "nothing changed");
    assert.equal(spawnSync("git", ["-C", repo, "config", "core.hooksPath", "later"]).status, 0);
    await box.launch("true", {});
    assert.equal(heard.length, 1);
    assert.notEqual(heard[0], token);
    stop();
  } finally {
    await box.close();
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("killTree ends a process and everything below it", async () => {
  const { spawn } = await import("node:child_process");
  const child = spawn("/bin/sh", ["-c", "sleep 300 & sleep 300 & wait"], { stdio: "ignore" });
  await new Promise((r) => setTimeout(r, 300));
  const below = spawnSync("/bin/ps", ["-A", "-o", "pid=,ppid="], { encoding: "utf8" })
    .stdout.split("\n")
    .map((l) => l.trim().split(/\s+/).map(Number))
    .filter(([, pp]) => pp === child.pid)
    .map(([p]) => p!);
  assert.ok(below.length >= 2, "two sleeps started");
  killTree(child.pid!);
  await new Promise((r) => setTimeout(r, 300));
  for (const p of [child.pid!, ...below]) {
    let alive = true;
    try {
      process.kill(p, 0);
    } catch {
      alive = false;
    }
    assert.equal(alive, false, `${p} still running`);
  }
});
