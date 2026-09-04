// OpenAPI-typed API tools and per-step rate limits.
//
// An `openapi:` document turns one generic `call_<api>` tool into one typed
// tool per operation; a `rate:` makes calls over the limit wait. These tests
// cover the parse (pure), the load (file confinement, URL cache), the attach
// (a real workspace file), and the built tools against a local HTTP server —
// where a path param and a query param must land in the right places, and
// three calls at 2/s must take at least half a second.
//
//   node --test tests/openapi-tools.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import {
  parseOpenApi,
  loadOpenApiDocument,
  attachOperations,
  MAX_OPERATIONS,
} from "../packages/core/src/openapi.ts";
import { parseApis, parseRate, type ApiSpec } from "../packages/core/src/store.ts";
import { buildApiTools, typedToolName, TokenBucket } from "../packages/core/src/api-tools.ts";

const DOC = {
  openapi: "3.0.3",
  info: { title: "Contacts", version: "1" },
  components: {
    parameters: {
      Limit: {
        name: "limit",
        in: "query",
        required: false,
        description: "Page size",
        schema: { type: "integer" },
      },
    },
    schemas: {
      Contact: {
        type: "object",
        required: ["email"],
        properties: { email: { type: "string" }, name: { type: "string" } },
      },
    },
    requestBodies: {
      Contact: {
        description: "The contact to create.",
        required: true,
        content: { "application/json": { schema: { $ref: "#/components/schemas/Contact" } } },
      },
    },
  },
  paths: {
    "/contacts": {
      get: {
        operationId: "listContacts",
        summary: "List contacts",
        parameters: [
          { $ref: "#/components/parameters/Limit" },
          { name: "X-Trace", in: "header", schema: { type: "string" }, description: "Trace id" },
        ],
      },
      post: {
        operationId: "createContact",
        summary: "Create a contact",
        requestBody: { $ref: "#/components/requestBodies/Contact" },
      },
    },
    "/contacts/{contactId}": {
      parameters: [{ name: "contactId", in: "path", required: true, schema: { type: "string" }, description: "The id" }],
      get: {
        operationId: "getContact",
        description: "Fetch one contact.\nMore detail here.",
        parameters: [{ name: "expand", in: "query", schema: { type: "boolean" } }],
      },
      delete: { operationId: "deleteContact", summary: "Delete a contact" },
      put: { summary: "Replace a contact", requestBody: { content: { "application/json": { schema: { type: "object" } } } } },
    },
  },
};

test("parseOpenApi: params, $ref, body, method filter, derived ids", () => {
  const { operations, warnings } = parseOpenApi(DOC, { methods: ["GET", "POST", "PUT"] });
  assert.deepEqual(warnings, []);
  assert.deepEqual(
    operations.map((o) => o.id),
    ["listContacts", "createContact", "getContact", "put_contacts_contactId"],
    "DELETE is filtered out by the method allowlist; the PUT without an operationId gets a derived id",
  );

  const list = operations.find((o) => o.id === "listContacts")!;
  assert.equal(list.method, "GET");
  assert.equal(list.path, "/contacts");
  const limit = list.params.find((p) => p.name === "limit")!;
  assert.deepEqual(limit, { name: "limit", in: "query", required: false, type: "integer", description: "Page size" });
  const trace = list.params.find((p) => p.name === "X-Trace")!;
  assert.equal(trace.in, "header");
  assert.equal(list.hasBody, false);

  const create = operations.find((o) => o.id === "createContact")!;
  assert.equal(create.hasBody, true);
  assert.match(create.bodyDescription, /The contact to create/);
  assert.match(create.bodyDescription, /Fields: email, name \(required: email\)/, "the $ref'd schema's fields are named");

  const get = operations.find((o) => o.id === "getContact")!;
  assert.equal(get.summary, "Fetch one contact.", "first line of the description stands in for a summary");
  const id = get.params.find((p) => p.name === "contactId")!;
  assert.equal(id.in, "path");
  assert.equal(id.required, true, "path-level parameters are inherited");
  assert.equal(get.params.find((p) => p.name === "expand")!.type, "boolean");
});

