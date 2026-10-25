// The callers that read more than fetchUntrusted's 1 MiB default on purpose
// (FOL-85 review): a public OpenAPI spec (Stripe's is about 8 MB), a
// gateway's model list (OpenRouter's is about 800 KB and grows) and the
// online MCP check, whose own byte budget is 2 MB. Each asks for its own
// limit, and an answer past 1 MiB still loads.
//
//   node --test tests/untrusted-fetch-limits.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { registerPlatform, resetPlatform } from "../src/platform.ts";
import { MAX_BYTES } from "../src/untrusted-fetch.ts";
import { prefetchOpenApi, loadOpenApiDocument, OPENAPI_MAX_BYTES } from "../src/openapi.ts";
import { loadCatalog, CATALOG_MAX_BYTES } from "../src/catalog.ts";
import { mcpDescriptionFindings, ONLINE_MAX_BYTES } from "../src/online-checks.ts";

const pad = "x".repeat(MAX_BYTES + 1024);

async function withSeam(answer: (url: string) => Response, body: (asked: Map<string, number | undefined>) => Promise<void>) {
  const asked = new Map<string, number | undefined>();
  const prev = process.env.FOLDRUN_DATA;
  process.env.FOLDRUN_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-limits-"));
  registerPlatform({
    async fetchUntrusted(url, _init, opts) {
      asked.set(url, opts?.maxBytes);
      return answer(url);
    },
  });
  try {
    await body(asked);
  } finally {
    resetPlatform();
    fs.rmSync(process.env.FOLDRUN_DATA!, { recursive: true, force: true });
    if (prev === undefined) delete process.env.FOLDRUN_DATA;
    else process.env.FOLDRUN_DATA = prev;
  }
}

test("an OpenAPI document past 1 MiB is fetched and cached whole", () =>
  withSeam(
    () => Response.json({ openapi: "3.0.0", info: { title: "big", version: "1", description: pad }, paths: { "/x": { get: { operationId: "getX" } } } }),
    async (asked) => {
      const url = "https://specs.example.com/openapi.json";
      assert.deepEqual(await prefetchOpenApi("default", [url]), []);
      assert.equal(asked.get(url), OPENAPI_MAX_BYTES);
      assert.ok(OPENAPI_MAX_BYTES > 13_502_446, "GitHub's REST spec fits");
      assert.ok(loadOpenApiDocument("default", "", url).doc, "the cached copy reads back");
    },
  ));

test("a model list past 1 MiB is read whole", () =>
  withSeam(
    () => Response.json({ data: [{ id: "big/model", name: "Big", description: pad }] }),
    async (asked) => {
      const catalog = await loadCatalog("https://gateway.example.com/api");
      assert.equal(catalog?.models[0]?.id, "big/model");
      assert.equal(asked.get("https://gateway.example.com/api/v1/models"), CATALOG_MAX_BYTES);
    },
  ));

test("the online MCP check asks the guard for its own byte budget, not the 1 MiB default", () =>
  withSeam(
    () => new Response("no", { status: 500 }),
    async (asked) => {
      const files = [{ path: "agents/a/agent.md", content: "---\nname: a\nmcpServers:\n  s:\n    url: https://mcp.example.com/mcp\n---\nx\n" }];
      await mcpDescriptionFindings(files);
      assert.equal(asked.get("https://mcp.example.com/mcp"), ONLINE_MAX_BYTES);
      assert.ok(ONLINE_MAX_BYTES > MAX_BYTES);
    },
  ));
