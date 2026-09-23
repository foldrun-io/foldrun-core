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
   *  Absent means it does not — `web_search: <that name>` is then an error a
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
 *  live apart from PROVIDERS. `web_search:` accepts either kind of name, and
 *  the difference decides where the search runs: a provider's server-side
 *  tool runs on the provider's machines and is off the run record, while a
 *  direct API is called from the run's own sandbox through the egress proxy
 *  — the key never enters the pod, the call is on the record with its
 *  arguments, and it works whichever model is driving. Same switch, better
 *  audit trail. Shapes were read from each vendor's own API reference on
 *  2026-09-16; the wrapper in the gallery's web_search tool carries the
 *  matching request and response mapping. */
export interface SearchApi {
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
  { name: "brave", title: "Brave Search", host: "api.search.brave.com", endpoint: "https://api.search.brave.com/res/v1/web/search",
    method: "GET", auth: { header: "X-Subscription-Token" }, secret: "BRAVE_SEARCH_API_KEY",
    index: "Brave's own — ~40B pages, ~100M refreshed a day; the index Claude searches" },
  { name: "exa", title: "Exa", host: "api.exa.ai", endpoint: "https://api.exa.ai/search",
    method: "POST", auth: { header: "x-api-key" }, secret: "EXA_API_KEY",
    index: "Exa's own semantic index — by meaning, not keywords" },
  { name: "tavily", title: "Tavily", host: "api.tavily.com", endpoint: "https://api.tavily.com/search",
    method: "POST", auth: { header: "Authorization", prefix: "Bearer " }, secret: "TAVILY_API_KEY",
    index: "Tavily's own crawler plus bought-in feeds" },
  { name: "parallel", title: "Parallel", host: "api.parallel.ai", endpoint: "https://api.parallel.ai/v1/search",
    method: "POST", auth: { header: "x-api-key" }, secret: "PARALLEL_API_KEY",
    index: "Parallel's own closed index",
    note: "Wants an objective beside the queries; the wrapper writes one from the query." },
  { name: "you", aliases: ["youcom", "you.com"], title: "You.com", host: "ydc-index.io", endpoint: "https://ydc-index.io/v1/search",
    method: "POST", auth: { header: "X-API-Key" }, secret: "YOU_API_KEY",
    index: "You.com's own index and cache (self-reported)" },
  { name: "jina", title: "Jina Search", host: "s.jina.ai", endpoint: "https://s.jina.ai/",
    method: "GET", auth: { header: "Authorization", prefix: "Bearer " }, secret: "JINA_API_KEY",
    index: "Jina's — top results, each with its page content already read",
    note: "s.jina.ai refuses without a key (checked live 2026-09-16); r.jina.ai, the reader, does not." },
  { name: "firecrawl", title: "Firecrawl", host: "api.firecrawl.dev", endpoint: "https://api.firecrawl.dev/v2/search",
    method: "POST", auth: { header: "Authorization", prefix: "Bearer " }, secret: "FIRECRAWL_API_KEY",
    index: "Firecrawl's — open-source core, self-hostable" },
  { name: "perplexity", title: "Perplexity Search", host: "api.perplexity.ai", endpoint: "https://api.perplexity.ai/search",
    method: "POST", auth: { header: "Authorization", prefix: "Bearer " }, secret: "PERPLEXITY_API_KEY",
    index: "Perplexity's own crawl — the Search API returns results, not an answer" },
  { name: "linkup", title: "Linkup", host: "api.linkup.so", endpoint: "https://api.linkup.so/v1/search",
    method: "POST", auth: { header: "Authorization", prefix: "Bearer " }, secret: "LINKUP_API_KEY",
    index: "Linkup's — agent-shaped, each result with its content" },
  // ---- the SERP scrapers: Google's own results page, read for you. Not
  // an index of their own, and not Google partners — there is no such
  // programme. The one kind to use when the question is about Google
  // itself: where a page ranks, what the SERP shows.
  { name: "serper", title: "Serper", host: "google.serper.dev", endpoint: "https://google.serper.dev/search",
    method: "POST", auth: { header: "X-API-KEY" }, secret: "SERPER_API_KEY",
    index: "Google's results page, scraped — ~$1 / 1,000; fast, developers' favourite" },
  { name: "serpapi", title: "SerpApi", host: "serpapi.com", endpoint: "https://serpapi.com/search",
    method: "GET", auth: { header: "", prefix: "" }, secret: "SERPAPI_API_KEY",
    index: "Google's results page, scraped — the dearest, 80+ engines",
    note: "The key travels as the api_key query parameter; the egress proxy fills the URL as it fills a header." },
  { name: "dataforseo", title: "DataForSEO", host: "api.dataforseo.com", endpoint: "https://api.dataforseo.com/v3/serp/google/organic/live/advanced",
    method: "POST", auth: { header: "Authorization", prefix: "Basic " }, secret: "DATAFORSEO_AUTH_BASIC",
    secretFormat: "base64 of `login:password` — DataForSEO authenticates with HTTP basic auth, and the proxy fills one placeholder verbatim: `printf 'LOGIN:PASSWORD' | base64`",
    index: "Google's results page, scraped — $0.60 / 1,000 standard queue; what rank-desk uses" },
];

