// FOL-128 from the runner's side: a step walled to its list that searches
// our engine is given the proxy's search door on its grant (which the pod
// cannot write), with the door's address for the driver; a list narrow on
// purpose needs the action written out; a provider, an open list or a
// report-only one changes nothing. Through a fake executor and a fake lease.
//
//   node --test tests/search-door.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startFlowRun, waitForRun } from "../src/runner.ts";
import { registerPlatform, platform } from "../src/platform.ts";
import type { FlowStep } from "../src/store.ts";
import type { EgressGrant, EgressLease } from "../src/egress.ts";
import type { RunInContainerArgs, ContainerStepOutcome } from "../src/run-container.ts";
import { SEARCH_DOOR_ENV, SEARCH_DOOR_LINE, SEARCH_NONE_UNNAMED, SEARCH_NO_DEFAULTS_UNNAMED, searchDoorWanted, searchProvided } from "../src/search-egress.ts";

const WEB_TOOL = "---\ntransport: script\nsecrets: proxied\nname: web\nrun: run.mjs\ndescription: the web\nargs:\n  action: which\n---\n";
const DOOR = "http://foldrun:tok_abcdefghijklmnop1234@egress.test:8090";

async function runAgent(opts: { front: string; confines: boolean; enforce?: boolean; workspace?: string; walls?: boolean }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-search-door-"));
  const prev = { data: process.env.FOLDRUN_DATA, iso: process.env.FOLDRUN_RUN_ISOLATION, key: process.env.ANTHROPIC_API_KEY };
  process.env.FOLDRUN_DATA = root;
  process.env.FOLDRUN_RUN_ISOLATION = "fake";
  process.env.ANTHROPIC_API_KEY ??= "sk-ant-api03-test-key-0000000000";
  const before = { isolation: platform.isolation, gallery: platform.galleryDir, egress: platform.egress, confines: platform.confinesBrowsing, walls: platform.wallsRestricted };
  const gallery = path.join(root, "gallery");
  fs.mkdirSync(path.join(gallery, "tools", "web"), { recursive: true });
  fs.writeFileSync(path.join(gallery, "tools", "web", "tool.md"), WEB_TOOL);
  fs.writeFileSync(path.join(gallery, "tools", "web", "run.mjs"), "");
  let seen: RunInContainerArgs | null = null;
  let granted: EgressGrant | null = null;
  const released: string[] = [];
  const lease = async (a: { grant: EgressGrant }): Promise<EgressLease> => {
    granted = a.grant;
    return {
      url: "http://egress.test/e/tok",
      search: "http://egress.test/s/tok",
      proxy: DOOR,
      ca: "-----BEGIN CERTIFICATE-----\nMA==\n-----END CERTIFICATE-----\n",
      enforce: opts.enforce ?? true,
      commit: async () => {},
      drainLog: async () => [],
      release: async () => {
        released.push("lease");
      },
    } as unknown as EgressLease;
  };
  registerPlatform({
    isolation: { fake: async (args: RunInContainerArgs): Promise<ContainerStepOutcome> => { seen = args; return { status: "completed", result: "ok", costUsd: 0 }; } },
    galleryDir: () => gallery,
    egress: { lease },
    confinesBrowsing: (kind) => opts.confines && kind === "fake",
    wallsRestricted: (kind) => (opts.walls ?? true) && kind === "fake",
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
    return { args: seen as RunInContainerArgs | null, events, status: done!.steps[0]!.status, released, grant: granted as EgressGrant | null };
  } finally {
    registerPlatform({ isolation: before.isolation, galleryDir: before.gallery, egress: before.egress, confinesBrowsing: before.confines, wallsRestricted: before.walls });
    for (const [k, v] of [["FOLDRUN_DATA", prev.data], ["FOLDRUN_RUN_ISOLATION", prev.iso], ["ANTHROPIC_API_KEY", prev.key]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
}


const door = (events: string[]) => events.some((e) => e.includes(SEARCH_DOOR_LINE));

test("held, searching our engine: the grant carries the door, the driver is told where it is, the trace says what it means", async () => {
  const { args, events, grant } = await runAgent({ front: "tools: [web]\nnetwork: trusted\nweb: {actions: [search, fetch]}\n", confines: false });
  assert.ok(args, events.join("\n"));
  assert.deepEqual(grant!.search, {});
  assert.equal(args!.env[SEARCH_DOOR_ENV], "http://egress.test/s/tok");
  assert.ok(door(events), events.join("\n"));
});

test("an executor that walls nothing (docker, the laptop): the step reaches the engine as before — no door, no line", async () => {
  const { args, events, grant } = await runAgent({ front: "tools: [web]\nnetwork: trusted\nweb: {actions: [search, fetch]}\n", confines: false, walls: false });
  assert.equal(grant?.search, undefined);
  assert.equal(args!.env[SEARCH_DOOR_ENV], undefined);
  assert.ok(!events.some((e) => /^info: search:/.test(e)), events.join("\n"));
});

test("limits: caps the door's count — web, or the sum when every searching action has one", async () => {
  let r = await runAgent({ front: "tools: [web]\nnetwork: trusted\nweb: {actions: [search, fetch]}\nlimits: {web.search: 5}\n", confines: false });
  assert.deepEqual(r.grant!.search, { max: 5 });
  r = await runAgent({ front: "tools: [web]\nnetwork: trusted\nweb: {actions: [search, answer]}\nlimits: {web.search: 5}\n", confines: false });
  assert.deepEqual(r.grant!.search, {}, "answer has no limit of its own: the door's own cap holds");
});

test("not held — report only, or an open list — nothing changes: no door, no line", async () => {
  for (const o of [{ front: "tools: [web]\nnetwork: trusted\nweb: {actions: [search, fetch]}\n", enforce: false }, { front: "tools: [web]\nnetwork: open\nweb: {actions: [search]}\n", enforce: true }]) {
    const { args, events, grant } = await runAgent({ ...o, confines: false });
    assert.ok(args, events.join("\n"));
    assert.equal(grant?.search, undefined, o.front);
    assert.equal(args!.env[SEARCH_DOOR_ENV], undefined);
    assert.ok(!events.some((e) => /^info: search:/.test(e)), events.join("\n"));
  }
});

test("network: none — a bare tools: [web] is not given the door, and the trace says why; search written out is", async () => {
  // A bare tools: [web] may browse: it is walled (and so searches through
  // the proxy at all) only where browsing is confined.
  let r = await runAgent({ front: "tools: [web]\nnetwork: none\n", confines: true });
  assert.equal(r.grant?.search, undefined);
  assert.equal(r.args!.env[SEARCH_DOOR_ENV], undefined);
  assert.ok(r.events.some((e) => e.includes(SEARCH_NONE_UNNAMED)), r.events.join("\n"));
  r = await runAgent({ front: "tools: [web]\nnetwork: none\nweb: {actions: [search]}\n", confines: false });
  assert.deepEqual(r.grant!.search, {});
});

test("a browsing step held to its list (FOL-110 phase 3) searches through the door too; one not held does not", async () => {
  let r = await runAgent({ front: "tools: [web]\nnetwork: trusted\n", confines: true });
  assert.equal(r.args!.env.FOLDRUN_BROWSER_CONFINED, "1");
  assert.deepEqual(r.grant!.search, {});
  r = await runAgent({ front: "tools: [web]\nnetwork: trusted\n", confines: false });
  assert.equal(r.grant?.search, undefined, "not walled: it reaches the engine as before");
  assert.equal(r.args!.env[SEARCH_DOOR_ENV], undefined);
});

test("a search provider answers: no door — its host is on the list already", async () => {
  const { grant, args } = await runAgent({ front: "tools: [web]\nnetwork: trusted\nweb: {actions: [search], search: brave}\n", confines: false });
  assert.equal(grant?.search, undefined);
  assert.equal(args!.env[SEARCH_DOOR_ENV], undefined);
});

test("searchDoorWanted, the rule itself", () => {
  const held = { level: "trusted" as const, defaults: true, enforce: true, web: true, actions: null, provided: [] };
  assert.deepEqual(searchDoorWanted(held).door, {});
  assert.equal(searchDoorWanted({ ...held, enforce: false }).door, null);
  assert.equal(searchDoorWanted({ ...held, level: "open" }).door, null);
  assert.equal(searchDoorWanted({ ...held, web: false }).door, null);
  assert.equal(searchDoorWanted({ ...held, actions: ["fetch", "browse"] }).door, null);
  assert.equal(searchDoorWanted({ ...held, provided: ["search", "answer", "monitor"] }).door, null);
  assert.deepEqual(searchDoorWanted({ ...held, provided: ["search"] }).door, {}, "answer still asks our engine");
  const noDefaults = searchDoorWanted({ ...held, defaults: false });
  assert.equal(noDefaults.door, null);
  assert.equal(noDefaults.line, SEARCH_NO_DEFAULTS_UNNAMED);
  assert.deepEqual(searchDoorWanted({ ...held, defaults: false, actions: ["monitor"] }).door, {});
  assert.deepEqual(searchDoorWanted({ ...held, limits: { web: 3, "web.search": 9 } }).door, { max: 3 });
  assert.deepEqual(searchDoorWanted({ ...held, actions: ["search", "answer"], limits: { "web.search": 2, "web.answer": 4 } }).door, { max: 6 });
});

test("searchProvided reads a web: block the way the runner does", () => {
  assert.deepEqual(searchProvided({}), []);
  assert.deepEqual(searchProvided({ search: "brave" }), ["search"]);
  assert.deepEqual(searchProvided({ search: { engines: ["naver"] } }), [], "SearXNG settings are our engine");
  assert.deepEqual(searchProvided({ search: "foldrun" }), []);
});
