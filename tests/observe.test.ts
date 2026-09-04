// The observability report, and the honesty rules it must not lose:
// percentiles only over enough samples, latency only where it was measured,
// counts a reader can check against the run they came from.
//
//   node --test tests/observe.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { observeWorkspace, parseToolLog, sampled } from "../packages/core/src/observe.ts";

function withRuns(runs: object[], run: (tenant: string, ws: string) => void) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-observe-"));
  const prev = process.env.FOLDRUN_DATA;
  process.env.FOLDRUN_DATA = root;
  try {
    const dir = path.join(root, "acme/workspaces/desk/runs");
    fs.mkdirSync(dir, { recursive: true });
    runs.forEach((r, i) => fs.writeFileSync(path.join(dir, `run-${i}.json`), JSON.stringify(r)));
    run("acme", "desk");
  } finally {
    if (prev === undefined) delete process.env.FOLDRUN_DATA;
    else process.env.FOLDRUN_DATA = prev;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const NOW = new Date("2026-08-30T12:00:00Z");
const at = (daysAgo: number, extraMs = 0) =>
  new Date(NOW.getTime() - daysAgo * 86_400_000 + extraMs).toISOString();

const step = (agent: string, over: object = {}) => ({
  agent,
  instruction: "work",
  group: 1,
  optional: false,
  status: "completed",
  attempts: 1,
  costUsd: 0.01,
  tokens: { input: 100, output: 20 },
  computeSecs: 3,
  events: [],
  result: "done",
  ...over,
});

const run = (id: string, daysAgo: number, steps: object[], over: object = {}) => ({
  id,
  flow: "publish",
  status: "completed",
  startedAt: at(daysAgo),
  finishedAt: at(daysAgo, 20_000),
  steps,
  ...over,
});

// --------------------------------------------------------------- sampling

test("a percentile over a handful of runs is not reported as one", () => {
  const few = sampled([1, 2, 3]);
  assert.equal(few.n, 3);
  assert.equal(few.p50, null, "three samples do not make a median worth printing");
  assert.equal(few.max, 3, "the worst one is still a fact");

  const enough = sampled([1, 2, 3, 4, 100]);
  assert.equal(enough.n, 5);
  assert.equal(enough.p50, 3);
  assert.equal(enough.max, 100);
});

// ---------------------------------------------------------- tool log lines

test("script and API outcome lines parse; prose does not", () => {
  assert.deepEqual(parseToolLog("script: ads_summary(customer_id=123) → exit 0 (412ms, sandbox)"), {
    kind: "script",
    name: "ads_summary",
    ok: true,
    ms: 412,
  });
  assert.deepEqual(parseToolLog("script: wordcount() → exit 1 (90ms, docker)"), {
    kind: "script",
    name: "wordcount",
    ok: false,
    ms: 90,
  });
  assert.deepEqual(parseToolLog("api: GET /v18/customers?… → 200 (91ms)"), {
    kind: "api",
    name: "GET /v18/customers?…",
    ok: true,
    ms: 91,
  });
  assert.equal(parseToolLog("api: POST /emails → 401 (55ms)")!.ok, false);
  assert.equal(parseToolLog("secret GSC_IMPERSONATE ← workspace scope"), null);
  assert.equal(parseToolLog("isolation: k8s"), null);
});

// ------------------------------------------------------------- the report

test("agents roll up: failures, retries, skips, cost — and failures carry their own words", () =>
  withRuns(
    [
      run("r1", 1, [
        step("writer"),
        step("writer", { attempts: 3 }),
        step("checker", {
          status: "failed",
          attempts: 2,
          events: [{ t: at(1, 9000), type: "error", text: "verify: exit 1 — count was 3" }],
        }),
      ]),
      run("r2", 2, [step("writer"), step("checker", { status: "skipped", skipReason: "when: no BUG marker" })], {
        status: "failed",
      }),
    ],
    (tenant, ws) => {
      const o = observeWorkspace(tenant, ws, 30, NOW);
      assert.equal(o.runs, 2);
      assert.equal(o.failedRuns, 1);
      assert.equal(o.steps, 5);

      const writer = o.agents.find((a) => a.agent === "writer")!;
      assert.equal(writer.steps, 3);
      assert.equal(writer.retried, 1, "attempts > 1 is a retry");
      assert.equal(writer.failed, 0);

      const checker = o.agents.find((a) => a.agent === "checker")!;
      assert.equal(checker.failed, 1);
      assert.equal(checker.skipped, 1);

      // The failure list quotes the step's own error, newest first.
      assert.equal(o.failures.length, 1);
      assert.equal(o.failures[0].agent, "checker");
      assert.match(o.failures[0].text, /verify: exit 1/);
      assert.equal(o.failures[0].attempts, 2);
    },
  ));

test("tool latency is reported only where the tool measured it", () =>
  withRuns(
    [
      run("r1", 1, [
        step("writer", {
          events: [
            // A built-in: counted, never timed — the gap to the next event
            // includes the model thinking, and is not this tool's latency.
            { t: at(1, 1000), type: "tool", text: "Read" },
            // A script tool: the tool event counts it, its own log line times it.
            { t: at(1, 2000), type: "tool", text: "mcp__foldrun_scripts__wordcount" },
            { t: at(1, 3000), type: "info", text: "script: wordcount(text=hi) → exit 0 (52ms, sandbox)" },
            { t: at(1, 4000), type: "tool", text: "mcp__foldrun_scripts__wordcount" },
            { t: at(1, 5000), type: "info", text: "script: wordcount(text=ho) → exit 1 (61ms, sandbox)" },
          ],
        }),
      ]),
    ],
    (tenant, ws) => {
      const o = observeWorkspace(tenant, ws, 30, NOW);

      const read = o.tools.find((t) => t.name === "Read")!;
      assert.equal(read.calls, 1);
      assert.equal(read.measured, 0, "built-ins have no measured duration");
      assert.equal(read.ms.max, null);

      const wc = o.tools.find((t) => t.name === "wordcount")!;
      assert.equal(wc.calls, 2, "counted by tool events, not double-counted from log lines");
      assert.equal(wc.measured, 2);
      assert.equal(wc.errors, 1, "exit 1 is an error");
      assert.equal(wc.ms.max, 61);
      assert.deepEqual(wc.agents, ["writer"], "blast radius: who calls it");
    },
  ));

test("the window is a window: older runs do not leak in", () =>
  withRuns(
    [run("recent", 2, [step("writer")]), run("ancient", 40, [step("writer"), step("writer")])],
    (tenant, ws) => {
      const o = observeWorkspace(tenant, ws, 30, NOW);
      assert.equal(o.runs, 1);
      assert.equal(o.steps, 1);
      const wide = observeWorkspace(tenant, ws, 90, NOW);
      assert.equal(wide.runs, 2);
      assert.equal(wide.steps, 3);
    },
  ));

test("a workspace with no runs reports zeros, not an error", () =>
  withRuns([], (tenant, ws) => {
    const o = observeWorkspace(tenant, ws, 30, NOW);
    assert.equal(o.runs, 0);
    assert.deepEqual(o.agents, []);
    assert.deepEqual(o.failures, []);
  }));

test("an API tool's untimed error lines still count as calls", () =>
  withRuns(
    [
      run("r1", 1, [
        step("emailer", {
          events: [
            // Found on a real box: two error lines and no timed success made
            // the report say calls=1, errors=2 — errors exceeding calls.
            { t: at(1, 1000), type: "info", text: "api: POST /emails → error: fetch failed" },
            { t: at(1, 2000), type: "info", text: "api: POST /emails → error: fetch failed" },
            { t: at(1, 3000), type: "info", text: "api: POST /emails → 200 (140ms)" },
          ],
        }),
      ]),
    ],
    (tenant, ws) => {
      const o = observeWorkspace(tenant, ws, 30, NOW);
      const t = o.tools.find((x) => x.name === "POST /emails")!;
      assert.equal(t.calls, 3, "every log line is a call — an API tool has no other record");
      assert.equal(t.errors, 2);
      assert.equal(t.measured, 1);
      assert.ok(t.errors <= t.calls, "errors can never exceed calls");
    },
  ));
