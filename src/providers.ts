// The providers this runtime knows by name.
//
//   provider:
//     name: groq
//     token: ${GROQ_API_KEY}
//     models: { fast: llama-3.3-70b-versatile }
//
// A name resolves to three facts: which wire format the endpoint speaks,
// where it is, and which header the key travels in. Everything here is
// bring-your-own-key — the platform never holds a provider credential on a
// customer's behalf — and a name is a convenience over `base_url:` +
// `format:` + `auth:`, never a requirement: an endpoint this table has
// never heard of works the same way by spelling those three out.
//
// Three formats. `responses` is OpenAI's newer API — the same translator
// with a second pair of mappings, for an OpenAI key that wants what only
// that shape carries (a PDF as input, the reasoning knobs). Nobody else
// implements it, so no preset defaults to it; a block asks for it by name.
// Two formats, deliberately. `anthropic` is what the runtime speaks, so
// those endpoints are reached directly. `openai` endpoints are reached
// through the runtime's own translator (translator.ts), which runs on
// localhost inside the run sandbox and rewrites Anthropic Messages to Chat
// Completions and back. Every provider without an Anthropic-shaped endpoint
// speaks Chat Completions — OpenAI, Gemini, xAI, Groq, Mistral, Hugging
// Face, Cloudflare's own models — so one translation reaches all of them.
//
// URLs and header shapes were checked against each provider's own
// documentation on 2026-09-02 and again on 2026-09-06 (see docs/providers.md). `verified` says
// whether a tool loop was actually driven through the endpoint from here,
// which is the only claim that matters for an agent runtime; a name without
// it is documented, not proven.

export type WireFormat = "anthropic" | "openai" | "responses";

/** Where the key goes for an Anthropic-format endpoint. A translated
 *  endpoint always gets a bearer token, because the translator is the
 *  client there and the SDK's header shape never reaches the provider. */
export type AuthShape = "bearer" | "x-api-key";

export interface ProviderPreset {
  /** The name people write and the docs use. */
  name: string;
  /** How it reads on a run trace and in the help page. */
  title: string;
  format: WireFormat;
  /** Absent when the customer's own account decides it (a workspace id in
   *  the host, an account id in the path): then `base_url:` is required. */
  baseUrl?: string;
  auth: AuthShape;
  /** `max_completion_tokens` for endpoints that reject `max_tokens` on
   *  reasoning models; everything else takes the classic name. */
  maxTokensParam?: "max_tokens" | "max_completion_tokens";
  /** Whether Anthropic `thinking:` should become OpenAI `reasoning_effort`.
   *  Off means the translator drops thinking rather than send a parameter
   *  the endpoint would reject. */
  reasoningEffort?: boolean;
  /** One line a person should read before relying on it. */
  note?: string;
  /** A tool loop was driven through this endpoint from this runtime. */
  verified?: boolean;
  /** Whether the endpoint runs a server-side web search, and in whose shape.
   *  Absent means it does not — `web.search: <that name>` is then an error a
   *  person should see from `check`, not an empty result at 3am. */
  search?: SearchShape;
}

/** Whether this endpoint will execute a server-side web search, and in whose
 *  shape. Separate from `format` on purpose: speaking a wire is not the same
 *  as running a tool on it. DeepSeek's endpoint is Anthropic-shaped and still
 *  has no search at all, which is exactly the mistake this field exists to
 *  stop `check` from letting through.
 *
 *   "anthropic"  executes the `web_search_20250305` server tool as Anthropic
 *                defines it, so the runtime grants it and the endpoint answers
 *   "plugin"     has its own switch rather than a tool (OpenRouter's web
 *                plugin / `:online`), fulfilled natively where the underlying
 *                model supports it and by Exa everywhere else
 *   "openai"     the Responses-shaped `web_search` tool
 *   "builtin_fn" Moonshot's `$web_search`, a Chat-Completions builtin_function
 *                the client has to echo back — billed per successful call
 *   undefined    no server-side search. Ours is the only way to the web. */
export type SearchShape = "anthropic" | "plugin" | "openai" | "builtin_fn" | "direct";

/** A search API the runtime calls itself, with the customer's own key.
 *
 *  These are not model providers — none of them serves a model — so they
 *  live apart from PROVIDERS. `web.search:` accepts either kind of name, and
 *  the difference decides where the search runs: a provider's server-side
 *  tool runs on the provider's machines and is off the run record, while a
 *  direct API is called from the run's own sandbox through the egress proxy
 *  — the key never enters the pod, the call is on the record with its
 *  arguments, and it works whichever model is driving. Same switch, better
 *  audit trail. Shapes were read from each vendor's own API reference on
 *  2026-09-16; the gallery's web tool carries the
 *  matching request and response mapping. */
export interface SearchApi {
  /** The vendor's API reference the adapter was built from, the day it was
   *  last matched to it, and what that page could not confirm. Read by
   *  web-actions.ts; a check older than 90 days fails its test. */
  docs?: string;
  checked?: string;
  gaps?: string;
  name: string;
  aliases?: string[];
  title: string;
  /** The one host the key may be sent to — the egress grant is for this. */
  host: string;
  endpoint: string;
  method: "GET" | "POST";
  /** The header the key travels in, and any prefix on the value. */
  auth: { header: string; prefix?: string };
  /** The vault name a customer stores their key under. */
  secret: string;
  index: string;
  note?: string;
  /** The API answers without a key (at a lower rate). The runner declares
   *  the secret only when the vault has it, so a missing key is not an
   *  error the way a declared-and-absent secret is. */
  secretOptional?: boolean;
  /** What the value in the vault must be, when it is not the bare key. */
  secretFormat?: string;
}

export const SEARCH_APIS: readonly SearchApi[] = [
  { name: "brave", docs: "https://api-dashboard.search.brave.com/app/documentation/web-search/query", checked: "2026-09-29", title: "Brave Search", host: "api.search.brave.com", endpoint: "https://api.search.brave.com/res/v1/web/search",
    method: "GET", auth: { header: "X-Subscription-Token" }, secret: "BRAVE_SEARCH_API_KEY",
    index: "Brave's own — ~40B pages, ~100M refreshed a day; the index Claude searches" },
  { name: "exa", docs: "https://exa.ai/docs/reference/search", checked: "2026-09-29", title: "Exa", host: "api.exa.ai", endpoint: "https://api.exa.ai/search",
    method: "POST", auth: { header: "x-api-key" }, secret: "EXA_API_KEY",
    index: "Exa's own semantic index — by meaning, not keywords" },
  { name: "tavily", docs: "https://docs.tavily.com/documentation/api-reference/endpoint/search", checked: "2026-09-29", title: "Tavily", host: "api.tavily.com", endpoint: "https://api.tavily.com/search",
    method: "POST", auth: { header: "Authorization", prefix: "Bearer " }, secret: "TAVILY_API_KEY",
    index: "Tavily's own crawler plus bought-in feeds" },
  { name: "parallel", docs: "https://docs.parallel.ai/api-reference/search-api/search", checked: "2026-09-29", title: "Parallel", host: "api.parallel.ai", endpoint: "https://api.parallel.ai/v1/search",
    method: "POST", auth: { header: "x-api-key" }, secret: "PARALLEL_API_KEY",
    index: "Parallel's own closed index",
    note: "Wants an objective beside the queries; the wrapper writes one from the query." },
  { name: "you", docs: "https://you.com/docs/api-reference/search/v1-search", checked: "2026-09-29", aliases: ["youcom", "you.com"], title: "You.com", host: "ydc-index.io", endpoint: "https://ydc-index.io/v1/search",
    method: "POST", auth: { header: "X-API-Key" }, secret: "YOU_API_KEY",
    index: "You.com's own index and cache (self-reported)" },
  { name: "jina", docs: "https://s.jina.ai/docs", checked: "2026-09-29", gaps: "response fields (title, url, description, content) are not in any official schema; read from live responses", title: "Jina Search", host: "s.jina.ai", endpoint: "https://s.jina.ai/",
    method: "GET", auth: { header: "Authorization", prefix: "Bearer " }, secret: "JINA_API_KEY",
    index: "Jina's — top results, each with its page content already read",
    note: "s.jina.ai refuses without a key (checked live 2026-09-16); r.jina.ai, the reader, does not." },
  { name: "firecrawl", docs: "https://docs.firecrawl.dev/api-reference/endpoint/search", checked: "2026-09-29", title: "Firecrawl", host: "api.firecrawl.dev", endpoint: "https://api.firecrawl.dev/v2/search",
    method: "POST", auth: { header: "Authorization", prefix: "Bearer " }, secret: "FIRECRAWL_API_KEY",
    index: "Firecrawl's — open-source core, self-hostable" },
  { name: "perplexity", docs: "https://docs.perplexity.ai/api-reference/search-post", checked: "2026-09-29", title: "Perplexity Search", host: "api.perplexity.ai", endpoint: "https://api.perplexity.ai/search",
    method: "POST", auth: { header: "Authorization", prefix: "Bearer " }, secret: "PERPLEXITY_API_KEY",
    index: "Perplexity's own crawl — the Search API returns results, not an answer" },
  { name: "linkup", docs: "https://docs.linkup.so/pages/documentation/api-reference/endpoint/post-search", checked: "2026-09-29", title: "Linkup", host: "api.linkup.so", endpoint: "https://api.linkup.so/v1/search",
    method: "POST", auth: { header: "Authorization", prefix: "Bearer " }, secret: "LINKUP_API_KEY",
    index: "Linkup's — agent-shaped, each result with its content" },
  // ---- the SERP scrapers: Google's own results page, read for you. Not
  // an index of their own, and not Google partners — there is no such
  // programme. The one kind to use when the question is about Google
  // itself: where a page ranks, what the SERP shows.
  { name: "serper", docs: "https://serper.dev", checked: "2026-09-29", gaps: "no public API reference page; parameters and fields confirmed from the homepage only", title: "Serper", host: "google.serper.dev", endpoint: "https://google.serper.dev/search",
    method: "POST", auth: { header: "X-API-KEY" }, secret: "SERPER_API_KEY",
    index: "Google's results page, scraped — ~$1 / 1,000; fast, developers' favourite" },
  { name: "serpapi", docs: "https://serpapi.com/search-api", checked: "2026-09-29", title: "SerpApi", host: "serpapi.com", endpoint: "https://serpapi.com/search",
    method: "GET", auth: { header: "", prefix: "" }, secret: "SERPAPI_API_KEY",
    index: "Google's results page, scraped — the dearest, 80+ engines",
    note: "The key travels as the api_key query parameter; the egress proxy fills the URL as it fills a header." },
  { name: "dataforseo", docs: "https://docs.dataforseo.com/v3/serp/google/organic/live/advanced/", checked: "2026-09-29", title: "DataForSEO", host: "api.dataforseo.com", endpoint: "https://api.dataforseo.com/v3/serp/google/organic/live/advanced",
    method: "POST", auth: { header: "Authorization", prefix: "Basic " }, secret: "DATAFORSEO_AUTH_BASIC",
    secretFormat: "base64 of `login:password` — DataForSEO authenticates with HTTP basic auth, and the proxy fills one placeholder verbatim: `printf 'LOGIN:PASSWORD' | base64`",
    index: "Google's results page, scraped — $0.60 / 1,000 standard queue; what rank-desk uses" },
];

