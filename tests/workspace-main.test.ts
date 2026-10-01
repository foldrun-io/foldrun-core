// A program started through the workspace link is still its own main module.
//
// `node workspace/tools/x/run.mjs` runs a file reached through the step's
// `workspace` link (confine.ts#linkWorkspace). Node gives the module its REAL
// path (import.meta.url) but leaves process.argv[1] as typed — through the
// link — so the usual "am I the entry point" check,
//
//   if (import.meta.url === pathToFileURL(process.argv[1]).href) main();
//
// was false, the program did nothing and exited 0, and a `verify:` that ran it
// passed every time. These tests pin that it now runs, in every way a step
// starts a child: the shell `verify:`, the model's own Bash (opts.env), a
// scripts: tool, and the Test button.
//
//   node --test tests/workspace-main.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { linkWorkspace, workspaceLinkEnv } from "../src/confine.ts";
import { executeStep, checkVerify, type QueryFn } from "../src/step-exec.ts";
import { runScript } from "../src/script-tools.ts";
import { testTool } from "../src/tool-test.ts";
import { workspaceTools } from "../src/store.ts";

/** A checker that FAILS (exit 1) when it runs as main, and says so. */
const CHECKER = `import { pathToFileURL } from "node:url";
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log("checked: bad input");
  process.exit(1);
}
`;

function workspace() {
  const ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ws-main-")));
  const agentDir = path.join(ws, "agents", "a");
  fs.mkdirSync(agentDir, { recursive: true });
  fs.mkdirSync(path.join(ws, "tools", "check"), { recursive: true });
  fs.writeFileSync(path.join(ws, "tools", "check", "run.mjs"), CHECKER);
  return { ws, agentDir };
}

const noModel: QueryFn = () => {
  const stream = (async function* () {
    yield { type: "result", subtype: "success", result: "done", total_cost_usd: 0 };
  })();
  return Object.assign(stream, { async interrupt() {} });
};

test("verify: `node workspace/…` runs the program as main — a failing check fails the step", async () => {
  const { ws, agentDir } = workspace();
  const events: string[] = [];
  const out = await executeStep({
    agentDir, workspaceRoot: ws, libraryRoot: path.join(ws, "..", "lib-none"), prompt: "p", model: "haiku", systemPrompt: "s",
    allowed: [], mcpNames: [], mcpServers: {}, env: {}, emit: (_t: string, text: string) => events.push(text),
    verify: "node workspace/tools/check/run.mjs",
  } as any, noModel);
  assert.equal(out.status, "failed", events.join("\n"));
  assert.ok(events.some((e) => /checked: bad input/.test(e)), events.join("\n"));
});

test("verify: the same check through ../../ fails too — both spellings agree", async () => {
  const { ws, agentDir } = workspace();
  const out = await executeStep({
    agentDir, workspaceRoot: ws, libraryRoot: path.join(ws, "..", "lib-none"), prompt: "p", model: "haiku", systemPrompt: "s",
    allowed: [], mcpNames: [], mcpServers: {}, env: {}, emit: () => {},
    verify: "node ../../tools/check/run.mjs",
  } as any, noModel);
  assert.equal(out.status, "failed");
});

test("checkVerify alone (an eval, a rerun's check) carries the fix too", async () => {
  const { ws, agentDir } = workspace();
  const l = linkWorkspace(agentDir, ws);
  try {
    const v = await checkVerify(agentDir, "node workspace/tools/check/run.mjs", { env: {}, result: "" });
    assert.equal(v.ok, false, v.detail);
  } finally {
    l.release();
  }
});

test("the model's Bash: the env handed to the SDK runs `node workspace/…` as main", async () => {
  const { ws, agentDir } = workspace();
  let code: number | null = -1;
  const query: QueryFn = (args: any) => {
    const r = spawnSync("node", ["workspace/tools/check/run.mjs"], { cwd: agentDir, env: { ...process.env, ...args.options.env } });
    code = r.status;
    return noModel(args);
  };
  await executeStep({
    agentDir, workspaceRoot: ws, libraryRoot: path.join(ws, "..", "lib-none"), prompt: "p", model: "haiku", systemPrompt: "s",
    allowed: [], mcpNames: [], mcpServers: {}, env: { NODE_OPTIONS: "--max-old-space-size=512" }, emit: () => {},
  } as any, query);
  assert.equal(code, 1);
});

test("workspaceLinkEnv keeps what NODE_OPTIONS held and is idempotent", () => {
  const once = workspaceLinkEnv({ NODE_OPTIONS: "--max-old-space-size=512" }, "/x/agents/a");
  assert.match(once.NODE_OPTIONS!, /^--max-old-space-size=512 --import=data:/);
  assert.doesNotMatch(once.NODE_OPTIONS!, / .* .* /, "no spaces inside the preload");
  const twice = workspaceLinkEnv(once, "/x/agents/a");
  assert.equal(twice.NODE_OPTIONS, once.NODE_OPTIONS);
});

