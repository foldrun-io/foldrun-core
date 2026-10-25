// FOL-72 step 9: one filter over the run index, and the index rows that
// carry what it reads.
//
//   node --test tests/runs-filter.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseRunFilter, matchesRunFilter } from "../src/runs-filter.ts";
import { summarizeRun, type RunRecord } from "../src/store.ts";

const T = (s: number) => new Date(Date.parse("2026-10-19T00:00:00.000Z") + s * 1000).toISOString();
const run = {
  id: "r", flow: "daily", status: "completed", startedAt: T(0), finishedAt: T(300),
  steps: [
    { agent: "researcher", instruction: "", group: 1, optional: false, status: "completed", model: "claude-haiku-5-5", tokens: { input: 40000, output: 10 }, result: null, costUsd: 0, events: [
      { t: T(1), type: "tool", text: "mcp__foldrun_scripts__web", call: "a" },
      { t: T(2), type: "tool", text: "mcp__foldrun_scripts__web", call: "a", ms: 9, err: true },
      { t: T(3), type: "tool", text: "Read", call: "b" },
      { t: T(4), type: "tool", text: "Read", call: "b", ms: 2 },
    ] },
    { agent: "writer", instruction: "", group: 2, optional: false, status: "completed", tokens: { input: 20000, output: 10 }, result: null, costUsd: 0, events: [] },
  ],
} as unknown as RunRecord;

test("the index row carries each step's tools, tool errors and model", () => {
  const row = summarizeRun(run);
  assert.deepEqual(row.steps[0], { ...row.steps[0], tools: ["mcp__foldrun_scripts__web", "Read"], toolErrors: 1, model: "claude-haiku-5-5" });
  assert.equal(row.steps[1]!.tools, undefined);
});

test("each filter, on the row", () => {
  const row = summarizeRun(run);
  const f = (q: Record<string, string>) => parseRunFilter(new URLSearchParams(q)).filter;
  assert.ok(matchesRunFilter(row, f({ tool: "web" })));
  assert.ok(!matchesRunFilter(row, f({ tool: "crm" })));
  assert.ok(matchesRunFilter(row, f({ tool_error: "1" })));
  assert.ok(matchesRunFilter(row, f({ agent: "writer", model: "haiku" })));
  assert.ok(matchesRunFilter(row, f({ min_tokens: "60k" })));
  assert.ok(!matchesRunFilter(row, f({ min_tokens: "60001" })));
  assert.ok(matchesRunFilter(row, f({ min_secs: "300" })));
  assert.ok(!matchesRunFilter(row, f({ min_secs: "301" })));
  assert.deepEqual(parseRunFilter(new URLSearchParams({ min_secs: "soon" })).problems, ["min_secs is a number (seconds), not soon"]);
});

test("1.5k is fifteen hundred; a whole record is searched by its events (Codex review)", () => {
  assert.equal(parseRunFilter(new URLSearchParams({ min_tokens: "1.5k" })).filter.minTokens, 1500);
  assert.ok(matchesRunFilter(run as unknown as Parameters<typeof matchesRunFilter>[0], parseRunFilter(new URLSearchParams({ tool: "web", tool_error: "1" })).filter), "the record itself, not its index row");
});
