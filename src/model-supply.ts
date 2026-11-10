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
import { fitEffort, EFFORT_ORDER } from "./effort-fit.ts";

export type SupplyProviderName = "anthropic" | "openai" | "gemini" | "deepseek" | "moonshot" | "zai" | "qwen" | "minimax" | "mimo";

export interface SupplyProvider {
  name: SupplyProviderName;
  /** The preset the step's provider block is built from (providers.ts);
   *  "" when the runtime has none for this provider. */
  preset: string;
  /** The endpoint, where the preset has none (a per-account address) or
   *  there is no preset: the one place the platform's key is used. */
  baseUrl?: string;
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
  /** `thinking.type` as this provider spells it (Claude Code sends
   *  `adaptive` to newer models; an endpoint that documents enabled |
   *  disabled alone gets `enabled`). A type not listed is sent as it is. */
  thinkingType?: Record<string, string>;
  /** `output_config.effort`, as this provider spells it. */
  effort?: Record<string, string>;
  /** A `system` message inside `messages` (Anthropic's mid-conversation
   *  instructions, which the SDK sends) folded into the user turn before
   *  it: the endpoint documents user and assistant roles only. */
  mergeSystemMessages?: boolean;
  /** Tools deferred for Anthropic's tool search (`defer_loading`; the SDK
   *  always sends a placeholder) dropped: the endpoint cannot load them. */
  dropDeferredTools?: boolean;
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
    send: { drop: ["context_management"], thinking: ["type", "budget_tokens"], mergeSystemMessages: true, dropDeferredTools: true },
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
      mergeSystemMessages: true,
      dropDeferredTools: true,
    },
  },
  // Four more open-weight coding families (owner, 10 Nov 2026), each on its
  // own Anthropic-format endpoint, pay-as-you-go keys (a coding-plan key is
  // a different product). What each documents was read from its own docs on
  // 10 Nov 2026; `service_tier` is dropped everywhere — MiniMax bills its
  // priority tier at 1.5x, and the others do not say what it does.
  zai: {
    name: "zai",
    preset: "zai",
    format: "anthropic",
    host: "api.z.ai",
    auth: "bearer",
    metered: ["/api/anthropic/v1/messages"],
    free: [],
    // docs.z.ai documents no request schema for its Anthropic endpoint, only
    // that Claude Code runs on it; its OpenAI one takes thinking.type
    // enabled | disabled (GLM-5.3 refuses disabled). Context editing and
    // tool search are Claude's alone.
    send: { drop: ["context_management", "service_tier"], thinking: ["type", "budget_tokens"], thinkingType: { adaptive: "enabled" }, mergeSystemMessages: true, dropDeferredTools: true },
  },
  qwen: {
    name: "qwen",
    preset: "qwen",
    // The preset's address is per account and per plan; the platform's
    // pay-as-you-go key is used on the region-wide Singapore host.
    baseUrl: "https://dashscope-intl.aliyuncs.com/apps/anthropic",
    format: "anthropic",
    // Alibaba Model Studio, Singapore: the region-wide host (still fully
    // supported; the per-workspace host differs per account).
    host: "dashscope-intl.aliyuncs.com",
    auth: "x-api-key",
    metered: ["/apps/anthropic/v1/messages"],
    free: [],
    // alibabacloud.com/help/en/model-studio/anthropic-api-messages (5 Nov
    // 2026): thinking.type enabled | disabled, budget_tokens; effort xhigh |
    // medium | low (max and high run as xhigh); user and assistant roles
    // only. Web search is a typed tool, refused like Anthropic's.
    send: { drop: ["context_management", "service_tier"], thinking: ["type", "budget_tokens"], thinkingType: { adaptive: "enabled" }, mergeSystemMessages: true, dropDeferredTools: true },
  },
  minimax: {
    name: "minimax",
    preset: "minimax",
    format: "anthropic",
    host: "api.minimax.io",
    auth: "bearer",
    metered: ["/anthropic/v1/messages"],
    free: [{ method: "GET", path: "/anthropic/v1/models" }],
    // platform.minimax.io/docs/api-reference/text-chat-anthropic (10 Nov
    // 2026): thinking.type disabled | adaptive (no budget); effort takes
    // every word ours does; no system role in messages (roles alternate);
    // context_management, stop_sequences and top_k ignored.
    send: { drop: ["context_management", "service_tier"], thinking: ["type"], thinkingType: { enabled: "adaptive" }, mergeSystemMessages: true, dropDeferredTools: true },
  },
  mimo: {
    name: "mimo",
    preset: "",
    baseUrl: "https://api.xiaomimimo.com/anthropic",
    format: "anthropic",
    host: "api.xiaomimimo.com",
    auth: "bearer",
    metered: ["/anthropic/v1/messages"],
    free: [],
    // mimo.mi.com/static/docs/api/chat/anthropic-api-post (10 Nov 2026):
    // the request schema is these fields alone; thinking.type enabled |
    // disabled; a system role in messages is accepted; no effort.
    send: {
      fields: ["model", "messages", "max_tokens", "system", "stream", "stop_sequences", "temperature", "top_p", "tools", "tool_choice", "thinking"],
      thinking: ["type"],
      thinkingType: { adaptive: "enabled" },
      dropDeferredTools: true,
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
  zai: "Z.ai GLM",
  qwen: "Alibaba Qwen",
  minimax: "MiniMax",
  mimo: "Xiaomi MiMo",
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
  | {
      kind: "foldrun";
      provider: SupplyProviderName;
      tiers: Partial<Record<"fast" | "default" | "max", string>>;
      /** The price list's output ceiling per model id: the most one reply
       *  may be on the platform's key, told to the runtime up front. */
      ceilings?: Record<string, number>;
    }
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
  const preset = p.preset ? providerPreset(p.preset) : undefined;
  const baseUrl = p.baseUrl ?? preset?.baseUrl;
  if (!baseUrl) throw new Error(`model supply: no endpoint for ${provider}`);
  return {
    // A provider the runtime has no preset for is spelled out whole: its
    // address, format and auth, no name to look up.
    ...(preset ? { name: p.preset } : {}),
    base_url: baseUrl,
    format: p.format,
    auth: p.auth,
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
  if (shape.thinkingType && json.thinking && typeof json.thinking === "object") {
    const t = json.thinking as Record<string, unknown>;
    const to = typeof t.type === "string" ? shape.thinkingType[t.type] : undefined;
    if (to !== undefined && to !== t.type) {
      t.type = to;
      changed = true;
    }
  }
  if (shape.dropDeferredTools && Array.isArray(json.tools)) {
    const kept = (json.tools as unknown[]).filter((t) => !(t && typeof t === "object" && (t as Record<string, unknown>).defer_loading === true));
    if (kept.length !== json.tools.length) {
      json.tools = kept;
      changed = true;
    }
  }
  if (shape.mergeSystemMessages && Array.isArray(json.messages)) {
    const out: Record<string, unknown>[] = [];
    const blocksOf = (c: unknown): Record<string, unknown>[] =>
      typeof c === "string" ? [{ type: "text", text: c }] : Array.isArray(c) ? (c as Record<string, unknown>[]) : [];
    for (const m of json.messages as Record<string, unknown>[]) {
      if (!m || m.role !== "system") {
        out.push(m);
        continue;
      }
      changed = true;
      // Its words only: an effort-only system message carries none.
      const text = blocksOf(m.content).filter((b) => b && b.type === "text" && typeof b.text === "string" && b.text).map((b) => ({ type: "text", text: b.text }));
      if (!text.length) continue;
      const prev = out[out.length - 1];
      if (prev && prev.role === "user") prev.content = [...blocksOf(prev.content), ...text];
      else out.push({ role: "user", content: text });
    }
    json.messages = out;
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

/** DeepSeek takes every foldrun word but runs three levels (its docs:
 *  "medium and xhigh both map to high"). Said, not rewritten. */
const DEEPSEEK_RUNS: Record<string, string> = { low: "low", medium: "high", high: "high", xhigh: "high", max: "max" };

/** Qwen 3.8 runs xhigh, medium and low ("max and high map to xhigh",
 *  Alibaba's Anthropic API page, 5 Nov 2026). Its other models' levels are
 *  not documented: said as written. */
const QWEN38_RUNS: Record<string, string> = { low: "low", medium: "medium", high: "xhigh", xhigh: "xhigh", max: "xhigh" };

/**
 * The effort a foldrun level actually runs at on one of foldrun's models:
 * the provider's own aliases (DeepSeek), its reshaping (Kimi), the model's
 * levels on an OpenAI-shaped endpoint (OpenAI, Gemini), or the level itself
 * (Claude takes all five). Null for a word that is not one of ours. What a
 * check tells a developer, from the same tables the wire uses.
 */
export function effortRunsAs(provider: SupplyProviderName, model: string, word: string): string | null {
  if (!(EFFORT_ORDER as readonly string[]).includes(word)) return null;
  const p = SUPPLY_PROVIDERS[provider];
  if (p.send?.effort) return p.send.effort[word] ?? null;
  if (provider === "deepseek") return DEEPSEEK_RUNS[word] ?? null;
  if (provider === "qwen" && /^qwen3\.8/i.test(model)) return QWEN38_RUNS[word] ?? null;
  if (p.format === "anthropic") return word;
  return fitEffort(model, word);
}
