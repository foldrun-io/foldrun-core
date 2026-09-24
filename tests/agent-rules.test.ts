// The coding-agent block in AGENTS.md is for the tool editing the folder,
// never for an agent doing the work: sharedInstructions must not carry it.
//
//   node --test tests/agent-rules.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readAgentsMd, withoutAgentRules, AGENT_RULES_START, AGENT_RULES_END } from "../src/runner.ts";

test("the managed block is removed from the prose, and nothing else is", () => {
  const body = `Write for Australian owners.\n\n${AGENT_RULES_START}\n# This is NOT the foldrun you know\nread the docs\n${AGENT_RULES_END}\n\nNever quote prices.`;
  assert.equal(withoutAgentRules(body), "Write for Australian owners.\n\n\n\nNever quote prices.");
  assert.equal(withoutAgentRules("no block here"), "no block here");
  assert.equal(withoutAgentRules(`${AGENT_RULES_START} unterminated`), `${AGENT_RULES_START} unterminated`, "a broken block is left alone rather than eating the file");
});

test("readAgentsMd returns the frontmatter and the prose without the block", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-rules-"));
  fs.writeFileSync(path.join(dir, "AGENTS.md"), `---\ntimezone: Australia/Sydney\n---\n\n${AGENT_RULES_START}\nfor the coding tool\n${AGENT_RULES_END}\n\nThe house style is plain English.\n`);
  const got = readAgentsMd(dir)!;
  assert.equal(got.data.timezone, "Australia/Sydney");
  assert.equal(got.body, "The house style is plain English.");
  fs.rmSync(dir, { recursive: true, force: true });
});