test("a scripts: tool that shells out to `node workspace/…` runs it as main", async () => {
  const { ws, agentDir } = workspace();
  fs.writeFileSync(path.join(agentDir, "go.sh"), "#!/bin/bash\nnode workspace/tools/check/run.mjs\n", { mode: 0o755 });
  const l = linkWorkspace(agentDir, ws);
  try {
    const r = await runScript(agentDir, { name: "go", description: "", run: "go.sh", args: {} } as any, {}, {}, "", {}, null);
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /checked: bad input/);
  } finally {
    l.release();
  }
});

test("not over-reaching: a node_modules/.bin link still resolves its own relative requires", () => {
  const { agentDir } = workspace();
  const pkg = path.join(agentDir, "node_modules", "pkg");
  fs.mkdirSync(path.join(pkg, "bin"), { recursive: true });
  fs.mkdirSync(path.join(pkg, "lib"), { recursive: true });
  fs.mkdirSync(path.join(agentDir, "node_modules", ".bin"), { recursive: true });
  fs.writeFileSync(path.join(pkg, "lib", "x.js"), 'module.exports = "lib-ok";\n');
  fs.writeFileSync(path.join(pkg, "bin", "cli.js"), '#!/usr/bin/env node\nconsole.log(require("../lib/x.js"));\n', { mode: 0o755 });
  fs.symlinkSync("../pkg/bin/cli.js", path.join(agentDir, "node_modules", ".bin", "pkg"));
  const env = workspaceLinkEnv({ ...process.env }, agentDir);
  assert.equal(execFileSync("node_modules/.bin/pkg", { cwd: agentDir, env, encoding: "utf8" }).trim(), "lib-ok");
});

test("not over-reaching: a package beside the program still resolves, through the link", () => {
  const { ws, agentDir } = workspace();
  fs.mkdirSync(path.join(ws, "node_modules", "dep"), { recursive: true });
  fs.writeFileSync(path.join(ws, "node_modules", "dep", "package.json"), '{"name":"dep","main":"i.js"}');
  fs.writeFileSync(path.join(ws, "node_modules", "dep", "i.js"), 'module.exports = "dep-ok";\n');
  fs.writeFileSync(
    path.join(ws, "tools", "check", "dep.mjs"),
    'import d from "dep";\nimport { pathToFileURL } from "node:url";\nif (import.meta.url === pathToFileURL(process.argv[1]).href) console.log("main", d);\n',
  );
  const l = linkWorkspace(agentDir, ws);
  try {
    const env = workspaceLinkEnv({ ...process.env }, agentDir);
    assert.equal(execFileSync("node", ["workspace/tools/check/dep.mjs"], { cwd: agentDir, env, encoding: "utf8" }).trim(), "main dep-ok");
  } finally {
    l.release();
  }
});

test("Python: `python3 workspace/…` is __main__ already — no fix needed, pinned", (t) => {
  if (spawnSync("python3", ["--version"]).status !== 0) return t.skip("no python3");
  const { ws, agentDir } = workspace();
  fs.writeFileSync(path.join(ws, "tools", "check", "run.py"), 'import sys\nif __name__ == "__main__":\n    sys.exit(1)\n');
  const l = linkWorkspace(agentDir, ws);
  try {
    assert.equal(spawnSync("python3", ["workspace/tools/check/run.py"], { cwd: agentDir }).status, 1);
  } finally {
    l.release();
  }
});

test("the Test button stands where a run stands: workspace/ is linked, and the program runs as main", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-tooltest-main-"));
  const previous = process.env.FOLDRUN_DATA;
  process.env.FOLDRUN_DATA = root;
  try {
    const files: Record<string, string> = {
      "AGENTS.md": "---\nname: desk\n---\n",
      "agents/keeper/agent.md": "---\nname: keeper\ndescription: d\ntools: [probe]\n---\n\nwork.\n",
      "tools/probe/tool.md": "---\ntransport: script\nname: probe\nrun: probe.sh\ndescription: d\n---\n\nx\n",
      "tools/probe/probe.sh": "#!/bin/bash\nnode workspace/tools/check/run.mjs\n",
      "tools/check/run.mjs": CHECKER,
    };
    for (const [rel, content] of Object.entries(files)) {
      const file = path.join(root, "acme/workspaces/desk", rel);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, content, { mode: 0o755 });
    }
    const def = workspaceTools("acme", "desk").probe;
    const result = await testTool("acme", "desk", def);
    assert.equal(result.ok, false, result.detail);
    assert.match(result.detail, /checked: bad input/);
    assert.equal(fs.existsSync(path.join(root, "acme/workspaces/desk/agents/keeper/workspace")), false, "the link is gone after");
  } finally {
    if (previous === undefined) delete process.env.FOLDRUN_DATA;
    else process.env.FOLDRUN_DATA = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
