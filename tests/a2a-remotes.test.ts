// `remotes:` — the outside A2A agents an agent may call, read as data, and
// what declaring one changes: the schema's check, the network's allowlist,
// the call limits, the scanner's legs and the published-flow rules.
//
//   node --test tests/a2a-remotes.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  readRemotes,
  parseRemotes,
  remotesProblem,
  remoteNetworkHosts,
  remoteGrantHost,
  remoteSecretNames,
  remotesPromptLines,
  cardUrlProblem,
  REMOTE_SECRET_NAME,
  A2A_TOOLS,
} from "../src/a2a-remotes.ts";
import { SECRET_NAME } from "../src/secrets.ts";
import { resolveNetwork, networkAllows } from "../src/network.ts";
import { frontmatterProblems, FRONTMATTER } from "../src/frontmatter-schema.ts";
import { nearestField, scanFiles } from "../src/scan.ts";
import { limitKeysFor, readLimits, limitKeyProblems, CallCounter } from "../src/limits.ts";
import { classifyCall } from "../src/browser-pod.ts";

const CARD = "https://agents.example.com/.well-known/agent-card.json";

test("remotes: reads name, card, secret and description; the origin is the card's", () => {
  const { remotes, problems } = readRemotes([
    { name: "invoice-checker", card: CARD, secret: "INVOICE_TOKEN", description: "  Checks invoices.  " },
    { name: "local", card: "http://127.0.0.1:8080/.well-known/agent-card.json" },
    { name: "braced", card: "https://b.example.org:8443/card.json", secret: "${OTHER_TOKEN}" },
  ]);
  assert.deepEqual(problems, []);
  assert.deepEqual(remotes[0], { name: "invoice-checker", card: CARD, origin: "https://agents.example.com", secret: "INVOICE_TOKEN", description: "Checks invoices." });
  assert.equal(remotes[1]!.origin, "http://127.0.0.1:8080", "plain http on loopback, for a local server");
  assert.equal(remotes[2]!.secret, "OTHER_TOKEN", "${NAME} reads as NAME");
  assert.equal(remoteGrantHost(remotes[2]!), "b.example.org:8443", "the grant names the port, as hostOf does");
  assert.deepEqual(remoteSecretNames(remotes), ["INVOICE_TOKEN", "OTHER_TOKEN"]);
});

test("remotes: what cannot be used is a problem, and left out — a value in secret: is never repeated", () => {
  const bad = readRemotes([
    { name: "Bad_Name", card: CARD },
    { name: "plain", card: "http://agents.example.com/card.json" },
    { name: "creds", card: "https://user:pw@agents.example.com/card.json" },
    { name: "nocard" },
    { name: "leaky", card: CARD, secret: "sk-live-abcdef123456" }, // gitleaks:allow — a fake key: the test checks a literal value is refused
    { name: "extra", card: CARD, url: "https://x" },
    "just a string",
  ]);
  assert.deepEqual(bad.remotes.map((r) => r.name), ["extra"], "an unknown key is reported; the entry still reads");
  assert.equal(bad.problems.length, 7);
  assert.ok(!bad.problems.join(" ").includes("sk-live"), "the secret's value is not in any message");
  assert.match(bad.problems.join("\n"), /https/);
  assert.equal(readRemotes([{ name: "a", card: CARD }, { name: "a", card: CARD }]).remotes.length, 1, "a name twice: the first");
  assert.match(readRemotes("invoice-checker").problems[0]!, /is a list/);
  assert.match(cardUrlProblem("not a url")!, /not a URL/);
  assert.equal(cardUrlProblem("http://localhost:3000/card.json"), null);
  assert.equal(remotesProblem([{ name: "ok", card: CARD }]), null);
  assert.match(remotesProblem([{ name: "x" }, { name: "y" }])!, /and 1 more/);
});

test("the secret-name shape is the vault's", () => {
  assert.equal(REMOTE_SECRET_NAME.source, SECRET_NAME.source);
});

test("the schema knows remotes: and checks it with readRemotes", () => {
  assert.ok(FRONTMATTER.agent.some((f) => f.key === "remotes"));
  const p = (data: Record<string, unknown>) => frontmatterProblems("agent", data, nearestField).map((x) => `${x.rule} ${x.key}`);
  assert.deepEqual(p({ remotes: [{ name: "invoice-checker", card: CARD, secret: "INVOICE_TOKEN" }] }), []);
  assert.deepEqual(p({ remotes: [{ name: "invoice-checker", card: "http://agents.example.com/c.json" }] }), ["config/invalid-value remotes"]);
  assert.deepEqual(p({ remotes: "invoice-checker" }), ["config/wrong-type remotes"]);
});

