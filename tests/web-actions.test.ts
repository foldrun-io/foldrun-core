// The web as actions: which provider can do which, foldrun when none is
// named, and an error — never a quiet fallback — when the named one cannot.
//
//   node --test tests/web-actions.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  WEB_ACTIONS, FOLDRUN, webProviders, providersFor, resolveWebAction, browseSupports, browsersFor,
  staleIntegrations, actionProblems, findWebProvider,
} from "../src/web-actions.ts";

test("unset is foldrun, for every action foldrun has live", () => {
  for (const action of ["search", "fetch", "browse", "crawl", "map", "extract"] as const) {
    const c = resolveWebAction(action, null);
    assert.equal(c.provider?.name, "foldrun", action);
  }
});

test("foldrun's answer and monitor are planned: naming them is an error that says so", () => {
  assert.equal(FOLDRUN.actions.answer?.status, "planned");
  assert.equal(FOLDRUN.actions.monitor?.status, "planned");
  assert.match(resolveWebAction("answer", null).error ?? "", /not built yet/);
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
  assert.match(c.error ?? "", /brave does not fetch here/);
  assert.match(c.error ?? "", /These do: foldrun, .*jina.*Unset uses foldrun/);
  assert.match(resolveWebAction("monitor", "parallel").error ?? "", /No provider has it wired yet/);
  assert.match(resolveWebAction("search", "nosuch").error ?? "", /no provider by that name/);
});

test("the registry reads the vendor lists: one provider, several actions", () => {
  const exa = webProviders().find((p) => p.name === "exa");
  assert.deepEqual(Object.keys(exa?.actions ?? {}).sort(), ["fetch", "search"]);
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

test("check catches a web_<action>: key for an action the provider cannot do", () => {
  assert.deepEqual(actionProblems({}), []);
  assert.deepEqual(actionProblems({ web_crawl: "foldrun" }), []);
  assert.match(actionProblems({ web_monitor: "parallel" })[0], /parallel does not monitor/);
  assert.match(actionProblems({ web_crawl: { name: "brave" } })[0], /brave does not crawl here/);
  assert.match(actionProblems({ web_extract: 3 })[0], /takes a provider name/);
});