/** Names people will try that cannot work, and why — said at `check`
 *  rather than discovered at 3am. */
export const REFUSED_WEB: Record<string, string> = {
  bing: "Microsoft retired the Bing Search API on 11 Aug 2025. What remains is Grounding with Bing Search, usable only inside an Azure AI agent — not a search a tool can call. Bing's index still answers through ChatGPT (web_search: openai).",
  azure: "the Bing Search API is retired; Grounding with Bing Search runs only inside Azure AI agents. See bing.",
  google: "Google does not sell its index. The Custom Search JSON API is closed to new customers and retires 1 Jan 2027; Grounding with Google Search runs only inside Gemini. For Google's results page, use a SERP scraper: serper, serpapi or dataforseo.",
  apify: "Apify is an actor marketplace, not a search, fetch or browser endpoint. Reach a specific actor as an http tool file, the way blog-desk's apify-fallback does.",
};

/** Fetch APIs the runtime calls itself: a URL in, the page out, with the
 *  customer's own key. Same seam as the search APIs — `web_fetch: jina` —
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
  { name: "jina", title: "Jina Reader", host: "r.jina.ai", endpoint: "https://r.jina.ai/",
    method: "GET", auth: { header: "Authorization", prefix: "Bearer " }, secret: "JINA_API_KEY", secretOptional: true,
    tier: "reader", batch: 1, what: "clean markdown, text or html; works without a key at 20 requests a minute (checked live 2026-09-16)" },
  { name: "firecrawl", title: "Firecrawl", host: "api.firecrawl.dev", endpoint: "https://api.firecrawl.dev/v2/scrape",
    method: "POST", auth: { header: "Authorization", prefix: "Bearer " }, secret: "FIRECRAWL_API_KEY",
    tier: "reader", batch: 1, what: "main-content markdown or html, boilerplate stripped; one URL per call" },
  { name: "exa", title: "Exa Contents", host: "api.exa.ai", endpoint: "https://api.exa.ai/contents",
    method: "POST", auth: { header: "x-api-key" }, secret: "EXA_API_KEY",
    tier: "extract", batch: 100, what: "text for up to 100 URLs in one call; always fetched fresh (maxAgeHours: 0), not Exa's cache" },
  { name: "tavily", title: "Tavily Extract", host: "api.tavily.com", endpoint: "https://api.tavily.com/extract",
    method: "POST", auth: { header: "Authorization", prefix: "Bearer " }, secret: "TAVILY_API_KEY",
    tier: "extract", batch: 20, what: "markdown or text for up to 20 URLs in one call, failures listed beside successes" },
  { name: "parallel", title: "Parallel Extract", host: "api.parallel.ai", endpoint: "https://api.parallel.ai/v1/extract",
    method: "POST", auth: { header: "x-api-key" }, secret: "PARALLEL_API_KEY",
    tier: "extract", batch: 20, what: "full-page markdown for several URLs at once; handles JavaScript pages and PDFs" },
  { name: "zyte", title: "Zyte API", host: "api.zyte.com", endpoint: "https://api.zyte.com/v1/extract",
    method: "POST", auth: { header: "Authorization", prefix: "Basic " }, secret: "ZYTE_API_KEY_BASIC",
    secretFormat: "base64 of `<api key>:` — Zyte authenticates with HTTP basic auth, and the proxy fills a placeholder verbatim, so the vault holds the encoded form: `printf 'KEY:' | base64`",
    tier: "unblocker", batch: 1, what: "the page rendered in a real browser behind Zyte's proxy pool — for the sites that refuse everything else; pay per successful request" },
  { name: "scrapingbee", aliases: ["scraping-bee", "scraping_bee"], title: "ScrapingBee", host: "app.scrapingbee.com", endpoint: "https://app.scrapingbee.com/api/v1/",
    method: "GET", auth: { header: "Authorization", prefix: "Bearer " }, secret: "SCRAPINGBEE_API_KEY",
    tier: "unblocker", batch: 1, what: "the page rendered in a real browser (render_js) behind ScrapingBee's proxy pool; credits per call, more for JavaScript" },
];

/** Remote browsers: a CDP endpoint our web_browse connects to instead of
 *  the account's pod — the same tool, the same modes and actions, rendered
 *  on the vendor's machines. `web_browse: browserbase`. The one capability
 *  where the key cannot ride the egress proxy: CDP is a websocket, so the
 *  wrapper holds the real value the way it already holds a cookie secret,
 *  and creates the session itself where the vendor wants one. */
