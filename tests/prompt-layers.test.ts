// The system prompt in layers: stable text first, then what changes between
// runs — and the record of each layer that lets a later reader say why the
// model's cache missed.
//
//   node --test tests/prompt-layers.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PromptLayers, promptLayersChanged, promptCacheNote, promptCacheKey, hashLayer } from "../src/prompt-layers.ts";

test("stable layers come first, dynamic ones last, each in the order it was added", () => {
  const p = new PromptLayers();
  p.add("persona", "You research.");
  p.add("memory", "# Memory\n\n- a fact", { dynamic: true });
  p.add("knowledge", "# Knowledge\n\n- a file");
  p.add("clock", "Today is 2026-10-20.", { dynamic: true });
  p.add("rules", "Write to storage.");
  p.add("rules", "Open with the outcome.");
  p.add("skills", "");
  const out = p.assemble();
  assert.equal(
    out.text,
    "You research.\n\n# Knowledge\n\n- a file\n\nWrite to storage.\n\nOpen with the outcome.\n\n# Memory\n\n- a fact\n\nToday is 2026-10-20.",
  );
  assert.ok(!out.text.includes("__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__"), "one string, no cache-split marker");
  assert.deepEqual(
    out.layers.map((l) => `${l.name}${l.stable === false ? "*" : ""}`),
    ["persona", "knowledge", "rules", "memory*", "clock*"],
    "an empty add is no layer",
  );
  const rules = out.layers.find((l) => l.name === "rules")!;
  assert.equal(rules.chars, "Write to storage.\n\nOpen with the outcome.".length);
  assert.equal(rules.hash, hashLayer("Write to storage.\n\nOpen with the outcome."));
});

test("the same text hashes the same, so two steps' layers compare by name", () => {
  const a = new PromptLayers();
  a.add("persona", "Same.");
  a.add("memory", "- one", { dynamic: true });
  a.add("clock", "Today is Monday.", { dynamic: true });
  const b = new PromptLayers();
  b.add("persona", "Same.");
  b.add("memory", "- one\n- two", { dynamic: true });
  b.add("state", "- cursor.json", { dynamic: true });
  assert.deepEqual(promptLayersChanged(a.assemble().layers, b.assemble().layers).sort(), ["clock", "memory", "state"]);
  assert.deepEqual(promptLayersChanged(a.assemble().layers, a.assemble().layers), []);
  // A step from before the layers were recorded has nothing to compare.
  assert.deepEqual(promptLayersChanged(undefined, b.assemble().layers), []);
});

test("the cache note names the layers that changed since the agent's last step, and only for a step that wrote a lot", () => {
  const layers = (memory: string) => [
    { name: "persona", chars: 5, hash: "aaaaaaaaaaaa" },
    { name: "memory", chars: memory.length, hash: hashLayer(memory), stable: false as const },
  ];
  const steps = [
    { agent: "a", tokens: { input: 1000, output: 10, cacheRead: 0, cacheWrite: 1000 }, promptLayers: layers("one") },
    { agent: "b", tokens: { input: 1000, output: 10, cacheRead: 0, cacheWrite: 1000 }, promptLayers: layers("one") },
    { agent: "a", tokens: { input: 1000, output: 10, cacheRead: 900, cacheWrite: 50 }, promptLayers: layers("one") },
    { agent: "a", tokens: { input: 1000, output: 10, cacheRead: 300, cacheWrite: 700 }, promptLayers: layers("one\ntwo") },
    { agent: "a", tokens: { input: 1000, output: 10, cacheRead: 0, cacheWrite: 1000 }, promptLayers: layers("one\ntwo") },
    { agent: "a", tokens: { input: 1000, output: 10 }, promptLayers: layers("one\ntwo") },
    { agent: "a", tokens: { input: 1000, output: 10, cacheRead: 0, cacheWrite: 1000 } },
  ];
  assert.equal(promptCacheNote(steps, 0), "100% of input written to the cache — the agent's first step in this run");
  assert.equal(promptCacheNote(steps, 1), "100% of input written to the cache — the agent's first step in this run", "another agent's step is not a previous step");
  assert.equal(promptCacheNote(steps, 2), null, "a 5% write is the cache working");
  assert.equal(promptCacheNote(steps, 3), "70% of input written to the cache — memory changed since step 3");
  assert.equal(promptCacheNote(steps, 4), "100% of input written to the cache — the same prompt as step 4; the entry had expired or was still being written");
  assert.equal(promptCacheNote(steps, 5), null, "no split on the record, no note");
  assert.equal(promptCacheNote(steps, 6), null, "no layers on the record, no note");
});