/** Names people will try that cannot work, and why — said at `check`
 *  rather than discovered at 3am. */
export const REFUSED_WEB: Record<string, string> = {
  bing: "Microsoft retired the Bing Search API on 11 Aug 2025. What remains is Grounding with Bing Search, usable only inside an Azure AI agent — not a search a tool can call. Bing's index still answers through ChatGPT (web.search: openai).",
  azure: "the Bing Search API is retired; Grounding with Bing Search runs only inside Azure AI agents. See bing.",
  google: "Google does not sell its index. The Custom Search JSON API is closed to new customers and retires 1 Jan 2027; Grounding with Google Search runs only inside Gemini. For Google's results page, use a SERP scraper: serper, serpapi or dataforseo.",
  apify: "Apify is an actor marketplace, not a search, fetch or browser endpoint. Reach a specific actor as an http tool file, the way blog-desk's apify-fallback does.",
};

/** Fetch APIs the runtime calls itself: a URL in, the page out, with the
 *  customer's own key. Same seam as the search APIs — `web.fetch: jina` —
 *  and the same trade: our own fetch is free and on the record; these are
 *  for the failure modes ours cannot cover, chiefly a page that refuses a
 *  plain request. Three tiers, priced accordingly: a reader (Jina,
 *  Firecrawl) turns a page into clean markdown; a search vendor's extract
 *  (Exa, Tavily, Parallel) reads many at once; an unblocker (Zyte, ScrapingBee) renders
 *  behind the anti-bot walls a reader cannot pass. */
export interface FetchApi extends Omit<SearchApi, "index"> {
  tier: "reader" | "extract" | "unblocker";
  /** How many URLs one call may carry. 1 means one call per page. */
  batch: number;
  what: string;
}

export const FETCH_APIS: readonly FetchApi[] = [
  { name: "jina", docs: "https://jina.ai/reader/", checked: "2026-09-29", gaps: "the {code, status, data} JSON wrapper is not shown on an official page", title: "Jina Reader", host: "r.jina.ai", endpoint: "https://r.jina.ai/",
    method: "GET", auth: { header: "Authorization", prefix: "Bearer " }, secret: "JINA_API_KEY", secretOptional: true,
    tier: "reader", batch: 1, what: "clean markdown, text or html; works without a key at 20 requests a minute (checked live 2026-09-16)" },
  { name: "firecrawl", docs: "https://docs.firecrawl.dev/api-reference/endpoint/scrape", checked: "2026-09-29", title: "Firecrawl", host: "api.firecrawl.dev", endpoint: "https://api.firecrawl.dev/v2/scrape",
    method: "POST", auth: { header: "Authorization", prefix: "Bearer " }, secret: "FIRECRAWL_API_KEY",
    tier: "reader", batch: 1, what: "main-content markdown or html, boilerplate stripped; one URL per call" },
  { name: "exa", docs: "https://exa.ai/docs/reference/get-contents", checked: "2026-09-29", title: "Exa Contents", host: "api.exa.ai", endpoint: "https://api.exa.ai/contents",
    method: "POST", auth: { header: "x-api-key" }, secret: "EXA_API_KEY",
    tier: "extract", batch: 100, what: "text for up to 100 URLs in one call; always fetched fresh (maxAgeHours: 0), not Exa's cache" },
  { name: "tavily", docs: "https://docs.tavily.com/documentation/api-reference/endpoint/extract", checked: "2026-09-29", title: "Tavily Extract", host: "api.tavily.com", endpoint: "https://api.tavily.com/extract",
    method: "POST", auth: { header: "Authorization", prefix: "Bearer " }, secret: "TAVILY_API_KEY",
    tier: "extract", batch: 20, what: "markdown or text for up to 20 URLs in one call, failures listed beside successes" },
  { name: "parallel", docs: "https://docs.parallel.ai/api-reference/extract/extract", checked: "2026-09-29", title: "Parallel Extract", host: "api.parallel.ai", endpoint: "https://api.parallel.ai/v1/extract",
    method: "POST", auth: { header: "x-api-key" }, secret: "PARALLEL_API_KEY",
    tier: "extract", batch: 20, what: "full-page markdown for several URLs at once; handles JavaScript pages and PDFs" },
  { name: "zyte", docs: "https://docs.zyte.com/zyte-api/usage/reference.html", checked: "2026-09-29", title: "Zyte API", host: "api.zyte.com", endpoint: "https://api.zyte.com/v1/extract",
    method: "POST", auth: { header: "Authorization", prefix: "Basic " }, secret: "ZYTE_API_KEY_BASIC",
    secretFormat: "base64 of `<api key>:` — Zyte authenticates with HTTP basic auth, and the proxy fills a placeholder verbatim, so the vault holds the encoded form: `printf 'KEY:' | base64`",
    tier: "unblocker", batch: 1, what: "the page rendered in a real browser behind Zyte's proxy pool — for the sites that refuse everything else; pay per successful request" },
  { name: "scrapingbee", docs: "https://www.scrapingbee.com/documentation/", checked: "2026-09-29", aliases: ["scraping-bee", "scraping_bee"], title: "ScrapingBee", host: "app.scrapingbee.com", endpoint: "https://app.scrapingbee.com/api/v1/",
    method: "GET", auth: { header: "Authorization", prefix: "Bearer " }, secret: "SCRAPINGBEE_API_KEY",
    tier: "unblocker", batch: 1, what: "the page rendered in a real browser (render_js) behind ScrapingBee's proxy pool; credits per call, more for JavaScript" },
];

/** Remote browsers: a CDP endpoint our web browse connects to instead of
 *  the account's pod — the same tool, the same modes and actions, rendered
 *  on the vendor's machines. `web.browse: browserbase`. The one capability
 *  where the key cannot ride the egress proxy: CDP is a websocket, so the
 *  wrapper holds the real value the way it already holds a cookie secret,
 *  and creates the session itself where the vendor wants one. */
/** What a vendor's own session can be asked for, per its docs — the keys of
 *  `web.browse.session:` it accepts. Absent means it has no such option;
 *  naming one is an error in `check` that says which vendors do. */
export interface SessionSupport {
  /** on: a proxy can be switched on; always: it is always on (true is a
   *  no-op, false an error); the rest say which parts of a location, and
   *  whether a proxy of your own is taken. */
  proxy?: { on?: boolean; always?: boolean; country?: boolean; state?: boolean; city?: boolean; own?: boolean; needsCountry?: boolean; stateOrCity?: boolean };
  captcha?: boolean;
  stealth?: boolean;
  region?: readonly string[];
  /** The session's life, in seconds: [least, most]. */
  timeout?: readonly [number, number];
  /** Saved logins across runs: the vendor's contexts or profiles. */
  keep?: boolean;
  record?: boolean;
  block?: readonly ("ads" | "trackers" | "cookies")[];
  /** Where `options:` goes, as written: the session request's body, or the
   *  connection URL's query. Absent: the vendor takes none. */
  options?: "body" | "query";
  /** web.browse settings this vendor's browser will not take. */
  refuses?: readonly string[];
}

/** `web.browse.session:` — what the vendor's session is asked for. */
export interface BrowseSession {
  proxy?: boolean | { country?: string; state?: string; city?: string; own?: string };
  captcha?: boolean;
  stealth?: boolean;
  region?: string;
  /** seconds */
  timeout?: number;
  keep?: string;
  record?: boolean;
  block?: ("ads" | "trackers" | "cookies")[];
  options?: Record<string, unknown>;
}

export interface BrowserApi {
  session?: SessionSupport;
  /** Steps of web browse this browser cannot do, per the vendor's own docs.
   *  Kept equal to the tool's VENDORS table by the platform's gallery test. */
  lacks?: string[];
  /** The vendor's API reference the adapter was built from, the day it was
   *  last matched to it, and what that page could not confirm. Read by
   *  web-actions.ts; a check older than 90 days fails its test. */
  docs?: string;
  checked?: string;
  gaps?: string;
  name: string;
  aliases?: string[];
  title: string;
  /** How a session is reached: a REST call that returns the endpoint, or a
   *  websocket URL the key goes straight into. */
  how: "session" | "direct";
  host: string;
  secret: string;
  secretFormat?: string;
  what: string;
  note?: string;
}

