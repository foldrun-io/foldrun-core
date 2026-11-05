// FOL-112 (5 Nov 2026): what an agent behind a published flow can reach, what
// a change widens, and the answer as a way out — the scanner's half and the
// pure facts the platform's write doors and serve path read.
//
//   node --test tests/a2a-reach.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { agentReach, reachWidening, flowAgents, a2aTree, a2aWriteEffect, flowSecretCode } from "../src/a2a-reach.ts";
import { a2aPublishProblems, parseA2aPublish } from "../src/a2a-publish.ts";
import { scanFiles } from "../src/scan.ts";
import { parseFlow } from "../src/store.ts";

const doc = (front: string, body = "Do the work.") => `---\n${front}\n---\n\n${body}\n`;

test("agentReach: tools expanded as the runner grants them; plan keeps no Bash; ask-mode is no grant", () => {
  const r = agentReach({ tools: ["code", "read", "crm"], secrets: ["CRM_TOKEN"] });
  assert.ok(r.runsCode);
  assert.deepEqual(r.tools, ["Bash", "Glob", "Grep", "Read", "crm", "install"], "install is every agent's");
  assert.deepEqual(r.secrets, ["CRM_TOKEN"]);
  assert.equal(agentReach({ tools: ["code"], disallowedTools: ["Bash"] }).runsCode, false, "disallowedTools takes the expanded name away");
  assert.equal(agentReach({ tools: ["code"], permissionMode: "plan" }).runsCode, false, "plan mode is read-only");
  assert.deepEqual(agentReach({ tools: ["crm", "code"], permissionMode: "plan" }).tools, ["Glob", "Grep", "Read", "crm"], "plan keeps the author's own (API, script) tools");
  assert.deepEqual(reachWidening(agentReach({ disallowedTools: ["install"] }), agentReach({})), ["tools install"], "dropping the deny gives install back (Codex review)");
  assert.equal(agentReach({ tools: [{ Bash: "ask" }] }).runsCode, false, "approval mode is not a grant");
  assert.equal(agentReach({ tools: "Read, Bash" }).runsCode, true, "Claude Code's comma string");
});

test("agentReach: secrets from secrets:, ${NAME} in apis:, a granted folder tool and a web provider", () => {
  const toolDefs = new Map<string, Record<string, unknown>>([
    ["mailer", { transport: "script", secrets: ["RESEND_API_KEY"] }],
    ["crm", { transport: "http", headers: { authorization: "Bearer ${CRM_TOKEN}" } }],
  ]);
  const r = agentReach(
    { secrets: "A_KEY", apis: [{ name: "x", base: "https://x", headers: { k: "${X_KEY}" } }], tools: ["mailer", "crm", "web"], web: { search: "exa" } },
    { toolDefs },
  );
  assert.deepEqual(r.secrets, ["A_KEY", "CRM_TOKEN", "EXA_API_KEY", "RESEND_API_KEY", "X_KEY"]);
  // The runner loads a named tool's secrets before it filters what may be
  // called (Codex review): disallowed or ask-mode, they still reach Bash.
  assert.deepEqual(agentReach({ tools: ["code", "mailer"], disallowedTools: ["mailer"] }, { toolDefs }).secrets, ["RESEND_API_KEY"]);
  assert.deepEqual(agentReach({ tools: ["code", { mailer: "ask" }] }, { toolDefs }).secrets, ["RESEND_API_KEY"]);
});

