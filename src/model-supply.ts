// "foldrun's models": the platform's own keys for a few providers, which a
// hosted account may choose instead of bringing its own (3 Nov 2026).
//
// One table, read by both halves:
//   - the runner (core) builds the step's provider block from it and grants
//     the key to the egress proxy as a supply grant (egress.ts SupplyGrant),
//     so the key never reaches the pod;
//   - the proxy's model gateway (foldrun-platform model-gateway.ts) fills
//     that grant only in the provider's auth header, on the provider's model
//     routes, and meters every call — the bill comes from the gateway.
//
// A provider here is offered only where the platform holds its key (set by
// an operator in the console, sealed in the platform's store — never in the
// environment), the operator lists it, and the price list names the model.

import { providerPreset, type WireFormat } from "./providers.ts";

export type SupplyProviderName = "anthropic" | "openai" | "gemini" | "deepseek" | "moonshot";

export interface SupplyProvider {
  name: SupplyProviderName;
  /** The preset the step's provider block is built from (providers.ts). */
  preset: string;
  format: WireFormat;
  /** The one host the key is granted to. */
  host: string;
  /** The header the key may be filled in, and its exact shape: the whole
   *  value of x-api-key, or "Bearer <key>" in authorization. Anywhere else —
   *  the URL, the body, another header — is refused. */
  auth: "x-api-key" | "bearer";
  /** Paths (the URL's pathname, exact) a call is metered on: POST only. */
  metered: string[];
  /** Paths that cost nothing and may pass unmetered (GET model lists, a
   *  free token count). Anything not listed in either is refused. */
  free: { method: "GET" | "POST"; path: string }[];
  /** How a request is reshaped before it leaves (the gateway applies it,
   *  shapeRequest). The agent runtime sends Claude's whole surface —
   *  `thinking: {type: adaptive, display}`, `output_config.effort` in five
   *  words, `context_management` — and a compatible endpoint documents
   *  less: what it does with the rest is not stated, so it is not sent. */
  send?: SendShape;
}

export interface SendShape {
  /** Only these top-level fields are sent; any other is dropped. */
  fields?: string[];
  /** These top-level fields are dropped. */
  drop?: string[];
  /** The keys of `thinking` that are sent; null drops `thinking` whole. */
  thinking?: string[] | null;
  /** `output_config.effort`, as this provider spells it. */
  effort?: Record<string, string>;
}

export const SUPPLY_PROVIDERS: Record<SupplyProviderName, SupplyProvider> = {
  anthropic: {
    name: "anthropic",
    preset: "anthropic",
    format: "anthropic",
    host: "api.anthropic.com",
    auth: "x-api-key",
    metered: ["/v1/messages"],
    free: [
      { method: "POST", path: "/v1/messages/count_tokens" },
      { method: "GET", path: "/v1/models" },
    ],
  },
  openai: {
    name: "openai",
    preset: "openai",
    // The Responses API, not Chat Completions: GPT-6 Astra and GPT-6.1 Sol
    // call tools on Responses alone, GPT-6 Luna on Chat Completions only
    // with reasoning off (OpenAI's model pages, 3 Nov 2026).
    format: "responses",
    host: "api.openai.com",
    auth: "bearer",
    metered: ["/v1/responses"],
    free: [{ method: "GET", path: "/v1/models" }],
  },
  gemini: {
    name: "gemini",
    preset: "gemini",
    format: "openai",
    host: "generativelanguage.googleapis.com",
    auth: "bearer",
    metered: ["/v1beta/openai/chat/completions"],
    free: [{ method: "GET", path: "/v1beta/openai/models" }],
  },
  // DeepSeek and Moonshot (owner, 3 Nov 2026: directly, not through
  // OpenRouter, whose price depends on which host it routes a call to).
  // Both speak Anthropic's Messages API at /anthropic/v1/messages and report
  // usage the same way; neither prices a provider-run tool we allow
  // (DeepSeek's web search is a typed tool, refused like Anthropic's).
  deepseek: {
    name: "deepseek",
    preset: "deepseek",
    format: "anthropic",
    host: "api.deepseek.com",
    auth: "x-api-key",
    metered: ["/anthropic/v1/messages"],
    free: [],
    // api-docs.deepseek.com/api/create-message (3 Nov 2026): thinking.type
    // enabled|disabled|adaptive (adaptive = enabled), budget_tokens ignored;
    // effort takes every word ours does (medium and xhigh = high). Context
    // editing and thinking.display are not in its schema.
    send: { drop: ["context_management"], thinking: ["type", "budget_tokens"] },
  },
  moonshot: {
    name: "moonshot",
    preset: "moonshot",
    format: "anthropic",
    host: "api.moonshot.ai",
    auth: "bearer",
    metered: ["/anthropic/v1/messages"],
    free: [],
    // platform.kimi.ai/docs/api/messages (3 Nov 2026): the request schema is
    // these fields alone; `thinking` is K2-only (K3.1 Pro always thinks);
    // effort is low | high | max; temperature and top_p are fixed (any
    // other value is an error).
    send: {
      fields: ["model", "messages", "max_tokens", "system", "stream", "stop_sequences", "tools", "tool_choice", "metadata", "cache_control", "output_config"],
      thinking: null,
      effort: { minimal: "low", low: "low", medium: "high", high: "high", xhigh: "high", max: "max" },
    },
  },
};