export const BROWSER_APIS: readonly BrowserApi[] = [
  { name: "browserbase", docs: "https://docs.browserbase.com/reference/api/create-a-session", checked: "2026-09-29", title: "Browserbase", how: "session", host: "api.browserbase.com", secret: "BROWSERBASE_API_KEY",
    session: { proxy: { on: true, country: true, state: true, city: true, own: true, needsCountry: true }, captcha: true, stealth: true, region: ["us-west-2", "us-east-1", "eu-central-1", "ap-southeast-1"], timeout: [60, 21600], keep: true, record: true, block: ["ads"], options: "body" },
    what: "hosted Chromium with stealth; POST /v1/sessions (X-BB-API-Key) returns connectUrl" },
  { name: "steel", docs: "https://docs.steel.dev/overview/sessions-api/quickstart", checked: "2026-09-29", gaps: "session field names are from the official steel-node SDK source; the API reference page is script-only", title: "Steel", how: "session", host: "api.steel.dev", secret: "STEEL_API_KEY",
    session: { proxy: { on: true, country: true, state: true, city: true, own: true }, captcha: true, stealth: true, timeout: [15, 86400], keep: true, block: ["ads"], options: "body" },
    what: "hosted Chromium, open-source core; POST /v1/sessions (steel-api-key), then wss://connect.steel.dev?apiKey&sessionId" },
  { name: "hyperbrowser", docs: "https://hyperbrowser.ai/docs/api-reference/create-new-session.md", checked: "2026-09-29", title: "Hyperbrowser", how: "session", host: "api.hyperbrowser.ai", secret: "HYPERBROWSER_API_KEY",
    session: { proxy: { on: true, country: true, state: true, city: true, own: true, stateOrCity: true }, captcha: true, stealth: true, region: ["us", "us-central", "us-west", "us-east", "asia-south", "europe-west"], timeout: [60, 43200], keep: true, record: true, block: ["ads", "trackers", "cookies"], options: "body" },
    what: "hosted Chromium with built-in unblocking; a session returns its wsEndpoint" },
  { name: "browserless", docs: "https://docs.browserless.io/baas/connection-url-patterns.md", checked: "2026-09-29", title: "Browserless", how: "direct", host: "production-sfo.browserless.io", secret: "BROWSERLESS_TOKEN",
    session: { proxy: { on: true, country: true, city: true, own: true }, captcha: true, stealth: true, region: ["sfo", "lon", "ams"], timeout: [1, 86400], block: ["ads"], options: "query" },
    what: "hosted Chrome; wss://production-sfo.browserless.io?token=… (other regions by name)",
    note: "SSPL-licensed: the free path is out for a paid service; the cloud is a plain vendor." },
  { name: "brightdata", docs: "https://docs.brightdata.com/products/scraping-browser/configuration.md", checked: "2026-09-29", lacks: ["tab"], gaps: "the limits are from a summary of the configuration page, not quoted verbatim", aliases: ["bright-data", "bright_data"], title: "Bright Data Scraping Browser", how: "direct", host: "brd.superproxy.io", secret: "BRIGHTDATA_BROWSER_AUTH",
    session: { proxy: { always: true, country: true }, captcha: true, block: ["ads", "cookies"] },
    secretFormat: "the zone credentials as `brd-customer-<id>-zone-<zone>:<password>` — the whole user:pass, which goes into the websocket URL",
    what: "Chromium behind a residential proxy pool, port 9222 — the one worth paying for when a site refuses everything else" },
  { name: "cdp", docs: "https://chromedevtools.github.io/devtools-protocol/", checked: "2026-09-29", aliases: ["devtools"], title: "Any DevTools address", how: "direct", host: "(the address in the secret)", secret: "BROWSER_CDP_URL",
    secretFormat: "the ws://, wss:// or http(s):// DevTools address, token included where the browser needs one",
    what: "any browser that serves the DevTools protocol — a Chrome started with --remote-debugging-port, a self-hosted pool, a vendor not listed here" },
  { name: "zenrows", docs: "https://docs.zenrows.com/browser-sessions/get-started/playwright.md", checked: "2026-09-29", aliases: ["zen-rows", "zen_rows"], title: "ZenRows Scraping Browser", how: "direct", host: "browser.zenrows.com", secret: "ZENROWS_API_KEY",
    session: { proxy: { always: true, country: true }, timeout: [60, 900], options: "query", refuses: ["user_agent", "device"] },
    what: "hosted Chromium with residential IPs and fingerprinting; wss://browser.zenrows.com?apikey=…" },
];

/** The web's actions, in the order the docs list them. */
export const WEB_ACTIONS = ["search", "fetch", "browse", "crawl", "map", "extract", "answer", "monitor"] as const;
export type WebAction = (typeof WEB_ACTIONS)[number];

/** A provider for one of the actions that came after search, fetch and
 *  browse. Only what the runtime needs — the vault name of the key and the
 *  one host it may go to — plus the docs the adapter in the `web` tool was
 *  built from. None has been called live from here: no account holds these
 *  keys yet, so each is as good as its docs page. */
export interface ActionApi {
  name: string;
  title: string;
  host: string;
  secret: string;
  docs: string;
  checked: string;
  gaps?: string;
}

export const ACTION_APIS: Record<"crawl" | "map" | "extract" | "answer" | "monitor", readonly ActionApi[]> = {
  crawl: [
    { name: "firecrawl", title: "Firecrawl crawl", host: "api.firecrawl.dev", secret: "FIRECRAWL_API_KEY", docs: "https://docs.firecrawl.dev/api-reference/endpoint/crawl-post", checked: "2026-09-29" },
    { name: "tavily", title: "Tavily crawl", host: "api.tavily.com", secret: "TAVILY_API_KEY", docs: "https://docs.tavily.com/documentation/api-reference/endpoint/crawl", checked: "2026-09-29", gaps: "its results carry no title; the first heading is used" },
  ],
  map: [
    { name: "firecrawl", title: "Firecrawl map", host: "api.firecrawl.dev", secret: "FIRECRAWL_API_KEY", docs: "https://docs.firecrawl.dev/api-reference/endpoint/map", checked: "2026-09-29" },
    { name: "tavily", title: "Tavily map", host: "api.tavily.com", secret: "TAVILY_API_KEY", docs: "https://docs.tavily.com/documentation/api-reference/endpoint/map", checked: "2026-09-29" },
  ],
  extract: [
    { name: "firecrawl", title: "Firecrawl JSON extraction", host: "api.firecrawl.dev", secret: "FIRECRAWL_API_KEY", docs: "https://docs.firecrawl.dev/features/llm-extract", checked: "2026-09-29", gaps: "the feature page puts the result at data.json, the endpoint reference at data.answer; both are read" },
    { name: "zyte", title: "Zyte custom attributes", host: "api.zyte.com", secret: "ZYTE_API_KEY_BASIC", docs: "https://docs.zyte.com/zyte-api/usage/extract/custom-attributes.html", checked: "2026-09-29", gaps: "no free-text prompt: a prompt becomes one attribute's description" },
    { name: "hyperbrowser", title: "Hyperbrowser extract", host: "api.hyperbrowser.ai", secret: "HYPERBROWSER_API_KEY", docs: "https://hyperbrowser.ai/docs/web-scraping/extract", checked: "2026-09-29", gaps: "whether schema or prompt is required is not stated" },
  ],
  answer: [
    { name: "exa", title: "Exa answer", host: "api.exa.ai", secret: "EXA_API_KEY", docs: "https://exa.ai/docs/reference/answer", checked: "2026-09-29" },
    { name: "linkup", title: "Linkup sourced answer", host: "api.linkup.so", secret: "LINKUP_API_KEY", docs: "https://docs.linkup.so/pages/documentation/api-reference/endpoint/post-search", checked: "2026-09-29" },
    { name: "tavily", title: "Tavily answer", host: "api.tavily.com", secret: "TAVILY_API_KEY", docs: "https://docs.tavily.com/documentation/api-reference/endpoint/search", checked: "2026-09-29", gaps: "the sources are the results it searched, not per-sentence citations" },
    { name: "parallel", title: "Parallel Responses", host: "api.parallel.ai", secret: "PARALLEL_API_KEY", docs: "https://docs.parallel.ai/responses-api/responses-quickstart.md", checked: "2026-09-29", gaps: "the citation nesting is not pinned down; both spellings are read" },
    { name: "perplexity", title: "Perplexity Agent API", host: "api.perplexity.ai", secret: "PERPLEXITY_API_KEY", docs: "https://docs.perplexity.ai/api-reference/agent-post", checked: "2026-09-29", gaps: "Sonar chat completions ended 27 Sep 2026; whether preset fast searches unasked is not stated, so web_search is asked for" },
    { name: "you", title: "You.com answer", host: "api.you.com", secret: "YOU_API_KEY", docs: "https://you.com/docs/guides/answer/quickstart.md", checked: "2026-09-29", gaps: "the answer's place (data.answer or answer) and the citation field names are not pinned down; both are read" },
  ],
  monitor: [
    { name: "parallel", title: "Parallel Monitor", host: "api.parallel.ai", secret: "PARALLEL_API_KEY", docs: "https://docs.parallel.ai/api-reference/monitor/create-monitor", checked: "2026-09-29", gaps: "an event's output has no documented title or url; its text and citations are read" },
    { name: "firecrawl", title: "Firecrawl change tracking", host: "api.firecrawl.dev", secret: "FIRECRAWL_API_KEY", docs: "https://docs.firecrawl.dev/features/change-tracking", checked: "2026-09-29" },
  ],
};

export function findActionApi(action: keyof typeof ACTION_APIS, name: string): ActionApi | undefined {
  const key = name.trim().toLowerCase();
  return ACTION_APIS[action].find((a) => a.name === key);
}

export function findBrowserApi(name: string): BrowserApi | undefined {
  const key = name.trim().toLowerCase();
  return BROWSER_APIS.find((a) => a.name === key || a.aliases?.includes(key));
}

export function findFetchApi(name: string): FetchApi | undefined {
  const key = name.trim().toLowerCase();
  return FETCH_APIS.find((a) => a.name === key || a.aliases?.includes(key));
}

export function findSearchApi(name: string): SearchApi | undefined {
  const key = name.trim().toLowerCase();
  return SEARCH_APIS.find((a) => a.name === key || a.aliases?.includes(key));
}

/** Whose index answers, for the ones that will answer at all. Checked against
 *  each vendor's own documentation on 2026-09-16. Worth stating out loud
 *  because it is the whole reason to prefer a provider's search over ours:
 *  you are buying an index we cannot crawl, not a faster endpoint. */
export const SEARCH_INDEX: Record<string, string> = {
  anthropic: "Brave",
  zai: "Zhipu's own (China-weighted)",
  openrouter: "native where the model supports it, Exa otherwise",
  openai: "Bing, plus OpenAI's own OAI-SearchBot crawl",
  kimi: "Moonshot's own (China-weighted)",
};

