// An agent granted `web` with a `web:` block, run through a fake sandbox:
// what the step is handed is what the block says — the actions it may
// use, each provider's name and vault key, and a model provider's own
// search beside our tool. The older per-action keys still do the same and
// are named for rewrite on the record.
//
//   node --test tests/web-block-run.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startFlowRun, waitForRun } from "../src/runner.ts";
import { registerPlatform, platform } from "../src/platform.ts";
import type { FlowStep } from "../src/store.ts";
import type { RunInContainerArgs, ContainerStepOutcome } from "../src/run-container.ts";

const WEB_TOOL = "---\ntransport: script\nsecrets: proxied\nname: web\nrun: run.mjs\ndescription: the web\nargs:\n  action: which\n---\n";

async function runAgent(front: string) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-webblock-"));
  const prev = { data: process.env.FOLDRUN_DATA, iso: process.env.FOLDRUN_RUN_ISOLATION };
  process.env.FOLDRUN_DATA = root;
  process.env.FOLDRUN_RUN_ISOLATION = "fake";
  const prevIso = platform.isolation;
  const prevGallery = platform.galleryDir;
  const gallery = path.join(root, "gallery");
  fs.mkdirSync(path.join(gallery, "tools", "web"), { recursive: true });
  fs.writeFileSync(path.join(gallery, "tools", "web", "tool.md"), WEB_TOOL);
  fs.writeFileSync(path.join(gallery, "tools", "web", "run.mjs"), "");
  let seen: RunInContainerArgs | null = null;
  registerPlatform({
    isolation: { fake: async (args: RunInContainerArgs): Promise<ContainerStepOutcome> => { seen = args; return { status: "completed", result: "ok", costUsd: 0 }; } },
    galleryDir: () => gallery,
  });
  try {
    const ws = path.join(root, "acme/workspaces/desk");
    fs.mkdirSync(path.join(ws, "agents", "a"), { recursive: true });
    fs.writeFileSync(path.join(ws, "agents", "a", "agent.md"), `---\nname: a\ndescription: x\n${front}---\n\nWork.\n`);
    fs.mkdirSync(path.join(ws, "runs"), { recursive: true });
    fs.writeFileSync(path.join(ws, "AGENTS.md"), "---\nname: desk\n---\n");
    const step: FlowStep = { agent: "a", instruction: "go", group: 1, optional: false };
    const run = startFlowRun("acme", "desk", [step], "f");
    const { run: done } = await waitForRun("acme", "desk", run.id, 30_000);
    const events = done!.steps.flatMap((s) => s.events.map((e) => `${e.type}: ${e.text}`));
    return { args: seen as RunInContainerArgs | null, events };
  } finally {
    registerPlatform({ isolation: prevIso, galleryDir: prevGallery });
    for (const [k, v] of [["FOLDRUN_DATA", prev.data], ["FOLDRUN_RUN_ISOLATION", prev.iso]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test("web: a provider per action becomes its env and its declared key; actions: becomes the allow-list", async () => {
  const { args, events } = await runAgent("tools: [web]\nweb:\n  actions: [search, fetch, crawl, answer]\n  fetch: jina\n  crawl: firecrawl\n  answer: exa\n");
  assert.ok(args, events.join("\n"));
  const env = args!.env;
  assert.equal(env.FOLDRUN_WEB_ACTIONS, "search,fetch,crawl,answer");
  assert.equal(env.FOLDRUN_WEB_FETCH_VIA, "jina");
  assert.equal(env.FOLDRUN_WEB_CRAWL_VIA, "firecrawl");
  assert.equal(env.FOLDRUN_WEB_CRAWL_SECRET, "FIRECRAWL_API_KEY");
  assert.equal(env.FOLDRUN_WEB_ANSWER_VIA, "exa");
  assert.equal(env.FOLDRUN_WEB_SEARCH_VIA, undefined, "search unset: foldrun's own engine");
  assert.ok(args!.input.scripts.some((s) => s.name === "web"), "the web tool is granted");
  // Declared, and absent from the vault: said on the record, as for any key.
  assert.ok(events.some((e) => /secret FIRECRAWL_API_KEY is not set/.test(e)), events.join("\n"));
  assert.ok(events.some((e) => /secret EXA_API_KEY is not set/.test(e)), events.join("\n"));
});

test("a provider that cannot do the action is on the record, in the web: spelling", async () => {
  const { events } = await runAgent("tools: [web]\nweb:\n  monitor: brave\n  fetch: brave\n");
  assert.ok(events.some((e) => /error: web\.monitor: brave does not monitor here/.test(e)), events.join("\n"));
  assert.ok(events.some((e) => /error: web\.fetch: brave/.test(e)), events.join("\n"));
});

test("a model provider's own search sits beside our tool, and the tool is told to hand search over", async () => {
  const { args } = await runAgent("tools: [web]\nweb:\n  search: anthropic\n");
  assert.ok(args!.input.allowed.includes("WebSearch"), "Anthropic's server-side search is granted beside ours");
  assert.equal(args!.env.FOLDRUN_WEB_BUILTIN, "search=WebSearch");
});

test("the per-action keys and tools outside web are not read: an error each", async () => {
  const { args, events } = await runAgent("tools: [web_browse]\nweb_search: brave\n");
  assert.equal(args?.env.FOLDRUN_WEB_SEARCH_VIA, undefined, "web_search: is not read");
  assert.ok(events.some((e) => /error: web_search: is not a key — write `web: \{search: …\}`/.test(e)), events.join("\n"));
  assert.ok(events.some((e) => /error: .*web_browse/.test(e)), events.join("\n"));
});

test("a vendor's session block reaches the tool as JSON; your own proxy's secret is declared", async () => {
  const { args, events } = await runAgent("tools: [web]\nweb:\n  browse:\n    via: steel\n    session:\n      proxy: { own: MY_PROXY }\n      captcha: true\n      timeout: 10m\n");
  assert.equal(args!.env.FOLDRUN_BROWSER_VENDOR, "steel");
  assert.deepEqual(JSON.parse(args!.env.FOLDRUN_BROWSER_SESSION), { proxy: { own: "MY_PROXY" }, captcha: true, timeout: 600 });
  assert.ok(events.some((e) => /secret MY_PROXY is not set/.test(e)), events.join("\n"));
});

test("a session option the vendor has not got is on the record, and no session is sent", async () => {
  const { args, events } = await runAgent("tools: [web]\nweb:\n  browse:\n    via: steel\n    session:\n      region: eu\n");
  assert.equal(args!.env.FOLDRUN_BROWSER_SESSION, undefined);
  assert.ok(events.some((e) => /error: web\.browse\.session\.region: Steel has no such option/.test(e)), events.join("\n"));
});
