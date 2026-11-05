// FOL-130: a run container's root start-up never runs with the step's
// environment. The step's env is the account's secrets under names the
// account chose — LD_PRELOAD, PATH, BASH_ENV, NODE_OPTIONS among them — and
// a value pointing into the agent-writable runtime cache would run the
// agent's code as root at the next step's start. The agent's own shell still
// gets every value, after the drop.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { stepEnvShell, rootEnvShell, ROOT_ENV_NAMES, ROOT_SHELL_GUARD_SH, ROOT_ENV_FILE, STEP_ENV_FILE, INSTALL_SOCKET } from "../src/runtime.ts";
import { rootStartSh, agentStartSh, ENTRY } from "../src/run-container.ts";
import { reservedEnvName, LOADER_ENV } from "../src/env-names.ts";
import { scanFiles } from "../src/scan.ts";

const tmp = (p: string) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p)));
const envOf = (file: string) =>
  Object.fromEntries(
    fs.readFileSync(file, "utf8").split("\0").filter(Boolean).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
  );
/** A program that writes its environment NUL-separated (values may hold
 *  newlines) — node's own, so no PATH lookup is involved. */
const dumpEnv = (to: string) =>
  `${process.execPath} -e 'require("fs").writeFileSync(process.argv[1], Object.entries(process.env).map(([k,v])=>k+"="+v).join("\\0")+"\\0")' ${to}`;

