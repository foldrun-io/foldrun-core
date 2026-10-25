// `workspace/…` is the one spelling for the workspace root — in the file
// tools, the shell, scripts, a shell `verify:`, and every path a flow option
// names — and the older `../../…` keeps working beside it.
//
// The file tools had it (confine.ts#expandVirtual); everything that only sees
// the filesystem did not: `cat workspace/storage/x` in Bash, `verify: file:`,
// `each: rows of` / `when: rows of`, `preview:` and `schema:` each resolved it
// as a folder inside the agent's own directory, which does not exist.
//
//   node --test tests/workspace-prefix.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { checkPaths, linkWorkspace, resolveAgentPath } from "../src/confine.ts";
import { executeStep, checkVerify, type QueryFn } from "../src/step-exec.ts";
import { startFlowRun, waitForRun, readSchemaFile, resolveDocLinks } from "../src/runner.ts";
import { parseFlow, type FlowStep } from "../src/store.ts";
import { lintFlow } from "../src/flow-lint.ts";
import { entriesNoFollow } from "../src/paths.ts";

function workspace() {
  const ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ws-prefix-")));
  const agentDir = path.join(ws, "agents", "a");
  fs.mkdirSync(agentDir, { recursive: true });
  fs.mkdirSync(path.join(ws, "storage"), { recursive: true });
  fs.mkdirSync(path.join(ws, "state"), { recursive: true });
  fs.writeFileSync(path.join(ws, "storage", "x.txt"), "stored\n");
  fs.writeFileSync(path.join(ws, "state", "cursor.json"), "{\"n\":1}\n");
  return { ws, agentDir };
}

test("resolveAgentPath: workspace/ from the root, anything else from the agent folder", () => {
  const { ws, agentDir } = workspace();
  assert.equal(resolveAgentPath(ws, agentDir, "workspace/storage/x.txt"), path.join(ws, "storage/x.txt"));
  assert.equal(resolveAgentPath(ws, agentDir, "../../storage/x.txt"), path.join(ws, "storage/x.txt"));
  assert.equal(resolveAgentPath(ws, agentDir, "outputs/y.md"), path.join(agentDir, "outputs/y.md"));
  assert.equal(resolveAgentPath(ws, agentDir, "workspace"), ws);
});

test("Glob: a workspace/ or climbing pattern is split into path + pattern", () => {
  const { ws, agentDir } = workspace();
  const roots = { agentDir, workspaceRoot: ws, libraryRoot: path.join(ws, "..", "lib-none") };
  for (const pattern of ["workspace/storage/*.txt", "../../storage/*.txt"]) {
    const v = checkPaths("Glob", { pattern }, roots);
    assert.ok(v.ok, pattern);
    assert.equal(v.updatedInput?.path, path.join(ws, "storage"), pattern);
    assert.equal(v.updatedInput?.pattern, "*.txt", pattern);
  }
  // A path given explicitly is the author's; the pattern then stays as is.
  const kept = checkPaths("Glob", { pattern: "*.txt", path: "workspace/storage" }, roots);
  assert.equal(kept.updatedInput?.path, path.join(ws, "storage"));
  assert.equal(kept.updatedInput?.pattern ?? "*.txt", "*.txt");
  // Read and Write keep the expansion they always had.
  assert.equal(checkPaths("Read", { file_path: "workspace/state/cursor.json" }, roots).updatedInput?.file_path, path.join(ws, "state/cursor.json"));
  assert.equal(checkPaths("Write", { file_path: "workspace/storage/new.csv" }, roots).updatedInput?.file_path, path.join(ws, "storage/new.csv"));
});

test("linkWorkspace: a shell reaches workspace/, the last holder removes the link", () => {
  const { ws, agentDir } = workspace();
  const a = linkWorkspace(agentDir, ws);
  const b = linkWorkspace(agentDir, ws); // a parallel instance of the same agent
  assert.equal(a.note, null);
  assert.equal(execFileSync("bash", ["-c", "cat workspace/storage/x.txt && cat ../../storage/x.txt"], { cwd: agentDir, encoding: "utf8" }), "stored\nstored\n");
  execFileSync("bash", ["-c", "echo new > workspace/state/written.txt"], { cwd: agentDir });
  assert.equal(fs.readFileSync(path.join(ws, "state", "written.txt"), "utf8"), "new\n");
  a.release();
  assert.ok(fs.lstatSync(path.join(agentDir, "workspace")).isSymbolicLink(), "still held by the other instance");
  b.release();
  b.release(); // twice is harmless
  assert.equal(fs.existsSync(path.join(agentDir, "workspace")), false);
});

