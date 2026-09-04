// Which skills a run actually loads.
//
// `when:` is the whole reason an agent can own 119 skills without paying for
// 119 of them on every run. But the run's tags were assembled by startFlowRun,
// stored on the run record, passed down to runStep — and then dropped one call
// short of the filter, which defaulted them to []. A skill with `when:` matches
// nothing against [], so declaring one made it permanently invisible rather
// than conditionally loaded, and silently: the skill was simply counted as
// withheld on every run. These tests are the guard on that last hop.
//
//   node --test tests/skill-tags.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { applicableSkills } from "../packages/core/src/runner.ts";

const skill = (name: string, when: string[] = []) => ({ name, when });

const ALWAYS = skill("house-style");
const ON_RELEASE = skill("changelog", ["release"]);
const ON_EITHER = skill("triage", ["release", "incident"]);

const names = (s: { name: string }[]) => s.map((x) => x.name);

test("a skill with no `when:` loads on a run that carries no tags", () => {
  assert.deepEqual(names(applicableSkills([ALWAYS], [], [])), ["house-style"]);
});

test("a skill with `when:` is withheld from an untagged run", () => {
  assert.deepEqual(names(applicableSkills([ALWAYS, ON_RELEASE], [], [])), ["house-style"]);
});

// The regression itself. Before the fix this returned ["house-style"] for
// every run, no matter what the flow was tagged with.
test("a matching tag loads the skill it gates", () => {
  assert.deepEqual(names(applicableSkills([ALWAYS, ON_RELEASE], [], ["release"])), [
    "house-style",
    "changelog",
  ]);
});

test("a non-matching tag is not a match for a different one", () => {
  assert.deepEqual(names(applicableSkills([ON_RELEASE], [], ["incident"])), []);
});

test("any one of a skill's tags is enough", () => {
  assert.deepEqual(names(applicableSkills([ON_EITHER], [], ["incident"])), ["triage"]);
  assert.deepEqual(names(applicableSkills([ON_EITHER], [], ["release"])), ["triage"]);
});

test("extra tags on the run are harmless", () => {
  assert.deepEqual(names(applicableSkills([ON_RELEASE], [], ["release", "nightly"])), [
    "changelog",
  ]);
});

test("an absent `skills:` allowlist admits everything in scope", () => {
  assert.deepEqual(names(applicableSkills([ALWAYS, ON_RELEASE], [], ["release"])), [
    "house-style",
    "changelog",
  ]);
});

test("`skills:` is an allowlist, and excludes what it does not name", () => {
  assert.deepEqual(names(applicableSkills([ALWAYS, ON_RELEASE], ["house-style"], ["release"])), [
    "house-style",
  ]);
});

// The two gates are independent, and both have to pass. Being named in
// `skills:` is not a way around `when:` — otherwise an allowlisted skill would
// load on runs it was explicitly scoped away from.
test("being allowlisted does not exempt a skill from its own `when:`", () => {
  assert.deepEqual(names(applicableSkills([ON_RELEASE], ["changelog"], [])), []);
  assert.deepEqual(names(applicableSkills([ON_RELEASE], ["changelog"], ["release"])), [
    "changelog",
  ]);
});

// Everything above passes against the broken runtime too: the filter was
// always right, and the defect was one caller handing it nothing to filter on.
// So the guard that matters is on the wiring, not the rule — the run's tags
// have to survive every hop between startFlowRun and the filter.
test("every hop from the run record to the filter carries the tags", () => {
  const src = fs.readFileSync(
    path.join(import.meta.dirname, "..", "packages/core/src/runner.ts"),
    "utf8",
  );

  const calls = [...src.matchAll(/\bagentContext\(([^)]*)\)/g)]
    .map((m) => m[1])
    .filter((args) => !args.includes("agentDir: string")); // the declaration
  assert.ok(calls.length > 0, "expected agentContext to be called somewhere");
  for (const args of calls) {
    // The third argument is the tags. Position, not arity: the call grew a
    // fourth argument (the run's identity for script provenance), and a
    // count check would forbid every future one while missing a call that
    // kept the count but dropped the tags.
    assert.equal(
      args.split(",")[2]?.trim(),
      "tags",
      `agentContext(${args}) drops the run's tags — a \`when:\` skill can then never load`,
    );
  }

  const runStepCalls = [...src.matchAll(/await runStep\(([\s\S]*?)\);/g)].map((m) => m[1]);
  assert.ok(runStepCalls.length > 0, "expected runStep to be called somewhere");
  for (const args of runStepCalls) {
    assert.match(args, /\btags\b/, "runStep is called without the run's tags");
  }
});