test("the network gains each card's own host, and only that: never a host the card names", () => {
  const remotes = parseRemotes([
    { name: "a", card: CARD },
    { name: "b", card: "https://B.Example.ORG:8443/card.json", secret: "B_TOKEN" },
  ]);
  assert.deepEqual(remoteNetworkHosts(remotes), ["agents.example.com", "b.example.org"]);
  const none = resolveNetwork({ agent: "none", readsWeb: false, implied: remoteNetworkHosts(remotes) });
  assert.deepEqual(none.hosts.sort(), ["agents.example.com", "b.example.org"], "level none: the declared cards and nothing else");
  assert.ok(networkAllows(none, "agents.example.com:443"));
  assert.ok(!networkAllows(none, "evil.example.net"), "a card pointing elsewhere adds nothing");
  assert.ok(!networkAllows(none, "sub.agents.example.com"), "the card's host, not its domain");
  const trusted = resolveNetwork({ readsWeb: false, implied: remoteNetworkHosts(remotes) });
  assert.deepEqual(trusted.implied.sort(), ["agents.example.com", "b.example.org"]);
});

test("limits: a2a counts messages sent, a2a.<tool> each tool, polling apart", () => {
  const [send, status, reply, cancel] = A2A_TOOLS as [string, string, string, string];
  assert.deepEqual(limitKeysFor(send, {}), ["calls", "a2a", "a2a.send"]);
  assert.deepEqual(limitKeysFor(reply, {}), ["calls", "a2a", "a2a.reply"]);
  assert.deepEqual(limitKeysFor(status, {}), ["calls", "a2a.status"]);
  assert.deepEqual(limitKeysFor(cancel, {}), ["calls", "a2a.cancel"]);
  assert.deepEqual(readLimits({ a2a: 3, "a2a.status": 10 }), { limits: { a2a: 3, "a2a.status": 10 }, problems: [] });
  assert.deepEqual(readLimits({ a2a: { status: 5 } }).limits, { "a2a.status": 5 }, "a nested block reads as dotted keys");
  assert.match(readLimits({ "a2a.poll": 2 }).problems[0]!, /a2a\.status/);
  const c = new CallCounter({ a2a: 1, "a2a.status": 2 });
  assert.equal(c.take(limitKeysFor(send, {})), null);
  assert.equal(c.take(limitKeysFor(status, {})), null);
  assert.equal(c.take(limitKeysFor(status, {})), null);
  assert.ok(c.take(limitKeysFor(status, {})), "the third poll is refused");
  assert.ok(c.take(limitKeysFor(reply, {})), "a reply is a second message: refused at a2a: 1");
  assert.deepEqual(limitKeyProblems({ a2a: 5, "a2a.status": 9 }, { known: [], granted: ["a2a"] }), []);
  assert.equal(limitKeyProblems({ a2a: 5 }, { known: [], granted: [] })[0]?.level, "warn", "no remotes: the limit never applies");
});

test("a status read is not a write; a send, a reply and a cancel are", () => {
  const [send, status, reply, cancel] = A2A_TOOLS as [string, string, string, string];
  assert.deepEqual(classifyCall(status, { handle: "a2a-1" }), { write: false });
  for (const t of [send, reply, cancel]) assert.equal(classifyCall(t, {}).write, true, t);
});

test("the prompt names remotes by the owner's words, never a URL", () => {
  const lines = remotesPromptLines(parseRemotes([{ name: "invoice-checker", card: CARD, description: "Checks invoices." }])).join("\n");
  assert.match(lines, /\*\*invoice-checker\*\* — Checks invoices\./);
  assert.ok(!lines.includes("agents.example.com"));
  assert.match(lines, /never send the same request again/i);
});

// ── the scanner ────────────────────────────────────────────────────────────

const doc = (front: string, body = "You do the work.") => `---\n${front}\n---\n\n${body}\n`;
const REMOTE = `remotes:\n  - name: checker\n    card: ${CARD}`;

