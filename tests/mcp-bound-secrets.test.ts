// A site-bound secret in a remote MCP server's headers or URL never enters the
// sandbox: the host fills unbound ones; a bound one goes back to ${NAME} for
// the egress proxy to fill, for that server's host only (FOL-160).
//
//   node --test tests/mcp-bound-secrets.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

test("headers and the URL: filled on the host; a bound secret back to its name, granted to the server's host", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-mcp-bound-"));
  const prev = process.env.FOLDRUN_DATA;
  process.env.FOLDRUN_DATA = root;
  try {
    fs.mkdirSync(path.join(root, "acme/workspaces/desk"), { recursive: true });
    const { setSecret } = await import("../src/secrets.ts");
    setSecret("acme", "MCP_KEY", "mcp-test-value-not-a-key");
    const { mcpConfig, unbindMcpHeaders } = await import("../src/runner.ts");
    const cfg = mcpConfig({ name: "crm", description: "", args: [], env: {}, url: "https://mcp.example.com/sse?key=${MCP_KEY}", headers: { authorization: "Bearer ${MCP_KEY}" } }, "acme", "desk") as { url: string; headers: Record<string, string> };
    assert.equal(cfg.url, "https://mcp.example.com/sse?key=mcp-test-value-not-a-key", "the host fills the URL");
    assert.equal(cfg.headers.authorization, "Bearer mcp-test-value-not-a-key");
    const grant = { secrets: {} } as never;
    const out = unbindMcpHeaders({ crm: cfg as never }, ["MCP_KEY"], { MCP_KEY: "mcp-test-value-not-a-key" }, grant) as Record<string, { url: string; headers: Record<string, string> }>;
    assert.equal(out.crm!.url, "https://mcp.example.com/sse?key=${MCP_KEY}", "a bound secret leaves the URL the sandbox sees");
    assert.equal(out.crm!.headers.authorization, "Bearer ${MCP_KEY}");
    assert.ok(!JSON.stringify(out).includes("mcp-test-value-not-a-key"), "the value is nowhere in what the sandbox gets");
    assert.deepEqual((grant as { secrets: Record<string, { hosts: string[] }> }).secrets.MCP_KEY!.hosts, ["mcp.example.com"], "granted to that host only");
    // A short value (Codex): put back by NAME from the server's text, not
    // found by value — and an unbound name beside it is still filled.
    setSecret("acme", "PIN", "abc");
    setSecret("acme", "TEAM", "team-42-unbound");
    const short = mcpConfig({ name: "s", description: "", args: [], env: {}, url: "https://pin.example.com/mcp?pin=${PIN}&team=${TEAM}", headers: { "x-pin": "${PIN}" } }, "acme", "desk");
    const g2 = { secrets: {} } as never;
    const o2 = unbindMcpHeaders({ s: short }, ["PIN"], { PIN: "abc" }, g2) as Record<string, { url: string; headers: Record<string, string> }>;
    assert.equal(o2.s!.url, "https://pin.example.com/mcp?pin=${PIN}&team=team-42-unbound");
    assert.equal(o2.s!.headers["x-pin"], "${PIN}");
    assert.ok(!JSON.stringify(o2).includes("=abc"), "the short value is not in what the sandbox gets");
    assert.deepEqual((g2 as { secrets: Record<string, { hosts: string[] }> }).secrets.PIN!.hosts, ["pin.example.com"]);
  } finally {
    if (prev === undefined) delete process.env.FOLDRUN_DATA;
    else process.env.FOLDRUN_DATA = prev;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("the runner's own path: a site-bound secret named only in an MCP server's URL reaches the sandbox as ${NAME}, granted to that host (Codex)", async () => {
  const { createFlowRun, driveRun } = await import("../src/runner.ts");
  const { readRun } = await import("../src/store.ts");
  const { registerPlatform, platform } = await import("../src/platform.ts");
  const { setSecret, setSecretSites } = await import("../src/secrets.ts");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-mcp-path-"));
  const prev = { data: process.env.FOLDRUN_DATA, iso: process.env.FOLDRUN_RUN_ISOLATION };
  const before = { isolation: platform.isolation, egress: platform.egress };
  process.env.FOLDRUN_DATA = root;
  process.env.FOLDRUN_RUN_ISOLATION = "fake";
  let seen: { mcp: unknown } | null = null;
  let granted: Record<string, { hosts: string[] }> = {};
  registerPlatform({
    isolation: {
      fake: async (args) => {
        seen = { mcp: (args.input as { mcpServers?: unknown }).mcpServers };
        return { status: "completed", result: "done", costUsd: 0, applied: [] };
      },
    },
    egress: {
      lease: async ({ grant }) => ({
        url: "http://proxy/e/tok",
        proxy: "http://foldrun:tok@proxy:8090",
        commit: async () => {
          granted = JSON.parse(JSON.stringify(grant.secrets));
        },
        drainLog: async () => [],
        release: async () => {},
      }),
    },
  });
  try {
    const ws = path.join(root, "acme/workspaces/desk");
    fs.mkdirSync(path.join(ws, "agents/a"), { recursive: true });
    fs.mkdirSync(path.join(ws, "runs"), { recursive: true });
    fs.writeFileSync(path.join(ws, "AGENTS.md"), "---\nname: desk\n---\n");
    fs.writeFileSync(path.join(ws, "agents/a/agent.md"), "---\nname: a\ndescription: x\nmcpServers:\n  crm:\n    url: https://mcp.crm.example/mcp?pin=${PIN}\n---\n\nWork.\n");
    setSecret("acme", "PIN", "abc");
    setSecretSites("acme", "PIN", ["mcp.crm.example"]);
    const run = createFlowRun("acme", "desk", [{ agent: "a", instruction: "go", group: 1, optional: false }], "f", "running");
    await driveRun("acme", "desk", readRun("acme", "desk", run.id)!);
    const url = (seen as unknown as { mcp: Record<string, { url: string }> }).mcp.crm.url;
    assert.equal(url, "https://mcp.crm.example/mcp?pin=${PIN}", "the sandbox holds the name, not the value");
    assert.deepEqual(granted.PIN?.hosts, ["mcp.crm.example"], "published to the proxy for that host");
  } finally {
    registerPlatform(before);
    for (const [k, v] of [["FOLDRUN_DATA", prev.data], ["FOLDRUN_RUN_ISOLATION", prev.iso]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a bound secret that names the server's address (the whole URL, or its host) is refused, not sent in and not left unroutable (Codex)", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-mcp-origin-"));
  const prev = process.env.FOLDRUN_DATA;
  process.env.FOLDRUN_DATA = root;
  try {
    fs.mkdirSync(path.join(root, "acme/workspaces/desk"), { recursive: true });
    const { setSecret } = await import("../src/secrets.ts");
    const { mcpConfig, unbindMcpHeaders } = await import("../src/runner.ts");
    setSecret("acme", "MCP_URL", "https://mcp.secret-host.example/mcp");
    setSecret("acme", "HOST", "mcp.other.example");
    for (const [url, name, value] of [["${MCP_URL}", "MCP_URL", "https://mcp.secret-host.example/mcp"], ["https://${HOST}/mcp", "HOST", "mcp.other.example"]] as const) {
      const cfg = mcpConfig({ name: "x", description: "", args: [], env: {}, url, headers: {} }, "acme", "desk");
      assert.throws(() => unbindMcpHeaders({ x: cfg }, [name], { [name]: value }, { secrets: {} } as never), /names part of the server's address/);
    }
  } finally {
    if (prev === undefined) delete process.env.FOLDRUN_DATA;
    else process.env.FOLDRUN_DATA = prev;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
