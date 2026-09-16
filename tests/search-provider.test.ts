import test from "node:test";
import assert from "node:assert/strict";
import { resolveSearch, PROVIDERS } from "../src/providers.ts";

test("unset means the account's own search engine", () => {
  for (const unset of [undefined, null, "", "ours"]) {
    const got = resolveSearch(unset);
    assert.equal(got.provider, null);
    assert.equal(got.error, undefined);
  }
});

test("a provider that searches resolves to its shape and its index", () => {
  const a = resolveSearch("anthropic");
  assert.equal(a.provider, "anthropic");
  assert.equal(a.shape, "anthropic");
  assert.match(a.index!, /Brave/);

  // Same wire shape, a different index — which is the whole point of the key.
  const z = resolveSearch("zai");
  assert.equal(z.shape, "anthropic");
  assert.match(z.index!, /Zhipu/);

  assert.equal(resolveSearch("kimi").shape, "builtin_fn");
  assert.equal(resolveSearch("openrouter").shape, "plugin");
  assert.equal(resolveSearch("openai").shape, "openai");
});

test("an Anthropic-shaped endpoint with no search is refused, not quietly allowed", () => {
  // DeepSeek is the case this exists for: the wire is Anthropic's, so every
  // shape check passes, and there is still no search behind it.
  const preset = PROVIDERS.find((p) => p.name === "deepseek")!;
  assert.equal(preset.format, "anthropic", "the trap only matters while this is true");
  const got = resolveSearch("deepseek");
  assert.equal(got.provider, null);
  assert.match(got.error!, /no server-side search/);
  assert.match(got.error!, /own search engine/, "the error says what to do instead");
});

test("a typo names the providers that would have worked", () => {
  const got = resolveSearch("anthropc");
  assert.match(got.error!, /no provider or search API by that name/);
  assert.match(got.error!, /anthropic/);
});

test("case and padding do not decide whether a desk can search", () => {
  assert.equal(resolveSearch("  Anthropic  ").provider, "anthropic");
});

test("a non-string is an error rather than a silent fallback", () => {
  assert.match(resolveSearch(true)!.error!, /takes a name/);
});

// ---- direct search APIs: the customer's own key, our tool, on the record --
import { SEARCH_APIS, findSearchApi } from "../src/providers.ts";

test("a search API resolves to the direct shape with its secret and its one host", () => {
  for (const api of SEARCH_APIS) {
    const got = resolveSearch(api.name);
    assert.equal(got.shape, "direct", api.name);
    assert.equal(got.provider, api.name);
    assert.equal(got.secret, api.secret, "the vault name the runner will declare");
    assert.equal(got.host, api.host, "the one host the egress grant is for");
    assert.equal(got.error, undefined);
  }
});

test("every search API names a host that is the host of its endpoint", () => {
  // The grant is by host; an endpoint on a different host would be a key
  // the proxy never fills, failing at the provider as "missing credential".
  for (const api of SEARCH_APIS) {
    assert.equal(new URL(api.endpoint).host, api.host, api.name);
  }
});

test("you.com answers to its spellings", () => {
  for (const spelling of ["you", "youcom", "you.com", "You.com"]) {
    assert.equal(findSearchApi(spelling)?.name, "you", spelling);
    assert.equal(resolveSearch(spelling).provider, "you", spelling);
  }
});


test("a provider keeps its own shape even though it also appears in the API error list", () => {
  assert.equal(resolveSearch("anthropic").shape, "anthropic");
  assert.equal(resolveSearch("anthropic").secret, undefined, "no vault key — the provider's own tool answers");
});

test("an unknown name lists both the providers and the APIs", () => {
  const got = resolveSearch("exxa");
  assert.match(got.error!, /Providers that search: .*anthropic/);
  assert.match(got.error!, /Search APIs, with your own key: .*exa/);
});

// ---- the long form: bring your own vault name --------------------------
test("the long form names the API and the customer's own vault entry", () => {
  const got = resolveSearch({ name: "exa", key: "${MY_EXA_KEY}" });
  assert.equal(got.provider, "exa");
  assert.equal(got.shape, "direct");
  assert.equal(got.secret, "MY_EXA_KEY", "the runner declares this name, not the default");
  assert.equal(got.secretOptional, false, "a chosen name is never optional");
});

test("a key written into the file is refused, and the refusal says where it goes", () => {
  const got = resolveSearch({ name: "exa", key: "the-key-itself-not-a-reference" });
  assert.equal(got.provider, null);
  assert.match(got.error!, /not the key itself/);
  assert.match(got.error!, /foldrun secrets set/);
});