test("lethal trifecta: an outside agent's reply is untrusted, and a message to one is a way out", () => {
  const trifecta = (front: string) => scanFiles([{ path: "agents/r/agent.md", content: doc(front) }]).filter((f) => f.rule === "security/lethal-trifecta");
  const found = trifecta(`name: r\n${REMOTE}\nsecrets: [CRM_TOKEN]\nnetwork: trusted`);
  assert.equal(found.length, 1, "reads a reply, holds a secret, can send to the remote");
  assert.match(found[0]!.message, /reads replies from outside agents \(checker\)/);
  assert.match(found[0]!.message, /a reply it reads can tell it/);
  assert.equal(trifecta(`name: r\n${REMOTE}\nnetwork: trusted`).length, 0, "nothing private: the remote's own token is the proxy's, not the agent's");
  assert.equal(trifecta(`name: r\nremotes:\n  - name: checker\n    card: ${CARD}\n    secret: CHECKER_TOKEN\nnetwork: trusted`).length, 0, "its own secret alone is not a leg");
  assert.equal(trifecta(`name: r\n${REMOTE}\nsecrets: [CRM_TOKEN]\nhooks: [guard]`).length, 0, "gated");
});

const PUBLISHED = (steps: string) => doc("a2a:\n  publish: true\n  description: Checks a lead", steps);

test("published flow: a step agent the caller could steer into sending what it holds", () => {
  const files = [
    { path: "agents/reader/agent.md", content: doc("name: reader\ntools: [read]") },
    { path: "agents/crm/agent.md", content: doc("name: crm\nsecrets: [CRM_TOKEN]\nnetwork: open") },
    { path: "flows/leads.md", content: PUBLISHED("1. [[reader]] — Read the request.\n2. [[crm]] — Look the lead up.\n") },
    { path: "flows/private.md", content: doc("trigger: manual", "1. [[crm]] — Look the lead up.\n") },
  ];
  const found = scanFiles(files).filter((f) => f.rule === "security/published-flow-trifecta");
  assert.deepEqual(found.map((f) => [f.file, f.line]), [["flows/leads.md", 8]], "the published flow, at the step's line; the unpublished one is not this rule's");
  assert.match(found[0]!.message, /leads is published over A2A.*crm, which holds secret CRM_TOKEN and can reach an open network/);
  const quiet = scanFiles(files.map((f) => (f.path === "flows/leads.md" ? { ...f, content: doc("a2a:\n  publish: false", "1. [[crm]] — x\n") } : f)));
  assert.equal(quiet.filter((f) => f.rule.startsWith("security/published-flow")).length, 0, "publish: false publishes nothing");
});

test("published flow: an outward step with no person before it", () => {
  const files = (flow: string) => [
    { path: "agents/poster/agent.md", content: doc("name: poster\ntools: [post_x]\nnetwork: trusted") },
    { path: "agents/caller/agent.md", content: doc(`name: caller\n${REMOTE}\nnetwork: trusted`) },
    { path: "agents/drafter/agent.md", content: doc("name: drafter\ntools: [write]") },
    { path: "tools/post_x/tool.md", content: doc("name: post_x\noutward: true\ntransport: http\nbase: https://api.x.com") },
    { path: "flows/post.md", content: PUBLISHED(flow) },
  ];
  const ungated = (flow: string) => scanFiles(files(flow)).filter((f) => f.rule === "security/published-flow-ungated");
  const open = ungated("1. [[drafter]] — Draft it.\n2. [[poster]] — Post it.\n3. [[caller]] — Tell the partner.\n");
  assert.equal(open.length, 2, "the post and the message to an outside agent");
  assert.match(open[0]!.message, /step 2 \(\[\[poster\]\]\) can act outside the workspace \(outward tool post_x\)/);
  assert.match(open[1]!.message, /outside agent checker/);
  assert.equal(ungated("1. [[drafter]] — Draft it.\n2!. [[poster]] — Post it.\n3. [[caller]] — Tell the partner.\n").length, 0, "a gate holds every step after it");
  assert.equal(ungated("1!. [[drafter]] — Draft it.\n2. [[poster]] — Post it.\n").length, 0, "a gate before");
  assert.equal(ungated("1. [[drafter]] — Draft it.\n2. [[poster]] — Post it.\n   ask: Post this?\n").length, 0, "ask: is a gate with a question");
  assert.equal(ungated("1. [[drafter]] — Draft it.\n2. [[poster]] — Post it.\n   verify: contains: posted\n").length, 1, "a verify is not a person");
  // A gate on a parallel sibling parks the run before any step of the group
  // launches, so the sibling is held too; a later group's gate holds nothing.
  assert.equal(ungated("1. [[drafter]] — Draft it.\n2!. [[drafter]] — Check the draft.\n2. [[poster]] — Post it.\n").length, 0, "gated beside it");
  assert.equal(ungated("1. [[drafter]] — Draft it.\n2. [[poster]] — Post it.\n   ask: Post this?\n2. [[caller]] — Tell the partner.\n").length, 0, "an ask: beside it");
  assert.equal(ungated("1. [[poster]] — Post it.\n2!. [[drafter]] — Check it.\n").length, 1, "a gate after it is too late");
});
