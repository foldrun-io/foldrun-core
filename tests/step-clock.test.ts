// The in-process step ends at its timeout and on a stop — on a clock, not
// only when a message happens to arrive.
//
// The deadline used to be checked at the top of the message loop, so a step
// waiting on one long tool call (a crawl, a build) sailed past `timeout:`
// with nothing to check it against; and a stop was read between groups and
// between attempts, never mid-step. Both now interrupt the model loop.
//
//   node --test tests/step-clock.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { executeStep, type ExecOptions, type QueryFn } from "../src/step-exec.ts";

/** A model loop that emits one text turn and then hangs — a tool call that
 *  never returns — until it is interrupted or aborted. */
function hangingQuery(): { query: QueryFn; interrupted: () => number; aborted: () => boolean } {
  let interrupts = 0;
  let abortedFlag = false;
  const query: QueryFn = ({ options }) => {
    const ac = options.abortController as AbortController;
    let release: (() => void) | null = null;
    const stream = (async function* () {
      yield { type: "assistant", message: { usage: { input_tokens: 10, output_tokens: 5 }, content: [{ type: "text", text: "Starting the crawl." }] } };
      await new Promise<void>((resolve) => {
        release = resolve;
        ac.signal.addEventListener("abort", () => {
          abortedFlag = true;
          resolve();
        });
      });
      // An interrupted SDK stream ends with an error result, not a success.
      yield { type: "result", subtype: "error_during_execution" };
    })();
    return Object.assign(stream, {
      async interrupt() {
        interrupts += 1;
        release?.();
      },
    });
  };
  return { query, interrupted: () => interrupts, aborted: () => abortedFlag };
}

function opts(agentDir: string, extra: Partial<ExecOptions>, events: string[]): ExecOptions {
  return {
    agentDir,
    workspaceRoot: path.dirname(path.dirname(agentDir)),
    libraryRoot: path.join(agentDir, "..", "..", "library"),
    prompt: "work",
    model: "haiku",
    systemPrompt: "you work",
    allowed: [],
    mcpNames: [],
    mcpServers: {},
    env: {},
    emit: (type, text) => events.push(`${type}: ${text}`),
    ...extra,
  };
}

function withAgent(body: (agentDir: string) => Promise<void>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-clock-"));
  const agentDir = path.join(root, "agents", "worker");
  fs.mkdirSync(agentDir, { recursive: true });
  return body(agentDir).finally(() => fs.rmSync(root, { recursive: true, force: true }));
}

test("a step hanging in a tool call is ended at its timeout, and says so", () =>
  withAgent(async (agentDir) => {
    const events: string[] = [];
    const fake = hangingQuery();
    const started = Date.now();
    const out = await executeStep(opts(agentDir, { timeoutSec: 1 }, events), fake.query);
    assert.equal(out.status, "failed");
    assert.ok(Date.now() - started < 5000, "ended on the clock, not at the grace period");
    assert.equal(fake.interrupted(), 1, "the loop was asked to stop");
    assert.ok(events.some((e) => /^error: timed out after 1s/.test(e)), `an event names the timeout: ${events.join(" | ")}`);
    assert.equal(out.result, "Starting the crawl.", "what it wrote before the cut is kept");
  }));

test("a stop written by a person lands mid-step", () =>
  withAgent(async (agentDir) => {
    const events: string[] = [];
    const fake = hangingQuery();
    let stop = false;
    setTimeout(() => (stop = true), 300);
    const started = Date.now();
    const out = await executeStep(opts(agentDir, { stopRequested: () => stop }, events), fake.query);
    assert.equal(out.status, "failed");
    assert.ok(Date.now() - started < 6000, `the stop was read on the poll, not at the next group (${Date.now() - started}ms)`);
    assert.equal(fake.interrupted(), 1);
    assert.ok(events.some((e) => e === "error: stopped by a person mid-step"), events.join(" | "));
  }));

test("a step that finishes on its own is untouched by either clock", () =>
  withAgent(async (agentDir) => {
    const events: string[] = [];
    const query: QueryFn = () => {
      const stream = (async function* () {
        yield { type: "assistant", message: { usage: { input_tokens: 1, output_tokens: 1 }, content: [{ type: "text", text: "done" }] } };
        yield { type: "result", subtype: "success", total_cost_usd: 0.001, usage: { input_tokens: 1, output_tokens: 1 } };
      })();
      return Object.assign(stream, { interrupt: async () => assert.fail("nothing to interrupt") });
    };
    const out = await executeStep(opts(agentDir, { timeoutSec: 60, stopRequested: () => false }, events), query);
    assert.equal(out.status, "completed");
    assert.equal(out.conclusion, "done");
    assert.equal(out.costUsd, 0.001);
  }));
