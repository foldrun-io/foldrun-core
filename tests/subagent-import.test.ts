// Bridge: single-file subagents authored by coding tools.
//
// Claude Code writes a subagent to .claude/agents/<name>.md (and the
// cross-client location is .agents/agents/<name>.md). Their frontmatter is
// already what a foldrun agent reads, so readTree maps each to the folder
// shape agents/<name>/agent.md with content unchanged — a native agent always
// winning. These guard that mapping and its precedence.
//
//   node --test tests/subagent-import.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readTree } from "../packages/core/src/deploy.ts";

function tree(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-import-"));
  for (const [rel, body] of Object.entries(files)) {
    const f = path.join(root, rel);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, body);
  }
  return root;
}

const CC_AGENT = "---\nname: code-reviewer\ndescription: Reviews a diff.\ntools: Read, Grep\nmodel: fast\n---\nReview the diff.";

test("a .claude/agents subagent imports as agents/<name>/agent.md", () => {
  const root = tree({
    "AGENTS.md": "---\ndescription: w\n---\nx",
    "agents/writer/agent.md": "---\nname: writer\ndescription: writes\n---\nWrite.",
    ".claude/agents/code-reviewer.md": CC_AGENT,
  });
  const paths = readTree(root).map((f) => f.path);
  assert.ok(paths.includes("agents/code-reviewer/agent.md"), "the subagent should be mapped in");
  const mapped = readTree(root).find((f) => f.path === "agents/code-reviewer/agent.md");
  assert.match(mapped!.content, /Review the diff\./, "content is shipped unchanged");
});

test(".agents/agents is also scanned (cross-client location)", () => {
  const root = tree({
    "AGENTS.md": "---\ndescription: w\n---\nx",
    ".agents/agents/scout.md": "---\nname: scout\ndescription: scouts\n---\nScout.",
  });
  const paths = readTree(root).map((f) => f.path);
  assert.ok(paths.includes("agents/scout/agent.md"));
});

test("a native agent wins a name clash with an imported one", () => {
  const root = tree({
    "AGENTS.md": "---\ndescription: w\n---\nx",
    "agents/code-reviewer/agent.md": "---\nname: code-reviewer\ndescription: native\n---\nNATIVE BODY.",
    ".claude/agents/code-reviewer.md": CC_AGENT,
  });
  const entries = readTree(root).filter((f) => f.path === "agents/code-reviewer/agent.md");
  assert.equal(entries.length, 1, "exactly one entry for the name");
  assert.match(entries[0].content, /NATIVE BODY/, "the native agent wins");
});

test("the neutral .agents/agents wins over a vendor .claude/agents clash", () => {
  const root = tree({
    "AGENTS.md": "---\ndescription: w\n---\nx",
    ".agents/agents/dup.md": "---\nname: dup\ndescription: neutral\n---\nNEUTRAL BODY.",
    ".claude/agents/dup.md": "---\nname: dup\ndescription: vendor\n---\nVENDOR BODY.",
  });
  const entries = readTree(root).filter((f) => f.path === "agents/dup/agent.md");
  assert.equal(entries.length, 1);
  assert.match(entries[0].content, /NEUTRAL BODY/, "the vendor-neutral location wins");
});
