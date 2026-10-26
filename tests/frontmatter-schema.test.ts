// The frontmatter schema is the one list of fields — and these tests are what
// keep it the one list. Each reads the code that actually consumes a kind of
// file, so a field the runtime starts reading fails here until the schema
// (and so check, the Checks page and the editor's completions) knows it.
// foldrun-web's consistency test holds the other end: every field here is
// in the docs.
//
//   node --test tests/frontmatter-schema.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { FRONTMATTER, frontmatterProblems, schemaKindOf, type SchemaKind } from "../src/frontmatter-schema.ts";
import { FLOW_TRIGGERS as STORE_TRIGGERS, EFFORT_LEVELS as STORE_EFFORTS } from "../src/store.ts";
import { FLOW_TRIGGERS, EFFORT_LEVELS } from "../src/frontmatter-fields.ts";
import { completionsAt, type Vocabulary } from "../src/completions.ts";
import { cronProblem, parseCron } from "../src/cron.ts";
import { nearestField } from "../src/scan.ts";
import { configMatter } from "../src/matter.ts";

const src = (f: string) => fs.readFileSync(path.join(import.meta.dirname, "..", "src", f), "utf8");
const keys = (kind: SchemaKind) => new Set(FRONTMATTER[kind].map((f) => f.key));
const reads = (text: string, obj: string) => new Set([...text.matchAll(new RegExp(`\\b${obj}\\.([A-Za-z_][A-Za-z0-9_]*)`, "g"))].map((m) => m[1]!));
const missing = (read: Set<string>, kinds: SchemaKind[]) => [...read].filter((k) => !kinds.some((kind) => keys(kind).has(k))).sort();

test("every agent field the runner reads is in the schema", () => {
  const read = reads(src("runner.ts"), "front");
  assert.ok(read.size >= 15, `expected the runner's reads, found ${[...read]}`);
  assert.deepEqual(missing(read, ["agent", "agents-md"]), []);
});

test("every flow field parseFlow reads is in the schema", () => {
  const store = src("store.ts");
  const body = store.slice(store.indexOf("export function parseFlow"));
  const read = reads(body.slice(0, body.indexOf("\nexport function")), "data");
  assert.ok(read.has("trigger") && read.has("schedule"), [...read].join());
  assert.deepEqual(missing(read, ["flow"]), []);
});

test("every tool, hook and eval field their parsers read is in the schema", () => {
  const store = src("store.ts");
  const tool = store.slice(store.indexOf("export function parseToolDef"));
  assert.deepEqual(missing(reads(tool.slice(0, tool.indexOf("\nexport function")), "data"), ["tool"]), []);
  assert.deepEqual(missing(reads(src("hooks.ts"), "data"), ["hook"]), []);
  const evals = src("evals.ts");
  const evalRead = new Set([...reads(evals, "data")].filter((k) => !["cases", "content"].includes(k)));
  assert.deepEqual(missing(evalRead, ["eval"]), []);
});

test("the trigger and effort lists are the schema's — store re-exports them", () => {
  assert.equal(STORE_TRIGGERS, FLOW_TRIGGERS);
  assert.equal(STORE_EFFORTS, EFFORT_LEVELS);
  assert.deepEqual(FRONTMATTER.flow.find((f) => f.key === "trigger")!.values, FLOW_TRIGGERS);
});

const VOCAB: Vocabulary = { agents: [], flows: [], skills: [], tools: [], secrets: [], scripts: [], types: [] };
/** Everything the editor would ever offer at the start of a frontmatter
 *  line: the list shows 16 at a time and narrows as you type, so ask with
 *  every letter and with each field's own name. */
const offeredFor = (file: string, q: string) =>
  (completionsAt(file, `---\n${q}`, 4 + q.length, VOCAB)?.items ?? []).map((c) => c.label.split(".")[0]!);
const offered = (file: string, extra: string[] = []) =>
  new Set([..."abcdefghijklmnopqrstuvwxyz_", ...extra].flatMap((q) => offeredFor(file, q)));

