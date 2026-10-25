// `owner:` — the person who answers for an agent or a flow.
//
// Its own, else the workspace AGENTS.md's, else the account's: the same
// cascade every default walks, so an account of thousands of agents can name
// one person for all of them and a team for its own desk.
//
//   node --test tests/owner.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { listAgents, listFlows, readFlow, resolveOwner } from "../src/store.ts";

function withAccount(files: Record<string, string>, run: () => void) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-owner-"));
  const previous = process.env.FOLDRUN_DATA;
  process.env.FOLDRUN_DATA = root;
  try {
    for (const [rel, content] of Object.entries(files)) {
      const file = path.join(root, rel);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, content);
    }
    run();
  } finally {
    if (previous === undefined) delete process.env.FOLDRUN_DATA;
    else process.env.FOLDRUN_DATA = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const agent = (front: string) => `---\n${front}description: t\n---\n\nwork.\n`;
const flow = (front: string) => `---\n${front}trigger: manual\n---\n\n1. [[writer]] — draft\n`;

test("an agent's owner: its own, else the workspace's, else the account's", () => {
  withAccount(
    {
      "acme/AGENTS.md": "---\nowner: cto@acme.io\n---\n",
      "acme/workspaces/desk/AGENTS.md": "---\nname: desk\nowner: desk-lead@acme.io\n---\n",
      "acme/workspaces/desk/agents/writer/agent.md": agent("name: writer\nowner: ana@acme.io\n"),
      "acme/workspaces/desk/agents/editor/agent.md": agent("name: editor\n"),
      "acme/workspaces/bare/AGENTS.md": "---\nname: bare\n---\n",
      "acme/workspaces/bare/agents/scout/agent.md": agent("name: scout\nowner: \"  \"\n"),
    },
    () => {
      const by = Object.fromEntries(listAgents("acme", "desk").map((a) => [a.name, a]));
      assert.equal(by.writer.owner, "ana@acme.io");
      assert.equal(by.writer.ownerFrom, "agent");
      assert.equal(by.editor.owner, "desk-lead@acme.io");
      assert.equal(by.editor.ownerFrom, "workspace");
      const [scout] = listAgents("acme", "bare");
      assert.equal(scout.owner, "cto@acme.io", "a blank owner is no owner");
      assert.equal(scout.ownerFrom, "account");
    },
  );
});

test("no owner anywhere is null, not an empty string", () => {
  withAccount(
    {
      "acme/workspaces/desk/AGENTS.md": "---\nname: desk\n---\n",
      "acme/workspaces/desk/agents/writer/agent.md": agent("name: writer\n"),
    },
    () => {
      const [writer] = listAgents("acme", "desk");
      assert.equal(writer.owner, null);
      assert.equal(writer.ownerFrom, null);
    },
  );
});

test("a flow's owner walks the same cascade, in listFlows and readFlow", () => {
  withAccount(
    {
      "acme/AGENTS.md": "---\nowner: cto@acme.io\n---\n",
      "acme/workspaces/desk/AGENTS.md": "---\nname: desk\n---\n",
      "acme/workspaces/desk/flows/daily.md": flow("name: daily\nowner: Ana Lopez\n"),
      "acme/workspaces/desk/flows/weekly.md": flow("name: weekly\n"),
    },
    () => {
      const by = Object.fromEntries(listFlows("acme", "desk").map((f) => [f.name, f]));
      assert.equal(by.daily.owner, "Ana Lopez");
      assert.equal(by.daily.ownerFrom, "flow");
      assert.equal(by.weekly.owner, "cto@acme.io");
      assert.equal(by.weekly.ownerFrom, "account");
      assert.equal(readFlow("acme", "desk", "weekly")?.owner, "cto@acme.io");
    },
  );
});

test("resolveOwner ignores what is not text", () => {
  assert.deepEqual(resolveOwner(42, ["x"], "  ops@acme.io "), { owner: "ops@acme.io", ownerFrom: "account" });
  assert.deepEqual(resolveOwner(undefined), { owner: null, ownerFrom: null });
});
