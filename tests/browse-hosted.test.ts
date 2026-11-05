// FOL-110 phase 3 from the runner's side: a browsing step whose network: is
// restricted and enforced, on a platform that walls the step's network
// (Platform.confinesBrowsing), gets the forward proxy like any other step —
// so the executor walls its pod — and says "enforced — hosted"; one that
// names a vendor is refused before a sandbox; with the wall switched off,
// every browsing step is handed exactly what it was before phase 3.
// Exercised through a fake executor and a fake lease.
//
//   node --test tests/browse-hosted.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startFlowRun, waitForRun } from "../src/runner.ts";
import { registerPlatform, platform } from "../src/platform.ts";
import type { FlowStep } from "../src/store.ts";
import type { EgressLease } from "../src/egress.ts";
import type { RunInContainerArgs, ContainerStepOutcome } from "../src/run-container.ts";

const WEB_TOOL = "---\ntransport: script\nsecrets: proxied\nname: web\nrun: run.mjs\ndescription: the web\nargs:\n  action: which\n---\n";
const DOOR = "http://foldrun:tok_abcdefghijklmnop1234@egress.test:8090";

async function runAgent(opts: { front: string; confines: boolean; enforce?: boolean; workspace?: string }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-browse-hosted-"));
  const prev = { data: process.env.FOLDRUN_DATA, iso: process.env.FOLDRUN_RUN_ISOLATION, key: process.env.ANTHROPIC_API_KEY };
  process.env.FOLDRUN_DATA = root;
  process.env.FOLDRUN_RUN_ISOLATION = "fake";
  process.env.ANTHROPIC_API_KEY ??= "sk-ant-api03-test-key-0000000000";
  const before = { isolation: platform.isolation, gallery: platform.galleryDir, egress: platform.egress, confines: platform.confinesBrowsing };
  const gallery = path.join(root, "gallery");
  fs.mkdirSync(path.join(gallery, "tools", "web"), { recursive: true });
  fs.writeFileSync(path.join(gallery, "tools", "web", "tool.md"), WEB_TOOL);
  fs.writeFileSync(path.join(gallery, "tools", "web", "run.mjs"), "");
  let seen: RunInContainerArgs | null = null;
  const released: string[] = [];
  const lease = async (): Promise<EgressLease> =>
    ({
      url: "http://egress.test/e/tok",
      proxy: DOOR,
      ca: "-----BEGIN CERTIFICATE-----\nMA==\n-----END CERTIFICATE-----\n",
      enforce: opts.enforce ?? true,
      commit: async () => {},
      drainLog: async () => [],
      release: async () => {
        released.push("lease");
      },
    }) as unknown as EgressLease;
  registerPlatform({
    isolation: { fake: async (args: RunInContainerArgs): Promise<ContainerStepOutcome> => { seen = args; return { status: "completed", result: "ok", costUsd: 0 }; } },
    galleryDir: () => gallery,
    egress: { lease },
    confinesBrowsing: (kind) => opts.confines && kind === "fake",
  });
  try {
    const ws = path.join(root, "acme/workspaces/desk");
    fs.mkdirSync(path.join(ws, "agents", "a"), { recursive: true });
    fs.writeFileSync(path.join(ws, "agents", "a", "agent.md"), `---\nname: a\ndescription: x\n${opts.front}---\n\nWork.\n`);
    fs.mkdirSync(path.join(ws, "runs"), { recursive: true });
    fs.writeFileSync(path.join(ws, "AGENTS.md"), opts.workspace ?? "---\nname: desk\n---\n");
    const step: FlowStep = { agent: "a", instruction: "go", group: 1, optional: false };
    const run = startFlowRun("acme", "desk", [step], "f");
    const { run: done } = await waitForRun("acme", "desk", run.id, 30_000);
    const events = done!.steps.flatMap((s) => s.events.map((e) => `${e.type}: ${e.text}`));
    return { args: seen as RunInContainerArgs | null, events, status: done!.steps[0]!.status, released };
  } finally {
    registerPlatform({ isolation: before.isolation, galleryDir: before.gallery, egress: before.egress, confinesBrowsing: before.confines });
    for (const [k, v] of [["FOLDRUN_DATA", prev.data], ["FOLDRUN_RUN_ISOLATION", prev.iso], ["ANTHROPIC_API_KEY", prev.key]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const BROWSER = "tools: [web]\nnetwork: trusted\n";

test("held: the browsing step gets the forward door, a walled network and the confined flag", async () => {
  const { args, events } = await runAgent({ front: BROWSER, confines: true });
  assert.ok(args, events.join("\n"));
  assert.equal(args!.env.HTTPS_PROXY, DOOR, "the forward door, as for any other step");
  assert.equal(args!.env.FOLDRUN_BROWSER_CONFINED, "1");
  assert.ok(args!.env.FOLDRUN_EGRESS_CA, "the CA, for the browser to trust on intercepted hosts");
  assert.deepEqual(args!.network, { level: "trusted", enforced: true }, "the executor walls it (filtered)");
  assert.ok(events.some((e) => /enforced — hosted: the browser runs inside this step's sandbox/.test(e)), events.join("\n"));
  assert.ok(!events.some((e) => /not enforced in this step/.test(e)));
});

test("switch off: exactly as before phase 3 — no proxy, no wall, said as not enforced", async () => {
  const { args, events } = await runAgent({ front: BROWSER, confines: false });
  assert.ok(args, events.join("\n"));
  assert.equal(args!.env.HTTPS_PROXY, undefined);
  assert.equal(args!.env.FOLDRUN_BROWSER_CONFINED, undefined);
  assert.equal(args!.env.FOLDRUN_EGRESS_CA, undefined);
  assert.deepEqual(args!.network, { level: "trusted", enforced: false });
  assert.ok(events.some((e) => /not enforced in this step: it may browse/.test(e)), events.join("\n"));
});

test("an open list, or a report-only one, is not held even with the wall on", async () => {
  for (const o of [{ front: "tools: [web]\n", enforce: true }, { front: BROWSER, enforce: false }]) {
    const { args, events } = await runAgent({ ...o, confines: true });
    assert.equal(args!.env.HTTPS_PROXY, undefined, o.front);
    assert.equal(args!.env.FOLDRUN_BROWSER_CONFINED, undefined);
    assert.ok(events.some((e) => /not enforced in this step/.test(e)), events.join("\n"));
  }
});

test("a step that does not browse is untouched by the switch", async () => {
  for (const confines of [true, false]) {
    const { args } = await runAgent({ front: "tools: [web]\nnetwork: trusted\nweb: {actions: [search, fetch]}\n", confines });
    assert.equal(args!.env.HTTPS_PROXY, DOOR, "it always had the door");
    assert.equal(args!.env.FOLDRUN_BROWSER_CONFINED, undefined);
  }
});

test("held, with a vendor's browser: refused before a sandbox, the lease released, the way out said", async () => {
  const { args, events, status, released } = await runAgent({ front: `${BROWSER}web: {browse: browserbase}\n`, confines: true });
  assert.equal(args, null, "no sandbox");
  assert.equal(status, "failed");
  assert.deepEqual(released, ["lease"]);
  assert.ok(events.some((e) => /^error: browse: refused before it connected .* Browserbase .* Drop browse: browserbase/.test(e)), events.join("\n"));
});

test("the same vendor with the wall off runs as it did", async () => {
  const { args, status } = await runAgent({ front: `${BROWSER}web: {browse: browserbase}\n`, confines: false });
  assert.ok(args);
  assert.equal(status, "completed");
  assert.equal(args!.env.FOLDRUN_BROWSER_VENDOR, "browserbase");
});
