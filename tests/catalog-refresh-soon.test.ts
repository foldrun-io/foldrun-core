// refreshCatalogSoon: the editor's completions and the flows page refresh a
// gateway's catalogue behind the request, at most once per five minutes per
// gateway whether the fetch worked or not — a failing gateway was fetched
// again on every keystroke. 30 Oct 2026.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.FOLDRUN_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-catalog-soon-"));
const { refreshCatalogSoon, CATALOG_RETRY_MS } = await import("../src/catalog.ts");

test("one attempt per gateway per retry window, failed or not; another gateway is its own", async () => {
  let calls = 0;
  const failing = async () => {
    calls++;
    throw new Error("unreachable");
  };
  const t0 = 1_000_000;
  assert.equal(refreshCatalogSoon("https://gw.example.com", failing, t0), true);
  assert.equal(refreshCatalogSoon("https://gw.example.com", failing, t0 + 1), false, "in flight or just failed: not again");
  assert.equal(refreshCatalogSoon("https://gw.example.com", failing, t0 + CATALOG_RETRY_MS - 1), false);
  assert.equal(refreshCatalogSoon("https://other.example.com", failing, t0 + 1), true, "keyed by gateway");
  assert.equal(refreshCatalogSoon("https://gw.example.com", failing, t0 + CATALOG_RETRY_MS), true, "tried again once the window passes");
  await new Promise((r) => setImmediate(r));
  assert.equal(calls, 3);
});

test("a fresh catalogue on disk is never fetched for", () => {
  const base = "https://fresh.example.com";
  // The cache file loadCatalog writes: catalog/<hostname>.json under the data root.
  const file = path.join(process.env.FOLDRUN_DATA!, "catalog", "fresh.example.com.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ baseUrl: base, fetchedAt: new Date().toISOString(), models: [] }));
  let calls = 0;
  const load = async () => {
    calls++;
  };
  assert.equal(refreshCatalogSoon(base, load), false);
  assert.equal(calls, 0);
});
