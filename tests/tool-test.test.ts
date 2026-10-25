// The "Test tool" button, and the one property that makes its answer mean
// anything: it must stand where a run stands.
//
//   node --test tests/tool-test.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";

import { testTool } from "../src/tool-test.ts";
import { workspaceTools } from "../src/store.ts";
import { setOAuth2Secret } from "../src/secrets.ts";

/** A throwaway installation with one workspace, for one callback. */
function withWorkspace(files: Record<string, string>, run: () => Promise<void>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-tooltest-"));
  const previous = process.env.FOLDRUN_DATA;
  process.env.FOLDRUN_DATA = root;
  return (async () => {
    try {
      for (const [rel, content] of Object.entries(files)) {
        const file = path.join(root, "acme/workspaces/desk", rel);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, content);
      }
      await run();
    } finally {
      if (previous === undefined) delete process.env.FOLDRUN_DATA;
      else process.env.FOLDRUN_DATA = previous;
      fs.rmSync(root, { recursive: true, force: true });
    }
  })();
}

// `path.resolve(process.cwd(), "..", "..", "state", f)` is the ordinary way a
// tool reaches workspace state, and it is correct only from an agent's own
// folder. Testing from the workspace root sent it to <data>/<tenant>/state —
// a real read of the wrong directory, which comes back as an empty result
// rather than an error. That is a worse answer than a failure: the button
// said the tool worked and showed nothing in it.
const PROGRAM = `import fs from "node:fs";
import path from "node:path";
const target = path.resolve(process.cwd(), "..", "..", "state", "rows.txt");
console.log(fs.existsSync(target) ? fs.readFileSync(target, "utf8").trim() : "NOT FOUND");
`;

const DEFINITION = `---
transport: script
name: rows
run: run.mjs
description: Reads the workspace's state the way every other tool does.
---

The program is beside this file.
`;

const AGENT = `---
name: keeper
description: Grants the tool under test.
tools: [rows]
---

work.
`;

test("a script tool is tested from an agent's folder, where a run runs", () =>
  withWorkspace(
    {
      "AGENTS.md": "---\nname: desk\n---\n",
      "agents/keeper/agent.md": AGENT,
      "state/rows.txt": "two live rows",
      "tools/rows/tool.md": DEFINITION,
      "tools/rows/run.mjs": PROGRAM,
    },
    async () => {
      const def = workspaceTools("acme", "desk").rows;
      const result = await testTool("acme", "desk", def);

      assert.equal(result.ok, true, `expected exit 0, got: ${result.summary}`);
      assert.match(
        result.detail,
        /two live rows/,
        "the tool read the workspace's state — from the workspace root it would find nothing",
      );
      // And the result says where it stood, so the output can be read.
      assert.match(result.detail, /ran from agents\/keeper\//);
    },
  ));

// Depth is what matters, but standing in the granting agent's folder is what
// makes the test the call that would actually happen — an agent's own
// scripts/, skills/ and memory/ are all resolved from there too.
test("the agent that granted the tool is the one stood in for", () =>
  withWorkspace(
    {
      "AGENTS.md": "---\nname: desk\n---\n",
      // Alphabetically first, and does NOT grant the tool.
      "agents/aaa-bystander/agent.md":
        "---\nname: aaa-bystander\ndescription: no grant.\n---\n\nwork.\n",
      "agents/keeper/agent.md": AGENT,
      "state/rows.txt": "two live rows",
      "tools/rows/tool.md": DEFINITION,
      "tools/rows/run.mjs": PROGRAM,
    },
    async () => {
      const def = workspaceTools("acme", "desk").rows;
      const result = await testTool("acme", "desk", def);
      assert.match(result.detail, /ran from agents\/keeper\//);
    },
  ));

// A workspace with no agents cannot run anything yet. The tester should still
// answer, and should say that its footing is not a run's footing rather than
// quietly reporting from the wrong depth.
test("with no agents, the tester says its footing is not a run's", () =>
  withWorkspace(
    {
      "AGENTS.md": "---\nname: desk\n---\n",
      "state/rows.txt": "two live rows",
      "tools/rows/tool.md": DEFINITION,
      "tools/rows/run.mjs": PROGRAM,
    },
    async () => {
      const def = workspaceTools("acme", "desk").rows;
      const result = await testTool("acme", "desk", def);
      assert.match(result.detail, /no agent to stand in for/);
    },
  ));

// ---- http tools with an `operations:` allowlist ----------------------------
// The tester used to append any path to `base:` and send it, so an allowlisted
// tool could be probed anywhere on the API: the one door the allowlist left
// open. It is bound now the way a run is.

const OPENAPI = JSON.stringify({
  openapi: "3.0.0",
  info: { title: "t", version: "1" },
  paths: {
    "/profile/": {
      get: { operationId: "getProfile", responses: { 200: { description: "ok" } } },
      patch: { operationId: "patchProfile", responses: { 200: { description: "ok" } } },
    },
    "/items/{id}": { get: { operationId: "getItem", parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }], responses: { 200: { description: "ok" } } } },
    "/feeds/popular": { get: { operationId: "popular", responses: { 200: { description: "ok" } } } },
  },
});