export interface BrowserApi {
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
  { name: "browserbase", title: "Browserbase", how: "session", host: "api.browserbase.com", secret: "BROWSERBASE_API_KEY",
    what: "hosted Chromium with stealth; POST /v1/sessions (X-BB-API-Key) returns connectUrl" },
  { name: "steel", title: "Steel", how: "session", host: "api.steel.dev", secret: "STEEL_API_KEY",
    what: "hosted Chromium, open-source core; POST /v1/sessions (steel-api-key), then wss://connect.steel.dev?apiKey&sessionId" },
  { name: "hyperbrowser", title: "Hyperbrowser", how: "session", host: "api.hyperbrowser.ai", secret: "HYPERBROWSER_API_KEY",
    what: "hosted Chromium with built-in unblocking; a session returns its wsEndpoint" },
  { name: "browserless", title: "Browserless", how: "direct", host: "production-sfo.browserless.io", secret: "BROWSERLESS_TOKEN",
    what: "hosted Chrome; wss://production-sfo.browserless.io?token=… (other regions by name)",
    note: "SSPL-licensed: the free path is out for a paid service; the cloud is a plain vendor." },
  { name: "brightdata", aliases: ["bright-data", "bright_data"], title: "Bright Data Scraping Browser", how: "direct", host: "brd.superproxy.io", secret: "BRIGHTDATA_BROWSER_AUTH",
    secretFormat: "the zone credentials as `brd-customer-<id>-zone-<zone>:<password>` — the whole user:pass, which goes into the websocket URL",
    what: "Chromium behind a residential proxy pool, port 9222 — the one worth paying for when a site refuses everything else" },
  { name: "zenrows", aliases: ["zen-rows", "zen_rows"], title: "ZenRows Scraping Browser", how: "direct", host: "browser.zenrows.com", secret: "ZENROWS_API_KEY",
    what: "hosted Chromium with residential IPs and fingerprinting; wss://browser.zenrows.com?apikey=…" },
];

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


/** What `web_search: <name>` in an agent's frontmatter resolves to.
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

/** `web_search: exa`, or the long form with the customer's own vault name:
 *
 *    web_search:
 *      name: exa
 *      key: ${MY_EXA_KEY}
 *
 *  The same two spellings `provider:` takes. `key` is a reference, never a
 *  value — a credential written into a markdown file is refused here, the
 *  way it is refused everywhere else in foldrun. */
/**
 * `web_browse:` settings — how the browser presents itself, not what one call
 * does.
 *
 *    web_browse:
 *      engine: firefox
 *      user_agent: "Mozilla/5.0 …"
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
  engine?: "chromium" | "firefox" | "webkit";
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
}

// What a person writes, and what Playwright calls it. "chromium" and "webkit"
// are engine names; "chrome" and "safari" are what everyone else calls those
// browsers, and a file should read the way the room talks. Both spellings are
// accepted forever: agents written before this keep working, and the engine
// names remain the truth underneath (chrome here is the open-source Chromium
// build, not the branded Chrome; safari is WebKit, Safari's engine).
const BROWSE_ENGINE_ALIASES: Record<string, "chromium" | "firefox" | "webkit"> = {
  chrome: "chromium",
  chromium: "chromium",
  firefox: "firefox",
  safari: "webkit",
  webkit: "webkit",
};
const BROWSE_ENGINES = ["chrome", "firefox", "safari"] as const;
const BROWSE_SETTING_KEYS = ["engine", "user_agent", "device", "locale", "timezone", "cookies", "cookie_domain", "storage", "storage_origin", "identities"] as const;
// What one identity may carry: the block's own settings, and the call
// arguments that describe who the browser is rather than what one call does.
const IDENTITY_KEYS = ["engine", "user_agent", "device", "locale", "timezone", "cookies", "cookie_domain", "storage", "storage_origin", "proxy", "headers", "geolocation", "permissions", "color_scheme", "block"] as const;
const SECRET_NAME = /^[A-Z][A-Z0-9_]*$/;

/** One named identity, checked the way the block is: text values, an
 *  engine that exists, secrets by NAME, a cookie with its domain. */
