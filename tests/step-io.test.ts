// The run page's In/Out columns read the record the way the runner feeds a
// step: the nearest earlier group's results, the nearest earlier group's
// JSON, the answer's first line as the headline. Pinned here, against the
// record alone, so a change to what a step is handed shows up as a failing
// rule rather than a panel that quietly lies.

import test from "node:test";
import assert from "node:assert/strict";
import { stepInputs, stepOutputs, headlineOf, fmtTokens, fmtBytes } from "../web/components/step-io-model.ts";
import type { StepRecord } from "../packages/core/src/store.ts";

const step = (over: Partial<StepRecord>): StepRecord => ({
  agent: "writer",
  instruction: "",
  group: 1,
  optional: false,
  status: "completed",
  events: [],
  result: null,
  costUsd: null,
  ...over,
});

test("the first group receives nothing", () => {
  const io = stepInputs([step({ agent: "a", group: 1, result: "x" }), step({ agent: "b", group: 2 })], 0);
  assert.equal(io.first, true);
  assert.equal(io.results, null);
  assert.equal(io.data, null);
});

test("results come from the nearest earlier group that produced any", () => {
  const steps = [
    step({ agent: "a", group: 1, result: "one" }),
    step({ agent: "b", group: 2, status: "skipped", result: null }),
    step({ agent: "c", group: 3 }),
  ];
  const io = stepInputs(steps, 2);
  assert.equal(io.first, false);
  // Group 2 said nothing, so group 1 is what rode in.
  assert.deepEqual(io.results, { group: 1, from: [{ index: 0, agent: "a" }] });
});

test("a parallel group lists every member that answered, with its item", () => {
  const steps = [
    step({ agent: "a", group: 1, result: "one", item: "sydney" }),
    step({ agent: "a", group: 1, result: "two", item: "perth" }),
    step({ agent: "a", group: 1, status: "failed", result: null, item: "hobart" }),
    step({ agent: "b", group: 2 }),
  ];
  assert.deepEqual(stepInputs(steps, 3).results, {
    group: 1,
    from: [{ index: 0, agent: "a", item: "sydney" }, { index: 1, agent: "a", item: "perth" }],
  });
});

test("data comes from the nearest earlier json group, which may differ from the results group", () => {
  const steps = [
    step({ agent: "extract", group: 1, result: "found 3", data: [1, 2, 3], output: "json" }),
    step({ agent: "write", group: 2, result: "wrote it" }),
    step({ agent: "publish", group: 3 }),
  ];
  const io = stepInputs(steps, 2);
  assert.equal(io.results?.group, 2);
  assert.deepEqual(io.data, { group: 1, from: [{ index: 0, agent: "extract" }] });
});

test("the gate's answer, the event payload and a carried origin are surfaced", () => {
  const s = step({ ask: "which list?", approvalNote: "the warm one", eventPayload: '{"id":7}', carriedFrom: "run_abc" });
  const io = stepInputs([s], 0);
  assert.equal(io.ask, "which list?");
  assert.equal(io.note, "the warm one");
  assert.equal(io.event, '{"id":7}');
  assert.equal(io.carriedFrom, "run_abc");
});

test("a step is fed by its own group's position, not its index", () => {
  // Steps of one group in the array out of order still read the group before them.
  const steps = [
    step({ agent: "late", group: 2 }),
    step({ agent: "early", group: 1, result: "first" }),
  ];
  assert.equal(stepInputs(steps, 0).results?.group, 1);
});

test("the headline is the first line, without markdown furniture", () => {
  assert.equal(headlineOf("\n\n## **Done:** 12 leads verified\nmore"), "Done: 12 leads verified");
  assert.equal(headlineOf("- first bullet\n- second"), "first bullet");
  assert.equal(headlineOf("   "), null);
  assert.equal(headlineOf("x".repeat(300))?.length, 240);
});

test("the conclusion wins over the result, and the answer is shown only when it says more", () => {
  const short = stepOutputs(step({ result: "Now let me read…\n\nDone.", conclusion: "Done." }));
  assert.equal(short.headline, "Done.");
  assert.equal(short.answer, null);
  const long = stepOutputs(step({ conclusion: "Verified 89 of 100.\n\nThe rest bounced; see dead-ends.md for the list." }));
  assert.equal(long.headline, "Verified 89 of 100.");
  assert.ok(long.answer?.includes("dead-ends"));
});

test("a failed step's error is its last error event; a completed step has none", () => {
  const failed = stepOutputs(
    step({ status: "failed", events: [{ t: "", type: "error", text: "first" }, { t: "", type: "error", text: "timeout" }] }),
  );
  assert.equal(failed.error, "timeout");
  const ok = stepOutputs(step({ events: [{ t: "", type: "error", text: "retried" }] }));
  assert.equal(ok.error, null);
});

test("json data rides through untouched", () => {
  assert.deepEqual(stepOutputs(step({ data: { a: 1 } })).data, { a: 1 });
  assert.equal(stepOutputs(step({})).data, undefined);
});

test("counts read at a glance", () => {
  assert.equal(fmtTokens(950), "950");
  assert.equal(fmtTokens(1200), "1.2k");
  assert.equal(fmtTokens(120_000), "120k");
  assert.equal(fmtTokens(2_500_000), "2.5M");
  assert.equal(fmtBytes(512), "512 B");
  assert.equal(fmtBytes(2048), "2.0 KB");
  assert.equal(fmtBytes(3 * 1024 * 1024), "3.0 MB");
});

test("a record without a stored conclusion reads its last text event, not its opening line", () => {
  const out = stepOutputs(
    step({
      result: "I'll check the outputs first.\n\nVerified 12 of 12.",
      events: [
        { t: "", type: "text", text: "I'll check the outputs first." },
        { t: "", type: "tool", text: "Read" },
        { t: "", type: "text", text: "Verified 12 of 12." },
      ],
    }),
  );
  assert.equal(out.headline, "Verified 12 of 12.");
  // No events at all: the joined result is all there is.
  assert.equal(stepOutputs(step({ result: "Plan first.\nThen do." })).headline, "Plan first.");
});