async function withServer(run: (base: string, hits: string[]) => Promise<void>) {
  const http = await import("node:http");
  const hits: string[] = [];
  const server = http.createServer((req, res) => {
    hits.push(`${req.method} ${req.url}`);
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  try {
    await run(`http://127.0.0.1:${port}`, hits);
  } finally {
    server.close();
  }
}

const httpTool = (base: string, operations: string) =>
  `---\ntransport: http\nname: prof\ndescription: t\nbase: ${base}\nmethods: [GET, PATCH]\nopenapi: tools/prof/openapi.json\n${operations}---\n`;

test("http: an operations: allowlist binds the tester to its GET operations", () =>
  withServer((base, hits) =>
    withWorkspace(
      { "tools/prof/tool.md": httpTool(base, "operations: [getProfile, patchProfile, getItem]\n"), "tools/prof/openapi.json": OPENAPI },
      async () => {
        const def = workspaceTools("acme", "desk").prof;

        const blank = await testTool("acme", "desk", def);
        assert.equal(blank.ok, true, blank.summary);
        assert.match(blank.summary, /^GET \/profile\/ → 200/, "no path: the first plain GET operation");

        const templated = await testTool("acme", "desk", def, { path: "/items/42" });
        assert.equal(templated.ok, true, templated.summary);

        const outside = await testTool("acme", "desk", def, { path: "/feeds/popular" });
        assert.equal(outside.ok, false);
        assert.match(outside.summary, /not one of the tool's GET operations/);

        assert.deepEqual(hits, ["GET /profile/", "GET /items/42"], "the refused path never left the host");
      },
    ),
  ));

test("http: an allowlist that resolves nothing fails the test, as it fails a run", () =>
  withServer((base, hits) =>
    withWorkspace(
      { "tools/prof/tool.md": httpTool(base, "operations: [getProfileV2]\n"), "tools/prof/openapi.json": OPENAPI },
      async () => {
        const result = await testTool("acme", "desk", workspaceTools("acme", "desk").prof, { path: "/profile/" });
        assert.equal(result.ok, false);
        assert.match(result.summary, /resolved no operations/);
        assert.match(result.detail, /getProfileV2/);
        assert.deepEqual(hits, []);
      },
    ),
  ));

test("http: without an allowlist the tester still probes any path under base", () =>
  withServer((base, hits) =>
    withWorkspace(
      { "tools/prof/tool.md": httpTool(base, ""), "tools/prof/openapi.json": OPENAPI },
      async () => {
        const result = await testTool("acme", "desk", workspaceTools("acme", "desk").prof, { path: "/feeds/popular" });
        assert.equal(result.ok, true, result.summary);
        assert.deepEqual(hits, ["GET /feeds/popular"]);
      },
    ),
  ));

// An oauth2 secret is stored as a recipe (`@oauth2 {token_url, …}`) and a run
// swaps it for a live access token just before the script starts. The tester
// did not, so a tool behind Google OAuth failed its Test button with its own
// "arrived unexchanged" guard while working in every run (gbp-desk
// review_candidates, 2026-09-28).
function tokenEndpoint(): Promise<{ url: string; close: () => void }> {
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const ok = new URLSearchParams(body).get("refresh_token") === "good-refresh";
      res.writeHead(ok ? 200 : 400, { "content-type": "application/json" });
      res.end(JSON.stringify(ok ? { access_token: "live-token", expires_in: 3600 } : { error: "invalid_grant" }));
    });
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      resolve({ url: `http://127.0.0.1:${port}/token`, close: () => server.close() });
    }),
  );
}