test("linkWorkspace: a real workspace/ folder is left alone and reported", () => {
  const { ws, agentDir } = workspace();
  fs.mkdirSync(path.join(agentDir, "workspace", "storage"), { recursive: true });
  fs.writeFileSync(path.join(agentDir, "workspace", "storage", "stray.txt"), "stray");
  const l = linkWorkspace(agentDir, ws);
  assert.match(l.note ?? "", /real folder/);
  l.release();
  assert.ok(fs.existsSync(path.join(agentDir, "workspace", "storage", "stray.txt")));
});

test("linkWorkspace: a link left by a step that never cleaned up is adopted and removed", () => {
  const { ws, agentDir } = workspace();
  fs.symlinkSync("../..", path.join(agentDir, "workspace"), "dir");
  const l = linkWorkspace(agentDir, ws);
  assert.equal(l.note, null);
  l.release();
  assert.equal(fs.existsSync(path.join(agentDir, "workspace")), false);
});

test("the workspace walkers do not follow the link back up the tree", () => {
  const { ws, agentDir } = workspace();
  const l = linkWorkspace(agentDir, ws);
  try {
    const entries = entriesNoFollow(ws);
    assert.ok(entries.includes(path.join("agents", "a", "workspace")));
    assert.ok(!entries.some((e) => e.startsWith(path.join("agents", "a", "workspace") + path.sep)));
  } finally {
    l.release();
  }
});

test("executeStep: the shell sees workspace/ during the step and its shell verify:, and the link is gone after", async () => {
  const { ws, agentDir } = workspace();
  let during = "";
  const query: QueryFn = () => {
    during = execFileSync("bash", ["-c", "cat workspace/storage/x.txt"], { cwd: agentDir, encoding: "utf8" });
    const stream = (async function* () {
      yield { type: "result", subtype: "success", result: "done", total_cost_usd: 0 };
    })();
    return Object.assign(stream, { async interrupt() {} });
  };
  const events: string[] = [];
  const out = await executeStep({
    agentDir, workspaceRoot: ws, libraryRoot: path.join(ws, "..", "lib-none"), prompt: "p", model: "haiku", systemPrompt: "s",
    allowed: [], mcpNames: [], mcpServers: {}, env: {}, emit: (_t: string, text: string) => events.push(text),
    verify: "test -s workspace/storage/x.txt && test -s ../../state/cursor.json",
  } as any, query);
  assert.equal(during, "stored\n");
  assert.equal(out.status, "completed", events.join("\n"));
  assert.ok(events.some((e) => /verify .* exit 0/.test(e)), events.join("\n"));
  assert.equal(fs.existsSync(path.join(agentDir, "workspace")), false);
});

test("verify: file: — workspace/ and ../../ both reach the workspace; outside it does not", async () => {
  const { agentDir } = workspace();
  const ctx = { env: {}, result: "" };
  assert.equal((await checkVerify(agentDir, "file: workspace/storage/x.txt", ctx)).ok, true);
  assert.equal((await checkVerify(agentDir, "file: ../../storage/x.txt", ctx)).ok, true);
  assert.equal((await checkVerify(agentDir, "file: workspace/storage/missing.txt", ctx)).ok, false);
  const out = await checkVerify(agentDir, "file: ../../../etc/passwd", ctx);
  assert.equal(out.ok, false);
  assert.match(out.headline, /escapes/);
});

