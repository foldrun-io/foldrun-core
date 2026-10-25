// When each agent last ran, from the run index.
//
//   node --test tests/agent-last-run.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { agentLastRuns, daysSince } from "../src/agent-activity.ts";
import type { RunSummary } from "../src/store.ts";

const run = (startedAt: string, steps: { agent: string; status: string; startedAt?: string }[]) =>
  ({ id: `r-${startedAt}`, flow: "f", status: "completed", summary: null, startedAt, finishedAt: null, steps }) as unknown as RunSummary;

test("the latest step that ran, per agent; skipped and pending steps are not activity", () => {
  const last = agentLastRuns([
    run("2026-10-01T00:00:00Z", [{ agent: "writer", status: "completed", startedAt: "2026-10-01T00:05:00Z" }, { agent: "editor", status: "skipped" }]),
    run("2026-10-10T00:00:00Z", [{ agent: "writer", status: "failed" }, { agent: "editor", status: "pending" }]),
  ]);
  assert.equal(last.get("writer"), "2026-10-10T00:00:00Z", "a step with no time of its own takes its run's");
  assert.equal(last.has("editor"), false);
  assert.equal(daysSince("2026-10-10T00:00:00Z", Date.parse("2026-10-21T12:00:00Z")), 11);
  assert.equal(daysSince(null), null);
});
