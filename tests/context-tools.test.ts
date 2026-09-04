// tools: [search] and tools: [history] — ranked search over an agent's
// documents, and its workspace's past runs, both built from values.
//
//   node --test tests/context-tools.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { searchRoots, digestRuns, buildSearchTools, buildHistoryTools } from "../packages/core/src/context-tools.ts";
import type { RunRecord } from "../packages/core/src/store.ts";

function bundle(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-search-"));
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), body);
  }
  return dir;
}

test("search ranks the file about the thing above the file that mentions it once, and skips OKF's generated files", () => {
  const dir = bundle({
    "index.md": "# Memory\n- rg-40 price\n- rain gauge",
    "log.md": "2026-01-01 Creation rg-40-price.md",
    "rg-40-price.md": "---\ntype: Fact\nname: RG-40 price\ndescription: what the RG-40 costs\n---\nThe RG-40 costs $34 including the bracket.",
    "farmers.md": "---\ntype: Fact\nname: audience\n---\nWe write for working farmers. The RG-40 is mentioned once here.",
    "nested/soil.md": "---\ntype: Fact\nname: soil\n---\nSoil moisture probes are a different product line.",
    "big.bin": "not text",
  });
  try {
    const hits = searchRoots([{ label: "memory/", dir }], "RG-40 price");
    assert.equal(hits[0].path, "memory/rg-40-price.md");
    assert.match(hits[0].snippet, /RG-40/);
    assert.ok(hits.some((h) => h.path === "memory/farmers.md"));
    assert.ok(!hits.some((h) => /index\.md|log\.md/.test(h.path)));
    assert.deepEqual(searchRoots([{ label: "memory/", dir }], "zzzz"), []);
    assert.deepEqual(searchRoots([{ label: "missing/", dir: path.join(dir, "nope") }], "soil"), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the search server exists only when there are roots, and names its one tool", () => {
  assert.equal(buildSearchTools([]).server, null);
  const built = buildSearchTools([{ label: "x/", dir: os.tmpdir() }]);
  assert.ok(built.server);
  assert.deepEqual(built.toolNames, ["mcp__foldrun_search__search_files"]);
});

const run = (id: string, status: RunRecord["status"], startedAt: string, result: string | null, flow = "publish"): RunRecord => ({
  id,
  flow,
  status,
  startedAt,
  finishedAt: startedAt,
  summary: result?.split("\n")[0] ?? null,
  steps: [{ agent: "writer", instruction: "x", group: 1, optional: false, status: status === "completed" ? "completed" : "failed", events: [], result, costUsd: 0.5 }],
});

test("the history digest is newest-first, finished runs only, minus the run being driven, results trimmed", () => {
  const runs = [
    run("r1", "completed", "2026-09-01T00:00:00Z", "Monday's piece.\n" + "x".repeat(10_000)),
    run("r2", "failed", "2026-09-02T00:00:00Z", null),
    run("r3", "running", "2026-09-03T00:00:00Z", null),
    run("r4", "completed", "2026-09-04T00:00:00Z", "Thursday's piece."),
  ];
  const digest = digestRuns(runs, 30, "r4");
  assert.deepEqual(digest.map((d) => d.id), ["r2", "r1"]);
  assert.equal(digest[1].summary, "Monday's piece.");
  assert.ok(digest[1].steps[0].result!.length < 6_100);
  assert.equal(digest[0].costUsd, 0.5);
  const built = buildHistoryTools(digest);
  assert.deepEqual(built.toolNames, ["mcp__foldrun_history__recall_runs", "mcp__foldrun_history__read_run"]);
});