test("reachWidening: what is new counts; order, aliases and narrowing do not", () => {
  const before = agentReach({ tools: ["read", "write"], secrets: ["A"], network: "trusted", hooks: ["guard"] });
  assert.deepEqual(reachWidening(before, agentReach({ tools: ["write", "read"], secrets: ["A"], network: "trusted", hooks: ["guard"] })), []);
  assert.deepEqual(reachWidening(before, agentReach({ tools: ["read"], network: "none", hooks: ["guard"] })), [], "narrower is not wider");
  assert.deepEqual(reachWidening(before, agentReach({ tools: ["read", "write", "code"], secrets: ["A"], network: "trusted", hooks: ["guard"] })), ["tools Bash"]);
  assert.deepEqual(reachWidening(before, agentReach({ tools: ["read", "write"], secrets: ["A", "B"], network: "trusted", hooks: ["guard"] })), ["secrets B"]);
  assert.deepEqual(reachWidening(before, agentReach({ tools: ["read", "write"], secrets: ["A"], network: "open", hooks: ["guard"] })), ["network trusted → open"]);
  assert.deepEqual(reachWidening(before, agentReach({ tools: ["read", "write"], secrets: ["A"], network: ["api.example.com"], hooks: ["guard"] })), ["network sites api.example.com"]);
  assert.deepEqual(reachWidening(before, agentReach({ tools: ["read", "write"], secrets: ["A"], network: "trusted" })), ["hooks removed: guard"]);
  assert.deepEqual(reachWidening(agentReach({ permissionMode: "plan" }), agentReach({})), ["tools install", "permissionMode: plan removed"]);
  assert.deepEqual(reachWidening(agentReach({}), agentReach({ sandbox: "own" })), ["sandbox: own"]);
  const api = (base: string) => agentReach({ apis: [{ name: "crm", base }] });
  assert.deepEqual(reachWidening(api("https://crm.example.com"), api("https://attacker.example")), ["network sites attacker.example", "apis crm (changed)"], "the base's host is implied, as the runner adds it");
  // Scripts by name and spec (Codex review: objects used to collapse into one).
  const sc = (scripts: unknown[]) => agentReach({ scripts });
  assert.deepEqual(reachWidening(sc([{ name: "a", run: "echo ok" }]), sc([{ name: "a", run: "echo ok" }, { name: "b", run: "curl x" }])), ["scripts b"]);
  assert.deepEqual(reachWidening(sc([{ name: "a", run: "echo ok" }]), sc([{ name: "a", run: "curl x" }])), ["scripts a (changed)"]);
  // A granted folder tool's definition changed.
  const withTool = (base: string) => agentReach({ tools: ["crm"] }, { toolDefs: new Map([["crm", { transport: "http", base }]]) });
  assert.deepEqual(reachWidening(withTool("https://crm.example.com"), withTool("https://crm.example.com/v2")), ["tools crm (changed)"]);
  // The web tool reads the open web only with fetch or browse among its actions.
  const web = (actions: string[]) => agentReach({ tools: ["web"], web: { actions } });
  assert.equal(web(["search"]).network.level, "trusted");
  assert.deepEqual(reachWidening(web(["search"]), web(["search", "fetch"])), ["network trusted → open"]);
  assert.deepEqual(reachWidening(null, agentReach({ tools: ["read"] })), ["tools Glob, Grep, Read, install", "network trusted"], "a new agent: all of it");
  // The workspace's own hooks and network count for every agent.
  assert.deepEqual(reachWidening(agentReach({}, { workspace: { hooks: ["audit"] } }), agentReach({}, { workspace: {} })), ["hooks removed: audit"]);
});

test("flowAgents: steps, rescuers, delegates, subflows and sub-agents, all the way down", () => {
  const flow = parseFlow("main.md", doc("a2a:\n  publish: true", "1. [[a]] — x\n   on-fail: [[fixer]]\n2. [[flow:inner]] — y\n"));
  const inner = parseFlow("inner.md", doc("trigger: manual", "1. [[b]] — z\n2. [[flow:main]] — loops back\n"));
  const subs: Record<string, string[]> = { a: ["helper"], helper: ["deep"], b: [], fixer: [], deep: [] };
  assert.deepEqual(flowAgents(flow, (n) => subs[n] ?? null, (n) => (n === "inner" ? inner : n === "main" ? flow : null)), ["a", "b", "deep", "fixer", "helper"]);
});

const AGENT = (front: string) => doc(`name: x\n${front}`);
const PUB = (extra = "") => doc(`a2a:\n  publish: true${extra}`, "1. [[worker]] — Do what the caller asks.\n");
const tree = (files: Record<string, string>) => a2aTree(Object.entries(files).map(([path, content]) => ({ path, content })));

test("a2aWriteEffect: an agent of a published flow widened; a new secret-and-code exposure; accepted; stale names", () => {
  const base = { "flows/leads.md": PUB(), "agents/worker/agent.md": AGENT("tools: [read]") };
  const before = tree(base);
  // Widening an agent behind a published flow.
  const wider = a2aWriteEffect(before, tree({ ...base, "agents/worker/agent.md": AGENT("tools: [read, code]\nsecrets: [TOKEN]") }));
  assert.deepEqual(wider.widened, [{ flow: "leads", agent: "worker", what: ["tools Bash", "secrets TOKEN"] }]);
  assert.deepEqual(wider.unaccepted, [{ flow: "leads", agent: "worker", secrets: ["TOKEN"] }]);
  // A new agent added to the published flow is a widening (it was not behind it).
  const added = a2aWriteEffect(before, tree({ ...base, "flows/leads.md": doc("a2a:\n  publish: true", "1. [[worker]] — x\n2. [[other]] — y\n"), "agents/other/agent.md": AGENT("tools: [read]") }));
  assert.deepEqual(added.widened.map((w) => w.agent), ["other"]);
  // An unpublished flow: nothing to say.
  assert.deepEqual(a2aWriteEffect(tree({ ...base, "flows/leads.md": doc("trigger: manual", "1. [[worker]] — x\n") }), tree({ ...base, "flows/leads.md": doc("trigger: manual", "1. [[worker]] — x\n"), "agents/worker/agent.md": AGENT("tools: [code]\nsecrets: [T]") })), { widened: [], unaccepted: [], accepted: [], stale: [] });
  // Publishing a flow whose agent holds a secret and runs code: unaccepted; with accept_risk: accepted.
  const risky = { "flows/leads.md": doc("trigger: manual", "1. [[worker]] — x\n"), "agents/worker/agent.md": AGENT("tools: [code]\nsecrets: [T]") };
  const publish = a2aWriteEffect(tree(risky), tree({ ...risky, "flows/leads.md": PUB() }));
  assert.deepEqual(publish.widened, [], "publishing is not widening — a2a: is the admin's already");
  assert.deepEqual(publish.unaccepted, [{ flow: "leads", agent: "worker", secrets: ["T"] }]);
  const ack = a2aWriteEffect(tree(risky), tree({ ...risky, "flows/leads.md": PUB("\n  accept_risk: [worker]") }));
  assert.deepEqual(ack.unaccepted, []);
  assert.deepEqual(ack.accepted, [{ flow: "leads", agent: "worker", secrets: ["T"] }]);
  // An exposure already there is not a write's to refuse (the serve path refuses it).
  const already = tree({ ...risky, "flows/leads.md": PUB() });
  assert.deepEqual(a2aWriteEffect(already, tree({ ...risky, "flows/leads.md": PUB(), "knowledge/x.md": "x" })).unaccepted, []);
  assert.deepEqual(flowSecretCode(already, "leads").map((e) => [e.agent, e.accepted]), [["worker", false]]);
  // A name the write adds that no agent of the flow answers to.
  assert.deepEqual(a2aWriteEffect(tree(risky), tree({ ...risky, "flows/leads.md": PUB("\n  accept_risk: [worker, ghost]") })).stale, [{ flow: "leads", agents: ["ghost"] }]);
});