export const PROVIDERS: readonly ProviderPreset[] = [
  // ------------------------------------------------ Anthropic-shaped, direct
  { name: "anthropic", title: "Anthropic", format: "anthropic", baseUrl: "https://api.anthropic.com", auth: "x-api-key", verified: true,
    note: "Models newer than Opus 4.6 reject top_k with a 400; the runtime never sends it unless a params: block does." , search: "anthropic" },
  { name: "openrouter", title: "OpenRouter", format: "anthropic", baseUrl: "https://openrouter.ai/api", auth: "bearer", verified: true,
    note: "Hundreds of models behind one key. Its own docs disagree on how well non-Anthropic models hold a tool loop on this endpoint — probe the model you mean to use." , search: "plugin" },
  { name: "deepseek", title: "DeepSeek", format: "anthropic", baseUrl: "https://api.deepseek.com/anthropic", auth: "x-api-key",
    note: "Ignores top_k, cache_control and thinking budgets; Claude model names are remapped to DeepSeek's." },
  { name: "kimi", title: "Moonshot Kimi", format: "anthropic", baseUrl: "https://api.moonshot.ai/anthropic", auth: "bearer",
    note: "Own model ids only. Known bug (2026-09): K3 reuses one tool_use id across separate calls, which breaks a tool loop." , search: "builtin_fn" },
  { name: "moonshot", title: "Moonshot Kimi", format: "anthropic", baseUrl: "https://api.moonshot.ai/anthropic", auth: "bearer",
    note: "Same endpoint as kimi." , search: "builtin_fn" },
  { name: "zai", title: "z.ai (GLM)", format: "anthropic", baseUrl: "https://api.z.ai/api/anthropic", auth: "bearer" , search: "anthropic" },
  { name: "minimax", title: "MiniMax", format: "anthropic", baseUrl: "https://api.minimax.io/anthropic", auth: "bearer" },
  { name: "qwen", title: "Alibaba Qwen (Model Studio)", format: "anthropic", auth: "x-api-key",
    note: "base_url depends on the plan: pay-as-you-go https://<workspace>.<region>.maas.aliyuncs.com/apps/anthropic; Coding Plan https://coding-intl.dashscope.aliyuncs.com/apps/anthropic. Own model ids (qwen3.7-max …), no remap; no reasoning_effort, use thinking." },
  { name: "fireworks", title: "Fireworks AI", format: "anthropic", baseUrl: "https://api.fireworks.ai/inference", auth: "bearer",
    note: "No server-side tools; no adaptive thinking." },
  { name: "deepinfra", title: "DeepInfra", format: "anthropic", baseUrl: "https://api.deepinfra.com/anthropic", auth: "bearer" },
  { name: "sambanova", title: "SambaNova", format: "anthropic", baseUrl: "https://api.sambanova.ai", auth: "x-api-key",
    note: "No server-side tools, base64 images only." },
  { name: "vercel", title: "Vercel AI Gateway", format: "anthropic", baseUrl: "https://ai-gateway.vercel.sh", auth: "bearer",
    note: "Model ids are namespaced, e.g. openai/gpt-5." },
  { name: "litellm", title: "LiteLLM (yours)", format: "anthropic", auth: "x-api-key",
    note: "base_url is your proxy, e.g. http://litellm.internal:4000. It presents an Anthropic endpoint and speaks anything behind it." },
  { name: "cloudflare-gateway", title: "Cloudflare AI Gateway", format: "anthropic", auth: "x-api-key",
    note: "base_url is https://gateway.ai.cloudflare.com/v1/<account>/<gateway>/anthropic — a pass-through to Anthropic with logging; for Cloudflare's own models use name: cloudflare." },
  { name: "ollama", title: "Ollama (local)", format: "anthropic", baseUrl: "http://localhost:11434", auth: "x-api-key",
    note: "v0.14+. Ignores tool_choice and cache_control; accepts but does not enforce thinking budgets; base64 images only. Any key value is accepted." },
  { name: "lmstudio", title: "LM Studio (local)", format: "anthropic", baseUrl: "http://localhost:1234", auth: "x-api-key" },
  { name: "vllm", title: "vLLM (yours)", format: "anthropic", auth: "bearer",
    note: "base_url is your server (default :8000). Start it with --enable-auto-tool-choice and a --tool-call-parser or no tool loop closes." },

  // ------------------------------------------- Chat-Completions, translated
  { name: "openai", title: "OpenAI", format: "openai", baseUrl: "https://api.openai.com/v1", auth: "bearer", verified: true,
    maxTokensParam: "max_completion_tokens", reasoningEffort: true,
    note: "Reached over Chat Completions, which OpenAI keeps supporting; the Responses API is not spoken here, so a reasoning model's reasoning does not carry across tool calls." , search: "openai" },
  { name: "gemini", title: "Google Gemini", format: "openai", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", auth: "bearer",
    note: "Google's OpenAI-compatible route. Unknown parameters are ignored silently; reasoning cannot be switched off on the newest models." },
  { name: "xai", title: "xAI Grok", format: "openai", baseUrl: "https://api.x.ai/v1", auth: "bearer",
    maxTokensParam: "max_completion_tokens", reasoningEffort: true },
  { name: "groq", title: "Groq", format: "openai", baseUrl: "https://api.groq.com/openai/v1", auth: "bearer",
    maxTokensParam: "max_completion_tokens", reasoningEffort: true },
  { name: "mistral", title: "Mistral", format: "openai", baseUrl: "https://api.mistral.ai/v1", auth: "bearer" },
  { name: "together", title: "Together AI", format: "openai", baseUrl: "https://api.together.ai/v1", auth: "bearer" },
  { name: "cerebras", title: "Cerebras", format: "openai", baseUrl: "https://api.cerebras.ai/v1", auth: "bearer",
    maxTokensParam: "max_completion_tokens", reasoningEffort: true },
  { name: "huggingface", title: "Hugging Face", format: "openai", baseUrl: "https://router.huggingface.co/v1", auth: "bearer",
    note: "The Inference Providers router; model ids are Hub ids, e.g. meta-llama/Llama-3.3-70B-Instruct." },
  { name: "cloudflare", title: "Cloudflare Workers AI", format: "openai", auth: "bearer",
    note: "base_url is https://api.cloudflare.com/client/v4/accounts/<account>/ai/v1" },
  { name: "nebius", title: "Nebius Token Factory", format: "openai", baseUrl: "https://api.tokenfactory.nebius.com/v1", auth: "bearer" },
  { name: "novita", title: "Novita", format: "openai", baseUrl: "https://api.novita.ai/openai", auth: "bearer",
    note: "Also has an Anthropic-shaped route at https://api.novita.ai/anthropic — spell it out with format: anthropic to skip the translator (header shape unverified)." },
  { name: "hyperbolic", title: "Hyperbolic", format: "openai", baseUrl: "https://api.hyperbolic.xyz/v1", auth: "bearer" },
];

/**
 * Request fields `params:` may not set.
 *
 * These are not the provider's knobs, they are the conversation: the
 * messages, the tools the agent declared, whether the reply streams, and
 * which model the tier resolved to. A file that could overwrite them could
 * silently break the agent loop — or make `model: fast` mean something else
 * — from a line that looks like a tuning option. Everything else passes
 * through untouched, because a vendor's own parameters are the vendor's
 * business and this format will never model them.
 */
export const PROTECTED_PARAMS = ["messages", "tools", "stream", "stream_options", "model"] as const;

/** A preset by any spelling a person reaches for: case-insensitive, and
 *  "z.ai" / "z-ai" / "hugging-face" all land. */
export function providerPreset(name: unknown): ProviderPreset | null {
  if (typeof name !== "string") return null;
  const key = name.trim().toLowerCase().replace(/[^a-z0-9]/g, "");
  if (!key) return null;
  return PROVIDERS.find((p) => p.name.replace(/[^a-z0-9]/g, "") === key) ?? null;
}

/** Does this URL look like a Chat-Completions endpoint a person pasted
 *  without saying `format: openai`? The heuristic the checker uses to say
 *  so before a run fails with a 404 from the wrong path. */
export function looksOpenAiShaped(baseUrl: string): boolean {
  return /\/v1\/?$|\/chat\/completions|api\.openai\.com|\/openai\b/i.test(baseUrl);
}


/** What `web.search: <name>` in an agent's frontmatter resolves to.
 *
 *  Unset means ours: the account's own search engine, free, on the run
 *  record. Naming a provider buys that provider's index instead — which is
 *  the only reason to do it, and the reason the failure modes below are
 *  errors rather than a quiet fallback. A desk that silently searched
 *  nothing for a month is worse than one that refused to deploy.
 */
export interface SearchChoice {
  /** null when ours answers. */
  provider: string | null;
  shape?: SearchShape;
  /** Whose index answers, for the run trace and the help page. */
  index?: string;
  /** For a direct API: the vault name of the customer's key, and the one
   *  host the egress proxy may fill it in for. */
  secret?: string;
  secretOptional?: boolean;
  host?: string;
  /** Set when the name cannot work; `check` prints it and refuses. */
  error?: string;
}

/** `web.search: exa`, or the long form with the customer's own vault name:
 *
 *    web:
 *      search:
 *        name: exa
 *        key: ${MY_EXA_KEY}
 *
 *  The same two spellings `provider:` takes. `key` is a reference, never a
 *  value — a credential written into a markdown file is refused here, the
 *  way it is refused everywhere else in foldrun. */
/**
 * `web.browse:` settings — how the browser presents itself, not what one call
 * does.
 *
 *    web:
 *      browse:
 *        engine: firefox
 *        user_agent: "Mozilla/5.0 …"
 *
 * The engine and the user agent belong in the file, not in every call. They
 * travel together: a Cloudflare clearance cookie is bound to the user agent
 * that earned it, so a skill repeating the UA in each call is one edit away
 * from a session that silently stops working (Medium, 2026-09-17).
 *
 * `via:` (or `name:`) names a remote browser vendor, which is what this key
 * meant when it only took a string; that spelling still works. Anything a
 * single call decides — mode, actions, wait_for, block — stays in the call.
 */
export interface BrowseSettings {
  engine?: "chrome" | "chromium" | "firefox" | "webkit" | "lightpanda" | "obscura";
  user_agent?: string;
  device?: string;
  locale?: string;
  timezone?: string;
  /** The NAME of a vault secret holding this site's sign-in cookies, never
   *  the cookies themselves. It sits here beside `user_agent` because the two
   *  are one thing: a Cloudflare clearance cookie is bound to the user agent
   *  that earned it, and a file that carries one without the other is a
   *  session waiting to stop working. */
  cookies?: string;
  cookie_domain?: string;
  /** The NAME of a vault secret holding this site's signed-in Web Storage and
   *  IndexedDB, as JSON: `{ localStorage, sessionStorage, indexedDB }`. The
   *  sibling of `cookies:` for the sites that keep their login in storage
   *  rather than a cookie — Firebase writes a record to IndexedDB, MSAL can
   *  keep tokens in sessionStorage, and a cookie jar alone opens those pages
   *  signed out. Seeded before the page's own scripts run, never read back. */
  storage?: string;
  storage_origin?: string;
  /** Named bundles of the same settings plus the per-call ones that travel
   *  with an identity — proxy, headers, geolocation, permissions,
   *  color_scheme, block — chosen on a call as `identity=<name>`. "As an
   *  Australian phone" is six settings; a name says it once. Each value is a
   *  map of text (or JSON for headers), validated here the way the block is. */
  identities?: Record<string, Record<string, string>>;
  /** false runs the full browser with a window, on a virtual screen where
   *  the machine has none. Unset or true is the usual no-window browser. */
  headless?: boolean;
  /** Which build of the engine to run: a Chrome release channel
   *  (`stable`/`beta`/`dev`) or a label naming a binary installed in the
   *  image (`/opt/browser/<engine>/<version>/`). Unset is the pinned
   *  default. Resolved in the tool, which falls back to the default and
   *  says so when the named build is not installed. */
  version?: string;
  /** true keeps the browser and its open page alive between this agent's
   *  calls in a step, so a multi-step form can be driven one step per call.
   *  Chromium-only (chrome/chromium). Unset: each call is a fresh page, with
   *  only cookies carried by a session. */
  live?: boolean;
  /** The domains this agent's browser may reach at all — pages, scripts,
   *  fetches, sockets. A lock, not a default: a call may narrow it and never
   *  widen it, so no page's text can talk the model past it. */
  allowed_domains?: string[];
  /** Actions this agent may never take (eval, download, upload, …), checked
   *  before a browser opens. Names from WEB_BROWSE_ACTIONS, plus js. */
  deny?: string[];
  /** true marks the page's words in every reply with a nonce the page cannot
   *  know, so text written to look like instructions stays the page's. */
  boundaries?: boolean;
  /** Workspace paths of scripts run in every page before its own. */
  init?: string[];
  /** Workspace paths of unpacked Chrome extensions to load (Chromium, in the step). */
  extensions?: string[];
  /** true gives pages WebGPU, on a software GPU where there is none. */
  webgpu?: boolean;
  /** true opens pages whose certificate does not check out (staging, self-signed). */
  ignore_https_errors?: boolean;
  /** The NAME of a vault secret whose value encrypts state= logins at rest. */
  state_key?: string;
  /** true records every call, so the run page always has the recording to play. */
  video?: boolean;
  /** false stops the tool streaming its page to the run page while the step
   *  runs. Unset is on wherever the platform can take the frames. */
  live_view?: boolean;
  /** What the vendor's own session is asked for (only with a vendor). */
  session?: BrowseSession;
}

