// The catalogue: cache behaviour, and a gate that only ever fails on
// knowledge. The fixtures are the shape OpenRouter's /v1/models actually
// returns (probed live), trimmed to the fields we read.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  readCatalog,
  loadCatalog,
  lintFlowModels,
  clampEffort,
  checkModel,
  effortIgnored,
  catalogCost,
  isPresetRef,
  type Catalog,
} from "./src/catalog.ts";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "mdagent-catalog-"));
  process.env.MDAGENT_DATA = dir;
});
afterEach(() => {
  delete process.env.MDAGENT_DATA;
  fs.rmSync(dir, { recursive: true, force: true });
});

const BASE = "https://openrouter.example";

function seed(models: Catalog["models"], ageMs = 0): void {
  const file = path.join(dir, "catalog", "openrouter.example.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const catalog: Catalog = {
    baseUrl: BASE,
    fetchedAt: new Date(Date.now() - ageMs).toISOString(),
    models,
  };
  fs.writeFileSync(file, JSON.stringify(catalog));
}

const TOOLLESS = {
  id: "acme/prose-only",
  name: "Prose Only",
  contextLength: 8192,
  promptPrice: 0.000001,
  completionPrice: 0.000002,
  tools: false,
  reasoning: false,
  efforts: null,
};
const TOOLED = {
  id: "acme/agentic",
  name: "Agentic",
  contextLength: 128000,
  promptPrice: 0.000002,
  completionPrice: 0.00001,
  tools: true,
  reasoning: true,
  efforts: ["xhigh", "high", "medium", "low", "minimal"],
};

// ---------------------------------------------------------------- cache

test("a fresh cache is served without touching the network", async () => {
  seed([TOOLED]);
  const catalog = await loadCatalog(BASE); // BASE doesn't resolve — a fetch would fail loudly
  assert.equal(catalog?.models.length, 1);
  assert.equal(catalog?.models[0].id, "acme/agentic");
});

test("an expired cache survives a dead network — stale beats nothing", async () => {
  seed([TOOLED], 48 * 60 * 60 * 1000); // two days old, past the TTL
  const catalog = await loadCatalog(BASE); // refresh fails: host doesn't exist
  assert.equal(catalog?.models[0].id, "acme/agentic");
});

test("no cache and no network is null, not a throw", async () => {
  assert.equal(await loadCatalog(BASE), null);
  assert.equal(readCatalog(BASE), null);
});

// ---------------------------------------------------------------- gate

test("a model that cannot call tools fails a tool-using step, naming a fix", () => {
  seed([TOOLLESS, TOOLED]);
  const verdict = checkModel(readCatalog(BASE), "acme/prose-only", { tools: true });
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason!, /cannot call tools/);
  assert.match(verdict.reason!, /acme\/agentic/); // same vendor preferred
});

test("the same model passes a toolless step", () => {
  seed([TOOLLESS]);
  assert.equal(checkModel(readCatalog(BASE), "acme/prose-only", { tools: false }).ok, true);
});

test("the gate never blocks on ignorance", () => {
  seed([TOOLLESS]);
  const catalog = readCatalog(BASE);
  // Unknown id: the model call is the authority of last resort.
  assert.equal(checkModel(catalog, "nobody/heard-of-it", { tools: true }).ok, true);
  // Preset: settings live in the gateway's dashboard, opaque on purpose.
  assert.equal(checkModel(catalog, "@preset/prod-agents", { tools: true }).ok, true);
  assert.equal(isPresetRef("@preset/prod-agents"), true);
  // No catalogue at all — offline development must keep working.
  assert.equal(checkModel(null, "acme/prose-only", { tools: true }).ok, true);
});

test("effort on a model with no reasoning parameter is flagged, not fatal", () => {
  seed([TOOLLESS, TOOLED]);
  const catalog = readCatalog(BASE);
  assert.equal(effortIgnored(catalog, "acme/prose-only"), true);
  assert.equal(effortIgnored(catalog, "acme/agentic"), false);
  assert.equal(effortIgnored(catalog, "unknown/model"), false); // no opinion
});

// ---------------------------------------------------------------- pricing

test("cost comes from the gateway's own prices, or not at all", () => {
  seed([TOOLED]);
  const catalog = readCatalog(BASE);
  const usage = { inputTokens: 1000, outputTokens: 500 };
  // 1000 × 0.000002 + 500 × 0.00001
  assert.equal(catalogCost(catalog, "acme/agentic", usage), 0.002 + 0.005);
  assert.equal(catalogCost(catalog, "unknown/model", usage), null);
  assert.equal(catalogCost(null, "acme/agentic", usage), null);
});

