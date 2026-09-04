// The board's two newest rewrites: pattern templates at creation, and one
// step's options edited surgically.
//
//   node --test tests/flow-edit.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  flowPatternTemplate,
  updateFlowStep,
  updateFlowStepInstruction,
  parseFlow,
  parseWait,
  FLOW_PATTERNS,
} from "../packages/core/src/store.ts";

// ---------------------------------------------------------------- templates

test("every pattern template parses into the shape it advertises", () => {
  for (const pattern of FLOW_PATTERNS) {
    const raw = flowPatternTemplate(pattern, "demo", ["writer", "editor", "extra", "judge"]);
    const flow = parseFlow("demo.md", raw);
    assert.equal(flow.name, "demo", pattern);
    assert.ok(flow.steps.length >= 1, pattern);
  }

  const loop = parseFlow("x.md", flowPatternTemplate("review-loop", "x", ["writer", "editor"]));
  assert.equal(loop.steps[1].loop, 3);
  assert.equal(loop.steps[1].until, "APPROVED");
  assert.equal(loop.steps[1].agent, "editor");

  const fan = parseFlow("x.md", flowPatternTemplate("fan-out", "x", ["a", "b", "c"]));
  assert.equal(fan.steps[1].each, "lines");
  assert.equal(fan.steps[1].max, 10);

  const debate = parseFlow("x.md", flowPatternTemplate("debate", "x", []));
  const groups = debate.steps.map((s) => s.group);
  assert.deepEqual(groups, [1, 2, 2, 3], "two takes in parallel, then the judge");
});

test("templates use the workspace's real agents where they exist", () => {
  const raw = flowPatternTemplate("review-loop", "x", ["notetaker"]);
  assert.match(raw, /\[\[notetaker\]\]/);
  assert.ok(!raw.includes("[[writer]]"), "no placeholder when a real agent exists");
});

// ---------------------------------------------------------------- step edit

const FLOW = `---
name: digest
# a comment that must survive
---

1. [[researcher]] — gather the week
2. [[writer]] — write it up
   retry: 1
   verify: test -s outputs/post.md
`;

