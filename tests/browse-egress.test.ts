// FOL-110 phase 1: a browsing step says plainly that its network: list does
// not hold yet, and which tier its browser falls in; the proxy's refusal
// advises adding only the one site, never opening the whole web.
//
//   node --test tests/browse-egress.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { browseTier, browseNetworkLine } from "../src/browse-egress.ts";
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
  assert.match(own, /foldrun's own browser: it comes under network: when hosted enforcement ships/);
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
