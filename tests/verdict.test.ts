import test from "node:test";
import assert from "node:assert/strict";
import { verdictOf, runVerdict } from "../src/store.ts";
import { endingOf } from "../src/triggers.ts";
import type { RunRecord } from "../src/store.ts";

test("a verdict is the word a summary leads with, whole and upper-case", () => {
  assert.equal(verdictOf("GOOD — applied 6 links across 6 files, commit 123ba33a"), "GOOD");
  assert.equal(verdictOf("BLOCKED — Applied the entire raw proposal set (78 links)"), "BLOCKED");
  assert.equal(verdictOf("**BLOCKED**: nothing pushed"), "BLOCKED");
  assert.equal(verdictOf("## QUIET: nothing changed this week"), "QUIET");
  assert.equal(verdictOf("BAD: 3 pages dropped"), "BAD");
});

test("a word merely present, a longer word, or lower case is no verdict", () => {
  assert.equal(verdictOf("There are no BLOCKED items this week"), null);
  assert.equal(verdictOf("BLOCKEDBY upstream"), null);
  assert.equal(verdictOf("Good news: 4 leads"), null);
  assert.equal(verdictOf("GOODS received"), null);
  assert.equal(verdictOf(null), null);
});

test("a run's verdict: the recorded one, else read from an old run's summary", () => {
  assert.equal(runVerdict({ verdict: "GOOD", summary: "BLOCKED — x" }), "GOOD");
  assert.equal(runVerdict({ summary: "BLOCKED — x" }), "BLOCKED");
  assert.equal(runVerdict({ verdict: null, summary: "BLOCKED — x" }), null);
});

const run = (over: Partial<RunRecord>): RunRecord =>
  ({ id: "r", flow: "f", status: "completed", startedAt: "", finishedAt: "", steps: [], ...over }) as RunRecord;

test("which on: a settled run answers: a BLOCKED completion is blocked, not completed", () => {
  assert.equal(endingOf(run({ summary: "GOOD — 6 links" })), "completed");
  assert.equal(endingOf(run({ summary: "just a line" })), "completed");
  assert.equal(endingOf(run({ summary: "BLOCKED — nothing pushed" })), "blocked");
  assert.equal(endingOf(run({ status: "failed", summary: "BLOCKED — x" })), "failed");
});
