// ZWNJ (U+200C) and ZWJ (U+200D) are invisible, and they are also spelling.
//
// In Persian the half-space is how a word is written: «کانال‌ها», «می‌شود».
// Arabic-script, Syriac, Thaana and N'Ko, and the Indic and other Brahmic
// scripts, use both joiners inside words. An emoji sequence (👨‍💻, 🏳️‍🌈) is
// glued with ZWJ. Flagging those as hidden text (scan.ts
// content/hidden-unicode) buried real findings under hundreds of false ones
// on a Persian workspace (cloudhost, 11 Nov 2026), and stripping them from an
// outside agent's reply (a2a-client.ts) misspelled every such word.
//
// So a joiner is spelling when it sits INSIDE a word of a script that uses
// joiners — a letter or mark of one on BOTH sides — or between two emoji.
// Anywhere else (between Latin letters, at a word's edge, alone) it is still
// hidden text. Every other invisible character (zero-width space, bidi
// overrides and isolates, word joiner, BOM, Unicode tags) is never spelling.

const JOINER_SCRIPTS = [
  "Arabic", "Syriac", "Thaana", "Nko",
  "Devanagari", "Bengali", "Gurmukhi", "Gujarati", "Oriya", "Tamil", "Telugu", "Kannada", "Malayalam", "Sinhala",
  "Tibetan", "Myanmar", "Khmer", "Mongolian",
];
const LETTER = `(?:${JOINER_SCRIPTS.map((s) => `[\\p{scx=${s}}&&[\\p{L}\\p{M}]]`).join("|")})`;

/** A ZWNJ or ZWJ with a letter or mark of a joining script on each side. */
const IN_WORD = new RegExp(`(?<=${LETTER})[\\u200C\\u200D](?=${LETTER})`, "gv");
/** A ZWJ between two emoji (a skin tone or VS16 may follow the first). */
const IN_EMOJI = /(?<=\p{Extended_Pictographic}\u{FE0F}?[\u{1F3FB}-\u{1F3FF}]?)‍(?=\p{Extended_Pictographic})/gu;

/** The indices (UTF-16) of every joiner in `text` that is spelling, not hiding. */
export function spellingJoiners(text: string): Set<number> {
  const at = new Set<number>();
  if (!/[‌‍]/.test(text)) return at;
  for (const re of [IN_WORD, IN_EMOJI]) for (const m of text.matchAll(re)) at.add(m.index!);
  return at;
}