const OAUTH_TOOL = `---
transport: script
name: who
run: run.mjs
secrets: [G_TOKEN]
description: Prints what it was handed.
---
`;

for (const [refresh, expectOk] of [["good-refresh", true], ["revoked", false]] as const) {
  test(`script: an oauth2 secret reaches the tool as a live token (${refresh})`, async () => {
    const endpoint = await tokenEndpoint();
    try {
      await withWorkspace(
        {
          "AGENTS.md": "---\nname: desk\n---\n",
          "tools/who/tool.md": OAUTH_TOOL,
          "tools/who/run.mjs": 'console.log("token=" + process.env.G_TOKEN)\n',
        },
        async () => {
          setOAuth2Secret("acme", "G_TOKEN", { token_url: endpoint.url, client_id: "c", client_secret: "s", refresh_token: refresh }, "desk");
          const result = await testTool("acme", "desk", workspaceTools("acme", "desk").who);
          if (expectOk) {
            assert.equal(result.ok, true, result.summary + " " + result.detail);
            assert.match(result.detail, /token=live-token/);
            assert.doesNotMatch(result.detail, /@oauth2/);
          } else {
            assert.equal(result.ok, false);
            assert.equal(result.summary, "a secret could not be refreshed");
            assert.match(result.detail, /G_TOKEN/);
          }
        },
      );
    } finally {
      endpoint.close();
    }
  });
}

// A run hands a script its agent's `secrets:` as well as the tool's own.
// gbp_read declares none itself; its agent declares GBP_OAUTH. The tester
// said "GBP_OAUTH is not set" while every run of the same call worked.
test("a script tool is tested with the granting agent's secrets, not a bystander's", () =>
  withWorkspace(
    {
      "AGENTS.md": "---\nname: desk\n---\n",
      "agents/aaa-bystander/agent.md": "---\nname: aaa-bystander\ndescription: no grant.\nsecrets: [OTHER_KEY]\n---\n\nwork.\n",
      "agents/reader/agent.md": "---\nname: reader\ndescription: reads.\ntools: [peek]\nsecrets: [READ_KEY]\n---\n\nwork.\n",
      "tools/peek/tool.md": "---\ntransport: script\nname: peek\ndescription: says which keys it can see.\nrun: run.mjs\n---\n",
      "tools/peek/run.mjs": `console.log("READ_KEY=" + (process.env.READ_KEY ? "set" : "unset") + " OTHER_KEY=" + (process.env.OTHER_KEY ? "set" : "unset"));\n`,
    },
    async () => {
      const { setSecret } = await import("../src/secrets.ts");
      setSecret("acme", "READ_KEY", "r-value");
      setSecret("acme", "OTHER_KEY", "o-value");
      const result = await testTool("acme", "desk", workspaceTools("acme", "desk").peek);
      assert.equal(result.ok, true, result.detail);
      assert.match(result.detail, /READ_KEY=set OTHER_KEY=unset/);
    },
  ));

