// Model and effort words: which tier or level a word in `model:` or
// `effort:` names. Its own module, importing only frontmatter-fields, so a
// caller that needs these few functions does not load the whole of store.ts
// and everything it reaches (FOL-265: foldrun code loaded all of core, about
// 67 MB, for resolveTier and resolveEffort on every turn).
import { EFFORT_LEVELS } from "./frontmatter-fields.ts";
export { EFFORT_LEVELS } from "./frontmatter-fields.ts";

// Model selection. Tiers are the portable default — they keep working as
// models are renamed. An explicit alias or full model id is passed straight
// through for callers who want to pin one.
export const MODEL_TIERS: Record<string, string> = {
  fast: "haiku",
  default: "sonnet",
  max: "opus",
};

// The same three tiers under every name someone reasonably reaches for.
// Nobody should have to learn our vocabulary to pick a model, and the
// alternative to accepting `small` is worse than pedantic: an unrecognised
// word is passed through as a model id, so `model: small` would reach the
// provider as a model called "small" and fail the step at run time, on a
// file that reads perfectly. A synonym table is cheaper than that error.
const MODEL_ALIASES: Record<string, keyof typeof MODEL_TIERS> = {
  fast: "fast",
  small: "fast",
  cheap: "fast",
  mini: "fast",
  light: "fast",
  low: "fast",
  haiku: "fast",

  default: "default",
  standard: "default",
  base: "default",
  balanced: "default",
  mid: "default",
  medium: "default",
  normal: "default",
  sonnet: "default",

  max: "max",
  large: "max",
  big: "max",
  best: "max",
  smart: "max",
  high: "max",
  deep: "max",
  opus: "max",
};

export type Tier = keyof typeof MODEL_TIERS;

/** Which tier a word names, or null if it names none. Exported because the
 *  provider block keys a remap table by tier and should accept every word
 *  `model:` does — one vocabulary, not two. */
export function resolveTier(value: unknown): Tier | null {
  if (typeof value !== "string" || !value.trim()) return null;
  return MODEL_ALIASES[value.trim().toLowerCase()] ?? null;
}

export function resolveModel(value: unknown): string {
  const raw = typeof value === "string" && value.trim() ? value.trim() : "default";
  const tier = resolveTier(raw);
  if (tier) return MODEL_TIERS[tier];
  return raw; // "claude-opus-5" | a provider's own id | …
}

// Effort is the other half of model selection, and the orthogonal one: the
// model is which brain, effort is how long it thinks before answering. The
// five levels are the SDK's own union — we neither invent our own scale nor
// narrow theirs, so a level added upstream is one line here.
export type Effort = (typeof EFFORT_LEVELS)[number];

const EFFORT_ALIASES: Record<string, Effort> = {
  low: "low",
  min: "low",
  minimal: "low",
  lowest: "low",
  fast: "low",
  quick: "low",

  medium: "medium",
  med: "medium",
  mid: "medium",
  moderate: "medium",
  normal: "medium",
  balanced: "medium",

  high: "high",
  default: "high", // the SDK's default, said out loud
  deep: "high",

  xhigh: "xhigh",
  "x-high": "xhigh",
  "extra-high": "xhigh",
  extrahigh: "xhigh",
  "very-high": "xhigh",
  veryhigh: "xhigh",
  higher: "xhigh",

  max: "max",
  maximum: "max",
  highest: "max",
  full: "max",
};

/**
 * `null` for both "not set" and "not a level we know" — unlike a model, the
 * set is closed, so passing an unrecognised word through would be a 400 from
 * the API rather than someone's pinned choice. Callers that can report say
 * which it was with `isEffortWord`.
 */
export function resolveEffort(value: unknown): Effort | null {
  if (typeof value !== "string" || !value.trim()) return null;
  return EFFORT_ALIASES[value.trim().toLowerCase()] ?? null;
}

/** True when a non-empty `effort:` was written but names no level — the
 *  one case worth a line in the run trace, because silence there looks
 *  exactly like the setting having been applied. */
export function isEffortWord(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0 && resolveEffort(value) === null;
}
