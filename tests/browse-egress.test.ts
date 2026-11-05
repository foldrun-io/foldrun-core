// FOL-110 phase 1: a browsing step says plainly that its network: list does
// not hold yet, and which tier its browser falls in; the proxy's refusal
// advises adding only the one site, never opening the whole web.
//
//   node --test tests/browse-egress.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { browseTier, browseNetworkLine, browseVerdict, browseVendorOf } from "../src/browse-egress.ts";
import { BROWSER_APIS } from "../src/providers.ts";
import { refusalText, type NetworkPolicy } from "../src/network.ts";

const trusted = { level: "trusted", from: "agent", defaults: true, added: ["api.example.com"], implied: [], allow: [] } as unknown as NetworkPolicy;

test("every browser vendor says whether it can go through our egress proxy", () => {
  for (const b of BROWSER_APIS) assert.ok(b.egress === "proxy" || b.egress === "own", b.name);
  assert.deepEqual(BROWSER_APIS.filter((b) => b.egress === "proxy").map((b) => b.name).sort(), ["browserbase", "browserless", "hyperbrowser", "steel"]);
});

test("tiers: foldrun's own browser is hosted; a proxy-taking vendor is vendor; the rest can never be enforced", () => {
  assert.equal(browseTier(undefined).tier, "hosted");
  assert.equal(browseTier("foldrun").tier, "hosted");
  assert.equal(browseTier("Browserbase").tier, "vendor");
  assert.equal(browseTier("steel").tier, "vendor");
  assert.equal(browseTier("brightdata").tier, "none");
  assert.equal(browseTier("bright-data").tier, "none", "aliases resolve");
  assert.equal(browseTier("zenrows").tier, "none");
  assert.equal(browseTier("cdp").tier, "none");
  assert.equal(browseTier("some-unknown").tier, "none");
});

test("the trace line keeps the step's list and says it is not enforced while the step browses", () => {
  const own = browseNetworkLine(trusted, undefined);
  assert.match(own, /^network: trusted \(agent\) — the trusted list .*added: api\.example\.com/);
  assert.match(own, /not enforced in this step: it may browse/);
  assert.match(own, /every other program in this step reach sites directly/);
  assert.match(own, /foldrun's own browser: it is held to network: on an install that confines browsing, with the list enforced/);
  assert.match(browseNetworkLine({ ...trusted, level: "open" } as NetworkPolicy, undefined), /with an open list there is nothing to hold it to/);
  assert.match(browseNetworkLine(trusted, "browserbase"), /Browserbase\) browses from the vendor's network: .* once that vendor is qualified/);
  assert.match(browseNetworkLine(trusted, "zenrows"), /ZenRows Scraping Browser\) always browses through its own network and cannot be held to network: — a restricted, enforced network: will refuse it/);
});

test("the refusal advises adding just the one site and keeps the level — never network: open", () => {
  const t = refusalText({ level: "trusted" }, "Docs.Example.com");
  assert.match(t, /network: \[docs\.example\.com\]/);
  assert.match(t, /keeps network: trusted for everything else/);
  assert.doesNotMatch(t, /network: open/);
});

