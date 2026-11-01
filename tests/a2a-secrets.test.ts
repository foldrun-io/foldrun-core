// A credential named only under `remotes:` reaches the a2a tools and nothing
// else — on the in-process path too, where scripts, Bash and consults are
// built from the step's secret environment on this host (Codex review,
// 1 Nov 2026). A secret the agent also declares stays the agent's to use.
//
//   node --test tests/a2a-secrets.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { agentContext, dropRetrySafe, buildSubagentSpecs } from "../src/runner.ts";
import { subagentGuard, subagentTools, isA2aTool } from "../src/subagents.ts";
import { A2A_TOOLS } from "../src/a2a-remotes.ts";
import { setSecret, getSecret, materializeSecrets } from "../src/secrets.ts";
import { buildA2ATools } from "../src/a2a-tools.ts";
import { buildApiTools } from "../src/api-tools.ts";
import { parseApis } from "../src/store.ts";
import type { RemoteSpec } from "../src/a2a-remotes.ts";

const TOKEN = "remote-tok-7f3a9c2e5b1d";
const OWN = "own-key-4c8e1a7b3f9d";

/** A remote that answers one SendMessage, completed, and remembers the auth. */
function remote() {
  const auth: (string | undefined)[] = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const self = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      auth.push(req.headers.authorization);
      if (req.method === "GET") {
        res.writeHead(200, { "content-type": "application/json" }).end(
          JSON.stringify({ name: "r", supportedInterfaces: [{ url: `${self}/rpc`, protocolBinding: "JSONRPC", protocolVersion: "1.0" }] }),
        );
        return;
      }
      const rpc = JSON.parse(body);
      res.writeHead(200, { "content-type": "application/json" }).end(
        JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result: { task: { id: "t1", status: { state: "TASK_STATE_COMPLETED" }, artifacts: [{ artifactId: "a", parts: [{ text: "ok" }] }] } } }),
      );
    });
  });
  return new Promise<{ url: string; auth: (string | undefined)[]; close: () => Promise<void> }>((resolve) =>
    server.listen(0, "127.0.0.1", () =>
      resolve({ url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, auth, close: () => new Promise((r) => server.close(() => r())) }),
    ),
  );
}

async function connect(instance: { connect: (t: unknown) => Promise<void> }) {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await instance.connect(serverSide);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(clientSide);
  return client;
}

test("in-process: a remote-only secret is in no script's environment, and the a2a tools still authenticate with it", async () => {
  const r = await remote();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-a2a-secrets-"));
  const prev = process.env.FOLDRUN_DATA;
  process.env.FOLDRUN_DATA = root;
  try {
    const ws = path.join(root, "acme/workspaces/desk");
    const agentDir = path.join(ws, "agents/caller");
    fs.mkdirSync(agentDir, { recursive: true });
    fs.mkdirSync(path.join(ws, "runs"), { recursive: true });
    fs.writeFileSync(path.join(ws, "AGENTS.md"), "---\nname: desk\n---\n");
    // The script prints which of the two names its environment holds.
    const dump = "console.log(JSON.stringify({ remote: process.env.CHECKER_TOKEN ?? null, own: process.env.OWN_KEY ?? null }))";
    fs.writeFileSync(
      path.join(agentDir, "agent.md"),
      "---\nname: caller\ndescription: calls\nsecrets: [OWN_KEY]\n" +
        `remotes:\n  - name: checker\n    card: ${r.url}/.well-known/agent-card.json\n    secret: CHECKER_TOKEN\n` +
        `scripts:\n  - name: dump\n    code: ${JSON.stringify(dump)}\n---\n\nCall it.\n`,
    );
    setSecret("acme", "CHECKER_TOKEN", TOKEN, "desk");
    setSecret("acme", "OWN_KEY", OWN, "desk");

    const ctx = agentContext(agentDir, "acme", [], { runId: "run-x", agent: "caller" }, null, true) as {
      secretEnv: Record<string, string>;
      remoteSecretEnv: Record<string, string>;
      remotes: RemoteSpec[];
      scriptTools: { server: { instance: { connect: (t: unknown) => Promise<void> } } | null };
      allowed: string[];
    };
    // What scripts, Bash, consults and stepSecrets are built from.
    assert.ok(!("CHECKER_TOKEN" in ctx.secretEnv), "a remote-only secret is not in the step's secret environment");
    assert.ok(!Object.values(ctx.secretEnv).includes(TOKEN));
    assert.equal(ctx.secretEnv.OWN_KEY, OWN, "a declared secret stays");
    assert.equal(ctx.remoteSecretEnv.CHECKER_TOKEN, TOKEN, "it is resolved apart, for the a2a tools");
    assert.ok(ctx.allowed.includes("mcp__foldrun_a2a__a2a_send"));

    // The script tool itself, run on this host.
    const client = await connect(ctx.scriptTools.server!.instance);
    const out = await client.callTool({ name: "dump", arguments: {} });
    const said = (out.content as { text: string }[]).map((c) => c.text).join("\n");
    assert.ok(!said.includes(TOKEN), said);
    assert.match(said, /"remote":null/);
    assert.match(said, new RegExp(`"own":"${OWN}"`));

    // The a2a tools as runStep builds them in process: the step's secret
    // environment and the remotes' own, and nothing more.
    const a2a = buildA2ATools("acme", ctx.remotes, "desk", { env: { ...ctx.secretEnv, ...ctx.remoteSecretEnv }, missing: [] }, { stateDir: null, runId: "run-x", step: 0 });
    const sent = await a2a.send({ remote: "checker", text: "check INV-7" });
    assert.match(sent.content[0]!.text, /state: completed/);
    assert.deepEqual([...new Set(r.auth)], [`Bearer ${TOKEN}`], "the card read and the send both carried it");
  } finally {
    if (prev === undefined) delete process.env.FOLDRUN_DATA;
    else process.env.FOLDRUN_DATA = prev;
    fs.rmSync(root, { recursive: true, force: true });
    await r.close();
  }
});