test("parseOpenApi: the allowlist takes operationIds and METHOD /path, and names what it cannot find", () => {
  const { operations, warnings } = parseOpenApi(DOC, {
    methods: ["GET", "POST"],
    operations: ["getContact", "POST /contacts", "deleteContact", "nope"],
  });
  assert.deepEqual(operations.map((o) => o.id), ["getContact", "createContact"]);
  assert.equal(warnings.length, 2);
  assert.match(warnings[0], /deleteContact.*method the API does not allow/);
  assert.match(warnings[1], /"nope" is not in the OpenAPI document/);
});

test("parseOpenApi: capped at 60 with a warning, and a non-document is a warning not a throw", () => {
  const paths: Record<string, unknown> = {};
  for (let i = 0; i < 70; i++) paths[`/things/${i}`] = { get: { operationId: `thing${i}` } };
  const big = parseOpenApi({ openapi: "3.1.0", paths }, { methods: ["GET"] });
  assert.equal(big.operations.length, MAX_OPERATIONS);
  assert.match(big.warnings[0], /70 operations.*first 60/);

  const bad = parseOpenApi("not a doc", { methods: ["GET"] });
  assert.deepEqual(bad.operations, []);
  assert.match(bad.warnings[0], /no `paths`/);
});

test("parseApis reads openapi, operations and rate; parseRate rejects nonsense", () => {
  const [api] = parseApis([
    { name: "crm", base: "https://api.example.com/v1/", openapi: "tools/crm/openapi.yaml", operations: ["getContact"], rate: "100/m" },
  ]);
  assert.equal(api.openapi, "tools/crm/openapi.yaml");
  assert.deepEqual(api.operations, ["getContact"]);
  assert.equal(api.rate!.count, 100);
  assert.ok(Math.abs(api.rate!.perSec - 100 / 60) < 1e-9);
  assert.equal(api.resolvedOperations, undefined, "parseApis never resolves the document");

  assert.deepEqual(parseRate("5/s"), { count: 5, perSec: 5 });
  assert.deepEqual(parseRate("1000/h"), { count: 1000, perSec: 1000 / 3600 });
  assert.equal(parseRate("fast"), null);
  assert.equal(parseRate("0/s"), null);
  assert.equal(parseRate("5/fortnight"), null);
  const [plain] = parseApis([{ name: "x", base: "https://x", rate: "banana" }]);
  assert.equal(plain.rate, undefined, "an unreadable rate is ignored, not guessed");
  assert.equal(plain.operations, undefined);
});

test("loadOpenApiDocument reads YAML from the workspace and refuses to leave it", () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-openapi-"));
  fs.mkdirSync(path.join(ws, "tools", "crm"), { recursive: true });
  fs.writeFileSync(
    path.join(ws, "tools", "crm", "openapi.yaml"),
    "openapi: 3.0.0\npaths:\n  /ping:\n    get:\n      operationId: ping\n      summary: Ping\n",
  );
  fs.writeFileSync(path.join(path.dirname(ws), "outside-openapi.json"), JSON.stringify(DOC));

  const ok = loadOpenApiDocument("t", ws, "tools/crm/openapi.yaml");
  assert.equal(ok.error, null);
  assert.ok((ok.doc as { paths: object }).paths, "YAML parsed");

  const escape = loadOpenApiDocument("t", ws, "../outside-openapi.json");
  assert.equal(escape.doc, null);
  assert.match(escape.error!, /escapes the workspace/);

  const absolute = loadOpenApiDocument("t", ws, path.join(path.dirname(ws), "outside-openapi.json"));
  assert.match(absolute.error!, /escapes the workspace/);

  const missing = loadOpenApiDocument("t", ws, "tools/crm/nope.json");
  assert.match(missing.error!, /no such file/);

  const prevData = process.env.FOLDRUN_DATA;
  process.env.FOLDRUN_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-data-"));
  try {
    const url = loadOpenApiDocument("t", ws, "https://example.com/openapi.json");
    assert.equal(url.doc, null);
    assert.match(url.error!, /not cached yet — prefetchOpenApi/);
    const plain = loadOpenApiDocument("t", ws, "http://example.com/openapi.json");
    assert.match(plain.error!, /only https/);
  } finally {
    if (prevData === undefined) delete process.env.FOLDRUN_DATA;
    else process.env.FOLDRUN_DATA = prevData;
  }
});