test("the long form without a name is an error, not a silent default", () => {
  assert.match(resolveSearch({ key: "${X}" }).error!, /needs `name:`/);
});

test("a model provider does not take a key here — that is the provider: block's job", () => {
  assert.match(resolveSearch({ name: "anthropic", key: "${K}" }).error!, /provider: block/);
});

// ---- fetch APIs ---------------------------------------------------------
import { FETCH_APIS, findFetchApi } from "../src/providers.ts";

test("every fetch API resolves for web_fetch with its secret and host", () => {
  for (const api of FETCH_APIS) {
    const got = resolveSearch(api.name, "fetch");
    assert.equal(got.shape, "direct", api.name);
    assert.equal(got.secret, api.secret, api.name);
    assert.equal(got.host, api.host, api.name);
    assert.equal(new URL(api.endpoint).host, api.host, `${api.name}: the grant host must be the endpoint's host`);
  }
});

test("Jina's reader is the one whose key is optional; its search is not", () => {
  assert.equal(resolveSearch("jina", "fetch").secretOptional, true);
  assert.equal(resolveSearch("jina", "search").secretOptional, false);
});

test("a search-only API named for web_fetch is refused and told what can fetch", () => {
  const got = resolveSearch("brave", "fetch");
  assert.equal(got.provider, null);
  assert.match(got.error!, /searches but has no fetch here/);
  assert.match(got.error!, /jina/);
});

test("web_fetch: anthropic stays the one provider swap, and openai is refused honestly", () => {
  assert.equal(resolveSearch("anthropic", "fetch").shape, "anthropic");
  assert.match(resolveSearch("openai", "fetch").error!, /no fetch a tool can call/);
});

test("Zyte's secret says what the vault must hold", () => {
  assert.match(findFetchApi("zyte")!.secretFormat!, /base64/);
  assert.equal(findFetchApi("zyte")!.secret, "ZYTE_API_KEY_BASIC");
});

// ---- the whole list: SERP scrapers, refused names, remote browsers ------
import { BROWSER_APIS, REFUSED_WEB } from "../src/providers.ts";

test("the SERP scrapers are search APIs like the rest, with the key where each vendor wants it", () => {
  for (const name of ["serper", "serpapi", "dataforseo", "perplexity", "linkup"]) {
    const got = resolveSearch(name);
    assert.equal(got.shape, "direct", name);
    assert.ok(got.secret && got.host, name);
  }
  assert.equal(resolveSearch("dataforseo").secret, "DATAFORSEO_AUTH_BASIC", "basic auth: the vault holds the encoded pair");
  assert.equal(resolveSearch("serpapi").secret, "SERPAPI_API_KEY");
});

test("names that cannot work are refused with the reason, for every kind", () => {
  for (const [name, why] of Object.entries(REFUSED_WEB)) {
    for (const kind of ["search", "fetch", "browse"] as const) {
      const got = resolveSearch(name, kind);
      assert.equal(got.provider, null, `${kind}: ${name}`);
      assert.ok(got.error!.includes(why.slice(0, 40)), `${kind}: ${name} says why`);
    }
  }
  assert.match(resolveSearch("bing").error!, /11 Aug 2025/);
  assert.match(resolveSearch("google").error!, /serper, serpapi or dataforseo/);
});

test("a remote browser resolves for web_browse with its secret, and only for web_browse", () => {
  for (const b of BROWSER_APIS) {
    const got = resolveSearch(b.name, "browse");
    assert.equal(got.shape, "direct", b.name);
    assert.equal(got.secret, b.secret, b.name);
    assert.equal(got.host, b.host, b.name);
    assert.equal(got.secretOptional, false, `${b.name}: a browser key is never optional`);
  }
  assert.equal(resolveSearch("bright-data", "browse").provider, "brightdata", "the hyphenated spelling");
  assert.match(resolveSearch("browserbase", "search").error!, /no provider or search API/);
  assert.match(resolveSearch("exa", "browse").error!, /no remote browser by that name/);
});

test("the long form works for a browser too, and a literal key is still refused", () => {
  assert.equal(resolveSearch({ name: "browserbase", key: "${BB}" }, "browse").secret, "BB");
  assert.match(resolveSearch({ name: "browserbase", key: "a-literal-value" }, "browse").error!, /not the key itself/);
});
