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
export type SearchShape = "anthropic" | "plugin" | "openai" | "builtin_fn";

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
  /** Set when the name cannot work; `check` prints it and refuses. */
  error?: string;
}

export function resolveSearch(name: unknown): SearchChoice {
  if (name === undefined || name === null || name === "" || name === "ours") {
    return { provider: null };
  }
  if (typeof name !== "string") {
    return { provider: null, error: "web_search: takes a provider name, or nothing at all for the account's own search engine." };
  }
  const key = name.trim().toLowerCase();
  const preset = PROVIDERS.find((p) => p.name === key);
  if (!preset) {
    const near = PROVIDERS.filter((p) => p.search).map((p) => p.name).join(", ");
    return { provider: null, error: `web_search: ${key} — no provider by that name. The ones that can search: ${near}.` };
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
