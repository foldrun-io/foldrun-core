// The install tool and its root helper: an agent installs what it finds it
// needs mid-step without anyone having declared it.
//
//   node --test tests/install-tool.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { refuse, serve } from "../src/install-helper.ts";
import { askHelper, buildInstallTool, INSTALL_TOOL } from "../src/install-tool.ts";
import { stepInstallEnv } from "../src/runtime.ts";

const textOf = (out: { content: { text: string }[] }) => out.content.map((c) => c.text).join("\n");

test("the helper takes Debian package names and nothing else", () => {
  assert.equal(refuse({ manager: "apt", packages: ["ffmpeg", "libcairo2-dev", "g++"] }), null);
  assert.match(refuse({ manager: "apt", packages: ["-oDebug::x"] })!, /not Debian package names/);
  assert.match(refuse({ manager: "apt", packages: ["ffmpeg; rm -rf /"] })!, /not Debian package names/);
  assert.match(refuse({ manager: "pip", packages: ["x"] })!, /apt\) only/);
  assert.match(refuse({ manager: "apt", packages: [] })!, /no packages/);
  assert.match(refuse({ manager: "apt", packages: Array.from({ length: 51 }, (_, i) => `p${i}x`) })!, /at most 50/);
  assert.match(refuse("nope")!, /not a request/);
});

test("over the socket: apt through the start-up's own installer, then a snapshot restore", async () => {
  // A short path: a unix socket path must fit in ~100 bytes.
  const dir = fs.realpathSync(fs.mkdtempSync(path.join("/tmp", "fi-")));
  const dpkg = path.join(dir, "dpkg");
  fs.mkdirSync(path.join(dpkg, "info"), { recursive: true });
  fs.writeFileSync(path.join(dpkg, "status"), "Package: base\n");
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin);
  fs.writeFileSync(
    path.join(bin, "apt-get"),
    `#!/bin/sh\necho "$@" >> ${dir}/calls\ncase "$*" in *" install "*) mkdir -p ${dir}/usr && echo x > ${dir}/usr/ffmpeg && echo ${dir}/usr/ffmpeg > ${dpkg}/info/ffmpeg.list ;; esac\n`,
    { mode: 0o755 },
  );
  const saved = { PATH: process.env.PATH, D: process.env.FOLDRUN_DPKG_DIR };
  process.env.PATH = `${bin}:${process.env.PATH}`;
  process.env.FOLDRUN_DPKG_DIR = dpkg;
  process.env.FOLDRUN_SYS_SCAN = dir;
  const sock = path.join(dir, "s");
  const server = serve(sock, path.join(dir, "cache"));
  try {
    await new Promise((r) => setTimeout(r, 100));
    const first = await askHelper(sock, ["ffmpeg"]);
    assert.equal(first.ok, true, first.error);
    assert.equal(first.mode, "apt");
    // the container is gone; a fresh one restores from the snapshot
    fs.rmSync(path.join(dir, "usr"), { recursive: true });
    fs.rmSync(path.join(dpkg, "info", "ffmpeg.list"));
    const second = await askHelper(sock, ["ffmpeg"]);
    assert.equal(second.ok, true, second.error);
    assert.equal(second.mode, "snapshot");
    assert.equal(fs.readFileSync(path.join(dir, "usr", "ffmpeg"), "utf8"), "x\n");
    const refused = await askHelper(sock, ["-oAPT::x"]);
    assert.equal(refused.ok, false);
    assert.match(refused.error!, /not Debian package names/);
  } finally {
    server.close();
    process.env.PATH = saved.PATH;
    if (saved.D === undefined) delete process.env.FOLDRUN_DPKG_DIR;
    else process.env.FOLDRUN_DPKG_DIR = saved.D;
  }
});

