// A push refused only because a run was in flight is a deploy that has not
// happened yet — git already told the client it succeeded, so nothing else
// would ever apply it. The scheduler retries it once the runs are done.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { applyPendingPush, writePushNote, readPushNote } from "../packages/core/src/deploy.ts";
import { workspaceDir } from "../packages/core/src/store.ts";

const FILES = [
  { path: "AGENTS.md", content: "---\nname: desk\n---\n" },
  { path: "agents/writer/agent.md", content: "---\nname: writer\ndescription: writes\n---\nWrite.\n" },
];
const filesAt = () => FILES;

function withWorkspace(body: () => void) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-pending-"));
  const previous = process.env.FOLDRUN_DATA;
  process.env.FOLDRUN_DATA = root;
  try {
    const ws = workspaceDir("acme", "desk");
    fs.mkdirSync(path.join(ws, "runs"), { recursive: true });
    fs.mkdirSync(path.join(ws, "agents/writer"), { recursive: true });
    fs.writeFileSync(path.join(ws, "AGENTS.md"), "---\nname: desk\n---\n");
    fs.writeFileSync(path.join(ws, "agents/writer/agent.md"), "---\nname: writer\ndescription: old\n---\nOld.\n");
    fs.mkdirSync(path.join(root, "acme/.git/desk.git"), { recursive: true });
    body();
  } finally {
    if (previous === undefined) delete process.env.FOLDRUN_DATA;
    else process.env.FOLDRUN_DATA = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const liveRun = () =>
  fs.writeFileSync(
    path.join(workspaceDir("acme", "desk"), "runs", "run-live.json"),
    JSON.stringify({ id: "run-live", flow: "publish", status: "running", startedAt: new Date().toISOString(), finishedAt: null, steps: [] }),
  );

test("a push blocked by a live run is applied once the run is done", () => {
  withWorkspace(() => {
    liveRun();
    writePushNote("acme", "desk", { commit: "abc123", at: new Date().toISOString(), applied: false, issues: [], blockedBy: ["run-live"] });

    assert.equal(applyPendingPush("acme", "desk", filesAt), null, "not while the run is live");

    fs.rmSync(path.join(workspaceDir("acme", "desk"), "runs", "run-live.json"));
    assert.deepEqual(applyPendingPush("acme", "desk", filesAt), { commit: "abc123" });

    const note = readPushNote("acme", "desk")!;
    assert.equal(note.applied, true);
    assert.ok(note.appliedAt, "records when it finally landed");
    assert.match(fs.readFileSync(path.join(workspaceDir("acme", "desk"), "agents/writer/agent.md"), "utf8"), /Write\./);
    assert.equal(applyPendingPush("acme", "desk", filesAt), null, "and does not apply twice");
  });
});

test("a push refused for issues is never retried — that one wants a person", () => {
  withWorkspace(() => {
    writePushNote("acme", "desk", {
      commit: "bad999",
      at: new Date().toISOString(),
      applied: false,
      issues: [{ where: "agents/", message: "no agents" }],
      blockedBy: ["run-live"],
    });
    assert.equal(applyPendingPush("acme", "desk", filesAt), null);
    assert.equal(readPushNote("acme", "desk")!.applied, false);
  });
});
