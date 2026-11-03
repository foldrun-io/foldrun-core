// Which reasoning-effort levels each model takes, and how a foldrun level
// runs on it. One table for the translator (what is sent), the gateway's
// reshaping and the checks (what a developer is told), so the warning and
// the wire never disagree. Pure: no network, no platform.

/** foldrun's effort words, low to high (frontmatter-fields EFFORT_LEVELS). */
export const EFFORT_ORDER = ["low", "medium", "high", "xhigh", "max"] as const;

/**
 * The reasoning-effort words each model takes on an OpenAI-shaped endpoint
 * (Chat Completions' reasoning_effort, Responses' reasoning.effort), from
 * the providers' own pages; the first match wins. A model not listed gets
 * low | medium | high, which every reasoning model there has taken — a
 * word it might not know is never sent on a guess. Add a row when a model
 * documents more (or fewer).
 */
export const MODEL_EFFORTS: readonly { match: RegExp; levels: readonly string[]; source: string }[] = [
  {
    // "reasoning.effort supports low, medium (default), high, xhigh, and max"
    // (Luna also none, which no foldrun word asks for).
    match: /^gpt-6(?:\.\d+)?-(?:astra|sol|luna)(?:$|-)/,
    levels: ["low", "medium", "high", "xhigh", "max"],
    source: "developers.openai.com/api/docs/models, 3 Nov 2026",
  },
  {
    // reasoning_effort minimal | low | medium | high; thinking cannot be
    // turned off on Gemini 3 and later.
    match: /^gemini-/,
    levels: ["low", "medium", "high"],
    source: "ai.google.dev/gemini-api/docs/openai, 3 Nov 2026",
  },
];
const DEFAULT_EFFORTS = ["low", "medium", "high"] as const;

/** The levels a model takes, by its id (a provider prefix ignored). */
export function effortsOf(model: string): readonly string[] {
  const id = String(model).split("/").pop()?.toLowerCase() ?? "";
  return MODEL_EFFORTS.find((m) => m.match.test(id))?.levels ?? DEFAULT_EFFORTS;
}

/**
 * A foldrun effort word as this model takes it: the word itself when the
 * model has it, else the nearest level below that it has (xhigh on a model
 * that stops at high runs as high), else its lowest. Null for a word that
 * is not one of ours.
 */
export function fitEffort(model: string, word: string): string | null {
  const want = (EFFORT_ORDER as readonly string[]).indexOf(word);
  if (want < 0) return null;
  const levels = effortsOf(model);
  for (let i = want; i >= 0; i--) if (levels.includes(EFFORT_ORDER[i]!)) return EFFORT_ORDER[i]!;
  return EFFORT_ORDER.find((l) => levels.includes(l)) ?? null;
}