test("attachOperations fills resolvedOperations from a workspace file, warns and passes through otherwise", () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-openapi-"));
  fs.mkdirSync(path.join(ws, "tools", "crm"), { recursive: true });
  fs.writeFileSync(path.join(ws, "tools", "crm", "openapi.json"), JSON.stringify(DOC));

  const specs = parseApis([
    { name: "crm", base: "https://api.example.com", methods: ["GET", "POST"], openapi: "tools/crm/openapi.json" },
    { name: "gone", base: "https://api.example.com", openapi: "tools/gone/openapi.json" },
    { name: "plain", base: "https://api.example.com" },
  ]);
  const { specs: out, warnings } = attachOperations(specs, "t", ws);
  assert.deepEqual(out[0].resolvedOperations!.map((o) => o.id), ["listContacts", "createContact", "getContact"]);
  assert.equal(out[1].resolvedOperations, undefined, "a missing document leaves the generic tool in place");
  assert.equal(out[2].resolvedOperations, undefined);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /^api gone: openapi tools\/gone\/openapi.json: no such file/);
  assert.doesNotThrow(() => JSON.parse(JSON.stringify(out)), "plain JSON: it crosses into the container");
});

test("typedToolName stays under 64 chars without collisions", () => {
  assert.equal(typedToolName("crm", "getContact"), "crm_getContact");
  const long = "a".repeat(70);
  const a = typedToolName("crm", long + "1");
  const b = typedToolName("crm", long + "2");
  assert.ok(a.length <= 64 && b.length <= 64);
  assert.notEqual(a, b);
  assert.ok(a.startsWith("crm_aaaa"));
});

test("TokenBucket: a burst passes, the next call waits for the refill", async () => {
  const bucket = new TokenBucket(2, 2);
  const t0 = Date.now();
  await bucket.take();
  await bucket.take();
  assert.ok(Date.now() - t0 < 100, "the first two are immediate");
  const waited = await bucket.take();
  assert.ok(waited >= 400, `the third waits about half a second (waited ${waited}ms)`);
});

/** A local API that records what it was asked. */
function startServer(): Promise<{ base: string; requests: { method: string; url: string; headers: http.IncomingHttpHeaders; body: string }[]; close: () => void }> {
  const requests: { method: string; url: string; headers: http.IncomingHttpHeaders; body: string }[] = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      requests.push({ method: req.method!, url: req.url!, headers: req.headers, body });
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ok: true, url: req.url }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      resolve({ base: `http://127.0.0.1:${port}/v1`, requests, close: () => server.close() });
    });
  });
}

/** buildApiTools' server, spoken to the way the SDK speaks to it. */
async function connect(instance: { connect: (t: unknown) => Promise<void> }) {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await instance.connect(serverSide);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(clientSide);
  return client;
}