test("the editor offers exactly the schema's fields for each kind of file, and AGENTS.md its own", () => {
  const cases: [string, SchemaKind][] = [
    ["agents/a/agent.md", "agent"],
    ["AGENTS.md", "agents-md"],
    ["flows/f.md", "flow"],
    ["tools/t/tool.md", "tool"],
    ["skills/s/SKILL.md", "skill"],
    ["evals/e.md", "eval"],
  ];
  for (const [file, kind] of cases) {
    const want = new Set(FRONTMATTER[kind].filter((f) => !f.legacy).map((f) => f.key));
    assert.deepEqual([...offered(file, [...want])].sort(), [...want].sort(), `${file} offers what the ${kind} schema takes`);
    for (const key of want) assert.ok(offeredFor(file, key).includes(key), `${file}: typing ${key} offers it`);
  }
  assert.ok(!offered("flows/f.md").has("language"), "no run reads language: on a flow");
  assert.ok(!offered("AGENTS.md").has("model"), "AGENTS.md does not set an agent's model");
});

test("a path maps to its schema", () => {
  assert.equal(schemaKindOf("agents/a/agent.md"), "agent");
  assert.equal(schemaKindOf(".claude/agents/a.md"), "agent");
  assert.equal(schemaKindOf("AGENTS.md"), "agents-md");
  assert.equal(schemaKindOf("library/tools/x/tool.md"), "tool");
  assert.equal(schemaKindOf("agents/a/skills/s/SKILL.md"), "skill");
  assert.equal(schemaKindOf("hooks/h/hook.md"), "hook");
  assert.equal(schemaKindOf("knowledge/k.md"), null);
});

test("values: what does nothing is reported, every alias and well-formed value is not", () => {
  const p = (kind: SchemaKind, data: Record<string, unknown>) => frontmatterProblems(kind, data, nearestField).map((x) => `${x.rule} ${x.key}`);
  assert.deepEqual(p("agent", { effort: "quick", size: "heavy", permissionMode: "plan", tools: "web, read", budget: 5, ask: { timeout: "10m" } }), []);
  assert.deepEqual(p("agent", { effort: "extreme", size: "giant", permissionMode: "yolo", ask: { timeout: "2d" } }), [
    "config/invalid-value effort", "config/invalid-value size", "config/invalid-value permissionMode", "config/invalid-value ask",
  ]);
  assert.deepEqual(p("agent", { tools: { web: true }, model: ["max"] }), ["config/wrong-type tools", "config/wrong-type model"]);
  assert.deepEqual(p("agent", { size: "large", resources: { cpu: 2, memory: "4Gi", disk: "10Gi" } }), []);
  assert.deepEqual(p("agent", configMatter("---\nguardrail:\n  resources: { memory: 1536Mi }\n---\n").data), [], "a guardrail field");
  assert.deepEqual(p("agent", { resources: { cpu: "fast" } }), ["config/invalid-value resources"]);
  assert.deepEqual(p("agent", { resources: "big" }), ["config/wrong-type resources"]);
  assert.deepEqual(p("agent", { apis: [{ name: "crm", base: "https://x", methods: ["GET", "FETCH"] }] }), ["config/invalid-value apis"]);
  assert.deepEqual(p("flow", { trigger: "schedule", schedule: "@daily", every: "15m", disable_after: 3, live: true, at: "2026-11-01T09:00:00Z" }), []);
  assert.deepEqual(p("flow", { trigger: "sometimes", schedule: "every day", debounce: "soon", disable_after: 500 }), [
    "config/invalid-value trigger", "config/invalid-value schedule", "config/invalid-value debounce", "config/invalid-value disable_after",
  ]);
  assert.deepEqual(p("flow", { language: "en" }), ["config/unknown-field language"]);
  assert.match(frontmatterProblems("flow", { language: "en" }, nearestField)[0]!.message, /read in an agent or AGENTS\.md, not in a flow/);
  assert.deepEqual(p("tool", { transport: "HTTP", methods: "GET,POST", rate: "10/m" }), []);
  assert.deepEqual(p("agents-md", { budget: "50/month", priority: "high", concurrency: 2, model: "max" }), ["config/unknown-field model"]);
  assert.deepEqual(p("agents-md", { compute: { vcpu: 4, memory: "8Gi" } }), []);
  assert.deepEqual(p("agents-md", configMatter("---\ngovernance:\n  compute: { vcpu: 2 }\n---\n").data), [], "a governance field");
  assert.deepEqual(p("agents-md", { compute: { vcpu: "many" } }), ["config/invalid-value compute"]);
  assert.deepEqual(p("skill", { name: "s" }), ["config/missing-field description"]);
  // Fields another function validates are left to it: no second message.
  assert.deepEqual(p("agent", { network: "wideopen", timezone: "Mars/Base", limits: { calls: "lots" } }), []);
  const far = frontmatterProblems("agent", { favourite_colour: "blue" }, nearestField)[0]!;
  assert.equal(far.level, "info", "a field like nothing foldrun reads may be another tool's");
});