// Only `description:` reached the model, so agents invented what tool.md's
// body documented (5 Oct 2026). The body now rides with the tool.
test("a tool.md body reaches the model as the tool's guide; an inline program does not", async () => {
  const { parseToolDef, toolGuide, TOOL_GUIDE_MAX } = await import("../src/store.ts");
  const run = parseToolDef({ transport: "script", name: "peek", description: "peeks", run: "run.mjs" },
    "peek", "Call it as:\n\n```\npeek --x 1\n```\n\nIt refuses a suburb in a slug.");
  const g = (run!.spec as { guide?: string }).guide ?? "";
  assert.match(g, /refuses a suburb/);
  assert.match(g, /peek --x 1/, "a run: tool keeps its fenced examples");
  const inline = parseToolDef({ transport: "script", name: "one", description: "one file" },
    "one", "Use it for totals.\n\n```js\nconsole.log(1)\n```\n");
  const ig = (inline!.spec as { guide?: string }).guide ?? "";
  assert.match(ig, /Use it for totals/);
  assert.doesNotMatch(ig, /console\.log/, "the program is code, not guidance");
  assert.equal(toolGuide("   \n"), undefined);
  assert.ok(toolGuide("x".repeat(TOOL_GUIDE_MAX + 50))!.endsWith("[the rest of tool.md is cut here]"));
  const http = parseToolDef({ transport: "http", name: "self", base: "https://x.test/api", description: "runs" }, "self", "GET /runs?limit=200 lists runs.");
  assert.match((http!.spec as { guide?: string }).guide ?? "", /limit=200/);
});

test("the guide is in the description the model gets for a script tool", async () => {
  const { parseToolDef } = await import("../src/store.ts");
  const { parseScripts, buildScriptTools } = await import("../src/script-tools.ts");
  const def = parseToolDef({ transport: "script", name: "peek", description: "peeks", run: "run.mjs" }, "peek", "Never pass a suburb in a slug.");
  const [spec] = parseScripts([def!.spec]);
  assert.equal(spec.guide, "Never pass a suburb in a slug.");
  const built = buildScriptTools(os.tmpdir(), [spec], {});
  // The SDK server holds the tool; its description is what the model reads.
  const inst = (built.server as unknown as { instance?: { _registeredTools?: Record<string, { description?: string }> } }).instance;
  const desc = inst?._registeredTools?.peek?.description ?? JSON.stringify(built.server);
  assert.match(desc, /Never pass a suburb in a slug/);
});

// ---- through the platform's guard (FOL-85) ----------------------------------
// The tester runs on the web tier, which reaches the cluster's services and its
// own loopback, at a base: URL the tenant wrote. It used to call fetch() itself
// and show whatever answered. It goes through platform.fetchUntrusted now, as
// every other tenant URL does. The seam below stands in for the platform's
// (ssrf.ts, tested in foldrun-platform against these same addresses): it
// refuses internal hosts and lets `localhost` play a public one.

import { registerPlatform, resetPlatform } from "../src/platform.ts";
import type { ToolDef } from "../src/store.ts";

const INTERNAL = /^(127\.|10\.|169\.254\.|\[::ffff:|foldrun-postgres$)/;

async function withGuard(run: (seen: string[]) => Promise<void>) {
  const seen: string[] = [];
  registerPlatform({
    async fetchUntrusted(url, init) {
      seen.push(url);
      const host = new URL(url).hostname;
      if (INTERNAL.test(host)) throw new Error(`${host} is a private or internal address`);
      return fetch(url.replace("//localhost:", "//127.0.0.1:"), init);
    },
  });
  try {
    await run(seen);
  } finally {
    resetPlatform();
  }
}

/** A "public" server on localhost, answering by path. */
async function withPublic(routes: Record<string, (res: http.ServerResponse) => void>, run: (base: string) => Promise<void>) {
  const server = http.createServer((req, res) => (routes[req.url ?? ""] ?? ((r) => r.writeHead(404).end()))(res));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    await run(`http://localhost:${(server.address() as { port: number }).port}`);
  } finally {
    server.close();
  }
}

