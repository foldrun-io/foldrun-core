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
// Two formats, deliberately. `anthropic` is what the runtime speaks, so
// those endpoints are reached directly. `openai` endpoints are reached
// through the runtime's own translator (translator.ts), which runs on
// localhost inside the run sandbox and rewrites Anthropic Messages to Chat
// Completions and back. Every provider without an Anthropic-shaped endpoint
// speaks Chat Completions — OpenAI, Gemini, xAI, Groq, Mistral, Hugging
// Face, Cloudflare's own models — so one translation reaches all of them.
//
// URLs and header shapes were checked against each provider's own
// documentation on 2026-09-02 (see docs/providers.md). `verified` says
// whether a tool loop was actually driven through the endpoint from here,
// which is the only claim that matters for an agent runtime; a name without
// it is documented, not proven.

export type WireFormat = "anthropic" | "openai";

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
}

export const PROVIDERS: readonly ProviderPreset[] = [
  // ------------------------------------------------ Anthropic-shaped, direct
  { name: "anthropic", title: "Anthropic", format: "anthropic", baseUrl: "https://api.anthropic.com", auth: "x-api-key", verified: true },
  { name: "openrouter", title: "OpenRouter", format: "anthropic", baseUrl: "https://openrouter.ai/api", auth: "bearer", verified: true,
    note: "Hundreds of models behind one key. Its own docs disagree on how well non-Anthropic models hold a tool loop on this endpoint — probe the model you mean to use." },
  { name: "deepseek", title: "DeepSeek", format: "anthropic", baseUrl: "https://api.deepseek.com/anthropic", auth: "x-api-key",
    note: "Ignores top_k, cache_control and thinking budgets; Claude model names are remapped to DeepSeek's." },
  { name: "kimi", title: "Moonshot Kimi", format: "anthropic", baseUrl: "https://api.moonshot.ai/anthropic", auth: "bearer" },
  { name: "moonshot", title: "Moonshot Kimi", format: "anthropic", baseUrl: "https://api.moonshot.ai/anthropic", auth: "bearer" },
  { name: "zai", title: "z.ai (GLM)", format: "anthropic", baseUrl: "https://api.z.ai/api/anthropic", auth: "bearer" },
  { name: "minimax", title: "MiniMax", format: "anthropic", baseUrl: "https://api.minimax.io/anthropic", auth: "bearer" },
  { name: "qwen", title: "Alibaba Qwen (Model Studio)", format: "anthropic", auth: "x-api-key",
    note: "base_url is per account: https://<workspace>.<region>.maas.aliyuncs.com/apps/anthropic" },
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
    note: "v0.14+. Ignores tool_choice." },
  { name: "lmstudio", title: "LM Studio (local)", format: "anthropic", baseUrl: "http://localhost:1234", auth: "x-api-key" },
  { name: "vllm", title: "vLLM (yours)", format: "anthropic", auth: "bearer", note: "base_url is your server; Python frontend only." },

  // ------------------------------------------- Chat-Completions, translated
  { name: "openai", title: "OpenAI", format: "openai", baseUrl: "https://api.openai.com/v1", auth: "bearer",
    maxTokensParam: "max_completion_tokens", reasoningEffort: true },
  { name: "gemini", title: "Google Gemini", format: "openai", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", auth: "bearer",
    note: "Google's OpenAI-compatible route. Unknown parameters are ignored silently; reasoning cannot be switched off on the newest models." },
  { name: "xai", title: "xAI Grok", format: "openai", baseUrl: "https://api.x.ai/v1", auth: "bearer", reasoningEffort: true },
  { name: "groq", title: "Groq", format: "openai", baseUrl: "https://api.groq.com/openai/v1", auth: "bearer" },
  { name: "mistral", title: "Mistral", format: "openai", baseUrl: "https://api.mistral.ai/v1", auth: "bearer" },
  { name: "together", title: "Together AI", format: "openai", baseUrl: "https://api.together.ai/v1", auth: "bearer" },
  { name: "cerebras", title: "Cerebras", format: "openai", baseUrl: "https://api.cerebras.ai/v1", auth: "bearer" },
  { name: "perplexity", title: "Perplexity", format: "openai", baseUrl: "https://api.perplexity.ai", auth: "bearer",
    note: "The Sonar chat route sunsets 2026-09-27; the successor Agent API is not Chat-Completions-shaped." },
  { name: "huggingface", title: "Hugging Face", format: "openai", baseUrl: "https://router.huggingface.co/v1", auth: "bearer",
    note: "The Inference Providers router; model ids are Hub ids, e.g. meta-llama/Llama-3.3-70B-Instruct." },
  { name: "cloudflare", title: "Cloudflare Workers AI", format: "openai", auth: "bearer",
    note: "base_url is https://api.cloudflare.com/client/v4/accounts/<account>/ai/v1" },
  { name: "nebius", title: "Nebius Token Factory", format: "openai", baseUrl: "https://api.tokenfactory.nebius.com/v1", auth: "bearer" },
  { name: "novita", title: "Novita", format: "openai", baseUrl: "https://api.novita.ai/openai", auth: "bearer" },
  { name: "hyperbolic", title: "Hyperbolic", format: "openai", baseUrl: "https://api.hyperbolic.xyz/v1", auth: "bearer" },
];

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