/** Every action web browse takes, which is what `deny:` may name. The
 *  gallery test holds this equal to the tool's own list, so a new action
 *  cannot be undeniable, and a misspelt denial — which would deny nothing —
 *  is refused at check time instead. */
export const WEB_BROWSE_ACTIONS = [
  "click", "dblclick", "rightclick", "hover", "check", "uncheck", "drag", "fill", "type", "press", "select",
  "wait", "goto", "screenshot", "pdf", "scroll", "paste", "upload", "download", "extract", "frame", "tab",
  "back", "forward", "reload", "focus", "clear", "highlight", "keyboard", "keydown", "keyup", "mouse", "wheel",
  "tap", "swipe", "clipboard", "eval", "get", "expect", "if", "mock", "unmock", "offline", "cookie",
  "localstorage", "sessionstorage", "viewport", "dialog", "solve",
  "pushstate", "insert", "webmcp", "login",
] as const;

// What a person writes, and what Playwright calls it. "chromium" and "webkit"
// are engine names; "chrome" and "safari" are what everyone else calls those
// browsers, and a file should read the way the room talks. Both spellings are
// accepted forever: agents written before this keep working, and the engine
// names remain the truth underneath (chrome here is the open-source Chromium
// build, not the branded Chrome; safari is WebKit, Safari's engine).
const BROWSE_ENGINE_ALIASES: Record<string, "chrome" | "chromium" | "firefox" | "webkit" | "lightpanda" | "obscura"> = {
  // `chrome` is the branded Google Chrome (Playwright channel "chrome"), where
  // the image has it; `chromium` is the open-source build. Same engine, a
  // truer user-agent and codecs. Both still fall back to chromium if Chrome
  // is not installed (a laptop without it, or an arch Google does not ship).
  chrome: "chrome",
  chromium: "chromium",
  firefox: "firefox",
  safari: "webkit",
  webkit: "webkit",
  // A browser that runs the JavaScript and never draws: a fraction of
  // Chromium's memory, and no screenshots.
  lightpanda: "lightpanda",
  // A headless browser in Rust around V8 that does draw (screenshots, a
  // raster PDF), light like Lightpanda; no request interception.
  obscura: "obscura",
};
const BROWSE_ENGINES = ["chrome", "firefox", "safari", "lightpanda", "obscura"] as const;
const BROWSE_SETTING_KEYS = [
  "engine", "user_agent", "device", "locale", "timezone", "cookies", "cookie_domain", "storage", "storage_origin", "identities", "headless", "version", "live",
  "allowed_domains", "deny", "boundaries", "init", "extensions", "webgpu", "ignore_https_errors", "state_key",
  "video", "live_view", "session",
] as const;
const BROWSE_DOMAIN = /^(\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;
/** A list setting: YAML's list, or one comma-separated line. */
function browseList(v: unknown): string[] | null {
  if (Array.isArray(v)) return v.every((x) => typeof x === "string") ? v.map((x) => x.trim()).filter(Boolean) : null;
  if (typeof v === "string") return v.split(",").map((x) => x.trim()).filter(Boolean);
  return null;
}
// What one identity may carry: the block's own settings, and the call
// arguments that describe who the browser is rather than what one call does.
const IDENTITY_KEYS = ["engine", "user_agent", "device", "locale", "timezone", "cookies", "cookie_domain", "storage", "storage_origin", "proxy", "headers", "geolocation", "permissions", "color_scheme", "block"] as const;
const SECRET_NAME = /^[A-Z][A-Z0-9_]*$/;

/** One named identity, checked the way the block is: text values, an
 *  engine that exists, secrets by NAME, a cookie with its domain. */
function readIdentity(name: string, raw: unknown): { identity?: Record<string, string>; error?: string } {
  const where = `web.browse.identities.${name}`;
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(name)) return { error: `web.browse.identities: "${name}" is not a plain name (letters, digits, dot, dash, underscore).` };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { error: `${where} must be a block of settings, like { device: "Pixel 7", locale: en-AU }.` };
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!(IDENTITY_KEYS as readonly string[]).includes(k)) return { error: `${where}.${k} is not an identity setting — they are ${IDENTITY_KEYS.join(", ")}.` };
    if (v === undefined || v === null || v === "") continue;
    if (k === "headers") {
      if (!v || typeof v !== "object" || Array.isArray(v)) return { error: `${where}.headers must be a map of header to value.` };
      out.headers = JSON.stringify(v);
      continue;
    }
    if (typeof v !== "string") return { error: `${where}.${k} must be text, not ${Array.isArray(v) ? "a list" : typeof v}.` };
    if (k === "engine") {
      const canonical = BROWSE_ENGINE_ALIASES[v.toLowerCase()];
      if (!canonical) return { error: `${where}.engine: ${v} — the browsers are ${BROWSE_ENGINES.join(", ")}.` };
      out.engine = canonical;
      continue;
    }
    if ((k === "cookies" || k === "storage" || k === "proxy") && !SECRET_NAME.test(v)) {
      return { error: `${where}.${k} must be the NAME of a vault secret (CAPITALS), never the value — store it with \`foldrun secrets set NAME\`.` };
    }
    out[k] = v;
  }
  if (out.cookies && !out.cookie_domain) return { error: `${where}.cookies needs cookie_domain beside it — write \`cookie_domain: .example.com\`.` };
  if (out.storage && !out.storage_origin) return { error: `${where}.storage needs storage_origin beside it — write \`storage_origin: https://www.example.com\`.` };
  return { identity: out };
}

/** The settings in a `web.browse:` block, and the vendor part with them
 *  removed — so one key carries both without either learning about the
 *  other. A string, or a block with no settings, gives no settings at all. */
const SESSION_KEYS = ["proxy", "captcha", "stealth", "region", "timeout", "keep", "record", "block", "options"] as const;
const BLOCKABLE = ["ads", "trackers", "cookies"] as const;

/** A duration as a person writes one — 90s, 30m, 2h, 1d, or a bare number
 *  of seconds — in seconds; null when it is none of those. */
function seconds(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v) && v > 0) return Math.round(v);
  const m = typeof v === "string" ? /^\s*(\d+(?:\.\d+)?)\s*(s|m|h|d)?\s*$/i.exec(v) : null;
  if (!m) return null;
  return Math.round(Number(m[1]) * { s: 1, m: 60, h: 3600, d: 86400 }[(m[2] ?? "s").toLowerCase() as "s"]);
}

/** The shape of `web.browse.session:`, before anyone knows the vendor. What
 *  the vendor can do is browseSessionProblems' question. */
export function readBrowseSession(raw: unknown): { session?: BrowseSession; error?: string } {
  const at = "web.browse.session";
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { error: `${at} is a block — what the vendor's own session is asked for: proxy, captcha, stealth, region, timeout, keep, record, block, options.` };
  }
  const out: BrowseSession = {};
  const bool = (k: string, v: unknown) => (v === true || v === "true" ? true : v === false || v === "false" ? false : undefined);
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!(SESSION_KEYS as readonly string[]).includes(k)) return { error: `${at}.${k}: is not a session setting. They are ${SESSION_KEYS.join(", ")}.` };
    if (v === undefined || v === null || v === "") continue;
    if (k === "captcha" || k === "stealth" || k === "record") {
      const b = bool(k, v);
      if (b === undefined) return { error: `${at}.${k} is true or false, not ${JSON.stringify(v)}.` };
      out[k] = b;
    } else if (k === "proxy") {
      const b = bool(k, v);
      if (b !== undefined) { out.proxy = b; continue; }
      if (typeof v !== "object" || Array.isArray(v)) return { error: `${at}.proxy is true, false, or a block: country, state, city — or own: a secret holding your proxy's URL.` };
      const p: { country?: string; state?: string; city?: string; own?: string } = {};
      for (const [pk, pv] of Object.entries(v as Record<string, unknown>)) {
        if (pk === "country" || pk === "state") {
          if (typeof pv !== "string" || !/^[A-Za-z]{2}$/.test(pv.trim())) return { error: `${at}.proxy.${pk} is a two-letter code, like ${pk === "country" ? "AU" : "CA"} — not ${JSON.stringify(pv)}.` };
          p[pk] = pv.trim().toUpperCase();
        } else if (pk === "city") {
          if (typeof pv !== "string" || !pv.trim()) return { error: `${at}.proxy.city is a city's name.` };
          p.city = pv.trim();
        } else if (pk === "own") {
          if (typeof pv !== "string" || !SECRET_NAME.test(pv.trim())) return { error: `${at}.proxy.own names a secret holding your proxy's URL (http://user:pass@host:port) — the NAME, never the URL.` };
          p.own = pv.trim();
        } else {
          return { error: `${at}.proxy.${pk}: is not a proxy setting. They are country, state, city, own.` };
        }
      }
      if (p.own && (p.country || p.state || p.city)) return { error: `${at}.proxy: own is your proxy, so its location is yours to set there — drop country, state and city, or own.` };
      if (p.state && p.country && p.country !== "US") return { error: `${at}.proxy.state is for the US only.` };
      out.proxy = p;
    } else if (k === "region" || k === "keep") {
      if (typeof v !== "string" || !v.trim()) return { error: `${at}.${k} is a name.` };
      if (k === "keep" && !/^[a-z0-9][a-z0-9-]{0,62}$/.test(v.trim())) return { error: `${at}.keep is a short name in lower case, like client-portal — the saved login it keeps.` };
      out[k] = v.trim();
    } else if (k === "timeout") {
      const n = seconds(v);
      if (n === null) return { error: `${at}.timeout is a duration, like 90s, 30m or 2h — not ${JSON.stringify(v)}.` };
      out.timeout = n;
    } else if (k === "block") {
      const list = browseList(v);
      const bad = list?.find((x) => !(BLOCKABLE as readonly string[]).includes(x));
      if (!list || bad !== undefined) return { error: `${at}.block is a list of ${BLOCKABLE.join(", ")}${bad ? ` — not ${bad}` : ""}.` };
      out.block = [...new Set(list)] as BrowseSession["block"];
    } else {
      if (typeof v !== "object" || Array.isArray(v)) return { error: `${at}.options is a block, passed to the vendor as written.` };
      out.options = v as Record<string, unknown>;
    }
  }
  return { session: out };
}