const plainHttpTool = (base: string, headers = "") => `---\ntransport: http\nname: api\ndescription: t\nbase: ${base}\nmethods: [GET]\n${headers}---\n`;

for (const base of ["http://127.0.0.1:3000", "http://10.43.0.1:443", "http://169.254.169.254/latest/meta-data", "http://[::ffff:7f00:1]:3900" /* ::ffff:127.0.0.1 as URL writes it */, "http://foldrun-postgres:5432"]) {
  test(`http: a base: inside the platform (${base}) is refused, not fetched`, () =>
    withGuard((seen) =>
      withWorkspace({ "tools/api/tool.md": plainHttpTool(base) }, async () => {
        const result = await testTool("acme", "desk", workspaceTools("acme", "desk").api, { path: "/" });
        assert.equal(result.ok, false);
        assert.match(result.summary, /private or internal address/);
        assert.equal(result.detail, "", "nothing from the far side is shown");
        assert.equal(seen.length, 1, "the one request went to the guard, which refused it");
      }),
    ));
}

test("http: a public base still answers, through the guard", () =>
  withGuard((seen) =>
    withPublic({ "/ping": (res) => res.writeHead(200, { "content-type": "text/plain" }).end("pong") }, (base) =>
      withWorkspace({ "tools/api/tool.md": plainHttpTool(base) }, async () => {
        const result = await testTool("acme", "desk", workspaceTools("acme", "desk").api, { path: "/ping" });
        assert.equal(result.ok, true, result.summary);
        assert.equal(result.detail, "pong");
        assert.deepEqual(seen, [`${base}/ping`]);
      }),
    ),
  ));

test("http: a public base that redirects to the metadata endpoint is refused at that hop", () =>
  withGuard((seen) =>
    withPublic({ "/x": (res) => res.writeHead(302, { location: "http://169.254.169.254/latest/meta-data/" }).end() }, (base) =>
      withWorkspace({ "tools/api/tool.md": plainHttpTool(base) }, async () => {
        const result = await testTool("acme", "desk", workspaceTools("acme", "desk").api, { path: "/x" });
        assert.equal(result.ok, false);
        // A redirect off the tool's origin is refused before the guard is even
        // asked: the probe carries the tool's secrets in its headers.
        assert.match(result.summary, /not followed: this request carries a credential/);
        assert.deepEqual(seen, [`${base}/x`], "the metadata endpoint was never asked");
      }),
    ),
  ));

test("http: an answer past 1 MiB is said, not shown, and not cut short as if whole", () =>
  withGuard(() =>
    withPublic({ "/big": (res) => res.writeHead(200, { "content-type": "text/plain" }).end("a".repeat(2 * 1024 * 1024)) }, (base) =>
      withWorkspace({ "tools/api/tool.md": plainHttpTool(base) }, async () => {
        const result = await testTool("acme", "desk", workspaceTools("acme", "desk").api, { path: "/big" });
        assert.equal(result.ok, true, "the status is the test");
        assert.match(result.detail, /larger than 1 MiB — not shown/);
        assert.doesNotMatch(result.detail, /aaaa/);
      }),
    ),
  ));

test("mcp: a remote server's url goes through the guard too", () =>
  withGuard(async (seen) => {
    const mcp = (url: string) => ({ kind: "mcp", name: "m", spec: { url } }) as unknown as ToolDef;
    const refused = await testTool("acme", "desk", mcp("http://10.43.0.1:443/mcp"));
    assert.equal(refused.ok, false);
    assert.match(refused.summary, /private or internal address/);
    await withPublic({ "/mcp": (res) => res.writeHead(200).end("{}") }, async (base) => {
      const ok = await testTool("acme", "desk", mcp(`${base}/mcp`));
      assert.equal(ok.ok, true, ok.summary);
    });
    assert.equal(seen.length, 2);
  }));
