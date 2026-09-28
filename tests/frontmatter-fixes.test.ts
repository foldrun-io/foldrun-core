// Flow-level frontmatter and step targets that used to default silently, and
// an agent-level `schedule:` that fired nothing — all now named at check.
//
//   node --test tests/frontmatter-fixes.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseFlow, listAgents } from "../src/store.ts";
import { lintFlow } from "../src/flow-lint.ts";

const flow = (front: string, body = "1. [[a]] — do it\n") =>
  parseFlow("f.md", `---\nname: f\n${front}\n---\n\n${body}`);
const frontErrors = (front: string, body?: string) => flow(front, body).frontProblems;

test("a flow enum typo is a check error, not a silent default", () => {
  assert.deepEqual(frontErrors("overlap: que"), ["overlap: que — the values are skip, queue."]);
  assert.match(frontErrors("priority: urgent")[0], /priority: urgent — the values are high, normal, low\./);
  assert.match(frontErrors("catchup: all")[0], /catchup: all — the values are none, last\./);
  assert.match(frontErrors("on: done")[0], /on: done — the values are completed, failed, blocked, any\./);
  assert.match(frontErrors("signature: hmac256")[0], /signature: hmac256 — the values are github, stripe, slack, hmac\./);
});

test("the valid values still parse and raise nothing", () => {
  assert.deepEqual(frontErrors("overlap: queue"), []);
  assert.equal(flow("overlap: queue").overlap, "queue");
  assert.equal(flow("on: blocked").on, "blocked");
  assert.equal(flow("priority: high").priority, "high");
});

test("a malformed step target is named, not swallowed as prose", () => {
  const f = flow("", "1. [[My_Agent]] — do it\n");
  assert.equal(f.steps.length, 0, "the line did not become a silent step");
  assert.match(f.frontProblems[0], /\[\[My_Agent\]\].*named in lower case, digits and dashes — not `My_Agent`/);
});

test("a well-formed target is still a step, with no front problem", () => {
  const f = flow("", "1. [[writer]] — do it\n");
  assert.equal(f.steps.length, 1);
  assert.equal(f.steps[0].agent, "writer");
  assert.deepEqual(f.frontProblems, []);
});

test("flow-lint reports frontProblems at error level", () => {
  const errs = lintFlow(flow("overlap: que")).filter((w) => w.level === "error").map((w) => w.message);
  assert.ok(errs.some((m) => m.startsWith("overlap: que")));
});

test("description is read into the flow", () => {
  assert.equal(flow("description: The weekly digest").description, "The weekly digest");
  assert.equal(flow("").description, null);
});

test("schedule on an agent is a problem; on nothing it is not", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-sched-"));
  const prev = process.env.FOLDRUN_DATA;
  process.env.FOLDRUN_DATA = root;
  const write = (rel: string, c: string) => {
    const f = path.join(root, rel);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, c);
  };
  try {
    write("acme/workspaces/desk/AGENTS.md", "---\nname: desk\n---\n");
    write("acme/workspaces/desk/agents/timed/agent.md", "---\nname: timed\nschedule: \"0 9 * * 1\"\n---\nhi\n");
    write("acme/workspaces/desk/agents/plain/agent.md", "---\nname: plain\n---\nhi\n");
    const by = Object.fromEntries(listAgents("acme", "desk").map((a) => [a.name, a]));
    assert.match(by.timed.scheduleProblem ?? "", /only a flow runs on a clock/);
    assert.equal(by.plain.scheduleProblem, null);
  } finally {
    if (prev === undefined) delete process.env.FOLDRUN_DATA;
    else process.env.FOLDRUN_DATA = prev;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