/**
 * Everything wrong with a session block for this vendor: a setting the
 * vendor has no option for (naming the vendors that do), a value outside its
 * range, and the browse settings its browser will not take. The rule the
 * actions follow — the file is fixed, nothing is quietly dropped.
 */
export function browseSessionProblems(settings: BrowseSettings, vendor: string | null): string[] {
  const s = settings.session;
  const out: string[] = [];
  const api = vendor ? findBrowserApi(vendor) : undefined;
  const sup = api?.session ?? {};
  const who = (pred: (x: SessionSupport) => boolean | undefined) =>
    BROWSER_APIS.filter((b) => b.session && pred(b.session)).map((b) => b.name).join(", ") || "none";
  const at = "web.browse.session";
  for (const key of api?.session?.refuses ?? []) {
    if ((settings as Record<string, unknown>)[key] !== undefined) {
      out.push(`web.browse.${key}: ${api!.title} does not let a session change it (its docs) — drop it, or render elsewhere.`);
    }
  }
  if (!s) return out;
  if (!api) {
    out.push(`${at}: is what a vendor's own session is asked for, and this browser is the account's own — name one with via:, or drop session:.`);
    return out;
  }
  const label = api.title;
  const need = (key: string, ok: boolean | undefined, pred: (x: SessionSupport) => boolean | undefined) => {
    if (!ok) out.push(`${at}.${key}: ${label} has no such option. These do: ${who(pred)}.`);
  };
  if (s.proxy !== undefined) {
    const p = sup.proxy;
    if (s.proxy === false && p?.always) out.push(`${at}.proxy: ${label} always goes through its own proxy network — false cannot be kept.`);
    else if (s.proxy === true) need("proxy", p?.on || p?.always, (x) => x.proxy?.on || x.proxy?.always);
    else if (typeof s.proxy === "object") {
      for (const part of ["country", "state", "city", "own"] as const) {
        if (s.proxy[part] !== undefined) need(`proxy.${part}`, p?.[part], (x) => x.proxy?.[part]);
      }
      if (p?.needsCountry && !s.proxy.own && !s.proxy.country) out.push(`${at}.proxy: ${label} needs a country for a proxy location (its docs) — add country:.`);
      if (p?.stateOrCity && s.proxy.state && s.proxy.city) out.push(`${at}.proxy: ${label} takes a state or a city, not both (its docs).`);
    }
  }
  if (s.captcha !== undefined) need("captcha", sup.captcha, (x) => x.captcha);
  if (s.stealth !== undefined) need("stealth", sup.stealth, (x) => x.stealth);
  if (s.record !== undefined) need("record", sup.record, (x) => x.record);
  if (s.keep !== undefined) {
    need("keep", sup.keep, (x) => x.keep);
    // A saved login lives in the vendor's own browser context, which is
    // used as it is: a context made to measure would not be the saved one.
    for (const key of ["user_agent", "device", "locale", "timezone", "identities"] as const) {
      if ((settings as Record<string, unknown>)[key] !== undefined) {
        out.push(`web.browse.${key}: with session.keep the vendor's saved browser is used as it stands, so ${key} cannot be applied — drop one of them.`);
      }
    }
  }
  if (s.region !== undefined) {
    if (!sup.region) need("region", false, (x) => Boolean(x.region));
    else if (!sup.region.includes(s.region)) out.push(`${at}.region: ${label}'s regions are ${sup.region.join(", ")} — not ${s.region}.`);
  }
  if (s.timeout !== undefined) {
    if (!sup.timeout) need("timeout", false, (x) => Boolean(x.timeout));
    else if (s.timeout < sup.timeout[0] || s.timeout > sup.timeout[1]) {
      out.push(`${at}.timeout: ${label} takes ${sup.timeout[0]}s to ${sup.timeout[1]}s, not ${s.timeout}s.`);
    }
  }
  for (const b of s.block ?? []) {
    if (!sup.block?.includes(b)) out.push(`${at}.block: ${label} cannot block ${b}. These can: ${who((x) => x.block?.includes(b))}.`);
  }
  if (s.options !== undefined && !sup.options) out.push(`${at}.options: ${label} takes no options beyond these.`);
  return out;
}

export function readBrowseSettings(raw: unknown): { settings: BrowseSettings; rest: unknown; error?: string } {
  // An empty leftover is nothing at all. Returned as `{}` it reads to the
  // vendor resolver as "the long form, with no name", which is a second
  // error about a key the person never wrote.
  const left = (o: Record<string, unknown>) => (Object.keys(o).length ? o : undefined);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { settings: {}, rest: raw };
  const o = raw as Record<string, unknown>;
  const settings: BrowseSettings = {};
  const rest: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) {
    if (!(BROWSE_SETTING_KEYS as readonly string[]).includes(k)) {
      rest[k] = v;
      continue;
    }
    if (v === undefined || v === null || v === "") continue;
    if (k === "identities") {
      if (!v || typeof v !== "object" || Array.isArray(v)) {
        return { settings, rest: left(rest), error: "web.browse.identities must be a map of name to settings, like { au-mobile: { device: \"Pixel 7\", locale: en-AU } }." };
      }
      const identities: Record<string, Record<string, string>> = {};
      for (const [name, block] of Object.entries(v as Record<string, unknown>)) {
        const read = readIdentity(name, block);
        if (read.error) return { settings, rest: left(rest), error: read.error };
        identities[name] = read.identity!;
      }
      if (Object.keys(identities).length) settings.identities = identities;
      continue;
    }
    // The one setting that is a yes or no. YAML gives a boolean; a quoted
    // "false" is the same wish and is read as one.
    if (k === "headless") {
      const b = v === true || v === "true" ? true : v === false || v === "false" ? false : undefined;
      if (b === undefined) return { settings, rest: left(rest), error: `web.browse.headless is true or false, not ${JSON.stringify(v)}.` };
      settings.headless = b;
      continue;
    }
    if (k === "live" || k === "boundaries" || k === "webgpu" || k === "ignore_https_errors" || k === "video") {
      const b = v === true || v === "true" ? true : v === false || v === "false" ? false : undefined;
      if (b === undefined) return { settings, rest: left(rest), error: `web.browse.${k} is true or false, not ${JSON.stringify(v)}.` };
      if (b) settings[k] = true;
      continue;
    }
    // The one that is on by default: only false travels.
    if (k === "session") {
      const r = readBrowseSession(v);
      if (r.error) return { settings, rest: left(rest), error: r.error };
      settings.session = r.session;
      continue;
    }
    if (k === "live_view") {
      const b = v === true || v === "true" ? true : v === false || v === "false" ? false : undefined;
      if (b === undefined) return { settings, rest: left(rest), error: `web.browse.live_view is true or false, not ${JSON.stringify(v)}.` };
      if (!b) settings.live_view = false;
      continue;
    }
    if (k === "allowed_domains") {
      const list = browseList(v)?.map((d) => d.toLowerCase());
      if (!list) return { settings, rest: left(rest), error: "web.browse.allowed_domains is a list of domains, like [example.com, \"*.example.com\"]." };
      const bad = list.find((d) => !BROWSE_DOMAIN.test(d));
      if (bad) return { settings, rest: left(rest), error: `web.browse.allowed_domains: ${bad} is not a domain or *.domain — no scheme, no path.` };
      if (list.length) settings.allowed_domains = list;
      continue;
    }
    if (k === "deny") {
      const list = browseList(v)?.map((d) => d.toLowerCase());
      if (!list) return { settings, rest: left(rest), error: "web.browse.deny is a list of actions, like [eval, download]." };
      const known = new Set<string>([...WEB_BROWSE_ACTIONS, "js"]);
      const bad = list.find((a) => !known.has(a));
      if (bad) return { settings, rest: left(rest), error: `web.browse.deny: ${bad} is not a browse action — a misspelt denial would deny nothing. The actions are ${[...known].join(", ")}.` };
      if (list.length) settings.deny = list;
      continue;
    }
    if (k === "init" || k === "extensions") {
      const list = browseList(v);
      if (!list) return { settings, rest: left(rest), error: `web.browse.${k} is a list of workspace paths, like [${k === "init" ? "scripts/stub.js" : "library/extensions/my-ext"}].` };
      const bad = list.find((p) => p.startsWith("/") || p.split(/[\\/]/).includes("..") || p.includes(","));
      if (bad) return { settings, rest: left(rest), error: `web.browse.${k}: ${bad} must be a path inside the workspace (no leading /, no .., no comma).` };
      if (list.length) settings[k] = list;
      continue;
    }
    if (k === "state_key") {
      if (typeof v !== "string" || !/^[A-Z][A-Z0-9_]{0,63}$/.test(v)) return { settings, rest: left(rest), error: "web.browse.state_key must be the NAME of a vault secret (CAPITALS), never the key — store it with `foldrun secrets set NAME` and declare it under secrets:." };
      settings.state_key = v;
      continue;
    }
    if (k === "version") {
      const val = String(v).trim();
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/.test(val)) return { settings, rest: left(rest), error: `web.browse.version: ${JSON.stringify(v)} — a plain label like stable, beta, dev, or a build name (letters, digits, dot, dash, underscore).` };
      settings.version = val;
      continue;
    }
    if (typeof v !== "string") {
      return { settings, rest: left(rest), error: `web.browse.${k} must be text, not ${Array.isArray(v) ? "a list" : typeof v}.` };
    }
    if (k === "engine") {
      const canonical = BROWSE_ENGINE_ALIASES[v.toLowerCase()];
      if (!canonical) {
        return { settings, rest: left(rest), error: `web.browse.engine: ${v} — the browsers are ${BROWSE_ENGINES.join(", ")}.` };
      }
      settings.engine = canonical;
      continue;
    }
    // A vault name, not a cookie. Someone will eventually paste the header
    // line straight into the file; it is refused here, where the mistake is
    // still private, rather than committed and read by everyone with the repo.
    if (k === "storage" && !/^[A-Z][A-Z0-9_]*$/.test(v)) {
      return {
        settings,
        rest: left(rest),
        error:
          `web.browse.storage must be the NAME of a vault secret (CAPITALS), not the storage itself — ` +
          `store the JSON with \`foldrun secrets set NAME\` and write \`storage: NAME\`.`,
      };
    }
    // An origin, not a cookie domain: Web Storage and IndexedDB are walled off
    // per origin, scheme and host together, so `.example.com` cannot be seeded.
    if (k === "storage_origin" && !/^https?:\/\/[^/\s]+$/.test(v)) {
      return {
        settings,
        rest: left(rest),
        error:
          `web.browse.storage_origin must be an origin, scheme and host with no path — ` +
          `write \`storage_origin: https://www.example.com\`, not \`.example.com\`.`,
      };
    }
    if (k === "cookies" && !/^[A-Z][A-Z0-9_]*$/.test(v)) {
      return {
        settings,
        rest: left(rest),
        error:
          `web.browse.cookies must be the NAME of a vault secret (CAPITALS), not the cookies themselves — ` +
          `store them with \`foldrun secrets set NAME\` and write \`cookies: NAME\`.`,
      };
    }
    (settings as Record<string, string>)[k] = v;
  }
  // A cookie default without a domain would ride on whatever host the call
  // opens, which is one agent handing a site someone else's session. The
  // domain is what keeps a file-level cookie to the site it belongs to.
  if (settings.cookies && !settings.cookie_domain) {
    return {
      settings,
      rest: left(rest),
      error:
        `web.browse.cookies needs web.browse.cookie_domain beside it — a cookie default with no domain ` +
        `would be sent to whatever site the call opens. Write \`cookie_domain: .example.com\`.`,
    };
  }

  // Storage is per origin, and seeding it into the wrong one would hand a
  // site another site's signed-in state — the same mistake `cookie_domain`
  // exists to prevent, one storage area over.
  if (settings.storage && !settings.storage_origin) {
    return {
      settings,
      rest: left(rest),
      error:
        `web.browse.storage needs web.browse.storage_origin beside it — Web Storage and IndexedDB are ` +
        `walled off per origin, so the tool has to be told which one. Write \`storage_origin: https://www.example.com\`.`,
    };
  }

  // `via:` is the readable name for what used to be the whole value.
  if (typeof rest.via === "string" && rest.name === undefined) {
    rest.name = rest.via;
    delete rest.via;
  }
  return { settings, rest: Object.keys(rest).length ? rest : undefined };
}

