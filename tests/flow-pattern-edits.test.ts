// Orchestration patterns as markdown edits (src/flow-patterns.ts). Every
// block the flow canvas offers, and every change to an agent's team, is
// applied and then round-tripped through the parser: the parse must say
// exactly what the pattern promised, and nothing else in the file may move —
// the prose, the comments, the other steps.
//
//   node --test tests/flow-pattern-edits.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import matter from "gray-matter";
import { parseFlow, AGENT_TEMPLATE } from "../src/store.ts";
import {
  applyPatternEdit,
  setStepOptions,
  setStepApprove,
  flowGroups,
  frontmatterList,
  editFrontmatterList,
  setFrontmatterScalar,
  newAgentFile,
  yamlScalar,
} from "../src/flow-patterns.ts";

const FLOW = `---
name: desk
trigger: schedule
schedule: "0 9 * * 1"   # Monday
---

Prose above the steps stays.

1. [[triage]] — sort the inbox
2. [[bugs]] — fix it
   case: BUG
2. [[docs]] — write it up
   case: DOCS
2. [[general]] — handle the rest
   else: true
3. [[writer]] — draft the digest
4. [[reviewer]] — review it
   loop: 3
   until: APPROVED
5. [[publisher]] — one post per line
   each: lines
   max: 5
   on-fail: [[fixer]]
6!. [[sender]] — send it
   ask: Which list?

Notes below the last step are prose.
`;

const parse = (raw: string) => parseFlow("desk.md", raw);

/** Everything outside the steps, byte for byte. */
const frame = (raw: string) => {
  const lines = raw.split("\n");
  return [lines.slice(0, 8).join("\n"), raw.slice(raw.indexOf("Notes below"))];
};

// ---------- palette blocks → markdown ----------

const onlyStep = (raw: string, agentName: string) => parse(raw).steps.find((s) => s.agent === agentName)!;

test("Chain: a new step in its own group at the drop column", () => {
  const out = applyPatternEdit(FLOW, { op: "insert", target: "editor", instruction: "tighten it", at: { rail: 4 } });
  const s = parse(out).steps;
  assert.deepEqual(flowGroups(s).map((g) => g.map((i) => s[i].agent)), [
    ["triage"], ["bugs", "docs", "general"], ["writer"], ["reviewer"], ["editor"], ["publisher"], ["sender"],
  ]);
  assert.equal(onlyStep(out, "editor").instruction, "tighten it");
  assert.deepEqual(frame(out), frame(FLOW));
});

test("Parallel: a new step joins an existing group", () => {
  const out = applyPatternEdit(FLOW, { op: "insert", target: "editor", at: { column: 2 } });
  const s = parse(out).steps;
  assert.equal(onlyStep(out, "editor").group, onlyStep(out, "writer").group);
  assert.equal(flowGroups(s).length, 6);
});

test("Run another flow: [[flow:x]] as a step", () => {
  const out = applyPatternEdit(FLOW, { op: "insert", target: "digest", subflow: true, at: { rail: 6 } });
  assert.match(out, /^7\. \[\[flow:digest\]\]$/m);
  assert.equal(parse(out).steps.at(-1)!.subflow, "digest");
});

test("Router: a triage step then one group of case:/else: branches", () => {
  const out = applyPatternEdit("1. [[writer]]\n", {
    op: "router",
    router: "triage",
    instruction: "reply BUG or DOCS",
    rail: 1,
    cases: [{ value: "BUG", target: "bugs" }, { value: "DOCS", target: "docs" }],
    else: "general",
  });
  assert.equal(out, "1. [[writer]]\n2. [[triage]] — reply BUG or DOCS\n3. [[bugs]]\n   case: BUG\n3. [[docs]]\n   case: DOCS\n3. [[general]]\n   else: true\n");
  const s = parse(out).steps;
  assert.deepEqual(s.map((x) => [x.agent, x.group, x.case ?? (x.else ? "else" : "")]), [
    ["writer", 1, ""], ["triage", 2, ""], ["bugs", 3, "BUG"], ["docs", 3, "DOCS"], ["general", 3, "else"],
  ]);
  assert.throws(() => applyPatternEdit("1. [[a]]\n", { op: "router", router: "t", rail: 1, cases: [] }), /at least one case/);
});

test("Fan-out: each: lines | items | rows of <path>, with max", () => {
  for (const each of ["lines", "items", "rows of ../../storage/leads.csv"]) {
    const out = applyPatternEdit(FLOW, { op: "options", step: 4, set: { each, max: "8" } });
    const s = onlyStep(out, "writer");
    assert.equal(s.each, each.split(" ")[0]);
    assert.equal(s.max, 8);
    assert.equal(s.problems, undefined);
    assert.match(out, new RegExp(`3\\. \\[\\[writer\\]\\] — draft the digest\\n   each: ${each.replace(/[./]/g, "\\$&")}\\n   max: 8\\n4\\.`));
  }
  assert.throws(() => applyPatternEdit(FLOW, { op: "options", step: 4, set: { each: "columns" } }), /lines, items, or rows/);
});

