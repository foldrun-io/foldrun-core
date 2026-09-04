// The editor's reading of a file: its kind from the path, its frontmatter as
// chips, the secrets it names.

import test from "node:test";
import assert from "node:assert/strict";
import { kindOf, chipsFor, secretRefs, crumbs, DOC_FOR } from "../web/components/editor-context-model.ts";

test("a path says what kind of thing it is", () => {
  assert.equal(kindOf("agents/writer/agent.md"), "agent");
  assert.equal(kindOf("agents/writer/skills/tone/SKILL.md"), "skill");
  assert.equal(kindOf("agents/writer/memory/lesson.md"), "memory");
  assert.equal(kindOf("flows/weekly.md"), "flow");
  assert.equal(kindOf("tools/sql/tool.md"), "tool");
  assert.equal(kindOf("tools/sql/run.py"), "tool");
  assert.equal(kindOf("knowledge/prices.md"), "knowledge");
  assert.equal(kindOf("evals/writer.md"), "eval");
  assert.equal(kindOf("state/cursor.json"), "state");
  assert.equal(kindOf("scripts/fetch.sh"), "script");
  assert.equal(kindOf("AGENTS.md"), "config");
  assert.equal(kindOf("README.md"), "other");
  assert.equal(DOC_FOR.tool, "tools");
});

test("frontmatter reads as chips", () => {
  assert.deepEqual(
    chipsFor("tool", { transport: "http", methods: ["POST"], base: "https://api.resend.com", timeout: 30 }).map((c) => c.label),
    ["http", "POST", "api.resend.com", "30s"],
  );
  assert.deepEqual(chipsFor("tool", { run: "run.py", args: { query: "x", files: "y" } }).map((c) => c.label), ["run run.py", "2 args"]);
  assert.deepEqual(chipsFor("agent", { model: "sonnet", tools: ["a", "b", "c"], agents: ["x"] }).map((c) => c.label), ["sonnet", "3 tools", "asks 1"]);
  assert.deepEqual(chipsFor("flow", { trigger: "schedule", schedule: "0 5 * * 1", budget: 4 }).map((c) => c.label), ["schedule", "0 5 * * 1", "budget $4"]);
  assert.deepEqual(chipsFor("knowledge", { type: "Reference", status: "stable" }).map((c) => c.label), ["Reference", "stable"]);
  assert.deepEqual(chipsFor("other", { anything: 1 }), []);
});

test("the secrets a file names, once each, sorted", () => {
  assert.deepEqual(secretRefs("Authorization: Bearer ${RESEND_API_KEY}\nx: ${A_B}\ny: ${RESEND_API_KEY} ${lower}"), ["A_B", "RESEND_API_KEY"]);
});

test("breadcrumbs carry the folder prefix each one opens", () => {
  assert.deepEqual(crumbs("agents/writer/agent.md"), [
    { label: "agents", prefix: "agents" },
    { label: "writer", prefix: "agents/writer" },
    { label: "agent.md", prefix: "agents/writer/agent.md" },
  ]);
});