/**
 * `web.search:` settings — what the account's own engine (SearXNG) is asked,
 * not who answers.
 *
 *    web:
 *      search:
 *        engines: [bing, google cse, duckduckgo]
 *        categories: [general, news]
 *        safesearch: moderate
 *
 * Every SearXNG request option that changes what comes back has a key here;
 * the ones that only change its HTML page (theme, results_on_new_tab,
 * image_proxy, url_formatting) do not, because in JSON they do nothing and a
 * key that does nothing is a question someone asks later. Engine and
 * category names are checked for shape here and against the running
 * instance by the tool (its /config), because the instance decides which of
 * SearXNG's engines are loaded. Plugin ids are a short list that changes
 * rarely, so a misspelt one — which would enable nothing — is refused here.
 *
 * The settings speak SearXNG, so they are refused beside `name:` — with
 * `web.search: exa` they would be silently ignored.
 */
export interface SearchSettings {
  /** Ask only these engines. A default: a call's `engines=` or
   *  `categories=` replaces it, and it beats `categories` beside it — the
   *  tool never sends SearXNG both, which would add the categories' engines
   *  to the list. */
  engines?: string[];
  /** Never ask these, whatever the call says. A lock, like
   *  web.browse.allowed_domains: a call may not widen it. */
  exclude_engines?: string[];
  /** The SearXNG categories to search (general, news, science, it, …),
   *  when no engine list is in force. A default a call replaces. */
  categories?: string[];
  /** 0 off, 1 moderate, 2 strict. */
  safesearch?: 0 | 1 | 2;
  /** The default recency when a call does not say. */
  time_range?: "day" | "week" | "month" | "year";
  /** Seconds SearXNG waits for its engines before answering with what it has. */
  timeout?: number;
  /** SearXNG plugins to switch on, and off, for this agent's searches. */
  plugins?: string[];
  exclude_plugins?: string[];
  /** Where the open-access DOI rewrite plugin points a paper's link. */
  doi_resolver?: string;
}

/** SearXNG's plugin ids (searx/plugins/*.py, 2026-09-29). The gallery test
 *  keeps this equal to the list the tool documents. */
export const WEB_SEARCH_PLUGINS = [
  "ahmia_filter", "calculator", "hash_plugin", "hostnames", "infinite_scroll", "oa_doi_rewrite",
  "self_info", "time_zone", "tor_check", "tracker_url_remover", "unit_converter",
] as const;
const SEARCH_SETTING_KEYS = [
  "engines", "exclude_engines", "categories", "safesearch", "time_range", "timeout", "plugins", "exclude_plugins", "doi_resolver",
] as const;
// SearXNG names engines the way people do — "google cse", "wikicommons.images",
// "yandex api" — so a space and a dot are allowed. A comma is not: the tool
// sends the list comma-joined, and one inside a name would split it.
const SEARCH_ENGINE_NAME = /^[a-z0-9][a-z0-9 ._-]{0,63}$/i;
const SEARCH_CATEGORY_NAME = /^[a-z][a-z0-9 _-]{0,31}$/i;
const SAFESEARCH_WORDS: Record<string, 0 | 1 | 2> = { off: 0, none: 0, moderate: 1, strict: 2 };

/** The settings in a `web.search:` block, and the provider part with them
 *  removed — the shape readBrowseSettings has, for the same reason. */
export function readSearchSettings(raw: unknown): { settings: SearchSettings; rest: unknown; error?: string } {
  const left = (o: Record<string, unknown>) => (Object.keys(o).length ? o : undefined);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { settings: {}, rest: raw };
  const settings: SearchSettings = {};
  const rest: Record<string, unknown> = {};
  const fail = (error: string) => ({ settings, rest: left(rest), error });
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!(SEARCH_SETTING_KEYS as readonly string[]).includes(k)) {
      rest[k] = v;
      continue;
    }
    if (v === undefined || v === null || v === "") continue;
    if (k === "engines" || k === "exclude_engines") {
      const list = browseList(v)?.map((e) => e.toLowerCase());
      if (!list) return fail(`web.search.${k} is a list of SearXNG engine names, like [bing, google cse, duckduckgo].`);
      const bad = list.find((e) => !SEARCH_ENGINE_NAME.test(e));
      if (bad !== undefined) return fail(`web.search.${k}: ${JSON.stringify(bad)} is not an engine name — letters, digits, space, dot, dash.`);
      if (list.length) settings[k] = [...new Set(list)];
      continue;
    }
    if (k === "categories") {
      const list = browseList(v)?.map((c) => c.toLowerCase());
      if (!list) return fail("web.search.categories is a list of SearXNG categories, like [general, news].");
      const bad = list.find((c) => !SEARCH_CATEGORY_NAME.test(c));
      if (bad !== undefined) return fail(`web.search.categories: ${JSON.stringify(bad)} is not a category name.`);
      if (list.length) settings.categories = [...new Set(list)];
      continue;
    }
    if (k === "plugins" || k === "exclude_plugins") {
      const list = browseList(v)?.map((p) => p.toLowerCase());
      if (!list) return fail(`web.search.${k} is a list of SearXNG plugin ids, like [oa_doi_rewrite].`);
      // Matched without underscores: SearXNG has respelt ids between releases
      // (infiniteScroll → infinite_scroll), and the tool sends whichever
      // spelling the running instance uses.
      const bare = (p: string) => p.replace(/_/g, "");
      const bad = list.find((p) => !WEB_SEARCH_PLUGINS.some((id) => bare(id) === bare(p)));
      if (bad !== undefined) {
        return fail(`web.search.${k}: ${bad} is not a SearXNG plugin — a misspelt one would switch nothing. The plugins are ${WEB_SEARCH_PLUGINS.join(", ")}.`);
      }
      if (list.length) settings[k] = [...new Set(list)];
      continue;
    }
    if (k === "safesearch") {
      const n = typeof v === "number" ? v : typeof v === "string" ? (SAFESEARCH_WORDS[v.trim().toLowerCase()] ?? (/^[012]$/.test(v.trim()) ? Number(v) : NaN)) : NaN;
      if (n !== 0 && n !== 1 && n !== 2) return fail(`web.search.safesearch is off, moderate or strict (or 0, 1, 2), not ${JSON.stringify(v)}.`);
      settings.safesearch = n;
      continue;
    }
    if (k === "time_range") {
      const r = String(v).trim().toLowerCase();
      if (r !== "day" && r !== "week" && r !== "month" && r !== "year") return fail(`web.search.time_range is day, week, month or year, not ${JSON.stringify(v)}.`);
      settings.time_range = r;
      continue;
    }
    if (k === "timeout") {
      const n = typeof v === "number" ? v : Number(String(v).replace(/s$/, ""));
      if (!Number.isFinite(n) || n < 0.5 || n > 30) return fail(`web.search.timeout is seconds, 0.5 to 30, not ${JSON.stringify(v)}.`);
      settings.timeout = n;
      continue;
    }
    // doi_resolver: a host SearXNG knows (oadoi.org, doi.org, …), checked
    // against the instance by the tool; here only that it is a host.
    if (typeof v !== "string" || !BROWSE_DOMAIN.test(v.trim().toLowerCase())) {
      return fail(`web.search.doi_resolver is a resolver's host, like oadoi.org or doi.org, not ${JSON.stringify(v)}.`);
    }
    settings.doi_resolver = v.trim().toLowerCase();
  }
  const both = (settings.engines ?? []).find((e) => settings.exclude_engines?.includes(e));
  if (both) return fail(`web.search: ${both} is in both engines and exclude_engines — say which.`);
  const bothP = (settings.plugins ?? []).find((p) => settings.exclude_plugins?.includes(p));
  if (bothP) return fail(`web.search: ${bothP} is in both plugins and exclude_plugins — say which.`);
  if (Object.keys(settings).length && (rest.name !== undefined || rest.key !== undefined)) {
    return fail(
      `web.search: ${Object.keys(settings).join(", ")} ${Object.keys(settings).length === 1 ? "is a setting" : "are settings"} for the account's own engine (SearXNG); ` +
        `beside name: ${String(rest.name)} ${Object.keys(settings).length === 1 ? "it" : "they"} would do nothing. Drop name: to use them, or drop them to use ${String(rest.name)}.`,
    );
  }
  return { settings, rest: left(rest) };
}

