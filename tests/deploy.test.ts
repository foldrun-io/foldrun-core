// Deploying a workspace from a directory.
//
// The pitch for a markdown platform is that there is no build step, so deploy
// is a copy. The two things a copy cannot do are what this file is about:
// checking the whole workspace before any of it is live, and refusing to swap
// files under a run that is already reading them.
//
//   node --test tests/deploy.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  readTree,
  deployIssues,
  planDeploy,
  deployWorkspace,
  deployedCommit,
  runsInFlight,
} from "../packages/core/src/deploy.ts";
import type { DeployFile } from "../packages/core/src/store.ts";

function withData(body: (root: string) => void) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-deploy-"));
  const previous = process.env.FOLDRUN_DATA;
  const previousWs = process.env.FOLDRUN_WORKSPACE;
  process.env.FOLDRUN_DATA = root;
  delete process.env.FOLDRUN_WORKSPACE;
  try {
    body(root);
  } finally {
    if (previous === undefined) delete process.env.FOLDRUN_DATA;
    else process.env.FOLDRUN_DATA = previous;
    if (previousWs !== undefined) process.env.FOLDRUN_WORKSPACE = previousWs;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const AGENT = "---\nname: writer\ndescription: writes things\n---\n\nWrite.\n";
const FLOW = "---\nname: publish\ntrigger: manual\n---\n\n1. [[writer]] — write it\n";

const workspace = (over: Record<string, string> = {}): DeployFile[] =>
  Object.entries({
    "AGENTS.md": "---\nname: desk\n---\n\nA desk.\n",
    "agents/writer/agent.md": AGENT,
    "flows/publish.md": FLOW,
    ...over,
  }).map(([p, content]) => ({ path: p, content }));

// ── reading a tree ───────────────────────────────────────────────────────────

// A workspace usually lives in a repo next to things that are not the
// workspace. Those are skipped, not rejected — refusing to deploy a repo
// because it has a README would make the feature useless.
test("reading a tree takes workspace files and ignores the rest of the repo", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-src-"));
  try {
    const write = (rel: string, body = "x\n") => {
      fs.mkdirSync(path.join(dir, path.dirname(rel)), { recursive: true });
      fs.writeFileSync(path.join(dir, rel), body);
    };
    write("AGENTS.md");
    write("agents/writer/agent.md", AGENT);
    write("flows/publish.md", FLOW);
    write("README.md"); // not a workspace file
    write("package.json"); // not a workspace file
    write(".github/workflows/ci.yml");
    write("node_modules/left-pad/index.js");
    write(".git/config");
    write("runs/run-1.json"); // the platform's, never git's
    write("agents/writer/outputs/draft.md"); // produced, not authored
    write("secrets.json", '{"TOKEN":"hunter2"}');

    const got = readTree(dir).map((f) => f.path).sort();
    assert.deepEqual(got, ["AGENTS.md", "agents/writer/agent.md", "flows/publish.md"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// The one file that must never make the trip. A workspace is meant to be a git
// repo, so if someone commits their secrets despite the shipped .gitignore, a
// deploy must not carry them into the platform's own secret store.
test("secrets.json is never read out of a source tree", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-src-"));
  try {
    fs.writeFileSync(path.join(dir, "AGENTS.md"), "x\n");
    fs.writeFileSync(path.join(dir, "secrets.json"), '{"TOKEN":"hunter2"}');
    assert.ok(!readTree(dir).some((f) => f.path === "secrets.json"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── the check that runs before anything is live ──────────────────────────────

test("a workspace that checks out has no issues", () => {
  assert.deepEqual(deployIssues(workspace()), []);
});

// The most common way a push breaks a schedule: rename an agent, forget the
// flow that names it. At 3am the schedule fires and the step has nowhere to go.
// Everything here is declarative, so this is free to catch at push time.
test("a flow naming an agent the push does not ship is rejected", () => {
  const issues = deployIssues(
    workspace({ "flows/publish.md": "---\nname: publish\n---\n\n1. [[ghost]] — do it\n" }),
  );
  assert.equal(issues.length, 1);
  assert.match(issues[0].message, /\[\[ghost\]\] does not exist/);
});

test("a workspace with no agents is rejected", () => {
  const files = workspace().filter((f) => !f.path.startsWith("agents/"));
  assert.ok(deployIssues(files).some((i) => /needs at least one/.test(i.message)));
});

// Case matters on Linux and does not on macOS, so `Agents.md` deploys happily
// from a laptop and then vanishes on the runtime.
test("a standard filename with the wrong case is rejected", () => {
  const files = workspace().map((f) =>
    f.path === "AGENTS.md" ? { ...f, path: "Agents.md" } : f,
  );
  assert.ok(deployIssues(files).some((i) => /spelled exactly "AGENTS.md"/.test(i.message)));
});

test("a path escaping the workspace is rejected", () => {
  const files = [...workspace(), { path: "../../etc/passwd", content: "x" }];
  assert.ok(deployIssues(files).some((i) => /illegal path/.test(i.message)));
});

// A memory file that would fail the OKF validator should not become live —
// this is the same question `foldrun check` asks, asked earlier.
test("a non-conformant memory file is rejected", () => {
  const issues = deployIssues(
    workspace({ "memory/a-fact.md": "no frontmatter at all, so no type\n" }),
  );
  assert.ok(issues.length > 0, "a typeless concept should not deploy");
  assert.ok(issues.every((i) => i.where.startsWith("memory/")));
});

// Every problem at once. A push that reports one error, gets fixed, and then
// reports the next one wastes a round trip per mistake.
test("all the problems are reported together", () => {
  const issues = deployIssues([
    { path: "flows/a.md", content: "---\nname: a\n---\n\n1. [[nobody]] — go\n" },
  ]);
  assert.ok(issues.length >= 2, `expected several issues, got ${JSON.stringify(issues)}`);
});

// ── planning ─────────────────────────────────────────────────────────────────

test("a plan says what would change, without changing it", () => {
  withData(() => {
    deployWorkspace("acme", "desk", workspace());

    const next = workspace({
      "agents/writer/agent.md": `${AGENT}\nBe brief.\n`,
      "agents/editor/agent.md": "---\nname: editor\n---\n\nEdit.\n",
    }).filter((f) => f.path !== "flows/publish.md");

    const plan = planDeploy("acme", "desk", next);
    assert.deepEqual(plan.added, ["agents/editor/agent.md"]);
    assert.deepEqual(plan.updated, ["agents/writer/agent.md"]);
    assert.deepEqual(plan.removed, ["flows/publish.md"]);
    // and nothing happened
    assert.ok(fs.existsSync(path.join(process.env.FOLDRUN_DATA!, "acme/workspaces/desk/flows/publish.md")));
  });
});

// state/ and agent-written memory are the platform's, not git's. Reporting
// them as removals would be a lie, and the alarming kind — it would read as
// "this push deletes everything your agents learned".
test("what a deploy keeps is not reported as a removal", () => {
  withData((root) => {
    deployWorkspace("acme", "desk", workspace());
    const ws = path.join(root, "acme/workspaces/desk");
    fs.mkdirSync(path.join(ws, "state"), { recursive: true });
    fs.writeFileSync(path.join(ws, "state/cursor.json"), '{"last":7}\n');
    fs.mkdirSync(path.join(ws, "memory"), { recursive: true });
    fs.writeFileSync(path.join(ws, "memory/learned.md"), "---\ntype: Memory\n---\n\nA fact.\n");

    const plan = planDeploy("acme", "desk", workspace());
    assert.deepEqual(plan.removed, []);
  });
});

// ── applying ─────────────────────────────────────────────────────────────────

test("a deploy applies, and records the commit it came from", () => {
  withData((root) => {
    const out = deployWorkspace("acme", "desk", workspace(), { commit: "abc1234" });
    assert.equal(out.applied, true);
    assert.deepEqual(out.issues, []);
    assert.ok(fs.existsSync(path.join(root, "acme/workspaces/desk/agents/writer/agent.md")));
    assert.equal(deployedCommit("acme", "desk")?.commit, "abc1234");
  });
});

// The marker cannot live inside the workspace: saveWorkspace replaces that
// directory wholesale, so the next deploy would delete the record of the one
// before it.
test("the commit marker survives the next deploy", () => {
  withData(() => {
    deployWorkspace("acme", "desk", workspace(), { commit: "aaa" });
    deployWorkspace("acme", "desk", workspace({ "flows/x.md": FLOW }), { commit: "bbb" });
    assert.equal(deployedCommit("acme", "desk")?.commit, "bbb");
  });
});

test("a deploy that does not check out changes nothing", () => {
  withData((root) => {
    deployWorkspace("acme", "desk", workspace());
    const before = fs.readFileSync(
      path.join(root, "acme/workspaces/desk/agents/writer/agent.md"),
      "utf8",
    );

    const out = deployWorkspace("acme", "desk", [
      { path: "AGENTS.md", content: "x\n" },
      { path: "agents/writer/agent.md", content: "rewritten\n" },
      { path: "flows/publish.md", content: "---\nname: publish\n---\n\n1. [[ghost]] — go\n" },
    ]);

    assert.equal(out.applied, false);
    assert.ok(out.issues.length > 0);
    assert.equal(
      fs.readFileSync(path.join(root, "acme/workspaces/desk/agents/writer/agent.md"), "utf8"),
      before,
      "a refused deploy must not half-apply",
    );
  });
});

// A flow reads its agents step by step. Replacing them mid-run means step 3
// runs against a definition step 1 never saw, and the trace becomes a record of
// two different workspaces.
test("a deploy is refused while a run is in flight", () => {
  withData((root) => {
    deployWorkspace("acme", "desk", workspace());
    const runs = path.join(root, "acme/workspaces/desk/runs");
    fs.mkdirSync(runs, { recursive: true });
    fs.writeFileSync(
      path.join(runs, "r1.json"),
      JSON.stringify({
        id: "r1",
        flow: "publish",
        status: "running",
        startedAt: new Date().toISOString(),
        finishedAt: null,
        steps: [],
      }),
    );

    assert.deepEqual(runsInFlight("acme", "desk"), ["r1"]);
    const out = deployWorkspace("acme", "desk", workspace({ "flows/x.md": FLOW }));
    assert.equal(out.applied, false);
    assert.deepEqual(out.blockedBy, ["r1"]);
    assert.deepEqual(out.issues, [], "the workspace is fine — the moment is wrong");

    // and it goes through once nothing is reading the files
    assert.equal(deployWorkspace("acme", "desk", workspace({ "flows/x.md": FLOW }), { force: true }).applied, true);
  });
});

// Someone waiting to approve a step is about to approve work against a
// definition the deploy would silently replace.
test("a run waiting for a person also blocks a deploy", () => {
  withData((root) => {
    deployWorkspace("acme", "desk", workspace());
    const runs = path.join(root, "acme/workspaces/desk/runs");
    fs.mkdirSync(runs, { recursive: true });
    fs.writeFileSync(
      path.join(runs, "r2.json"),
      JSON.stringify({
        id: "r2",
        flow: "publish",
        status: "awaiting-approval",
        startedAt: new Date().toISOString(),
        finishedAt: null,
        steps: [],
      }),
    );
    assert.equal(deployWorkspace("acme", "desk", workspace()).applied, false);
  });
});

// The whole reason deploys route through here rather than writing files: what
// an agent produced is not in git and must outlive a push that never knew
// about it.
test("a deploy does not destroy what the agents produced", () => {
  withData((root) => {
    deployWorkspace("acme", "desk", workspace());
    const ws = path.join(root, "acme/workspaces/desk");
    fs.mkdirSync(path.join(ws, "state"), { recursive: true });
    fs.writeFileSync(path.join(ws, "state/cursor.json"), '{"last":7}\n');
    fs.mkdirSync(path.join(ws, "memory"), { recursive: true });
    fs.writeFileSync(path.join(ws, "memory/learned.md"), "---\ntype: Memory\n---\n\nA fact.\n");
    fs.writeFileSync(path.join(ws, "secrets.json"), '{"TOKEN":"x"}');
    fs.mkdirSync(path.join(ws, "runs"), { recursive: true });
    fs.writeFileSync(path.join(ws, "runs/old.json"), '{"id":"old","status":"completed","startedAt":"2026-01-01T00:00:00Z","steps":[]}');

    assert.equal(deployWorkspace("acme", "desk", workspace()).applied, true);

    for (const kept of ["state/cursor.json", "memory/learned.md", "secrets.json", "runs/old.json"]) {
      assert.ok(fs.existsSync(path.join(ws, kept)), `a deploy destroyed ${kept}`);
    }
  });
});