test("listAgents says which agents may browse — the dashboard's Network card warns on them", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-browses-"));
  const previous = process.env.FOLDRUN_DATA;
  process.env.FOLDRUN_DATA = root;
  try {
    const { saveWorkspace, listAgents } = await import("../src/store.ts");
    const agent = (name: string, front: string) => ({ path: `agents/${name}/agent.md`, content: `---\nname: ${name}\ndescription: ${name}\n${front}---\n\nWork.\n` });
    saveWorkspace("acme", "desk", [
      { path: "AGENTS.md", content: "# Desk\n" },
      agent("scout", "tools: [web]\n"),
      agent("reader", "tools: [web]\nweb: {actions: [search, fetch]}\n"),
      agent("writer", "tools: [write]\n"),
    ], "replace");
    const by = Object.fromEntries(listAgents("acme", "desk").map((a) => [a.name, a.network]));
    assert.equal(by.scout.browses, true);
    assert.equal(by.reader.browses, false);
    assert.equal(by.reader.readsWeb, true, "fetch still reads the web");
    assert.equal(by.writer.browses, false);
  } finally {
    if (previous === undefined) delete process.env.FOLDRUN_DATA;
    else process.env.FOLDRUN_DATA = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// FOL-110 phase 3: hosted enforcement.

test("the verdict: held only where the list is restricted, enforced and the executor walls the step", () => {
  const held = { level: "trusted" as const, enforce: true, vendor: undefined, confines: true };
  assert.deepEqual(browseVerdict(held), { kind: "hosted" });
  assert.deepEqual(browseVerdict({ ...held, vendor: "foldrun" }), { kind: "hosted" });
  assert.deepEqual(browseVerdict({ ...held, level: "none" }), { kind: "hosted" });
  // Each missing half leaves the step exactly as before phase 3.
  assert.deepEqual(browseVerdict({ ...held, level: "open" }), { kind: "legacy" }, "an open list has nothing to hold");
  assert.deepEqual(browseVerdict({ ...held, enforce: false }), { kind: "legacy" }, "a report-only list");
  assert.deepEqual(browseVerdict({ ...held, confines: false }), { kind: "legacy" }, "no wall (switch off, docker, laptop)");
  assert.deepEqual(browseVerdict({ ...held, level: "open", vendor: "zenrows" }), { kind: "legacy" }, "a vendor under an open list runs as before");
  assert.deepEqual(browseVerdict({ ...held, confines: false, vendor: "brightdata" }), { kind: "legacy" });
});

test("the verdict refuses every vendor under a held list — the never-enforceable and the not-yet-qualified alike", () => {
  const held = { level: "trusted" as const, enforce: true, confines: true };
  for (const vendor of ["brightdata", "zenrows", "cdp", "browserbase", "steel", "hyperbrowser", "browserless", "some-unknown"]) {
    const v = browseVerdict({ ...held, vendor });
    assert.equal(v.kind, "refuse", vendor);
    if (v.kind !== "refuse") continue;
    assert.match(v.message, /refused before it connected/);
    assert.match(v.message, new RegExp(`Drop browse: ${vendor} from the agent's web: block`));
    assert.match(v.message, /give that agent network: open/, "the per-agent opt-in of decision 4");
  }
  const bb = browseVerdict({ ...held, vendor: "browserbase" });
  assert.ok(bb.kind === "refuse" && /until that vendor is qualified \(FOL-110 phase 4\)/.test(bb.message));
  const zr = browseVerdict({ ...held, vendor: "zenrows" });
  assert.ok(zr.kind === "refuse" && /always browses through its own network/.test(zr.message));
});

test("a held step's trace line says enforced — hosted, and what the wall is", () => {
  const line = browseNetworkLine(trusted, undefined, { hosted: true });
  assert.match(line, /^network: trusted \(agent\) — the trusted list/);
  assert.match(line, /enforced — hosted: the browser runs inside this step's sandbox, whose network reaches only the egress proxy \(which holds the list\) and DNS/);
  assert.match(line, /DNS lookups themselves are not restricted/, "what the wall admits is said, not hidden");
  assert.doesNotMatch(line, /not enforced/);
});

test("browseVendorOf reads web.browse the way the runner does", () => {
  assert.equal(browseVendorOf(undefined), null);
  assert.equal(browseVendorOf({ engine: "chromium", headless: false }), null, "settings alone are foldrun's own browser");
  assert.equal(browseVendorOf("browserbase"), "browserbase");
  assert.equal(browseVendorOf("zenrows"), "zenrows");
  assert.equal(browseVendorOf({ name: "steel", engine: "chrome" }), "steel", "the long form, settings beside it");
  assert.equal(browseVendorOf("no-such-vendor"), null, "a name no resolver knows is an error elsewhere, never a vendor here");
});

test("listAgents carries this folder's half of the verdict: network_enforce and the vendor", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-browse-held-"));
  const previous = process.env.FOLDRUN_DATA;
  process.env.FOLDRUN_DATA = root;
  try {
    const { saveWorkspace, listAgents } = await import("../src/store.ts");
    const agent = (name: string, front: string) => ({ path: `agents/${name}/agent.md`, content: `---\nname: ${name}\ndescription: ${name}\n${front}---\n\nWork.\n` });
    saveWorkspace("acme", "held", [
      { path: "AGENTS.md", content: "---\nnetwork_enforce: true\n---\n# Desk\n" },
      agent("own", "tools: [web]\nnetwork: trusted\n"),
      agent("vendor", "tools: [web]\nnetwork: trusted\nweb: {browse: browserbase}\n"),
    ], "replace");
    const by = Object.fromEntries(listAgents("acme", "held").map((a) => [a.name, a.network]));
    assert.equal(by.own.enforceWanted, true);
    assert.equal(by.own.browseVendor, null);
    assert.equal(by.vendor.browseVendor, "browserbase");
    saveWorkspace("acme", "loose", [{ path: "AGENTS.md", content: "# Desk\n" }, agent("own", "tools: [web]\n")], "replace");
    assert.equal(listAgents("acme", "loose")[0]!.network.enforceWanted, false);
  } finally {
    if (previous === undefined) delete process.env.FOLDRUN_DATA;
    else process.env.FOLDRUN_DATA = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