test("Evaluator loop: loop + until + verify: judge:, existing lines rewritten in place", () => {
  const out = applyPatternEdit(FLOW, { op: "options", step: 5, set: { loop: "2", until: "SHIP IT", verify: "judge: cites every source" } });
  const s = onlyStep(out, "reviewer");
  assert.equal(s.loop, 2);
  assert.equal(s.until, "SHIP IT");
  assert.equal(s.verify, "judge: cites every source");
  assert.match(out, /4\. \[\[reviewer\]\] — review it\n   loop: 2\n   until: SHIP IT\n   verify: judge: cites every source\n/);
  assert.throws(() => applyPatternEdit(FLOW, { op: "options", step: 5, set: { loop: "9" } }), /1 to 5/);
});

test("Approval gate: ! on, off, and approve: true for an optional step", () => {
  const on = applyPatternEdit(FLOW, { op: "approve", step: 4, on: true });
  assert.match(on, /^3!\. \[\[writer\]\] — draft the digest$/m);
  assert.equal(onlyStep(on, "writer").approve, true);
  const off = applyPatternEdit(on, { op: "approve", step: 4, on: false });
  assert.equal(off, FLOW);
  const optional = "1?. [[a]] — x\n";
  const gated = setStepApprove(optional, 0, true);
  assert.equal(gated, "1?. [[a]] — x\n   approve: true\n");
  assert.equal(parse(gated).steps[0].approve, true);
  assert.equal(parse(gated).steps[0].optional, true);
  assert.equal(setStepApprove(gated, 0, false), optional);
  const was = applyPatternEdit(FLOW, { op: "approve", step: 7, on: false });
  assert.match(was, /^6\. \[\[sender\]\] — send it$/m);
});

test("Ask a person before: ask: <question>, and cleared with null", () => {
  const out = applyPatternEdit(FLOW, { op: "options", step: 0, set: { ask: "Which inbox?" } });
  assert.equal(onlyStep(out, "triage").ask, "Which inbox?");
  assert.equal(applyPatternEdit(out, { op: "options", step: 0, set: { ask: null } }), FLOW);
});

test("Wait: wait: 30m and wait: event; a bad duration is refused", () => {
  const a = applyPatternEdit(FLOW, { op: "options", step: 4, set: { wait: "30m" } });
  assert.equal(onlyStep(a, "writer").waitSecs, 1800);
  const b = applyPatternEdit(a, { op: "options", step: 4, set: { wait: "event" } });
  assert.equal(onlyStep(b, "writer").waitFor, "event");
  assert.equal(onlyStep(b, "writer").waitSecs, undefined);
  assert.equal((b.match(/wait:/g) ?? []).length, 1, "rewritten in place, not added twice");
  assert.throws(() => applyPatternEdit(FLOW, { op: "options", step: 4, set: { wait: "soon" } }), /duration/);
});

test("Rescue: on-fail: [[agent]], replacing an existing one", () => {
  const out = applyPatternEdit(FLOW, { op: "options", step: 6, set: { "on-fail": "editor" } });
  assert.equal(onlyStep(out, "publisher").onFail, "editor");
  assert.match(out, /   on-fail: \[\[editor\]\]\n/);
  assert.equal((out.match(/on-fail/g) ?? []).length, 1);
  assert.throws(() => setStepOptions(FLOW, 6, { "on-fail": "Bad Name" }));
});

test("options land under the step, never after the prose below the last step", () => {
  const out = applyPatternEdit(FLOW, { op: "options", step: 7, set: { wait: "4h" } });
  assert.match(out, /   ask: Which list\?\n   wait: 4h\n\nNotes below/);
  assert.deepEqual(frame(out), frame(FLOW));
});

// ---------- dock actions → agent frontmatter ----------

const AGENT_MD = `---
name: lead   # the orchestrator
description: Runs the desk.
model: max
tools: [read, write]  # keep narrow
agents:
  - editor   # house style
subagents: [researcher]
---

# lead

Prose, with a colon: and a --- rule below.

---
`;

const bodyOf = (raw: string) => raw.slice(raw.indexOf("\n---\n", 4) + 5);