test("the provider cache key is per agent, stable, and short enough for the parameter", () => {
  const k = promptCacheKey("acme", "desk", "researcher");
  assert.equal(k, promptCacheKey("acme", "desk", "researcher"));
  assert.notEqual(k, promptCacheKey("acme", "desk", "writer"));
  assert.notEqual(k, promptCacheKey("other", "desk", "researcher"));
  assert.ok(k.length <= 64);
  assert.match(k, /^fr-[0-9a-f]{32}$/);
});

test("agentContext puts the agent's prose, knowledge and rules before the boundary and memory, state and the clock after", async () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), "pl-ctx-"));
  const prev = process.env.FOLDRUN_DATA;
  process.env.FOLDRUN_DATA = data;
  try {
    const { agentContext } = await import("../src/runner.ts");
    const ws = path.join(data, "acme", "workspaces", "desk");
    const dir = path.join(ws, "agents", "researcher");
    fs.mkdirSync(path.join(dir, "memory"), { recursive: true });
    fs.mkdirSync(path.join(dir, "knowledge"), { recursive: true });
    fs.mkdirSync(path.join(ws, "state"), { recursive: true });
    fs.writeFileSync(path.join(dir, "agent.md"), "---\nname: researcher\ntools: [files]\n---\n\nYou find sources.\n");
    fs.writeFileSync(path.join(dir, "memory", "pricing.md"), "---\nname: pricing\ndescription: what we charge\n---\n\n$5.\n");
    fs.writeFileSync(path.join(dir, "knowledge", "style.md"), "---\nname: style\ndescription: house style\n---\n\nPlain.\n");
    fs.writeFileSync(path.join(ws, "state", "cursor.json"), "{}");
    fs.writeFileSync(path.join(ws, "AGENTS.md"), "---\nname: desk\n---\n\nThe desk's context.\n");
    const ctx = agentContext(dir, "acme", [], {}, null, true) as {
      systemPrompt: string;
      promptLayers: { name: string; stable?: false }[];
    };
    const p = ctx.systemPrompt;
    assert.ok(p.startsWith("You find sources."), "the persona opens the prompt");
    assert.ok(!p.includes("__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__"));
    const firstDynamic = p.indexOf("# Memory");
    assert.ok(firstDynamic > 0);
    for (const s of ["The desk's context.", "# Knowledge", "house style", "Write deliverables for people"]) {
      assert.ok(p.indexOf(s) >= 0 && p.indexOf(s) < firstDynamic, `before memory: ${s}`);
    }
    for (const d of ["what we charge", "# State", "workspace/state/cursor.json", "# Clock"]) {
      assert.ok(p.indexOf(d) > firstDynamic, `after the stable layers: ${d}`);
    }
    const dyn = ctx.promptLayers.filter((l) => l.stable === false).map((l) => l.name);
    assert.deepEqual(dyn, ["memory", "state", "clock"]);
    assert.ok(ctx.promptLayers.findIndex((l) => l.name === "rules") < ctx.promptLayers.findIndex((l) => l.name === "memory"));
  } finally {
    if (prev === undefined) delete process.env.FOLDRUN_DATA;
    else process.env.FOLDRUN_DATA = prev;
    fs.rmSync(data, { recursive: true, force: true });
  }
});