test("remotes: makes an agent act outward, so a retry after a failed check does not send the work again", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-a2a-outward-"));
  const prev = process.env.FOLDRUN_DATA;
  process.env.FOLDRUN_DATA = root;
  try {
    const ws = path.join(root, "acme/workspaces/desk");
    fs.mkdirSync(path.join(ws, "runs"), { recursive: true });
    fs.writeFileSync(path.join(ws, "AGENTS.md"), "---\nname: desk\n---\n");
    const agent = (name: string, extra: string) => {
      const dir = path.join(ws, "agents", name);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "agent.md"), `---\nname: ${name}\ndescription: d\n${extra}---\n\nWork.\n`);
      return (agentContext(dir, "acme", [], { agent: name }, null, true) as { outward: boolean }).outward;
    };
    const REMOTE = "remotes:\n  - name: checker\n    card: https://agents.example.com/.well-known/agent-card.json\n";
    const caller = agent("caller", REMOTE);
    assert.equal(caller, true, "a granted remote is a way to act outside the workspace");
    assert.equal(dropRetrySafe(caller, [{ type: "tool" }]), false, "after a tool ran, the step is not run again");
    assert.equal(agent("planner", `${REMOTE}permissionMode: plan\n`), false, "plan withholds the tools, so nothing is sent");
    assert.equal(agent("reader", "tools: [read]\n"), false);
  } finally {
    if (prev === undefined) delete process.env.FOLDRUN_DATA;
    else process.env.FOLDRUN_DATA = prev;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

/** A token endpoint that rotates: each refresh token works once, and its
 *  answer carries the next one. A spent one is invalid_grant. */
function rotatingTokens() {
  const used: string[] = [];
  const next: Record<string, [string, string]> = { r1: ["a1", "r2"], r2: ["a2", "r3"], r3: ["a3", "r4"] };
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const rt = new URLSearchParams(body).get("refresh_token") ?? "";
      used.push(rt);
      const hit = next[rt];
      if (!hit) return void res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ error: "invalid_grant" }));
      delete next[rt];
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ access_token: hit[0], refresh_token: hit[1], expires_in: 3600 }));
    });
  });
  return new Promise<{ url: string; used: string[]; close: () => Promise<void> }>((resolve) =>
    server.listen(0, "127.0.0.1", () =>
      resolve({ url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/token`, used, close: () => new Promise((r) => server.close(() => r())) }),
    ),
  );
}

test("an oauth2 remote secret with rotating refresh tokens: the a2a tools use the account's cached token and the vault's current recipe, and keep rotations", async () => {
  const r = await remote();
  const tokens = await rotatingTokens();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-a2a-oauth-"));
  const prev = process.env.FOLDRUN_DATA;
  const realNow = Date.now;
  process.env.FOLDRUN_DATA = root;
  try {
    fs.mkdirSync(path.join(root, "acme/workspaces/desk"), { recursive: true });
    const recipe = (rt: string) => "@oauth2 " + JSON.stringify({ token_url: tokens.url, client_id: "c", client_secret: "s", refresh_token: rt });
    setSecret("acme", "CHECKER_TOKEN", recipe("r1"), "desk", "oauth2");
    const started = getSecret("acme", "CHECKER_TOKEN", "desk")!.value;

    // The runner, at step start: made live in the account's scope. r1 is spent.
    const live = await materializeSecrets({ CHECKER_TOKEN: started }, { tenant: "acme", workspace: "desk" });
    assert.equal(live.CHECKER_TOKEN, "a1");
    assert.match(getSecret("acme", "CHECKER_TOKEN", "desk")!.value, /"refresh_token":"r2"/, "the rotation was kept");

    // The a2a tools hold the recipe the step started with (r1).
    const remotes = [{ name: "checker", card: `${r.url}/.well-known/agent-card.json`, origin: r.url, secret: "CHECKER_TOKEN", description: "" }];
    const a2a = buildA2ATools("acme", remotes, "desk", { env: { CHECKER_TOKEN: started }, missing: [] }, { stateDir: null, runId: "run-o", step: 0 });
    assert.match((await a2a.send({ remote: "checker", text: "one" })).content[0]!.text, /state: completed/);
    assert.deepEqual(tokens.used, ["r1"], "the runner's token, from the account's cache: no refresh with the spent r1");
    assert.equal(r.auth.at(-1), "Bearer a1");

    // An hour on: the token has expired; the tools refresh with the CURRENT one.
    Date.now = () => realNow() + 2 * 3600_000;
    assert.match((await a2a.send({ remote: "checker", text: "two" })).content[0]!.text, /state: completed/);
    assert.deepEqual(tokens.used, ["r1", "r2"]);
    assert.equal(r.auth.at(-1), "Bearer a2");
    assert.match(getSecret("acme", "CHECKER_TOKEN", "desk")!.value, /"refresh_token":"r3"/, "the tools' own rotation is written back");

    Date.now = () => realNow() + 4 * 3600_000;
    assert.match((await a2a.send({ remote: "checker", text: "three" })).content[0]!.text, /state: completed/);
    assert.deepEqual(tokens.used, ["r1", "r2", "r3"], "never a spent refresh token");
    assert.equal(r.auth.at(-1), "Bearer a3");
  } finally {
    Date.now = realNow;
    if (prev === undefined) delete process.env.FOLDRUN_DATA;
    else process.env.FOLDRUN_DATA = prev;
    fs.rmSync(root, { recursive: true, force: true });
    await r.close();
    await tokens.close();
  }
});

test("the API tools too: a rotating oauth2 secret is refreshed from the vault's current recipe, in the account's scope", async () => {
  const api = await remote();
  const tokens = await rotatingTokens();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-api-oauth-"));
  const prev = process.env.FOLDRUN_DATA;
  const realNow = Date.now;
  process.env.FOLDRUN_DATA = root;
  try {
    fs.mkdirSync(path.join(root, "acme/workspaces/desk"), { recursive: true });
    setSecret("acme", "API_TOKEN", "@oauth2 " + JSON.stringify({ token_url: tokens.url, client_id: "c", client_secret: "s", refresh_token: "r1" }), "desk", "oauth2");
    // The order a step runs in: agentContext builds the tools (reading r1),
    // then runStep makes the secrets live at step start (spending r1).
    const built = buildApiTools("acme", parseApis([{ name: "crm", base: api.url, headers: { authorization: "Bearer ${API_TOKEN}" } }]), "desk");
    await materializeSecrets({ API_TOKEN: getSecret("acme", "API_TOKEN", "desk")!.value }, { tenant: "acme", workspace: "desk" });
    const client = await connect(built.server!.instance as never);
    const call = async () => {
      const out = await client.callTool({ name: "call_crm", arguments: { method: "GET", path: "/x" } });
      return (out.content as { text: string }[])[0]!.text;
    };
    assert.match(await call(), /^HTTP 200/);
    assert.deepEqual(tokens.used, ["r1"], "the runner's token, from the account's cache");
    assert.equal(api.auth.at(-1), "Bearer a1");

    Date.now = () => realNow() + 2 * 3600_000;
    assert.match(await call(), /^HTTP 200/);
    assert.deepEqual(tokens.used, ["r1", "r2"], "refreshed with the current refresh token, not the spent r1");
    assert.equal(api.auth.at(-1), "Bearer a2");
    assert.match(getSecret("acme", "API_TOKEN", "desk")!.value, /"refresh_token":"r3"/);

    Date.now = () => realNow() + 4 * 3600_000;
    assert.match(await call(), /^HTTP 200/);
    assert.deepEqual(tokens.used, ["r1", "r2", "r3"]);
    assert.equal(api.auth.at(-1), "Bearer a3");
  } finally {
    Date.now = realNow;
    if (prev === undefined) delete process.env.FOLDRUN_DATA;
    else process.env.FOLDRUN_DATA = prev;
    fs.rmSync(root, { recursive: true, force: true });
    await api.close();
    await tokens.close();
  }
});

test("a shared-sandbox sub-agent never gets the parent's a2a tools — its own remotes: or not — and a call to one is refused", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-a2a-sub-"));
  const prev = process.env.FOLDRUN_DATA;
  process.env.FOLDRUN_DATA = root;
  try {
    const ws = path.join(root, "acme/workspaces/desk");
    fs.mkdirSync(path.join(ws, "runs"), { recursive: true });
    fs.writeFileSync(path.join(ws, "AGENTS.md"), "---\nname: desk\n---\n");
    const write = (name: string, front: string) => {
      fs.mkdirSync(path.join(ws, "agents", name), { recursive: true });
      fs.writeFileSync(path.join(ws, "agents", name, "agent.md"), `---\nname: ${name}\ndescription: ${name} does a job\n${front}---\n\nWork.\n`);
    };
    const card = (host: string) => `remotes:\n  - name: ${host}\n    card: https://${host}.example.com/.well-known/agent-card.json\n`;
    write("parent", `tools: [read]\n${card("payments")}subagents: [helper, plain, isolated]\n`);
    write("helper", `tools: [read]\n${card("partner")}`); // its own remotes — different from the parent's
    write("plain", "tools: [read]\n");
    write("isolated", `sandbox: own\n${card("partner")}`);

    const parent = agentContext(path.join(ws, "agents/parent"), "acme", [], { agent: "parent" }, null, true) as { allowed: string[] };
    assert.ok(A2A_TOOLS.every((t) => parent.allowed.includes(t)), "the parent holds them");
    const lines: string[] = [];
    const specs = buildSubagentSpecs({
      names: ["helper", "plain", "isolated"], self: "parent", workspaceRoot: ws, tenant: "acme",
      parentAllowed: parent.allowed, push: (_t, text) => lines.push(text),
    });
    assert.deepEqual(specs.map((s) => s.name), ["helper", "plain"], "sandbox: own is delegated as a step of its own, not here");
    for (const s of specs) assert.ok(!s.tools.some(isA2aTool), `${s.name} has no a2a tool`);
    assert.ok(specs[0]!.tools.includes("Read"));
    assert.match(specs[0]!.prompt, /remotes: are not available to shared-sandbox sub-agents yet/);
    assert.ok(!/Outside agents/.test(specs[1]!.prompt), "a sub-agent that declares none is not told");
    assert.ok(lines.some((l) => /"helper" declares remotes: \(partner\), which it does not get inside this step/.test(l)));

    // The guard: a delegated call to any a2a tool is refused, whatever the sub-agent declared.
    const guard = subagentGuard(specs);
    for (const sub of ["helper", "plain"]) {
      for (const t of A2A_TOOLS) {
        const why = guard({ agentId: "x", agentType: sub, tool: t, input: { remote: "payments", text: "pay it" } });
        assert.match(why ?? "", /not available to .*remotes: are not available to shared-sandbox sub-agents yet/, `${sub} ${t}`);
      }
    }
    assert.equal(guard({ agentId: "x", agentType: "helper", tool: "Read", input: {} }), null, "its other tools still work");
    assert.equal(guard({ tool: A2A_TOOLS[0]!, input: {} }), null, "the parent's own call is the parent's");
    assert.deepEqual(subagentTools([...A2A_TOOLS, "mcp__foldrun_a2a"], [...A2A_TOOLS, "mcp__foldrun_a2a"]), [], "never passed down, even held by name or as a server");

    // sandbox: own — a step of its own, from its own file: its OWN remotes only.
    const isolated = agentContext(path.join(ws, "agents/isolated"), "acme", [], { agent: "isolated" }, null, true) as { remotes: { name: string }[]; allowed: string[] };
    assert.deepEqual(isolated.remotes.map((r) => r.name), ["partner"]);
    assert.ok(A2A_TOOLS.every((t) => isolated.allowed.includes(t)));
  } finally {
    if (prev === undefined) delete process.env.FOLDRUN_DATA;
    else process.env.FOLDRUN_DATA = prev;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