test("a2aTree: a Claude Code agent file, a library tool, the workspace's network", () => {
  const t = tree({
    "AGENTS.md": doc("network: open"),
    ".claude/agents/worker.md": AGENT("tools: [code, mailer]"),
    "library/tools/mailer/tool.md": doc("name: mailer\ntransport: script\nsecrets: [RESEND_API_KEY]"),
    "flows/leads.md": PUB(),
  });
  const r = t.reachOf("worker")!;
  assert.deepEqual(r.secrets, ["RESEND_API_KEY"]);
  assert.equal(r.network.level, "open");
  assert.deepEqual(t.agentsOf("leads"), ["worker"]);
});

test("accept_risk: a list of agent names; anything else publishes nothing", () => {
  assert.deepEqual(a2aPublishProblems({ publish: true, accept_risk: ["worker"] }), []);
  assert.deepEqual(parseA2aPublish({ publish: true, accept_risk: [" worker ", "worker"] })!.acceptRisk, ["worker"]);
  assert.equal(parseA2aPublish({ publish: true })!.acceptRisk, undefined, "absent when not written");
  for (const bad of [true, "worker", ["a/b"], [""], [1]]) assert.equal(parseA2aPublish({ publish: true, accept_risk: bad }), null, JSON.stringify(bad));
});

test("scan: published-flow-secret-code warns; accepted is info; the answer counts as a way out for the trifecta rule", () => {
  const files = (flow: string, worker = "tools: [read, code]\nsecrets: [CRM_TOKEN]\nnetwork: none") => [
    { path: "agents/worker/agent.md", content: AGENT(worker) },
    { path: "flows/leads.md", content: flow },
  ];
  const found = scanFiles(files(PUB())).filter((f) => f.rule === "security/published-flow-secret-code");
  assert.equal(found.length, 1);
  assert.equal(found[0]!.level, "warn");
  assert.match(found[0]!.message, /worker holds CRM_TOKEN and can run code \(Bash\), and leads is published over A2A — its answer goes back to the outside caller/);
  assert.equal(found[0]!.line, 6, "at the step that runs it");
  const accepted = scanFiles(files(PUB("\n  accept_risk: [worker]"))).filter((f) => f.rule === "security/published-flow-secret-code");
  assert.deepEqual(accepted.map((f) => f.level), ["info"]);
  assert.match(accepted[0]!.message, /accepted by an admin/);
  assert.equal(scanFiles(files(PUB(), "tools: [read]\nsecrets: [CRM_TOKEN]")).filter((f) => f.rule === "security/published-flow-secret-code").length, 0, "no code: not this rule");
  // N1: no network out and a hooks: gate — the answer is still a way out.
  const trifecta = scanFiles(files(PUB(), "tools: [read]\nsecrets: [CRM_TOKEN]\nnetwork: none\nhooks: [guard]")).filter((f) => f.rule === "security/published-flow-trifecta");
  assert.equal(trifecta.length, 1);
  assert.match(trifecta[0]!.message, /leads is published over A2A, so what an outside caller sends reaches worker, which holds secret CRM_TOKEN — and the flow's answer goes back to that caller/);
  assert.equal(scanFiles(files(PUB(), "tools: [read]")).filter((f) => f.rule.startsWith("security/published-flow")).length, 0, "nothing private, nothing to say");
});