test("editing one step touches only that step's managed options", () => {
  const out = updateFlowStep(FLOW, 1, { model: "fast", loop: 2, until: "SHIP IT", retry: null });
  const flow = parseFlow("digest.md", out);
  assert.equal(flow.steps[1].model, "fast");
  assert.equal(flow.steps[1].loop, 2);
  assert.equal(flow.steps[1].until, "SHIP IT");
  assert.equal(flow.steps[1].retry, undefined, "null cleared it");
  assert.equal(flow.steps[1].verify, "test -s outputs/post.md", "unmanaged option survives");
  assert.equal(flow.steps[0].model, undefined, "the other step is untouched");
  assert.match(out, /# a comment that must survive/);
});

test("fan-out options write and clear as a pair", () => {
  const on = updateFlowStep(FLOW, 0, { each: "lines", max: 99 });
  assert.equal(parseFlow("f.md", on).steps[0].each, "lines");
  assert.equal(parseFlow("f.md", on).steps[0].max, 20, "clamped on the way in");

  const off = updateFlowStep(on, 0, { each: null, max: null });
  assert.equal(parseFlow("f.md", off).steps[0].each, undefined);
  assert.equal(parseFlow("f.md", off).steps[0].max, undefined);
});

test("an index off the end refuses rather than writing garbage", () => {
  assert.throws(() => updateFlowStep(FLOW, 9, { model: "fast" }), /no step 9/);
});


// ------------------------------------------------------- step instructions

test("editing an instruction keeps the number, the marker and the link", () => {
  const marked = `---\nname: digest\n---\n\n1? [[researcher]] — gather the week\n2! [[writer]] — write it up\n   retry: 1\n`;
  const out = updateFlowStepInstruction(marked, 0, "gather the month instead");
  const flow = parseFlow("digest.md", out);
  assert.equal(flow.steps[0].instruction, "gather the month instead");
  assert.equal(flow.steps[0].optional, true, "the ? marker survived");
  assert.equal(flow.steps[0].agent, "researcher");
  assert.equal(flow.steps[1].approve, true, "the other step's ! marker survived");
  assert.equal(flow.steps[1].instruction, "write it up", "the other step is untouched");
  assert.equal(flow.steps[1].retry, 1, "its options survived");
});

test("a multi-line instruction is flattened — one step is one line", () => {
  const out = updateFlowStepInstruction(FLOW, 0, "  gather the week\n  then summarise it  ");
  assert.equal(parseFlow("d.md", out).steps[0].instruction, "gather the week then summarise it");
  assert.equal(out.split("\n").filter((l) => l.startsWith("1.")).length, 1);
});

test("clearing an instruction leaves a step that still parses", () => {
  const out = updateFlowStepInstruction(FLOW, 1, "");
  const flow = parseFlow("d.md", out);
  assert.equal(flow.steps.length, 2);
  assert.equal(flow.steps[1].instruction, "");
  assert.equal(flow.steps[1].agent, "writer");
  assert.equal(flow.steps[1].verify, "test -s outputs/post.md", "options survived");
});

test("parallel groups survive an instruction edit", () => {
  const parallel = `---\nname: p\n---\n\n1. [[a]] — one\n2. [[b]] — two\n2. [[c]] — three\n`;
  const out = updateFlowStepInstruction(parallel, 1, "two, revised");
  const groups = parseFlow("p.md", out).steps.map((s) => s.group);
  assert.deepEqual(groups, [1, 2, 2], "b and c still run in parallel");
  assert.equal(parseFlow("p.md", out).steps[2].instruction, "three");
});

test("an index off the end refuses rather than writing garbage", () => {
  assert.throws(() => updateFlowStepInstruction(FLOW, 9, "nope"), /no step 9/);
});

// ------------------------------------------------- the five newest options

test("on-fail, wait, each: rows, ask and delegate all parse", () => {
  const raw = `---
name: pipeline
---

1. [[scraper]] — fetch the pages
   retry: 1
   on-fail: fallback-scraper
2. [[emailer]] — send the follow-up
   wait: 3d
3. [[enricher]] — enrich each lead
   each: rows of ../../storage/leads.csv
   max: 15
4. [[writer]] — draft the subject line
   ask: Which tone — formal or friendly?
5. [[coordinator]] — decide who finishes this
   delegate: enricher, emailer, writer
`;
  const flow = parseFlow("pipeline.md", raw);
  assert.equal(flow.steps[0].onFail, "fallback-scraper");
  assert.equal(flow.steps[1].waitSecs, 3 * 86400);
  assert.equal(flow.steps[2].each, "rows");
  assert.equal(flow.steps[2].eachPath, "../../storage/leads.csv");
  assert.equal(flow.steps[2].max, 15);
  assert.equal(flow.steps[3].ask, "Which tone — formal or friendly?");
  assert.deepEqual(flow.steps[4].delegate, ["enricher", "emailer", "writer"]);
});

test("wait: understands units, clamps at 30 days, refuses nonsense", () => {
  assert.equal(parseWait("90"), 90);
  assert.equal(parseWait("90s"), 90);
  assert.equal(parseWait("30m"), 1800);
  assert.equal(parseWait("4h"), 14400);
  assert.equal(parseWait("3d"), 259200);
  assert.equal(parseWait("365d"), 30 * 86400, "clamped");
  assert.equal(parseWait("soon"), undefined);
  assert.equal(parseWait("0"), undefined);
});

test("a delegate list strips wikilink brackets and caps at five", () => {
  const raw = "---\nname: d\n---\n\n1. [[boss]] — choose\n   delegate: [[a]], b, [[c]], d, e, f, g\n";
  assert.deepEqual(parseFlow("d.md", raw).steps[0].delegate, ["a", "b", "c", "d", "e"]);
});
