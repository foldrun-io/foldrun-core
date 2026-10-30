// Names that are one folder, never a path; and writes that never make a
// workspace (API review, 30 Oct 2026).
//
//   - an ad-hoc run's agent came from the URL, and the runner joined it
//     unchecked: `../../<tenant>/workspaces/<ws>/agents/<a>` ran another
//     account's agent;
//   - resolveHooks joined a hook name unchecked, so the hook test route
//     answered which folders exist anywhere on the server;
//   - writeWorkspaceFile mkdir'd recursively, so a write to a name that did
//     not exist made that workspace, past workspace:manage and the plan cap;
//   - setWorkspaceDescription spliced its text into the frontmatter raw;
//   - a deploy's commit was checked after the files were replaced, and a
//     commit equal to a revision id overwrote that revision.
//
//   node --test tests/path-names.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startFlowRun, waitForRun } from "../src/runner.ts";
import {
  isOneSegment,
  saveWorkspace,
  setWorkspaceDescription,
  workspaceDir,
  writeWorkspaceFile,
} from "../src/store.ts";
import { resolveHooks, isHookName } from "../src/hooks.ts";
import { listRevisions, readRevision, resolveRevision, snapshotAt, changedPathsBetween } from "../src/history.ts";
import { configMatter } from "../src/matter.ts";

function withData(run: (root: string) => Promise<void> | void) {
  return async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-path-names-"));
    const prev = process.env.FOLDRUN_DATA;
    process.env.FOLDRUN_DATA = root;
    try {
      await run(root);
    } finally {
      if (prev === undefined) delete process.env.FOLDRUN_DATA;
      else process.env.FOLDRUN_DATA = prev;
      fs.rmSync(root, { recursive: true, force: true });
    }
  };
}

const AGENTS = "---\nname: desk\n---\n\nA desk.\n";

test("isOneSegment: a folder's name, never a path", () => {
  for (const ok of ["writer", "code_reviewer", "Writer2", "a.b"]) assert.equal(isOneSegment(ok), true, ok);
  for (const bad of ["", ".", "..", "../x", "a/b", "a\\b", "a\0b", "../../t2/workspaces/w/agents/spy", undefined, 7]) {
    assert.equal(isOneSegment(bad), false, String(bad));
  }
});

test("the runner refuses an agent name that is a path, even when the file it names exists", withData(async (root) => {
  const prevStub = process.env.FOLDRUN_STUB_STEP;
  process.env.FOLDRUN_STUB_STEP = "1";
  try {
    // Another account's agent, reachable by `..` from this workspace.
    const spy = path.join(root, "other/workspaces/w/agents/spy");
    fs.mkdirSync(spy, { recursive: true });
    fs.writeFileSync(path.join(spy, "agent.md"), "---\nname: spy\n---\n\nSpy.\n");
    const ws = path.join(root, "acme/workspaces/desk");
    fs.mkdirSync(path.join(ws, "agents"), { recursive: true });
    fs.writeFileSync(path.join(ws, "AGENTS.md"), AGENTS);
    const agent = "../../../../other/workspaces/w/agents/spy";
    assert.ok(fs.existsSync(path.join(ws, "agents", agent, "agent.md")), "the traversal does land on a real agent");

    const run = startFlowRun("acme", "desk", [{ agent, instruction: "go", group: 1, optional: false }], "adhoc:x");
    const { run: done } = await waitForRun("acme", "desk", run.id, 30_000);
    assert.ok(done);
    assert.equal(done.status, "failed");
    assert.equal(done.steps[0].status, "failed");
    assert.ok(done.steps[0].events.some((e) => /not found in workspace/.test(e.text)));
    assert.ok(!done.steps[0].events.some((e) => /stub call/.test(e.text)), "the step never ran");
  } finally {
    if (prevStub === undefined) delete process.env.FOLDRUN_STUB_STEP;
    else process.env.FOLDRUN_STUB_STEP = prevStub;
  }
}));

test("resolveHooks: a hook name that is a path is an error, and nothing outside hooks/ is looked at", withData((root) => {
  const ws = path.join(root, "acme/workspaces/desk");
  const lib = path.join(root, "acme/library");
  const other = path.join(root, "bigcorp/workspaces/w/hooks/guard");
  fs.mkdirSync(other, { recursive: true });
  fs.writeFileSync(path.join(other, "hook.md"), "---\non: tool.call\n---\n");
  fs.writeFileSync(path.join(other, "run.mjs"), "console.log('{}')\n");
  fs.mkdirSync(path.join(ws, "hooks"), { recursive: true });
  for (const name of ["../../../../bigcorp/workspaces/w/hooks/guard", "../../../../bigcorp", "a/b", ".."]) {
    assert.equal(isHookName(name), false, name);
    const r = resolveHooks({ workspaceRoot: ws, libraryRoot: lib, names: [name] });
    assert.deepEqual(r.hooks, [], name);
    assert.deepEqual(r.missing, [], `${name}: no existence answer either way`);
    assert.match(r.errors[0] ?? "", /is not a hook name/, name);
  }
  assert.equal(isHookName("no-force-push"), true);
}));

