// The four job blocks — governance, guardrail, observability, evaluation —
// read as the flat keys they hold (matter.ts), and check refuses a key set
// both ways and reports one in the wrong block.
//
//   node --test tests/jobs.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import matter, { jobFold, configMatter } from "../src/matter.ts";
import { scanFiles } from "../src/scan.ts";
import { checkFiles } from "../src/deploy.ts";
import { FRONTMATTER, fieldsOfJob } from "../src/frontmatter-fields.ts";

const fm = (body: string) => `---\n${body}---\n\nText.\n`;

test("a block reads as its flat keys; the fold is invisible to JSON and to spreads", () => {
  const { data } = configMatter(fm("name: desk\nguardrail:\n  limits: {repeat: 5}\n  network: [api.example.com]\ngovernance:\n  owner: ana@acme.io\n"));
  assert.deepEqual(data, { name: "desk", limits: { repeat: 5 }, network: ["api.example.com"], owner: "ana@acme.io" });
  assert.deepEqual(JSON.parse(JSON.stringify(data)), { name: "desk", limits: { repeat: 5 }, network: ["api.example.com"], owner: "ana@acme.io" }, "nothing extra in JSON");
  assert.equal(jobFold(data)?.folded.get("limits"), "guardrail");
  assert.equal(jobFold({ ...data }), null, "a copy carries no fold record");
});

test("a key no kind lets that block hold stays in it; plain matter() folds nothing — a note keeps its own data", () => {
  const { data } = configMatter(fm("governance:\n  limits: {calls: 9}\n  owner: x\n"));
  assert.deepEqual(data, { owner: "x", governance: { limits: { calls: 9 } } });
  // Codex's example: a knowledge note whose owner and governance.owner are two things.
  const note = matter(fm("title: Board responsibilities\nowner: editorial\ngovernance:\n  owner: compliance\n")).data;
  assert.deepEqual(note, { title: "Board responsibilities", owner: "editorial", governance: { owner: "compliance" } });
});

test("the fold changes nothing it parsed: a YAML alias shared with another key keeps its value", () => {
  const { data } = configMatter(fm("custom: &x {owner: Ana}\ngovernance: *x\n"));
  assert.deepEqual(data, { custom: { owner: "Ana" }, owner: "Ana" });
});