test("the tool refuses bad names before running anything, and apt says plainly when there is no container", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "it-"));
  const events: string[] = [];
  const t = buildInstallTool({ dir, socket: null, cacheRoot: dir, python: "python3", env: process.env, emit: (_k, s) => events.push(s) });
  assert.equal(t.toolName, INSTALL_TOOL);
  const bad = await t.call({ manager: "pip", packages: ["--index-url=http://evil", "ok"] });
  assert.equal((bad as { isError?: boolean }).isError, true);
  assert.match(textOf(bad as never), /Not pip package names: --index-url=http:\/\/evil/);
  const apt = await t.call({ manager: "apt", packages: ["ffmpeg"] });
  assert.equal((apt as { isError?: boolean }).isError, true);
  assert.match(textOf(apt as never), /only be installed inside a run container/);
  assert.deepEqual(t.installed(), []);
});

test("an npm install lands in the step's directory, on NODE_PATH and PATH, and is logged with the runtime line", async (t) => {
  if (process.env.FOLDRUN_OFFLINE === "1") return t.skip("offline");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "it-npm-"));
  const events: string[] = [];
  const env = { ...process.env, ...stepInstallEnv(dir, process.env) };
  const tool = buildInstallTool({ dir, socket: null, cacheRoot: dir, python: "python3", env, emit: (_k, s) => events.push(s) });
  // `ms` is tiny and dependency-free.
  const out = await tool.call({ manager: "npm", packages: ["ms@2.1.3"] });
  if ((out as { isError?: boolean }).isError && /ENOTFOUND|EAI_AGAIN|network/i.test(textOf(out as never))) return t.skip("no network");
  assert.ok(!(out as { isError?: boolean }).isError, textOf(out as never));
  assert.ok(fs.existsSync(path.join(dir, "npm", "node_modules", "ms", "package.json")));
  assert.ok(env.NODE_PATH!.split(path.delimiter).includes(path.join(dir, "npm", "node_modules")));
  assert.ok(env.PATH!.split(path.delimiter).includes(path.join(dir, "npm", "node_modules", ".bin")));
  assert.match(events.join("\n"), /install: npm ms@2\.1\.3 — ready \(npm, \d+s\)\. To have it before the step starts: runtime: npm: \[ms@2\.1\.3\]/);
  assert.deepEqual(tool.installed(), ["npm:ms@2.1.3"]);
});

test("stepInstallEnv appends, so a declared environment keeps winning", () => {
  const env = stepInstallEnv("/s", { PATH: "/venv/bin:/usr/bin", PYTHONPATH: "/a", NODE_PATH: "/n" });
  assert.equal(env.PATH, `/venv/bin:/usr/bin:/s/py/bin:/s/npm/node_modules/.bin`);
  assert.equal(env.PYTHONPATH, "/a:/s/py");
  assert.equal(env.NODE_PATH, "/n:/s/npm/node_modules");
});

test("every agent is granted install; disallowedTools: [install] and plan mode take it away", async () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), "it-grant-"));
  process.env.FOLDRUN_DATA = data;
  const { agentContext } = await import("../src/runner.ts");
  const ws = path.join(data, "acme", "workspaces", "desk");
  const mk = (name: string, front: string) => {
    const d = path.join(ws, "agents", name);
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, "agent.md"), `---\nname: ${name}\n${front}---\n\nWork.\n`);
    return d;
  };
  fs.mkdirSync(ws, { recursive: true });
  fs.writeFileSync(path.join(ws, "AGENTS.md"), "---\nname: desk\n---\n");
  const allowedOf = (d: string) => (agentContext(d, "acme", [], {}, null, true) as { allowed: string[] }).allowed;
  assert.ok(allowedOf(mk("plain", "tools: [read]\n")).includes(INSTALL_TOOL), "granted with no mention");
  assert.ok(allowedOf(mk("named", "tools: [read, install]\n")).includes(INSTALL_TOOL), "naming it is harmless");
  assert.ok(!allowedOf(mk("denied", "tools: [read]\ndisallowedTools: [install]\n")).includes(INSTALL_TOOL), "disallowedTools removes it");
  assert.ok(!allowedOf(mk("planner", "tools: [read, Bash]\npermissionMode: plan\n")).includes(INSTALL_TOOL), "plan mode is read-only");
});