export const SUPPLY_PROVIDER_NAMES = Object.keys(SUPPLY_PROVIDERS) as SupplyProviderName[];

/** How each reads to a person: on a step's credential line, in Settings. */
export const SUPPLY_TITLES: Record<SupplyProviderName, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  gemini: "Google Gemini",
  deepseek: "DeepSeek",
  moonshot: "Moonshot Kimi",
};

export function isSupplyProvider(name: unknown): name is SupplyProviderName {
  return typeof name === "string" && Object.hasOwn(SUPPLY_PROVIDERS, name);
}

/** The placeholder name a supply grant is filed under in a step's lease. */
export const SUPPLY_KEY_NAME = "FOLDRUN_SUPPLY_KEY";

/**
 * What the platform says about one account's model supply, before any
 * provider: block of its own is considered (a written block always wins):
 *   none     — it did not choose foldrun's models: its own key, as before
 *   foldrun  — it chose them and they are on: run on the platform's key
 *   refused  — it chose them and they cannot be had now (switched off, the
 *              provider withdrawn, the account refused). The step FAILS
 *              with the reason: never quietly onto the account's stored
 *              key, and never onto the operator's.
 */
export type SupplyAnswer =
  | { kind: "none" }
  | { kind: "foldrun"; provider: SupplyProviderName; tiers: Partial<Record<"fast" | "default" | "max", string>> }
  | { kind: "refused"; reason: string };

/** The token a supply provider block carries: a marker, not a secret. The
 *  proxy grant built from it is a supply grant (egress.ts grantModelKey),
 *  which the proxy fills with the platform's key. Sent anywhere unproxied
 *  it is only a word a provider refuses. */
const MARKER = "foldrun-supply:";
export const supplyToken = (provider: SupplyProviderName) => `${MARKER}${provider}`;
export function supplyProviderOfToken(value: string | null | undefined): SupplyProviderName | null {
  if (typeof value !== "string" || !value.startsWith(MARKER)) return null;
  const p = value.slice(MARKER.length);
  return isSupplyProvider(p) ? p : null;
}

/** The provider block a step on foldrun's models runs with: the preset's
 *  endpoint and format, the operator's tier map, and the key as a
 *  placeholder only. */
export function supplyProviderBlock(provider: SupplyProviderName, tiers: Partial<Record<"fast" | "default" | "max", string>>): Record<string, unknown> {
  const p = SUPPLY_PROVIDERS[provider];
  const preset = providerPreset(p.preset);
  if (!preset?.baseUrl) throw new Error(`model supply: no preset endpoint for ${provider}`);
  return {
    name: p.preset,
    base_url: preset.baseUrl,
    format: p.format,
    token: supplyToken(provider),
    ...(Object.keys(tiers).length ? { models: tiers } : {}),
  };
}

/**
 * Reshape a request body for a provider (its `send`), in place. True when
 * anything changed. What a provider's schema does not list is not sent,
 * rather than trusted to be ignored; an effort word it does not spell is
 * sent as the nearest one it does.
 */
export function shapeRequest(p: SupplyProvider, json: Record<string, unknown>): boolean {
  const shape = p.send;
  if (!shape) return false;
  let changed = false;
  if (shape.fields) {
    for (const k of Object.keys(json)) if (!shape.fields.includes(k)) (delete json[k], (changed = true));
  }
  for (const k of shape.drop ?? []) if (k in json) (delete json[k], (changed = true));
  if (shape.thinking !== undefined && "thinking" in json) {
    if (shape.thinking === null) {
      delete json.thinking;
      changed = true;
    } else if (json.thinking && typeof json.thinking === "object") {
      const t = json.thinking as Record<string, unknown>;
      for (const k of Object.keys(t)) if (!shape.thinking.includes(k)) (delete t[k], (changed = true));
    }
  }
  const oc = json.output_config;
  if (shape.effort && oc && typeof oc === "object" && typeof (oc as Record<string, unknown>).effort === "string") {
    const word = (oc as Record<string, unknown>).effort as string;
    const to = shape.effort[word];
    if (to === undefined) {
      delete (oc as Record<string, unknown>).effort;
      changed = true;
    } else if (to !== word) {
      (oc as Record<string, unknown>).effort = to;
      changed = true;
    }
  }
  return changed;
}