// ---------------------------------------------------------------- lint

import { parseFlow } from "./src/store.ts";

const AGENTS = [
  { name: "writer", model: "acme/prose-only", usesTools: true },
  { name: "poet", model: "acme/prose-only", usesTools: false },
];

test("the gate's veto, raised in the editor: agent model can't do tools", () => {
  seed([TOOLLESS, TOOLED]);
  const flow = parseFlow("f.md", `---\nname: f\n---\n\n1. [[writer]] — draft it\n`);
  const warnings = lintFlowModels(flow, AGENTS, readCatalog(BASE));
  assert.equal(warnings.length, 1);
  assert.match(warnings[0].message, /writer.*acme\/prose-only.*cannot call tools/);
});

test("a toolless agent on a toolless model is fine — nothing to warn about", () => {
  seed([TOOLLESS]);
  const flow = parseFlow("f.md", `---\nname: f\n---\n\n1. [[poet]] — a haiku\n`);
  assert.deepEqual(lintFlowModels(flow, AGENTS, readCatalog(BASE)), []);
});

test("a step override rescues the agent's bad default", () => {
  seed([TOOLLESS, TOOLED]);
  const flow = parseFlow(
    "f.md",
    `---\nname: f\n---\n\n1. [[writer]] — draft it\n   model: acme/agentic\n`,
  );
  assert.deepEqual(lintFlowModels(flow, AGENTS, readCatalog(BASE)), []);
});

test("a tier remapped by the provider block is checked as the wire id", () => {
  seed([TOOLLESS, TOOLED]);
  const agents = [{ name: "writer", model: "fast", usesTools: true }];
  const flow = parseFlow("f.md", `---\nname: f\n---\n\n1. [[writer]] — go\n`);
  // fast → the gateway's toolless model: the lint must see through the tier.
  const bad = lintFlowModels(flow, agents, readCatalog(BASE), { fast: "acme/prose-only" });
  assert.equal(bad.length, 1);
  // Remapped to a capable one instead: clean.
  const good = lintFlowModels(flow, agents, readCatalog(BASE), { fast: "acme/agentic" });
  assert.deepEqual(good, []);
  // Unmapped, "haiku" is unknown to this catalogue: no opinion, no warning.
  assert.deepEqual(lintFlowModels(flow, agents, readCatalog(BASE)), []);
});

test("no catalogue, no lint — the editor works offline", () => {
  const flow = parseFlow("f.md", `---\nname: f\n---\n\n1. [[writer]] — draft it\n`);
  assert.deepEqual(lintFlowModels(flow, AGENTS, null), []);
});

// ---------------------------------------------------------------- effort fit

test("a supported level passes through silently", () => {
  seed([TOOLED]);
  const fit = clampEffort(readCatalog(BASE), "acme/agentic", "high");
  assert.deepEqual(fit, { effort: "high", note: null });
});

test("max on a model that tops out at xhigh runs as xhigh, said aloud", () => {
  seed([TOOLED]);
  const fit = clampEffort(readCatalog(BASE), "acme/agentic", "max");
  assert.equal(fit.effort, "xhigh");
  assert.match(fit.note!, /effort: max runs as xhigh/);
});

test("a model that does not reason drops effort, said aloud", () => {
  seed([TOOLLESS]);
  const fit = clampEffort(readCatalog(BASE), "acme/prose-only", "high");
  assert.equal(fit.effort, null);
  assert.match(fit.note!, /no reasoning parameter/);
});

test("no knowledge, no opinion — unknown model and absent catalogue pass through", () => {
  seed([TOOLED]);
  assert.deepEqual(clampEffort(readCatalog(BASE), "unknown/model", "max"), { effort: "max", note: null });
  assert.deepEqual(clampEffort(null, "acme/agentic", "max"), { effort: "max", note: null });
  assert.deepEqual(clampEffort(readCatalog(BASE), "acme/agentic", null), { effort: null, note: null });
});

test("a request below the floor climbs to the lowest supported level", () => {
  seed([
    { ...TOOLED, id: "acme/deep-only", efforts: ["max", "xhigh", "high"] },
  ]);
  const fit = clampEffort(readCatalog(BASE), "acme/deep-only", "low");
  assert.equal(fit.effort, "high");
  assert.match(fit.note!, /effort: low runs as high/);
});