test("cron: the scheduler's parser, and a message that says why", () => {
  assert.ok(parseCron("0 9 * * MON"));
  assert.equal(cronProblem("0 9 * * MON"), null);
  assert.equal(cronProblem("@weekly"), null);
  assert.match(cronProblem("every day")!, /has 2 fields; cron has five/);
  assert.match(cronProblem("0 25 * * *")!, /out of range or not a number/);
});

test("cron month names count from 1, weekday names from 0; a property name is a bad cron, not a crash; a YAML date is an instant", () => {
  assert.deepEqual([...parseCron("0 9 1 JAN *")!.month], [1]);
  assert.deepEqual([...parseCron("0 9 1 feb,dec *")!.month], [2, 12]);
  assert.deepEqual([...parseCron("0 9 * * SUN")!.dow], [0]);
  assert.deepEqual([...parseCron("0 9 * * mon-fri")!.dow], [1, 2, 3, 4, 5]);
  for (const bad of ["constructor", "__proto__", "toString"]) {
    assert.equal(parseCron(bad), null);
    assert.match(cronProblem(bad)!, /field/);
  }
  const p = frontmatterProblems("flow", { trigger: "once", at: new Date("2026-11-01T09:00:00Z") }, nearestField);
  assert.deepEqual(p, []);
});

test("library agents and flows are read by their schema; a circular YAML alias is a finding, not a crash", async () => {
  const { scanFiles } = await import("../src/scan.ts");
  assert.equal(schemaKindOf("library/agents/a/agent.md"), "agent");
  assert.equal(schemaKindOf("library/flows/f.md"), "flow");
  const found = scanFiles([
    { path: "library/agents/a/agent.md", content: "---\nname: a\ntolls: [read]\n---\nGo.\n" },
    { path: "agents/b/agent.md", content: "---\nname: b\ncustom: &x {self: *x}\n---\nGo.\n" },
  ]).filter((f) => f.rule === "config/unknown-field");
  assert.deepEqual(found.map((f) => `${f.file}:${f.line}`), ["agents/b/agent.md:3", "library/agents/a/agent.md:3"]);
});

test("a value built to break a check is a finding; a skill with no frontmatter is missing its description", async () => {
  const { scanFiles } = await import("../src/scan.ts");
  const p = frontmatterProblems("agent", { ask: { timeout: { toString: "nope" } } }, nearestField);
  assert.deepEqual(p.map((x) => x.rule), ["config/invalid-value"]);
  const found = scanFiles([{ path: "skills/a/SKILL.md", content: "# Just markdown\n\nSteps.\n" }]);
  assert.deepEqual(found.map((f) => f.rule), ["config/missing-field"]);
});

test("rate: the runtime's grammar; a step option on an agent holding a map is a finding, not a crash", () => {
  const p = (data: Record<string, unknown>, kind: SchemaKind = "tool") => frontmatterProblems(kind, data, nearestField).map((x) => `${x.rule} ${x.key}`);
  for (const ok of ["1.5/s", "100/minute", "10/m", 2]) assert.deepEqual(p({ rate: ok }), [], String(ok));
  for (const bad of ["0/s", "fast", "10/fortnight"]) assert.deepEqual(p({ rate: bad }), ["config/invalid-value rate"], bad);
  assert.deepEqual(p({ timeout: { toString: "nope" } }, "agent"), ["config/unknown-field timeout"]);
});

test("FOL-19: secrets: naming a model variable is flagged on an agent and a tool", () => {
  const agent = frontmatterProblems("agent", { name: "a", secrets: ["ANTHROPIC_API_KEY", "CRM_TOKEN"] }, () => null);
  const hit = agent.find((p) => p.key === "secrets");
  assert.equal(hit?.rule, "config/invalid-value");
  assert.match(hit?.message ?? "", /`ANTHROPIC_API_KEY` is a name the step's own model call uses/);
  assert.ok(!/CRM_TOKEN/.test(hit?.message ?? ""));
  assert.equal(frontmatterProblems("agent", { name: "a", secrets: ["CRM_TOKEN"] }, () => null).find((p) => p.key === "secrets"), undefined);
  assert.match(frontmatterProblems("tool", { name: "t", secrets: "ANTHROPIC_BASE_URL" }, () => null).find((p) => p.key === "secrets")?.message ?? "", /ANTHROPIC_BASE_URL/);
  assert.equal(frontmatterProblems("tool", { name: "t", secrets: "proxied" }, () => null).find((p) => p.key === "secrets"), undefined);
});
