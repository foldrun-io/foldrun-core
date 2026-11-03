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

export type SupplyProviderName = "anthropic" | "openai" | "gemini" | "openrouter";

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
  openrouter: {
    name: "openrouter",
    preset: "openrouter",
    format: "anthropic",
    host: "openrouter.ai",
    auth: "bearer",
    metered: ["/api/v1/messages"],
    free: [{ method: "GET", path: "/api/v1/models" }],
  },
  openai: {
    name: "openai",
    preset: "openai",
    format: "openai",
    host: "api.openai.com",
    auth: "bearer",
    metered: ["/v1/chat/completions"],
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
};

export const SUPPLY_PROVIDER_NAMES = Object.keys(SUPPLY_PROVIDERS) as SupplyProviderName[];

/** How each reads to a person: on a step's credential line, in Settings. */
export const SUPPLY_TITLES: Record<SupplyProviderName, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  gemini: "Google Gemini",
  openrouter: "OpenRouter",
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