/** The `web.search:` block's settings as the env the tool reads. Only what
 *  was said travels — an unset key is SearXNG's own default. */
export function searchSettingsEnv(s: SearchSettings): Record<string, string> {
  return {
    ...(s.engines ? { FOLDRUN_WEB_SEARCH_ENGINES: s.engines.join(",") } : {}),
    ...(s.exclude_engines ? { FOLDRUN_WEB_SEARCH_EXCLUDE_ENGINES: s.exclude_engines.join(",") } : {}),
    ...(s.categories ? { FOLDRUN_WEB_SEARCH_CATEGORIES: s.categories.join(",") } : {}),
    ...(s.safesearch !== undefined ? { FOLDRUN_WEB_SEARCH_SAFESEARCH: String(s.safesearch) } : {}),
    ...(s.time_range ? { FOLDRUN_WEB_SEARCH_TIME_RANGE: s.time_range } : {}),
    ...(s.timeout !== undefined ? { FOLDRUN_WEB_SEARCH_TIMEOUT: String(s.timeout) } : {}),
    ...(s.plugins ? { FOLDRUN_WEB_SEARCH_PLUGINS: s.plugins.join(",") } : {}),
    ...(s.exclude_plugins ? { FOLDRUN_WEB_SEARCH_EXCLUDE_PLUGINS: s.exclude_plugins.join(",") } : {}),
    ...(s.doi_resolver ? { FOLDRUN_WEB_SEARCH_DOI_RESOLVER: s.doi_resolver } : {}),
  };
}

function readChoice(raw: unknown, field: string): { name: string; secret?: string } | { error: string } {
  if (typeof raw === "string") return { name: raw };
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const o = raw as Record<string, unknown>;
    if (typeof o.name !== "string" || !o.name.trim()) {
      return { error: `${field}: the long form needs \`name:\` — the API or provider to ask.` };
    }
    if (o.key === undefined) return { name: o.name };
    if (typeof o.key !== "string") return { error: `${field}.key must be a \${NAME} reference to a secret in the vault.` };
    const m = /^\$\{([A-Z][A-Z0-9_]*)\}$/.exec(o.key.trim());
    if (!m) {
      return {
        error:
          `${field}.key must be a \${NAME} reference to a secret in the vault, not the key itself — ` +
          `store it with \`foldrun secrets set NAME\` and write \`key: \${NAME}\`.`,
      };
    }
    return { name: o.name, secret: m[1] };
  }
  return { error: `${field}: takes a name, or a block with name: and key:, or nothing at all for the runtime's own.` };
}

export function resolveSearch(name: unknown, kind: "search" | "fetch" | "browse" = "search"): SearchChoice {
  const field = kind === "fetch" ? "web.fetch" : kind === "browse" ? "web.browse" : "web.search";
  if (name === undefined || name === null || name === "" || name === "ours") {
    return { provider: null };
  }
  const read = readChoice(name, field);
  if ("error" in read) return { provider: null, error: read.error };
  const key = read.name.trim().toLowerCase();

  if (key in REFUSED_WEB) return { provider: null, error: `${field}: ${key} — ${REFUSED_WEB[key]}` };
  if (kind === "browse") {
    const b = findBrowserApi(key);
    if (!b) {
      return { provider: null, error: `web.browse: ${key} — no remote browser by that name. The ones this tool can connect to: ${BROWSER_APIS.map((a) => a.name).join(", ")}. Unset means the account's own browser.` };
    }
    return { provider: b.name, shape: "direct", index: b.what, secret: read.secret ?? b.secret, secretOptional: false, host: b.host };
  }
  const api = kind === "fetch" ? findFetchApi(key) : findSearchApi(key);
  if (api) {
    return {
      provider: api.name,
      shape: "direct",
      index: "index" in api ? (api as SearchApi).index : (api as FetchApi).what,
      secret: read.secret ?? api.secret,
      // A custom vault name is a deliberate choice; it is never optional.
      secretOptional: read.secret ? false : Boolean(api.secretOptional),
      host: api.host,
    };
  }
  if (kind === "fetch") {
    const other = findSearchApi(key);
    if (other) {
      return { provider: null, error: `web.fetch: ${key} — ${other.title} searches but has no fetch here. The fetch APIs: ${FETCH_APIS.map((a) => a.name).join(", ")}; or anthropic.` };
    }
    if (key === "anthropic") return { provider: "anthropic", shape: "anthropic", index: "Anthropic's web_fetch — a small model's reading of the page, on Anthropic's servers" };
    const preset = PROVIDERS.find((p) => p.name === key);
    return {
      provider: null,
      error: preset
        ? `web.fetch: ${key} — ${preset.title} has no fetch a tool can call. The fetch APIs: ${FETCH_APIS.map((a) => a.name).join(", ")}; or anthropic.`
        : `web.fetch: ${key} — no fetch API or provider by that name. The fetch APIs: ${FETCH_APIS.map((a) => a.name).join(", ")}; or anthropic.`,
    };
  }
  if (read.secret) {
    return { provider: null, error: `${field}.key: only a direct API takes your own key here. ${key} is a model provider — its key lives in the provider: block.` };
  }
  const preset = PROVIDERS.find((p) => p.name === key);
  if (!preset) {
    const providers = PROVIDERS.filter((p) => p.search).map((p) => p.name).join(", ");
    const apis = SEARCH_APIS.map((a) => a.name).join(", ");
    return { provider: null, error: `${field}: ${key} — no provider or search API by that name. Providers that search: ${providers}. Search APIs, with your own key: ${apis}.` };
  }
  if (!preset.search) {
    return {
      provider: null,
      error:
        `web.search: ${key} — ${preset.title} has no server-side search. ` +
        `Its endpoint is ${preset.format}-shaped, but speaking a wire is not the same as running a tool on it. ` +
        `Leave web.search: unset to use the account's own search engine.`,
    };
  }
  return { provider: key, shape: preset.search, index: SEARCH_INDEX[key] };
}

/** Every `web:` value in a frontmatter that cannot work, each as the
 *  sentence resolveSearch gives. Computed once in core so `check`, the
 *  deploy gate and the run all refuse the same thing in the same words —
 *  the timezone rule's shape. Empty when all are unset or answerable. */
export function webProblems(front: Record<string, unknown>): string[] {
  const web = webConfig(front);
  const out: string[] = [...web.problems];
  for (const kind of ["search", "fetch", "browse"] as const) {
    let value = web.raw[kind];
    let browse: BrowseSettings | null = null;
    if (kind === "browse" || kind === "search") {
      const read = kind === "browse" ? readBrowseSettings(value) : readSearchSettings(value);
      if (read.error) {
        out.push(read.error);
        continue;
      }
      if (kind === "browse") browse = read.settings as BrowseSettings;
      value = read.rest;
    }
    const choice = resolveSearch(value, kind);
    if (choice.error) out.push(choice.error);
    else if (browse) out.push(...browseSessionProblems(browse, choice.provider));
  }
  return out;
}

/**
 * The agent's `web:` block, read once for everyone — the runner, `check`
 * and the deploy gate:
 *
 *    tools: [web]
 *    web:
 *      actions: [search, fetch, crawl]   # what it may do; all when absent
 *      search: brave                     # who does each; absent is foldrun
 *      browse: { engine: firefox }       # search and browse also take their settings
 *
 * `raw` is each action's value as written. Browse alone cascades: the
 * workspace's (or account's) `web: {browse: …}` applies when the agent's
 * says nothing. A per-action key outside the block (`web_search:`) is not
 * read; it is a problem naming the block.
 */
export function webConfig(
  front: Record<string, unknown>,
  workspaceFront?: Record<string, unknown>,
): {
  actions: WebAction[] | null;
  raw: Record<WebAction, unknown>;
  problems: string[];
} {
  const problems: string[] = [];
  const block = front.web;
  let web: Record<string, unknown> = {};
  if (block !== undefined && block !== null) {
    if (typeof block === "object" && !Array.isArray(block)) web = block as Record<string, unknown>;
    else problems.push("web: is a block — actions: and a provider per action, e.g. `web: {fetch: jina}`.");
  }
  for (const k of Object.keys(web)) {
    if (k !== "actions" && !(WEB_ACTIONS as readonly string[]).includes(k)) {
      problems.push(`web.${k}: is not an action. The actions: ${WEB_ACTIONS.join(", ")}; and actions: for which of them the agent may use.`);
    }
  }
  for (const a of WEB_ACTIONS) {
    if (front[`web_${a}`] !== undefined) problems.push(`web_${a}: is not a key — write \`web: {${a}: …}\`.`);
  }
  let actions: WebAction[] | null = null;
  if (web.actions !== undefined) {
    const list = Array.isArray(web.actions) ? web.actions.map((a) => String(a).trim().toLowerCase()) : null;
    const bad = list?.filter((a) => !(WEB_ACTIONS as readonly string[]).includes(a)) ?? [];
    if (!list) problems.push(`web.actions: is a list, e.g. [search, fetch].`);
    else if (bad.length) problems.push(`web.actions: ${bad.join(", ")} ${bad.length === 1 ? "is not an action" : "are not actions"}. The actions: ${WEB_ACTIONS.join(", ")}.`);
    else actions = [...new Set(list)] as WebAction[];
  }
  const wsWeb = workspaceFront?.web && typeof workspaceFront.web === "object" && !Array.isArray(workspaceFront.web)
    ? (workspaceFront.web as Record<string, unknown>) : {};
  const raw = Object.fromEntries(WEB_ACTIONS.map((a) => {
    let v = web[a];
    if (v === undefined && a === "browse") v = wsWeb.browse;
    return [a, v];
  })) as Record<WebAction, unknown>;
  return { actions, raw, problems };
}