test("Orchestrator + workers: subagents: add/remove, flow style kept, comments and prose byte-for-byte", () => {
  const added = editFrontmatterList(AGENT_MD, "subagents", "writer", "add");
  assert.match(added, /^subagents: \[researcher, writer\]$/m);
  assert.deepEqual(matter(added).data.subagents, ["researcher", "writer"]);
  assert.equal(bodyOf(added), bodyOf(AGENT_MD));
  assert.equal(added.replace("subagents: [researcher, writer]", "subagents: [researcher]"), AGENT_MD, "only that line changed");
  assert.equal(editFrontmatterList(added, "subagents", "writer", "add"), added, "adding twice is a no-op");
  const removed = editFrontmatterList(added, "subagents", "writer", "remove");
  assert.equal(removed, AGENT_MD);
  const empty = editFrontmatterList(AGENT_MD, "subagents", "researcher", "remove");
  assert.match(empty, /^subagents: \[\]$/m);
  assert.deepEqual(matter(empty).data.subagents, []);
});

test("Consult: agents: in block style stays block style, comments kept", () => {
  const added = editFrontmatterList(AGENT_MD, "agents", "critic", "add");
  assert.match(added, /agents:\n  - editor   # house style\n  - critic\nsubagents/);
  assert.deepEqual(matter(added).data.agents, ["editor", "critic"]);
  assert.equal(editFrontmatterList(added, "agents", "critic", "remove"), AGENT_MD);
  const none = editFrontmatterList(AGENT_MD, "agents", "editor", "remove");
  assert.match(none, /^agents: \[\]\nsubagents/m);
  assert.deepEqual(matter(none).data.agents, []);
  assert.deepEqual(frontmatterList(AGENT_MD, "agents"), ["editor"]);
});

test("Can ask me: ask in tools:, trailing comment kept; an absent key is added before the fence", () => {
  const on = editFrontmatterList(AGENT_MD, "tools", "ask", "add");
  assert.match(on, /^tools: \[read, write, ask\]  # keep narrow$/m);
  assert.deepEqual(matter(on).data.tools, ["read", "write", "ask"]);
  assert.equal(editFrontmatterList(on, "tools", "ask", "remove"), AGENT_MD);
  const bare = "---\nname: x\n---\n\nBody.\n";
  const withTools = editFrontmatterList(bare, "tools", "ask", "add");
  assert.equal(withTools, "---\nname: x\ntools: [ask]\n---\n\nBody.\n");
  assert.equal(editFrontmatterList(bare, "tools", "ask", "remove"), bare);
  // [[wikilinks]] and quotes are the same name.
  assert.deepEqual(frontmatterList('---\nsubagents: ["[[a]]", \'b\']\n---\n', "subagents"), ["a", "b"]);
  assert.equal(editFrontmatterList('---\nsubagents: ["[[a]]", b]\n---\n', "subagents", "a", "remove"), "---\nsubagents: [b]\n---\n");
});

test("worker description: set, replaced (including a folded block), quoted when YAML needs it", () => {
  const set = setFrontmatterScalar("---\nname: w\nmodel: fast\n---\nBody: stays.\n", "description", "Finds sources: fast");
  assert.equal(set, '---\nname: w\ndescription: "Finds sources: fast"\nmodel: fast\n---\nBody: stays.\n');
  assert.equal(matter(set).data.description, "Finds sources: fast");
  const folded = "---\nname: w\ndescription: >\n  old words\n  more\nmodel: fast\n---\nB\n";
  assert.equal(setFrontmatterScalar(folded, "description", "New one"), "---\nname: w\ndescription: New one\nmodel: fast\n---\nB\n");
  assert.equal(setFrontmatterScalar(AGENT_MD, "description", "Leads."), AGENT_MD.replace("Runs the desk.", "Leads."));
  assert.equal(yamlScalar("yes"), '"yes"');
  assert.equal(yamlScalar("Plain words, fine"), "Plain words, fine");
  assert.equal(yamlScalar("# not a comment"), '"# not a comment"');
});

test("New agent: template answered, everything else as the template wrote it", async () => {
  const t = AGENT_TEMPLATE("scout");
  const out = newAgentFile(t, { description: "Scouts leads", model: "fast" });
  const m = matter(out);
  assert.equal(m.data.name, "scout");
  assert.equal(m.data.description, "Scouts leads");
  assert.equal(m.data.model, "fast");
  assert.equal(m.content, matter(t).content);
  assert.equal(newAgentFile(t, {}), t);
});

test("CRLF files keep CRLF", () => {
  const crlf = AGENT_MD.replace(/\n/g, "\r\n");
  const out = editFrontmatterList(crlf, "subagents", "w", "add");
  assert.ok(!/[^\r]\n/.test(out), "a bare LF crept in");
  assert.deepEqual(matter(out).data.subagents, ["researcher", "w"]);
});