test("a write into a workspace that does not exist is a 404 and makes nothing", withData(() => {
  assert.throws(
    () => writeWorkspaceFile("acme", "ghost", "flows/x.md", "---\nname: x\n---\n"),
    (e: Error & { status?: number }) => e.status === 404 && /workspace ghost not found/.test(e.message),
  );
  assert.equal(fs.existsSync(workspaceDir("acme", "ghost")), false);
  saveWorkspace("acme", "desk", [{ path: "AGENTS.md", content: AGENTS }]);
  writeWorkspaceFile("acme", "desk", "flows/x.md", "---\nname: x\n---\n");
  assert.ok(fs.existsSync(path.join(workspaceDir("acme", "desk"), "flows/x.md")), "into one that exists, as always");
}));

test("a description is one YAML value: no extra keys, no $ patterns, and a revision", withData(() => {
  saveWorkspace("acme", "desk", [{ path: "AGENTS.md", content: "---\nname: desk\ndescription: old\n---\n\nBody $& stays.\n" }]);
  const sneaky = "harmless\nnetwork_enforce: false\nnotify: {url: https://evil.example/x}\n$' $& $`";
  setWorkspaceDescription("acme", "desk", sneaky, { by: "ana@example.com" });
  const raw = fs.readFileSync(path.join(workspaceDir("acme", "desk"), "AGENTS.md"), "utf8");
  const data = configMatter(raw).data as Record<string, unknown>;
  assert.equal(data.description, sneaky, "the whole text, as the value");
  assert.equal(data.network_enforce, undefined);
  assert.equal(data.notify, undefined);
  assert.equal(data.name, "desk");
  assert.match(raw, /Body \$& stays\./);
  assert.equal(raw.match(/Body/g)?.length, 1, "no part of the file was duplicated");
  const head = listRevisions("acme", "desk")[0];
  assert.equal(head.by, "ana@example.com");
  assert.deepEqual(head.paths, ["AGENTS.md"]);
}));

test("a bad commit is refused before anything is written", withData(() => {
  saveWorkspace("acme", "desk", [{ path: "AGENTS.md", content: AGENTS }]);
  const file = path.join(workspaceDir("acme", "desk"), "AGENTS.md");
  for (const commit of ["../x", "has space", "-flag", "x".repeat(200)]) {
    assert.throws(
      () => saveWorkspace("acme", "desk", [{ path: "AGENTS.md", content: "---\nname: changed\n---\n" }], { commit }),
      (e: Error & { status?: number }) => e.status === 400 && /not a commit id/.test(e.message),
      commit,
    );
    assert.equal(fs.readFileSync(file, "utf8"), AGENTS, `${commit}: the live source is untouched`);
  }
}));

test("deploying a commit that is already a revision id never overwrites that revision", withData(() => {
  saveWorkspace("acme", "desk", [{ path: "AGENTS.md", content: AGENTS }], { commit: "abc1234", by: "deploy" });
  const first = readRevision("acme", "desk", "abc1234")!;
  assert.ok(first);
  saveWorkspace("acme", "desk", [{ path: "AGENTS.md", content: "---\nname: desk\n---\n\nChanged.\n" }], { commit: "abc1234", by: "deploy" });
  assert.deepEqual(readRevision("acme", "desk", "abc1234"), first, "the first revision is as it was");
  const revs = listRevisions("acme", "desk");
  const again = revs.find((r) => r.id !== "abc1234" && r.commit === "abc1234");
  assert.ok(again, "the second deploy is its own revision, naming the commit");
  assert.equal(revs.filter((r) => r.id === "abc1234").length, 1, "one index line per id");
  // Each stays restorable by itself: the exact id is the first deploy, not
  // the newer revision that names the same commit (Codex review, 30 Oct 2026).
  assert.equal(resolveRevision("acme", "desk", "abc1234")!.id, "abc1234");
  assert.equal(resolveRevision("acme", "desk", again!.id)!.id, again!.id);
  assert.match(snapshotAt("acme", "desk", resolveRevision("acme", "desk", "abc1234")!.id)!.find((f) => f.path === "AGENTS.md")!.content, /A desk\./);
  assert.deepEqual(changedPathsBetween("acme", "desk", "abc1234", again!.id), ["AGENTS.md"], "a diff from the first deploy to the second");
  // A local revision id as `commit` cannot take it over either.
  const local = revs.find((r) => r.id.startsWith("r-")) ?? again!;
  const before = readRevision("acme", "desk", local.id);
  saveWorkspace("acme", "desk", [{ path: "AGENTS.md", content: AGENTS }], { commit: local.id });
  assert.deepEqual(readRevision("acme", "desk", local.id), before);
}));
