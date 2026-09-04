// Preview workspaces: a branch pushed to a workspace's repository becomes
// `<ws>--<branch>`, deployed from the branch; a deleted branch takes it
// with it; the scheduler skips it; it reads its source's secrets.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { commitChanges, gitAvailable, listRefs, repoDir } from "../packages/core/src/gitrepo.ts";
import { saveWorkspace, workspaceDir, listWorkspaces } from "../packages/core/src/store.ts";
import { previewName, syncPreviews, readPreview, isPreview, previewsOf, readPreviewNotes, deletePreviewsOf } from "../packages/core/src/preview.ts";
import { parseCron, nextFire } from "../packages/core/src/scheduler.ts";

const HAVE_GIT = gitAvailable();

function withData(run: () => void) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-preview-"));
  const prev = process.env.FOLDRUN_DATA;
  process.env.FOLDRUN_DATA = root;
  try {
    run();
  } finally {
    if (prev === undefined) delete process.env.FOLDRUN_DATA;
    else process.env.FOLDRUN_DATA = prev;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const AGENT = "---\nname: writer\ndescription: writes\n---\nWrite.\n";
const AGENTS_MD = "---\nname: desk\ndescription: the desk\n---\n";

test("a branch name becomes a workspace name that reads back to its source", () => {
  assert.equal(previewName("leads", "fix/referral-sync"), "leads-preview-fix-referral-sync");
  assert.equal(previewName("leads", "Feature_Branch_2"), "leads-preview-feature-branch-2");
  assert.equal(previewName("leads", "///"), "leads-preview-branch");
  assert.ok(previewName("a-long-workspace-name", "x".repeat(200)).length <= 63);
});

test("a pushed branch deploys a preview; moving it redeploys; deleting it removes the preview", { skip: !HAVE_GIT }, () =>
  withData(() => {
    saveWorkspace("acme", "desk", [{ path: "AGENTS.md", content: AGENTS_MD }, { path: "agents/writer/agent.md", content: AGENT }]);
    commitChanges("acme", "desk", [
      { path: "AGENTS.md", before: null, after: AGENTS_MD },
      { path: "agents/writer/agent.md", before: null, after: AGENT },
    ], { message: "start" });
    const before = listRefs("acme", "desk", "heads");
    // A branch with a second agent, made the way a push makes one: clone
    // the bare repository, commit on a branch, push it back.
    const dir = repoDir("acme", "desk");
    const work = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-preview-clone-"));
    const sh = (args: string[], cwd = work) => {
      const r = spawnSync("git", args, {
        cwd,
        encoding: "utf8",
        env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@x", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@x" },
      });
      assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`);
      return r.stdout.trim();
    };
    sh(["clone", "--quiet", "--branch", "main", dir, "clone"], work);
    const clone = path.join(work, "clone");
    sh(["checkout", "--quiet", "-b", "feat/second"], clone);
    fs.mkdirSync(path.join(clone, "agents/checker"), { recursive: true });
    fs.writeFileSync(path.join(clone, "agents/checker/agent.md"), "---\nname: checker\ndescription: checks\n---\nCheck.\n");
    sh(["add", "."], clone);
    sh(["commit", "--quiet", "-m", "add a checker"], clone);
    sh(["push", "--quiet", "origin", "feat/second"], clone);
    const git = (...args: string[]) => sh(["--git-dir", dir, ...args], work);

    const after = listRefs("acme", "desk", "heads");
    const sync = syncPreviews("acme", "desk", before, after);
    assert.deepEqual(sync.deployed.map((d) => d.workspace), ["desk-preview-feat-second"]);
    assert.ok(fs.existsSync(path.join(workspaceDir("acme", "desk-preview-feat-second"), "agents/checker/agent.md")), "the branch's tree is the preview");
    assert.equal(readPreview("acme", "desk-preview-feat-second")?.branch, "feat/second");
    assert.equal(isPreview("acme", "desk-preview-feat-second"), true);
    assert.equal(isPreview("acme", "desk"), false);
    assert.equal(previewsOf("acme", "desk")[0]?.workspace, "desk-preview-feat-second");
    assert.equal(listWorkspaces("acme").find((w) => w.name === "desk-preview-feat-second")?.preview?.source, "desk");
    const notes = readPreviewNotes("acme", "desk");
    assert.equal(notes[0].subject, "add a checker");
    assert.equal(notes[0].applied, true);

    // Unmoved: nothing redeploys.
    assert.deepEqual(syncPreviews("acme", "desk", after, after).deployed, []);

    // The branch goes: so does the preview, and its note.
    git("update-ref", "-d", "refs/heads/feat/second");
    const gone = syncPreviews("acme", "desk", after, listRefs("acme", "desk", "heads"));
    assert.deepEqual(gone.deleted, ["desk-preview-feat-second"]);
    assert.equal(fs.existsSync(workspaceDir("acme", "desk-preview-feat-second")), false);
    assert.equal(readPreview("acme", "desk-preview-feat-second"), null);
    assert.deepEqual(readPreviewNotes("acme", "desk"), []);
  }));

test("deleting the source deletes its previews", { skip: !HAVE_GIT }, () =>
  withData(() => {
    saveWorkspace("acme", "desk", [{ path: "AGENTS.md", content: AGENTS_MD }]);
    saveWorkspace("acme", "desk-preview-x", [{ path: "AGENTS.md", content: AGENTS_MD }]);
    fs.writeFileSync(path.join(workspaceDir("acme", "desk-preview-x"), "..", ".desk-preview-x.preview.json"), JSON.stringify({ source: "desk", branch: "x", commit: "abc", at: "2026-09-04T00:00:00Z" }));
    assert.deepEqual(deletePreviewsOf("acme", "desk"), ["desk-preview-x"]);
    assert.equal(fs.existsSync(workspaceDir("acme", "desk-preview-x")), false);
  }));

test("the next fire of a cron, across a zone", () => {
  const daily = parseCron("0 5 * * *")!;
  const from = new Date("2026-09-04T10:00:00Z");
  // 05:00 Sydney (AEST, +10) is 19:00 UTC the day before — the next one after 10:00Z is today 19:00Z.
  assert.equal(nextFire(daily, from, "Australia/Sydney")?.toISOString(), "2026-09-04T19:00:00.000Z");
  assert.equal(nextFire(daily, from, "UTC")?.toISOString(), "2026-09-05T05:00:00.000Z");
  // Adelaide is +9:30: 05:00 there is 19:30Z.
  assert.equal(nextFire(daily, from, "Australia/Adelaide")?.toISOString(), "2026-09-04T19:30:00.000Z");
  // Weekday only, from a Friday evening: Monday.
  const weekdays = parseCron("30 9 * * 1-5")!;
  assert.equal(nextFire(weekdays, new Date("2026-09-04T23:00:00Z"), "UTC")?.toISOString(), "2026-09-07T09:30:00.000Z");
  // A day that never comes inside the window is null, not a hang.
  assert.equal(nextFire(parseCron("0 0 31 2 *")!, from, "UTC", 60), null);
});
