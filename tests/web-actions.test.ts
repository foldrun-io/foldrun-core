// The web as actions: which provider can do which, foldrun when none is
// named, and an error — never a quiet fallback — when the named one cannot.
//
//   node --test tests/web-actions.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  WEB_ACTIONS, FOLDRUN, webProviders, providersFor, resolveWebAction, browseSupports, browsersFor,
  staleIntegrations, actionProblems, findWebProvider, resolveActionApi,
} from "../src/web-actions.ts";
import { webConfig, webProblems, legacyWebKeyError } from "../src/providers.ts";

test("unset is foldrun, for every action", () => {
  for (const action of WEB_ACTIONS) {
    const c = resolveWebAction(action, null);
    assert.equal(c.provider?.name, "foldrun", action);
  }
});

test("foldrun does all eight, none of them with a second model in it", () => {
  for (const a of WEB_ACTIONS) assert.equal(FOLDRUN.actions[a]?.status, "live", a);
});

test("a provider named for an action it has is that provider", () => {
  assert.equal(resolveWebAction("search", "brave").provider?.name, "brave");
  assert.equal(resolveWebAction("fetch", "exa").provider?.name, "exa");
  assert.equal(resolveWebAction("browse", "steel").support?.via, "cdp");
  // aliases resolve
  assert.equal(findWebProvider("you.com")?.name, "you");
});

test("a provider named for an action it lacks is an error naming the ones that have it — no fallback", () => {
  const c = resolveWebAction("fetch", "brave");
  assert.equal(c.provider, undefined);
  assert.match(c.error ?? "", /web\.fetch: brave does not fetch here/);
  assert.match(c.error ?? "", /These do: foldrun, .*jina.*Unset uses foldrun/);
  assert.match(resolveWebAction("monitor", "brave").error ?? "", /These do: foldrun, parallel, firecrawl/);
  assert.match(resolveWebAction("search", "nosuch").error ?? "", /no provider by that name/);
});

test("the registry reads the vendor lists: one provider, several actions", () => {
  const exa = webProviders().find((p) => p.name === "exa");
  assert.deepEqual(Object.keys(exa?.actions ?? {}).sort(), ["answer", "fetch", "search"]);
  const fc = webProviders().find((p) => p.name === "firecrawl");
  assert.deepEqual(Object.keys(fc?.actions ?? {}).sort(), ["crawl", "extract", "fetch", "map", "monitor", "search"]);
  assert.ok(providersFor("browse").includes("browserbase"));
  for (const p of webProviders()) {
    for (const a of Object.keys(p.actions)) assert.ok((WEB_ACTIONS as readonly string[]).includes(a), `${p.name}: ${a}`);
  }
});

test("a CDP browser takes every step except what its docs say it lacks", () => {
  const bd = webProviders().find((p) => p.name === "brightdata")!.actions.browse!;
  assert.equal(browseSupports(bd, "click"), true);
  assert.equal(browseSupports(bd, "tab"), false);
  assert.ok(!browsersFor("tab").includes("brightdata"));
  assert.ok(browsersFor("tab").includes("foldrun"));
});

test("every vendor integration names its docs page and was matched to it within 90 days", () => {
  // The rule "integrations follow the latest docs", as a test CI can fail on.
  // When this fails: re-read the vendor's page, fix the adapter if it moved,
  // and bump `checked` in providers.ts in the same commit.
  assert.deepEqual(staleIntegrations(new Date().toISOString().slice(0, 10)), []);
  assert.ok(staleIntegrations("2027-06-01").length > 0, "an old check is reported");
});

test("check catches a newer action whose provider cannot do it", () => {
  assert.deepEqual(actionProblems({}), []);
  assert.deepEqual(actionProblems({ web: { crawl: "foldrun", monitor: "parallel" } }), []);
  assert.match(actionProblems({ web: { monitor: "brave" } })[0], /web\.monitor: brave does not monitor here/);
  assert.match(actionProblems({ web: { crawl: { name: "exa" } } })[0], /exa does not crawl here/);
  assert.match(actionProblems({ web: { extract: 3 } })[0], /takes a provider name/);
  // the older per-action key is still read
  assert.match(actionProblems({ web_crawl: "brave" })[0], /brave does not crawl/);
});

test("a newer action resolves to its key and the one host that key may reach", () => {
  assert.deepEqual(resolveActionApi("crawl", undefined), { provider: null });
  assert.deepEqual(resolveActionApi("crawl", "foldrun"), { provider: null });
  assert.deepEqual(resolveActionApi("answer", "you"), { provider: "you", secret: "YOU_API_KEY", host: "api.you.com" });
  assert.deepEqual(resolveActionApi("map", { name: "tavily", key: "${MY_TAVILY}" }), { provider: "tavily", secret: "MY_TAVILY", host: "api.tavily.com" });
  assert.match(resolveActionApi("map", { name: "tavily", key: "tvly-123" }).error ?? "", /reference to a secret/);
});

test("the web: block: actions, a provider each, the older keys still read and named for rewrite", () => {
  const w = webConfig({ web: { actions: ["search", "fetch"], fetch: "jina" }, web_search: "brave" });
  assert.deepEqual(w.actions, ["search", "fetch"]);
  assert.equal(w.raw.fetch, "jina");
  assert.equal(w.raw.search, "brave", "web_search: is still read");
  assert.deepEqual(w.legacy, ["web_search"]);
  assert.equal(webConfig({ web: { search: "exa" }, web_search: "brave" }).raw.search, "exa", "web: wins");
  assert.match(legacyWebKeyError("web_search"), /web: \{search: …\}/);
  assert.match(webConfig({ web: { actions: ["serch"] } }).problems[0], /serch is not an action/);
  assert.match(webConfig({ web: { crwal: "x" } }).problems[0], /web\.crwal: is not an action/);
  assert.match(webConfig({ web: "brave" }).problems[0], /web: is a block/);
  // browse cascades from the workspace, as web_browse: did
  assert.deepEqual(webConfig({}, { web: { browse: { engine: "firefox" } } }).raw.browse, { engine: "firefox" });
  assert.equal(webConfig({}, { web_browse: "steel" }).raw.browse, "steel");
  // search, fetch and browse values are checked through the web: block too
  assert.match(webProblems({ web: { fetch: "brave" } })[0], /brave/);
  assert.deepEqual(webProblems({ web: { fetch: "jina", search: "exa" } }), []);
  // an error is worded the way the file is written
  assert.match(webProblems({ web: { browse: { engine: "opera" } } })[0], /^web\.browse\.engine: opera/);
  assert.match(webProblems({ web_browse: { engine: "opera" } })[0], /^web_browse\.engine: opera/);
});