test("preview: and schema: take workspace/ like ../../", () => {
  const flow = parseFlow(
    "flows/x.md",
    "---\nname: x\n---\n\n1. [[a]] — go\n   preview: workspace/storage/draft/*.mdx, ../../storage/b.md, c.md\n",
  );
  assert.deepEqual(flow.steps[0].preview, ["draft/*.mdx", "b.md", "c.md"]);
  const { ws } = workspace();
  fs.mkdirSync(path.join(ws, "schemas"));
  fs.writeFileSync(path.join(ws, "schemas", "lead.json"), JSON.stringify({ type: "object" }));
  assert.deepEqual(readSchemaFile(ws, "workspace/schemas/lead.json"), { type: "object" });
  assert.deepEqual(readSchemaFile(ws, "../../schemas/lead.json"), { type: "object" });
});

test("doc links name storage/ and state/ files by workspace/", () => {
  const { ws } = workspace();
  const out = resolveDocLinks("read [[cursor.json]] and [[storage/x.txt]]", ws);
  assert.match(out, /workspace\/state\/cursor\.json/);
  assert.match(out, /workspace\/storage\/x\.txt/);
});

test("foldrun check: ../../storage is a hint, never an error; workspace/ is silent", () => {
  const old = parseFlow("flows/x.md", "---\nname: x\n---\n\n1. [[a]] — go\n   verify: test -s ../../storage/out.md\n");
  const w = lintFlow(old, { agents: ["a"] }).filter((x) => x.kind === "spelling");
  assert.equal(w.length, 1);
  assert.equal(w[0].level, undefined);
  const fresh = parseFlow("flows/x.md", "---\nname: x\n---\n\n1. [[a]] — go\n   verify: test -s workspace/storage/out.md\n");
  assert.equal(lintFlow(fresh, { agents: ["a"] }).filter((x) => x.kind === "spelling").length, 0);
});

// ---------------------------------------------------- each: / when: rows of

async function stubbedRun(files: Record<string, string>, steps: FlowStep[]) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-ws-prefix-"));
  const prevData = process.env.FOLDRUN_DATA;
  const prevStub = process.env.FOLDRUN_STUB_STEP;
  process.env.FOLDRUN_DATA = root;
  process.env.FOLDRUN_STUB_STEP = "1";
  try {
    const ws = path.join(root, "acme/workspaces/desk");
    for (const name of new Set(steps.map((s) => s.agent!))) {
      const dir = path.join(ws, "agents", name);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "agent.md"), `---\nname: ${name}\ndescription: stub\n---\n\nStub.\n`);
      fs.writeFileSync(path.join(dir, "stub.md"), "ok");
    }
    for (const [rel, content] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(ws, rel)), { recursive: true });
      fs.writeFileSync(path.join(ws, rel), content);
    }
    fs.writeFileSync(path.join(ws, "AGENTS.md"), "---\nname: desk\n---\n");
    const run = startFlowRun("acme", "desk", steps, "ws-prefix-test");
    const { run: finished } = await waitForRun("acme", "desk", run.id, 30_000);
    assert.ok(finished);
    return finished!;
  } finally {
    if (prevData === undefined) delete process.env.FOLDRUN_DATA;
    else process.env.FOLDRUN_DATA = prevData;
    if (prevStub === undefined) delete process.env.FOLDRUN_STUB_STEP;
    else process.env.FOLDRUN_STUB_STEP = prevStub;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const step = (agent: string, group: number, extra: Partial<FlowStep> = {}): FlowStep => ({
  agent, instruction: `do the ${agent} thing`, group, optional: false, ...extra,
});

for (const csv of ["workspace/storage/q.csv", "../../storage/q.csv"]) {
  test(`each: / when: rows of ${csv} — both spellings read the workspace's file`, async () => {
    const run = await stubbedRun({ "storage/q.csv": "id,x\nr1,a\nr2,b\n" }, [
      step("scan", 1),
      step("writer", 2, { each: "rows", eachPath: csv }),
      step("sheet", 3, { when: `rows of ${csv}` }),
    ]);
    assert.equal(run.status, "completed");
    assert.deepEqual(run.steps.filter((s) => s.agent === "writer").map((s) => s.status), ["skipped", "completed", "completed"]);
    assert.deepEqual(run.steps.filter((s) => s.agent === "sheet").map((s) => s.status), ["completed"]);
  });
}