test("stepEnvShell writes what a shell sources back exactly, and rootEnvShell only the proxy", () => {
  const dir = tmp("envsh-");
  const env = { PLAIN: "v", QUOTES: `it's "q" $(id) \`x\` \\n`, LINES: "one\ntwo", HTTPS_PROXY: "http://u:p@egress:3128", no_proxy: "localhost", "BAD-NAME": "x" };
  fs.writeFileSync(path.join(dir, "env.sh"), stepEnvShell(env));
  const r = spawnSync("sh", ["-c", `set -a; . ${dir}/env.sh; set +a; ${dumpEnv(`${dir}/seen`)}`], { env: { PATH: process.env.PATH! }, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const seen = envOf(`${dir}/seen`);
  for (const k of ["PLAIN", "QUOTES", "LINES", "HTTPS_PROXY", "no_proxy"]) assert.equal(seen[k], env[k as keyof typeof env], k);
  assert.equal(seen["BAD-NAME"], undefined);
  assert.deepEqual(
    rootEnvShell({ ...env, LD_PRELOAD: "/x.so", FOLDRUN_INSTALL_SOCKET: "/evil" }).split("\n").map((l) => l.replace(/=.*/, "")),
    ["export HTTPS_PROXY", "export no_proxy"],
  );
  assert.deepEqual([...ROOT_ENV_NAMES].sort(), ["HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy"]);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("the root shell's guard unsets the loader's and the shells' variables and keeps the image's own", () => {
  const dir = tmp("guard-");
  const r = spawnSync("sh", ["-c", `${ROOT_SHELL_GUARD_SH}\n${dumpEnv(`${dir}/seen`)}`], {
    env: {
      PATH: process.env.PATH!, NODE_PATH: "/usr/local/lib/node_modules", FOLDRUN_RUNTIME_SHARED: "/opt/shared",
      LD_PRELOAD: "/c/x.so", LD_LIBRARY_PATH: "/c", LD_AUDIT: "/c/a.so", BASH_ENV: "/c/b", ENV: "/c/e", NODE_OPTIONS: "--require /c/x.js",
      PYTHONPATH: "/c", PYTHONSTARTUP: "/c/s.py", PERL5OPT: "-Mx", GCONV_PATH: "/c", IFS: "x",
    },
    encoding: "utf8",
  });
  assert.equal(r.status, 0, r.stderr);
  const seen = envOf(`${dir}/seen`);
  for (const k of ["LD_PRELOAD", "LD_LIBRARY_PATH", "LD_AUDIT", "BASH_ENV", "ENV", "NODE_OPTIONS", "PYTHONPATH", "PYTHONSTARTUP", "PERL5OPT", "GCONV_PATH"]) {
    assert.equal(seen[k], undefined, `${k} is gone`);
  }
  assert.equal(seen.PATH, process.env.PATH);
  assert.equal(seen.NODE_PATH, "/usr/local/lib/node_modules");
  assert.equal(seen.FOLDRUN_RUNTIME_SHARED, "/opt/shared");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("root's start-up reads root-env.sh's proxy and nothing of the step's env.sh; the socket stays its own", async () => {
  const dir = tmp("rootstart-");
  const job = path.join(dir, "job");
  fs.mkdirSync(job);
  fs.writeFileSync(path.join(job, "input.json"), JSON.stringify({ runtime: null }));
  // The step's own environment, with names chosen to hurt — never read here.
  fs.writeFileSync(path.join(job, "env.sh"), stepEnvShell({ LD_PRELOAD: "/c/x.so", PATH: "/c/bin", MY_SECRET: "s", HTTPS_PROXY: "http://step" }));
  // The worker's cut, plus lines a broken worker might let through: sourced
  // before the reset, so they are unset again.
  fs.writeFileSync(
    path.join(job, "root-env.sh"),
    `${rootEnvShell({ HTTPS_PROXY: "http://foldrun:t@egress:3128", no_proxy: "localhost" })}\nexport LD_PRELOAD='/c/x.so' FOLDRUN_INSTALL_SOCKET='/c/evil.sock' NODE_OPTIONS='--require /c/x.js'`,
  );
  // What root runs last in the subshell is the install helper: stand in for
  // it with a dump of the environment it would start with.
  fs.writeFileSync(path.join(dir, "seen.sh"), `#!/bin/sh\n${dumpEnv(`${dir}/root-seen`)}\n`, { mode: 0o755 });
  const sh = rootStartSh(path.join(dir, "cache"))
    .replaceAll("/opt/runner/job", job)
    .replace("node /opt/runner/node_modules/@foldrun/core/dist/src/install-helper.js", `${dir}/seen.sh`);
  assert.ok(!sh.includes(`${job}/env.sh`), "the step's env.sh is never named in root's start-up");
  const r = spawnSync("sh", ["-c", sh], { env: { PATH: "/usr/bin:/bin" }, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  for (let i = 0; i < 100 && !fs.existsSync(`${dir}/root-seen`); i++) await new Promise((res) => setTimeout(res, 50));
  const seen = envOf(`${dir}/root-seen`);
  assert.equal(seen.HTTPS_PROXY, "http://foldrun:t@egress:3128");
  assert.equal(seen.no_proxy, "localhost");
  assert.equal(seen.FOLDRUN_INSTALL_SOCKET, INSTALL_SOCKET.replace("/opt/runner/job", job), "a sourced line cannot move the socket");
  assert.equal(seen.PATH, "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin");
  assert.equal(seen.LANG, "C.UTF-8");
  assert.equal(seen.LC_ALL, "C.UTF-8");
  for (const k of ["LD_PRELOAD", "NODE_OPTIONS", "MY_SECRET"]) assert.equal(seen[k], undefined, k);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("the agent's shell gets the step's env exactly, the CA's variables, runuser's HOME/USER/LOGNAME and the fixed socket", () => {
  const dir = tmp("agentstart-");
  const job = path.join(dir, "job");
  fs.mkdirSync(job);
  const ca = Buffer.from("-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n").toString("base64");
  const stepEnv = {
    LD_PRELOAD: "/nowhere/x.so", PATH: `${dir}/bin:/usr/bin:/bin`, BASH_ENV: "/nowhere/b", NODE_OPTIONS: "--max-old-space-size=99",
    HOME: "/evil-home", USER: "evil", LOGNAME: "evil", FOLDRUN_INSTALL_SOCKET: "/evil.sock", QUOTED: `a'b"c $1 \`d\``, FOLDRUN_EGRESS_CA: ca,
  };
  fs.writeFileSync(path.join(job, "env.sh"), stepEnvShell(stepEnv));
  fs.writeFileSync(path.join(dir, "driver.sh"), `#!/bin/sh\n${dumpEnv(`${dir}/agent-seen`)}\nexit 7\n`, { mode: 0o755 });
  const drop = agentStartSh(`${dir}/driver.sh`).replaceAll("/opt/runner/job", job);
  assert.match(drop, /^runuser -u agent -- \/bin\/sh -c '/);
  // runuser itself, as root, would set HOME/USER/LOGNAME and keep the rest:
  // stand in for it with exactly that.
  const r = spawnSync("sh", ["-c", drop.replace(/^runuser -u agent -- /, "")], {
    env: { PATH: "/usr/bin:/bin", HOME: "/home/agent", USER: "agent", LOGNAME: "agent", FROM_THE_POD: "kept" },
    encoding: "utf8",
  });
  assert.equal(r.status, 7, `the command's exit status is the step's: ${r.stderr}`);
  const seen = envOf(`${dir}/agent-seen`);
  for (const k of ["LD_PRELOAD", "PATH", "BASH_ENV", "NODE_OPTIONS", "QUOTED"] as const) assert.equal(seen[k], stepEnv[k], `${k} reaches the agent as set`);
  assert.equal(seen.HOME, "/home/agent");
  assert.equal(seen.USER, "agent");
  assert.equal(seen.LOGNAME, "agent");
  assert.equal(seen.FOLDRUN_INSTALL_SOCKET, INSTALL_SOCKET.replace("/opt/runner/job", job));
  assert.equal(seen.FROM_THE_POD, "kept");
  assert.equal(seen.NODE_EXTRA_CA_CERTS, `${job}/egress-ca.pem`);
  assert.match(fs.readFileSync(`${job}/egress-ca.pem`, "utf8"), /BEGIN CERTIFICATE/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("the docker entry: the guard first, root's start-up, then the drop — and no step env before it", () => {
  const drop = ENTRY.indexOf("exec runuser -u agent -- /bin/sh -c '");
  const guard = ENTRY.indexOf("export -p");
  const root = ENTRY.indexOf(ROOT_ENV_FILE);
  assert.ok(guard > 0 && guard < ENTRY.indexOf("chown "), "the guard runs before root's first command");
  assert.ok(root > guard && drop > root);
  const beforeDrop = ENTRY.slice(0, drop);
  assert.ok(!beforeDrop.includes(STEP_ENV_FILE), "root never names the step's env.sh");
  assert.ok(!beforeDrop.includes("FOLDRUN_EGRESS_CA"), "the CA lines run as the agent");
  assert.ok(ENTRY.slice(drop).includes(STEP_ENV_FILE));
});

test("reservedEnvName and secret/reserved-env-name: a secret named after a loader or shell variable is a warning", () => {
  for (const n of ["LD_PRELOAD", "LD_LIBRARY_PATH", "BASH_ENV", "ENV", "IFS", "PATH", "NODE_OPTIONS", "PYTHONPATH", "HOME"]) assert.ok(reservedEnvName(n), n);
  for (const n of ["STRIPE_KEY", "CRM_TOKEN", "ENVIRONMENT", "PATHWAY_KEY", "OLD_PRELOAD"]) assert.equal(reservedEnvName(n), null, n);
  assert.ok(LOADER_ENV.includes("LD_*"));

  const findings = scanFiles([
    { path: "agents/a/agent.md", content: "---\nname: a\nsecrets:\n  - CRM_TOKEN\n  - LD_PRELOAD\n  - ${PATH}\n---\nDo it.\n" },
    { path: "agents/b/agent.md", content: "---\nname: b\nguardrail:\n  secrets: [NODE_OPTIONS]\n---\nDo it.\n" },
    { path: "tools/t/tool.md", content: "---\nname: t\ndescription: x\nrun: run.py\nsecrets: [BASH_ENV]\n---\n" },
    { path: "agents/c/agent.md", content: "---\nname: c\nsecrets: [STRIPE_KEY]\n---\nLD_PRELOAD is mentioned in prose only.\n" },
  ]).filter((f) => f.rule === "secret/reserved-env-name");
  assert.deepEqual(
    findings.map((f) => [f.file, f.line, f.level, /secrets: (\S+)/.exec(f.message)?.[1]]),
    [
      ["agents/a/agent.md", 5, "warn", "LD_PRELOAD"],
      ["agents/a/agent.md", 6, "warn", "PATH"],
      ["agents/b/agent.md", 4, "warn", "NODE_OPTIONS"],
      ["tools/t/tool.md", 5, "warn", "BASH_ENV"],
    ],
  );
});

// The real docker entry, run as root in a throwaway Debian container
// (FOLDRUN_ROOT_START_E2E=1 — it writes /opt/runner, /workspace, /library and
// the agent's cache, so never on a machine that matters). The step's env
// points LD_PRELOAD, PATH, BASH_ENV, ENV and NODE_OPTIONS into the cache the
// agent writes; every trap there records the uid it ran as. A control run
// that sources env.sh as root, the way the shim did before FOL-130, proves
// the traps spring.
const e2e = process.platform === "linux" && process.getuid?.() === 0 && process.env.FOLDRUN_ROOT_START_E2E === "1";
test("e2e: nothing runs as root from a step env pointing into the cache; the agent still gets it", { skip: !e2e && "set FOLDRUN_ROOT_START_E2E=1, as root in a throwaway Debian container" }, async () => {
  const { RUNTIME_CACHE } = await import("../src/run-container.ts");
  const sh = (cmd: string, opts: { env?: NodeJS.ProcessEnv } = {}) => spawnSync("sh", ["-c", cmd], { encoding: "utf8", env: opts.env ?? { PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin", HOME: "/root" } });
  if (sh("id -u agent").status !== 0) assert.equal(sh("useradd -m -u 10001 agent").status, 0);
  const marks = "/tmp/fol130-marks";
  fs.rmSync(marks, { recursive: true, force: true });
  fs.mkdirSync(marks, { mode: 0o777 });
  fs.chmodSync(marks, 0o1777);
  const cache = RUNTIME_CACHE;
  fs.mkdirSync(path.join(cache, "evil", "bin"), { recursive: true });
  const mark = (what: string) => `echo x > ${marks}/$(id -u)-${what}-$$`;
  // A program by every name root's start-up runs, first on the step's PATH.
  for (const name of ["chown", "runuser", "date", "cat", "base64", "touch", "sleep", "env", "mktemp", "rm", "node", "id", "timeout", "tar", "apt-get", "dpkg"]) {
    fs.writeFileSync(
      path.join(cache, "evil", "bin", name),
      `#!/bin/sh\n_o=$PATH; PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin; _r=$(command -v ${name})\n${mark(`path-${name}`)}\nPATH=$_o; exec "$_r" "$@"\n`,
      { mode: 0o755 },
    );
  }
  fs.writeFileSync(path.join(cache, "evil", "shell-env.sh"), `${mark("shell-env")}\n`);
  fs.writeFileSync(path.join(cache, "evil", "require.js"), `require("fs").writeFileSync("${marks}/" + process.getuid() + "-node-options-" + process.pid, "x");\n`);
  const cc = sh("command -v cc").status === 0;
  if (cc) {
    fs.writeFileSync("/tmp/fol130-preload.c", `#include <stdio.h>\n#include <unistd.h>\n__attribute__((constructor)) static void at_load(void) { char p[256]; snprintf(p, sizeof p, "${marks}/%d-preload-%d", (int)getuid(), (int)getpid()); FILE *f = fopen(p, "w"); if (f) fclose(f); }\n`);
    assert.equal(sh(`cc -shared -fPIC -o ${cache}/evil/preload.so /tmp/fol130-preload.c`).status, 0);
  }
  assert.equal(sh(`chown -R agent:agent ${cache}`).status, 0, "the cache is the agent's, as in a real pod");

  for (const d of ["/opt/runner/job", "/workspace", "/library"]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync("/opt/runner/job/input.json", JSON.stringify({ runtime: null }));
  const stepEnv: Record<string, string> = {
    PATH: `${cache}/evil/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`,
    BASH_ENV: `${cache}/evil/shell-env.sh`,
    ENV: `${cache}/evil/shell-env.sh`,
    NODE_OPTIONS: `--require ${cache}/evil/require.js`,
    MY_SECRET: "it's s3cret",
    HTTPS_PROXY: "http://proxy.invalid:3128",
    ...(cc ? { LD_PRELOAD: `${cache}/evil/preload.so` } : {}),
  };
  fs.writeFileSync(STEP_ENV_FILE, stepEnvShell(stepEnv), { mode: 0o600 });
  fs.writeFileSync(ROOT_ENV_FILE, rootEnvShell(stepEnv), { mode: 0o600 });
  fs.writeFileSync("/opt/runner/driver.mjs", `import fs from "node:fs"; fs.writeFileSync("/tmp/fol130-driver.json", JSON.stringify({ uid: process.getuid(), env: process.env }));\n`);
  fs.writeFileSync("/opt/runner/entry.sh", ENTRY, { mode: 0o755 });
  const rootMarks = () => fs.readdirSync(marks).filter((m) => m.startsWith("0-"));

  const run = sh("sh /opt/runner/entry.sh", { env: { PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin", HOME: "/root", NODE_PATH: "/usr/local/lib/node_modules" } });
  assert.equal(run.status, 0, run.stderr);
  await new Promise((res) => setTimeout(res, 500)); // the background install helper, had it been fooled
  assert.deepEqual(rootMarks(), [], "nothing ran as root from the step's environment");
  const driver = JSON.parse(fs.readFileSync("/tmp/fol130-driver.json", "utf8"));
  assert.equal(driver.uid, 10001);
  for (const k of Object.keys(stepEnv)) assert.equal(driver.env[k], stepEnv[k], `the agent's ${k}`);
  assert.equal(driver.env.HOME, "/home/agent");
  assert.equal(driver.env.FOLDRUN_INSTALL_SOCKET, INSTALL_SOCKET);
  assert.ok(fs.readdirSync(marks).some((m) => m.startsWith("10001-node-options-")), "the agent's own node read its NODE_OPTIONS");
  if (cc) assert.ok(fs.readdirSync(marks).some((m) => m.startsWith("10001-preload-")), "and the agent's programs its LD_PRELOAD");

  // Control: root sourcing env.sh and running one command — what the shim did.
  const control = sh(`set -a; . ${STEP_ENV_FILE}; set +a; chown agent:agent ${cache}`);
  assert.equal(control.status, 0, control.stderr);
  const sprung = rootMarks();
  assert.ok(sprung.some((m) => m.startsWith("0-path-chown-")), `the PATH trap springs for root: ${sprung}`);
  if (cc) assert.ok(sprung.some((m) => m.startsWith("0-preload-")), `the LD_PRELOAD trap springs for root: ${sprung}`);
});
