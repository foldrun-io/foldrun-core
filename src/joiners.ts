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

/** A ZWNJ or ZWJ with a letter or mark of a joining script on one side and
 *  a letter or mark on the other — inside a word, or where a Persian suffix
 *  follows a Latin word («channel‌ها», «webhooks‌اند»; cloudhost, 11 Nov). */
const ANY_LETTER = "[\\p{L}\\p{M}]";
const IN_WORD = new RegExp(`(?<=${LETTER})[\\u200C\\u200D](?=${ANY_LETTER})|(?<=${ANY_LETTER})[\\u200C\\u200D](?=${LETTER})`, "gv");
/** A ZWJ between two emoji (a skin tone or VS16 may follow the first). */
const IN_EMOJI = /(?<=\p{Extended_Pictographic}\u{FE0F}?[\u{1F3FB}-\u{1F3FF}]?)\u200D(?=\p{Extended_Pictographic})/gu;

/** A right-to-left LETTER (Arabic-script, Hebrew, Syriac, Thaana, N'Ko) —
 *  letters only, so a mark (ALM is Arabic-script) is never its own evidence. */
const RTL_LETTER = new RegExp("[[\\p{scx=Arabic}\\p{scx=Hebrew}\\p{scx=Syriac}\\p{scx=Thaana}\\p{scx=Nko}]&&\\p{L}]", "v");
/** A run of bidi MARKS — LRM, RLM, ALM. Unlike overrides and isolates they
 *  move nothing: they settle where a neutral (a backtick, a dot) sits, which
 *  is how a Latin file name stays in order inside Persian text. */
const MARKS = /[\u200E\u200F\u061C]+/gu;
const LATIN = /\p{scx=Latin}/u;
const MARKS_ANY = /[\u200E\u200F\u061C]/u;

/** The indices (UTF-16) of every invisible in `text` that is spelling, not
 *  hiding: a joiner of a joining script or emoji; and a run of bidi marks on a
 *  LINE with right-to-left letters, not splitting a Latin word (Codex review:
 *  judged per line, per whole run, by letters alone). */
export function spellingJoiners(text: string): Set<number> {
  const at = new Set<number>();
  if (/[\u200C\u200D]/.test(text)) for (const re of [IN_WORD, IN_EMOJI]) for (const m of text.matchAll(re)) at.add(m.index!);
  if (/[\u200E\u200F\u061C]/.test(text)) {
    // Line by line, each line classified once (Codex review: rescanning the
    // line for every run of marks was quadratic on hostile input).
    let lineStart = 0;
    while (lineStart <= text.length) {
      const nl = text.indexOf("\n", lineStart);
      const lineEnd = nl === -1 ? text.length : nl;
      const line = text.slice(lineStart, lineEnd);
      if (MARKS_ANY.test(line) && RTL_LETTER.test(line)) {
        for (const m of line.matchAll(MARKS)) {
          const start = lineStart + m.index!;
          const end = start + m[0].length;
          // "ig\u200E\u200Enore": marks between two Latin letters split a
          // word; they order nothing there, so they are still hidden text.
          if (LATIN.test(text[start - 1] ?? "") && LATIN.test(text[end] ?? "")) continue;
          for (let k = start; k < end; k++) at.add(k);
        }
      }
      if (nl === -1) break;
      lineStart = nl + 1;
    }
  }
  return at;
}