test("buildApiTools: typed tools route path, query and header params; the generic tool stays; rate spaces calls", async () => {
  const api = await startServer();
  try {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-openapi-"));
    fs.mkdirSync(path.join(ws, "tools", "crm"), { recursive: true });
    fs.writeFileSync(path.join(ws, "tools", "crm", "openapi.json"), JSON.stringify(DOC));
    const parsed = parseApis([
      {
        name: "crm",
        base: api.base,
        description: "Contacts.",
        methods: ["GET", "POST"],
        headers: { Authorization: "Bearer ${CRM_TOKEN}" },
        openapi: "tools/crm/openapi.json",
        rate: "2/s",
      },
    ]);
    const { specs } = attachOperations(parsed, "t", ws);
    const built = buildApiTools("t", specs, undefined, { env: { CRM_TOKEN: "sekrit" }, missing: [] });

    assert.deepEqual(built.toolNames, [
      "mcp__foldrun_apis__crm_listContacts",
      "mcp__foldrun_apis__crm_createContact",
      "mcp__foldrun_apis__crm_getContact",
      "mcp__foldrun_apis__call_crm",
    ]);
    assert.match(built.promptLines[0], /3 typed tools, plus `call_crm`/);
    assert.match(built.promptLines[0], /Rate limit 2\/1s/);
    assert.match(built.promptLines[3], /`crm_getContact` — Fetch one contact\./);

    const client = await connect(built.server!.instance as never);
    const listed = await client.listTools();
    const get = listed.tools.find((t) => t.name === "crm_getContact")!;
    const props = get.inputSchema.properties as Record<string, { type?: string; description?: string }>;
    assert.equal(props.contactId.type, "string");
    assert.equal(props.contactId.description, "The id");
    assert.equal(props.expand.type, "boolean");
    assert.deepEqual(get.inputSchema.required, ["contactId"], "only the path param is required");
    assert.match(get.description!, /waits its turn/);
    const create = listed.tools.find((t) => t.name === "crm_createContact")!;
    assert.ok((create.inputSchema.properties as Record<string, unknown>).body, "a requestBody becomes a body argument");

    const t0 = Date.now();
    const r1 = await client.callTool({ name: "crm_getContact", arguments: { contactId: "a/b 1", expand: true } });
    assert.equal(r1.isError, false);
    await client.callTool({ name: "crm_listContacts", arguments: { limit: 5, "X_Trace": "trace-1" } });
    await client.callTool({
      name: "crm_createContact",
      arguments: { body: JSON.stringify({ email: "x@example.com" }) },
    });
    const elapsed = Date.now() - t0;
    assert.ok(elapsed >= 450, `three calls at 2/s take at least ~500ms (took ${elapsed}ms)`);

    assert.equal(api.requests.length, 3);
    const [getReq, listReq, postReq] = api.requests;
    assert.equal(getReq.method, "GET");
    assert.equal(getReq.url, "/v1/contacts/a%2Fb%201?expand=true", "path param substituted and encoded; query param in the query string");
    assert.equal(getReq.headers.authorization, "Bearer sekrit", "the secret was injected, never seen by the agent");
    assert.equal(listReq.url, "/v1/contacts?limit=5");
    assert.equal(listReq.headers["x-trace"], "trace-1", "a header param lands in the headers");
    assert.equal(postReq.method, "POST");
    assert.equal(postReq.headers["content-type"], "application/json");
    assert.equal(postReq.body, '{"email":"x@example.com"}');

    // The schema marks contactId required, so MCP refuses this before the
    // handler runs — no request, no log line.
    const missing = await client.callTool({ name: "crm_getContact", arguments: {} });
    assert.equal(missing.isError, true, "a missing required path param is refused before any request");
    assert.equal(api.requests.length, 3);

    const generic = await client.callTool({ name: "call_crm", arguments: { method: "GET", path: "/anything", query: { q: "1" } } });
    assert.equal(generic.isError, false, "the escape hatch still works");
    assert.equal(api.requests.at(-1)!.url, "/v1/anything?q=1");

    const log = built.drainLog();
    assert.equal(log.length, 4);
    assert.match(log[0], /^GET \/v1\/contacts\/a%2Fb%201\?… → 200/);
    assert.match(log[2], /^POST \/v1\/contacts → 200/);
    assert.match(log[3], /^GET \/v1\/anything\?… → 200/);
    await client.close();
  } finally {
    api.close();
  }
});

test("buildApiTools: an explicit operations: list withholds the generic tool", async () => {
  const spec: ApiSpec = {
    name: "crm",
    base: "https://api.example.com",
    description: "",
    headers: {},
    query: {},
    methods: ["GET"],
    operations: ["getContact"],
    resolvedOperations: parseOpenApi(DOC, { methods: ["GET"], operations: ["getContact"] }).operations,
  };
  const built = buildApiTools("t", [spec], undefined, { env: {}, missing: [] });
  assert.deepEqual(built.toolNames, ["mcp__foldrun_apis__crm_getContact"]);
  assert.doesNotMatch(built.promptLines[0], /call_crm/);

  // …unless the document never resolved: then the generic tool is all there is.
  const unresolved = buildApiTools("t", [{ ...spec, resolvedOperations: undefined }], undefined, { env: {}, missing: [] });
  assert.deepEqual(unresolved.toolNames, ["mcp__foldrun_apis__call_crm"]);
});
