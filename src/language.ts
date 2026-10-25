// The language an agent works in — the same cascade as its clock, for the
// same reason: a value written once at the level it belongs to, inherited
// below it, and never a hardcoded default inside a tool.
//
// Prose in AGENTS.md reaches the model and nothing else. A search engine
// asked in English answers in English whatever the agent was told, a
// browser reports en-US to every page, a fetch sends no Accept-Language.
// `language:` is what those read; the prompt sentence it adds is the small
// part. English is the default, so nothing changes for an agent that never
// says.

export interface LanguageChoice {
  /** BCP-47, normalised: `en`, `en-AU`, `fa`, `pt-BR`. */
  language: string;
  from: "agent" | "flow" | "workspace" | "account" | "env" | "default";
  /** A level that wrote something unreadable, said once and skipped. */
  lines: string[];
}

/** `en`, `en-AU`, `en_au`, ` FA-ir ` → `en`, `en-AU`, `en-AU`, `fa-IR`; anything else null. */
export function normalizeLanguage(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const m = /^([a-z]{2,3})(?:[-_]([a-z]{2}))?$/i.exec(raw.trim());
  if (!m) return null;
  return m[2] ? `${m[1].toLowerCase()}-${m[2].toUpperCase()}` : m[1].toLowerCase();
}

/** Null when unset (inherit) or readable; else the sentence check prints. */
export function languageProblem(raw: unknown): string | null {
  if (raw === undefined || raw === null || raw === "") return null;
  if (normalizeLanguage(raw)) return null;
  return `language: ${JSON.stringify(raw)} is not a language tag — write it like \`en\`, \`en-AU\` or \`fa\` (a two-letter language, and optionally a two-letter region).`;
}

export function resolveLanguage(
  levels: { level: LanguageChoice["from"]; value: unknown }[],
  env: Record<string, string | undefined> = process.env,
): LanguageChoice {
  const lines: string[] = [];
  for (const { level, value } of levels) {
    if (value === undefined || value === null || value === "") continue;
    const tag = normalizeLanguage(value);
    if (tag) return { language: tag, from: level, lines };
    lines.push(`language: ${level} says ${JSON.stringify(value)}, which is not a language tag — using the next level`);
  }
  const fromEnv = normalizeLanguage(env.FOLDRUN_LANGUAGE);
  if (fromEnv) return { language: fromEnv, from: "env", lines };
  return { language: "en", from: "default", lines };
}

/** How a person would name it in a prompt: `fa-IR` → "Persian (Iran)". */
export function languageName(tag: string): string {
  try {
    const [lang, region] = tag.split("-");
    const names = new Intl.DisplayNames(["en"], { type: "language" });
    const regions = new Intl.DisplayNames(["en"], { type: "region" });
    const base = names.of(lang) ?? lang;
    return region ? `${base} (${regions.of(region) ?? region})` : base;
  } catch {
    return tag;
  }
}