test("every config reader folds: listAgents, parseFlow, readAgentsMdKeys", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-jobs-readers-"));
  const prev = process.env.FOLDRUN_DATA;
  process.env.FOLDRUN_DATA = root;
  try {
    const ws = path.join(root, "acme/workspaces/desk");
    fs.mkdirSync(path.join(ws, "agents/w"), { recursive: true });
    fs.mkdirSync(path.join(ws, "flows"), { recursive: true });
    fs.writeFileSync(path.join(ws, "AGENTS.md"), fm("name: desk\ngovernance:\n  owner: desk-lead\n"));
    fs.writeFileSync(path.join(ws, "agents/w/agent.md"), fm("name: w\ndescription: d\nguardrail:\n  secrets: [CRM_TOKEN]\n  network: [api.crm.io]\n"));
    fs.writeFileSync(path.join(ws, "flows/daily.md"), fm("name: daily\ntrigger: manual\ngovernance:\n  owner: flow-owner\nguardrail:\n  overlap: queue\n") + "1. [[w]] — go\n");
    const { listAgents, listFlows } = await import("../src/store.ts");
    const { readAgentsMdKeys } = await import("../src/agents-md.ts");
    const [w] = listAgents("acme", "desk");
    assert.deepEqual(w.secrets, ["CRM_TOKEN"]);
    assert.deepEqual(w.network.added ?? w.network.hosts, w.network.added ?? w.network.hosts);
    assert.ok(JSON.stringify(w.network).includes("api.crm.io"), "network from inside guardrail:");
    assert.equal(w.owner, "desk-lead", "the workspace owner, from inside governance:");
    const [flow] = listFlows("acme", "desk");
    assert.equal(flow.owner, "flow-owner");
    assert.equal(flow.overlap, "queue");
    assert.equal(readAgentsMdKeys(ws).owner, "desk-lead");
  } finally {
    if (prev === undefined) delete process.env.FOLDRUN_DATA; else process.env.FOLDRUN_DATA = prev;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("check: set both ways is a config/conflict error; a misplaced key is config/misplaced", () => {
  const found = scanFiles([
    { path: "agents/writer/agent.md", content: fm("name: writer\nlimits: {calls: 10}\nguardrail:\n  limits: {calls: 20}\ngovernance:\n  network: [a.com]\n") },
  ]);
  const conflict = found.find((f) => f.rule === "config/conflict");
  assert.equal(conflict?.level, "error");
  assert.equal(conflict?.line, 3, "the top-level line");
  const misplaced = found.find((f) => f.rule === "config/misplaced");
  assert.match(misplaced?.message ?? "", /`network:` is a guardrail field, not a governance one/);
  assert.equal(misplaced?.line, 7, "the indented line inside the block");
});

test("a block-form AGENTS.md and agent check clean, and a conflict refuses the deploy", () => {
  const clean = checkFiles([
    { path: "AGENTS.md", content: fm("name: desk\ngovernance:\n  owner: ops@acme.io\n  deploy_block: security\nguardrail:\n  limits: {repeat: 5}\nobservability:\n  capture: metadata\nevaluation:\n  judge: {model: fast}\n") },
    { path: "agents/writer/agent.md", content: fm("name: writer\ndescription: Writes.\nguardrail:\n  disallowedTools: [Bash]\n") },
  ]).filter((f) => f.rule.startsWith("config/"));
  assert.deepEqual(clean.map((f) => `${f.rule} ${f.message}`), []);
  const refused = checkFiles([{ path: "AGENTS.md", content: fm("name: desk\nowner: a\ngovernance:\n  owner: b\n") }]);
  assert.ok(refused.some((f) => f.rule === "config/conflict" && f.level === "error"));
});

test("each kind offers a block only for the jobs it has fields for", () => {
  const keys = (k: "agent" | "flow" | "agents-md") => FRONTMATTER[k].map((f) => f.key);
  assert.ok(keys("agent").includes("guardrail") && !keys("agent").includes("evaluation"));
  assert.ok(keys("agents-md").includes("evaluation"));
  assert.deepEqual(fieldsOfJob("agents-md", "evaluation"), ["judge"]);
  assert.equal(FRONTMATTER["agents-md"].find((f) => f.key === "alerts")?.job, "observability");
});

test("the editor offers a block's own fields inside it, and no step options in a flow's frontmatter", async () => {
  const { completionsAt } = await import("../src/completions.ts");
  const vocab = { agents: [], flows: [], skills: [], tools: [], secrets: [], scripts: [], types: [], docs: [] } as never;
  const at = (path: string, text: string) => (completionsAt(path, text, text.length, vocab)?.items ?? []).map((c) => c.label.split(".")[0]);
  assert.deepEqual(at("AGENTS.md", "---\nname: desk\nobservability:\n  ").sort(), ["alerts", "capture", "notify", "telemetry"]);
  assert.deepEqual(at("agents/w/agent.md", "---\nguardrail:\n  li"), ["limits"]);
  const flowFront = at("flows/daily.md", "---\nguardrail:\n  ");
  assert.ok(flowFront.includes("throttle") && !flowFront.includes("retry"), "the block's fields, not step options");
});

test("the canvas and the network setting edit a key inside its block, not beside it", async () => {
  const { editFrontmatterList, setFrontmatterScalar } = await import("../src/flow-patterns.ts");
  const { setNetworkSetting } = await import("../src/network.ts");
  const agent = "---\nname: w\nguardrail:\n  disallowedTools: [Bash]\n  network: [a.com]\n---\n\nWork.\n";
  const added = editFrontmatterList(agent, "disallowedTools", "Write", "add");
  assert.match(added, /guardrail:\n  disallowedTools: \[Bash, Write\]\n/);
  assert.equal((added.match(/disallowedTools/g) ?? []).length, 1);
  const net = setNetworkSetting(agent, { level: "trusted", allow: ["b.com"] });
  assert.match(net, /guardrail:\n  disallowedTools: \[Bash\]\n  network: /);
  assert.equal((net.match(/network:/g) ?? []).length, 1);
  const cleared = setNetworkSetting("---\nname: w\nguardrail:\n  network: [a.com]\n---\n", null);
  assert.doesNotMatch(cleared, /guardrail|network/);
  assert.match(setFrontmatterScalar(agent, "description", "Writes."), /name: w\ndescription: Writes\.\nguardrail:/);
  for (const out of [added, net, cleared]) assert.deepEqual(scanFiles([{ path: "agents/w/agent.md", content: out }]).filter((f) => f.rule === "config/conflict"), []);
});

test("judge: in AGENTS.md sets every eval's judge model unless the eval names one; the workspace's wins", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-judge-"));
  const prev = process.env.FOLDRUN_DATA;
  process.env.FOLDRUN_DATA = root;
  try {
    const ws = path.join(root, "acme/workspaces/desk");
    fs.mkdirSync(path.join(ws, "evals"), { recursive: true });
    fs.writeFileSync(path.join(root, "acme/AGENTS.md"), fm("evaluation:\n  judge: {model: max, effort: high}\n"));
    fs.writeFileSync(path.join(ws, "AGENTS.md"), fm("name: desk\n"));
    fs.writeFileSync(path.join(ws, "evals/a.md"), fm("agent: w\n") + "## c\ntask: x\nexpect:\n  - contains: y\n");
    fs.writeFileSync(path.join(ws, "evals/b.md"), fm("agent: w\nmodel: fast\n") + "## c\ntask: x\nexpect:\n  - contains: y\n");
    const { listEvals } = await import("../src/evals.ts");
    const { resolveModel } = await import("../src/store.ts");
    const by = Object.fromEntries(listEvals("acme", "desk").map((e) => [e.name, e]));
    assert.equal(by.a.model, resolveModel("max"), "the account's judge: from inside evaluation:");
    assert.equal(by.a.effort, "high");
    assert.equal(by.b.model, resolveModel("fast"), "an eval's own model wins");
    fs.writeFileSync(path.join(ws, "AGENTS.md"), fm("name: desk\njudge: {model: default}\n"));
    assert.equal(listEvals("acme", "desk").find((e) => e.name === "a")?.model, resolveModel("default"), "the workspace's wins");
    fs.writeFileSync(path.join(ws, "AGENTS.md"), fm("name: desk\njudge: {effort: low}\n"));
    const a2 = listEvals("acme", "desk").find((e) => e.name === "a");
    assert.equal(a2?.model, resolveModel("max"), "field by field: the account's model stays");
    assert.equal(a2?.effort, "low");
  } finally {
    if (prev === undefined) delete process.env.FOLDRUN_DATA; else process.env.FOLDRUN_DATA = prev;
    fs.rmSync(root, { recursive: true, force: true });
  }
  const { parseJudge } = await import("../src/judge-verdict.ts");
  assert.match(parseJudge({ model: "fast", temperature: 1 }).problems.join(), /temperature — not a key/);
});

test("writers: a trailing comment, a deeper same-named key, an indentless list, an inline block", async () => {
  const { patchFrontmatter } = await import("../src/agents-md.ts");
  const { setNetworkSetting } = await import("../src/network.ts");
  const commented = patchFrontmatter("---\nobservability:   # who is told\n  capture: full\n---\n", { capture: "metadata" });
  assert.match(commented, /observability: {3}# who is told\n  capture: metadata\n---/);
  assert.equal((commented.match(/capture:/g) ?? []).length, 1);
  // `owner` deeper (inside notify) is not the block's owner.
  const deeper = patchFrontmatter("---\nobservability:\n  notify:\n    owner: x\n---\n", { owner: "ana" });
  assert.match(deeper, /    owner: x\nowner: ana\n---/, "added at the top; the nested one untouched");
  const indentless = setNetworkSetting("---\nname: w\nguardrail:\n  network:\n  - a.com\n  - b.com\n  limits: {calls: 3}\n---\n", { level: "trusted", allow: ["c.com"] });
  assert.doesNotMatch(indentless, /a\.com|b\.com/, "the old list's items go with it");
  assert.match(indentless, /  limits: \{calls: 3\}/);
  assert.throws(() => patchFrontmatter("---\nguardrail: {network: [a.com]}\n---\n", { network: "open" }), /write `guardrail:` one key per line/);
});

test("Codex round 3 repros: blank line in a block, other block spellings, the deploy gate", async () => {
  const { patchFrontmatter } = await import("../src/agents-md.ts");
  const { deployIssues } = await import("../src/deploy.ts");
  // Clearing the block's first key keeps the header while a key follows a blank line.
  const cleared = patchFrontmatter("---\nname: desk\nguardrail:\n  network: none\n\n  limits: {calls: 2}\n---\n", { network: null });
  assert.deepEqual(matter(cleared).data, { name: "desk", guardrail: { limits: { calls: 2 } } });
  // Clearing the last key still removes the header.
  assert.equal(patchFrontmatter("---\nname: desk\nguardrail:\n  network: none\n---\n", { network: null }), "---\nname: desk\n---\n");
  // A comment at column 0 inside the block does not end it.
  const commented = patchFrontmatter("---\nguardrail:\n# network policy\n  network: none\n---\n", { network: "trusted" });
  assert.equal((commented.match(/network:/g) ?? []).length, 1);
  assert.match(commented, /\n {2}network: trusted\n/);
  // Forms the writers do not edit are refused, never written beside.
  for (const raw of ["---\nguardrail: {\"network\": none}\n---\n", "---\nguardrail: {\n  network: none\n}\n---\n", "---\nbase: &g {network: none}\nguardrail: *g\n---\n"]) {
    assert.throws(() => patchFrontmatter(raw, { network: "trusted" }), /not written one key per line/, raw);
  }
  // A one-line block without the key does not stop an edit elsewhere.
  assert.match(patchFrontmatter("---\nguardrail: {limits: {calls: 2}}\n---\n", { owner: "ana" }), /owner: ana/);
  // A quoted top-level key is edited, not duplicated.
  assert.equal((patchFrontmatter("---\n\"owner\": a\n---\n", { owner: "b" }).match(/owner/g) ?? []).length, 1);
  // The deploy gate refuses both job rules, as check does.
  const issues = (content: string) => deployIssues([{ path: "AGENTS.md", content }, { path: "agents/w/agent.md", content: fm("name: w\ndescription: d\n") + "Writes.\n" }]).map((i) => i.message);
  assert.ok(issues(fm("name: desk\ngovernance:\n  network_enforce: true\n")).some((m) => /config\/misplaced/.test(m)));
  assert.ok(issues(fm("name: desk\nowner: a\ngovernance:\n  owner: b\n")).some((m) => /config\/conflict/.test(m)));
  assert.ok(!issues(fm("name: desk\nguardrail:\n  network_enforce: true\n")).some((m) => /config\//.test(m)));
});

test("Codex round 4: comments inside a list and before a blank line, quoted headers; the write guard", async () => {
  const { patchFrontmatter } = await import("../src/agents-md.ts");
  const { guardEdit, UnsafeEditError } = await import("../src/frontmatter-guard.ts");
  const listed = patchFrontmatter("---\nname: desk\nguardrail:\n  network:\n  - a.com\n  # another host\n  - b.com\n---\n", { network: "none" });
  assert.deepEqual(matter(listed).data, { name: "desk", guardrail: { network: "none" } });
  const kept = patchFrontmatter("---\nname: desk\nguardrail:\n  network: none\n  # remaining policy\n\n  limits: {calls: 2}\n---\n", { network: null });
  assert.deepEqual(matter(kept).data, { name: "desk", guardrail: { limits: { calls: 2 } } });
  const quoted = patchFrontmatter("---\n\"guardrail\":\n  network: none\n---\n", { network: "trusted" });
  assert.deepEqual(matter(quoted).data, { guardrail: { network: "trusted" } });
  // The guard itself: an edit that drops another key, doubles one, or breaks the YAML.
  const before = "---\nname: desk\nguardrail:\n  network: none\n  limits: {calls: 2}\n---\n";
  assert.throws(() => guardEdit(before, "---\nname: desk\nguardrail:\n  limits: {calls: 2}\n---\n".replace("  limits: {calls: 2}\n", ""), ["network"]), /`limits` would change too/);
  assert.throws(() => guardEdit(before, before.replace("---\n", "---\nnetwork: open\n").replace(/---\n$/, "---\n"), ["network"]), /both at the top and inside `guardrail:`/);
  assert.throws(() => guardEdit(before, "---\nname: desk\n  limits: {calls: 2}\n---\n", ["network"]), /would not parse/);
  assert.throws(() => guardEdit(before, before.replace("network: none", "network: open"), ["network"], { network: "trusted" }), (e) => e instanceof UnsafeEditError && e.status === 409);
  assert.equal(guardEdit(before, before.replace("network: none", "network: open"), ["network"], { network: "open" }), before.replace("network: none", "network: open"));
});

test("Codex round 5: the guard checks every call — an unchanged result, an unreadable file", async () => {
  const { patchFrontmatter } = await import("../src/agents-md.ts");
  const { guardEdit } = await import("../src/frontmatter-guard.ts");
  // An escaped key the text writer cannot see: clearing it must not report success.
  assert.throws(() => patchFrontmatter('---\n"networ\\u006b": none\n---\n', { network: null }), /`network` would not read back as written/);
  assert.throws(() => patchFrontmatter("---\nnetwork: [\n---\n", { owner: "Ana" }), /does not parse as it is/);
  // A predicate expectation, as the canvas list edit gives.
  const raw = "---\nname: w\ntools: [read]\n---\n";
  assert.equal(guardEdit(raw, raw.replace("[read]", "[read, web]"), ["tools"], { tools: (v: unknown) => Array.isArray(v) && v.includes("web") }), raw.replace("[read]", "[read, web]"));
  assert.throws(() => guardEdit(raw, raw, ["tools"], { tools: (v: unknown) => Array.isArray(v) && v.includes("web") }), /would not read back/);
});

test("the canvas edits a quoted key inside its block, not beside it", async () => {
  const { editFrontmatterList } = await import("../src/flow-patterns.ts");
  const out = editFrontmatterList("---\nname: w\nguardrail:\n  \"disallowedTools\": [Bash]\n---\n", "disallowedTools", "Write", "add");
  assert.deepEqual(configMatter(out).data.disallowedTools, ["Bash", "Write"]);
  assert.equal(jobFold(configMatter(out).data)?.conflicts.size ?? 0, 0);
});

test("patchFrontmatter writes and removes a whole job block, checked as the keys it holds", async () => {
  const { patchFrontmatter } = await import("../src/agents-md.ts");
  const added = patchFrontmatter("---\nname: desk\n---\n", { guardrail: { network: "trusted", limits: { calls: 5 } } });
  assert.deepEqual(configMatter(added).data, { name: "desk", network: "trusted", limits: { calls: 5 } });
  const removed = patchFrontmatter(added, { guardrail: null });
  assert.deepEqual(configMatter(removed).data, { name: "desk" });
  // A whole block that would double a flat key is still refused.
  assert.throws(() => patchFrontmatter("---\nnetwork: none\n---\n", { guardrail: { network: "open" } }), /both at the top/);
});

test("reading a list in a block the writers do not edit is empty; editing it is refused", async () => {
  const { frontmatterList, editFrontmatterList } = await import("../src/flow-patterns.ts");
  const raw = "---\nname: w\nguardrail: {disallowedTools: [Bash]}\n---\n";
  assert.deepEqual(frontmatterList(raw, "disallowedTools"), []);
  assert.throws(() => editFrontmatterList(raw, "disallowedTools", "Bash", "remove"), /not written one key per line/);
});

test("a block that merges another map (<<:) refuses a key it may bring in", async () => {
  const { setNetworkSetting } = await import("../src/network.ts");
  assert.throws(() => setNetworkSetting("---\nbase: &policy {network: none}\nguardrail:\n  <<: *policy\n---\n", { level: "trusted" }), /not written one key per line/);
});