function readIdentity(name: string, raw: unknown): { identity?: Record<string, string>; error?: string } {
  const where = `web_browse.identities.${name}`;
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(name)) return { error: `web_browse.identities: "${name}" is not a plain name (letters, digits, dot, dash, underscore).` };
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

/** The settings in a `web_browse:` block, and the vendor part with them
 *  removed — so one key carries both without either learning about the
 *  other. A string, or a block with no settings, gives no settings at all. */
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
        return { settings, rest: left(rest), error: "web_browse.identities must be a map of name to settings, like { au-mobile: { device: \"Pixel 7\", locale: en-AU } }." };
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
    if (typeof v !== "string") {
      return { settings, rest: left(rest), error: `web_browse.${k} must be text, not ${Array.isArray(v) ? "a list" : typeof v}.` };
    }
    if (k === "engine") {
      const canonical = BROWSE_ENGINE_ALIASES[v.toLowerCase()];
      if (!canonical) {
        return { settings, rest: left(rest), error: `web_browse.engine: ${v} — the browsers are ${BROWSE_ENGINES.join(", ")}.` };
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
          `web_browse.storage must be the NAME of a vault secret (CAPITALS), not the storage itself — ` +
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
          `web_browse.storage_origin must be an origin, scheme and host with no path — ` +
          `write \`storage_origin: https://www.example.com\`, not \`.example.com\`.`,
      };
    }
    if (k === "cookies" && !/^[A-Z][A-Z0-9_]*$/.test(v)) {
      return {
        settings,
        rest: left(rest),
        error:
          `web_browse.cookies must be the NAME of a vault secret (CAPITALS), not the cookies themselves — ` +
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
        `web_browse.cookies needs web_browse.cookie_domain beside it — a cookie default with no domain ` +
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
        `web_browse.storage needs web_browse.storage_origin beside it — Web Storage and IndexedDB are ` +
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
  const field = kind === "fetch" ? "web_fetch" : kind === "browse" ? "web_browse" : "web_search";
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
      return { provider: null, error: `web_browse: ${key} — no remote browser by that name. The ones this tool can connect to: ${BROWSER_APIS.map((a) => a.name).join(", ")}. Unset means the account's own browser.` };
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
      return { provider: null, error: `web_fetch: ${key} — ${other.title} searches but has no fetch here. The fetch APIs: ${FETCH_APIS.map((a) => a.name).join(", ")}; or anthropic.` };
    }
    if (key === "anthropic") return { provider: "anthropic", shape: "anthropic", index: "Anthropic's web_fetch — a small model's reading of the page, on Anthropic's servers" };
    const preset = PROVIDERS.find((p) => p.name === key);
    return {
      provider: null,
      error: preset
        ? `web_fetch: ${key} — ${preset.title} has no fetch a tool can call. The fetch APIs: ${FETCH_APIS.map((a) => a.name).join(", ")}; or anthropic.`
        : `web_fetch: ${key} — no fetch API or provider by that name. The fetch APIs: ${FETCH_APIS.map((a) => a.name).join(", ")}; or anthropic.`,
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
        `web_search: ${key} — ${preset.title} has no server-side search. ` +
        `Its endpoint is ${preset.format}-shaped, but speaking a wire is not the same as running a tool on it. ` +
        `Leave web_search: unset to use the account's own search engine.`,
    };
  }
  return { provider: key, shape: preset.search, index: SEARCH_INDEX[key] };
}

/** Every web_search: / web_fetch: / web_browse: value in a frontmatter that
 *  cannot work, each as the sentence resolveSearch gives. Computed once in
 *  core so `check`, the deploy gate and the run all refuse the same thing
 *  in the same words — the timezone rule's shape. Empty when all three are
 *  unset or answerable. */
export function webProblems(front: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const [key, kind] of [["web_search", "search"], ["web_fetch", "fetch"], ["web_browse", "browse"]] as const) {
    let value = front[key];
    if (kind === "browse") {
      const read = readBrowseSettings(value);
      if (read.error) {
        out.push(read.error);
        continue;
      }
      value = read.rest;
    }
    const choice = resolveSearch(value, kind);
    if (choice.error) out.push(choice.error);
  }
  return out;
}
