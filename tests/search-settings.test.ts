// `web: {search: …}` carries two things in one key, as browse does: who
// answers (a search API by name) and, for the account's own engine, what
// SearXNG is asked — engines, categories, safesearch, plugins. These are the
// rules that keep the two apart and the settings honest.
import test from "node:test";
import assert from "node:assert/strict";
import { readSearchSettings, resolveSearch, searchSettingsEnv, webProblems } from "../src/providers.ts";

test("a bare name still means a search API, and carries no settings", () => {
  const read = readSearchSettings("exa");
  assert.deepEqual(read.settings, {});
  assert.equal(read.rest, "exa");
  assert.equal(resolveSearch(read.rest, "search").provider, "exa");
});

test("a block of settings alone means the account's own engine, tuned", () => {
  const read = readSearchSettings({ engines: ["Bing", "google cse"], categories: "general, news", safesearch: "moderate" });
  assert.equal(read.error, undefined);
  assert.deepEqual(read.settings, { engines: ["bing", "google cse"], categories: ["general", "news"], safesearch: 1 });
  assert.equal(read.rest, undefined, "nothing left for the provider resolver");
  assert.equal(resolveSearch(read.rest, "search").provider, null);
});

test("the long form with name: and key: still resolves as before", () => {
  const read = readSearchSettings({ name: "exa", key: "${MY_EXA_KEY}" });
  assert.deepEqual(read.settings, {});
  const choice = resolveSearch(read.rest, "search");
  assert.equal(choice.provider, "exa");
  assert.equal(choice.secret, "MY_EXA_KEY");
});

test("SearXNG settings beside a search API are refused — the API would ignore them", () => {
  const read = readSearchSettings({ name: "exa", engines: ["bing"] });
  assert.match(read.error!, /for the account's own engine/);
  assert.match(read.error!, /name: exa/);
  assert.deepEqual(webProblems({ web: { search: { name: "exa", engines: ["bing"] } } }), [read.error]);
});

test("every setting is read and shaped; only what was said travels as env", () => {
  const read = readSearchSettings({
    engines: "bing, duckduckgo",
    exclude_engines: ["yandex"],
    categories: ["science"],
    safesearch: 2,
    time_range: "Week",
    timeout: "5s",
    plugins: ["oa_doi_rewrite"],
    exclude_plugins: "tracker_url_remover",
    doi_resolver: "doi.org",
  });
  assert.equal(read.error, undefined);
  assert.deepEqual(searchSettingsEnv(read.settings), {
    FOLDRUN_WEB_SEARCH_ENGINES: "bing,duckduckgo",
    FOLDRUN_WEB_SEARCH_EXCLUDE_ENGINES: "yandex",
    FOLDRUN_WEB_SEARCH_CATEGORIES: "science",
    FOLDRUN_WEB_SEARCH_SAFESEARCH: "2",
    FOLDRUN_WEB_SEARCH_TIME_RANGE: "week",
    FOLDRUN_WEB_SEARCH_TIMEOUT: "5",
    FOLDRUN_WEB_SEARCH_PLUGINS: "oa_doi_rewrite",
    FOLDRUN_WEB_SEARCH_EXCLUDE_PLUGINS: "tracker_url_remover",
    FOLDRUN_WEB_SEARCH_DOI_RESOLVER: "doi.org",
  });
  assert.deepEqual(searchSettingsEnv({}), {}, "nothing said, nothing sent: SearXNG's own defaults");
});

test("safesearch takes the words and the numbers, and nothing else", () => {
  assert.equal(readSearchSettings({ safesearch: "off" }).settings.safesearch, 0);
  assert.equal(readSearchSettings({ safesearch: 0 }).settings.safesearch, 0, "0 is a value, not unset");
  assert.equal(readSearchSettings({ safesearch: "strict" }).settings.safesearch, 2);
  assert.equal(readSearchSettings({ safesearch: "1" }).settings.safesearch, 1);
  assert.match(readSearchSettings({ safesearch: "high" }).error!, /off, moderate or strict/);
  assert.match(readSearchSettings({ safesearch: 3 }).error!, /off, moderate or strict/);
});

test("a misspelt plugin is refused by name — it would switch nothing", () => {
  const err = readSearchSettings({ plugins: ["oa_doi_rewrit"] }).error!;
  assert.match(err, /oa_doi_rewrit is not a SearXNG plugin/);
  assert.match(err, /tracker_url_remover/, "the real ones are named");
});

test("a plugin spelt the way an older SearXNG spelt it is accepted", () => {
  assert.equal(readSearchSettings({ plugins: ["infiniteScroll"] }).error, undefined);
});

test("an engine name with a comma would split the list, so it is refused", () => {
  assert.match(readSearchSettings({ engines: ["bing", "a,b"] }).error!, /"a,b" is not an engine name/);
  assert.deepEqual(readSearchSettings({ engines: "bing, duckduckgo" }).settings.engines, ["bing", "duckduckgo"], "one line splits on commas");
  assert.equal(readSearchSettings({ engines: [" "] }).error, undefined, "a blank is dropped, not an error");
  assert.match(readSearchSettings({ engines: ["bing!"] }).error!, /not an engine name/);
  assert.match(readSearchSettings({ engines: 3 }).error!, /list of SearXNG engine names/);
});

test("an engine both asked for and excluded is a contradiction, not a coin toss", () => {
  assert.match(readSearchSettings({ engines: ["bing"], exclude_engines: ["bing"] }).error!, /bing is in both/);
  assert.match(readSearchSettings({ plugins: ["calculator"], exclude_plugins: ["calculator"] }).error!, /calculator is in both/);
});

test("time_range, timeout and doi_resolver are bounded", () => {
  assert.match(readSearchSettings({ time_range: "fortnight" }).error!, /day, week, month or year/);
  assert.match(readSearchSettings({ timeout: 90 }).error!, /0.5 to 30/);
  assert.match(readSearchSettings({ doi_resolver: "https://doi.org/x" }).error!, /resolver's host/);
});

test("check reports a bad block the way it reports a bad name", () => {
  assert.deepEqual(webProblems({ web: { search: { engines: ["bing", "google cse"] } } }), []);
  assert.match(webProblems({ web: { search: { time_range: "never" } } })[0], /web\.search\.time_range/);
  assert.match(webProblems({ web: { search: "nosuchapi" } })[0], /no provider or search API by that name/);
});
